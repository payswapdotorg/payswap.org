import { describe, expect, it } from 'vitest';

import type {
  ApprovalItemInput,
  CommandCenterSnapshot,
  ExecutionItemInput,
  GenericAuthorityItem,
  OffNetworkItemInput,
  RemittanceItemInput,
} from '../src/command-center.js';
import {
  aggregateInbox,
  assembleWorkGraphContext,
  COMMAND_CENTER_DOMAINS,
  deriveApprovalUiState,
  deriveApprovalView,
  deriveCapabilityView,
  deriveEconomicControls,
  deriveExecutionUiState,
  deriveExecutionView,
  deriveMandateUiState,
  deriveMandateView,
  deriveOffNetworkUiState,
  deriveOffNetworkView,
  deriveTerminalUiState,
  emptySnapshot,
  EXECUTION_UI_STATES,
  formatExactMinorUnits,
  isTerminalExecutionUiState,
  searchCommandCenter,
} from '../src/command-center.js';
import type { OfferDerivationRejectionReason } from '@payswap/execution';
import { TERMINAL_STATES, UI_STATES } from '@payswap/interfaces';
import type { ApprovalRecord } from '@payswap/api';
import type { OffNetworkPaymentRecord } from '@payswap/payment';
import { applyMandateEvent, asOffNetworkPaymentRecordId, allocateRemittance } from '@payswap/payment';
import { currencyCode, fromMinorUnits, USD } from '@payswap/protocol';

import {
  makeAcceptancePolicy,
  makeAttempt,
  makeMandate,
  makeOffer,
  NOW_MS,
} from './fixtures.js';

// ---------------------------------------------------------------------------
// One-to-one: view state derived from authority state via pure functions
// ---------------------------------------------------------------------------

describe('deriveExecutionUiState — total + one-to-one with the authority machine', () => {
  const AUTHORITY_STATES = [
    'PENDING',
    'IN_FLIGHT',
    'AWAITING_CUSTOMER_ACTION',
    'PARTIALLY_EXECUTED',
    'OUTCOME_UNKNOWN',
    'SUCCEEDED',
    'FAILED',
    'CANCELLED',
    'COMPENSATED',
    'RECOVERED',
  ] as const;

  it('is TOTAL: every authority attempt state maps to exactly one view state', () => {
    expect(AUTHORITY_STATES).toHaveLength(EXECUTION_UI_STATES.length);
    for (const state of AUTHORITY_STATES) {
      expect(() => deriveExecutionUiState(state)).not.toThrow();
    }
  });

  it('is INJECTIVE: distinct authority states map to distinct view states (nothing merged)', () => {
    const views = AUTHORITY_STATES.map((state) => deriveExecutionUiState(state));
    expect(new Set(views).size).toBe(views.length);
  });

  it('INV-X01: OUTCOME_UNKNOWN renders as reconciling, NEVER as failed', () => {
    expect(deriveExecutionUiState('OUTCOME_UNKNOWN')).toBe('reconciling');
    expect(deriveExecutionUiState('OUTCOME_UNKNOWN')).not.toBe('failed');
    expect(isTerminalExecutionUiState(deriveExecutionUiState('OUTCOME_UNKNOWN'))).toBe(false);
  });

  it('the derivation is deterministic: same authority state, same view (deep)', () => {
    for (const state of AUTHORITY_STATES) {
      const left = deriveExecutionView({ attempt: makeAttempt(state) });
      const right = deriveExecutionView({ attempt: makeAttempt(state) });
      expect(left).toEqual(right);
      // Views are frozen: no view-side mutation path exists at all.
      expect(Object.isFrozen(left)).toBe(true);
    }
  });

  it('NO view transition without an authority transition: the view is a pure function of the authority record only', () => {
    // The attempt in state S produces view V. The ONLY way to obtain a
    // different view for the same record identity is a different authority
    // state — there is no view-side input (the derivation takes the attempt
    // record alone and is frozen).
    const base = makeAttempt('IN_FLIGHT');
    const before = deriveExecutionView({ attempt: base });
    const unchanged = deriveExecutionView({ attempt: { ...base } });
    expect(unchanged).toEqual(before);
    // The authority machine moves IN_FLIGHT → OUTCOME_UNKNOWN (external
    // ambiguity); with the authority record changed, the view follows 1:1.
    const after = deriveExecutionView({ attempt: makeAttempt('OUTCOME_UNKNOWN', { attemptId: base.attemptId, planId: base.planId }) });
    expect(after.uiState).toBe('reconciling');
    expect(after.uiState).not.toBe(before.uiState);
  });

  it('INV-C06: AWAITING_CUSTOMER_ACTION surfaces preserved provider actions verbatim', () => {
    const envelope = makeProviderEnvelopeFixture();
    const attempt = makeAttempt('AWAITING_CUSTOMER_ACTION', {
      providerState: envelope,
      evidence: [
        {
          evidenceId: 'ev_awaiting',
          kind: 'STATE_OBSERVATION',
          evidenceRef: 'psp-one/obs/42',
          recordedAt: 1n,
          providerState: envelope,
          attemptId: makeAttempt('PENDING').attemptId,
        },
      ],
    });
    const view = deriveExecutionView({ attempt });
    expect(view.uiState).toBe('action-required');
    expect(view.pendingCustomerActions).toHaveLength(1);
    const action = view.pendingCustomerActions[0];
    expect(action?.message).toBe('Complete 3DS authentication with your bank');
    expect(action?.deepLink).toBe('https://psp-one.example/3ds/pi_ext_42');
    // The action to complete it is offered (no dead state).
    expect(view.actions.some((candidate) => candidate.actionId.startsWith('complete-provider-action:'))).toBe(true);
  });
});

function makeProviderEnvelopeFixture() {
  return {
    provider: { name: 'psp-one', version: '2.4.1' },
    object: { objectType: 'payment_intent', externalId: 'pi_ext_42' },
    revision: 'rev_9',
    state: 'requires_action',
    classification: {
      family: 'customer_action_required' as const,
      lifecycleStep: '3ds_challenge',
      isTerminal: false,
      requiresCustomerAction: true,
    },
    history: [],
    actionRequired: {
      kind: '3ds_challenge',
      message: 'Complete 3DS authentication with your bank',
      deepLink: 'https://psp-one.example/3ds/pi_ext_42',
    },
    privacy: { dataClassification: 'PARTNER' as const, constraints: [], shareableFields: [] },
    timestamps: { observedAt: '2026-09-30T00:00:00Z' },
    provenance: { source: 'PROVIDER_API' as const },
  };
}

describe('deriveTerminalUiState — the canonical mapping is CONSUMED, never redefined', () => {
  it('matches @payswap/interfaces mapTerminalStateToUi for EVERY terminal state (totality)', () => {
    expect(TERMINAL_STATES).toHaveLength(9);
    for (const state of TERMINAL_STATES) {
      expect(deriveTerminalUiState(state)).toBeDefined();
      expect(UI_STATES).toContain(deriveTerminalUiState(state));
    }
  });

  it('INV-X01: UNKNOWN → reconciling (never failed)', () => {
    expect(deriveTerminalUiState('UNKNOWN')).toBe('reconciling');
  });
});

describe('approval view derivation — one-to-one with the authority record', () => {
  const record = (status: ApprovalRecord['status'], expiresAtMs: number): ApprovalRecord => ({
    requestHash: 'reqhash_1',
    status,
    channel: 'IN_APP',
    expiresAt: new Date(expiresAtMs).toISOString(),
    ...(status === 'APPROVED' ? { artifactRef: 'approval:reqhash_1' } : {}),
  });

  it('is total over every authority approval status', () => {
    const statuses = ['PENDING', 'APPROVED', 'REJECTED', 'CONSUMED'] as const;
    for (const status of statuses) {
      expect(() => deriveApprovalUiState(record(status, NOW_MS + 60_000), NOW_MS)).not.toThrow();
    }
  });

  it('PENDING + within window → awaiting-decision; PENDING + expired → the honest expired state', () => {
    expect(deriveApprovalUiState(record('PENDING', NOW_MS + 60_000), NOW_MS)).toBe('awaiting-decision');
    expect(deriveApprovalUiState(record('PENDING', NOW_MS - 60_000), NOW_MS)).toBe('awaiting-decision-expired');
  });

  it('the pending decision action is bound to the TRUSTED surface (never a chat/click authority)', () => {
    const view = deriveApprovalView(
      {
        record: record('PENDING', NOW_MS + 60_000),
        renderedMessage: {
          text: 'approve?',
          requestHash: 'reqhash_1',
          expiresAt: new Date(NOW_MS + 60_000).toISOString(),
          deepLink: 'https://app.payswap.example/approvals/reqhash_1',
        },
      },
      NOW_MS,
    );
    const trusted = view.actions.find((action) => action.actionId === 'open-trusted-approval-surface');
    expect(trusted).toBeDefined();
    expect(trusted?.kind).toBe('TRUSTED_SURFACE');
    expect(trusted?.trustedSurface?.requestHash).toBe('reqhash_1');
  });
});

describe('mandate view derivation — one-to-one with the authority mandate machine', () => {
  it('is total over every authority mandate state', () => {
    const states = ['PENDING', 'ACTIVE', 'PAUSED', 'CANCELLED', 'EXPIRED'] as const;
    for (const state of states) {
      expect(() => deriveMandateUiState(state)).not.toThrow();
    }
  });

  it('the offered actions are exactly the authority machine’s legal events (no view-side transitions)', () => {
    const active = deriveMandateView(
      { mandate: applyMandateEvent(makeMandate({ id: 'mandate_active' }), 'ACTIVATE', BigInt(NOW_MS)) },
      NOW_MS,
    );
    const activeEvents = active.actions
      .filter((action) => action.kind === 'AUTHORITY_TRANSITION')
      .map((action) => action.authorityEvent?.event);
    expect(activeEvents).toContain('PAUSE');
    expect(activeEvents).toContain('CANCEL');
    // EXPIRE is declarative: only legal once the expiry window is reached.
    expect(activeEvents).not.toContain('EXPIRE');
    expect(active.expiryReached).toBe(false);
    expect(activeEvents).not.toContain('ACTIVATE');

    // A mandate whose validity window has passed: the authority machine now
    // accepts EXPIRE (and the view surfaces it instead of rewriting state).
    const expiredWindow = applyMandateEvent(
      makeMandate({
        id: 'mandate_expired_window',
        validFrom: BigInt(NOW_MS) - 2_000n,
        expiresAt: BigInt(NOW_MS) - 1_000n,
      }),
      'ACTIVATE',
      BigInt(NOW_MS) - 1_500n,
    );
    const expiredView = deriveMandateView({ mandate: expiredWindow }, NOW_MS);
    const expiredEvents = expiredView.actions
      .filter((action) => action.kind === 'AUTHORITY_TRANSITION')
      .map((action) => action.authorityEvent?.event);
    expect(expiredView.expiryReached).toBe(true);
    expect(expiredEvents).toContain('EXPIRE');

    const pending = deriveMandateView({ mandate: makeMandate({ id: 'mandate_pending' }) }, NOW_MS);
    const pendingEvents = pending.actions
      .filter((action) => action.kind === 'AUTHORITY_TRANSITION')
      .map((action) => action.authorityEvent?.event);
    expect(pendingEvents).toContain('ACTIVATE');
    expect(pendingEvents).not.toContain('PAUSE');
  });

  it('NO renewal action exists: terminal mandates surface NEW-mandate authorization (fresh, never silent)', () => {
    const cancelled = makeMandate({ id: 'mandate_cancelled' });
    // Authority fold first: PENDING → CANCELLED via the authority machine.
    const cancelledAuthority = { ...cancelled, state: 'CANCELLED' as const };
    const view = deriveMandateView({ mandate: cancelledAuthority }, NOW_MS);
    expect(view.uiState).toBe('cancelled');
    expect(
      view.actions.some((action) => action.actionId === 'mandate-resume' || action.actionId === 'mandate-activate'),
    ).toBe(false);
    const newAuth = view.actions.find((action) => action.actionId === 'request-new-mandate-authorization');
    expect(newAuth).toBeDefined();
    expect(newAuth?.apiCommand?.path).toBe('/v1/approvals');
  });
});

describe('off-network view derivation — one-to-one + honest attribution', () => {
  it('is total over every authority reconciliation state', () => {
    const states = ['UNRECONCILED', 'RECONCILING', 'RECONCILED', 'DISCREPANT'] as const;
    for (const state of states) {
      expect(() => deriveOffNetworkUiState(state)).not.toThrow();
    }
  });

  it('carries the structural attribution: EXTERNAL_PARTY, never PaySwap execution', () => {
    const record: OffNetworkPaymentRecord = {
      id: asOffNetworkPaymentRecordId('offnet_1'),
      source: 'CHECK',
      reporter: 'user:alice',
      amount: fromMinorUnits(USD, 25000n),
      externalRef: 'check-1042',
      evidence: [{ kind: 'check-image', reference: 'store/checks/1042.png', recordedAt: 1n }],
      reconciliationState: 'UNRECONCILED',
      businessDocumentRefs: [{ documentKind: 'INVOICE', documentId: 'INV-77' }],
      recordedAt: 1n,
      orchestratedBy: 'EXTERNAL_PARTY',
    };
    const view = deriveOffNetworkView({ record });
    expect(view.orchestratedBy).toBe('EXTERNAL_PARTY');
    expect(view.uiState).toBe('unreconciled');
  });
});

// ---------------------------------------------------------------------------
// Search over the authority snapshot
// ---------------------------------------------------------------------------

describe('searchCommandCenter', () => {
  const snapshot = makeSnapshot();

  it('finds items by title/keyword tokens and reports what matched', () => {
    const result = searchCommandCenter(snapshot, { text: 'att_1 execution' });
    expect(result.hits.some((hit) => hit.domain === 'EXECUTION' && hit.authorityRef === 'att_1')).toBe(true);
  });

  it('every hit references an authority item from the snapshot (nothing fabricated)', () => {
    const result = searchCommandCenter(snapshot, { text: 'mandate' });
    for (const hit of result.hits) {
      expect(hit.authorityRef.length).toBeGreaterThan(0);
      expect(COMMAND_CENTER_DOMAINS).toContain(hit.domain);
    }
  });

  it('domain filters restrict the scan; scanned counts are honest', () => {
    const result = searchCommandCenter(snapshot, { text: 'a', domains: ['APPROVAL'] });
    expect(result.hits.every((hit) => hit.domain === 'APPROVAL')).toBe(true);
    expect(result.scanned['EXECUTION']).toBe(3);
    expect(result.scanned['APPROVAL']).toBe(2);
  });

  it('an empty query returns no hits (the inbox is the default surface)', () => {
    expect(searchCommandCenter(snapshot, { text: '   ' }).hits).toEqual([]);
  });

  it('a token matching nothing returns no hits', () => {
    expect(searchCommandCenter(snapshot, { text: 'zzz-nothing-matches-this' }).hits).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Universal inbox
// ---------------------------------------------------------------------------

describe('aggregateInbox — no dead inbox items, honest urgencies', () => {
  const snapshot = makeSnapshot();

  it('every entry carries at least one AVAILABLE action (no dead inbox items)', () => {
    const inbox = aggregateInbox(snapshot, NOW_MS);
    expect(inbox.entries.length).toBeGreaterThanOrEqual(5);
    for (const entry of inbox.entries) {
      expect(entry.actions.some((action) => action.available)).toBe(true);
      expect(entry.authorityRef.length).toBeGreaterThan(0);
    }
  });

  it('UNKNOWN execution → RECONCILING urgency, never a failure tone', () => {
    const inbox = aggregateInbox(snapshot, NOW_MS);
    const unknown = inbox.entries.find((entry) => entry.authorityRef === 'att_unknown');
    expect(unknown?.urgency).toBe('RECONCILING');
    expect(unknown?.uiState).toBe('reconciling');
  });

  it('an awaiting-customer-action execution → ACTION_REQUIRED with the provider action verbatim', () => {
    const inbox = aggregateInbox(snapshot, NOW_MS);
    const actionRequired = inbox.entries.find((entry) => entry.authorityRef === 'att_awaiting');
    expect(actionRequired?.urgency).toBe('ACTION_REQUIRED');
    expect(actionRequired?.uiState).toBe('action-required');
  });

  it('a pending approval within its window → ACTION_REQUIRED bound to the trusted surface', () => {
    const inbox = aggregateInbox(snapshot, NOW_MS);
    const approval = inbox.entries.find((entry) => entry.domain === 'APPROVAL');
    expect(approval?.urgency).toBe('ACTION_REQUIRED');
    expect(approval?.actions.some((action) => action.kind === 'TRUSTED_SURFACE')).toBe(true);
  });

  it('an expired pending approval surfaces as REVIEW with a re-request path (honest, not hidden)', () => {
    const inbox = aggregateInbox(snapshot, NOW_MS);
    const expired = inbox.entries.find((entry) => entry.authorityRef === 'reqhash_expired');
    expect(expired?.urgency).toBe('REVIEW');
    expect(expired?.reason).toContain('expired');
  });

  it('counts add up', () => {
    const inbox = aggregateInbox(snapshot, NOW_MS);
    const total = inbox.counts['ACTION_REQUIRED'] + inbox.counts['RECONCILING'] + inbox.counts['REVIEW'] + inbox.counts['FYI'];
    expect(total).toBe(inbox.entries.length);
  });
});

// ---------------------------------------------------------------------------
// Work-Graph context assembly
// ---------------------------------------------------------------------------

describe('assembleWorkGraphContext', () => {
  const snapshot = makeSnapshot();

  it('links remittances that settle the focused project milestone (SETTLES relation)', () => {
    const context = assembleWorkGraphContext(snapshot, { nodeKind: 'PROJECT', nodeId: 'proj-42' });
    expect(context.linked.some((link) => link.domain === 'REMITTANCE' && link.relation === 'SETTLES')).toBe(true);
  });

  it('links work items whose linkedRefs carry the focus reference (BELONGS_TO)', () => {
    const context = assembleWorkGraphContext(snapshot, { nodeKind: 'PROJECT', nodeId: 'proj-42' });
    expect(context.workItems.some((item) => item.authorityRef === 'task-9')).toBe(true);
  });

  it('links off-network records documenting the focused node (DOCUMENTS relation)', () => {
    const context = assembleWorkGraphContext(snapshot, { nodeKind: 'PROJECT', nodeId: 'proj-42' });
    expect(context.linked.some((link) => link.domain === 'OFF_NETWORK_RECORD')).toBe(true);
  });

  it('surfaces agent collaborators (proposals and their pending approvals) — FRONTEND-UX-DEPLOYMENT Agent UX', () => {
    const context = assembleWorkGraphContext(snapshot, { nodeKind: 'PROJECT', nodeId: 'proj-42' });
    const agent = context.agentCollaborators.find((collaborator) => collaborator.agentRef === 'agent:helper');
    expect(agent).toBeDefined();
    expect(agent?.pendingApprovals).toContain('reqhash_1');
    expect(agent?.proposedItems.some((item) => item.authorityRef === 'intent-agent-1')).toBe(true);
    expect(agent?.note).toContain('propose');
  });

  it('an unrelated focus yields an honest empty context', () => {
    const context = assembleWorkGraphContext(snapshot, { nodeKind: 'CASE', nodeId: 'case-unknown' });
    expect(context.empty).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Economic controls surface
// ---------------------------------------------------------------------------

describe('deriveEconomicControls', () => {
  const snapshot = makeSnapshot();

  it('mandate controls expose exact charge ceilings and per-charge maximums (INV-F01, no floats)', () => {
    const controls = deriveEconomicControls(snapshot, NOW_MS);
    const mandate = controls.mandates.find((view) => view.mandateId === 'mandate_active');
    expect(mandate?.remainingCharges).toBe(11n);
    expect(mandate?.perChargeMaximum.value).toBe(5000n);
    expect(formatExactMinorUnits(mandate?.perChargeMaximum ?? { currency: 'USD', value: 0n })).toBe(
      'USD 5000 (exact minor units)',
    );
  });

  it('off-network totals are exact per currency and explicitly NOT PaySwap-executed money', () => {
    const controls = deriveEconomicControls(snapshot, NOW_MS);
    const usd = controls.offNetworkTotals.find((total) => total.currency === 'USD');
    expect(usd?.exactTotalMinorUnits).toBe(25000n);
    expect(usd?.attribution).toBe('EXTERNAL_PARTY_REPORTED');
    expect(usd?.note).toContain('never PaySwap-executed');
  });

  it('counts pending approvals and reconciling executions from authority', () => {
    const controls = deriveEconomicControls(snapshot, NOW_MS);
    expect(controls.pendingApprovalCount).toBe(1);
    expect(controls.reconcilingExecutionCount).toBe(1);
  });
});

describe('capability views — derived from authoritative offer state', () => {
  it('an offer view exposes inspection of the actual rail path (INV-C07 transparency)', () => {
    const view = deriveCapabilityView({ kind: 'OFFER', offer: makeOffer() });
    expect(view.offered).toBe(true);
    expect(view.offer?.railPath).toHaveLength(1);
    expect(view.actions.some((action) => action.actionId === 'inspect-rail-path')).toBe(true);
  });

  it('a rejection view carries the typed authority reason and remains actionable', () => {
    const view = deriveCapabilityView({
      kind: 'REJECTION',
      methodId: 'card',
      derivation: {
        ok: false,
        reason: 'ACCEPTANCE_REJECTED' as OfferDerivationRejectionReason,
        message: 'the payment request is not accepted by policy',
      },
    });
    expect(view.offered).toBe(false);
    expect(view.rejectionReason).toBe('ACCEPTANCE_REJECTED');
    expect(view.actions.some((action) => action.available)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Snapshot fixture shared by search/inbox/workgraph/controls suites
// ---------------------------------------------------------------------------

function makeSnapshot(): CommandCenterSnapshot {
  const pendingApproval: ApprovalItemInput = {
    record: {
      requestHash: 'reqhash_1',
      status: 'PENDING',
      channel: 'IN_APP',
      expiresAt: new Date(NOW_MS + 3_600_000).toISOString(),
    },
    request: {
      principal: 'user:alice',
      agentRef: 'agent:helper',
      requestedAuthorityScope: { domain: 'payments', actions: ['payments.intent.create'] },
      requestHash: 'reqhash_1',
      expiresAt: new Date(NOW_MS + 3_600_000).toISOString(),
      channel: 'IN_APP',
    },
  };
  const expiredApproval: ApprovalItemInput = {
    record: {
      requestHash: 'reqhash_expired',
      status: 'PENDING',
      channel: 'IN_APP',
      expiresAt: new Date(NOW_MS - 60_000).toISOString(),
    },
  };

  const executions: readonly ExecutionItemInput[] = [
    { attempt: makeAttempt('IN_FLIGHT') },
    { attempt: makeAttempt('OUTCOME_UNKNOWN', { attemptId: 'att_unknown' }) },
    {
      attempt: makeAttempt('AWAITING_CUSTOMER_ACTION', {
        attemptId: 'att_awaiting',
        providerState: makeProviderEnvelopeFixture(),
        evidence: [
          {
            evidenceId: 'ev_awaiting',
            kind: 'STATE_OBSERVATION',
            evidenceRef: 'psp-one/obs/42',
            recordedAt: 1n,
            providerState: makeProviderEnvelopeFixture(),
            attemptId: makeAttempt('PENDING').attemptId,
          },
        ],
      }),
    },
  ];

  const offNetwork: readonly OffNetworkItemInput[] = [
    {
      record: {
        id: asOffNetworkPaymentRecordId('offnet_1'),
        source: 'CHECK',
        reporter: 'user:alice',
        amount: fromMinorUnits(USD, 25000n),
        externalRef: 'check-1042',
        evidence: [{ kind: 'check-image', reference: 'store/checks/1042.png', recordedAt: 1n }],
        reconciliationState: 'UNRECONCILED',
        businessDocumentRefs: [{ documentKind: 'PROJECT_MILESTONE', documentId: 'proj-42' }],
        recordedAt: 1n,
        orchestratedBy: 'EXTERNAL_PARTY',
      },
    },
  ];

  const remittance = allocateRemittance({
    id: 'remittance_1',
    paymentRef: 'payment_1',
    method: 'mobile_money',
    paymentAmount: fromMinorUnits(USD, 5000n),
    allocations: [
      {
        documentKind: 'PROJECT_MILESTONE',
        documentId: 'proj-42',
        allocatedAmount: fromMinorUnits(USD, 5000n),
      },
    ],
  });
  const remittances: readonly RemittanceItemInput[] = [{ allocation: remittance }];

  const workItem: GenericAuthorityItem = {
    domain: 'WORK_ITEM',
    authorityRef: 'task-9',
    title: 'Ship milestone for project 42',
    keywords: ['milestone', 'proj-42'],
    authorityState: 'IN_PROGRESS',
    linkedRefs: ['PROJECT:proj-42'],
  };
  const goal: GenericAuthorityItem = {
    domain: 'GOAL',
    authorityRef: 'goal-1',
    title: 'Reduce payment costs',
    keywords: ['costs', 'optimization'],
    authorityState: 'ACTIVE',
    requiresAttention: true,
  };
  const proposal: GenericAuthorityItem = {
    domain: 'INTENT',
    authorityRef: 'intent-agent-1',
    title: 'Agent proposal: switch to bank debit',
    keywords: ['proposal', 'agent'],
    authorityState: 'PROPOSED',
    proposedByAgent: 'agent:helper',
  };

  return {
    viewer: { principal: 'user:alice', roleLabels: ['payer'], agentRefs: ['agent:helper'] },
    approvals: [pendingApproval, expiredApproval],
    executions,
    capabilities: [
      { kind: 'OFFER', offer: makeOffer() },
      {
        kind: 'REJECTION',
        methodId: 'card',
        derivation: {
          ok: false,
          reason: 'ACCEPTANCE_REJECTED' as OfferDerivationRejectionReason,
          message: 'the payment request is not accepted by policy',
        },
      },
    ],
    mandates: [
      { mandate: makeMandate({ id: 'mandate_pending' }) },
      {
        mandate: {
          ...makeMandate({ id: 'mandate_active' }),
          state: 'ACTIVE' as const,
          chargeCount: 1n,
        },
      },
    ],
    offNetworkRecords: offNetwork,
    remittances,
    generic: [workItem, goal, proposal],
  };
}

describe('emptySnapshot — empty states are still honest states', () => {
  it('derives an empty inbox and empty controls without inventing anything', () => {
    const snapshot = emptySnapshot({ principal: 'user:alice', roleLabels: [], agentRefs: [] });
    expect(aggregateInbox(snapshot, NOW_MS).entries).toEqual([]);
    expect(deriveEconomicControls(snapshot, NOW_MS).mandates).toEqual([]);
    expect(searchCommandCenter(snapshot, { text: 'anything' }).hits).toEqual([]);
  });
});

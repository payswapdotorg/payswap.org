/**
 * @payswap/ux — the universal Command Center view-model CONTRACT (W3-006).
 *
 * FRONTEND-UX-DEPLOYMENT ("State rendering"): UI state must be a ONE-TO-ONE
 * projection of authority state. This module encodes that rule structurally:
 *
 * - every view item is DERIVED from an authority record by a PURE function
 *   (`deriveExecutionView`, `deriveApprovalView`, `deriveMandateView`,
 *   `deriveOffNetworkView`, `deriveCapabilityView`) — the view constructors
 *   take authority records only, so a view state can never change without a
 *   corresponding authority change (there is no view-side mutation path);
 * - the terminal-state mapping is CONSUMED from @payswap/interfaces
 *   (`mapTerminalStateToUi`, W3-001) — this package never re-defines the
 *   protocol-state → UI-state mapping;
 * - the derivation is TOTAL: every authority state (all TerminalStates, all
 *   ExecutionAttemptStates, all mandate states, all off-network
 *   reconciliation states) maps to exactly one view state (tested);
 * - search, the universal inbox, Work-Graph context assembly and the economic
 *   controls surface are deterministic aggregations over an
 *   `CommandCenterSnapshot` of authority records — nothing is fabricated,
 *   every item carries the authority reference it was derived from.
 *
 * INVARIANTS exercised here:
 * - INV-E04: view items carry provenance no stronger than their source
 *   (see incumbent-views.ts for the provenance strength discipline);
 * - INV-C06: provider customer-action state is surfaced VERBATIM from the
 *   preserved ProviderStateEnvelope (via @payswap/execution
 *   `pendingCustomerActions`), never flattened;
 * - INV-X01: UNKNOWN authority states render as `reconciling`, never as
 *   failure (via mapTerminalStateToUi + the execution view derivation);
 * - NO DEAD BUTTONS: every derived view declares its available actions; the
 *   universal inbox only contains entries with at least one available action.
 *
 * Deterministic by construction: no DOM, no network, no rendering, no
 * ambient time (all "now" readings are injected parameters), no randomness.
 */

import type { ApprovalRecord } from '@payswap/api';
import type {
  ExecutionAttempt,
  ExecutionAttemptState,
  OfferDerivation,
  PaymentMethodOffer,
} from '@payswap/execution';
import { pendingCustomerActions } from '@payswap/execution';
import type {
  OffNetworkPaymentRecord,
  RecurringMandate,
  RemittanceAllocation,
} from '@payswap/payment';
import { mandateStateMachine } from '@payswap/payment';
import type {
  ApprovalMessage,
  ApprovalRequest,
  TerminalState,
  UiState,
} from '@payswap/interfaces';
import { mapTerminalStateToUi } from '@payswap/interfaces';

// ---------------------------------------------------------------------------
// Domains and provenance
// ---------------------------------------------------------------------------

/** The authority domains the Command Center searches over (W3-006 work order). */
export const COMMAND_CENTER_DOMAINS = [
  'GOAL',
  'INTENT',
  'APPROVAL',
  'EXECUTION',
  'CAPABILITY',
  'INCENTIVE',
  'DISPUTE',
  'EVIDENCE',
  'PARTICIPATION',
  'WORK_ITEM',
  'MANDATE',
  'OFF_NETWORK_RECORD',
  'REMITTANCE',
] as const;

export type CommandCenterDomain = (typeof COMMAND_CENTER_DOMAINS)[number];

/** Generic domains whose authority packages are consumed structurally. */
export type GenericDomain = Exclude<
  CommandCenterDomain,
  'APPROVAL' | 'EXECUTION' | 'CAPABILITY' | 'MANDATE' | 'OFF_NETWORK_RECORD' | 'REMITTANCE'
>;

/**
 * A generic authority item (goal, intent, incentive, dispute, evidence,
 * participation, Work-Operating-Plane item). The `authorityState` is the
 * authoritative system's own state token, carried VERBATIM — the Command
 * Center never re-interprets it. Shapes here are structural so the
 * composition root (W3-007) can pass records from @payswap/participation,
 * @payswap/campaigns and the Work Operating Plane without this package
 * depending on them.
 */
export interface GenericAuthorityItem {
  readonly domain: GenericDomain;
  readonly authorityRef: string;
  readonly title: string;
  readonly summary?: string;
  readonly keywords: readonly string[];
  /** The authoritative system's own state token (opaque passthrough). */
  readonly authorityState: string;
  /** Work-Graph links, e.g. `PROJECT:proj-1`, `CASE:case-9`. */
  readonly linkedRefs?: readonly string[];
  /** Authority-flagged: the authoritative system marked this item as needing attention. */
  readonly requiresAttention?: boolean;
  /** Agent that proposed/owns this item, when applicable (agent-collaboration view). */
  readonly proposedByAgent?: string;
}

// ---------------------------------------------------------------------------
// View actions — the no-dead-buttons primitive
// ---------------------------------------------------------------------------

export type ViewActionKind =
  /** Dispatches a validated RequestEnvelope through the @payswap/api handler. */
  | 'API_COMMAND'
  /** Folds a domain authority state machine (@payswap/payment, @payswap/execution). */
  | 'AUTHORITY_TRANSITION'
  /** Completes on the trusted approval surface (INV-A03 — never raw chat/click). */
  | 'TRUSTED_SURFACE'
  /** Navigation inside the Command Center (no external effect). */
  | 'NAVIGATION'
  /** Deep link to a preserved provider/incumbent action (INV-C06). */
  | 'EXTERNAL_OPEN'
  /** Inspect evidence/provenance (read-only). */
  | 'EVIDENCE_VIEW';

/** The API command an API_COMMAND action dispatches (built in journeys.ts). */
export interface ApiCommandSpec {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body?: unknown;
}

/** The authority event an AUTHORITY_TRANSITION action folds. */
export interface AuthorityEventSpec {
  readonly domain: 'MANDATE' | 'OFF_NETWORK_RECORD';
  readonly authorityId: string;
  readonly event: string;
}

/**
 * One action a view offers. `authorityRef` binds the action to the authority
 * record it operates on — an action can never float free of authority.
 */
export interface ViewAction {
  readonly actionId: string;
  readonly label: string;
  readonly kind: ViewActionKind;
  readonly authorityRef: string;
  readonly available: boolean;
  /** Actionable reason whenever the action is unavailable. */
  readonly unavailableReason?: string;
  /** Present for API_COMMAND actions (journeys dispatch these). */
  readonly apiCommand?: ApiCommandSpec;
  /** Present for AUTHORITY_TRANSITION actions. */
  readonly authorityEvent?: AuthorityEventSpec;
  /** Present for TRUSTED_SURFACE actions: the approval request it completes. */
  readonly trustedSurface?: { readonly requestHash: string; readonly deepLink?: string };
  /** Present for EXTERNAL_OPEN actions. */
  readonly externalOpen?: { readonly systemName: string; readonly deepLink?: string };
}

/** Raised when a view contract rule is violated. */
export class ViewContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ViewContractError';
  }
}

// ---------------------------------------------------------------------------
// Execution views — one-to-one with the authority attempt state
// ---------------------------------------------------------------------------

/**
 * Execution view states. Derived ONE-TO-ONE from
 * `ExecutionAttemptState` (@payswap/execution, W3-003) by
 * `deriveExecutionUiState`: the mapping is exhaustive and deterministic, and
 * there is NO other constructor for an execution view than the authority
 * record (one-to-one: view change ⟺ authority change).
 */
export const EXECUTION_UI_STATES = [
  'not-started',
  'executing',
  'action-required',
  'partially-executed',
  'reconciling',
  'fulfilled',
  'failed',
  'cancelled',
  'compensated',
  'recovered',
] as const;

export type ExecutionUiState = (typeof EXECUTION_UI_STATES)[number];

/** Total, exhaustive authority → view mapping (INV-X01: UNKNOWN → reconciling). */
export function deriveExecutionUiState(state: ExecutionAttemptState): ExecutionUiState {
  switch (state) {
    case 'PENDING':
      return 'not-started';
    case 'IN_FLIGHT':
      return 'executing';
    case 'AWAITING_CUSTOMER_ACTION':
      return 'action-required';
    case 'PARTIALLY_EXECUTED':
      return 'partially-executed';
    case 'OUTCOME_UNKNOWN':
      // INV-X01: the outcome is UNKNOWN — reconciling, NEVER 'failed'.
      return 'reconciling';
    case 'SUCCEEDED':
      return 'fulfilled';
    case 'FAILED':
      return 'failed';
    case 'CANCELLED':
      return 'cancelled';
    case 'COMPENSATED':
      return 'compensated';
    case 'RECOVERED':
      return 'recovered';
    default: {
      const exhaustive: never = state;
      throw new ViewContractError(`unhandled execution attempt state: ${String(exhaustive)}`);
    }
  }
}

/** Which authority states render in a terminal badge (INV-X04: monotonic). */
export function isTerminalExecutionUiState(view: ExecutionUiState): boolean {
  switch (view) {
    case 'fulfilled':
    case 'failed':
    case 'cancelled':
    case 'compensated':
    case 'recovered':
      return true;
    case 'not-started':
    case 'executing':
    case 'action-required':
    case 'partially-executed':
    case 'reconciling':
      return false;
    default: {
      const exhaustive: never = view;
      throw new ViewContractError(`unhandled execution ui state: ${String(exhaustive)}`);
    }
  }
}

/** Input to the execution view derivation: the authority attempt record. */
export interface ExecutionItemInput {
  readonly attempt: ExecutionAttempt;
}

/** The derived execution view. Carries the authority ref — always. */
export interface ExecutionView {
  readonly domain: 'EXECUTION';
  readonly authorityRef: string;
  readonly attemptId: string;
  readonly planId: string;
  readonly stepId: string;
  readonly capabilityInstanceId: string;
  readonly uiState: ExecutionUiState;
  readonly terminal: boolean;
  /**
   * Provider-required customer actions surfaced VERBATIM from the preserved
   * ProviderStateEnvelope (INV-C06) — never flattened into the ui state.
   */
  readonly pendingCustomerActions: ReturnType<typeof pendingCustomerActions>;
  readonly title: string;
  readonly actions: readonly ViewAction[];
}

/** Derive the execution view from the authority attempt (pure, total). */
export function deriveExecutionView(input: ExecutionItemInput): ExecutionView {
  const attempt = input.attempt;
  const uiState = deriveExecutionUiState(attempt.state);
  const actions: ViewAction[] = [];
  const base = { authorityRef: attempt.attemptId };

  actions.push({
    actionId: 'view-execution-evidence',
    label: 'View execution evidence',
    kind: 'EVIDENCE_VIEW',
    ...base,
    available: attempt.evidence.length > 0,
    ...(attempt.evidence.length > 0 ? {} : { unavailableReason: 'no evidence recorded on this attempt yet' }),
  });

  const customerActions = pendingCustomerActions(attempt);
  for (const required of customerActions) {
    actions.push({
      actionId: `complete-provider-action:${required.kind}`,
      label: required.message,
      kind: 'EXTERNAL_OPEN',
      ...base,
      available: true,
      ...(required.deepLink === undefined
        ? { externalOpen: { systemName: 'provider' } }
        : { externalOpen: { systemName: 'provider', deepLink: required.deepLink } }),
    });
  }

  switch (uiState) {
    case 'reconciling':
      // INV-X01/INV-X03: honest UNKNOWN — the action path is reconciliation.
      actions.push({
        actionId: 'view-reconciliation-case',
        label: 'View reconciliation case',
        kind: 'NAVIGATION',
        ...base,
        available: true,
      });
      actions.push({
        actionId: 'refresh-authoritative-state',
        label: 'Refresh from authoritative state',
        kind: 'NAVIGATION',
        ...base,
        available: true,
      });
      break;
    case 'not-started':
    case 'executing':
    case 'partially-executed':
      actions.push({
        actionId: 'view-attempt-status',
        label: 'View attempt status',
        kind: 'NAVIGATION',
        ...base,
        available: true,
      });
      break;
    case 'action-required':
      actions.push({
        actionId: 'view-provider-envelope',
        label: 'View provider state envelope',
        kind: 'EVIDENCE_VIEW',
        ...base,
        available: attempt.providerState !== undefined,
        ...(attempt.providerState !== undefined
          ? {}
          : { unavailableReason: 'no provider state envelope preserved on this attempt yet' }),
      });
      break;
    case 'failed':
      // Retry is a NEW intent with a fresh idempotency key (INV-F05/X02);
      // UNKNOWN writes are never blindly retried and FAILED terminal states
      // render the retry path explicitly.
      actions.push({
        actionId: 'retry-as-new-intent',
        label: 'Retry as a new intent',
        kind: 'NAVIGATION',
        ...base,
        available: attempt.retryPolicy === 'SAFE_TO_RETRY',
        ...(attempt.retryPolicy === 'SAFE_TO_RETRY'
          ? {}
          : {
              unavailableReason:
                'this capability requires reconciliation before any retry (INV-X02); open the reconciliation case instead',
            }),
      });
      break;
    case 'fulfilled':
    case 'cancelled':
    case 'compensated':
    case 'recovered':
      actions.push({
        actionId: 'view-receipt',
        label: 'View receipt',
        kind: 'EVIDENCE_VIEW',
        ...base,
        available: true,
      });
      break;
    default: {
      const exhaustive: never = uiState;
      throw new ViewContractError(`unhandled execution ui state: ${String(exhaustive)}`);
    }
  }

  return Object.freeze({
    domain: 'EXECUTION',
    authorityRef: attempt.attemptId,
    attemptId: attempt.attemptId,
    planId: attempt.planId,
    stepId: attempt.stepId,
    capabilityInstanceId: attempt.capabilityInstanceId,
    uiState,
    terminal: isTerminalExecutionUiState(uiState),
    pendingCustomerActions: customerActions,
    title: `Execution ${attempt.attemptId} (${attempt.state})`,
    actions: Object.freeze(actions),
  });
}

// ---------------------------------------------------------------------------
// Approval views — one-to-one with the authority approval record
// ---------------------------------------------------------------------------

/** Approval view states, derived one-to-one from `ApprovalRecord`. */
export const APPROVAL_UI_STATES = [
  'awaiting-decision',
  'awaiting-decision-expired',
  'approved',
  'rejected',
  'consumed',
] as const;

export type ApprovalUiState = (typeof APPROVAL_UI_STATES)[number];

/** Input to the approval view derivation: the authority record + rendering. */
export interface ApprovalItemInput {
  readonly record: ApprovalRecord;
  /** The W3-001 ApprovalRequest, when the composition root retained it. */
  readonly request?: ApprovalRequest;
  /** The rendered approval message (deepLink to the trusted surface). */
  readonly renderedMessage?: ApprovalMessage;
}

/** The derived approval view. */
export interface ApprovalView {
  readonly domain: 'APPROVAL';
  readonly authorityRef: string;
  readonly requestHash: string;
  readonly uiState: ApprovalUiState;
  readonly channel: ApprovalRecord['channel'];
  readonly expiresAt: string;
  readonly deepLink?: string;
  readonly title: string;
  readonly actions: readonly ViewAction[];
}

/** Total derivation of the approval view state from the authority record. */
export function deriveApprovalUiState(record: ApprovalRecord, nowMs: number): ApprovalUiState {
  if (record.status === 'PENDING') {
    const expiresAtMs = Date.parse(record.expiresAt);
    // An expired window is still an authority fact (PENDING + time), surfaced
    // explicitly — never silently restyled as approved or rejected.
    return Number.isFinite(expiresAtMs) && expiresAtMs > nowMs
      ? 'awaiting-decision'
      : 'awaiting-decision-expired';
  }
  switch (record.status) {
    case 'APPROVED':
      return 'approved';
    case 'REJECTED':
      return 'rejected';
    case 'CONSUMED':
      return 'consumed';
    default: {
      const exhaustive: never = record.status;
      throw new ViewContractError(`unhandled approval status: ${String(exhaustive)}`);
    }
  }
}

/** Derive the approval view (pure; the ONLY approval view constructor). */
export function deriveApprovalView(input: ApprovalItemInput, nowMs: number): ApprovalView {
  const record = input.record;
  const uiState = deriveApprovalUiState(record, nowMs);
  const base = { authorityRef: record.requestHash };
  const actions: ViewAction[] = [];
  const deepLink = input.renderedMessage?.deepLink;

  switch (uiState) {
    case 'awaiting-decision':
      // AGENTS.md rule 10 / INV-A03: approval completes on the TRUSTED surface.
      actions.push({
        actionId: 'open-trusted-approval-surface',
        label: 'Review and decide on the trusted approval surface',
        kind: 'TRUSTED_SURFACE',
        ...base,
        available: true,
        trustedSurface:
          deepLink === undefined
            ? { requestHash: record.requestHash }
            : { requestHash: record.requestHash, deepLink },
      });
      actions.push({
        actionId: 'view-approval-scope',
        label: 'View requested authority scope',
        kind: 'EVIDENCE_VIEW',
        ...base,
        available: input.request !== undefined,
        ...(input.request === undefined
          ? { unavailableReason: 'the original ApprovalRequest was not retained in this snapshot' }
          : {}),
      });
      break;
    case 'awaiting-decision-expired':
      actions.push({
        actionId: 're-request-approval',
        label: 'Re-request approval (window expired)',
        kind: 'NAVIGATION',
        ...base,
        available: true,
      });
      actions.push({
        actionId: 'view-approval-history',
        label: 'View approval history',
        kind: 'EVIDENCE_VIEW',
        ...base,
        available: true,
      });
      break;
    case 'approved':
      actions.push({
        actionId: 'view-approval-artifact',
        label: 'View signed approval artifact',
        kind: 'EVIDENCE_VIEW',
        ...base,
        available: record.artifactRef !== undefined,
        ...(record.artifactRef === undefined
          ? { unavailableReason: 'artifact reference not present on this record projection' }
          : {}),
      });
      break;
    case 'rejected':
    case 'consumed':
      actions.push({
        actionId: 'view-approval-history',
        label: 'View approval history',
        kind: 'EVIDENCE_VIEW',
        ...base,
        available: true,
      });
      break;
    default: {
      const exhaustive: never = uiState;
      throw new ViewContractError(`unhandled approval ui state: ${String(exhaustive)}`);
    }
  }

  return Object.freeze({
    domain: 'APPROVAL',
    authorityRef: record.requestHash,
    requestHash: record.requestHash,
    uiState,
    channel: record.channel,
    expiresAt: record.expiresAt,
    ...(deepLink === undefined ? {} : { deepLink }),
    title: `Approval ${record.requestHash.slice(0, 12)} (${record.status})`,
    actions: Object.freeze(actions),
  });
}

// ---------------------------------------------------------------------------
// Mandate views — one-to-one with the authority mandate machine
// ---------------------------------------------------------------------------

/** Mandate view states, derived one-to-one from `MandateState` (W1-003). */
export const MANDATE_UI_STATES = [
  'pending-activation',
  'active',
  'paused',
  'cancelled',
  'expired',
] as const;

export type MandateUiState = (typeof MANDATE_UI_STATES)[number];

/** Input to the mandate view derivation: the authority mandate record. */
export interface MandateItemInput {
  readonly mandate: RecurringMandate;
}

/** The derived mandate view with its economic control surface. */
export interface MandateView {
  readonly domain: 'MANDATE';
  readonly authorityRef: string;
  readonly mandateId: string;
  readonly uiState: MandateUiState;
  /** Declarative expiry reached while the authority state is still ACTIVE/PAUSED. */
  readonly expiryReached: boolean;
  readonly perChargeMaximum: { readonly currency: string; readonly value: bigint };
  readonly schedule: RecurringMandate['schedule'];
  readonly chargeCount: bigint;
  readonly remainingCharges: bigint | undefined;
  readonly title: string;
  readonly actions: readonly ViewAction[];
}

/** Total mapping from authority mandate state to the view state. */
export function deriveMandateUiState(state: RecurringMandate['state']): MandateUiState {
  switch (state) {
    case 'PENDING':
      return 'pending-activation';
    case 'ACTIVE':
      return 'active';
    case 'PAUSED':
      return 'paused';
    case 'CANCELLED':
      return 'cancelled';
    case 'EXPIRED':
      return 'expired';
    default: {
      const exhaustive: never = state;
      throw new ViewContractError(`unhandled mandate state: ${String(exhaustive)}`);
    }
  }
}

/**
 * Derive the mandate view. The actions are the AUTHORITY machine's own legal
 * events (`mandateStateMachine.canTransition`) — the view offers exactly what
 * the authority allows, no more, no less (one-to-one). There is deliberately
 * NO renewal action: renewal is a NEW mandate requiring fresh authorization
 * (PAYMENT-OPERATING-PLANE "Recurring").
 */
export function deriveMandateView(input: MandateItemInput, nowMs: number): MandateView {
  const mandate = input.mandate;
  const uiState = deriveMandateUiState(mandate.state);
  const expiryReached = nowMs >= mandate.expiresAt;
  const base = { authorityRef: mandate.id };
  const actions: ViewAction[] = [];

  const EVENT_LABELS: Readonly<Record<string, string>> = {
    ACTIVATE: 'Activate mandate',
    PAUSE: 'Pause mandate',
    RESUME: 'Resume mandate',
    CANCEL: 'Cancel mandate',
    EXPIRE: 'Record mandate expiry',
  };

  for (const event of mandateStateMachine.events) {
    const legal = mandateStateMachine.canTransition(mandate.state, event, {
      now: BigInt(nowMs),
      expiresAt: mandate.expiresAt,
    });
    if (!legal) {
      continue;
    }
    actions.push({
      actionId: `mandate-${event.toLowerCase()}`,
      label: EVENT_LABELS[event] ?? `Mandate ${event.toLowerCase()}`,
      kind: 'AUTHORITY_TRANSITION',
      ...base,
      available: true,
      authorityEvent: { domain: 'MANDATE', authorityId: mandate.id, event },
    });
  }

  if (uiState === 'cancelled' || uiState === 'expired') {
    // No renewal transition exists in the authority machine; the honest
    // action is requesting authorization for a NEW mandate.
    actions.push({
      actionId: 'request-new-mandate-authorization',
      label: 'Authorize a new mandate (renewal never extends authority)',
      kind: 'API_COMMAND',
      ...base,
      available: true,
      apiCommand: {
        method: 'POST',
        path: '/v1/approvals',
        body: {
          principal: mandate.payer,
          scope: {
            actions: ['payments.mandate.create'],
            resources: [{ type: 'mandate' }],
            maxAmount: {
              currency: mandate.maxAmountPerCharge.currency,
              minorUnits: mandate.maxAmountPerCharge.value.toString(),
            },
          },
        },
      },
    });
  }

  if (uiState === 'active' || uiState === 'pending-activation') {
    actions.push({
      actionId: 'view-charge-admissibility',
      label: 'View charge admissibility',
      kind: 'NAVIGATION',
      ...base,
      available: true,
    });
  }

  actions.push({
    actionId: 'view-mandate-scope',
    label: 'View mandate scope and maximums',
    kind: 'EVIDENCE_VIEW',
    ...base,
    available: true,
  });

  return Object.freeze({
    domain: 'MANDATE',
    authorityRef: mandate.id,
    mandateId: mandate.id,
    uiState,
    expiryReached,
    perChargeMaximum: mandate.maxAmountPerCharge,
    schedule: mandate.schedule,
    chargeCount: mandate.chargeCount,
    remainingCharges:
      mandate.schedule.maxCharges > 0n
        ? mandate.schedule.maxCharges - mandate.chargeCount
        : undefined,
    title: `Mandate ${mandate.id} (${mandate.state})`,
    actions: Object.freeze(actions),
  });
}

// ---------------------------------------------------------------------------
// Off-network record views — honest about external attribution
// ---------------------------------------------------------------------------

/** Off-network view states, one-to-one with `OffNetworkReconciliationState`. */
export const OFF_NETWORK_UI_STATES = [
  'unreconciled',
  'reconciling',
  'reconciled',
  'discrepant',
] as const;

export type OffNetworkUiState = (typeof OFF_NETWORK_UI_STATES)[number];

/** Input to the off-network view derivation: the authority record. */
export interface OffNetworkItemInput {
  readonly record: OffNetworkPaymentRecord;
}

/** The derived off-network record view. */
export interface OffNetworkView {
  readonly domain: 'OFF_NETWORK_RECORD';
  readonly authorityRef: string;
  readonly recordId: string;
  readonly uiState: OffNetworkUiState;
  /** Honest attribution: never PaySwap execution (W1-003 structural marker). */
  readonly orchestratedBy: 'EXTERNAL_PARTY';
  readonly evidenceCount: number;
  readonly title: string;
  readonly actions: readonly ViewAction[];
}

/** Total mapping from the authority reconciliation state to the view state. */
export function deriveOffNetworkUiState(
  state: OffNetworkPaymentRecord['reconciliationState'],
): OffNetworkUiState {
  switch (state) {
    case 'UNRECONCILED':
      return 'unreconciled';
    case 'RECONCILING':
      return 'reconciling';
    case 'RECONCILED':
      return 'reconciled';
    case 'DISCREPANT':
      return 'discrepant';
    default: {
      const exhaustive: never = state;
      throw new ViewContractError(`unhandled off-network reconciliation state: ${String(exhaustive)}`);
    }
  }
}

/** Derive the off-network record view (pure). */
export function deriveOffNetworkView(input: OffNetworkItemInput): OffNetworkView {
  const record = input.record;
  const uiState = deriveOffNetworkUiState(record.reconciliationState);
  const base = { authorityRef: record.id };
  const actions: ViewAction[] = [];

  actions.push({
    actionId: 'view-off-network-evidence',
    label: 'View recorded evidence',
    kind: 'EVIDENCE_VIEW',
    ...base,
    available: record.evidence.length > 0,
    ...(record.evidence.length > 0
      ? {}
      : { unavailableReason: 'no evidence attached to this record yet' }),
  });
  actions.push({
    actionId: 'view-business-document-links',
    label: 'View linked business documents',
    ...base,
    kind: 'NAVIGATION',
    available: record.businessDocumentRefs.length > 0,
    ...(record.businessDocumentRefs.length > 0
      ? {}
      : { unavailableReason: 'this record is not linked to business documents yet' }),
  });

  switch (uiState) {
    case 'unreconciled':
      actions.push({
        actionId: 'off-network-begin-reconciliation',
        label: 'Begin reconciliation against external evidence',
        kind: 'AUTHORITY_TRANSITION',
        ...base,
        available: true,
        authorityEvent: { domain: 'OFF_NETWORK_RECORD', authorityId: record.id, event: 'RECONCILING' },
      });
      break;
    case 'reconciling':
      actions.push({
        actionId: 'off-network-resolve-reconciliation',
        label: 'Resolve reconciliation (reconciled or discrepant)',
        kind: 'AUTHORITY_TRANSITION',
        ...base,
        available: true,
        authorityEvent: { domain: 'OFF_NETWORK_RECORD', authorityId: record.id, event: 'RESOLVE' },
      });
      break;
    case 'discrepant':
      actions.push({
        actionId: 'off-network-investigate-discrepancy',
        label: 'Investigate discrepancy and re-reconcile',
        kind: 'AUTHORITY_TRANSITION',
        ...base,
        available: true,
        authorityEvent: { domain: 'OFF_NETWORK_RECORD', authorityId: record.id, event: 'RECONCILING' },
      });
      break;
    case 'reconciled':
      break;
    default: {
      const exhaustive: never = uiState;
      throw new ViewContractError(`unhandled off-network ui state: ${String(exhaustive)}`);
    }
  }

  return Object.freeze({
    domain: 'OFF_NETWORK_RECORD',
    authorityRef: record.id,
    recordId: record.id,
    uiState,
    orchestratedBy: 'EXTERNAL_PARTY',
    evidenceCount: record.evidence.length,
    title: `Off-network ${record.source.toLowerCase()} ${record.id}`,
    actions: Object.freeze(actions),
  });
}

// ---------------------------------------------------------------------------
// Capability (offer) views — derived from authoritative acceptance state
// ---------------------------------------------------------------------------

/** Input: a derived offer, or a typed derivation rejection (no offer). */
export type CapabilityItemInput =
  | { readonly kind: 'OFFER'; readonly offer: PaymentMethodOffer }
  | {
      readonly kind: 'REJECTION';
      readonly methodId: string;
      /** The @payswap/execution typed derivation rejection (ok: false). */
      readonly derivation: Extract<OfferDerivation, { readonly ok: false }>;
    };

/** The derived capability surface view. */
export interface CapabilityView {
  readonly domain: 'CAPABILITY';
  readonly authorityRef: string;
  readonly methodId: string;
  readonly offered: boolean;
  readonly uiState: 'offered' | 'not-offered';
  /** Present when offered: the authority-derived offer record. */
  readonly offer?: PaymentMethodOffer;
  /** Present when not offered: the typed authority rejection reason. */
  readonly rejectionReason?: string;
  readonly rejectionMessage?: string;
  readonly title: string;
  readonly actions: readonly ViewAction[];
}

/** Derive the capability view (pure). */
export function deriveCapabilityView(input: CapabilityItemInput): CapabilityView {
  const base = (authorityRef: string) => ({ authorityRef });
  if (input.kind === 'OFFER') {
    const offer = input.offer;
    const actions: ViewAction[] = [
      {
        actionId: 'inspect-rail-path',
        label: 'Inspect actual rail path, fees and execution mode',
        kind: 'EVIDENCE_VIEW',
        ...base(offer.offerId),
        available: true,
      },
      {
        actionId: 'view-settlement-destination',
        label: 'View merchant settlement destination (external)',
        kind: 'EVIDENCE_VIEW',
        ...base(offer.offerId),
        available: true,
      },
    ];
    if (offer.requiredCustomerActions.length > 0) {
      actions.push({
        actionId: 'review-required-customer-actions',
        label: 'Review required customer actions',
        kind: 'NAVIGATION',
        ...base(offer.offerId),
        available: true,
      });
    }
    return Object.freeze({
      domain: 'CAPABILITY',
      authorityRef: offer.offerId,
      methodId: offer.methodId,
      offered: true,
      uiState: 'offered',
      ...(offer === undefined ? {} : { offer }),
      title: `Offer for ${offer.methodId}`,
      actions: Object.freeze(actions),
    });
  }
  const derivation = input.derivation;
  const rejectionActions: ViewAction[] = [
    {
      actionId: 'view-why-not-offered',
      label: 'View why this method is not offered',
      kind: 'EVIDENCE_VIEW',
      ...base(`${input.methodId}:${derivation.reason}`),
      available: true,
    },
    {
      actionId: 'adjust-constraints',
      label: 'Adjust request constraints or connect a capability',
      kind: 'NAVIGATION',
      ...base(`${input.methodId}:${derivation.reason}`),
      available: true,
    },
  ];
  return Object.freeze({
    domain: 'CAPABILITY',
    authorityRef: `${input.methodId}:${derivation.reason}`,
    methodId: input.methodId,
    offered: false,
    uiState: 'not-offered',
    rejectionReason: derivation.reason,
    rejectionMessage: derivation.message,
    title: `No offer for ${input.methodId}`,
    actions: Object.freeze(rejectionActions),
  });
}

// ---------------------------------------------------------------------------
// The Command Center snapshot
// ---------------------------------------------------------------------------

/** The viewer whose Command Center is being derived. */
export interface ViewerContext {
  readonly principal: string;
  readonly roleLabels: readonly string[];
  readonly agentRefs: readonly string[];
}

/** Remittance (invoice/order/project allocation) authority input. */
export interface RemittanceItemInput {
  readonly allocation: RemittanceAllocation;
}

/**
 * The authority snapshot the Command Center is derived from. Composed by the
 * deployment root (W3-007) from the authoritative packages; this package adds
 * nothing to it and invents nothing from it.
 */
export interface CommandCenterSnapshot {
  readonly viewer: ViewerContext;
  readonly approvals: readonly ApprovalItemInput[];
  readonly executions: readonly ExecutionItemInput[];
  readonly capabilities: readonly CapabilityItemInput[];
  readonly mandates: readonly MandateItemInput[];
  readonly offNetworkRecords: readonly OffNetworkItemInput[];
  readonly remittances: readonly RemittanceItemInput[];
  readonly generic: readonly GenericAuthorityItem[];
}

/** An empty snapshot (empty states are still honest states). */
export function emptySnapshot(viewer: ViewerContext): CommandCenterSnapshot {
  return Object.freeze({
    viewer: Object.freeze(viewer),
    approvals: [],
    executions: [],
    capabilities: [],
    mandates: [],
    offNetworkRecords: [],
    remittances: [],
    generic: [],
  });
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface SearchQueryInput {
  readonly text: string;
  /** Restrict the search to these domains; undefined searches all domains. */
  readonly domains?: readonly CommandCenterDomain[];
}

export interface SearchHit {
  readonly domain: CommandCenterDomain;
  readonly authorityRef: string;
  readonly title: string;
  readonly matchedOn: readonly string[];
}

export interface SearchResultSet {
  readonly hits: readonly SearchHit[];
  /** How many authority items were scanned, by domain. */
  readonly scanned: Readonly<Record<CommandCenterDomain, number>>;
}

interface SearchableEntry {
  readonly domain: CommandCenterDomain;
  readonly authorityRef: string;
  readonly title: string;
  readonly keywords: readonly string[];
}

function searchableEntries(snapshot: CommandCenterSnapshot): SearchableEntry[] {
  const entries: SearchableEntry[] = [];
  for (const approval of snapshot.approvals) {
    entries.push({
      domain: 'APPROVAL',
      authorityRef: approval.record.requestHash,
      title: `Approval ${approval.record.requestHash}`,
      keywords: ['approval', approval.record.status, approval.record.channel],
    });
  }
  for (const execution of snapshot.executions) {
    entries.push({
      domain: 'EXECUTION',
      authorityRef: execution.attempt.attemptId,
      title: `Execution ${execution.attempt.attemptId}`,
      keywords: ['execution', 'payment', execution.attempt.state, execution.attempt.capabilityInstanceId],
    });
  }
  for (const capability of snapshot.capabilities) {
    if (capability.kind === 'OFFER') {
      entries.push({
        domain: 'CAPABILITY',
        authorityRef: capability.offer.offerId,
        title: `Offer for ${capability.offer.methodId}`,
        keywords: ['offer', 'capability', 'payment-method', capability.offer.methodId],
      });
    } else {
      entries.push({
        domain: 'CAPABILITY',
        authorityRef: `${capability.methodId}:${capability.derivation.reason}`,
        title: `No offer for ${capability.methodId}`,
        keywords: ['capability', 'payment-method', capability.methodId, capability.derivation.reason],
      });
    }
  }
  for (const mandate of snapshot.mandates) {
    entries.push({
      domain: 'MANDATE',
      authorityRef: mandate.mandate.id,
      title: `Mandate ${mandate.mandate.id}`,
      keywords: ['mandate', 'recurring', mandate.mandate.state, mandate.mandate.scope],
    });
  }
  for (const offNetwork of snapshot.offNetworkRecords) {
    entries.push({
      domain: 'OFF_NETWORK_RECORD',
      authorityRef: offNetwork.record.id,
      title: `Off-network ${offNetwork.record.source.toLowerCase()} ${offNetwork.record.id}`,
      keywords: ['off-network', offNetwork.record.source, offNetwork.record.reconciliationState],
    });
  }
  for (const remittance of snapshot.remittances) {
    entries.push({
      domain: 'REMITTANCE',
      authorityRef: remittance.allocation.id,
      title: `Remittance ${remittance.allocation.id}`,
      keywords: ['remittance', 'allocation', remittance.allocation.paymentRef],
    });
  }
  for (const item of snapshot.generic) {
    entries.push({
      domain: item.domain,
      authorityRef: item.authorityRef,
      title: item.title,
      keywords: ['generic', item.authorityState, ...item.keywords],
    });
  }
  return entries;
}

/**
 * Deterministic search over the authority snapshot. Tokens are matched
 * (case-insensitive, substring) against title, keywords and the authority
 * reference; every token must match for a hit. Order is stable: domain order,
 * then authority reference. An empty query returns no hits (the inbox is the
 * default surface, not an unfiltered list).
 */
export function searchCommandCenter(
  snapshot: CommandCenterSnapshot,
  query: SearchQueryInput,
): SearchResultSet {
  const scanned = emptyScanned();
  const entries = searchableEntries(snapshot);
  const tokens = query.text
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0);
  const domainFilter =
    query.domains === undefined ? undefined : new Set<CommandCenterDomain>(query.domains);

  const hits: SearchHit[] = [];
  for (const entry of entries) {
    scanned[entry.domain] += 1;
    if (domainFilter !== undefined && !domainFilter.has(entry.domain)) {
      continue;
    }
    if (tokens.length === 0) {
      continue;
    }
    const matchedOn: string[] = [];
    let allTokensMatch = true;
    for (const token of tokens) {
      const tokenMatches =
        entry.title.toLowerCase().includes(token) ||
        entry.authorityRef.toLowerCase().includes(token) ||
        entry.keywords.some((keyword) => keyword.toLowerCase().includes(token));
      if (!tokenMatches) {
        allTokensMatch = false;
        break;
      }
      if (entry.title.toLowerCase().includes(token)) {
        matchedOn.push('title');
      }
      if (entry.authorityRef.toLowerCase().includes(token)) {
        matchedOn.push('authorityRef');
      }
      if (entry.keywords.some((keyword) => keyword.toLowerCase().includes(token))) {
        matchedOn.push('keywords');
      }
    }
    if (allTokensMatch) {
      hits.push({
        domain: entry.domain,
        authorityRef: entry.authorityRef,
        title: entry.title,
        matchedOn: Object.freeze([...new Set(matchedOn)]),
      });
    }
  }

  hits.sort((left, right) => {
    const domainOrder = COMMAND_CENTER_DOMAINS.indexOf(left.domain) - COMMAND_CENTER_DOMAINS.indexOf(right.domain);
    if (domainOrder !== 0) {
      return domainOrder;
    }
    return left.authorityRef < right.authorityRef ? -1 : left.authorityRef > right.authorityRef ? 1 : 0;
  });

  return Object.freeze({ hits: Object.freeze(hits), scanned });
}

function emptyScanned(): Record<CommandCenterDomain, number> {
  const record = {} as Record<CommandCenterDomain, number>;
  for (const domain of COMMAND_CENTER_DOMAINS) {
    record[domain] = 0;
  }
  return record;
}

// ---------------------------------------------------------------------------
// Universal inbox
// ---------------------------------------------------------------------------

export type InboxUrgency = 'ACTION_REQUIRED' | 'RECONCILING' | 'REVIEW' | 'FYI';

export interface InboxEntry {
  readonly domain: CommandCenterDomain;
  readonly authorityRef: string;
  readonly title: string;
  readonly urgency: InboxUrgency;
  readonly uiState: UiState;
  readonly reason: string;
  readonly actions: readonly ViewAction[];
}

export interface UniversalInbox {
  readonly entries: readonly InboxEntry[];
  readonly counts: Readonly<Record<InboxUrgency, number>>;
}

/**
 * Aggregate the universal inbox from the authority snapshot. Inclusion and
 * urgency are deterministic functions of authority state; every entry carries
 * at least one AVAILABLE action (no dead inbox items).
 */
export function aggregateInbox(snapshot: CommandCenterSnapshot, nowMs: number): UniversalInbox {
  const entries: InboxEntry[] = [];
  const counts: Record<InboxUrgency, number> = { ACTION_REQUIRED: 0, RECONCILING: 0, REVIEW: 0, FYI: 0 };

  const add = (entry: InboxEntry): void => {
    const available = entry.actions.some((action) => action.available);
    if (!available) {
      throw new ViewContractError(
        `inbox entry ${entry.authorityRef} has no available action (dead inbox item)`,
      );
    }
    counts[entry.urgency] += 1;
    entries.push(Object.freeze(entry));
  };

  for (const approval of snapshot.approvals) {
    const view = deriveApprovalView(approval, nowMs);
    if (view.uiState === 'awaiting-decision') {
      add({
        domain: 'APPROVAL',
        authorityRef: view.authorityRef,
        title: view.title,
        urgency: 'ACTION_REQUIRED',
        uiState: 'action-required',
        reason: 'an approval decision is pending within its window',
        actions: view.actions,
      });
    } else if (view.uiState === 'awaiting-decision-expired') {
      add({
        domain: 'APPROVAL',
        authorityRef: view.authorityRef,
        title: view.title,
        urgency: 'REVIEW',
        uiState: 'action-required',
        reason: 'the approval window expired before a decision was recorded',
        actions: view.actions,
      });
    }
  }

  for (const execution of snapshot.executions) {
    const view = deriveExecutionView(execution);
    if (view.uiState === 'action-required') {
      add({
        domain: 'EXECUTION',
        authorityRef: view.authorityRef,
        title: view.title,
        urgency: 'ACTION_REQUIRED',
        uiState: 'action-required',
        reason: 'the provider is waiting on a preserved customer action (INV-C06)',
        actions: view.actions,
      });
    } else if (view.uiState === 'reconciling') {
      // INV-X01: outcome UNKNOWN — reconciling, never failure.
      add({
        domain: 'EXECUTION',
        authorityRef: view.authorityRef,
        title: view.title,
        urgency: 'RECONCILING',
        uiState: 'reconciling',
        reason: 'the external outcome is unknown and reconciliation is authoritative (INV-X03)',
        actions: view.actions,
      });
    }
  }

  for (const mandate of snapshot.mandates) {
    const view = deriveMandateView(mandate, nowMs);
    if (view.uiState === 'pending-activation' || view.uiState === 'active' || view.uiState === 'paused') {
      add({
        domain: 'MANDATE',
        authorityRef: view.authorityRef,
        title: view.title,
        urgency: 'REVIEW',
        uiState: 'reconciling',
        reason: view.expiryReached
          ? 'the mandate validity window has been reached; the authority state must record expiry'
          : 'recurring authority is live; charges are bounded by the mandate',
        actions: view.actions,
      });
    }
  }

  for (const offNetwork of snapshot.offNetworkRecords) {
    const view = deriveOffNetworkView(offNetwork);
    if (view.uiState !== 'reconciled') {
      add({
        domain: 'OFF_NETWORK_RECORD',
        authorityRef: view.authorityRef,
        title: view.title,
        urgency: 'REVIEW',
        uiState: view.uiState === 'reconciling' ? 'reconciling' : 'action-required',
        reason:
          view.uiState === 'discrepant'
            ? 'external evidence disagrees with the recorded off-network payment'
            : 'an off-network payment is not yet reconciled against external evidence',
        actions: view.actions,
      });
    }
  }

  for (const capability of snapshot.capabilities) {
    const view = deriveCapabilityView(capability);
    if (!view.offered) {
      add({
        domain: 'CAPABILITY',
        authorityRef: view.authorityRef,
        title: view.title,
        urgency: 'REVIEW',
        uiState: 'no-viable-route',
        reason: `no offer could be derived (${view.rejectionReason ?? 'unknown reason'})`,
        actions: view.actions,
      });
    }
  }

  for (const item of snapshot.generic) {
    if (item.requiresAttention === true) {
      add({
        domain: item.domain,
        authorityRef: item.authorityRef,
        title: item.title,
        urgency: 'REVIEW',
        uiState: 'action-required',
        reason: `flagged by the authoritative system (authority state: ${item.authorityState})`,
        actions: Object.freeze([
          {
            actionId: 'view-authoritative-item',
            label: 'Open the authoritative item',
            kind: 'NAVIGATION',
            authorityRef: item.authorityRef,
            available: true,
          },
        ]),
      });
    }
  }

  return Object.freeze({
    entries: Object.freeze(entries),
    counts: Object.freeze({ ...counts }),
  });
}

// ---------------------------------------------------------------------------
// Work-Graph context assembly
// ---------------------------------------------------------------------------

export interface WorkGraphFocus {
  readonly nodeKind: 'PROJECT' | 'CASE' | 'WORK_ITEM';
  readonly nodeId: string;
}

export type WorkGraphRelation = 'BELONGS_TO' | 'SETTLES' | 'DOCUMENTS' | 'TRACKS' | 'REQUIRES_APPROVAL';

export interface WorkGraphLinkedRef {
  readonly domain: CommandCenterDomain;
  readonly authorityRef: string;
  readonly relation: WorkGraphRelation;
}

/** FRONTEND-UX-DEPLOYMENT "Agent UX": agents visible as collaborators. */
export interface AgentCollaborationView {
  readonly agentRef: string;
  readonly proposedItems: readonly GenericAuthorityItem[];
  readonly pendingApprovals: readonly string[];
  readonly spendAuthorityMandates: readonly string[];
  readonly note: string;
}

export interface WorkGraphContextView {
  readonly focus: WorkGraphFocus;
  readonly linked: readonly WorkGraphLinkedRef[];
  readonly workItems: readonly GenericAuthorityItem[];
  readonly agentCollaborators: readonly AgentCollaborationView[];
  readonly empty: boolean;
}

/**
 * Assemble the Work-Graph context view for a focus node. Links are derived
 * from authority business references only (remittance document allocations,
 * off-network business document refs, generic linkedRefs) — the graph is
 * context, never a replacement for the authoritative systems of record.
 */
export function assembleWorkGraphContext(
  snapshot: CommandCenterSnapshot,
  focus: WorkGraphFocus,
): WorkGraphContextView {
  const focusRef = `${focus.nodeKind}:${focus.nodeId}`;
  const linked: WorkGraphLinkedRef[] = [];
  const workItems: GenericAuthorityItem[] = [];

  for (const item of snapshot.generic) {
    if (item.domain === 'WORK_ITEM') {
      if (item.authorityRef === focus.nodeId || item.linkedRefs?.includes(focusRef) === true) {
        workItems.push(item);
        linked.push({ domain: 'WORK_ITEM', authorityRef: item.authorityRef, relation: 'BELONGS_TO' });
      }
    }
    if (item.linkedRefs?.includes(focusRef) === true) {
      linked.push({ domain: item.domain, authorityRef: item.authorityRef, relation: 'TRACKS' });
    }
  }

  for (const remittance of snapshot.remittances) {
    const allocation = remittance.allocation;
    const matchesFocus = allocation.allocations.some(
      (entry) =>
        (focus.nodeKind === 'PROJECT' && entry.documentKind === 'PROJECT_MILESTONE' && entry.documentId === focus.nodeId) ||
        (focus.nodeKind !== 'PROJECT' && entry.documentKind === 'INVOICE' && entry.documentId === focus.nodeId) ||
        (focus.nodeKind !== 'PROJECT' && entry.documentKind === 'ORDER' && entry.documentId === focus.nodeId),
    );
    if (matchesFocus) {
      linked.push({ domain: 'REMITTANCE', authorityRef: allocation.id, relation: 'SETTLES' });
    }
  }

  for (const offNetwork of snapshot.offNetworkRecords) {
    const record = offNetwork.record;
    const matchesFocus =
      record.businessDocumentRefs.some((ref) => ref.documentId === focus.nodeId) ||
      record.businessDocumentRefs.some((ref) => `${ref.documentKind}:${ref.documentId}` === focusRef);
    if (matchesFocus) {
      linked.push({ domain: 'OFF_NETWORK_RECORD', authorityRef: record.id, relation: 'DOCUMENTS' });
    }
  }

  // NOTE: approvals are not focus-linked here — an approval request carries no
  // Work-Graph business reference. Agent-bound approvals remain visible in the
  // agent-collaboration views below (their pending approvals), which is the
  // honest linkage the authority records support.

  const collaborators = deriveAgentCollaborators(snapshot);
  return Object.freeze({
    focus: Object.freeze({ ...focus }),
    linked: Object.freeze(linked),
    workItems: Object.freeze(workItems),
    agentCollaborators: collaborators,
    empty: linked.length === 0 && workItems.length === 0,
  });
}

function deriveAgentCollaborators(snapshot: CommandCenterSnapshot): readonly AgentCollaborationView[] {
  const byAgent = new Map<string, { proposals: GenericAuthorityItem[]; approvals: string[]; mandates: string[] }>();
  const entry = (agentRef: string) => {
    const existing = byAgent.get(agentRef);
    if (existing !== undefined) {
      return existing;
    }
    const fresh = { proposals: [] as GenericAuthorityItem[], approvals: [] as string[], mandates: [] as string[] };
    byAgent.set(agentRef, fresh);
    return fresh;
  };

  for (const viewerAgent of snapshot.viewer.agentRefs) {
    entry(viewerAgent);
  }
  for (const item of snapshot.generic) {
    if (item.proposedByAgent !== undefined) {
      entry(item.proposedByAgent).proposals.push(item);
    }
  }
  for (const approval of snapshot.approvals) {
    const agentRef = approval.request?.agentRef;
    if (agentRef !== undefined) {
      entry(agentRef).approvals.push(approval.record.requestHash);
    }
  }
  for (const mandate of snapshot.mandates) {
    if (snapshot.viewer.agentRefs.includes(mandate.mandate.payer)) {
      entry(mandate.mandate.payer).mandates.push(mandate.mandate.id);
    }
  }

  const views: AgentCollaborationView[] = [];
  for (const [agentRef, data] of byAgent) {
    views.push(
      Object.freeze({
        agentRef,
        proposedItems: Object.freeze(data.proposals),
        pendingApprovals: Object.freeze(data.approvals),
        spendAuthorityMandates: Object.freeze(data.mandates),
        note:
          'agents propose; consequential effects require protocol authorization and (where mandated) a signed approval artifact (INV-G03/INV-A03)',
      }),
    );
  }
  views.sort((left, right) => (left.agentRef < right.agentRef ? -1 : left.agentRef > right.agentRef ? 1 : 0));
  return Object.freeze(views);
}

// ---------------------------------------------------------------------------
// Economic controls surface
// ---------------------------------------------------------------------------

/** Exact, lossless money rendering (INV-F01): minor units, no float math. */
export function formatExactMinorUnits(amount: { readonly currency: string; readonly value: bigint }): string {
  return `${amount.currency} ${amount.value.toString()} (exact minor units)`;
}

/** An honest per-currency total over reported off-network records. */
export interface OffNetworkTotalsView {
  readonly currency: string;
  readonly exactTotalMinorUnits: bigint;
  readonly recordCount: number;
  readonly attribution: 'EXTERNAL_PARTY_REPORTED';
  readonly note: string;
}

export interface EconomicControlsView {
  readonly mandates: readonly MandateView[];
  readonly offNetworkTotals: readonly OffNetworkTotalsView[];
  readonly pendingApprovalCount: number;
  readonly reconcilingExecutionCount: number;
}

/**
 * Derive the economic-controls surface. Every control is bound to authority:
 * mandates (recurring spend authority), honest off-network totals (explicitly
 * NOT PaySwap-executed money) and the counts of pending approvals and
 * reconciling executions.
 */
export function deriveEconomicControls(snapshot: CommandCenterSnapshot, nowMs: number): EconomicControlsView {
  const mandates = snapshot.mandates.map((input) => deriveMandateView(input, nowMs));

  const totals = new Map<string, { total: bigint; count: number }>();
  for (const offNetwork of snapshot.offNetworkRecords) {
    const record = offNetwork.record;
    const current = totals.get(record.amount.currency) ?? { total: 0n, count: 0 };
    totals.set(record.amount.currency, {
      total: current.total + record.amount.value,
      count: current.count + 1,
    });
  }
  const offNetworkTotals: OffNetworkTotalsView[] = [...totals.entries()]
    .map(([currency, value]) =>
      Object.freeze({
        currency,
        exactTotalMinorUnits: value.total,
        recordCount: value.count,
        attribution: 'EXTERNAL_PARTY_REPORTED' as const,
        note: 'reported external movements; never PaySwap-executed settlements and never PaySwap custody',
      }),
    )
    .sort((left, right) => (left.currency < right.currency ? -1 : left.currency > right.currency ? 1 : 0));

  let pendingApprovalCount = 0;
  for (const approval of snapshot.approvals) {
    if (deriveApprovalUiState(approval.record, nowMs) === 'awaiting-decision') {
      pendingApprovalCount += 1;
    }
  }
  let reconcilingExecutionCount = 0;
  for (const execution of snapshot.executions) {
    if (deriveExecutionUiState(execution.attempt.state) === 'reconciling') {
      reconcilingExecutionCount += 1;
    }
  }

  return Object.freeze({
    mandates: Object.freeze(mandates),
    offNetworkTotals: Object.freeze(offNetworkTotals),
    pendingApprovalCount,
    reconcilingExecutionCount,
  });
}

// ---------------------------------------------------------------------------
// Terminal mapping passthrough (consumed, never re-defined)
// ---------------------------------------------------------------------------

/**
 * The canonical terminal protocol state → UI state mapping, CONSUMED from
 * @payswap/interfaces (W3-001). Re-exported so UIs implementing this contract
 * layer import exactly one mapping — never a parallel one.
 */
export { mapTerminalStateToUi };

/** Convenience derivation for any terminal authority state (total). */
export function deriveTerminalUiState(state: TerminalState): UiState {
  return mapTerminalStateToUi(state);
}

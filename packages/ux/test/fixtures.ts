/**
 * Shared deterministic fixtures for the @payswap/ux test suite (W3-006).
 *
 * Every dependency is REAL and injected: the journeys run against a genuine
 * @payswap/api `createApiHandler` (the same surface programmatic clients
 * use), with a real @payswap/trust grant configuration and the real
 * @payswap/payment / @payswap/execution authority constructors. No ambient
 * time, no entropy, no mocks of authority (worker-runbook: never replace
 * unresolved behavior with mocks).
 */

import type { ApiHandler } from '@payswap/api';
import { ApprovalService, asApprovalSigningKey, createApiHandler, GrantAuthority, SessionManager, asSessionSigningKey } from '@payswap/api';
import type { ExecutionAttempt, PaymentMethodOffer } from '@payswap/execution';
import { asExecutionAttemptId } from '@payswap/execution';
import type { AcceptanceRequest, PaymentAcceptancePolicy, RecurringMandate } from '@payswap/payment';
import {
  asPaymentMethodId,
  asRailCapabilityRef,
  defineAcceptancePolicy,
  defineCredentialCapability,
  defineMandate,
  defineMaterialTerms,
  definePaymentMethod,
  defineSettlementDestination,
} from '@payswap/payment';
import type { PendingApproval } from '@payswap/interfaces';
import { CURRENT_API_VERSION } from '@payswap/interfaces';
import type { CommandEnvelope } from '@payswap/protocol';
import { currencyCode, DeterministicClock, fromMinorUnits, InMemoryIdempotencyRegistrar, createIdFactory, USD } from '@payswap/protocol';
import type { Mandate, PermissionGrant, Principal } from '@payswap/trust';
import { EpochLedger, issueGrant, principalRef } from '@payswap/trust';

import {
  createJourneySession,
  sequentialIdempotencyKeys,
  type JourneySession,
} from '../src/journeys.js';

/** 2026-09-30T00:00:00Z in epoch milliseconds — the architecture lock date. */
export const CLOCK_SEED_MS = 1_767_052_800_000n;
export const NOW_MS = 1_767_052_800_000;
export const FAR_FUTURE_MS = 4_102_444_800_000;

export const SESSION_KEY = asSessionSigningKey('ux-test-session-signing-key');
export const APPROVAL_KEY = asApprovalSigningKey('ux-test-approval-signing-key');

export const ALICE: Principal = { kind: 'user', id: 'alice', securityEpoch: 0n };

export interface UxHarness {
  readonly clock: DeterministicClock;
  readonly sessions: SessionManager;
  readonly approvals: ApprovalService;
  readonly grants: GrantAuthority;
  readonly handler: ApiHandler;
  readonly aliceSessionToken: string;
}

function trustMandateFixture(overrides: {
  readonly id: string;
  readonly grantee: string;
  readonly actions?: readonly string[];
  readonly perTransactionAmount?: { readonly currency: string; readonly minorUnits: string };
  readonly escalation?: 'require_approval' | 'deny';
  readonly approverRef?: string;
}): Mandate {
  return {
    id: overrides.id,
    version: 1,
    grantor: 'user:owner',
    grantee: overrides.grantee,
    actions: overrides.actions ?? ['payments.intent.create'],
    resources: [{ type: 'intent' }],
    ...(overrides.perTransactionAmount === undefined
      ? {}
      : { limits: { perTransactionAmount: overrides.perTransactionAmount } }),
    ...(overrides.escalation === undefined
      ? {}
      : {
          escalation:
            overrides.escalation === 'require_approval'
              ? {
                  onLimitExceeded: 'require_approval' as const,
                  ...(overrides.approverRef === undefined ? {} : { approverRef: overrides.approverRef }),
                }
              : { onLimitExceeded: 'deny' as const },
        }),
    expiresAt: FAR_FUTURE_MS,
    proofRequirements: [],
  };
}

/** A broad allow mandate covering every command type the journeys dispatch. */
function allowGrants(nowMs: number): readonly PermissionGrant[] {
  const mandate = trustMandateFixture({
    id: 'mand_ux_allow',
    grantee: principalRef(ALICE),
    actions: [
      'payments.intent.create',
      'payments.method.switch',
      'payments.refund.create',
      'payments.dispute.open',
      'payments.mandate.pause',
      'payments.mandate.cancel',
      'payments.mandate.create',
      'payments.off-network.record',
      'payments.remittance.allocate',
    ],
  });
  return [issueGrant(mandate, { grantId: 'grant_ux_allow_1', issuedAt: nowMs })];
}

function escalationGrants(nowMs: number): readonly PermissionGrant[] {
  const mandate = trustMandateFixture({
    id: 'mand_ux_escalate',
    grantee: principalRef(ALICE),
    perTransactionAmount: { currency: 'USD', minorUnits: '100000' },
    escalation: 'require_approval',
    approverRef: 'user:owner',
  });
  return [issueGrant(mandate, { grantId: 'grant_ux_escalate_1', issuedAt: nowMs })];
}

function denyGrants(nowMs: number): readonly PermissionGrant[] {
  const mandate = trustMandateFixture({
    id: 'mand_ux_deny',
    grantee: principalRef(ALICE),
    perTransactionAmount: { currency: 'USD', minorUnits: '100000' },
    escalation: 'deny',
  });
  return [issueGrant(mandate, { grantId: 'grant_ux_deny_1', issuedAt: nowMs })];
}

export function buildHarness(grants: readonly PermissionGrant[]): UxHarness {
  const clock = new DeterministicClock(CLOCK_SEED_MS);
  const ids = createIdFactory(clock);
  const epochLedger = new EpochLedger();
  const sessions = new SessionManager({ clock, tokenSigningKey: SESSION_KEY, epochLedger });
  sessions.registerTenant({ id: 'tenant_ux', name: 'UX Test Tenant' });
  sessions.registerIdentity({ tenantId: 'tenant_ux', principal: ALICE, displayName: 'Alice' });
  const approvals = new ApprovalService({ clock, signingKey: APPROVAL_KEY });
  const grantAuthority = new GrantAuthority({ clock, ids, grants, epochLedger, approvals });
  const idempotency = new InMemoryIdempotencyRegistrar();
  const handler = createApiHandler({ clock, ids, sessions, approvals, grants: grantAuthority, idempotency });
  const session = sessions.issueSession({
    tenantId: 'tenant_ux',
    principalRef: principalRef(ALICE),
    ttlMs: 3_600_000,
  });
  return { clock, sessions, approvals, grants: grantAuthority, handler, aliceSessionToken: session.token };
}

export function allowHarness(): UxHarness {
  return buildHarness(allowGrants(NOW_MS));
}

export function escalationHarness(): UxHarness {
  return buildHarness(escalationGrants(NOW_MS));
}

export function denyHarness(): UxHarness {
  return buildHarness(denyGrants(NOW_MS));
}

/** A journey session bound to a harness (the SAME api handler + trusted surface). */
export function uxSession(harness: UxHarness, keyPrefix = 'ux-journey'): JourneySession {
  return createJourneySession({
    api: harness.handler,
    approvals: harness.approvals,
    auth: { principal: principalRef(ALICE), scheme: 'SESSION' },
    sessionToken: harness.aliceSessionToken,
    apiVersion: CURRENT_API_VERSION,
    idempotencyKeys: sequentialIdempotencyKeys(keyPrefix),
  });
}

// ---------------------------------------------------------------------------
// Authority record fixtures (payment plane / execution plane)
// ---------------------------------------------------------------------------

export const MOBILE_MONEY_METHOD = definePaymentMethod({
  id: 'mobile_money',
  kind: 'MOBILE_MONEY',
  displayName: 'Mobile Money',
  currencies: [USD],
  credentialRequirements: [
    defineCredentialCapability({
      id: 'mobile_money_auth',
      kind: 'MOBILE_MONEY_AUTHORIZATION',
      required: true,
      scope: 'authorize recurring and one-off mobile money charges',
    }),
  ],
  railHint: 'cap.mobile_money.collect',
});

export const CARD_METHOD = definePaymentMethod({
  id: 'card',
  kind: 'CARD',
  displayName: 'Card',
  currencies: [USD],
  credentialRequirements: [
    defineCredentialCapability({
      id: 'card_token',
      kind: 'TOKEN',
      required: true,
      scope: 'card payment tokenization',
    }),
  ],
  railHint: 'cap.card.charge',
});

export const SETTLEMENT_DESTINATION = defineSettlementDestination({
  id: 'dest_merchant_bank',
  kind: 'BANK_ACCOUNT',
  currency: USD,
  externalRef: 'bank://merchant-acme/000123',
  provenance: { source: 'merchant-onboarding', reference: 'onboarding-form-42', recordedAt: CLOCK_SEED_MS },
});

export function makeAcceptancePolicy(overrides?: Partial<Parameters<typeof defineAcceptancePolicy>[0]>): PaymentAcceptancePolicy {
  const base = {
    id: 'acceptance_merchant_acme',
    merchantRef: 'merchant:acme',
    methods: ['MOBILE_MONEY', 'CARD'] as const,
    methodCatalog: [MOBILE_MONEY_METHOD, CARD_METHOD],
    currencies: [USD],
    recurring: { supported: true },
    partialPayments: { supported: false },
    refunds: { supported: true, cutoffMs: 86_400_000n },
    recourse: 'MERCHANT_DISPUTE_WINDOW' as const,
    customerEligibility: [],
    settlementDestination: SETTLEMENT_DESTINATION,
    timing: { maxCompletionMs: 3_600_000n },
    remittance: { requiredDocumentKinds: ['INVOICE'] },
    geography: ['US'],
  };
  return defineAcceptancePolicy(overrides === undefined ? base : { ...base, ...overrides });
}

export function acceptanceRequestFor(methodId: string): AcceptanceRequest {
  return {
    methodId: asPaymentMethodId(methodId),
    currency: currencyCode('USD'),
    country: 'US',
  };
}

export function makeOffer(
  overrides?: Partial<Omit<PaymentMethodOffer, 'methodId'>> & { readonly methodId?: string },
): PaymentMethodOffer {
  const base: PaymentMethodOffer = {
    offerId: `offer_${overrides?.methodId ?? 'mobile_money'}`,
    methodId: asPaymentMethodId(overrides?.methodId ?? 'mobile_money'),
    currency: USD,
    amount: fromMinorUnits(USD, 5000n),
    fees: fromMinorUnits(USD, 120n),
    executionMode: 'PASS_THROUGH_NATIVE',
    railPath: [asRailCapabilityRef('cap.mobile_money.collect')],
    basedOnInstanceId: 'inst_mm_1',
    basedOnObservationVersion: 7,
    settlementDestinationId: 'dest_merchant_bank',
    expiresAt: CLOCK_SEED_MS + 600_000n,
    requiredCustomerActions: [],
  };
  return Object.freeze({ ...base, ...overrides, methodId: asPaymentMethodId(overrides?.methodId ?? 'mobile_money') });
}

export function makeMandate(overrides?: Partial<Parameters<typeof defineMandate>[0]>): RecurringMandate {
  const base = {
    id: 'mandate_sub_1',
    payer: 'user:alice',
    payee: 'merchant:acme',
    method: 'mobile_money',
    schedule: { intervalMs: 2_592_000_000n, maxCharges: 12n },
    maxAmountPerCharge: { currency: 'USD', value: 5000n },
    scope: 'monthly subscription',
    validFrom: CLOCK_SEED_MS,
    expiresAt: CLOCK_SEED_MS + 31_536_000_000n,
  };
  return defineMandate(overrides === undefined ? base : { ...base, ...overrides });
}

export function makeTerms(overrides?: Partial<Parameters<typeof defineMaterialTerms>[0]>) {
  const base = {
    amount: fromMinorUnits(USD, 5000n),
    currency: 'USD',
    fees: fromMinorUnits(USD, 120n),
    completionMs: 3_600_000n,
    recourse: 'MERCHANT_DISPUTE_WINDOW',
    settlementDestinationId: 'dest_merchant_bank',
  };
  return defineMaterialTerms(overrides === undefined ? base : { ...base, ...overrides });
}

export function makeProviderEnvelope(overrides?: {
  readonly family?: 'customer_action_required' | 'async_processing' | 'refund';
  readonly state?: unknown;
}) {
  return Object.freeze({
    provider: { name: 'psp-one', version: '2.4.1' },
    object: { objectType: 'payment_intent', externalId: 'pi_ext_42' },
    revision: 'rev_9',
    state: overrides?.state ?? 'requires_action',
    classification: Object.freeze({
      family: overrides?.family ?? 'customer_action_required',
      lifecycleStep: '3ds_challenge',
      isTerminal: false,
      requiresCustomerAction: true,
    }),
    history: Object.freeze([]),
    actionRequired: Object.freeze({
      kind: '3ds_challenge',
      message: 'Complete 3DS authentication with your bank',
      deepLink: 'https://psp-one.example/3ds/pi_ext_42',
    }),
    privacy: Object.freeze({ dataClassification: 'PARTNER', constraints: [], shareableFields: [] }),
    timestamps: Object.freeze({ observedAt: '2026-09-30T00:00:00Z' }),
    provenance: Object.freeze({ source: 'PROVIDER_API' }),
  });
}

export function makeAttempt(
  state: ExecutionAttempt['state'],
  overrides?: Partial<Omit<ExecutionAttempt, 'attemptId'>> & { readonly attemptId?: string },
): ExecutionAttempt {
  const base: ExecutionAttempt = {
    attemptId: asExecutionAttemptId('att_1'),
    planId: 'plan_1',
    stepId: 'step_1',
    executionMode: 'PASS_THROUGH_NATIVE',
    capabilityInstanceId: 'inst_mm_1',
    capabilityId: 'cap.mobile_money.collect',
    retryPolicy: 'REQUIRES_RECONCILIATION',
    semantics: Object.freeze({
      cancellation: 'NOT_SUPPORTED',
      compensation: Object.freeze({
        compensable: false,
        cancellation: 'NOT_SUPPORTED',
        partialExecution: Object.freeze({ possible: false, granularity: 'ATOMIC', onPartial: 'DISCLOSED' }),
      }),
    }),
    state,
    idempotencyKey: 'ik_att_1',
    principal: Object.freeze({ principalType: 'user', principalId: 'alice' }),
    commandHash: 'cmdhash_1',
    createdAt: CLOCK_SEED_MS,
    updatedAt: CLOCK_SEED_MS,
    history: Object.freeze([]),
    evidence: Object.freeze([]),
  };
  const attemptId = asExecutionAttemptId(overrides?.attemptId ?? 'att_1');
  return Object.freeze({ ...base, ...overrides, attemptId });
}

export function pendingApprovalFixture(expiresAtMs: number): PendingApproval {
  return {
    requestHash: 'reqhash_fixture_1',
    status: 'PENDING',
    channel: 'IN_APP',
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

/** Reads the intent envelope out of a successful POST /v1/intents response. */
export function intentEnvelopeOf(
  response: Extract<Awaited<ReturnType<ApiHandler>>, { readonly kind: 'success' }>,
): CommandEnvelope<unknown> {
  const data = response.envelope.data as { intent: CommandEnvelope<unknown> };
  return data.intent;
}

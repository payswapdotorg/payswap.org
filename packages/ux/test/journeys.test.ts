import { describe, expect, it } from 'vitest';

import type { ApiResponse } from '@payswap/api';
import { applyMandateEvent, defineFallbackPolicy } from '@payswap/payment';
import { validateRequestEnvelope } from '@payswap/interfaces';
import { fromMinorUnits, USD } from '@payswap/protocol';

import {
  abandonJourney,
  adjustAllocations,
  advanceOffNetworkReconciliation,
  applyIntentSubmissionResponse,
  beginChooseOrDelegatePayment,
  beginMandateManagement,
  beginRecordOffNetworkPayment,
  beginReconcileDocuments,
  beginRefundOrDispute,
  beginSwitchOrFallback,
  buildJourneyRequest,
  chooseMethod,
  confirmDelegationApproval,
  confirmFallbackApproval,
  declineSwitch,
  delegatePayment,
  diffMaterialTerms,
  dispatchJourneyCommand,
  executeSwitch,
  grantAgentAuthority,
  journeyStateHasLiveActions,
  PAYMENT_JOURNEY_STATES,
  recordAllocationIntent,
  recordMandateEvent,
  recordOffNetworkIntent,
  recommendPaymentMethod,
  requestNewMandateAuthorization,
  requestNewTermsApproval,
  resubmitApprovedIntent,
  sequentialIdempotencyKeys,
  submitAllocation,
  submitAuthorizationIntent,
  submitDelegatedIntent,
  submitOffNetworkDetails,
  submitRefundDisputeRequest,
  withdrawRequest,
} from '../src/journeys.js';
import type { PaymentJourney } from '../src/journeys.js';
import { approvalArtifactRef, completeApprovalOnTrustedSurface } from '../src/trusted-approvals.js';
import {
  acceptanceRequestFor,
  allowHarness,
  denyHarness,
  escalationHarness,
  intentEnvelopeOf,
  makeAcceptancePolicy,
  makeAttempt,
  makeMandate,
  makeOffer,
  makeTerms,
  NOW_MS,
  uxSession,
} from './fixtures.js';

function expectSuccess(response: ApiResponse): Extract<ApiResponse, { readonly kind: 'success' }> {
  if (response.kind !== 'success') {
    throw new Error(`expected success, got error: ${JSON.stringify(response.body.error)}`);
  }
  return response;
}

// ---------------------------------------------------------------------------
// The same API path as programmatic clients
// ---------------------------------------------------------------------------

describe('journeys consume the @payswap/api surface (no parallel path)', () => {
  it('every journey mutation is a VALIDATED RequestEnvelope with a fresh idempotency key (INV-F05)', () => {
    const session = uxSession(allowHarness());
    const keys = sequentialIdempotencyKeys('probe');
    const sessionWithProbe = { ...session, idempotencyKeys: keys };
    const first = buildJourneyRequest(sessionWithProbe, {
      method: 'POST',
      path: '/v1/intents',
      body: { commandType: 'payments.intent.create' },
    });
    const second = buildJourneyRequest(sessionWithProbe, {
      method: 'POST',
      path: '/v1/intents',
      body: { commandType: 'payments.intent.create' },
    });
    expect(validateRequestEnvelope(first).ok).toBe(true);
    expect(validateRequestEnvelope(second).ok).toBe(true);
    expect(first.idempotencyKey).toBe('probe-1');
    expect(second.idempotencyKey).toBe('probe-2');
    // GETs never carry a key (only mutations do).
    expect(buildJourneyRequest(session, { method: 'GET', path: '/v1/health' }).idempotencyKey).toBeUndefined();
  });

  it('a journey dispatch reaches the REAL api handler: the submitted intent is retrievable through the api', async () => {
    const harness = allowHarness();
    const session = uxSession(harness);
    const journey = beginChooseOrDelegatePayment({
      payment: { amount: { currency: 'USD', minorUnits: '5000' }, correlationId: 'corr-ux-1' },
      offers: [makeOffer()],
      rejections: [],
    });
    const reviewing = chooseMethod(journey, 'mobile_money');
    const submitted = await submitAuthorizationIntent(session, reviewing);
    expect(submitted.response.status).toBe(200);
    const intentId = submitted.journey.submittedIntent?.intentId;
    expect(intentId).toBeDefined();

    // Round trip through the SAME surface: the journey's view action GETs
    // the intent back from the api handler.
    const viewAction = submitted.journey.actions.find((action) => action.actionId === 'view-submitted-intent');
    expect(viewAction?.apiCommand).toBeDefined();
    const fetched = await dispatchJourneyCommand(
      session,
      viewAction?.apiCommand ?? { method: 'GET', path: '/v1/health' },
    );
    const fetchedIntent = intentEnvelopeOf(expectSuccess(fetched));
    expect(fetchedIntent.id).toBe(intentId);
  });

  it('journey commands always pass the W3-001 REST contract before dispatch (fail closed)', () => {
    const session = uxSession(allowHarness());
    const request = buildJourneyRequest(session, { method: 'POST', path: '/v1/intents', body: {} });
    expect(validateRequestEnvelope(request).ok).toBe(true);
    // The builder cannot produce a keyless mutation: POST always draws a key.
    expect(typeof request.idempotencyKey).toBe('string');
    expect(request.auth.principal).toBe('user:alice');
    expect(request.apiVersion).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Recommended payment method — reasons derived from authority
// ---------------------------------------------------------------------------

describe('recommendPaymentMethod — reasons derived from authoritative acceptance/capability state', () => {
  const acceptance = makeAcceptancePolicy();

  it('recommends only accepted methods with typed, authority-derived reasons', () => {
    const lowFee = makeOffer();
    const highFee = makeOffer({
      methodId: 'card',
      offerId: 'offer_card',
      fees: fromMinorUnits(USD, 500n),
      railPath: [],
    });
    const recommendation = recommendPaymentMethod([lowFee, highFee], {
      acceptance,
      request: acceptanceRequestFor('mobile_money'),
    });
    expect(recommendation?.offer.methodId).toBe('mobile_money');
    const kinds = recommendation?.reasons.map((reason) => reason.kind);
    expect(kinds).toContain('ACCEPTED_BY_MERCHANT_POLICY');
    expect(kinds).toContain('CONNECTED_INSTANCE_AUTHORIZED');
    expect(kinds).toContain('OBSERVATION_BACKED');
    expect(kinds).toContain('LOWEST_FEES');
    expect(kinds).toContain('EXPLICIT_EXECUTION_MODE');
    expect(kinds).toContain('SETTLES_TO_ACCEPTED_DESTINATION');
  });

  it('a method REJECTED by the acceptance authority is never recommended (reasons follow authority)', () => {
    const acceptanceEu = makeAcceptancePolicy({ geography: ['DE'] });
    const recommendation = recommendPaymentMethod([makeOffer()], {
      acceptance: acceptanceEu,
      request: { ...acceptanceRequestFor('mobile_money'), country: 'US' },
    });
    expect(recommendation).toBeUndefined();
  });

  it('the recommendation follows a change in the authoritative fees (derivation, not cache)', () => {
    const cheapCard = makeOffer({ methodId: 'card', offerId: 'offer_card', fees: fromMinorUnits(USD, 10n) });
    const expensiveMobile = makeOffer({ fees: fromMinorUnits(USD, 999n) });
    const recommendation = recommendPaymentMethod([expensiveMobile, cheapCard], {
      acceptance,
      request: acceptanceRequestFor('card'),
    });
    expect(recommendation?.offer.methodId).toBe('card');
    expect(recommendation?.reasons.some((reason) => reason.kind === 'LOWEST_FEES')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Journey 1 — choose or delegate a payment (full real flows)
// ---------------------------------------------------------------------------

describe('choose-or-delegate-payment journey', () => {
  const payment = { amount: { currency: 'USD', minorUnits: '5000' }, correlationId: 'corr-ux-1' };
  const offers = [
    makeOffer(),
    makeOffer({ methodId: 'card', offerId: 'offer_card', fees: fromMinorUnits(USD, 500n) }),
  ];

  it('CHOOSING_METHOD lists every offered method, the delegation path and the why-not views', () => {
    const journey = beginChooseOrDelegatePayment({
      payment,
      offers,
      rejections: [{ methodId: 'wire', reason: 'CAPABILITY_UNAVAILABLE', message: 'no viable route' }],
      acceptance: makeAcceptancePolicy(),
      request: acceptanceRequestFor('mobile_money'),
    });
    expect(journey.stateName).toBe('CHOOSING_METHOD');
    expect(journey.actions.some((action) => action.actionId === 'choose-method:mobile_money')).toBe(true);
    expect(journey.actions.some((action) => action.actionId === 'choose-method:card')).toBe(true);
    expect(journey.actions.some((action) => action.actionId === 'delegate-payment')).toBe(true);
    expect(journey.actions.some((action) => action.actionId === 'view-why-not:wire')).toBe(true);
    expect(journey.actions.some((action) => action.actionId === 'view-recommendation-reasons')).toBe(true);
  });

  it('the allow flow reaches SUBMITTED through the real api (200 grant)', async () => {
    const session = uxSession(allowHarness());
    const journey = chooseMethod(beginChooseOrDelegatePayment({ payment, offers, rejections: [] }), 'mobile_money');
    expect(journey.stateName).toBe('REVIEWING_TERMS');
    const submitted = await submitAuthorizationIntent(session, journey);
    expect(submitted.response.status).toBe(200);
    expect(submitted.journey.stateName).toBe('SUBMITTED');
    expect(submitted.journey.terminal).toBe(true);
    expect(submitted.journey.submittedIntent?.grantRef).toMatch(/^grant:/);
  });

  it('the escalation flow reaches AWAITING_APPROVAL, then completes on the trusted surface with a SIGNED artifact', async () => {
    const harness = escalationHarness();
    const session = uxSession(harness);
    const largePayment = { amount: { currency: 'USD', minorUnits: '500000' }, correlationId: 'corr-ux-2' };
    const journey = chooseMethod(
      beginChooseOrDelegatePayment({ payment: largePayment, offers, rejections: [] }),
      'mobile_money',
    );
    const awaiting = await submitAuthorizationIntent(session, journey);
    expect(awaiting.response.status).toBe(202);
    expect(awaiting.journey.stateName).toBe('AWAITING_APPROVAL');
    const requestHash = awaiting.journey.approval?.requestHash;
    expect(requestHash).toBeDefined();

    // The approval completes ONLY through the trusted surface (INV-A03).
    const completion = await completeApprovalOnTrustedSurface(harness.approvals, {
      principal: 'user:owner',
      requestHash: requestHash ?? '',
      decision: 'APPROVED',
    });
    expect(completion.outcome).toBe('ARTIFACT_ISSUED');
    if (completion.outcome === 'ARTIFACT_ISSUED') {
      expect(completion.artifact.requestHash).toBe(requestHash);
      expect(completion.artifact.principal).toBe('user:owner');
      expect(completion.artifact.signature.length).toBeGreaterThan(0);
    }

    const resubmitted = await resubmitApprovedIntent(session, awaiting.journey, approvalArtifactRef(requestHash ?? ''));
    expect(resubmitted.response.status).toBe(200);
    expect(resubmitted.journey.stateName).toBe('SUBMITTED');
  });

  it('the deny flow folds into the honest AUTHORIZATION_ERROR state (still actionable)', async () => {
    const session = uxSession(denyHarness());
    const largePayment = { amount: { currency: 'USD', minorUnits: '500000' }, correlationId: 'corr-ux-3' };
    const journey = chooseMethod(
      beginChooseOrDelegatePayment({ payment: largePayment, offers, rejections: [] }),
      'mobile_money',
    );
    const denied = await submitAuthorizationIntent(session, journey);
    expect(denied.response.status).toBe(403);
    expect(denied.journey.stateName).toBe('AUTHORIZATION_ERROR');
    expect(denied.journey.error?.category).toBe('AUTHORIZATION');
    expect(denied.journey.actions.some((action) => action.available)).toBe(true);
  });

  it('the delegation flow: DELEGATED_TO_AGENT → real POST /v1/approvals → AWAITING_DELEGATION_APPROVAL → DELEGATION_READY → SUBMITTED', async () => {
    const harness = allowHarness();
    const session = uxSession(harness);
    const delegated = delegatePayment(
      beginChooseOrDelegatePayment({ payment, offers, rejections: [] }),
      'agent:helper',
    );
    expect(delegated.stateName).toBe('DELEGATED_TO_AGENT');
    expect(delegated.actions.some((action) => action.actionId === 'grant-agent-authority')).toBe(true);

    const granted = await grantAgentAuthority(session, delegated);
    expect(granted.response.status).toBe(202);
    expect(granted.journey.stateName).toBe('AWAITING_DELEGATION_APPROVAL');
    expect(granted.journey.approval?.requestHash).toBeDefined();

    // The delegator completes the delegation approval on the trusted surface
    // (minting the artifact for the delegation authority).
    const completion = await completeApprovalOnTrustedSurface(harness.approvals, {
      principal: 'user:alice',
      requestHash: granted.journey.approval?.requestHash ?? '',
      decision: 'APPROVED',
    });
    expect(completion.outcome).toBe('ARTIFACT_ISSUED');

    const ready = confirmDelegationApproval(granted.journey);
    expect(ready.stateName).toBe('DELEGATION_READY');
    const submitted = await submitDelegatedIntent(session, ready);
    expect(submitted.response.status).toBe(200);
    expect(submitted.journey.stateName).toBe('SUBMITTED');
  });

  it('abandon folds to the terminal ABANDONED state with remaining view actions', () => {
    const abandoned = abandonJourney(beginChooseOrDelegatePayment({ payment, offers, rejections: [] }));
    expect(abandoned.stateName).toBe('ABANDONED');
    expect(abandoned.terminal).toBe(true);
    expect(abandoned.actions.some((action) => action.available)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Journey 2 — switch/fallback with EXPLICIT term changes
// ---------------------------------------------------------------------------

describe('switch-or-fallback-payment journey', () => {
  const automaticPolicy = defineFallbackPolicy({
    mode: 'AUTOMATIC',
    permittedAlternateMethods: ['card'],
    maxExtraCostBasisPoints: 200n,
    maxDelayMs: 60_000n,
    recourseRequirements: ['chargeback_only'],
  });

  it('UNCHANGED terms + AUTOMATIC fallback → EVALUATING_SWITCH with the execute action', () => {
    const journey = beginSwitchOrFallback({
      currentOffer: makeOffer(),
      candidateOffer: makeOffer({ methodId: 'card', offerId: 'offer_card', fees: fromMinorUnits(USD, 120n) }),
      fallbackPolicy: automaticPolicy,
      authorizedTerms: makeTerms(),
      candidateTerms: makeTerms(),
      extraCostBasisPoints: 50n,
      extraDelayMs: 10_000n,
    });
    expect(journey.stateName).toBe('EVALUATING_SWITCH');
    expect(journey.termChanges).toEqual([]);
    expect(journey.actions.some((action) => action.actionId === 'execute-switch')).toBe(true);
  });

  it('CHANGED material terms → REAUTHORIZATION_REQUIRED with the explicit diff (never a silent switch)', () => {
    const journey = beginSwitchOrFallback({
      currentOffer: makeOffer(),
      candidateOffer: makeOffer({ methodId: 'card', offerId: 'offer_card', fees: fromMinorUnits(USD, 500n) }),
      fallbackPolicy: automaticPolicy,
      authorizedTerms: makeTerms(),
      candidateTerms: makeTerms({ fees: fromMinorUnits(USD, 500n), completionMs: 7_200_000n }),
      extraCostBasisPoints: 50n,
      extraDelayMs: 10_000n,
    });
    expect(journey.stateName).toBe('REAUTHORIZATION_REQUIRED');
    const changedFields = journey.termChanges.map((change) => change.field);
    expect(changedFields).toContain('fees');
    expect(changedFields).toContain('completionMs');
    const feesChange = journey.termChanges.find((change) => change.field === 'fees');
    expect(feesChange?.from).toContain('120');
    expect(feesChange?.to).toContain('500');
    // The switch cannot be executed from this state: only re-authorization or decline.
    expect(journey.actions.some((action) => action.actionId === 'execute-switch')).toBe(false);
    expect(journey.actions.some((action) => action.actionId === 'approve-new-terms')).toBe(true);
  });

  it('APPROVAL_REQUIRED fallback policy → AWAITING_FALLBACK_APPROVAL', () => {
    const approvalPolicy = defineFallbackPolicy({
      mode: 'APPROVAL_REQUIRED',
      permittedAlternateMethods: ['card'],
      maxExtraCostBasisPoints: 0n,
      maxDelayMs: 0n,
      recourseRequirements: [],
    });
    const journey = beginSwitchOrFallback({
      currentOffer: makeOffer(),
      candidateOffer: makeOffer({ methodId: 'card', offerId: 'offer_card', fees: fromMinorUnits(USD, 120n) }),
      fallbackPolicy: approvalPolicy,
      authorizedTerms: makeTerms(),
      candidateTerms: makeTerms(),
      extraCostBasisPoints: 0n,
      extraDelayMs: 0n,
    });
    expect(journey.stateName).toBe('AWAITING_FALLBACK_APPROVAL');
    expect(journey.fallbackEvaluation.automatic).toBe(false);
    expect(journey.actions.some((action) => action.actionId === 'decline-switch')).toBe(true);
  });

  it('the re-authorization request dispatches through the real api and returns to a switchable state', async () => {
    const harness = allowHarness();
    const session = uxSession(harness);
    const journey = beginSwitchOrFallback({
      currentOffer: makeOffer(),
      candidateOffer: makeOffer({ methodId: 'card', offerId: 'offer_card', fees: fromMinorUnits(USD, 500n) }),
      fallbackPolicy: automaticPolicy,
      authorizedTerms: makeTerms(),
      candidateTerms: makeTerms({ fees: fromMinorUnits(USD, 500n) }),
      extraCostBasisPoints: 50n,
      extraDelayMs: 10_000n,
    });
    const requested = await requestNewTermsApproval(session, journey);
    expect(requested.response.status).toBe(202);
    expect(requested.journey.stateName).toBe('AWAITING_FALLBACK_APPROVAL');

    const switchable = confirmFallbackApproval(requested.journey);
    expect(switchable.stateName).toBe('EVALUATING_SWITCH');

    const switched = await executeSwitch(session, switchable);
    expect(switched.response.status).toBe(200);
    expect(switched.journey.stateName).toBe('SWITCHED');
    expect(switched.journey.terminal).toBe(true);
  });

  it('decline folds to SWITCH_DECLINED (terminal, still viewable)', () => {
    const journey = beginSwitchOrFallback({
      currentOffer: makeOffer(),
      candidateOffer: makeOffer({ methodId: 'card', offerId: 'offer_card', fees: fromMinorUnits(USD, 120n) }),
      fallbackPolicy: automaticPolicy,
      authorizedTerms: makeTerms(),
      candidateTerms: makeTerms(),
      extraCostBasisPoints: 0n,
      extraDelayMs: 0n,
    });
    const declined = declineSwitch(journey);
    expect(declined.stateName).toBe('SWITCH_DECLINED');
    expect(declined.actions.some((action) => action.available)).toBe(true);
  });

  it('diffMaterialTerms is exact field-by-field (amount, currency, fees, timing, recourse, destination)', () => {
    const changes = diffMaterialTerms(makeTerms(), makeTerms({ recourse: 'CHARGEBACK_ONLY' }));
    expect(changes).toEqual([{ field: 'recourse', from: 'MERCHANT_DISPUTE_WINDOW', to: 'CHARGEBACK_ONLY' }]);
  });
});

// ---------------------------------------------------------------------------
// Journey 3 — recurring mandate management
// ---------------------------------------------------------------------------

describe('manage-recurring-mandate journey', () => {
  it('VIEWING_MANDATE offers exactly the authority-legal events', () => {
    const journey = beginMandateManagement({ mandate: makeMandate(), nowMs: NOW_MS });
    expect(journey.stateName).toBe('VIEWING_MANDATE');
    const events = journey.actions
      .filter((action) => action.kind === 'AUTHORITY_TRANSITION')
      .map((action) => action.authorityEvent?.event);
    expect(events).toContain('ACTIVATE');
    expect(events).not.toContain('PAUSE');
  });

  it('recordMandateEvent dispatches a REAL api intent and folds the authority machine (PAUSE on ACTIVE)', async () => {
    const harness = allowHarness();
    const session = uxSession(harness);
    const active = applyMandateEvent(makeMandate(), 'ACTIVATE', BigInt(NOW_MS));
    const journey = beginMandateManagement({ mandate: active, nowMs: NOW_MS });
    expect(journey.actions.some((action) => action.actionId === 'mandate-pause')).toBe(true);

    const paused = await recordMandateEvent(session, journey, 'PAUSE', NOW_MS);
    expect(paused.response.status).toBe(200);
    expect(paused.journey.stateName).toBe('MANDATE_EVENT_RECORDED');
    expect(paused.journey.mandate.state).toBe('PAUSED');
  });

  it('an illegal mandate event is not offered (no view-side transitions)', () => {
    const journey = beginMandateManagement({ mandate: makeMandate(), nowMs: NOW_MS });
    expect(journey.actions.some((action) => action.actionId === 'mandate-pause')).toBe(false);
    expect(journey.actions.some((action) => action.actionId === 'mandate-resume')).toBe(false);
  });

  it('a terminal mandate offers NEW-mandate authorization through the real api (never a renewal transition)', async () => {
    const harness = allowHarness();
    const session = uxSession(harness);
    let mandate = applyMandateEvent(makeMandate(), 'ACTIVATE', BigInt(NOW_MS));
    mandate = applyMandateEvent(mandate, 'CANCEL', BigInt(NOW_MS));
    const journey = beginMandateManagement({ mandate, nowMs: NOW_MS });
    expect(journey.mandate.state).toBe('CANCELLED');
    expect(journey.actions.some((action) => action.actionId === 'request-new-mandate-authorization')).toBe(true);

    const requested = await requestNewMandateAuthorization(session, journey, NOW_MS);
    expect(requested.response.status).toBe(202);
    expect(requested.journey.stateName).toBe('AWAITING_NEW_MANDATE_APPROVAL');
    expect(requested.journey.approval?.requestHash).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Journey 4 — invoice/order/project reconciliation
// ---------------------------------------------------------------------------

describe('reconcile-invoice-order-project journey', () => {
  const documents = [
    { documentKind: 'INVOICE' as const, documentId: 'INV-77', allocatedAmount: fromMinorUnits(USD, 3000n) },
    { documentKind: 'ORDER' as const, documentId: 'ORD-12', allocatedAmount: fromMinorUnits(USD, 2000n) },
  ];

  it('ALLOCATING → submitAllocation → ALLOCATED when allocations sum EXACTLY', () => {
    const journey = beginReconcileDocuments({
      allocationId: 'remittance_ux_1',
      paymentRef: 'payment_1',
      methodId: 'mobile_money',
      paymentAmount: fromMinorUnits(USD, 5000n),
      documents,
    });
    expect(journey.stateName).toBe('ALLOCATING');
    const allocated = submitAllocation(journey);
    expect(allocated.stateName).toBe('ALLOCATED');
    expect(allocated.terminal).toBe(true);
    expect(allocated.allocation?.allocations).toHaveLength(2);
  });

  it('an over-allocation folds to ALLOCATION_MISMATCH with the exact discrepancy (never a silent pad)', () => {
    const journey = beginReconcileDocuments({
      allocationId: 'remittance_ux_2',
      paymentRef: 'payment_1',
      methodId: 'mobile_money',
      paymentAmount: fromMinorUnits(USD, 5000n),
      documents: [
        ...documents,
        { documentKind: 'CREDIT_REPAYMENT' as const, documentId: 'CR-1', allocatedAmount: fromMinorUnits(USD, 1000n) },
      ],
    });
    const mismatched = submitAllocation(journey);
    expect(mismatched.stateName).toBe('ALLOCATION_MISMATCH');
    expect(mismatched.mismatch?.expected).toBe(5000n);
    expect(mismatched.mismatch?.actual).toBe(6000n);
    expect(mismatched.mismatch?.reason).toContain('exactly');
    expect(mismatched.actions.some((action) => action.actionId === 'adjust-allocations')).toBe(true);
  });

  it('adjusting the drafts re-enters ALLOCATING; the recorded intent dispatches through the real api', async () => {
    const session = uxSession(allowHarness());
    const mismatched = submitAllocation(
      beginReconcileDocuments({
        allocationId: 'remittance_ux_3',
        paymentRef: 'payment_1',
        methodId: 'mobile_money',
        paymentAmount: fromMinorUnits(USD, 5000n),
        documents: [
          ...documents,
          { documentKind: 'CREDIT_REPAYMENT' as const, documentId: 'CR-1', allocatedAmount: fromMinorUnits(USD, 1000n) },
        ],
      }),
    );
    const retry = adjustAllocations(mismatched, documents);
    expect(retry.stateName).toBe('ALLOCATING');
    const allocated = submitAllocation(retry);
    expect(allocated.stateName).toBe('ALLOCATED');
    const response = await recordAllocationIntent(session, allocated);
    expect(response.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Journey 5 — refund / dispute initiation
// ---------------------------------------------------------------------------

describe('initiate-refund-or-dispute journey', () => {
  it('an eligible refund reaches CONFIRMING with the submit action', () => {
    const journey = beginRefundOrDispute({
      kind: 'REFUND',
      paymentRef: 'payment_1',
      acceptance: makeAcceptancePolicy(),
      attempt: makeAttempt('SUCCEEDED'),
      nowMs: NOW_MS,
    });
    expect(journey.stateName).toBe('CONFIRMING');
    expect(journey.eligibility.eligible).toBe(true);
    expect(journey.actions.some((action) => action.actionId === 'submit-refund-request')).toBe(true);
  });

  it('refunds not supported by the merchant authority → BLOCKED_BY_POLICY (honest, with actions)', () => {
    const journey = beginRefundOrDispute({
      kind: 'REFUND',
      paymentRef: 'payment_1',
      acceptance: makeAcceptancePolicy({ refunds: { supported: false } }),
      attempt: makeAttempt('SUCCEEDED'),
      nowMs: NOW_MS,
    });
    expect(journey.stateName).toBe('BLOCKED_BY_POLICY');
    expect(journey.eligibility.reasons).toContain('REFUNDS_NOT_SUPPORTED');
    expect(journey.actions.some((action) => action.available)).toBe(true);
  });

  it('a non-fulfilled payment cannot be refunded (PAYMENT_NOT_FULFILLED)', () => {
    const journey = beginRefundOrDispute({
      kind: 'REFUND',
      paymentRef: 'payment_1',
      acceptance: makeAcceptancePolicy(),
      attempt: makeAttempt('OUTCOME_UNKNOWN'),
      nowMs: NOW_MS,
    });
    expect(journey.stateName).toBe('BLOCKED_BY_POLICY');
    expect(journey.eligibility.reasons).toContain('PAYMENT_NOT_FULFILLED');
  });

  it('without the authoritative attempt the journey is ELIGIBILITY_UNKNOWN (never an assumed outcome)', () => {
    const journey = beginRefundOrDispute({
      kind: 'DISPUTE',
      paymentRef: 'payment_1',
      acceptance: makeAcceptancePolicy(),
      nowMs: NOW_MS,
    });
    expect(journey.stateName).toBe('ELIGIBILITY_UNKNOWN');
    expect(journey.eligibility.reasons).toContain('PAYMENT_STATE_NOT_ESTABLISHABLE');
  });

  it('a dispute with no recourse policy is BLOCKED_BY_POLICY (NO_RECOURSE_POLICY)', () => {
    const journey = beginRefundOrDispute({
      kind: 'DISPUTE',
      paymentRef: 'payment_1',
      acceptance: makeAcceptancePolicy({ recourse: 'NONE' }),
      attempt: makeAttempt('SUCCEEDED'),
      nowMs: NOW_MS,
    });
    expect(journey.stateName).toBe('BLOCKED_BY_POLICY');
    expect(journey.eligibility.reasons).toContain('NO_RECOURSE_POLICY');
  });

  it('the refund request dispatches through the real api and reaches REQUEST_SUBMITTED', async () => {
    const session = uxSession(allowHarness());
    const journey = beginRefundOrDispute({
      kind: 'REFUND',
      paymentRef: 'payment_1',
      amount: { currency: 'USD', minorUnits: '5000' },
      acceptance: makeAcceptancePolicy(),
      attempt: makeAttempt('SUCCEEDED'),
      nowMs: NOW_MS,
    });
    const submitted = await submitRefundDisputeRequest(session, journey);
    expect(submitted.response.status).toBe(200);
    expect(submitted.journey.stateName).toBe('REQUEST_SUBMITTED');
    expect(submitted.journey.terminal).toBe(true);
  });

  it('a denied request folds to REQUEST_DENIED (honest, still actionable)', async () => {
    const session = uxSession(denyHarness());
    const journey = beginRefundOrDispute({
      kind: 'REFUND',
      paymentRef: 'payment_1',
      amount: { currency: 'USD', minorUnits: '500000' },
      acceptance: makeAcceptancePolicy(),
      attempt: makeAttempt('SUCCEEDED'),
      nowMs: NOW_MS,
    });
    const denied = await submitRefundDisputeRequest(session, journey);
    expect(denied.response.status).toBe(403);
    expect(denied.journey.stateName).toBe('REQUEST_DENIED');
    expect(denied.journey.actions.some((action) => action.available)).toBe(true);
  });

  it('withdraw folds to REQUEST_WITHDRAWN', () => {
    const journey = beginRefundOrDispute({
      kind: 'REFUND',
      paymentRef: 'payment_1',
      acceptance: makeAcceptancePolicy(),
      attempt: makeAttempt('SUCCEEDED'),
      nowMs: NOW_MS,
    });
    expect(withdrawRequest(journey).stateName).toBe('REQUEST_WITHDRAWN');
  });
});

// ---------------------------------------------------------------------------
// Journey 6 — off-network payment recording
// ---------------------------------------------------------------------------

describe('record-off-network-payment journey', () => {
  it('records through the authority constructor, ingests with attributedToPaySwap: false, and dispatches the real api intent', async () => {
    const harness = allowHarness();
    const session = uxSession(harness);
    const journey = beginRecordOffNetworkPayment();
    expect(journey.stateName).toBe('ENTERING_DETAILS');

    const recorded = submitOffNetworkDetails(journey, {
      id: 'offnet_ux_1',
      source: 'CHECK',
      reporter: 'user:alice',
      amount: fromMinorUnits(USD, 25000n),
      externalRef: 'check-1042',
      evidence: [{ kind: 'check-image', reference: 'store/checks/1042.png', recordedAt: BigInt(NOW_MS) }],
      businessDocumentRefs: [{ documentKind: 'INVOICE', documentId: 'INV-77' }],
      recordedAt: BigInt(NOW_MS),
    });
    expect(recorded.stateName).toBe('RECORDED');
    expect(recorded.record?.orchestratedBy).toBe('EXTERNAL_PARTY');
    expect(recorded.attributedToPaySwap).toBe(false);

    const response = await recordOffNetworkIntent(session, recorded);
    expect(response.status).toBe(200);
  });

  it('reconciliation walks the authority machine: RECONCILING → RECONCILED (terminal)', () => {
    const journey = submitOffNetworkDetails(beginRecordOffNetworkPayment(), {
      id: 'offnet_ux_2',
      source: 'CASH',
      reporter: 'user:alice',
      amount: fromMinorUnits(USD, 1000n),
      externalRef: 'cash-receipt-9',
      evidence: [],
      businessDocumentRefs: [],
      recordedAt: BigInt(NOW_MS),
    });
    const reconciling = advanceOffNetworkReconciliation(journey, 'RECONCILING');
    expect(reconciling.stateName).toBe('RECONCILING');
    const reconciled = advanceOffNetworkReconciliation(reconciling, 'RECONCILED');
    expect(reconciled.stateName).toBe('RECONCILED');
    expect(reconciled.terminal).toBe(true);
  });

  it('a discrepancy is honest and actionable (DISCREPANT → re-reconcile)', () => {
    const journey = submitOffNetworkDetails(beginRecordOffNetworkPayment(), {
      id: 'offnet_ux_3',
      source: 'EXTERNAL_BANK_TRANSFER',
      reporter: 'user:alice',
      amount: fromMinorUnits(USD, 1000n),
      externalRef: 'wire-77',
      evidence: [],
      businessDocumentRefs: [],
      recordedAt: BigInt(NOW_MS),
    });
    const discrepant = advanceOffNetworkReconciliation(journey, 'RECONCILING');
    const flagged = advanceOffNetworkReconciliation(discrepant, 'DISCREPANT');
    expect(flagged.stateName).toBe('DISCREPANT');
    expect(flagged.actions.some((action) => action.actionId === 'investigate-discrepancy')).toBe(true);
    const back = advanceOffNetworkReconciliation(flagged, 'RECONCILING');
    expect(back.stateName).toBe('RECONCILING');
  });
});

// ---------------------------------------------------------------------------
// NO DEAD BUTTONS — the full state table cross-check
// ---------------------------------------------------------------------------

describe('no dead buttons — every journey state declares live actions', () => {
  const visited = new Map<string, Set<string>>();

  function visit(journey: PaymentJourney): PaymentJourney {
    const set = visited.get(journey.journeyId) ?? new Set<string>();
    set.add(journey.stateName);
    visited.set(journey.journeyId, set);
    // Non-terminal states MUST have live actions; terminal states keep at
    // least one live view action too (history/evidence).
    expect(
      journeyStateHasLiveActions(journey),
      `${journey.journeyId}/${journey.stateName} has no available action (dead button)`,
    ).toBe(true);
    return journey;
  }

  it('the declared state table covers exactly the states the journeys can be driven through', async () => {
    // --- choose-or-delegate
    const offers = [makeOffer(), makeOffer({ methodId: 'card', offerId: 'offer_card' })];
    const payment = { amount: { currency: 'USD', minorUnits: '5000' }, correlationId: 'corr-nodb' };
    const largePayment = { amount: { currency: 'USD', minorUnits: '500000' }, correlationId: 'corr-nodb-2' };
    visit(beginChooseOrDelegatePayment({ payment, offers, rejections: [] }));
    visit(chooseMethod(beginChooseOrDelegatePayment({ payment, offers, rejections: [] }), 'mobile_money'));
    visit(delegatePayment(beginChooseOrDelegatePayment({ payment, offers, rejections: [] }), 'agent:helper'));
    visit(abandonJourney(beginChooseOrDelegatePayment({ payment, offers, rejections: [] })));

    const escalationSession = uxSession(escalationHarness(), 'nodb-esc');
    const awaiting = await submitAuthorizationIntent(
      escalationSession,
      chooseMethod(beginChooseOrDelegatePayment({ payment: largePayment, offers, rejections: [] }), 'mobile_money'),
    );
    visit(awaiting.journey);
    const deniedSession = uxSession(denyHarness(), 'nodb-deny');
    const denied = await submitAuthorizationIntent(
      deniedSession,
      chooseMethod(beginChooseOrDelegatePayment({ payment: largePayment, offers, rejections: [] }), 'mobile_money'),
    );
    visit(denied.journey);
    const delegated = await grantAgentAuthority(
      escalationSession,
      delegatePayment(beginChooseOrDelegatePayment({ payment: largePayment, offers, rejections: [] }), 'agent:helper'),
    );
    visit(delegated.journey);
    visit(confirmDelegationApproval(delegated.journey));
    const allowedSession = uxSession(allowHarness(), 'nodb-allow');
    visit(
      (
        await submitAuthorizationIntent(
          allowedSession,
          chooseMethod(beginChooseOrDelegatePayment({ payment, offers, rejections: [] }), 'mobile_money'),
        )
      ).journey,
    );

    // --- switch-or-fallback
    const automaticPolicy = defineFallbackPolicy({
      mode: 'AUTOMATIC',
      permittedAlternateMethods: ['card'],
      maxExtraCostBasisPoints: 200n,
      maxDelayMs: 60_000n,
      recourseRequirements: ['chargeback_only'],
    });
    const approvalPolicy = defineFallbackPolicy({
      mode: 'APPROVAL_REQUIRED',
      permittedAlternateMethods: ['card'],
      maxExtraCostBasisPoints: 0n,
      maxDelayMs: 0n,
      recourseRequirements: [],
    });
    const switchable = beginSwitchOrFallback({
      currentOffer: makeOffer(),
      candidateOffer: makeOffer({ methodId: 'card', offerId: 'offer_card', fees: fromMinorUnits(USD, 120n) }),
      fallbackPolicy: automaticPolicy,
      authorizedTerms: makeTerms(),
      candidateTerms: makeTerms(),
      extraCostBasisPoints: 0n,
      extraDelayMs: 0n,
    });
    visit(switchable);
    const reauth = beginSwitchOrFallback({
      currentOffer: makeOffer(),
      candidateOffer: makeOffer({ methodId: 'card', offerId: 'offer_card', fees: fromMinorUnits(USD, 500n) }),
      fallbackPolicy: automaticPolicy,
      authorizedTerms: makeTerms(),
      candidateTerms: makeTerms({ fees: fromMinorUnits(USD, 500n) }),
      extraCostBasisPoints: 0n,
      extraDelayMs: 0n,
    });
    visit(reauth);
    const newTermsRequested = await requestNewTermsApproval(allowedSession, reauth);
    visit(newTermsRequested.journey);
    visit(confirmFallbackApproval(newTermsRequested.journey));
    visit(
      beginSwitchOrFallback({
        currentOffer: makeOffer(),
        candidateOffer: makeOffer({ methodId: 'card', offerId: 'offer_card', fees: fromMinorUnits(USD, 120n) }),
        fallbackPolicy: approvalPolicy,
        authorizedTerms: makeTerms(),
        candidateTerms: makeTerms(),
        extraCostBasisPoints: 0n,
        extraDelayMs: 0n,
      }),
    );
    visit(declineSwitch(switchable));
    visit((await executeSwitch(allowedSession, switchable)).journey);

    // --- mandate
    visit(beginMandateManagement({ mandate: makeMandate(), nowMs: NOW_MS }));
    const activeMandate = applyMandateEvent(makeMandate(), 'ACTIVATE', BigInt(NOW_MS));
    visit(
      (
        await recordMandateEvent(
          allowedSession,
          beginMandateManagement({ mandate: activeMandate, nowMs: NOW_MS }),
          'PAUSE',
          NOW_MS,
        )
      ).journey,
    );
    const terminalMandate = applyMandateEvent(activeMandate, 'CANCEL', BigInt(NOW_MS));
    visit(
      (
        await requestNewMandateAuthorization(
          allowedSession,
          beginMandateManagement({ mandate: terminalMandate, nowMs: NOW_MS }),
          NOW_MS,
        )
      ).journey,
    );

    // --- reconcile
    const documents = [
      { documentKind: 'INVOICE' as const, documentId: 'INV-77', allocatedAmount: fromMinorUnits(USD, 3000n) },
      { documentKind: 'ORDER' as const, documentId: 'ORD-12', allocatedAmount: fromMinorUnits(USD, 2000n) },
    ];
    const allocating = beginReconcileDocuments({
      allocationId: 'remittance_nodb',
      paymentRef: 'payment_1',
      methodId: 'mobile_money',
      paymentAmount: fromMinorUnits(USD, 5000n),
      documents,
    });
    visit(allocating);
    visit(submitAllocation(allocating));
    visit(
      submitAllocation(
        beginReconcileDocuments({
          allocationId: 'remittance_nodb_2',
          paymentRef: 'payment_1',
          methodId: 'mobile_money',
          paymentAmount: fromMinorUnits(USD, 5000n),
          documents: [
            ...documents,
            { documentKind: 'CREDIT_REPAYMENT' as const, documentId: 'CR-1', allocatedAmount: fromMinorUnits(USD, 1000n) },
          ],
        }),
      ),
    );

    // --- refund/dispute
    const eligibleRefund = beginRefundOrDispute({
      kind: 'REFUND',
      paymentRef: 'payment_1',
      acceptance: makeAcceptancePolicy(),
      attempt: makeAttempt('SUCCEEDED'),
      nowMs: NOW_MS,
    });
    visit(eligibleRefund);
    visit(
      beginRefundOrDispute({
        kind: 'REFUND',
        paymentRef: 'payment_1',
        acceptance: makeAcceptancePolicy({ refunds: { supported: false } }),
        attempt: makeAttempt('SUCCEEDED'),
        nowMs: NOW_MS,
      }),
    );
    visit(beginRefundOrDispute({ kind: 'DISPUTE', paymentRef: 'payment_1', acceptance: makeAcceptancePolicy(), nowMs: NOW_MS }));
    visit(
      beginRefundOrDispute({
        kind: 'DISPUTE',
        paymentRef: 'payment_1',
        acceptance: makeAcceptancePolicy({ recourse: 'NONE' }),
        attempt: makeAttempt('SUCCEEDED'),
        nowMs: NOW_MS,
      }),
    );
    visit(withdrawRequest(eligibleRefund));
    visit((await submitRefundDisputeRequest(allowedSession, eligibleRefund)).journey);
    visit(
      (
        await submitRefundDisputeRequest(
          deniedSession,
          beginRefundOrDispute({
            kind: 'REFUND',
            paymentRef: 'payment_1',
            amount: { currency: 'USD', minorUnits: '500000' },
            acceptance: makeAcceptancePolicy(),
            attempt: makeAttempt('SUCCEEDED'),
            nowMs: NOW_MS,
          }),
        )
      ).journey,
    );

    // --- off-network
    const offNetwork = submitOffNetworkDetails(beginRecordOffNetworkPayment(), {
      id: 'offnet_nodb',
      source: 'CHECK',
      reporter: 'user:alice',
      amount: fromMinorUnits(USD, 25000n),
      externalRef: 'check-1042',
      evidence: [],
      businessDocumentRefs: [],
      recordedAt: BigInt(NOW_MS),
    });
    visit(beginRecordOffNetworkPayment());
    visit(offNetwork);
    const reconciling = advanceOffNetworkReconciliation(offNetwork, 'RECONCILING');
    visit(reconciling);
    visit(advanceOffNetworkReconciliation(reconciling, 'RECONCILED'));
    visit(advanceOffNetworkReconciliation(reconciling, 'DISCREPANT'));

    // Cross-check: driven states == declared table, per journey.
    for (const spec of PAYMENT_JOURNEY_STATES) {
      const driven = visited.get(spec.journeyId) ?? new Set<string>();
      const declared = spec.states.map((entry) => entry.stateName);
      for (const stateName of declared) {
        expect(driven.has(stateName), `${spec.journeyId}: declared state ${stateName} was never driven`).toBe(true);
      }
      for (const stateName of driven) {
        expect(declared, `${spec.journeyId}: driven state ${stateName} is not declared`).toContain(stateName);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The pure response fold (one more one-to-one authority proof)
// ---------------------------------------------------------------------------

describe('applyIntentSubmissionResponse — the fold is a pure function of the api response', () => {
  const journey = chooseMethod(
    beginChooseOrDelegatePayment({
      payment: { amount: { currency: 'USD', minorUnits: '5000' } },
      offers: [makeOffer()],
      rejections: [],
    }),
    'mobile_money',
  );

  it('a 200 grant response folds to SUBMITTED with the intent id', () => {
    const folded = applyIntentSubmissionResponse(journey, {
      kind: 'success',
      status: 200,
      envelope: {
        data: { intent: { id: 'cmd_1' }, grantRef: 'grant_1' },
        meta: { schemaVersion: '1', requestId: 'req_1' },
      },
    });
    expect(folded.stateName).toBe('SUBMITTED');
    expect(folded.submittedIntent).toEqual({ intentId: 'cmd_1', grantRef: 'grant_1' });
  });

  it('a 202 approval-required response folds to AWAITING_APPROVAL with the deep link', () => {
    const folded = applyIntentSubmissionResponse(journey, {
      kind: 'success',
      status: 202,
      envelope: {
        data: {
          approvalRequest: { requestHash: 'reqhash_x', expiresAt: '2026-10-01T00:00:00Z' },
          approvalMessage: { deepLink: 'https://app.payswap.example/approvals/reqhash_x' },
        },
        meta: { schemaVersion: '1', requestId: 'req_2' },
      },
    });
    expect(folded.stateName).toBe('AWAITING_APPROVAL');
    expect(folded.approval?.deepLink).toBe('https://app.payswap.example/approvals/reqhash_x');
  });

  it('an error response folds to the honest AUTHORIZATION_ERROR state (never invented success)', () => {
    const folded = applyIntentSubmissionResponse(journey, {
      kind: 'error',
      status: 403,
      body: {
        error: { code: 'auth.denied', category: 'AUTHORIZATION', message: 'mandate missing' },
        meta: { schemaVersion: '1', requestId: 'req_3' },
      },
    });
    expect(folded.stateName).toBe('AUTHORIZATION_ERROR');
    expect(folded.error?.category).toBe('AUTHORIZATION');
  });
});

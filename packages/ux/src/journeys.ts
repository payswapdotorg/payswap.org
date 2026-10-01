/**
 * @payswap/ux — payment command-center journeys (W3-006).
 *
 * W3-006 work order: each journey is a DETERMINISTIC state machine that
 * CONSUMES THE SAME API/PROTOCOL PATH AS PROGRAMMATIC CLIENTS. This module
 * encodes that rule structurally:
 *
 * - the ONLY protocol channel a journey owns is `JourneySession.api`, an
 *   `ApiHandler` produced by @payswap/api `createApiHandler` — the same
 *   handler every programmatic client calls. There is no parallel transport:
 *   src/ contains no network primitive (proven by the boundary test) and
 *   every mutation leaves the journey as a VALIDATED `RequestEnvelope`
 *   (`validateRequestEnvelope` from @payswap/interfaces — auth principal,
 *   pinned API version, idempotency key on every mutation, INV-F05);
 * - domain state folds CONSUME the authority packages' own state machines
 *   (@payswap/payment `applyMandateEvent` / `advanceReconciliation` /
 *   `allocateRemittance` / `evaluateFallback`, @payswap/execution
 *   `ingestOffNetworkPaymentRecord`) — the view never invents a transition
 *   the authority does not have;
 * - NO DEAD BUTTONS: every journey state declares its available actions;
 *   the journey state table (`PAYMENT_JOURNEY_STATES`) is cross-checked by
 *   test against driven journeys: no non-terminal state has zero available
 *   actions;
 * - switch/fallback surfaces EXPLICIT term changes: a fallback that changes
 *   material terms (amount, currency, fees, timing, recourse, settlement
 *   destination) enters `REAUTHORIZATION_REQUIRED` — never a silent switch
 *   (PAYMENT-OPERATING-PLANE "PaymentFallbackPolicy"; W1-003
 *   `assertTranslationAuthorized` semantics);
 * - recommended payment methods carry REASONS derived from authoritative
 *   acceptance/capability state (@payswap/payment `matchesAcceptance`,
 *   @payswap/execution offer records).
 *
 * Deterministic by construction: pure folds + an injected API port; no DOM, no
 * network, no ambient time (folds that need "now" take it as a parameter), no
 * randomness.
 */

import type { ApiResponse, ApiRequest, ApiHandler, ApprovalService } from '@payswap/api';
import type { ExecutionAttempt, PaymentMethodOffer } from '@payswap/execution';
import { ingestOffNetworkPaymentRecord } from '@payswap/execution';
import type {
  AcceptanceRequest,
  MaterialTerms,
  OffNetworkEvidenceRef,
  OffNetworkPaymentRecord,
  OffNetworkReconciliationState,
  PaymentAcceptancePolicy,
  PaymentFallbackPolicy,
  RecurringMandate,
  RemittanceAllocation,
  RemittanceDocumentKind,
} from '@payswap/payment';
import {
  advanceReconciliation,
  allocateRemittance,
  applyMandateEvent,
  evaluateFallback,
  matchesAcceptance,
  recordOffNetworkPayment,
} from '@payswap/payment';
import type { RequestAuth } from '@payswap/interfaces';
import { validateRequestEnvelope } from '@payswap/interfaces';

import type { ApiCommandSpec, ViewAction } from './command-center.js';
import { ViewContractError } from './command-center.js';

// ---------------------------------------------------------------------------
// The journey session — one API path, one trusted surface
// ---------------------------------------------------------------------------

/** Issues idempotency keys for journey mutations (INV-F05: one key, one result). */
export interface JourneyIdempotencyKeySource {
  next(): string;
}

/**
 * The session a journey runs in. `api` is the @payswap/api handler — the SAME
 * surface programmatic clients use; `approvals` is the trusted approval
 * surface (@payswap/api ApprovalService) bound to that handler, because an
 * approval may only complete through a trusted surface (INV-A03).
 */
export interface JourneySession {
  readonly api: ApiHandler;
  readonly approvals: ApprovalService;
  readonly auth: RequestAuth;
  readonly sessionToken: string;
  readonly apiVersion: string;
  readonly idempotencyKeys: JourneyIdempotencyKeySource;
}

/** Raised when a journey violates the UX contract (invalid command, illegal action). */
export class JourneyContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JourneyContractError';
  }
}

/** Deterministic key source for tests/composition roots that prefer sequence keys. */
export function sequentialIdempotencyKeys(prefix: string): JourneyIdempotencyKeySource {
  let counter = 0;
  return {
    next(): string {
      counter += 1;
      return `${prefix}-${counter}`;
    },
  };
}

/** Build a validated journey session (constructor validation, fail closed). */
export function createJourneySession(input: {
  readonly api: ApiHandler;
  readonly approvals: ApprovalService;
  readonly auth: RequestAuth;
  readonly sessionToken: string;
  readonly apiVersion: string;
  readonly idempotencyKeys: JourneyIdempotencyKeySource;
}): JourneySession {
  if (typeof input.auth?.principal !== 'string' || input.auth.principal === '') {
    throw new JourneyContractError('journey session requires an authenticated principal');
  }
  if (typeof input.sessionToken !== 'string' || input.sessionToken === '') {
    throw new JourneyContractError('journey session requires a session token (SESSION scheme)');
  }
  if (typeof input.apiVersion !== 'string' || input.apiVersion === '') {
    throw new JourneyContractError('journey session requires a pinned API version');
  }
  if (typeof input.idempotencyKeys?.next !== 'function') {
    throw new JourneyContractError('journey session requires an idempotency key source');
  }
  return Object.freeze({ ...input });
}

/**
 * Build the journey's API request from a command spec. POST mutations ALWAYS
 * draw a fresh idempotency key — the REST contract validated below rejects
 * keyless mutations (INV-F05).
 */
export function buildJourneyRequest(session: JourneySession, spec: ApiCommandSpec): ApiRequest {
  if (spec.method !== 'GET' && spec.method !== 'POST') {
    throw new JourneyContractError(`journey commands only use GET/POST; got ${spec.method}`);
  }
  return {
    method: spec.method,
    path: spec.path,
    auth: session.auth,
    apiVersion: session.apiVersion,
    ...(spec.method === 'POST' ? { idempotencyKey: session.idempotencyKeys.next() } : {}),
    ...(spec.body === undefined ? {} : { body: spec.body }),
    sessionToken: session.sessionToken,
  };
}

/**
 * Dispatch one journey command through the API surface. The request is
 * validated against the W3-001 REST contract BEFORE dispatch — a journey can
 * never emit an unauthenticated, unversioned or keyless mutation.
 */
export async function dispatchJourneyCommand(
  session: JourneySession,
  spec: ApiCommandSpec,
): Promise<ApiResponse> {
  const request = buildJourneyRequest(session, spec);
  const validation = validateRequestEnvelope(request);
  if (!validation.ok) {
    throw new JourneyContractError(
      `journey command violates the REST contract: ${validation.violations.join('; ')}`,
    );
  }
  return session.api(request);
}

// ---------------------------------------------------------------------------
// Response parsing (the authoritative result shapes of the api surface)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface IntentGrantedResult {
  readonly kind: 'GRANTED';
  readonly intentId: string;
  readonly grantRef?: string;
}

export interface ApprovalRequiredResult {
  readonly kind: 'APPROVAL_REQUIRED';
  readonly requestHash: string;
  readonly expiresAt: string;
  readonly deepLink?: string;
}

export interface JourneyErrorResult {
  readonly kind: 'ERROR';
  readonly category: string;
  readonly code: string;
  readonly message: string;
  readonly reconciliationRef?: string;
}

export type IntentSubmissionOutcome =
  | IntentGrantedResult
  | ApprovalRequiredResult
  | JourneyErrorResult;

/** Parse an intent submission response into its authoritative outcome. */
export function parseIntentSubmissionResponse(response: ApiResponse): IntentSubmissionOutcome {
  if (response.kind === 'error') {
    const error = response.body.error;
    return {
      kind: 'ERROR',
      category: error.category,
      code: error.code,
      message: error.message,
      ...(error.reconciliationRef === undefined ? {} : { reconciliationRef: error.reconciliationRef }),
    };
  }
  const data = response.envelope.data;
  if (!isRecord(data)) {
    throw new JourneyContractError('success envelope carried no data object');
  }
  const approvalRequest = data['approvalRequest'];
  if (response.status === 202 && isRecord(approvalRequest)) {
    const requestHash = approvalRequest['requestHash'];
    const expiresAt = approvalRequest['expiresAt'];
    if (typeof requestHash !== 'string' || typeof expiresAt !== 'string') {
      throw new JourneyContractError('approval request payload is malformed');
    }
    const approvalMessage = data['approvalMessage'];
    const deepLink = isRecord(approvalMessage) ? approvalMessage['deepLink'] : undefined;
    return {
      kind: 'APPROVAL_REQUIRED',
      requestHash,
      expiresAt,
      ...(typeof deepLink === 'string' ? { deepLink } : {}),
    };
  }
  const intent = data['intent'];
  if (!isRecord(intent)) {
    throw new JourneyContractError('intent payload is malformed');
  }
  const intentId = intent['id'];
  if (typeof intentId !== 'string') {
    throw new JourneyContractError('intent payload carried no id');
  }
  const grantRef = data['grantRef'];
  return {
    kind: 'GRANTED',
    intentId,
    ...(typeof grantRef === 'string' ? { grantRef } : {}),
  };
}

// ---------------------------------------------------------------------------
// Recommended payment method — reasons derived from authority
// ---------------------------------------------------------------------------

export type RecommendationReason =
  | { readonly kind: 'ACCEPTED_BY_MERCHANT_POLICY'; readonly policyId: string }
  | { readonly kind: 'CONNECTED_INSTANCE_AUTHORIZED'; readonly instanceId: string }
  | { readonly kind: 'OBSERVATION_BACKED'; readonly observationVersion: number }
  | { readonly kind: 'LOWEST_FEES'; readonly fees: { readonly currency: string; readonly value: bigint } }
  | { readonly kind: 'SHORTEST_RAIL_PATH'; readonly railPathLength: number }
  | { readonly kind: 'EXPLICIT_EXECUTION_MODE'; readonly executionMode: PaymentMethodOffer['executionMode'] }
  | { readonly kind: 'SETTLES_TO_ACCEPTED_DESTINATION'; readonly settlementDestinationId: string }
  | { readonly kind: 'NO_CUSTOMER_ACTIONS_REQUIRED' }
  | {
      readonly kind: 'CUSTOMER_ACTIONS_REQUIRED';
      readonly actions: PaymentMethodOffer['requiredCustomerActions'];
    };

export interface RecommendedMethodView {
  readonly offer: PaymentMethodOffer;
  readonly reasons: readonly RecommendationReason[];
}

/**
 * Recommend a payment method with reasons DERIVED from authoritative
 * acceptance/capability state: only offers whose method is ACCEPTED by the
 * merchant's PaymentAcceptancePolicy (`matchesAcceptance`, @payswap/payment)
 * can be recommended. Ranking is deterministic: lowest exact fees, then
 * shortest rail path, then method id. When nothing is accepted, there is NO
 * recommendation (never a fabricated one).
 */
export function recommendPaymentMethod(
  offers: readonly PaymentMethodOffer[],
  authority: {
    readonly acceptance: PaymentAcceptancePolicy;
    readonly request: AcceptanceRequest;
  },
): RecommendedMethodView | undefined {
  const accepted = offers.filter((offer) =>
    matchesAcceptance(authority.acceptance, { ...authority.request, methodId: offer.methodId }).accepted,
  );
  if (accepted.length === 0) {
    return undefined;
  }
  const sorted = [...accepted].sort((left, right) => {
    if (left.fees.currency !== right.fees.currency) {
      return left.fees.currency < right.fees.currency ? -1 : 1;
    }
    if (left.fees.value !== right.fees.value) {
      return left.fees.value < right.fees.value ? -1 : 1;
    }
    if (left.railPath.length !== right.railPath.length) {
      return left.railPath.length - right.railPath.length;
    }
    return left.methodId < right.methodId ? -1 : left.methodId > right.methodId ? 1 : 0;
  });
  const best = sorted[0];
  if (best === undefined) {
    return undefined;
  }
  const reasons: RecommendationReason[] = [
    { kind: 'ACCEPTED_BY_MERCHANT_POLICY', policyId: authority.acceptance.id },
    { kind: 'CONNECTED_INSTANCE_AUTHORIZED', instanceId: best.basedOnInstanceId },
    { kind: 'OBSERVATION_BACKED', observationVersion: best.basedOnObservationVersion },
    { kind: 'EXPLICIT_EXECUTION_MODE', executionMode: best.executionMode },
    { kind: 'SETTLES_TO_ACCEPTED_DESTINATION', settlementDestinationId: best.settlementDestinationId },
  ];
  const lowestFee = sorted.every(
    (offer) => offer.fees.currency !== best.fees.currency || offer.fees.value >= best.fees.value,
  );
  if (lowestFee) {
    reasons.push({ kind: 'LOWEST_FEES', fees: { currency: best.fees.currency, value: best.fees.value } });
  }
  const shortestPath = sorted.every((offer) => offer.railPath.length >= best.railPath.length);
  if (shortestPath) {
    reasons.push({ kind: 'SHORTEST_RAIL_PATH', railPathLength: best.railPath.length });
  }
  if (best.requiredCustomerActions.length === 0) {
    reasons.push({ kind: 'NO_CUSTOMER_ACTIONS_REQUIRED' });
  } else {
    reasons.push({
      kind: 'CUSTOMER_ACTIONS_REQUIRED',
      actions: Object.freeze([...best.requiredCustomerActions]),
    });
  }
  return { offer: best, reasons: Object.freeze(reasons) };
}

// ---------------------------------------------------------------------------
// Journey 1 — choose or delegate a payment
// ---------------------------------------------------------------------------

export type ChooseOrDelegateStateName =
  | 'CHOOSING_METHOD'
  | 'REVIEWING_TERMS'
  | 'AWAITING_APPROVAL'
  | 'DELEGATED_TO_AGENT'
  | 'AWAITING_DELEGATION_APPROVAL'
  | 'DELEGATION_READY'
  | 'SUBMITTED'
  | 'AUTHORIZATION_ERROR'
  | 'ABANDONED';

export interface PaymentRequestSummary {
  /** Exact amount, string minor units (INV-F01). */
  readonly amount: { readonly currency: string; readonly minorUnits: string };
  readonly correlationId?: string;
  readonly description?: string;
}

export interface RejectedMethodView {
  readonly methodId: string;
  readonly reason: string;
  readonly message: string;
}

export interface ChooseOrDelegateJourney {
  readonly journeyId: 'choose-or-delegate-payment';
  readonly stateName: ChooseOrDelegateStateName;
  readonly terminal: boolean;
  readonly payment: PaymentRequestSummary;
  readonly offers: readonly PaymentMethodOffer[];
  readonly rejections: readonly RejectedMethodView[];
  readonly recommendation?: RecommendedMethodView;
  readonly chosenOffer?: PaymentMethodOffer;
  readonly approval?: {
    readonly requestHash: string;
    readonly expiresAt: string;
    readonly deepLink?: string;
  };
  readonly agentRef?: string;
  readonly submittedIntent?: { readonly intentId: string; readonly grantRef?: string };
  readonly error?: JourneyErrorResult;
  readonly actions: readonly ViewAction[];
}

function chooseJourneyActions(
  stateName: ChooseOrDelegateStateName,
  journey: Omit<ChooseOrDelegateJourney, 'actions'>,
): readonly ViewAction[] {
  const actions: ViewAction[] = [];
  const base = { authorityRef: journey.payment.correlationId ?? `payment:${journey.payment.amount.currency}` };
  switch (stateName) {
    case 'CHOOSING_METHOD':
      for (const offer of journey.offers) {
        actions.push({
          actionId: `choose-method:${offer.methodId}`,
          label: `Pay with ${offer.methodId}`,
          kind: 'NAVIGATION',
          authorityRef: offer.offerId,
          available: true,
        });
      }
      actions.push({
        actionId: 'delegate-payment',
        label: 'Delegate this payment to an agent',
        kind: 'NAVIGATION',
        ...base,
        available: true,
      });
      for (const rejection of journey.rejections) {
        actions.push({
          actionId: `view-why-not:${rejection.methodId}`,
          label: `Why ${rejection.methodId} is not offered`,
          kind: 'EVIDENCE_VIEW',
          authorityRef: `${rejection.methodId}:${rejection.reason}`,
          available: true,
        });
      }
      if (journey.recommendation !== undefined) {
        actions.push({
          actionId: 'view-recommendation-reasons',
          label: 'View why this method is recommended',
          kind: 'EVIDENCE_VIEW',
          authorityRef: journey.recommendation.offer.offerId,
          available: true,
        });
      }
      break;
    case 'REVIEWING_TERMS':
      if (journey.chosenOffer !== undefined) {
        actions.push({
          actionId: 'authorize-payment',
          label: 'Authorize this payment',
          kind: 'API_COMMAND',
          authorityRef: journey.chosenOffer.offerId,
          available: true,
          apiCommand: {
            method: 'POST',
            path: '/v1/intents',
            body: {
              commandType: 'payments.intent.create',
              amount: journey.payment.amount,
              ...(journey.payment.correlationId === undefined
                ? {}
                : { correlationId: journey.payment.correlationId }),
            },
          },
        });
        actions.push({
          actionId: 'inspect-rail-path-and-fees',
          label: 'Inspect rail path, fees and execution mode',
          kind: 'EVIDENCE_VIEW',
          authorityRef: journey.chosenOffer.offerId,
          available: true,
        });
      }
      actions.push({
        actionId: 'choose-different-method',
        label: 'Choose a different method',
        kind: 'NAVIGATION',
        ...base,
        available: journey.offers.length > 1,
        ...(journey.offers.length > 1
          ? {}
          : { unavailableReason: 'only one method is currently offerable for this payment' }),
      });
      actions.push({
        actionId: 'abandon-journey',
        label: 'Cancel this payment',
        kind: 'NAVIGATION',
        ...base,
        available: true,
      });
      break;
    case 'AWAITING_APPROVAL':
      if (journey.approval !== undefined) {
        actions.push({
          actionId: 'open-trusted-approval-surface',
          label: 'Complete approval on the trusted surface',
          kind: 'TRUSTED_SURFACE',
          authorityRef: journey.approval.requestHash,
          available: true,
          trustedSurface:
            journey.approval.deepLink === undefined
              ? { requestHash: journey.approval.requestHash }
              : { requestHash: journey.approval.requestHash, deepLink: journey.approval.deepLink },
        });
        actions.push({
          actionId: 'view-approval-status',
          label: 'View approval status',
          kind: 'API_COMMAND',
          authorityRef: journey.approval.requestHash,
          available: true,
          apiCommand: { method: 'GET', path: `/v1/approvals/${journey.approval.requestHash}` },
        });
      }
      actions.push({
        actionId: 'abandon-journey',
        label: 'Cancel this payment',
        kind: 'NAVIGATION',
        ...base,
        available: true,
      });
      break;
    case 'DELEGATED_TO_AGENT':
      actions.push({
        actionId: 'grant-agent-authority',
        label: 'Request approval to delegate payment authority',
        kind: 'API_COMMAND',
        ...base,
        available: true,
        apiCommand: {
          method: 'POST',
          path: '/v1/approvals',
          body: {
            agentRef: journey.agentRef,
            scope: {
              actions: ['payments.intent.create'],
              resources: [{ type: 'intent' }],
              maxAmount: {
                currency: journey.payment.amount.currency,
                minorUnits: journey.payment.amount.minorUnits,
              },
            },
          },
        },
      });
      actions.push({
        actionId: 'view-delegation-terms',
        label: 'View what the agent may do (proposals only, INV-G03)',
        kind: 'EVIDENCE_VIEW',
        ...base,
        available: true,
      });
      actions.push({
        actionId: 'abandon-journey',
        label: 'Cancel this delegation',
        kind: 'NAVIGATION',
        ...base,
        available: true,
      });
      break;
    case 'AWAITING_DELEGATION_APPROVAL':
      if (journey.approval !== undefined) {
        actions.push({
          actionId: 'open-trusted-approval-surface',
          label: 'Complete delegation approval on the trusted surface',
          kind: 'TRUSTED_SURFACE',
          authorityRef: journey.approval.requestHash,
          available: true,
          trustedSurface:
            journey.approval.deepLink === undefined
              ? { requestHash: journey.approval.requestHash }
              : { requestHash: journey.approval.requestHash, deepLink: journey.approval.deepLink },
        });
      }
      actions.push({
        actionId: 'abandon-journey',
        label: 'Cancel this delegation',
        kind: 'NAVIGATION',
        ...base,
        available: true,
      });
      break;
    case 'DELEGATION_READY':
      actions.push({
        actionId: 'submit-delegated-intent',
        label: 'Submit the delegated payment intent',
        kind: 'API_COMMAND',
        ...base,
        available: true,
        apiCommand: {
          method: 'POST',
          path: '/v1/intents',
          body: {
            commandType: 'payments.intent.create',
            amount: journey.payment.amount,
            ...(journey.payment.correlationId === undefined
              ? {}
              : { correlationId: journey.payment.correlationId }),
          },
        },
      });
      actions.push({
        actionId: 'view-agent-authority',
        label: 'View the authority the agent holds',
        kind: 'EVIDENCE_VIEW',
        ...base,
        available: true,
      });
      break;
    case 'SUBMITTED':
      if (journey.submittedIntent !== undefined) {
        actions.push({
          actionId: 'view-submitted-intent',
          label: 'View the submitted intent',
          kind: 'API_COMMAND',
          authorityRef: journey.submittedIntent.intentId,
          available: true,
          apiCommand: { method: 'GET', path: `/v1/intents/${journey.submittedIntent.intentId}` },
        });
      }
      actions.push({
        actionId: 'reconcile-documents',
        label: 'Reconcile this payment against invoices, orders or projects',
        kind: 'NAVIGATION',
        ...base,
        available: true,
      });
      break;
    case 'AUTHORIZATION_ERROR':
      actions.push({
        actionId: 'view-error',
        label: 'View the authoritative error',
        kind: 'EVIDENCE_VIEW',
        ...base,
        available: journey.error !== undefined,
        ...(journey.error === undefined
          ? { unavailableReason: 'no error recorded on this journey' }
          : {}),
      });
      actions.push({
        actionId: 'retry-as-new-intent',
        label: 'Start again as a new intent (fresh idempotency key)',
        kind: 'NAVIGATION',
        ...base,
        available: true,
      });
      break;
    case 'ABANDONED':
      actions.push({
        actionId: 'view-journey-history',
        label: 'View journey history',
        kind: 'EVIDENCE_VIEW',
        ...base,
        available: true,
      });
      actions.push({
        actionId: 'start-new-journey',
        label: 'Start a new payment',
        kind: 'NAVIGATION',
        ...base,
        available: true,
      });
      break;
    default: {
      const exhaustive: never = stateName;
      throw new ViewContractError(`unhandled choose-or-delegate state: ${String(exhaustive)}`);
    }
  }
  return Object.freeze(actions);
}

function finishChooseJourney(
  journey: Omit<ChooseOrDelegateJourney, 'actions'>,
): ChooseOrDelegateJourney {
  return Object.freeze({
    ...journey,
    actions: chooseJourneyActions(journey.stateName, journey),
  });
}

/** Begin the choose-or-delegate payment journey. */
export function beginChooseOrDelegatePayment(input: {
  readonly payment: PaymentRequestSummary;
  readonly offers: readonly PaymentMethodOffer[];
  readonly rejections: readonly RejectedMethodView[];
  readonly acceptance?: PaymentAcceptancePolicy;
  readonly request?: AcceptanceRequest;
}): ChooseOrDelegateJourney {
  const recommendation =
    input.acceptance !== undefined && input.request !== undefined
      ? recommendPaymentMethod(input.offers, { acceptance: input.acceptance, request: input.request })
      : undefined;
  return finishChooseJourney({
    journeyId: 'choose-or-delegate-payment',
    stateName: 'CHOOSING_METHOD',
    terminal: false,
    payment: input.payment,
    offers: Object.freeze([...input.offers]),
    rejections: Object.freeze([...input.rejections]),
    ...(recommendation === undefined ? {} : { recommendation }),
  });
}

/** Fold: the payer chose a method (pure — terms come from the derived offer). */
export function chooseMethod(
  journey: ChooseOrDelegateJourney,
  methodId: string,
): ChooseOrDelegateJourney {
  if (journey.stateName !== 'CHOOSING_METHOD') {
    throw new JourneyContractError(`choose-method is not legal in state ${journey.stateName}`);
  }
  const offer = journey.offers.find((candidate) => candidate.methodId === methodId);
  if (offer === undefined) {
    throw new JourneyContractError(`method ${methodId} has no derived offer on this journey`);
  }
  return finishChooseJourney({ ...journey, stateName: 'REVIEWING_TERMS', chosenOffer: offer });
}

/** Fold: the payer delegated the payment to an agent (agent PROPOSES, INV-G03). */
export function delegatePayment(
  journey: ChooseOrDelegateJourney,
  agentRef: string,
): ChooseOrDelegateJourney {
  if (journey.stateName !== 'CHOOSING_METHOD') {
    throw new JourneyContractError(`delegate-payment is not legal in state ${journey.stateName}`);
  }
  return finishChooseJourney({ ...journey, stateName: 'DELEGATED_TO_AGENT', agentRef });
}

/** Fold the intent submission response into the journey (pure). */
export function applyIntentSubmissionResponse(
  journey: ChooseOrDelegateJourney,
  response: ApiResponse,
): ChooseOrDelegateJourney {
  const outcome = parseIntentSubmissionResponse(response);
  switch (outcome.kind) {
    case 'GRANTED':
      return finishChooseJourney({
        ...journey,
        stateName: 'SUBMITTED',
        terminal: true,
        submittedIntent: {
          intentId: outcome.intentId,
          ...(outcome.grantRef === undefined ? {} : { grantRef: outcome.grantRef }),
        },
      });
    case 'APPROVAL_REQUIRED':
      return finishChooseJourney({
        ...journey,
        stateName: 'AWAITING_APPROVAL',
        approval: {
          requestHash: outcome.requestHash,
          expiresAt: outcome.expiresAt,
          ...(outcome.deepLink === undefined ? {} : { deepLink: outcome.deepLink }),
        },
      });
    case 'ERROR':
      return finishChooseJourney({ ...journey, stateName: 'AUTHORIZATION_ERROR', error: outcome });
    default: {
      const exhaustive: never = outcome;
      throw new JourneyContractError(`unhandled intent outcome: ${String(exhaustive)}`);
    }
  }
}

/** Fold the delegation authorization response (pure). */
export function applyDelegationAuthorizationResponse(
  journey: ChooseOrDelegateJourney,
  response: ApiResponse,
): ChooseOrDelegateJourney {
  if (journey.stateName !== 'DELEGATED_TO_AGENT') {
    throw new JourneyContractError(
      `grant-agent-authority response is not foldable in state ${journey.stateName}`,
    );
  }
  const outcome = parseIntentSubmissionResponse(response);
  if (outcome.kind === 'APPROVAL_REQUIRED') {
    return finishChooseJourney({
      ...journey,
      stateName: 'AWAITING_DELEGATION_APPROVAL',
      approval: {
        requestHash: outcome.requestHash,
        expiresAt: outcome.expiresAt,
        ...(outcome.deepLink === undefined ? {} : { deepLink: outcome.deepLink }),
      },
    });
  }
  if (outcome.kind === 'ERROR') {
    return finishChooseJourney({ ...journey, stateName: 'AUTHORIZATION_ERROR', error: outcome });
  }
  throw new JourneyContractError(
    'delegation authorization is expected to produce an approval request or an error',
  );
}

/**
 * Fold: the delegation approval completed on the trusted surface (the caller
 * obtained the signed artifact through the trusted surface — see
 * trusted-approvals.ts). The journey is now ready to submit the delegated
 * intent carrying the approval artifact reference.
 */
export function confirmDelegationApproval(
  journey: ChooseOrDelegateJourney,
): ChooseOrDelegateJourney {
  if (journey.stateName !== 'AWAITING_DELEGATION_APPROVAL' || journey.approval === undefined) {
    throw new JourneyContractError('confirm-delegation-approval requires an awaited delegation approval');
  }
  return finishChooseJourney({ ...journey, stateName: 'DELEGATION_READY' });
}

/** Fold: abandon the journey. */
export function abandonJourney(journey: ChooseOrDelegateJourney): ChooseOrDelegateJourney {
  if (journey.stateName === 'SUBMITTED') {
    throw new JourneyContractError('a submitted intent cannot be abandoned from the journey');
  }
  return finishChooseJourney({ ...journey, stateName: 'ABANDONED', terminal: true });
}

/** Dispatch `authorize-payment` through the API and fold the response. */
export async function submitAuthorizationIntent(
  session: JourneySession,
  journey: ChooseOrDelegateJourney,
): Promise<{ readonly journey: ChooseOrDelegateJourney; readonly response: ApiResponse }> {
  const action = journey.actions.find((candidate) => candidate.actionId === 'authorize-payment');
  if (action === undefined || !action.available || action.apiCommand === undefined) {
    throw new JourneyContractError('authorize-payment is not available in this state');
  }
  const response = await dispatchJourneyCommand(session, action.apiCommand);
  return { journey: applyIntentSubmissionResponse(journey, response), response };
}

/** Dispatch `grant-agent-authority` through the API and fold the response. */
export async function grantAgentAuthority(
  session: JourneySession,
  journey: ChooseOrDelegateJourney,
): Promise<{ readonly journey: ChooseOrDelegateJourney; readonly response: ApiResponse }> {
  const action = journey.actions.find((candidate) => candidate.actionId === 'grant-agent-authority');
  if (action === undefined || !action.available || action.apiCommand === undefined) {
    throw new JourneyContractError('grant-agent-authority is not available in this state');
  }
  const spec: ApiCommandSpec = {
    ...action.apiCommand,
    body: { ...(action.apiCommand.body as Readonly<Record<string, unknown>>), principal: session.auth.principal },
  };
  const response = await dispatchJourneyCommand(session, spec);
  return { journey: applyDelegationAuthorizationResponse(journey, response), response };
}

/**
 * Dispatch `submit-delegated-intent` — the intent the delegated agent
 * proposed. When `approvalArtifactRef` is provided (an artifact minted on
 * the trusted surface for THIS intent's request hash) it is attached to the
 * submission; otherwise the intent is adjudicated like any other (a
 * NEEDS_APPROVAL outcome folds the journey into AWAITING_APPROVAL).
 */
export async function submitDelegatedIntent(
  session: JourneySession,
  journey: ChooseOrDelegateJourney,
  approvalArtifactRef?: string,
): Promise<{ readonly journey: ChooseOrDelegateJourney; readonly response: ApiResponse }> {
  const action = journey.actions.find((candidate) => candidate.actionId === 'submit-delegated-intent');
  if (action === undefined || !action.available || action.apiCommand === undefined) {
    throw new JourneyContractError('submit-delegated-intent is not available in this state');
  }
  const baseBody = action.apiCommand.body as Readonly<Record<string, unknown>>;
  const spec: ApiCommandSpec = {
    ...action.apiCommand,
    body:
      approvalArtifactRef === undefined ? baseBody : { ...baseBody, approvalArtifactRef },
  };
  const response = await dispatchJourneyCommand(session, spec);
  return { journey: applyIntentSubmissionResponse(journey, response), response };
}

/**
 * Re-submit the intent after the approval completed on the trusted surface,
 * carrying the artifact reference (INV-A03: the artifact is the authority).
 */
export async function resubmitApprovedIntent(
  session: JourneySession,
  journey: ChooseOrDelegateJourney,
  approvalArtifactRef: string,
): Promise<{ readonly journey: ChooseOrDelegateJourney; readonly response: ApiResponse }> {
  if (journey.stateName !== 'AWAITING_APPROVAL') {
    throw new JourneyContractError('resubmit-with-approval requires the AWAITING_APPROVAL state');
  }
  const spec: ApiCommandSpec = {
    method: 'POST',
    path: '/v1/intents',
    body: {
      commandType: 'payments.intent.create',
      amount: journey.payment.amount,
      ...(journey.payment.correlationId === undefined
        ? {}
        : { correlationId: journey.payment.correlationId }),
      approvalArtifactRef,
    },
  };
  const response = await dispatchJourneyCommand(session, spec);
  return { journey: applyIntentSubmissionResponse(journey, response), response };
}

// ---------------------------------------------------------------------------
// Journey 2 — switch/fallback with EXPLICIT term changes
// ---------------------------------------------------------------------------

export type SwitchOrFallbackStateName =
  | 'EVALUATING_SWITCH'
  | 'REAUTHORIZATION_REQUIRED'
  | 'AWAITING_FALLBACK_APPROVAL'
  | 'SWITCHED'
  | 'SWITCH_DECLINED';

export interface MaterialTermChange {
  readonly field: 'amount' | 'currency' | 'fees' | 'completionMs' | 'recourse' | 'settlementDestinationId';
  readonly from: string;
  readonly to: string;
}

export interface SwitchOrFallbackJourney {
  readonly journeyId: 'switch-or-fallback-payment';
  readonly stateName: SwitchOrFallbackStateName;
  readonly terminal: boolean;
  readonly currentOffer: PaymentMethodOffer;
  readonly candidateOffer: PaymentMethodOffer;
  readonly fallbackPolicy: PaymentFallbackPolicy;
  /** EXPLICIT term changes the switch would realize (never silent). */
  readonly termChanges: readonly MaterialTermChange[];
  readonly fallbackEvaluation: { readonly automatic: boolean; readonly reasons: readonly string[] };
  readonly approval?: { readonly requestHash: string; readonly expiresAt: string; readonly deepLink?: string };
  readonly submittedIntent?: { readonly intentId: string; readonly grantRef?: string };
  readonly error?: JourneyErrorResult;
  readonly actions: readonly ViewAction[];
}

/** Render one material term field exactly (string form for the diff view). */
function renderTermField(terms: MaterialTerms, field: MaterialTermChange['field']): string {
  switch (field) {
    case 'amount':
      return `${terms.amount.currency} ${terms.amount.value.toString()}`;
    case 'currency':
      return terms.currency;
    case 'fees':
      return `${terms.fees.currency} ${terms.fees.value.toString()}`;
    case 'completionMs':
      return terms.completionMs.toString();
    case 'recourse':
      return terms.recourse;
    case 'settlementDestinationId':
      return terms.settlementDestinationId;
    default: {
      const exhaustive: never = field;
      throw new ViewContractError(`unhandled material term field: ${String(exhaustive)}`);
    }
  }
}

/**
 * Diff two material-term sets field by field. A non-empty diff means the
 * switch CHANGES material terms and requires fresh re-authorization
 * (PAYMENT-OPERATING-PLANE; W1-003 translation semantics).
 */
export function diffMaterialTerms(
  authorized: MaterialTerms,
  candidate: MaterialTerms,
): readonly MaterialTermChange[] {
  const fields: readonly MaterialTermChange['field'][] = [
    'amount',
    'currency',
    'fees',
    'completionMs',
    'recourse',
    'settlementDestinationId',
  ];
  const changes: MaterialTermChange[] = [];
  for (const field of fields) {
    const from = renderTermField(authorized, field);
    const to = renderTermField(candidate, field);
    if (from !== to) {
      changes.push({ field, from, to });
    }
  }
  return Object.freeze(changes);
}

function switchJourneyActions(
  stateName: SwitchOrFallbackStateName,
  journey: Omit<SwitchOrFallbackJourney, 'actions'>,
): readonly ViewAction[] {
  const actions: ViewAction[] = [];
  const base = { authorityRef: journey.candidateOffer.offerId };
  const decline: ViewAction = {
    actionId: 'decline-switch',
    label: 'Keep the current method',
    kind: 'NAVIGATION',
    ...base,
    available: true,
  };
  switch (stateName) {
    case 'EVALUATING_SWITCH':
      actions.push({
        actionId: 'execute-switch',
        label: 'Execute the switch (terms unchanged, within fallback thresholds)',
        kind: 'API_COMMAND',
        ...base,
        available: true,
        apiCommand: {
          method: 'POST',
          path: '/v1/intents',
          body: {
            commandType: 'payments.method.switch',
            correlationId: `switch:${journey.candidateOffer.methodId}`,
          },
        },
      });
      actions.push({
        actionId: 'view-fallback-policy',
        label: 'View the fallback policy thresholds',
        kind: 'EVIDENCE_VIEW',
        ...base,
        available: true,
      });
      actions.push(decline);
      break;
    case 'REAUTHORIZATION_REQUIRED':
      actions.push({
        actionId: 'view-term-changes',
        label: 'View the explicit term changes requiring re-authorization',
        kind: 'EVIDENCE_VIEW',
        ...base,
        available: journey.termChanges.length > 0,
        ...(journey.termChanges.length > 0
          ? {}
          : { unavailableReason: 'no term changes recorded (internal inconsistency)' }),
      });
      actions.push({
        actionId: 'approve-new-terms',
        label: 'Approve the new terms (fresh authorization required)',
        kind: 'API_COMMAND',
        ...base,
        available: true,
        apiCommand: {
          method: 'POST',
          path: '/v1/approvals',
          body: {
            scope: {
              actions: ['payments.intent.create'],
              resources: [{ type: 'intent' }],
            },
          },
        },
      });
      actions.push(decline);
      break;
    case 'AWAITING_FALLBACK_APPROVAL':
      if (journey.approval !== undefined) {
        actions.push({
          actionId: 'open-trusted-approval-surface',
          label: 'Complete the fallback approval on the trusted surface',
          kind: 'TRUSTED_SURFACE',
          authorityRef: journey.approval.requestHash,
          available: true,
          trustedSurface:
            journey.approval.deepLink === undefined
              ? { requestHash: journey.approval.requestHash }
              : { requestHash: journey.approval.requestHash, deepLink: journey.approval.deepLink },
        });
      }
      actions.push(decline);
      break;
    case 'SWITCHED':
      if (journey.submittedIntent !== undefined) {
        actions.push({
          actionId: 'view-switched-intent',
          label: 'View the switch intent',
          kind: 'API_COMMAND',
          authorityRef: journey.submittedIntent.intentId,
          available: true,
          apiCommand: { method: 'GET', path: `/v1/intents/${journey.submittedIntent.intentId}` },
        });
      }
      actions.push({
        actionId: 'view-new-terms',
        label: 'View the terms now in effect',
        kind: 'EVIDENCE_VIEW',
        ...base,
        available: true,
      });
      break;
    case 'SWITCH_DECLINED':
      actions.push({
        actionId: 'view-decline-reason',
        label: 'View why the switch was not executed',
        kind: 'EVIDENCE_VIEW',
        ...base,
        available: journey.error !== undefined,
        ...(journey.error === undefined
          ? {}
          : { unavailableReason: 'the switch was declined by the payer (no error)' }),
      });
      actions.push({
        actionId: 'start-new-journey',
        label: 'Start a new payment journey',
        kind: 'NAVIGATION',
        ...base,
        available: true,
      });
      break;
    default: {
      const exhaustive: never = stateName;
      throw new ViewContractError(`unhandled switch state: ${String(exhaustive)}`);
    }
  }
  return Object.freeze(actions);
}

function finishSwitchJourney(
  journey: Omit<SwitchOrFallbackJourney, 'actions'>,
): SwitchOrFallbackJourney {
  return Object.freeze({ ...journey, actions: switchJourneyActions(journey.stateName, journey) });
}

/**
 * Begin the switch/fallback journey. The initial state is derived from
 * AUTHORITY ONLY: explicit material-term diff + the payment plane's fallback
 * evaluation (`evaluateFallback`, W1-003). Changed terms force
 * `REAUTHORIZATION_REQUIRED` — a material change is never silently absorbed.
 */
export function beginSwitchOrFallback(input: {
  readonly currentOffer: PaymentMethodOffer;
  readonly candidateOffer: PaymentMethodOffer;
  readonly fallbackPolicy: PaymentFallbackPolicy;
  readonly authorizedTerms: MaterialTerms;
  readonly candidateTerms: MaterialTerms;
  readonly extraCostBasisPoints: bigint;
  readonly extraDelayMs: bigint;
}): SwitchOrFallbackJourney {
  const termChanges = diffMaterialTerms(input.authorizedTerms, input.candidateTerms);
  const fallbackEvaluation = evaluateFallback(input.fallbackPolicy, {
    alternateMethod: input.candidateOffer.methodId,
    extraCostBasisPoints: input.extraCostBasisPoints,
    extraDelayMs: input.extraDelayMs,
  });
  const base: Omit<SwitchOrFallbackJourney, 'actions'> = {
    journeyId: 'switch-or-fallback-payment',
    stateName: 'EVALUATING_SWITCH',
    terminal: false,
    currentOffer: input.currentOffer,
    candidateOffer: input.candidateOffer,
    fallbackPolicy: input.fallbackPolicy,
    termChanges,
    fallbackEvaluation,
  };
  if (termChanges.length > 0) {
    return finishSwitchJourney({ ...base, stateName: 'REAUTHORIZATION_REQUIRED' });
  }
  if (!fallbackEvaluation.automatic) {
    return finishSwitchJourney({ ...base, stateName: 'AWAITING_FALLBACK_APPROVAL' });
  }
  return finishSwitchJourney(base);
}

/** Fold the switch execution response (pure). */
export function applySwitchExecutionResponse(
  journey: SwitchOrFallbackJourney,
  response: ApiResponse,
): SwitchOrFallbackJourney {
  const outcome = parseIntentSubmissionResponse(response);
  switch (outcome.kind) {
    case 'GRANTED':
      return finishSwitchJourney({
        ...journey,
        stateName: 'SWITCHED',
        terminal: true,
        submittedIntent: {
          intentId: outcome.intentId,
          ...(outcome.grantRef === undefined ? {} : { grantRef: outcome.grantRef }),
        },
      });
    case 'APPROVAL_REQUIRED':
      return finishSwitchJourney({
        ...journey,
        stateName: 'AWAITING_FALLBACK_APPROVAL',
        approval: {
          requestHash: outcome.requestHash,
          expiresAt: outcome.expiresAt,
          ...(outcome.deepLink === undefined ? {} : { deepLink: outcome.deepLink }),
        },
      });
    case 'ERROR':
      return finishSwitchJourney({
        ...journey,
        stateName: 'SWITCH_DECLINED',
        terminal: true,
        error: outcome,
      });
    default: {
      const exhaustive: never = outcome;
      throw new JourneyContractError(`unhandled switch outcome: ${String(exhaustive)}`);
    }
  }
}

/** Dispatch `execute-switch` through the API and fold the response. */
export async function executeSwitch(
  session: JourneySession,
  journey: SwitchOrFallbackJourney,
): Promise<{ readonly journey: SwitchOrFallbackJourney; readonly response: ApiResponse }> {
  const action = journey.actions.find((candidate) => candidate.actionId === 'execute-switch');
  if (action === undefined || !action.available || action.apiCommand === undefined) {
    throw new JourneyContractError('execute-switch is not available in this state');
  }
  const response = await dispatchJourneyCommand(session, action.apiCommand);
  return { journey: applySwitchExecutionResponse(journey, response), response };
}

/**
 * Dispatch `approve-new-terms` (the explicit re-authorization request for
 * changed material terms) through the API and fold the response.
 */
export async function requestNewTermsApproval(
  session: JourneySession,
  journey: SwitchOrFallbackJourney,
): Promise<{ readonly journey: SwitchOrFallbackJourney; readonly response: ApiResponse }> {
  const action = journey.actions.find((candidate) => candidate.actionId === 'approve-new-terms');
  if (action === undefined || !action.available || action.apiCommand === undefined) {
    throw new JourneyContractError('approve-new-terms is not available in this state');
  }
  const spec: ApiCommandSpec = {
    ...action.apiCommand,
    body: { ...(action.apiCommand.body as Readonly<Record<string, unknown>>), principal: session.auth.principal },
  };
  const response = await dispatchJourneyCommand(session, spec);
  const outcome = parseIntentSubmissionResponse(response);
  if (outcome.kind === 'APPROVAL_REQUIRED') {
    return {
      journey: finishSwitchJourney({
        ...journey,
        stateName: 'AWAITING_FALLBACK_APPROVAL',
        approval: {
          requestHash: outcome.requestHash,
          expiresAt: outcome.expiresAt,
          ...(outcome.deepLink === undefined ? {} : { deepLink: outcome.deepLink }),
        },
      }),
      response,
    };
  }
  if (outcome.kind === 'ERROR') {
    return {
      journey: finishSwitchJourney({ ...journey, stateName: 'SWITCH_DECLINED', terminal: true, error: outcome }),
      response,
    };
  }
  throw new JourneyContractError(
    'a new-terms approval request is expected to produce an approval request or an error',
  );
}

/**
 * Fold: the fallback/new-terms approval completed on the trusted surface;
 * the switch may now be executed (the authorization covers the new terms).
 */
export function confirmFallbackApproval(
  journey: SwitchOrFallbackJourney,
): SwitchOrFallbackJourney {
  if (journey.stateName !== 'AWAITING_FALLBACK_APPROVAL' || journey.approval === undefined) {
    throw new JourneyContractError('confirm-fallback-approval requires an awaited fallback approval');
  }
  return finishSwitchJourney({ ...journey, stateName: 'EVALUATING_SWITCH' });
}

/** Fold: the payer declined the switch (terminal). */
export function declineSwitch(journey: SwitchOrFallbackJourney): SwitchOrFallbackJourney {
  return finishSwitchJourney({ ...journey, stateName: 'SWITCH_DECLINED', terminal: true });
}

// ---------------------------------------------------------------------------
// Journey 3 — recurring mandate management
// ---------------------------------------------------------------------------

export type MandateJourneyStateName =
  | 'VIEWING_MANDATE'
  | 'MANDATE_EVENT_RECORDED'
  | 'AWAITING_NEW_MANDATE_APPROVAL';

export interface MandateManagementJourney {
  readonly journeyId: 'manage-recurring-mandate';
  readonly stateName: MandateJourneyStateName;
  readonly terminal: boolean;
  readonly mandate: RecurringMandate;
  readonly approval?: { readonly requestHash: string; readonly expiresAt: string; readonly deepLink?: string };
  readonly actions: readonly ViewAction[];
}

type MandateEventName = 'ACTIVATE' | 'PAUSE' | 'RESUME' | 'CANCEL' | 'EXPIRE';

const MANDATE_EVENT_LABELS: Readonly<Record<MandateEventName, string>> = Object.freeze({
  ACTIVATE: 'Activate the mandate',
  PAUSE: 'Pause the mandate',
  RESUME: 'Resume the mandate',
  CANCEL: 'Cancel the mandate',
  EXPIRE: 'Record mandate expiry',
});

function mandateJourneyActions(
  journey: Omit<MandateManagementJourney, 'actions'>,
  nowMs: number,
): readonly ViewAction[] {
  const mandate = journey.mandate;
  const base = { authorityRef: mandate.id };
  const actions: ViewAction[] = [];

  for (const event of ['ACTIVATE', 'PAUSE', 'RESUME', 'CANCEL', 'EXPIRE'] as const) {
    // One-to-one with the authority machine: an action exists exactly when
    // @payswap/payment's mandateStateMachine accepts the transition.
    let legal = false;
    try {
      applyMandateEvent(mandate, event, BigInt(nowMs));
      legal = true;
    } catch {
      legal = false;
    }
    if (legal) {
      actions.push({
        actionId: `mandate-${event.toLowerCase()}`,
        label: MANDATE_EVENT_LABELS[event],
        kind: 'AUTHORITY_TRANSITION',
        ...base,
        available: true,
        authorityEvent: { domain: 'MANDATE', authorityId: mandate.id, event },
      });
    }
  }

  switch (journey.stateName) {
    case 'VIEWING_MANDATE':
    case 'MANDATE_EVENT_RECORDED':
      if (mandate.state === 'CANCELLED' || mandate.state === 'EXPIRED') {
        // No renewal transition exists in the authority machine — renewal is
        // a NEW mandate with fresh authorization (never silent expansion).
        actions.push({
          actionId: 'request-new-mandate-authorization',
          label: 'Authorize a new mandate',
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
      } else {
        actions.push({
          actionId: 'view-charge-admissibility',
          label: 'View charge admissibility under this mandate',
          kind: 'EVIDENCE_VIEW',
          ...base,
          available: true,
        });
      }
      break;
    case 'AWAITING_NEW_MANDATE_APPROVAL':
      if (journey.approval !== undefined) {
        actions.push({
          actionId: 'open-trusted-approval-surface',
          label: 'Complete the new-mandate approval on the trusted surface',
          kind: 'TRUSTED_SURFACE',
          authorityRef: journey.approval.requestHash,
          available: true,
          trustedSurface:
            journey.approval.deepLink === undefined
              ? { requestHash: journey.approval.requestHash }
              : { requestHash: journey.approval.requestHash, deepLink: journey.approval.deepLink },
        });
      }
      break;
    default: {
      const exhaustive: never = journey.stateName;
      throw new ViewContractError(`unhandled mandate journey state: ${String(exhaustive)}`);
    }
  }
  actions.push({
    actionId: 'view-mandate-scope',
    label: 'View mandate scope, maximums and schedule',
    kind: 'EVIDENCE_VIEW',
    ...base,
    available: true,
  });
  return Object.freeze(actions);
}

function finishMandateJourney(
  journey: Omit<MandateManagementJourney, 'actions'>,
  nowMs: number,
): MandateManagementJourney {
  return Object.freeze({ ...journey, actions: mandateJourneyActions(journey, nowMs) });
}

/** Begin mandate management for one authority mandate. */
export function beginMandateManagement(input: {
  readonly mandate: RecurringMandate;
  readonly nowMs: number;
}): MandateManagementJourney {
  return finishMandateJourney(
    {
      journeyId: 'manage-recurring-mandate',
      stateName: 'VIEWING_MANDATE',
      terminal: false,
      mandate: input.mandate,
    },
    input.nowMs,
  );
}

/**
 * Fold a mandate event through the AUTHORITY machine (`applyMandateEvent`,
 * @payswap/payment). The view offers only events the authority machine
 * accepts; an illegal fold throws (no view-side transitions).
 */
export function applyMandateJourneyEvent(
  journey: MandateManagementJourney,
  event: MandateEventName,
  nowMs: number,
): MandateManagementJourney {
  const nextMandate = applyMandateEvent(journey.mandate, event, BigInt(nowMs));
  return finishMandateJourney(
    {
      ...journey,
      stateName: 'MANDATE_EVENT_RECORDED',
      mandate: nextMandate,
    },
    nowMs,
  );
}

/**
 * Dispatch the mandate-event recording intent through the API and fold the
 * authority machine: the event is BOTH recorded as a protocol command and
 * folded on the authority record — never a view-only mutation.
 */
export async function recordMandateEvent(
  session: JourneySession,
  journey: MandateManagementJourney,
  event: MandateEventName,
  nowMs: number,
): Promise<{ readonly journey: MandateManagementJourney; readonly response: ApiResponse }> {
  const action = journey.actions.find((candidate) => candidate.actionId === `mandate-${event.toLowerCase()}`);
  if (action === undefined || !action.available) {
    throw new JourneyContractError(`mandate event ${event} is not legal in state ${journey.mandate.state}`);
  }
  const response = await dispatchJourneyCommand(session, {
    method: 'POST',
    path: '/v1/intents',
    body: {
      commandType: `payments.mandate.${event.toLowerCase()}`,
      correlationId: journey.mandate.id,
    },
  });
  if (response.kind === 'error') {
    const error = response.body.error;
    throw new JourneyContractError(
      `mandate event intent was rejected (${error.category}/${error.code}): ${error.message}`,
    );
  }
  return { journey: applyMandateJourneyEvent(journey, event, nowMs), response };
}

/** Fold the new-mandate approval response (pure). */
export function applyNewMandateApprovalResponse(
  journey: MandateManagementJourney,
  response: ApiResponse,
  nowMs: number,
): MandateManagementJourney {
  const outcome = parseIntentSubmissionResponse(response);
  if (outcome.kind === 'APPROVAL_REQUIRED') {
    return finishMandateJourney(
      {
        ...journey,
        stateName: 'AWAITING_NEW_MANDATE_APPROVAL',
        approval: {
          requestHash: outcome.requestHash,
          expiresAt: outcome.expiresAt,
          ...(outcome.deepLink === undefined ? {} : { deepLink: outcome.deepLink }),
        },
      },
      nowMs,
    );
  }
  if (outcome.kind === 'ERROR') {
    throw new JourneyContractError(
      `new-mandate authorization was denied (${outcome.category}/${outcome.code}): ${outcome.message}`,
    );
  }
  throw new JourneyContractError(
    'a new-mandate authorization request is expected to produce an approval request or an error',
  );
}

/** Dispatch `request-new-mandate-authorization` through the API and fold. */
export async function requestNewMandateAuthorization(
  session: JourneySession,
  journey: MandateManagementJourney,
  nowMs: number,
): Promise<{ readonly journey: MandateManagementJourney; readonly response: ApiResponse }> {
  const action = journey.actions.find(
    (candidate) => candidate.actionId === 'request-new-mandate-authorization',
  );
  if (action === undefined || !action.available || action.apiCommand === undefined) {
    throw new JourneyContractError('request-new-mandate-authorization is not available in this state');
  }
  const response = await dispatchJourneyCommand(session, action.apiCommand);
  return { journey: applyNewMandateApprovalResponse(journey, response, nowMs), response };
}

// ---------------------------------------------------------------------------
// Journey 4 — invoice/order/project reconciliation
// ---------------------------------------------------------------------------

export type ReconcileStateName = 'ALLOCATING' | 'ALLOCATION_MISMATCH' | 'ALLOCATED';

export interface DocumentAllocationDraft {
  readonly documentKind: RemittanceDocumentKind;
  readonly documentId: string;
  readonly allocatedAmount: RemittanceAllocation['allocations'][number]['allocatedAmount'];
}

export interface ReconcileDocumentsJourney {
  readonly journeyId: 'reconcile-invoice-order-project';
  readonly stateName: ReconcileStateName;
  readonly terminal: boolean;
  readonly paymentRef: string;
  readonly methodId: string;
  readonly paymentAmount: RemittanceAllocation['paymentAmount'];
  readonly documents: readonly DocumentAllocationDraft[];
  /** The allocation id the authority allocation will be recorded under. */
  readonly allocationId: string;
  readonly remittanceInfo?: string;
  readonly allocation?: RemittanceAllocation;
  readonly mismatch?: {
    readonly currency: string;
    readonly expected: bigint;
    readonly actual: bigint;
    readonly reason: string;
  };
  readonly actions: readonly ViewAction[];
}

function reconcileActions(journey: Omit<ReconcileDocumentsJourney, 'actions'>): readonly ViewAction[] {
  const base = { authorityRef: journey.paymentRef };
  const actions: ViewAction[] = [];
  switch (journey.stateName) {
    case 'ALLOCATING':
      actions.push({
        actionId: 'submit-allocation',
        label: 'Allocate the payment to documents',
        kind: 'NAVIGATION',
        ...base,
        available: journey.documents.length > 0,
        ...(journey.documents.length > 0
          ? {}
          : { unavailableReason: 'select at least one document to allocate against' }),
      });
      break;
    case 'ALLOCATION_MISMATCH':
      actions.push({
        actionId: 'adjust-allocations',
        label: 'Adjust the allocations so they sum exactly to the payment',
        kind: 'NAVIGATION',
        ...base,
        available: true,
      });
      actions.push({
        actionId: 'view-discrepancy',
        label: 'View the exact discrepancy',
        kind: 'EVIDENCE_VIEW',
        ...base,
        available: journey.mismatch !== undefined,
        ...(journey.mismatch === undefined
          ? { unavailableReason: 'no mismatch recorded on this journey' }
          : {}),
      });
      break;
    case 'ALLOCATED':
      actions.push({
        actionId: 'view-documents-settled',
        label: 'View which documents this payment settles',
        kind: 'EVIDENCE_VIEW',
        ...base,
        available: true,
      });
      actions.push({
        actionId: 'record-allocation-intent',
        label: 'Record the allocation as a protocol command',
        kind: 'API_COMMAND',
        ...base,
        available: true,
        apiCommand: {
          method: 'POST',
          path: '/v1/intents',
          body: {
            commandType: 'payments.remittance.allocate',
            correlationId: journey.paymentRef,
          },
        },
      });
      break;
    default: {
      const exhaustive: never = journey.stateName;
      throw new ViewContractError(`unhandled reconcile state: ${String(exhaustive)}`);
    }
  }
  return Object.freeze(actions);
}

function finishReconcileJourney(
  journey: Omit<ReconcileDocumentsJourney, 'actions'>,
): ReconcileDocumentsJourney {
  return Object.freeze({ ...journey, actions: reconcileActions(journey) });
}

/**
 * Begin document reconciliation: the ALLOCATING state lists the draft
 * allocations; `submitAllocation` runs the AUTHORITY allocation.
 */
export function beginReconcileDocuments(input: {
  readonly allocationId: string;
  readonly paymentRef: string;
  readonly methodId: string;
  readonly paymentAmount: RemittanceAllocation['paymentAmount'];
  readonly documents: readonly DocumentAllocationDraft[];
  readonly remittanceInfo?: string;
}): ReconcileDocumentsJourney {
  return finishReconcileJourney({
    journeyId: 'reconcile-invoice-order-project',
    stateName: 'ALLOCATING',
    terminal: false,
    paymentRef: input.paymentRef,
    methodId: input.methodId,
    paymentAmount: input.paymentAmount,
    documents: Object.freeze([...input.documents]),
    allocationId: input.allocationId,
    ...(input.remittanceInfo === undefined ? {} : { remittanceInfo: input.remittanceInfo }),
  });
}

/**
 * Fold: run the AUTHORITY allocation (`allocateRemittance`, W1-003).
 * Allocations must sum EXACTLY to the payment amount; a mismatch is an
 * explicit, actionable state carrying the authority error — never a silent
 * pad or dust.
 */
export function submitAllocation(
  journey: ReconcileDocumentsJourney,
): ReconcileDocumentsJourney {
  if (journey.stateName !== 'ALLOCATING') {
    throw new JourneyContractError('an allocation can only be submitted in ALLOCATING');
  }
  const base: Omit<ReconcileDocumentsJourney, 'actions'> = {
    journeyId: journey.journeyId,
    stateName: 'ALLOCATING',
    terminal: false,
    paymentRef: journey.paymentRef,
    methodId: journey.methodId,
    paymentAmount: journey.paymentAmount,
    documents: journey.documents,
    allocationId: journey.allocationId,
  };
  try {
    const allocation = allocateRemittance({
      id: journey.allocationId,
      paymentRef: journey.paymentRef,
      method: journey.methodId,
      paymentAmount: journey.paymentAmount,
      allocations: journey.documents.map((draft) => ({
        documentKind: draft.documentKind,
        documentId: draft.documentId,
        allocatedAmount: draft.allocatedAmount,
      })),
      ...(journey.remittanceInfo === undefined ? {} : { remittanceInfo: journey.remittanceInfo }),
    });
    return finishReconcileJourney({ ...base, stateName: 'ALLOCATED', terminal: true, allocation });
  } catch (error) {
    const actual = journey.documents.reduce(
      (sum, draft) => sum + draft.allocatedAmount.value,
      0n,
    );
    return finishReconcileJourney({
      ...base,
      stateName: 'ALLOCATION_MISMATCH',
      mismatch: {
        currency: journey.paymentAmount.currency,
        expected: journey.paymentAmount.value,
        actual,
        reason: error instanceof Error ? error.message : 'the authority allocation was rejected',
      },
    });
  }
}

/** Fold: adjust the allocation drafts and re-enter ALLOCATING. */
export function adjustAllocations(
  journey: ReconcileDocumentsJourney,
  documents: readonly DocumentAllocationDraft[],
): ReconcileDocumentsJourney {
  return beginReconcileDocuments({
    allocationId: journey.allocationId,
    paymentRef: journey.paymentRef,
    methodId: journey.methodId,
    paymentAmount: journey.paymentAmount,
    documents,
  });
}

/** Dispatch the allocation recording intent through the API. */
export async function recordAllocationIntent(
  session: JourneySession,
  journey: ReconcileDocumentsJourney,
): Promise<ApiResponse> {
  const action = journey.actions.find((candidate) => candidate.actionId === 'record-allocation-intent');
  if (action === undefined || !action.available || action.apiCommand === undefined) {
    throw new JourneyContractError('record-allocation-intent is not available in this state');
  }
  return dispatchJourneyCommand(session, action.apiCommand);
}

// ---------------------------------------------------------------------------
// Journey 5 — refund / dispute initiation
// ---------------------------------------------------------------------------

export type RefundDisputeJourneyKind = 'REFUND' | 'DISPUTE';

export type RefundDisputeStateName =
  | 'CONFIRMING'
  | 'REQUEST_SUBMITTED'
  | 'REQUEST_DENIED'
  | 'BLOCKED_BY_POLICY'
  | 'ELIGIBILITY_UNKNOWN'
  | 'REQUEST_WITHDRAWN';

export type RefundDisputeEligibilityReason =
  | 'REFUNDS_NOT_SUPPORTED'
  | 'REFUND_WINDOW_CLOSED'
  | 'PAYMENT_NOT_FULFILLED'
  | 'NO_RECOURSE_POLICY'
  | 'PAYMENT_STATE_NOT_ESTABLISHABLE';

export interface RefundDisputeJourney {
  readonly journeyId: 'initiate-refund-or-dispute';
  readonly kind: RefundDisputeJourneyKind;
  readonly stateName: RefundDisputeStateName;
  readonly terminal: boolean;
  readonly paymentRef: string;
  readonly amount?: { readonly currency: string; readonly minorUnits: string };
  readonly eligibility: { readonly eligible: boolean; readonly reasons: readonly RefundDisputeEligibilityReason[] };
  readonly approval?: { readonly requestHash: string; readonly expiresAt: string; readonly deepLink?: string };
  readonly submittedIntent?: { readonly intentId: string; readonly grantRef?: string };
  readonly error?: JourneyErrorResult;
  readonly actions: readonly ViewAction[];
}

function refundDisputeActions(journey: Omit<RefundDisputeJourney, 'actions'>): readonly ViewAction[] {
  const base = { authorityRef: journey.paymentRef };
  const actions: ViewAction[] = [];
  switch (journey.stateName) {
    case 'CONFIRMING':
      actions.push({
        actionId: journey.kind === 'REFUND' ? 'submit-refund-request' : 'submit-dispute-request',
        label: journey.kind === 'REFUND' ? 'Submit the refund request' : 'Open the dispute',
        kind: 'API_COMMAND',
        ...base,
        available: true,
        apiCommand: {
          method: 'POST',
          path: '/v1/intents',
          body: {
            commandType: journey.kind === 'REFUND' ? 'payments.refund.create' : 'payments.dispute.open',
            ...(journey.amount === undefined ? {} : { amount: journey.amount }),
            correlationId: journey.paymentRef,
          },
        },
      });
      actions.push({
        actionId: 'view-recourse-policy',
        label: 'View the merchant recourse policy',
        kind: 'EVIDENCE_VIEW',
        ...base,
        available: true,
      });
      actions.push({
        actionId: 'withdraw-request',
        label: 'Withdraw this request',
        kind: 'NAVIGATION',
        ...base,
        available: true,
      });
      if (journey.approval !== undefined) {
        actions.push({
          actionId: 'open-trusted-approval-surface',
          label: 'Complete the required approval on the trusted surface',
          kind: 'TRUSTED_SURFACE',
          authorityRef: journey.approval.requestHash,
          available: true,
          trustedSurface:
            journey.approval.deepLink === undefined
              ? { requestHash: journey.approval.requestHash }
              : { requestHash: journey.approval.requestHash, deepLink: journey.approval.deepLink },
        });
      }
      break;
    case 'REQUEST_SUBMITTED':
      if (journey.submittedIntent !== undefined) {
        actions.push({
          actionId: 'view-submitted-request',
          label: 'View the submitted request',
          kind: 'API_COMMAND',
          authorityRef: journey.submittedIntent.intentId,
          available: true,
          apiCommand: { method: 'GET', path: `/v1/intents/${journey.submittedIntent.intentId}` },
        });
      }
      actions.push({
        actionId: 'view-evidence-requirements',
        label: 'View evidence requirements for this recourse path',
        kind: 'EVIDENCE_VIEW',
        ...base,
        available: true,
      });
      break;
    case 'REQUEST_DENIED':
      actions.push({
        actionId: 'view-denial-reason',
        label: 'View the authoritative denial',
        kind: 'EVIDENCE_VIEW',
        ...base,
        available: journey.error !== undefined,
        ...(journey.error === undefined ? { unavailableReason: 'no error recorded on this journey' } : {}),
      });
      actions.push({
        actionId: 'retry-as-new-intent',
        label: 'Start again as a new request (fresh idempotency key)',
        kind: 'NAVIGATION',
        ...base,
        available: true,
      });
      break;
    case 'BLOCKED_BY_POLICY':
      actions.push({
        actionId: 'view-policy-reason',
        label: 'View the recorded policy reason',
        kind: 'EVIDENCE_VIEW',
        ...base,
        available: true,
      });
      actions.push({
        actionId: 'contact-merchant',
        label: 'Contact the merchant about this payment',
        kind: 'EXTERNAL_OPEN',
        ...base,
        available: true,
        externalOpen: { systemName: 'merchant' },
      });
      break;
    case 'ELIGIBILITY_UNKNOWN':
      actions.push({
        actionId: 'open-payment-record',
        label: 'Open the authoritative payment record',
        kind: 'NAVIGATION',
        ...base,
        available: true,
      });
      actions.push({
        actionId: 'view-what-is-needed',
        label: 'View what is needed to establish eligibility',
        kind: 'EVIDENCE_VIEW',
        ...base,
        available: true,
      });
      break;
    case 'REQUEST_WITHDRAWN':
      actions.push({
        actionId: 'view-journey-history',
        label: 'View journey history',
        kind: 'EVIDENCE_VIEW',
        ...base,
        available: true,
      });
      break;
    default: {
      const exhaustive: never = journey.stateName;
      throw new ViewContractError(`unhandled refund/dispute state: ${String(exhaustive)}`);
    }
  }
  return Object.freeze(actions);
}

function finishRefundDisputeJourney(
  journey: Omit<RefundDisputeJourney, 'actions'>,
): RefundDisputeJourney {
  return Object.freeze({ ...journey, actions: refundDisputeActions(journey) });
}

/**
 * Begin a refund or dispute initiation. Eligibility is derived from
 * AUTHORITY ONLY: the merchant's acceptance policy (refunds supported,
 * cutoff window, recourse policy) and the payment's authoritative attempt
 * state. Without the authority record the journey is honestly
 * ELIGIBILITY_UNKNOWN — never an assumed success or failure.
 */
export function beginRefundOrDispute(input: {
  readonly kind: RefundDisputeJourneyKind;
  readonly paymentRef: string;
  readonly amount?: { readonly currency: string; readonly minorUnits: string };
  readonly acceptance: PaymentAcceptancePolicy;
  readonly attempt?: ExecutionAttempt;
  readonly nowMs: number;
}): RefundDisputeJourney {
  const reasons: RefundDisputeEligibilityReason[] = [];
  if (input.kind === 'REFUND') {
    if (!input.acceptance.refunds.supported) {
      reasons.push('REFUNDS_NOT_SUPPORTED');
    }
    if (input.attempt === undefined) {
      reasons.push('PAYMENT_STATE_NOT_ESTABLISHABLE');
    } else {
      if (input.attempt.state !== 'SUCCEEDED') {
        reasons.push('PAYMENT_NOT_FULFILLED');
      }
      const cutoffMs = input.acceptance.refunds.cutoffMs;
      if (cutoffMs !== undefined && BigInt(input.nowMs) > input.attempt.createdAt + cutoffMs) {
        reasons.push('REFUND_WINDOW_CLOSED');
      }
    }
  } else {
    if (input.acceptance.recourse === 'NONE') {
      reasons.push('NO_RECOURSE_POLICY');
    }
    if (input.attempt === undefined) {
      reasons.push('PAYMENT_STATE_NOT_ESTABLISHABLE');
    }
  }

  const base: Omit<RefundDisputeJourney, 'actions'> = {
    journeyId: 'initiate-refund-or-dispute',
    kind: input.kind,
    stateName: 'CONFIRMING',
    terminal: false,
    paymentRef: input.paymentRef,
    ...(input.amount === undefined ? {} : { amount: input.amount }),
    eligibility: { eligible: reasons.length === 0, reasons: Object.freeze(reasons) },
  };

  if (reasons.includes('PAYMENT_STATE_NOT_ESTABLISHABLE')) {
    return finishRefundDisputeJourney({ ...base, stateName: 'ELIGIBILITY_UNKNOWN' });
  }
  if (reasons.length > 0) {
    return finishRefundDisputeJourney({ ...base, stateName: 'BLOCKED_BY_POLICY' });
  }
  return finishRefundDisputeJourney(base);
}

/** Fold the refund/dispute submission response (pure). */
export function applyRefundDisputeResponse(
  journey: RefundDisputeJourney,
  response: ApiResponse,
): RefundDisputeJourney {
  const outcome = parseIntentSubmissionResponse(response);
  switch (outcome.kind) {
    case 'GRANTED':
      return finishRefundDisputeJourney({
        ...journey,
        stateName: 'REQUEST_SUBMITTED',
        terminal: true,
        submittedIntent: {
          intentId: outcome.intentId,
          ...(outcome.grantRef === undefined ? {} : { grantRef: outcome.grantRef }),
        },
      });
    case 'APPROVAL_REQUIRED':
      return finishRefundDisputeJourney({
        ...journey,
        approval: {
          requestHash: outcome.requestHash,
          expiresAt: outcome.expiresAt,
          ...(outcome.deepLink === undefined ? {} : { deepLink: outcome.deepLink }),
        },
      });
    case 'ERROR':
      return finishRefundDisputeJourney({
        ...journey,
        stateName: 'REQUEST_DENIED',
        terminal: true,
        error: outcome,
      });
    default: {
      const exhaustive: never = outcome;
      throw new JourneyContractError(`unhandled refund/dispute outcome: ${String(exhaustive)}`);
    }
  }
}

/** Dispatch the refund/dispute request through the API and fold the response. */
export async function submitRefundDisputeRequest(
  session: JourneySession,
  journey: RefundDisputeJourney,
): Promise<{ readonly journey: RefundDisputeJourney; readonly response: ApiResponse }> {
  const actionId = journey.kind === 'REFUND' ? 'submit-refund-request' : 'submit-dispute-request';
  const action = journey.actions.find((candidate) => candidate.actionId === actionId);
  if (action === undefined || !action.available || action.apiCommand === undefined) {
    throw new JourneyContractError(`${actionId} is not available in this state`);
  }
  const response = await dispatchJourneyCommand(session, action.apiCommand);
  return { journey: applyRefundDisputeResponse(journey, response), response };
}

/** Fold: withdraw the request before submission. */
export function withdrawRequest(journey: RefundDisputeJourney): RefundDisputeJourney {
  return finishRefundDisputeJourney({ ...journey, stateName: 'REQUEST_WITHDRAWN', terminal: true });
}

// ---------------------------------------------------------------------------
// Journey 6 — off-network payment recording
// ---------------------------------------------------------------------------

export type RecordOffNetworkStateName =
  | 'ENTERING_DETAILS'
  | 'RECORDED'
  | 'RECONCILING'
  | 'RECONCILED'
  | 'DISCREPANT';

export interface RecordOffNetworkJourney {
  readonly journeyId: 'record-off-network-payment';
  readonly stateName: RecordOffNetworkStateName;
  readonly terminal: boolean;
  readonly record?: OffNetworkPaymentRecord;
  /** Structural attribution marker: an off-network record is NEVER PaySwap-executed. */
  readonly attributedToPaySwap?: false;
  readonly actions: readonly ViewAction[];
}

function offNetworkActions(journey: Omit<RecordOffNetworkJourney, 'actions'>): readonly ViewAction[] {
  const actions: ViewAction[] = [];
  const base = { authorityRef: journey.record?.id ?? 'off-network-draft' };
  switch (journey.stateName) {
    case 'ENTERING_DETAILS':
      actions.push({
        actionId: 'submit-off-network-details',
        label: 'Record the off-network payment',
        kind: 'NAVIGATION',
        ...base,
        available: true,
      });
      actions.push({
        actionId: 'view-attribution-note',
        label: 'Read what an off-network record means (never PaySwap-executed)',
        kind: 'EVIDENCE_VIEW',
        ...base,
        available: true,
      });
      break;
    case 'RECORDED':
      actions.push({
        actionId: 'begin-reconciliation',
        label: 'Begin reconciliation against external evidence',
        kind: 'AUTHORITY_TRANSITION',
        ...base,
        available: true,
        authorityEvent: {
          domain: 'OFF_NETWORK_RECORD',
          authorityId: journey.record?.id ?? 'off-network-draft',
          event: 'RECONCILING',
        },
      });
      actions.push({
        actionId: 'record-off-network-intent',
        label: 'Record the off-network payment as a protocol command',
        kind: 'API_COMMAND',
        ...base,
        available: true,
        apiCommand: {
          method: 'POST',
          path: '/v1/intents',
          body: {
            commandType: 'payments.off-network.record',
            ...(journey.record === undefined ? {} : { correlationId: journey.record.id }),
          },
        },
      });
      actions.push({
        actionId: 'view-attribution-note',
        label: 'View the attribution note (external party, never PaySwap execution)',
        kind: 'EVIDENCE_VIEW',
        ...base,
        available: true,
      });
      break;
    case 'RECONCILING':
      actions.push({
        actionId: 'resolve-reconciliation',
        label: 'Resolve the reconciliation (reconciled or discrepant)',
        kind: 'AUTHORITY_TRANSITION',
        ...base,
        available: true,
        authorityEvent: {
          domain: 'OFF_NETWORK_RECORD',
          authorityId: journey.record?.id ?? 'off-network-draft',
          event: 'RESOLVE',
        },
      });
      actions.push({
        actionId: 'view-recorded-evidence',
        label: 'View the recorded evidence',
        kind: 'EVIDENCE_VIEW',
        ...base,
        available: journey.record !== undefined && journey.record.evidence.length > 0,
        ...(journey.record !== undefined && journey.record.evidence.length > 0
          ? {}
          : { unavailableReason: 'no evidence attached yet' }),
      });
      break;
    case 'RECONCILED':
      actions.push({
        actionId: 'view-reconciled-record',
        label: 'View the reconciled record',
        kind: 'EVIDENCE_VIEW',
        ...base,
        available: true,
      });
      break;
    case 'DISCREPANT':
      actions.push({
        actionId: 'investigate-discrepancy',
        label: 'Investigate the discrepancy and re-reconcile',
        kind: 'AUTHORITY_TRANSITION',
        ...base,
        available: true,
        authorityEvent: {
          domain: 'OFF_NETWORK_RECORD',
          authorityId: journey.record?.id ?? 'off-network-draft',
          event: 'RECONCILING',
        },
      });
      actions.push({
        actionId: 'view-discrepancy-evidence',
        label: 'View the disagreeing evidence',
        kind: 'EVIDENCE_VIEW',
        ...base,
        available: true,
      });
      break;
    default: {
      const exhaustive: never = journey.stateName;
      throw new ViewContractError(`unhandled off-network state: ${String(exhaustive)}`);
    }
  }
  return Object.freeze(actions);
}

function finishOffNetworkJourney(
  journey: Omit<RecordOffNetworkJourney, 'actions'>,
): RecordOffNetworkJourney {
  return Object.freeze({ ...journey, actions: offNetworkActions(journey) });
}

/** Begin recording an off-network payment. */
export function beginRecordOffNetworkPayment(): RecordOffNetworkJourney {
  return finishOffNetworkJourney({
    journeyId: 'record-off-network-payment',
    stateName: 'ENTERING_DETAILS',
    terminal: false,
  });
}

/**
 * Fold: record the off-network payment. Runs the AUTHORITY constructor
 * (`recordOffNetworkPayment`, W1-003 — sets `orchestratedBy:
 * 'EXTERNAL_PARTY'` structurally) and ingests it through @payswap/execution
 * (`ingestOffNetworkPaymentRecord`), whose result carries the structural
 * `attributedToPaySwap: false` marker.
 */
export function submitOffNetworkDetails(
  journey: RecordOffNetworkJourney,
  input: {
    readonly id: string;
    readonly source: 'CHECK' | 'CASH' | 'EXTERNAL_BANK_TRANSFER' | 'OTHER_EXTERNAL';
    readonly reporter: string;
    readonly amount: OffNetworkPaymentRecord['amount'];
    readonly externalRef: string;
    readonly evidence: readonly OffNetworkEvidenceRef[];
    readonly reconciliationState?: OffNetworkReconciliationState;
    readonly businessDocumentRefs: readonly { readonly documentKind: string; readonly documentId: string }[];
    readonly recordedAt: bigint;
  },
): RecordOffNetworkJourney {
  if (journey.stateName !== 'ENTERING_DETAILS') {
    throw new JourneyContractError('off-network details can only be submitted in ENTERING_DETAILS');
  }
  const record = recordOffNetworkPayment({
    id: input.id,
    source: input.source,
    reporter: input.reporter,
    amount: input.amount,
    externalRef: input.externalRef,
    evidence: input.evidence,
    reconciliationState: input.reconciliationState ?? 'UNRECONCILED',
    businessDocumentRefs: input.businessDocumentRefs,
    recordedAt: input.recordedAt,
  });
  const ingested = ingestOffNetworkPaymentRecord(record);
  return finishOffNetworkJourney({
    ...journey,
    stateName: 'RECORDED',
    record,
    attributedToPaySwap: ingested.attributedToPaySwap,
  });
}

/**
 * Fold the off-network reconciliation state through the AUTHORITY machine
 * (`advanceReconciliation`, W1-003 — UNRECONCILED → RECONCILING →
 * RECONCILED, or → DISCREPANT; terminal states do not silently rewrite).
 */
export function advanceOffNetworkReconciliation(
  journey: RecordOffNetworkJourney,
  next: 'RECONCILING' | 'RECONCILED' | 'DISCREPANT',
): RecordOffNetworkJourney {
  if (journey.record === undefined) {
    throw new JourneyContractError('off-network reconciliation requires a recorded payment');
  }
  const record = advanceReconciliation(journey.record, next);
  return finishOffNetworkJourney({
    ...journey,
    record,
    stateName: next,
    terminal: next === 'RECONCILED',
  });
}

/** Dispatch the off-network recording intent through the API. */
export async function recordOffNetworkIntent(
  session: JourneySession,
  journey: RecordOffNetworkJourney,
): Promise<ApiResponse> {
  const action = journey.actions.find((candidate) => candidate.actionId === 'record-off-network-intent');
  if (action === undefined || !action.available || action.apiCommand === undefined) {
    throw new JourneyContractError('record-off-network-intent is not available in this state');
  }
  return dispatchJourneyCommand(session, action.apiCommand);
}

// ---------------------------------------------------------------------------
// The journey state table (no-dead-buttons contract)
// ---------------------------------------------------------------------------

export type PaymentJourney =
  | ChooseOrDelegateJourney
  | SwitchOrFallbackJourney
  | MandateManagementJourney
  | ReconcileDocumentsJourney
  | RefundDisputeJourney
  | RecordOffNetworkJourney;

export type PaymentJourneyId = PaymentJourney['journeyId'];

export interface JourneyStateSpecEntry {
  readonly stateName: string;
  readonly terminal: boolean;
}

export interface JourneyStateSpec {
  readonly journeyId: PaymentJourneyId;
  readonly states: readonly JourneyStateSpecEntry[];
}

/**
 * The declared state table of every payment journey. The no-dead-buttons test
 * drives each journey through its states and cross-checks: (a) the driven
 * states match this table exactly; (b) no NON-TERMINAL state has zero
 * available actions.
 */
export const PAYMENT_JOURNEY_STATES: readonly JourneyStateSpec[] = Object.freeze([
  {
    journeyId: 'choose-or-delegate-payment',
    states: Object.freeze([
      { stateName: 'CHOOSING_METHOD', terminal: false },
      { stateName: 'REVIEWING_TERMS', terminal: false },
      { stateName: 'AWAITING_APPROVAL', terminal: false },
      { stateName: 'DELEGATED_TO_AGENT', terminal: false },
      { stateName: 'AWAITING_DELEGATION_APPROVAL', terminal: false },
      { stateName: 'DELEGATION_READY', terminal: false },
      { stateName: 'SUBMITTED', terminal: true },
      { stateName: 'AUTHORIZATION_ERROR', terminal: false },
      { stateName: 'ABANDONED', terminal: true },
    ]),
  },
  {
    journeyId: 'switch-or-fallback-payment',
    states: Object.freeze([
      { stateName: 'EVALUATING_SWITCH', terminal: false },
      { stateName: 'REAUTHORIZATION_REQUIRED', terminal: false },
      { stateName: 'AWAITING_FALLBACK_APPROVAL', terminal: false },
      { stateName: 'SWITCHED', terminal: true },
      { stateName: 'SWITCH_DECLINED', terminal: true },
    ]),
  },
  {
    journeyId: 'manage-recurring-mandate',
    states: Object.freeze([
      { stateName: 'VIEWING_MANDATE', terminal: false },
      { stateName: 'MANDATE_EVENT_RECORDED', terminal: false },
      { stateName: 'AWAITING_NEW_MANDATE_APPROVAL', terminal: false },
    ]),
  },
  {
    journeyId: 'reconcile-invoice-order-project',
    states: Object.freeze([
      { stateName: 'ALLOCATING', terminal: false },
      { stateName: 'ALLOCATION_MISMATCH', terminal: false },
      { stateName: 'ALLOCATED', terminal: true },
    ]),
  },
  {
    journeyId: 'initiate-refund-or-dispute',
    states: Object.freeze([
      { stateName: 'CONFIRMING', terminal: false },
      { stateName: 'REQUEST_SUBMITTED', terminal: true },
      { stateName: 'REQUEST_DENIED', terminal: true },
      { stateName: 'BLOCKED_BY_POLICY', terminal: false },
      { stateName: 'ELIGIBILITY_UNKNOWN', terminal: false },
      { stateName: 'REQUEST_WITHDRAWN', terminal: true },
    ]),
  },
  {
    journeyId: 'record-off-network-payment',
    states: Object.freeze([
      { stateName: 'ENTERING_DETAILS', terminal: false },
      { stateName: 'RECORDED', terminal: false },
      { stateName: 'RECONCILING', terminal: false },
      { stateName: 'RECONCILED', terminal: true },
      { stateName: 'DISCREPANT', terminal: false },
    ]),
  },
]);

/**
 * The no-dead-buttons check for ONE journey state: a state must declare at
 * least one AVAILABLE action unless it is terminally complete. (Every state
 * in this contract keeps at least one available action even when terminal —
 * history/evidence views — but the hard rule is the non-terminal one.)
 */
export function journeyStateHasLiveActions(journey: PaymentJourney): boolean {
  return journey.actions.some((action) => action.available);
}

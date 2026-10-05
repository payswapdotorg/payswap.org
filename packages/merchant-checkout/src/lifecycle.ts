/**
 * @payswap/merchant-checkout — payment lifecycle (P4-W2-003 §3.5).
 *
 * PaymentAttempt lineage over the canonical primitives: every record wraps
 * the landed @payswap/merchant-crypto attempt machine (PENDING → SUBMITTED
 * → CONFIRMED/FAILED/OUTCOME_UNKNOWN, evidence-mandatory definitive
 * outcomes, reconciliation as the only UNKNOWN exit) and the landed intent
 * machine. Laws:
 *
 * - ACCEPTANCE LAW (structural): a wallet payment attempt CANNOT exist
 *   without its explicit customer authorization lineage
 *   (`WalletAuthorizationLineage` from payment.ts) — the composite record
 *   type requires it, so "authorization-without-explicit-signing" is
 *   unrepresentable;
 * - UNKNOWN is preserved (INV-X01): OUTCOME_UNKNOWN is never collapsed to
 *   FAILED or SUCCESS; leaving it requires a reconciliation resolution
 *   (INV-X03) through the settlement plane's UnknownOutcomeResolution;
 * - blind-retry forbidden (INV-X02): there is NO resubmit function — a
 *   re-observe is a new observation over the same immutable history
 *   (`recordAmbiguityEvidence` appends evidence linkage without a state
 *   change);
 * - every definitive outcome carries evidence (INV-E02, enforced by the
 *   landed helpers).
 *
 * Deterministic only: every operation takes an explicit `now`.
 */

import { ValidationError } from "@payswap/protocol";
import type { TimestampMs } from "@payswap/protocol";
import type { PaymentMethodTranslation } from "@payswap/payment";
import type { UnknownOutcomeResolution } from "@payswap/settlement";
import {
  abandonMerchantPaymentAttempt,
  attachSettlement,
  attachSettlementRoute,
  attachSubmission,
  attachTranslation,
  beginMerchantPaymentAttempt,
  confirmMerchantPaymentAttemptFailed,
  confirmMerchantPaymentAttemptSucceeded,
  merchantPaymentAttemptStateMachine,
  merchantPaymentIntentStateMachine,
  reportMerchantPaymentAttemptUnknown,
  resolveMerchantPaymentAttemptUnknown,
  submitMerchantPaymentAttempt,
} from "@payswap/merchant-crypto";
import type {
  MerchantCryptoSettlementRoute,
  MerchantPaymentAttempt,
  MerchantPaymentAttemptState,
  MerchantPaymentIntent,
  MerchantPaymentIntentState,
} from "@payswap/merchant-crypto";
import type { WalletAuthorizationLineage } from "./payment.js";

/**
 * A checkout payment attempt: the canonical MerchantPaymentAttempt PLUS
 * the mandatory explicit customer authorization lineage. The lineage is
 * REQUIRED by the type — a wallet payment without it is structurally
 * unrepresentable.
 */
export interface CheckoutPaymentAttempt {
  readonly attempt: MerchantPaymentAttempt;
  readonly authorization: WalletAuthorizationLineage;
}

/** Validate a lineage record (fail-closed). */
function requireLineage(
  lineage: WalletAuthorizationLineage,
  label: string,
): void {
  if (
    lineage === null ||
    typeof lineage !== "object" ||
    typeof lineage.authorizationRequestHash !== "string" ||
    lineage.authorizationRequestHash.length === 0 ||
    typeof lineage.writeDigest !== "string" ||
    lineage.writeDigest.length === 0 ||
    typeof lineage.paymentSummaryDigest !== "string" ||
    lineage.paymentSummaryDigest.length === 0 ||
    typeof lineage.signingRequestId !== "string" ||
    lineage.signingRequestId.length === 0 ||
    typeof lineage.externalSubmissionRef !== "string" ||
    lineage.externalSubmissionRef.length === 0 ||
    !Array.isArray(lineage.evidenceRefs) ||
    lineage.evidenceRefs.length === 0
  ) {
    throw new ValidationError(`${label} requires a WalletAuthorizationLineage`, {
      reason:
        "a payment without explicit customer authorization lineage is structurally unrepresentable",
    });
  }
}

function requireIntent(intent: MerchantPaymentIntent): void {
  if (intent === null || typeof intent !== "object" || typeof intent.id !== "string" || intent.id.length === 0) {
    throw new ValidationError("the operation requires a MerchantPaymentIntent");
  }
}

function requireNow(now: TimestampMs): void {
  if (typeof now !== "bigint") {
    throw new ValidationError("now must be a bigint TimestampMs");
  }
}

/**
 * Attach the selected payment method to the intent (the customer chose an
 * option): REQUIRES_PAYMENT_METHOD → REQUIRES_CONFIRMATION through the
 * landed intent machine. Returns a NEW frozen intent record.
 */
export function attachMethodToIntent(
  intent: MerchantPaymentIntent,
  now: TimestampMs,
): MerchantPaymentIntent {
  requireIntent(intent);
  requireNow(now);
  const record = merchantPaymentIntentStateMachine.transition(
    intent.state,
    "ATTACH_METHOD",
    { now, expiresAt: intent.expiresAt },
  );
  return Object.freeze({ ...intent, state: record.to as MerchantPaymentIntentState });
}

/**
 * Confirm the intent (the wallet payment was authorized and submitted at
 * the trusted surface): REQUIRES_CONFIRMATION → PROCESSING. Returns a NEW
 * frozen intent record.
 */
export function confirmIntentSubmission(
  intent: MerchantPaymentIntent,
  now: TimestampMs,
): MerchantPaymentIntent {
  requireIntent(intent);
  requireNow(now);
  const record = merchantPaymentIntentStateMachine.transition(intent.state, "CONFIRM", {
    now,
    expiresAt: intent.expiresAt,
  });
  return Object.freeze({ ...intent, state: record.to as MerchantPaymentIntentState });
}

/**
 * Submit a wallet payment attempt: begins the canonical attempt under the
 * option's quote (which must be unexpired), submits it, attaches the
 * external submission reference from the authorization lineage, and binds
 * the lineage to the composite record. This is the ONLY attempt-submission
 * path in the package — there is no resubmit (blind-retry forbidden,
 * INV-X02; the landed machine's SUBMIT transition exists only from
 * PENDING).
 */
export function submitWalletPaymentAttempt(input: {
  readonly attemptId: string;
  readonly intent: MerchantPaymentIntent;
  readonly quote: import("@payswap/merchant-crypto").CryptoQuote;
  readonly authorization: WalletAuthorizationLineage;
  readonly now: TimestampMs;
}): CheckoutPaymentAttempt {
  if (typeof input.attemptId !== "string" || input.attemptId.length === 0) {
    throw new ValidationError("attemptId must be a non-empty string");
  }
  requireIntent(input.intent);
  requireNow(input.now);
  requireLineage(input.authorization, "submitWalletPaymentAttempt");
  if (input.authorization.chainRef !== input.quote.chainId) {
    throw new ValidationError(
      "the authorized chain must be the chain the quote was accepted on",
      {
        authorizedChain: input.authorization.chainRef,
        quoteChain: input.quote.chainId,
      },
    );
  }
  const pending = beginMerchantPaymentAttempt({
    id: input.attemptId,
    intent: input.intent,
    quote: input.quote,
    now: input.now,
  });
  const submitted = submitMerchantPaymentAttempt(pending, input.quote, input.now);
  const withSubmission = attachSubmission(submitted, {
    externalTxRef: input.authorization.externalSubmissionRef,
    now: input.now,
  });
  return Object.freeze({
    attempt: withSubmission,
    authorization: input.authorization,
  });
}

/** Abandon a PENDING attempt (never a submitted one — the machine's law). */
export function abandonCheckoutAttempt(
  record: CheckoutPaymentAttempt,
  now: TimestampMs,
): CheckoutPaymentAttempt {
  if (record === null || typeof record !== "object") {
    throw new ValidationError("abandonCheckoutAttempt requires a CheckoutPaymentAttempt");
  }
  requireNow(now);
  const abandoned = abandonMerchantPaymentAttempt(record.attempt, now);
  return Object.freeze({ ...record, attempt: abandoned });
}

/**
 * Attach the settlement route this attempt settles through
 * (discrimination-checked by the landed helper). Only legal on SUBMITTED
 * or CONFIRMED attempts.
 */
export function attachAttemptSettlementRoute(
  record: CheckoutPaymentAttempt,
  route: MerchantCryptoSettlementRoute,
  now: TimestampMs,
): CheckoutPaymentAttempt {
  if (record === null || typeof record !== "object") {
    throw new ValidationError("attachAttemptSettlementRoute requires a CheckoutPaymentAttempt");
  }
  requireNow(now);
  const attempt = attachSettlementRoute(record.attempt, route, now);
  return Object.freeze({ ...record, attempt });
}

/** Attach the canonical PaymentMethodTranslation realizing this attempt. */
export function attachAttemptTranslation(
  record: CheckoutPaymentAttempt,
  translation: PaymentMethodTranslation,
  now: TimestampMs,
): CheckoutPaymentAttempt {
  if (record === null || typeof record !== "object") {
    throw new ValidationError("attachAttemptTranslation requires a CheckoutPaymentAttempt");
  }
  requireNow(now);
  const attempt = attachTranslation(record.attempt, translation, now);
  return Object.freeze({ ...record, attempt });
}

/** Attach the protocol settlement mapping (only on a CONFIRMED attempt). */
export function attachAttemptSettlement(
  record: CheckoutPaymentAttempt,
  input: {
    readonly settlementInstructionId: string;
    readonly settlementAttemptIds: readonly string[];
    readonly now: TimestampMs;
  },
): CheckoutPaymentAttempt {
  if (record === null || typeof record !== "object") {
    throw new ValidationError("attachAttemptSettlement requires a CheckoutPaymentAttempt");
  }
  const attempt = attachSettlement(record.attempt, input);
  return Object.freeze({ ...record, attempt });
}

/** One externally-observed outcome of a submitted attempt. */
export type AttemptOutcomeObservation =
  | { readonly kind: "SUCCEEDED"; readonly evidenceIds: readonly string[]; readonly externalTxRef?: string; readonly translation?: PaymentMethodTranslation }
  | { readonly kind: "FAILED"; readonly evidenceIds: readonly string[] }
  | { readonly kind: "OUTCOME_UNKNOWN"; readonly evidenceIds: readonly string[] };

/**
 * Observe the outcome of a SUBMITTED attempt. Definitive outcomes REQUIRE
 * evidence (INV-E02, enforced by the landed helpers); UNKNOWN is
 * first-class and preserved verbatim (INV-X01) — never converted into
 * FAILED or SUCCESS. Returns a NEW frozen record.
 */
export function observeAttemptOutcome(
  record: CheckoutPaymentAttempt,
  observation: AttemptOutcomeObservation,
  now: TimestampMs,
): CheckoutPaymentAttempt {
  if (record === null || typeof record !== "object") {
    throw new ValidationError("observeAttemptOutcome requires a CheckoutPaymentAttempt");
  }
  if (
    observation === null ||
    typeof observation !== "object" ||
    (observation.kind !== "SUCCEEDED" &&
      observation.kind !== "FAILED" &&
      observation.kind !== "OUTCOME_UNKNOWN")
  ) {
    throw new ValidationError("an outcome observation must be typed SUCCEEDED/FAILED/OUTCOME_UNKNOWN");
  }
  requireNow(now);
  let attempt: MerchantPaymentAttempt;
  switch (observation.kind) {
    case "SUCCEEDED":
      attempt = confirmMerchantPaymentAttemptSucceeded(record.attempt, {
        evidenceIds: observation.evidenceIds,
        ...(observation.externalTxRef !== undefined
          ? { externalTxRef: observation.externalTxRef }
          : {}),
        ...(observation.translation !== undefined
          ? { translation: observation.translation }
          : {}),
        now,
      });
      break;
    case "FAILED":
      attempt = confirmMerchantPaymentAttemptFailed(record.attempt, {
        evidenceIds: observation.evidenceIds,
        now,
      });
      break;
    default:
      attempt = reportMerchantPaymentAttemptUnknown(record.attempt, {
        evidenceIds: observation.evidenceIds,
        now,
      });
      break;
  }
  return Object.freeze({ ...record, attempt });
}

/**
 * A re-observe of an ambiguous attempt: appends NEW evidence linkage to an
 * OUTCOME_UNKNOWN attempt WITHOUT any state change — a re-observe is a new
 * observation, never a mutation of history and never a blind retry
 * (INV-X02). The attempt stays OUTCOME_UNKNOWN until a reconciliation
 * resolution arrives.
 */
export function recordAmbiguityEvidence(
  record: CheckoutPaymentAttempt,
  evidenceIds: readonly string[],
  now: TimestampMs,
): CheckoutPaymentAttempt {
  if (record === null || typeof record !== "object") {
    throw new ValidationError("recordAmbiguityEvidence requires a CheckoutPaymentAttempt");
  }
  requireNow(now);
  if (
    !Array.isArray(evidenceIds) ||
    evidenceIds.length === 0 ||
    !evidenceIds.every((id) => typeof id === "string" && id.length > 0)
  ) {
    throw new ValidationError(
      "an ambiguity re-observation requires non-empty evidence ids — the observation itself is evidence",
    );
  }
  if (record.attempt.state !== "OUTCOME_UNKNOWN") {
    throw new ValidationError(
      "ambiguity evidence can only be recorded on an OUTCOME_UNKNOWN attempt",
      { attemptId: record.attempt.id, state: record.attempt.state },
    );
  }
  const merged = [...record.attempt.evidenceIds];
  for (const id of evidenceIds) {
    if (!merged.includes(id)) {
      merged.push(id);
    }
  }
  const attempt = Object.freeze({
    ...record.attempt,
    evidenceIds: Object.freeze(merged),
    updatedAt: now,
  });
  return Object.freeze({ ...record, attempt });
}

/**
 * Resolve an OUTCOME_UNKNOWN attempt through a reconciliation resolution
 * (INV-X03 — the ONLY exit from ambiguity). The resolution is the
 * settlement plane's own `UnknownOutcomeResolution`, consumed verbatim;
 * its evidence ids are mandatory and merged. Returns a NEW frozen record.
 */
export function resolveAttemptUnknown(
  record: CheckoutPaymentAttempt,
  resolution: UnknownOutcomeResolution,
  now: TimestampMs,
): CheckoutPaymentAttempt {
  if (record === null || typeof record !== "object") {
    throw new ValidationError("resolveAttemptUnknown requires a CheckoutPaymentAttempt");
  }
  requireNow(now);
  const attempt = resolveMerchantPaymentAttemptUnknown(record.attempt, resolution, now);
  return Object.freeze({ ...record, attempt });
}

/**
 * Project the attempt's outcome onto the intent machine: PROCESSING →
 * SUCCEEDED / FAILED / OUTCOME_UNKNOWN (or the reconciliation resolutions
 * from OUTCOME_UNKNOWN). The attempt's state is the authority for which
 * intent event is legal; evidence ids are mandatory and carried on the
 * composite record. Returns a NEW frozen intent.
 */
export function settleIntentOutcome(
  intent: MerchantPaymentIntent,
  record: CheckoutPaymentAttempt,
  input: { readonly evidenceIds: readonly string[]; readonly now: TimestampMs },
): MerchantPaymentIntent {
  requireIntent(intent);
  if (record === null || typeof record !== "object") {
    throw new ValidationError("settleIntentOutcome requires a CheckoutPaymentAttempt");
  }
  requireNow(input.now);
  if (
    !Array.isArray(input.evidenceIds) ||
    input.evidenceIds.length === 0 ||
    !input.evidenceIds.every((id) => typeof id === "string" && id.length > 0)
  ) {
    throw new ValidationError(
      "an intent outcome transition requires non-empty evidence ids (INV-E02)",
    );
  }
  const attemptState: MerchantPaymentAttemptState = record.attempt.state;
  let event: import("@payswap/merchant-crypto").MerchantPaymentIntentEvent;
  switch (attemptState) {
    case "CONFIRMED":
      event = "CONFIRM_SUCCEEDED";
      break;
    case "FAILED":
      event = "CONFIRM_FAILED";
      break;
    case "OUTCOME_UNKNOWN":
      event = "REPORT_UNKNOWN";
      break;
    default:
      throw new ValidationError(
        "the intent can only be settled from a definitive or ambiguous attempt outcome (SUBMITTED attempts are still PROCESSING)",
        { attemptId: record.attempt.id, attemptState },
      );
  }
  const transitionRecord = merchantPaymentIntentStateMachine.transition(intent.state, event, {
    now: input.now,
    expiresAt: intent.expiresAt,
  });
  return Object.freeze({
    ...intent,
    state: transitionRecord.to as MerchantPaymentIntentState,
  });
}

/**
 * Resolve the INTENT's ambiguity through a reconciliation resolution
 * (INV-X03): OUTCOME_UNKNOWN → SUCCEEDED or FAILED. Only legal while the
 * intent is OUTCOME_UNKNOWN and the attempt was resolved the same way.
 */
export function resolveIntentUnknown(
  intent: MerchantPaymentIntent,
  record: CheckoutPaymentAttempt,
  resolution: UnknownOutcomeResolution,
  now: TimestampMs,
): MerchantPaymentIntent {
  requireIntent(intent);
  if (record === null || typeof record !== "object") {
    throw new ValidationError("resolveIntentUnknown requires a CheckoutPaymentAttempt");
  }
  requireNow(now);
  const event =
    resolution.resolvedOutcome === "CONFIRMED_SUCCEEDED"
      ? ("RESOLVE_SUCCEEDED" as const)
      : ("RESOLVE_FAILED" as const);
  const consistent =
    (event === "RESOLVE_SUCCEEDED" && record.attempt.state === "CONFIRMED") ||
    (event === "RESOLVE_FAILED" && record.attempt.state === "FAILED");
  if (!consistent) {
    throw new ValidationError(
      "the intent resolution must match the attempt's reconciled outcome",
      { intentState: intent.state, attemptState: record.attempt.state, resolvedOutcome: resolution.resolvedOutcome },
    );
  }
  const transitionRecord = merchantPaymentIntentStateMachine.transition(intent.state, event, {
    now,
    expiresAt: intent.expiresAt,
  });
  return Object.freeze({
    ...intent,
    state: transitionRecord.to as MerchantPaymentIntentState,
  });
}

/**
 * Deterministic read-only status projection over one attempt (used by the
 * status views and the webhook layer): the canonical outcome on the
 * settlement plane's definiteness dimension.
 */
export function attemptStatusView(
  record: CheckoutPaymentAttempt,
): {
  readonly attemptId: string;
  readonly state: MerchantPaymentAttemptState;
  readonly outcome: "PENDING" | "SUCCEEDED" | "FAILED" | "OUTCOME_UNKNOWN";
  readonly evidenceIds: readonly string[];
  readonly authorizationRequestHash: string;
} {
  if (record === null || typeof record !== "object") {
    throw new ValidationError("attemptStatusView requires a CheckoutPaymentAttempt");
  }
  const state = record.attempt.state;
  const outcome =
    state === "CONFIRMED"
      ? ("SUCCEEDED" as const)
      : state === "FAILED"
        ? ("FAILED" as const)
        : state === "OUTCOME_UNKNOWN"
          ? ("OUTCOME_UNKNOWN" as const)
          : ("PENDING" as const);
  return Object.freeze({
    attemptId: record.attempt.id,
    state,
    outcome,
    evidenceIds: Object.freeze([...record.attempt.evidenceIds]),
    authorizationRequestHash: record.authorization.authorizationRequestHash,
  });
}

/** Whether the attempt machine allows an outcome observation in this state. */
export function attemptMayObserveOutcome(record: CheckoutPaymentAttempt): boolean {
  if (record === null || typeof record !== "object") {
    throw new ValidationError("attemptMayObserveOutcome requires a CheckoutPaymentAttempt");
  }
  return (
    merchantPaymentAttemptStateMachine.canTransition(record.attempt.state, "CONFIRM_SUCCEEDED") ||
    merchantPaymentAttemptStateMachine.canTransition(record.attempt.state, "CONFIRM_FAILED") ||
    merchantPaymentAttemptStateMachine.canTransition(record.attempt.state, "REPORT_UNKNOWN")
  );
}

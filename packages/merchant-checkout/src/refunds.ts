/**
 * @payswap/merchant-checkout — refunds (P4-W2-003 §3.7).
 *
 * Refund initiation ONLY where the underlying rail supports refunds: the
 * support fact arrives as a TYPED RAIL CAPABILITY OBSERVATION
 * (`RailRefundSupportObservation`) scoped to the actual rail — for the
 * native Stripe family, to the ACTUAL connected instance (AGENTS.md rule
 * 18: a ProviderCatalogueEntry is rejected with ConnectorAuthorityError);
 * for the external family, to the reachable conversion chain. Unsupported
 * rails answer with the typed NOT_SUPPORTED outcome — never a silent
 * rejection, never an implied future support.
 *
 * Refund lifecycle mirrors the payment lifecycle laws: evidence-mandatory
 * definitive outcomes (INV-E02), UNKNOWN preserved (INV-X01) with
 * reconciliation the only exit (INV-X03), terminal monotonicity (INV-X04),
 * and IMMUTABLE ORIGINALS — a refund references its original attempt by id
 * and never rewrites it; the recourse vocabulary is the payment
 * primitives' own RecoursePolicyKind, consumed verbatim.
 *
 * The native-family refund semantics follow the Stripe research law:
 * refunds are returned as stablecoins to the customer's original wallet
 * (never fiat), partial refunds are supported, and there is no
 * chargeback/dispute path to inherit.
 */

import { ValidationError, defineStateMachine } from "@payswap/protocol";
import type { Money, StateMachine, TimestampMs } from "@payswap/protocol";
import type { RecoursePolicyKind } from "@payswap/payment";
import type { ConnectedCapabilityInstance } from "@payswap/connectors";
import { assertConnectedInstance } from "@payswap/connectors";
import { assertNoSecretMaterial } from "@payswap/onchain-security";
import type { CryptoAmount } from "@payswap/merchant-crypto";
import type { UnknownOutcomeResolution } from "@payswap/settlement";
import type { CheckoutPaymentAttempt } from "./lifecycle.js";

declare const RefundIdBrand: unique symbol;

/** Branded id of one refund. */
export type RefundId = string & { readonly [RefundIdBrand]: "RefundId" };

/** Refund lifecycle states. */
export type RefundState = "PENDING" | "SUBMITTED" | "CONFIRMED" | "FAILED" | "OUTCOME_UNKNOWN";

/** Events the refund machine declares. */
export type RefundEvent =
  | "SUBMIT"
  | "CONFIRM_SUCCEEDED"
  | "CONFIRM_FAILED"
  | "REPORT_UNKNOWN"
  | "RESOLVE_SUCCEEDED"
  | "RESOLVE_FAILED";

/**
 * The deterministic refund lifecycle machine — the payment-attempt law
 * mirrored: SUBMITTED only from PENDING; definitive outcomes only from
 * SUBMITTED; OUTCOME_UNKNOWN is first-class NON-TERMINAL with
 * reconciliation resolutions as its ONLY exits (INV-X01/X03); terminal
 * states monotonic (INV-X04).
 */
export const refundStateMachine: StateMachine<RefundState, RefundEvent, unknown> =
  defineStateMachine<RefundState, RefundEvent, unknown>({
    name: "merchant-checkout-refund",
    initial: "PENDING",
    states: ["PENDING", "SUBMITTED", "CONFIRMED", "FAILED", "OUTCOME_UNKNOWN"],
    events: [
      "SUBMIT",
      "CONFIRM_SUCCEEDED",
      "CONFIRM_FAILED",
      "REPORT_UNKNOWN",
      "RESOLVE_SUCCEEDED",
      "RESOLVE_FAILED",
    ],
    transitions: [
      { from: "PENDING", on: "SUBMIT", to: "SUBMITTED", description: "submitted to the rail" },
      { from: "SUBMITTED", on: "CONFIRM_SUCCEEDED", to: "CONFIRMED", description: "definitive success observed with evidence (INV-E02)" },
      { from: "SUBMITTED", on: "CONFIRM_FAILED", to: "FAILED", description: "definitive failure observed with evidence (INV-E02)" },
      { from: "SUBMITTED", on: "REPORT_UNKNOWN", to: "OUTCOME_UNKNOWN", description: "ambiguous outcome — UNKNOWN preserved (INV-X01)" },
      { from: "OUTCOME_UNKNOWN", on: "RESOLVE_SUCCEEDED", to: "CONFIRMED", description: "reconciliation resolved as success (INV-X03)" },
      { from: "OUTCOME_UNKNOWN", on: "RESOLVE_FAILED", to: "FAILED", description: "reconciliation resolved as failure (INV-X03)" },
    ],
    terminalStates: ["CONFIRMED", "FAILED"],
  });

/**
 * A TYPED rail capability observation of refund support, scoped to the
 * actual rail. For the native Stripe family the observation is bound to a
 * genuinely connected instance (INV-C05) and carries the research-pinned
 * semantics: stablecoins to the original wallet, partial supported, no
 * chargeback path.
 */
export interface RailRefundSupportObservation {
  readonly observationId: string;
  readonly routeFamily: "NATIVE_STRIPE_CRYPTO" | "EXTERNAL_PAYSWAP_CONVERSION";
  readonly supportsRefunds: boolean;
  readonly partialRefunds: boolean;
  /** How refunds return value (typed per family; present when supported). */
  readonly refundMedium?: "STABLECOIN_TO_ORIGINAL_WALLET" | "EXTERNAL_CONVERSION_RETURN";
  /** The Stripe research law: no chargeback/dispute path on native crypto acceptance. */
  readonly chargebackPathAvailable: boolean;
  readonly observedAt: TimestampMs;
  readonly evidenceRefs: readonly string[];
}

/** One refund of a confirmed payment attempt (originals are never mutated). */
export interface RefundRecord {
  readonly id: RefundId;
  readonly originalAttemptId: string;
  readonly intentId: string;
  /** Exact fiat refund amount (≤ the original payment, same currency). */
  readonly amount: Money;
  /** The exact refunded crypto amount, observed at submission when the rail reports it. */
  readonly refundedCryptoAmount?: CryptoAmount;
  readonly routeFamily: "NATIVE_STRIPE_CRYPTO" | "EXTERNAL_PAYSWAP_CONVERSION";
  readonly refundMedium: "STABLECOIN_TO_ORIGINAL_WALLET" | "EXTERNAL_CONVERSION_RETURN";
  /** The customer's original wallet (where value returns on the native family). */
  readonly destinationRef: string;
  /** The recourse vocabulary from the payment primitives, frozen at initiation. */
  readonly recourse: RecoursePolicyKind;
  readonly railObservationId: string;
  readonly state: RefundState;
  readonly evidenceIds: readonly string[];
  readonly createdAt: TimestampMs;
  readonly updatedAt: TimestampMs;
}

/** The typed result of a refund initiation. */
export type RefundInitiationResult =
  | { readonly outcome: "REFUND_STARTED"; readonly refund: RefundRecord }
  | {
      readonly outcome: "NOT_SUPPORTED";
      readonly routeFamily: "NATIVE_STRIPE_CRYPTO" | "EXTERNAL_PAYSWAP_CONVERSION";
      readonly reason: string;
    };

/** Brand a validated string as a `RefundId`. */
export function asRefundId(value: string): RefundId {
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError("RefundId must be a non-empty string", { value });
  }
  if (value.length > 256) {
    throw new ValidationError("RefundId exceeds 256 characters", { value });
  }
  if (value.trim() !== value) {
    throw new ValidationError("RefundId must not carry surrounding whitespace", { value });
  }
  return value as RefundId;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function requireEvidenceIds(evidenceIds: readonly string[], label: string): void {
  if (
    !Array.isArray(evidenceIds) ||
    evidenceIds.length === 0 ||
    !evidenceIds.every((id) => isNonEmptyString(id))
  ) {
    throw new ValidationError(label);
  }
}

/**
 * Observe refund support on the NATIVE Stripe crypto rail, scoped to the
 * ACTUAL connected instance (rule 18): a ProviderCatalogueEntry throws
 * ConnectorAuthorityError (INV-C05); an ineligible or inactive instance is
 * an honest NOT_SUPPORTED observation, never an error. The semantics are
 * pinned by the Stripe research: refunds always return as stablecoins to
 * the customer's original wallet; partial refunds supported; no
 * chargeback path.
 */
export function observeNativeStripeRefundSupport(input: {
  readonly observationId: string;
  readonly connectedInstance: ConnectedCapabilityInstance;
  readonly evidenceRefs: readonly string[];
  readonly observedAt: TimestampMs;
}): RailRefundSupportObservation {
  if (!isNonEmptyString(input.observationId)) {
    throw new ValidationError("an observation requires an observationId");
  }
  // INV-C05 / rule 18: only a genuinely connected instance, never a catalogue entry.
  assertConnectedInstance(input.connectedInstance);
  requireEvidenceIds(
    input.evidenceRefs,
    "a refund-support observation requires non-empty evidence refs",
  );
  if (typeof input.observedAt !== "bigint") {
    throw new ValidationError("observedAt must be a bigint TimestampMs");
  }
  const instance = input.connectedInstance;
  const eligible =
    instance.authorization.status === "ACTIVE" && instance.eligibility.eligible === true;
  const observation: RailRefundSupportObservation = Object.freeze({
    observationId: input.observationId,
    routeFamily: "NATIVE_STRIPE_CRYPTO",
    supportsRefunds: eligible,
    partialRefunds: eligible,
    ...(eligible ? { refundMedium: "STABLECOIN_TO_ORIGINAL_WALLET" as const } : {}),
    chargebackPathAvailable: false,
    observedAt: input.observedAt,
    evidenceRefs: Object.freeze([...input.evidenceRefs]),
  });
  assertNoSecretMaterial(observation, "native stripe refund support observation");
  return observation;
}

/**
 * Observe refund support on the EXTERNAL PaySwap conversion family:
 * supported exactly when the reachable conversion chain declares a return
 * path; the observation is evidence-backed and typed, never assumed.
 */
export function observeExternalConversionRefundSupport(input: {
  readonly observationId: string;
  readonly conversionChain: readonly string[];
  readonly supportsRefunds: boolean;
  readonly partialRefunds: boolean;
  readonly evidenceRefs: readonly string[];
  readonly observedAt: TimestampMs;
}): RailRefundSupportObservation {
  if (!isNonEmptyString(input.observationId)) {
    throw new ValidationError("an observation requires an observationId");
  }
  if (
    !Array.isArray(input.conversionChain) ||
    input.conversionChain.length === 0 ||
    !input.conversionChain.every((ref) => isNonEmptyString(ref))
  ) {
    throw new ValidationError(
      "the external-family observation must reference its conversion chain",
    );
  }
  requireEvidenceIds(
    input.evidenceRefs,
    "a refund-support observation requires non-empty evidence refs",
  );
  if (typeof input.observedAt !== "bigint") {
    throw new ValidationError("observedAt must be a bigint TimestampMs");
  }
  const observation: RailRefundSupportObservation = Object.freeze({
    observationId: input.observationId,
    routeFamily: "EXTERNAL_PAYSWAP_CONVERSION",
    supportsRefunds: input.supportsRefunds,
    partialRefunds: input.partialRefunds,
    ...(input.supportsRefunds
      ? { refundMedium: "EXTERNAL_CONVERSION_RETURN" as const }
      : {}),
    chargebackPathAvailable: false,
    observedAt: input.observedAt,
    evidenceRefs: Object.freeze([...input.evidenceRefs]),
  });
  assertNoSecretMaterial(observation, "external conversion refund support observation");
  return observation;
}

/**
 * Initiate a refund of a CONFIRMED payment attempt.
 *
 * - the attempt must be CONFIRMED (fail-closed — no refunding
 *   non-succeeded payments);
 * - the rail observation must declare refund support: an unsupported rail
 *   answers with the TYPED NOT_SUPPORTED outcome (never silent, never an
 *   implied future support);
 * - the refund amount must be exact Money in the original currency and not
 *   exceed the original payment amount (partial refunds allowed when the
 *   rail supports them);
 * - the original attempt is NEVER mutated: the refund references it by id.
 */
export function initiateRefund(input: {
  readonly refundId: string;
  readonly attempt: CheckoutPaymentAttempt;
  readonly originalAmount: Money;
  readonly amount: Money;
  readonly railSupport: RailRefundSupportObservation;
  readonly destinationRef: string;
  readonly recourse: RecoursePolicyKind;
  readonly now: TimestampMs;
}): RefundInitiationResult {
  const id = asRefundId(input.refundId);
  if (input.attempt === null || typeof input.attempt !== "object") {
    throw new ValidationError("initiateRefund requires a CheckoutPaymentAttempt", { id });
  }
  if (input.attempt.attempt.state !== "CONFIRMED") {
    throw new ValidationError(
      "only a CONFIRMED payment attempt can be refunded (originals are immutable and never rewritten)",
      { refundId: id, attemptId: input.attempt.attempt.id, state: input.attempt.attempt.state },
    );
  }
  if (input.railSupport === null || typeof input.railSupport !== "object") {
    throw new ValidationError("initiateRefund requires a RailRefundSupportObservation", {
      id,
    });
  }
  if (!isNonEmptyString(input.destinationRef)) {
    throw new ValidationError("a refund requires a destinationRef", { id });
  }
  if (typeof input.now !== "bigint") {
    throw new ValidationError("now must be a bigint TimestampMs", { id });
  }
  if (!input.railSupport.supportsRefunds) {
    return Object.freeze({
      outcome: "NOT_SUPPORTED" as const,
      routeFamily: input.railSupport.routeFamily,
      reason:
        "the underlying rail does not support refunds (typed rail capability observation — not an implied future support)",
    });
  }
  const original = input.originalAmount;
  const amount = input.amount;
  for (const [label, value] of [
    ["originalAmount", original],
    ["amount", amount],
  ] as const) {
    if (value === null || typeof value !== "object" || typeof value.value !== "bigint") {
      throw new ValidationError(`the refund ${label} must be exact Money`, { id });
    }
  }
  if (amount.value <= 0n) {
    throw new ValidationError("the refund amount must be positive", { id });
  }
  if (amount.currency !== original.currency) {
    throw new ValidationError("the refund must be denominated in the original currency", {
      id,
      refundCurrency: amount.currency,
      originalCurrency: original.currency,
    });
  }
  if (amount.value > original.value) {
    throw new ValidationError(
      "the refund amount must not exceed the original payment amount",
      { id, refundValue: amount.value, originalValue: original.value },
    );
  }
  const isPartial = amount.value < original.value;
  if (isPartial && !input.railSupport.partialRefunds) {
    throw new ValidationError(
      "the rail does not support partial refunds (typed rail capability observation)",
      { id },
    );
  }
  if (input.railSupport.refundMedium === undefined) {
    throw new ValidationError(
      "a supporting rail observation must declare its refundMedium",
      { id },
    );
  }
  const refund: RefundRecord = Object.freeze({
    id,
    originalAttemptId: input.attempt.attempt.id,
    intentId: input.attempt.attempt.intentId,
    amount,
    routeFamily: input.railSupport.routeFamily,
    refundMedium: input.railSupport.refundMedium,
    destinationRef: input.destinationRef,
    recourse: input.recourse,
    railObservationId: input.railSupport.observationId,
    state: "PENDING",
    evidenceIds: Object.freeze([
      `rail-observation:${input.railSupport.observationId}`,
      ...input.railSupport.evidenceRefs,
    ]),
    createdAt: input.now,
    updatedAt: input.now,
  });
  assertNoSecretMaterial(refund, "refund record");
  return Object.freeze({ outcome: "REFUND_STARTED" as const, refund });
}

/** Submit a PENDING refund to the rail (a NEW frozen record). */
export function submitRefund(
  refund: RefundRecord,
  input: {
    readonly submissionRef: string;
    readonly refundedCryptoAmount?: CryptoAmount;
    readonly now: TimestampMs;
  },
): RefundRecord {
  if (refund === null || typeof refund !== "object" || !isNonEmptyString(refund.id)) {
    throw new ValidationError("submitRefund requires a RefundRecord");
  }
  if (!isNonEmptyString(input.submissionRef)) {
    throw new ValidationError("a refund submission requires a submissionRef", {
      refundId: refund.id,
    });
  }
  if (typeof input.now !== "bigint") {
    throw new ValidationError("now must be a bigint TimestampMs", { refundId: refund.id });
  }
  const record = refundStateMachine.transition(refund.state, "SUBMIT");
  return Object.freeze({
    ...refund,
    state: record.to,
    ...(input.refundedCryptoAmount !== undefined
      ? { refundedCryptoAmount: input.refundedCryptoAmount }
      : {}),
    evidenceIds: Object.freeze([...refund.evidenceIds, `submission:${input.submissionRef}`]),
    updatedAt: input.now,
  });
}

/** One externally-observed refund outcome. */
export type RefundOutcomeObservation =
  | { readonly kind: "SUCCEEDED"; readonly evidenceIds: readonly string[] }
  | { readonly kind: "FAILED"; readonly evidenceIds: readonly string[] }
  | { readonly kind: "OUTCOME_UNKNOWN"; readonly evidenceIds: readonly string[] };

/**
 * Observe the outcome of a SUBMITTED refund. Evidence is MANDATORY for
 * definitive outcomes (INV-E02); UNKNOWN is preserved first-class
 * (INV-X01). Returns a NEW frozen record.
 */
export function observeRefundOutcome(
  refund: RefundRecord,
  observation: RefundOutcomeObservation,
  now: TimestampMs,
): RefundRecord {
  if (refund === null || typeof refund !== "object" || !isNonEmptyString(refund.id)) {
    throw new ValidationError("observeRefundOutcome requires a RefundRecord");
  }
  if (
    observation === null ||
    typeof observation !== "object" ||
    (observation.kind !== "SUCCEEDED" &&
      observation.kind !== "FAILED" &&
      observation.kind !== "OUTCOME_UNKNOWN")
  ) {
    throw new ValidationError("a refund outcome observation must be typed");
  }
  if (typeof now !== "bigint") {
    throw new ValidationError("now must be a bigint TimestampMs", { refundId: refund.id });
  }
  requireEvidenceIds(
    observation.evidenceIds,
    "recording a refund outcome requires linked evidence (INV-E02)",
  );
  const event =
    observation.kind === "SUCCEEDED"
      ? "CONFIRM_SUCCEEDED"
      : observation.kind === "FAILED"
        ? "CONFIRM_FAILED"
        : "REPORT_UNKNOWN";
  const record = refundStateMachine.transition(refund.state, event);
  const merged = [...refund.evidenceIds];
  for (const id of observation.evidenceIds) {
    if (!merged.includes(id)) {
      merged.push(id);
    }
  }
  return Object.freeze({
    ...refund,
    state: record.to,
    evidenceIds: Object.freeze(merged),
    updatedAt: now,
  });
}

/**
 * Resolve an OUTCOME_UNKNOWN refund through a reconciliation resolution
 * (INV-X03 — the only exit from ambiguity). Returns a NEW frozen record.
 */
export function resolveRefundUnknown(
  refund: RefundRecord,
  resolution: UnknownOutcomeResolution,
  now: TimestampMs,
): RefundRecord {
  if (refund === null || typeof refund !== "object" || !isNonEmptyString(refund.id)) {
    throw new ValidationError("resolveRefundUnknown requires a RefundRecord");
  }
  if (
    resolution === null ||
    typeof resolution !== "object" ||
    (resolution.resolvedOutcome !== "CONFIRMED_SUCCEEDED" &&
      resolution.resolvedOutcome !== "CONFIRMED_FAILED")
  ) {
    throw new ValidationError(
      "a refund resolution must be an UnknownOutcomeResolution with a declared resolvedOutcome",
      { refundId: refund.id },
    );
  }
  if (typeof now !== "bigint") {
    throw new ValidationError("now must be a bigint TimestampMs", { refundId: refund.id });
  }
  requireEvidenceIds(
    resolution.evidenceIds,
    "a refund reconciliation resolution requires evidence ids (INV-X03)",
  );
  const event =
    resolution.resolvedOutcome === "CONFIRMED_SUCCEEDED"
      ? "RESOLVE_SUCCEEDED"
      : "RESOLVE_FAILED";
  const record = refundStateMachine.transition(refund.state, event);
  const merged = [...refund.evidenceIds];
  for (const id of resolution.evidenceIds) {
    if (!merged.includes(id)) {
      merged.push(id);
    }
  }
  return Object.freeze({
    ...refund,
    state: record.to,
    evidenceIds: Object.freeze(merged),
    updatedAt: now,
  });
}

/** Read-only status projection over one refund. */
export function refundStatusView(
  refund: RefundRecord,
): {
  readonly refundId: string;
  readonly state: RefundState;
  readonly outcome: "PENDING" | "SUCCEEDED" | "FAILED" | "OUTCOME_UNKNOWN";
  readonly evidenceIds: readonly string[];
} {
  if (refund === null || typeof refund !== "object" || !isNonEmptyString(refund.id)) {
    throw new ValidationError("refundStatusView requires a RefundRecord");
  }
  const outcome =
    refund.state === "CONFIRMED"
      ? ("SUCCEEDED" as const)
      : refund.state === "FAILED"
        ? ("FAILED" as const)
        : refund.state === "OUTCOME_UNKNOWN"
          ? ("OUTCOME_UNKNOWN" as const)
          : ("PENDING" as const);
  return Object.freeze({
    refundId: refund.id,
    state: refund.state,
    outcome,
    evidenceIds: Object.freeze([...refund.evidenceIds]),
  });
}

/**
 * Payment-method offers derived from authoritative state (W3-003).
 *
 * PAYMENT-OPERATING-PLANE (PaymentMethodOffer) + PSP-ADAPTER-NETWORK:
 *
 * - An offer is DERIVED, never fabricated: it exists only when (a) the
 *   payment request is ACCEPTED by the merchant's PaymentAcceptancePolicy
 *   (@payswap/payment, W1-003), (b) the backing capability is a genuinely
 *   ConnectedCapabilityInstance (INV-C05: authorized, eligible, no missing
 *   permissions), and (c) the LATEST CapabilityObservation establishes the
 *   capability as AVAILABLE and the instance ELIGIBLE (INV-C02: unknown
 *   reachability is never success — it yields NO offer, with a typed
 *   rejection reason).
 * - The offer carries the EXPLICIT execution mode (INV-C07) and the ACTUAL
 *   rail path, mirrored from the PaymentMethodTranslation's selected
 *   capability chain (W1-003), so "Pay with PaySwap" can always be inspected
 *   down to the real rails traversed.
 * - The merchant settlement destination is explicit (external, never PaySwap
 *   custody) and must match the translation's settlement result.
 * - OffNetworkPaymentRecords can be INGESTED without claiming PaySwap
 *   execution — the ingestion result is structurally marked as not
 *   PaySwap-executed (the payment plane's guard can only ever return false
 *   for it).
 * - Asynchronous / customer-action-required provider states remain
 *   actionable: `pendingCustomerActions` surfaces the preserved
 *   ProviderActionRequired entries (INV-C06 — surfaced, never flattened).
 */

import { ValidationError } from "@payswap/protocol";
import type { CurrencyCode, Money, TimestampMs } from "@payswap/protocol";
import type {
  CapabilityDefinition,
  CapabilityObservation,
  ConnectedCapabilityInstance,
  ExecutionMode,
  ProviderActionRequired,
  RequiredCustomerAction,
} from "@payswap/connectors";
import type {
  AcceptanceDecision,
  AcceptanceRequest,
  OffNetworkPaymentRecord,
  PaymentAcceptancePolicy,
  PaymentMethodId,
  PaymentMethodTranslation,
  RailCapabilityRef,
} from "@payswap/payment";
import { isPaySwapExecutedSettlement, matchesAcceptance } from "@payswap/payment";
import type { ExecutionAttempt } from "./attempts.js";

// ---------------------------------------------------------------------------
// The offer
// ---------------------------------------------------------------------------

/** A concrete payment-method offer derived from authoritative state. */
export interface PaymentMethodOffer {
  readonly offerId: string;
  readonly methodId: PaymentMethodId;
  readonly currency: CurrencyCode;
  readonly amount: Money;
  readonly fees: Money;
  /** EXPLICIT on the offer (INV-C07). */
  readonly executionMode: ExecutionMode;
  /** The ACTUAL rail path (from the translation's selected capability chain). */
  readonly railPath: readonly RailCapabilityRef[];
  /** The ConnectedCapabilityInstance the offer is derived from (INV-C05). */
  readonly basedOnInstanceId: string;
  /** The authoritative observation version backing the offer. */
  readonly basedOnObservationVersion: number;
  /** Explicit external merchant settlement destination (never PaySwap custody). */
  readonly settlementDestinationId: string;
  readonly expiresAt: TimestampMs;
  /** Customer actions required to execute (from the capability declarations). */
  readonly requiredCustomerActions: readonly RequiredCustomerAction[];
}

export type OfferDerivationRejectionReason =
  | "ACCEPTANCE_REJECTED"
  | "CAPABILITY_INSTANCE_NOT_AUTHORIZED"
  | "CAPABILITY_INSTANCE_NOT_ELIGIBLE"
  | "CAPABILITY_INSTANCE_MISSING_PERMISSIONS"
  | "OBSERVATION_INSTANCE_MISMATCH"
  | "CAPABILITY_AVAILABILITY_UNKNOWN"
  | "CAPABILITY_UNAVAILABLE"
  | "CAPABILITY_NOT_ELIGIBLE"
  | "TRANSLATION_METHOD_MISMATCH"
  | "TRANSLATION_SETTLEMENT_MISMATCH";

export type OfferDerivation =
  | { readonly ok: true; readonly offer: PaymentMethodOffer }
  | {
      readonly ok: false;
      readonly reason: OfferDerivationRejectionReason;
      readonly message: string;
    };

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isMoney(value: Money): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof value.value === "bigint" &&
    isNonEmptyString(value.currency)
  );
}

export interface DerivePaymentMethodOfferInput {
  readonly offerId: string;
  readonly acceptance: PaymentAcceptancePolicy;
  readonly request: AcceptanceRequest;
  readonly instance: ConnectedCapabilityInstance;
  readonly observation: CapabilityObservation;
  readonly translation: PaymentMethodTranslation;
  /** The CapabilityDefinition of the backing rail (W2-003 vocabulary — consumed). */
  readonly capability?: CapabilityDefinition;
  readonly amount: Money;
  readonly fees: Money;
  readonly executionMode: ExecutionMode;
  readonly expiresAt: TimestampMs;
}

/**
 * Derive one payment-method offer from authoritative acceptance + capability
 * state. Every axis must hold; a single failed axis yields a typed rejection
 * and NO offer — offers are never fabricated, and unknown reachability
 * (INV-C02) is never success.
 */
export function derivePaymentMethodOffer(
  input: DerivePaymentMethodOfferInput,
): OfferDerivation {
  if (input === null || typeof input !== "object") {
    throw new ValidationError("offer derivation input must be an object");
  }
  if (!isNonEmptyString(input.offerId)) {
    throw new ValidationError("offerId must be a non-empty string");
  }
  if (!isMoney(input.amount) || !isMoney(input.fees)) {
    throw new ValidationError("offer amount and fees must be exact Money (INV-F01)");
  }
  if (typeof input.expiresAt !== "bigint" || input.expiresAt <= 0n) {
    throw new ValidationError("offer expiresAt must be a positive bigint TimestampMs");
  }

  // Axis 1: merchant acceptance is authoritative for what may be offered.
  const decision: AcceptanceDecision = matchesAcceptance(input.acceptance, input.request);
  if (!decision.accepted) {
    return {
      ok: false,
      reason: "ACCEPTANCE_REJECTED",
      message: `the payment request is not accepted by policy '${input.acceptance.id}': ${decision.reasons.join(", ")}`,
    };
  }

  // Axis 2: a genuinely connected instance (INV-C05) — never a catalogue claim.
  const instance = input.instance;
  if (instance.authorization.status !== "ACTIVE") {
    return {
      ok: false,
      reason: "CAPABILITY_INSTANCE_NOT_AUTHORIZED",
      message: `instance '${instance.instanceId}' authorization is '${instance.authorization.status}'`,
    };
  }
  if (instance.eligibility.eligible !== true) {
    return {
      ok: false,
      reason: "CAPABILITY_INSTANCE_NOT_ELIGIBLE",
      message: `instance '${instance.instanceId}' is not eligible`,
    };
  }
  if (instance.permissionState.missing.length > 0) {
    return {
      ok: false,
      reason: "CAPABILITY_INSTANCE_MISSING_PERMISSIONS",
      message: `instance '${instance.instanceId}' is missing permissions [${instance.permissionState.missing.join(", ")}]`,
    };
  }

  // Axis 3: the CURRENT observation is authoritative for reachability.
  const observation = input.observation;
  if (observation.instanceId !== instance.instanceId) {
    return {
      ok: false,
      reason: "OBSERVATION_INSTANCE_MISMATCH",
      message: `observation is for instance '${observation.instanceId}' but the offer is being derived for instance '${instance.instanceId}'`,
    };
  }
  if (observation.availability === "UNKNOWN") {
    return {
      ok: false,
      reason: "CAPABILITY_AVAILABILITY_UNKNOWN",
      message:
        "INV-C02: current reachability cannot be established — availability UNKNOWN is never success, and no offer is fabricated",
    };
  }
  if (observation.availability === "UNAVAILABLE") {
    return {
      ok: false,
      reason: "CAPABILITY_UNAVAILABLE",
      message: `capability for instance '${instance.instanceId}' is currently unavailable`,
    };
  }
  if (observation.eligibility === "NOT_ELIGIBLE") {
    return {
      ok: false,
      reason: "CAPABILITY_NOT_ELIGIBLE",
      message: `observation for instance '${instance.instanceId}' reports NOT_ELIGIBLE`,
    };
  }

  // Axis 4: the translation shows the actual rail path and settlement.
  const translation = input.translation;
  if (translation.requestedMethod !== input.request.methodId) {
    return {
      ok: false,
      reason: "TRANSLATION_METHOD_MISMATCH",
      message: "the translation is for a different requested method",
    };
  }
  if (
    translation.merchantSettlementResult.destinationId !==
    input.acceptance.settlementDestination.id
  ) {
    return {
      ok: false,
      reason: "TRANSLATION_SETTLEMENT_MISMATCH",
      message: "the translation settles to a destination other than the acceptance policy's",
    };
  }
  if (translation.selectedCapabilityChain.length === 0) {
    return {
      ok: false,
      reason: "TRANSLATION_METHOD_MISMATCH",
      message: "the translation carries an empty capability chain",
    };
  }

  const railPath: RailCapabilityRef[] = translation.selectedCapabilityChain.map(
    (step) => step.capability,
  );

  const offer: PaymentMethodOffer = Object.freeze({
    offerId: input.offerId,
    methodId: input.request.methodId,
    currency: input.request.currency,
    amount: Object.freeze({ ...input.amount }),
    fees: Object.freeze({ ...input.fees }),
    executionMode: input.executionMode,
    railPath: Object.freeze(railPath),
    basedOnInstanceId: instance.instanceId,
    basedOnObservationVersion: observation.observationVersion,
    settlementDestinationId: input.acceptance.settlementDestination.id,
    expiresAt: input.expiresAt,
    requiredCustomerActions: Object.freeze([
      ...(input.capability?.requiredCustomerActions ?? []),
    ]),
  });
  return { ok: true, offer };
}

// ---------------------------------------------------------------------------
// Off-network ingestion (never PaySwap-executed)
// ---------------------------------------------------------------------------

/** The result of ingesting an off-network payment record. */
export interface IngestedOffNetworkPayment {
  readonly record: OffNetworkPaymentRecord;
  /** Structural literal: an off-network record is never PaySwap-executed. */
  readonly attributedToPaySwap: false;
}

/**
 * Ingest an external (off-network) payment record WITHOUT claiming PaySwap
 * execution. The payment plane's `isPaySwapExecutedSettlement` guard can only
 * ever return false for this record — the ingestion result exposes that fact
 * structurally so aggregation code cannot miscount it.
 */
export function ingestOffNetworkPaymentRecord(
  record: OffNetworkPaymentRecord,
): IngestedOffNetworkPayment {
  if (record === null || typeof record !== "object") {
    throw new ValidationError("an OffNetworkPaymentRecord is required");
  }
  if (record.orchestratedBy !== "EXTERNAL_PARTY") {
    throw new ValidationError(
      "off-network records are orchestrated by EXTERNAL_PARTY by construction (payment plane, W1-003)",
    );
  }
  if (isPaySwapExecutedSettlement(record)) {
    // Unreachable by construction; the check makes the impossibility explicit
    // rather than assumed.
    throw new ValidationError(
      "an off-network payment record can never be a PaySwap-executed settlement",
    );
  }
  return Object.freeze({
    record,
    attributedToPaySwap: false,
  });
}

// ---------------------------------------------------------------------------
// Actionable customer-action surfaces (INV-C06)
// ---------------------------------------------------------------------------

/**
 * The provider-required customer/user actions an attempt is currently waiting
 * on, surfaced VERBATIM from the preserved ProviderStateEnvelope
 * (INV-C06/AGENTS.md rule 19: customer-action-required states remain
 * actionable; they are never flattened into generic outcomes).
 */
export function pendingCustomerActions(
  attempt: ExecutionAttempt,
): readonly ProviderActionRequired[] {
  if (attempt === null || typeof attempt !== "object") {
    throw new ValidationError("an ExecutionAttempt is required");
  }
  const actions: ProviderActionRequired[] = [];
  for (const evidence of attempt.evidence) {
    const envelope = evidence.providerState;
    if (envelope === undefined) {
      continue;
    }
    if (
      (envelope.classification.requiresCustomerAction ||
        envelope.classification.family === "customer_action_required") &&
      envelope.actionRequired !== undefined
    ) {
      actions.push(envelope.actionRequired);
    }
  }
  return Object.freeze(actions);
}

/** True while an attempt is waiting on a customer/user action (actionable, not failed). */
export function isAwaitingCustomerAction(
  attempt: ExecutionAttempt,
): boolean {
  return attempt.state === "AWAITING_CUSTOMER_ACTION";
}

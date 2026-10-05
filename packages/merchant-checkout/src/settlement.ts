/**
 * @payswap/merchant-checkout — settlement configuration + Stripe connection
 * (P4-W2-003 §3.8) and the two explicit Stripe paths (§3.9).
 *
 * §3.8 — Settlement policy per destination (schedule, threshold, currency
 * denomination) is CONFIGURATION AS TYPED DATA: no function in this module
 * turns a policy into an effect; effects flow ONLY through
 * `settleConfirmedAttempt`, which requires a CONFIRMED attempt plus a
 * selected settlement route (and, on the native family, a provider-verified
 * confirmation — the merchant-crypto law). The Stripe connection model is
 * a ProviderStateEnvelope-style lifecycle (connect/onboard/verify/restrict)
 * built through the canonical @payswap/connectors envelope (INV-C06: raw
 * provider state preserved verbatim), and the eligible-capability
 * observation is scoped to the ACTUAL connected instance (AGENTS.md rule
 * 18: catalogue presence is never connection).
 *
 * §3.9 — NAMING RECONCILIATION (documented for TL audit; see README):
 * the work item names the settlement modes NATIVE_STRIPE_CRYPTO and
 * PAYSWAP_EXTERNAL_SETTLEMENT; the LANDED W1-003 route-family literals are
 * NATIVE_STRIPE_CRYPTO and EXTERNAL_PAYSWAP_CONVERSION (and W4-001's
 * route-compiler speaks Mode A/Mode B over the same families). This module
 * reuses the LANDED route-family literals as the routing-level
 * discriminator (never renaming them) and introduces the work-item
 * settlement-mode union as a DOCUMENTED typed mapping on top:
 *
 *   settlementMode              routeFamily (landed literal)
 *   NATIVE_STRIPE_CRYPTO    →   NATIVE_STRIPE_CRYPTO
 *   PAYSWAP_EXTERNAL_SETTLEMENT → EXTERNAL_PAYSWAP_CONVERSION
 *
 * with disjoint fields both directions on the mode configs
 * (`assertSettlementModeDiscriminated`).
 *
 * The honest-unavailability law: PAYSWAP_EXTERNAL_SETTLEMENT carries the
 * mandated notice (consumed VERBATIM from @payswap/route-compiler's
 * STRIPE_NATIVE_SETTLEMENT_UNAVAILABLE_NOTICE) wherever the native path is
 * not eligible — and NEVER implies Stripe balance settlement (the external
 * settlement record structurally cannot carry a Stripe balance reference).
 */

import { PaySwapError, ValidationError } from "@payswap/protocol";
import type { CurrencyCode, Money, PaySwapErrorDetails, TimestampMs } from "@payswap/protocol";
import type { MerchantSettlementDestination } from "@payswap/payment";
import type { ConnectedCapabilityInstance } from "@payswap/connectors";
import { assertConnectedInstance, createProviderStateEnvelope } from "@payswap/connectors";
import type { ProviderStateEnvelope } from "@payswap/connectors";
import {
  STRIPE_NATIVE_CRYPTO_SETTLEMENT_CAPABILITY_ID,
  defineExternalConversionSettlementRoute,
  defineNativeStripeCryptoSettlementRoute,
  nativeStripeCryptoEligibility,
  recordStripeSettlementConfirmation,
} from "@payswap/merchant-crypto";
import type {
  ExternalConversionSettlementRoute,
  NativeStripeCryptoSettlementRoute,
  NativeStripeCryptoEligibilityView,
  StripeSettlementConfirmation,
} from "@payswap/merchant-crypto";
import { STRIPE_NATIVE_SETTLEMENT_UNAVAILABLE_NOTICE } from "@payswap/route-compiler";
import { assertNoSecretMaterial } from "@payswap/onchain-security";
import type { CheckoutPaymentAttempt } from "./lifecycle.js";
import { attachAttemptSettlement } from "./lifecycle.js";

// ---------------------------------------------------------------------------
// §3.8 — Settlement policy (configuration as typed data)
// ---------------------------------------------------------------------------

/** When settled value is scheduled to move (schedule semantics only). */
export type MerchantSettlementSchedule = "MANUAL" | "DAILY" | "WEEKLY" | "MONTHLY";

const SETTLEMENT_SCHEDULES: readonly MerchantSettlementSchedule[] = [
  "MANUAL",
  "DAILY",
  "WEEKLY",
  "MONTHLY",
];

/**
 * Settlement policy per destination: schedule, optional exact threshold and
 * the currency denomination. PURE CONFIGURATION — there is no function from
 * a policy to a settlement effect; effects only ever flow through
 * `settleConfirmedAttempt` (which requires a CONFIRMED attempt, a selected
 * route, and on the native family a provider-verified confirmation).
 */
export interface MerchantSettlementPolicy {
  readonly policyId: string;
  readonly merchantRef: string;
  readonly destinationId: string;
  readonly schedule: MerchantSettlementSchedule;
  /** Optional exact threshold that triggers a settlement run. */
  readonly thresholdAmount?: Money;
  readonly currencyDenomination: CurrencyCode;
}

/** Construct a validated, frozen settlement policy (typed data, no effects). */
export function defineSettlementPolicy(input: {
  readonly policyId: string;
  readonly merchantRef: string;
  readonly destinationId: string;
  readonly schedule: MerchantSettlementSchedule;
  readonly thresholdAmount?: Money;
  readonly currencyDenomination: string;
}): MerchantSettlementPolicy {
  if (typeof input.policyId !== "string" || input.policyId.length === 0) {
    throw new ValidationError("settlement policy id must be a non-empty string");
  }
  if (typeof input.merchantRef !== "string" || input.merchantRef.length === 0) {
    throw new ValidationError("settlement policy merchantRef must be a non-empty string");
  }
  if (typeof input.destinationId !== "string" || input.destinationId.length === 0) {
    throw new ValidationError("settlement policy destinationId must be a non-empty string");
  }
  if (!SETTLEMENT_SCHEDULES.includes(input.schedule)) {
    throw new ValidationError(`settlement schedule is not declared: ${String(input.schedule)}`);
  }
  if (
    typeof input.currencyDenomination !== "string" ||
    !/^[A-Z]{3}$/.test(input.currencyDenomination)
  ) {
    throw new ValidationError(
      "settlement policy currencyDenomination must be a 3-letter uppercase ISO-style code",
    );
  }
  if (input.thresholdAmount !== undefined) {
    const threshold = input.thresholdAmount;
    if (threshold === null || typeof threshold !== "object" || typeof threshold.value !== "bigint") {
      throw new ValidationError("settlement threshold must be exact Money");
    }
    if (threshold.value <= 0n) {
      throw new ValidationError("settlement threshold must be positive");
    }
    if (threshold.currency !== input.currencyDenomination) {
      throw new ValidationError(
        "settlement threshold must be denominated in the policy currency",
      );
    }
  }
  const policy: MerchantSettlementPolicy = Object.freeze({
    policyId: input.policyId,
    merchantRef: input.merchantRef,
    destinationId: input.destinationId,
    schedule: input.schedule,
    ...(input.thresholdAmount !== undefined
      ? { thresholdAmount: input.thresholdAmount }
      : {}),
    currencyDenomination: input.currencyDenomination as CurrencyCode,
  });
  assertNoSecretMaterial(policy, "settlement policy");
  return policy;
}

// ---------------------------------------------------------------------------
// §3.8 — Stripe connection (ProviderStateEnvelope-style lifecycle)
// ---------------------------------------------------------------------------

/** The Stripe connected-account lifecycle steps (connect/onboard/verify/restrict). */
export const STRIPE_CONNECTION_LIFECYCLE_STEPS = [
  "connect",
  "onboard",
  "verify",
  "restrict",
] as const;

export type StripeConnectionLifecycleStep = (typeof STRIPE_CONNECTION_LIFECYCLE_STEPS)[number];

/**
 * Record one Stripe connected-account state observation as a canonical
 * ProviderStateEnvelope (family `connected_account`): the RAW provider
 * state passes through VERBATIM (INV-C06 — never flattened into a generic
 * status), the lifecycle step is one of connect/onboard/verify/restrict,
 * and the observation carries its provenance. This is an OBSERVATION of an
 * external account — never PaySwap custody and never connection authority
 * by itself (connection authority is the ConnectedCapabilityInstance).
 */
export function recordStripeConnectionObservation(input: {
  readonly stripeAccountRef: string;
  readonly revision: string;
  /** Raw provider-native state (preserved verbatim, INV-C06). */
  readonly rawState: unknown;
  readonly lifecycleStep: StripeConnectionLifecycleStep;
  readonly isTerminal: boolean;
  readonly requiresCustomerAction: boolean;
  readonly actionRequired?: { readonly kind: string; readonly message: string };
  readonly observedAt: string;
}): ProviderStateEnvelope {
  if (typeof input.stripeAccountRef !== "string" || input.stripeAccountRef.length === 0) {
    throw new ValidationError("a connection observation requires a stripeAccountRef");
  }
  if (typeof input.revision !== "string" || input.revision.length === 0) {
    throw new ValidationError("a connection observation requires a revision");
  }
  if (!STRIPE_CONNECTION_LIFECYCLE_STEPS.includes(input.lifecycleStep)) {
    throw new ValidationError(
      `a Stripe connection lifecycle step must be one of ${STRIPE_CONNECTION_LIFECYCLE_STEPS.join(", ")}`,
      { lifecycleStep: input.lifecycleStep },
    );
  }
  if (typeof input.observedAt !== "string" || input.observedAt.length === 0) {
    throw new ValidationError("a connection observation requires an observedAt instant");
  }
  const envelope = createProviderStateEnvelope({
    provider: { name: "stripe", version: "1" },
    object: { objectType: "stripe.account", externalId: input.stripeAccountRef },
    revision: input.revision,
    state: input.rawState,
    classification: {
      family: "connected_account",
      lifecycleStep: input.lifecycleStep,
      isTerminal: input.isTerminal,
      requiresCustomerAction: input.requiresCustomerAction,
    },
    history: [],
    ...(input.actionRequired !== undefined
      ? { actionRequired: input.actionRequired }
      : {}),
    privacy: {
      dataClassification: "PARTNER",
      constraints: ["no-secret-material-in-envelopes"],
      shareableFields: ["status", "capabilities", "country"],
    },
    timestamps: { observedAt: input.observedAt },
    provenance: { source: "PROVIDER_API" },
  });
  return envelope;
}

// ---------------------------------------------------------------------------
// §3.8 — Eligible-capability observation (scoped to the ACTUAL instance)
// ---------------------------------------------------------------------------

/**
 * A typed eligibility observation of the native Stripe crypto settlement
 * capability, scoped to the ACTUAL connected instance (rule 18). Derived
 * through the LANDED `nativeStripeCryptoEligibility` — this layer adds no
 * eligibility vocabulary.
 */
export interface StripeCryptoSettlementEligibilityObservation {
  readonly observationId: string;
  readonly instanceId: string;
  readonly capabilityId: string;
  readonly eligible: boolean;
  readonly reasons: readonly string[];
  readonly observedAt: TimestampMs;
  readonly evidenceRefs: readonly string[];
}

/**
 * Observe native Stripe crypto settlement eligibility for one ACTUAL
 * connected instance against one settlement currency. The instance is
 * asserted FIRST (a catalogue entry throws ConnectorAuthorityError,
 * INV-C05); the view is the landed `nativeStripeCryptoEligibility` output
 * over a route carrying the settlement currency.
 */
export function observeStripeCryptoSettlementEligibility(input: {
  readonly observationId: string;
  readonly connectedInstance: ConnectedCapabilityInstance;
  readonly settlementCurrency: string;
  readonly supportedAssets: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly observedAt: TimestampMs;
}): StripeCryptoSettlementEligibilityObservation {
  if (typeof input.observationId !== "string" || input.observationId.length === 0) {
    throw new ValidationError("an eligibility observation requires an observationId");
  }
  assertConnectedInstance(input.connectedInstance);
  if (typeof input.settlementCurrency !== "string" || input.settlementCurrency.length !== 3) {
    throw new ValidationError("the settlement currency must be a 3-character code");
  }
  if (
    !Array.isArray(input.supportedAssets) ||
    input.supportedAssets.length === 0
  ) {
    throw new ValidationError("an eligibility observation requires supported assets");
  }
  if (
    !Array.isArray(input.evidenceRefs) ||
    input.evidenceRefs.length === 0 ||
    !input.evidenceRefs.every((ref) => typeof ref === "string" && ref.length > 0)
  ) {
    throw new ValidationError(
      "an eligibility observation requires non-empty evidence refs (INV-C05: catalogue presence is never connection)",
    );
  }
  if (typeof input.observedAt !== "bigint") {
    throw new ValidationError("observedAt must be a bigint TimestampMs");
  }
  // The landed eligibility view is route-shaped; evaluate it against a
  // provider-verified native route bound to this instance (which itself
  // fails closed when the instance is not ACTIVE/eligible — so a
  // constructed route implies eligibility; the observation records it).
  const route = defineNativeStripeCryptoSettlementRoute(
    {
      connectedInstanceId: input.connectedInstance.instanceId,
      stripeAccountRef: input.connectedInstance.accountRef,
      settlementCurrency: input.settlementCurrency,
      supportedAssets: input.supportedAssets,
      evidenceRefs: input.evidenceRefs,
    },
    input.connectedInstance,
  );
  const view: NativeStripeCryptoEligibilityView = nativeStripeCryptoEligibility(
    input.connectedInstance,
    route,
  );
  const observation: StripeCryptoSettlementEligibilityObservation = Object.freeze({
    observationId: input.observationId,
    instanceId: input.connectedInstance.instanceId,
    capabilityId: STRIPE_NATIVE_CRYPTO_SETTLEMENT_CAPABILITY_ID,
    eligible: view.eligible,
    reasons: Object.freeze([...view.reasons]),
    observedAt: input.observedAt,
    evidenceRefs: Object.freeze([...input.evidenceRefs]),
  });
  assertNoSecretMaterial(observation, "stripe crypto settlement eligibility observation");
  return observation;
}

// ---------------------------------------------------------------------------
// §3.9 — The two explicit Stripe paths (naming reconciliation)
// ---------------------------------------------------------------------------

/**
 * The work-item settlement-mode discriminator (see the module header for
 * the documented reconciliation onto the LANDED route-family literals).
 */
export type MerchantStripeSettlementMode = "NATIVE_STRIPE_CRYPTO" | "PAYSWAP_EXTERNAL_SETTLEMENT";

export const MERCHANT_STRIPE_SETTLEMENT_MODES: readonly MerchantStripeSettlementMode[] =
  Object.freeze(["NATIVE_STRIPE_CRYPTO", "PAYSWAP_EXTERNAL_SETTLEMENT"]);

/** The landed W1-003 route-family literals (never renamed). */
export type LandedSettlementRouteFamily = "NATIVE_STRIPE_CRYPTO" | "EXTERNAL_PAYSWAP_CONVERSION";

/**
 * The DOCUMENTED typed mapping settlement-mode → landed route-family
 * (§3.9 reconciliation; audit target).
 */
export function settlementModeRouteFamily(
  mode: MerchantStripeSettlementMode,
): LandedSettlementRouteFamily {
  switch (mode) {
    case "NATIVE_STRIPE_CRYPTO":
      return "NATIVE_STRIPE_CRYPTO";
    case "PAYSWAP_EXTERNAL_SETTLEMENT":
      return "EXTERNAL_PAYSWAP_CONVERSION";
    default:
      throw new ValidationError(`settlement mode is not declared: ${String(mode)}`);
  }
}

/** The inverse mapping landed route-family → settlement-mode. */
export function routeFamilySettlementMode(
  routeFamily: LandedSettlementRouteFamily,
): MerchantStripeSettlementMode {
  switch (routeFamily) {
    case "NATIVE_STRIPE_CRYPTO":
      return "NATIVE_STRIPE_CRYPTO";
    case "EXTERNAL_PAYSWAP_CONVERSION":
      return "PAYSWAP_EXTERNAL_SETTLEMENT";
    default:
      throw new ValidationError(
        `settlement route family is not declared: ${String(routeFamily)}`,
      );
  }
}

/** Native-mode configuration (settlement through Stripe's own crypto settlement). */
export interface NativeStripeModeConfig {
  readonly mode: "NATIVE_STRIPE_CRYPTO";
  readonly connectedInstanceId: string;
  readonly stripeAccountRef: string;
  readonly settlementCurrency: string;
}

/** External-mode configuration (PaySwap converts/settles externally). */
export interface PayswapExternalModeConfig {
  readonly mode: "PAYSWAP_EXTERNAL_SETTLEMENT";
  readonly destination: MerchantSettlementDestination;
  readonly conversionChain: readonly string[];
}

/** Either mode configuration — discriminated by `mode`, disjoint fields. */
export type MerchantSettlementModeConfig = NativeStripeModeConfig | PayswapExternalModeConfig;

/** Raised when a value mixes fields of both settlement-mode configs. */
export class SettlementModeConflationError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({ code: "SETTLEMENT_MODE_CONFLATION", category: "VALIDATION", message, details });
  }
}

/**
 * Runtime anti-conflation guard for mode configurations: `mode` must be
 * one of the two declared modes and the config must not carry the OTHER
 * mode's fields (disjoint both directions).
 */
export function assertSettlementModeDiscriminated(
  config: unknown,
): asserts config is MerchantSettlementModeConfig {
  if (config === null || typeof config !== "object") {
    throw new ValidationError("a settlement mode config must be an object");
  }
  const record = config as Readonly<Record<string, unknown>>;
  const mode = record["mode"];
  if (mode === "NATIVE_STRIPE_CRYPTO") {
    if ("destination" in record || "conversionChain" in record) {
      throw new SettlementModeConflationError(
        "a NATIVE_STRIPE_CRYPTO mode config must not carry PAYSWAP_EXTERNAL_SETTLEMENT fields (destination/conversionChain)",
        { mode },
      );
    }
    if (
      typeof record["connectedInstanceId"] !== "string" ||
      (record["connectedInstanceId"] as string).length === 0 ||
      typeof record["stripeAccountRef"] !== "string" ||
      (record["stripeAccountRef"] as string).length === 0
    ) {
      throw new ValidationError(
        "a NATIVE_STRIPE_CRYPTO mode config requires connectedInstanceId and stripeAccountRef",
      );
    }
    return;
  }
  if (mode === "PAYSWAP_EXTERNAL_SETTLEMENT") {
    if (
      "connectedInstanceId" in record ||
      "stripeAccountRef" in record ||
      "settlementCurrency" in record
    ) {
      throw new SettlementModeConflationError(
        "a PAYSWAP_EXTERNAL_SETTLEMENT mode config must not carry NATIVE_STRIPE_CRYPTO fields (connectedInstanceId/stripeAccountRef/settlementCurrency)",
        { mode },
      );
    }
    if (record["destination"] === null || typeof record["destination"] !== "object") {
      throw new ValidationError(
        "a PAYSWAP_EXTERNAL_SETTLEMENT mode config requires an external settlement destination",
      );
    }
    if (
      !Array.isArray(record["conversionChain"]) ||
      record["conversionChain"].length === 0
    ) {
      throw new ValidationError(
        "a PAYSWAP_EXTERNAL_SETTLEMENT mode config requires a non-empty conversion chain",
      );
    }
    return;
  }
  throw new ValidationError(
    "settlement mode must be NATIVE_STRIPE_CRYPTO or PAYSWAP_EXTERNAL_SETTLEMENT",
    { mode },
  );
}

/** The mandated honest-unavailability notice (consumed verbatim from W4-001). */
export interface NativeSettlementUnavailableNotice {
  readonly notice: typeof STRIPE_NATIVE_SETTLEMENT_UNAVAILABLE_NOTICE;
  readonly reason: string;
}

/** Typed reasons the native path is unavailable at decision time. */
export type NativeUnavailableReason =
  | "NO_CONNECTED_INSTANCE"
  | "AUTHORIZATION_NOT_ACTIVE"
  | "INSTANCE_NOT_ELIGIBLE"
  | "SETTLEMENT_CURRENCY_NOT_IN_SCOPE"
  | "MERCHANT_CONFIGURED_EXTERNAL";

/** The result of a settlement-route selection at decision time. */
export type SettlementRouteSelection =
  | {
      readonly selected: "NATIVE_STRIPE_CRYPTO";
      readonly route: NativeStripeCryptoSettlementRoute;
      readonly eligibility: NativeStripeCryptoEligibilityView;
    }
  | {
      readonly selected: "PAYSWAP_EXTERNAL_SETTLEMENT";
      readonly route: ExternalConversionSettlementRoute;
      /** Present wherever the native path is not eligible (the honest-unavailability law). */
      readonly nativeUnavailable: NativeSettlementUnavailableNotice;
    };

/**
 * Select the settlement route at DECISION TIME.
 *
 * - desiredMode NATIVE_STRIPE_CRYPTO: the native path is available ONLY
 *   when the actual connected capability is eligible (connected instance +
 *   observed eligibility right now). When any axis fails, the selection
 *   falls back to the external route CARRYING THE MANDATED NOTICE with the
 *   typed reason — never a synthesized native route, never silence.
 * - desiredMode PAYSWAP_EXTERNAL_SETTLEMENT: the external route, with the
 *   notice (reason MERCHANT_CONFIGURED_EXTERNAL — this route does not
 *   settle to a Stripe balance).
 *
 * The external destination is ALWAYS required: the merchant's onboarding
 * mandates a configured external settlement destination, so the honest
 * fallback is always constructible. Fail-closed otherwise.
 */
export function selectSettlementRoute(input: {
  readonly desiredMode: MerchantStripeSettlementMode;
  readonly native?: {
    readonly connectedInstance: ConnectedCapabilityInstance;
    /** The merchant's Stripe account ref; defaults to the instance's accountRef. */
    readonly stripeAccountRef?: string;
    readonly settlementCurrency: string;
    readonly supportedAssets: readonly string[];
    readonly evidenceRefs: readonly string[];
  };
  readonly external: {
    readonly destination: MerchantSettlementDestination;
    readonly conversionChain: readonly string[];
  };
}): SettlementRouteSelection {
  if (!MERCHANT_STRIPE_SETTLEMENT_MODES.includes(input.desiredMode)) {
    throw new ValidationError("desiredMode must be a declared settlement mode");
  }
  if (input.external === null || typeof input.external !== "object") {
    throw new ValidationError(
      "an external settlement configuration is always required (the honest fallback destination)",
    );
  }
  const externalRoute = defineExternalConversionSettlementRoute({
    destination: input.external.destination,
    conversionChain: [...input.external.conversionChain],
  });

  if (input.desiredMode === "PAYSWAP_EXTERNAL_SETTLEMENT") {
    return Object.freeze({
      selected: "PAYSWAP_EXTERNAL_SETTLEMENT" as const,
      route: externalRoute,
      nativeUnavailable: Object.freeze({
        notice: STRIPE_NATIVE_SETTLEMENT_UNAVAILABLE_NOTICE,
        reason: "MERCHANT_CONFIGURED_EXTERNAL" as const,
      }),
    });
  }

  // desiredMode === NATIVE_STRIPE_CRYPTO — evaluate the actual instance.
  if (
    input.native === undefined ||
    input.native === null ||
    typeof input.native !== "object"
  ) {
    return Object.freeze({
      selected: "PAYSWAP_EXTERNAL_SETTLEMENT" as const,
      route: externalRoute,
      nativeUnavailable: Object.freeze({
        notice: STRIPE_NATIVE_SETTLEMENT_UNAVAILABLE_NOTICE,
        reason: "NO_CONNECTED_INSTANCE" as const,
      }),
    });
  }
  const instance = input.native.connectedInstance;
  assertConnectedInstance(instance);
  const settlementCurrency = input.native.settlementCurrency;
  if (typeof settlementCurrency !== "string" || settlementCurrency.length !== 3) {
    throw new ValidationError("the native settlement currency must be a 3-character code");
  }

  // Decision-time eligibility axes (the landed constructor re-verifies all
  // of them — defense in depth; this pre-check yields TYPED reasons).
  let reason: NativeUnavailableReason | undefined;
  if (instance.authorization.status !== "ACTIVE") {
    reason = "AUTHORIZATION_NOT_ACTIVE";
  } else if (instance.eligibility.eligible !== true) {
    reason = "INSTANCE_NOT_ELIGIBLE";
  } else if (!instance.currencies.includes(settlementCurrency)) {
    reason = "SETTLEMENT_CURRENCY_NOT_IN_SCOPE";
  }
  if (reason !== undefined) {
    return Object.freeze({
      selected: "PAYSWAP_EXTERNAL_SETTLEMENT" as const,
      route: externalRoute,
      nativeUnavailable: Object.freeze({
        notice: STRIPE_NATIVE_SETTLEMENT_UNAVAILABLE_NOTICE,
        reason,
      }),
    });
  }

  const route = defineNativeStripeCryptoSettlementRoute(
    {
      connectedInstanceId: instance.instanceId,
      stripeAccountRef:
        input.native.stripeAccountRef !== undefined
          ? input.native.stripeAccountRef
          : instance.accountRef,
      settlementCurrency,
      supportedAssets: [...input.native.supportedAssets],
      evidenceRefs: [...input.native.evidenceRefs],
    },
    instance,
  );
  const eligibility = nativeStripeCryptoEligibility(instance, route);
  return Object.freeze({
    selected: "NATIVE_STRIPE_CRYPTO" as const,
    route,
    eligibility,
  });
}

// ---------------------------------------------------------------------------
// §3.9 — Settlement execution (provider-verified effects only)
// ---------------------------------------------------------------------------

/**
 * The durable settlement record for one CONFIRMED attempt. Discriminated by
 * the LANDED route-family literal with DISJOINT fields: the native variant
 * carries the provider-verified StripeSettlementConfirmation (and nothing
 * can construct it without provider evidence — the merchant-crypto law);
 * the external variant carries the protocol settlement instruction refs and
 * the external destination — and structurally CANNOT imply a Stripe
 * balance settlement.
 */
export type MerchantSettlementRecord =
  | {
      readonly settlementId: string;
      readonly attemptId: string;
      readonly routeFamily: "NATIVE_STRIPE_CRYPTO";
      readonly settlementMode: "NATIVE_STRIPE_CRYPTO";
      readonly confirmation: StripeSettlementConfirmation;
      readonly recordedAt: TimestampMs;
      readonly evidenceIds: readonly string[];
    }
  | {
      readonly settlementId: string;
      readonly attemptId: string;
      readonly routeFamily: "EXTERNAL_PAYSWAP_CONVERSION";
      readonly settlementMode: "PAYSWAP_EXTERNAL_SETTLEMENT";
      readonly instructionId: string;
      readonly settlementAttemptIds: readonly string[];
      readonly destinationId: string;
      readonly recordedAt: TimestampMs;
      readonly evidenceIds: readonly string[];
    };

/**
 * Settle a CONFIRMED attempt through the selected route.
 *
 * - the attempt MUST be CONFIRMED (fail-closed);
 * - NATIVE: a provider-verified confirmation input is REQUIRED — it flows
 *   through the LANDED `recordStripeSettlementConfirmation`, which throws
 *   SyntheticStripeBalanceError without provider evidence (a synthetic
 *   Stripe balance effect is unconstructible);
 * - EXTERNAL: a confirmation input is FORBIDDEN (mode-field disjointness)
 *   and the protocol settlement instruction refs are attached — the record
 *   never implies Stripe balance settlement;
 * - the protocol settlement mapping is attached to the attempt through the
 *   landed `attachSettlement` (canonical linkage).
 */
export function settleConfirmedAttempt(input: {
  readonly settlementId: string;
  readonly attempt: CheckoutPaymentAttempt;
  readonly selection: SettlementRouteSelection;
  readonly confirmationInput?: {
    readonly confirmationId: string;
    readonly connectedInstanceId: string;
    readonly stripeBalanceTxRef: string;
    readonly amount: Money;
    readonly providerStateEnvelopeRef: string;
    readonly evidenceIds: readonly string[];
  };
  readonly protocolInstructionId: string;
  readonly protocolSettlementAttemptIds: readonly string[];
  readonly now: TimestampMs;
}): { readonly attempt: CheckoutPaymentAttempt; readonly settlement: MerchantSettlementRecord } {
  if (typeof input.settlementId !== "string" || input.settlementId.length === 0) {
    throw new ValidationError("a settlement requires a settlementId");
  }
  if (input.attempt === null || typeof input.attempt !== "object") {
    throw new ValidationError("settleConfirmedAttempt requires a CheckoutPaymentAttempt");
  }
  if (input.attempt.attempt.state !== "CONFIRMED") {
    throw new ValidationError(
      "settlement executes only on a CONFIRMED attempt (INV-F06: no financial mutation bypasses the lifecycle rules)",
      { attemptId: input.attempt.attempt.id, state: input.attempt.attempt.state },
    );
  }
  if (typeof input.protocolInstructionId !== "string" || input.protocolInstructionId.length === 0) {
    throw new ValidationError("a settlement requires the protocol settlement instruction id");
  }
  if (
    !Array.isArray(input.protocolSettlementAttemptIds) ||
    input.protocolSettlementAttemptIds.length === 0 ||
    !input.protocolSettlementAttemptIds.every((id) => typeof id === "string" && id.length > 0)
  ) {
    throw new ValidationError("a settlement requires non-empty protocol settlement attempt ids");
  }
  if (typeof input.now !== "bigint") {
    throw new ValidationError("now must be a bigint TimestampMs");
  }
  const attempt = attachAttemptSettlement(input.attempt, {
    settlementInstructionId: input.protocolInstructionId,
    settlementAttemptIds: input.protocolSettlementAttemptIds,
    now: input.now,
  });

  if (input.selection.selected === "NATIVE_STRIPE_CRYPTO") {
    if (input.confirmationInput === undefined) {
      throw new ValidationError(
        "NATIVE_STRIPE_CRYPTO settlement requires a provider-verified confirmation input (the honest-unavailability law: never imply Stripe balance settlement without the provider's own confirmation)",
        { attemptId: input.attempt.attempt.id },
      );
    }
    const confirmation = recordStripeSettlementConfirmation(input.confirmationInput);
    if (confirmation.connectedInstanceId !== input.selection.route.connectedInstanceId) {
      throw new ValidationError(
        "the settlement confirmation must come from the same connected instance the route was selected on",
        {
          confirmationInstanceId: confirmation.connectedInstanceId,
          routeInstanceId: input.selection.route.connectedInstanceId,
        },
      );
    }
    const settlement: MerchantSettlementRecord = Object.freeze({
      settlementId: input.settlementId,
      attemptId: input.attempt.attempt.id,
      routeFamily: "NATIVE_STRIPE_CRYPTO",
      settlementMode: "NATIVE_STRIPE_CRYPTO",
      confirmation,
      recordedAt: input.now,
      evidenceIds: Object.freeze([...confirmation.evidenceIds]),
    });
    return Object.freeze({ attempt, settlement });
  }

  // EXTERNAL path: a native confirmation input is FORBIDDEN (disjointness).
  if (input.confirmationInput !== undefined) {
    throw new SettlementModeConflationError(
      "a PAYSWAP_EXTERNAL_SETTLEMENT settlement must not carry a NATIVE_STRIPE_CRYPTO confirmation input (disjoint fields both directions)",
    );
  }
  const settlement: MerchantSettlementRecord = Object.freeze({
    settlementId: input.settlementId,
    attemptId: input.attempt.attempt.id,
    routeFamily: "EXTERNAL_PAYSWAP_CONVERSION",
    settlementMode: "PAYSWAP_EXTERNAL_SETTLEMENT",
    instructionId: input.protocolInstructionId,
    settlementAttemptIds: Object.freeze([...input.protocolSettlementAttemptIds]),
    destinationId: input.selection.route.destination.id,
    recordedAt: input.now,
    evidenceIds: Object.freeze([
      `instruction:${input.protocolInstructionId}`,
      ...input.protocolSettlementAttemptIds.map((id) => `settlement-attempt:${id}`),
    ]),
  });
  return Object.freeze({ attempt, settlement });
}

/** Whether a settlement record implies a provider-verified Stripe balance effect. */
export function isProviderVerifiedStripeSettlementRecord(
  settlement: MerchantSettlementRecord,
): boolean {
  return (
    settlement.routeFamily === "NATIVE_STRIPE_CRYPTO" &&
    settlement.confirmation.confirmedByProvider === true
  );
}

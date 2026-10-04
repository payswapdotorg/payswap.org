/**
 * @payswap/route-compiler — the Stripe crypto-settlement leg contracts
 * (Work Order P4-W4-001, representative route 4).
 *
 * THE PROVIDER-VERIFIED-EFFECTS LAW (phase-4 state policy
 * `stripe_effects_must_be_provider_verified`; AGENTS.md rule 30:
 * "Stripe settlement is a capability only when the actual connected Stripe
 * account/transaction is eligible; never fabricate provider effects";
 * UNIVERSAL-MONEY-HANDOFF §21):
 *
 * - Mode A — NATIVE Stripe crypto settlement: when the merchant's Stripe
 *   account and the transaction are eligible, customer crypto settles
 *   through Stripe's actual supported crypto payment capability into the
 *   merchant's Stripe balance in fiat. PaySwap integrates with the REAL
 *   provider capability; it NEVER invents a synthetic Stripe balance
 *   credit.
 *
 * - Mode B — EXTERNAL PaySwap route: customer crypto is routed through
 *   PaySwap conversion/off-ramp to the merchant's supported settlement
 *   destination. The route must say explicitly: "Stripe balance settlement
 *   unavailable for this route." Never fake equivalent semantics.
 *
 * HONEST AUTHORITY STATUS: the actual Stripe integration waits on the
 * P4-W1-003 research artifacts (merchant crypto contracts + Stripe UX
 * research — the wave-1 work item that owns the Stripe crypto payment
 * contracts). This module therefore models the Mode A leg's CONTRACTS now:
 * the eligibility evidence shape, its provider-verified requirement, its
 * freshness law, and the settlement-observation shape every effect must
 * arrive through — each honestly marked `awaitingAuthority: "P4-W1-003"`.
 * The compiler will only compile a Mode A leg on top of eligibility
 * evidence that satisfies this contract; the evidence's provider
 * verification reference is an opaque artifact reference whose real
 * verification machinery (the Stripe-side capability the research artifacts
 * will pin down) is exactly what P4-W1-003 will supply.
 *
 * STRUCTURAL LAWS ENCODED HERE:
 * - no synthetic Stripe balance effects: a settlement effect exists ONLY
 *   as a provider-verified StripeSettlementObservation (verificationStatus
 *   SUCCESS/FAILURE — the paypal-direct provider-verification discipline:
 *   trust only the provider's own verification outcome; anything else is
 *   fail-closed OUTCOME_UNKNOWN);
 * - Mode A legs are provider-native baseline candidates (INV-C08): they
 *   are emitted, never structurally disadvantaged;
 * - when eligibility evidence is absent or stale, the honest marker is
 *   emitted (the Mode B notice) — never a fabricated Mode A leg.
 */

import { ValidationError } from "@payswap/protocol";

/**
 * The wave-1 work order whose research artifacts the actual Stripe crypto
 * settlement integration awaits. Every Mode A contract carries this marker.
 */
export const STRIPE_CRYPTO_SETTLEMENT_AUTHORITY = "P4-W1-003" as const;

/**
 * The spec name of the Mode A capability (UNIVERSAL-MONEY-HANDOFF §21:
 * "StripeMerchantSettlementCapability"). The registered capability id and
 * the real integration surface await the P4-W1-003/W4-002 authority — this
 * constant deliberately names the SPEC descriptor, not a fabricated
 * registered capability id.
 */
export const STRIPE_MERCHANT_SETTLEMENT_CAPABILITY =
  "StripeMerchantSettlementCapability" as const;

/** The Mode B honesty notice (verbatim from the handoff mandate). */
export const STRIPE_NATIVE_SETTLEMENT_UNAVAILABLE_NOTICE =
  "Stripe balance settlement unavailable for this route" as const;

/** The two explicit Stripe settlement modes (never conflated). */
export const STRIPE_SETTLEMENT_MODES = [
  "NATIVE_STRIPE_CRYPTO_SETTLEMENT",
  "EXTERNAL_PAYSWAP_ROUTE",
] as const;
export type StripeSettlementMode = (typeof STRIPE_SETTLEMENT_MODES)[number];

/** Raised when a Stripe crypto-settlement contract is violated (fail closed). */
export class InvalidStripeSettlementContractError extends ValidationError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidStripeSettlementContractError";
  }
}

// ---------------------------------------------------------------------------
// Mode A eligibility evidence (the provider-verified-effects law)
// ---------------------------------------------------------------------------

/**
 * Provider-verified eligibility evidence for one merchant Stripe account
 * and arrival currency: the ONLY grounding on which a native Stripe crypto
 * settlement leg may be compiled. `providerVerified: true` is structural —
 * evidence without provider verification cannot be represented, and the
 * verification reference is an opaque provider-side artifact (the actual
 * verification machinery awaits the P4-W1-003 research authority).
 */
export interface StripeCryptoSettlementEligibilityEvidence {
  readonly evidenceId: string;
  readonly stripeAccountRef: string;
  readonly currency: string;
  readonly eligible: true;
  readonly providerVerified: true;
  /** Opaque reference to the provider-side verification artifact. */
  readonly verificationRef: string;
  readonly observedAt: string;
  readonly freshness: { readonly asOf: string; readonly maxAgeSeconds: number };
  /** Honest marker: the real integration awaits the P4-W1-003 artifacts. */
  readonly awaitingAuthority: typeof STRIPE_CRYPTO_SETTLEMENT_AUTHORITY;
}

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/** Fail-closed validation of Mode A eligibility evidence (the contract of route 4's authorization). */
export function validateStripeCryptoSettlementEligibility(
  candidate: unknown,
): StripeCryptoSettlementEligibilityEvidence {
  if (candidate === null || typeof candidate !== "object") {
    throw new InvalidStripeSettlementContractError(
      "Stripe crypto settlement eligibility evidence is required for a native settlement leg",
    );
  }
  const record = candidate as Readonly<Record<string, unknown>>;
  for (const field of ["evidenceId", "stripeAccountRef", "verificationRef", "observedAt"] as const) {
    if (typeof record[field] !== "string" || (record[field] as string).length === 0) {
      throw new InvalidStripeSettlementContractError(
        `Stripe eligibility evidence requires a non-empty '${field}'`,
      );
    }
  }
  if (typeof record["currency"] !== "string" || !CURRENCY_PATTERN.test(record["currency"] as string)) {
    throw new InvalidStripeSettlementContractError(
      "Stripe eligibility evidence currency must be an uppercase 3-letter code (the merchant balance fiat currency)",
    );
  }
  if (record["eligible"] !== true) {
    throw new InvalidStripeSettlementContractError(
      "ineligible evidence never grounds a native settlement leg — only eligible: true is representable (ineligibility is surfaced as an honest exclusion, never as evidence)",
    );
  }
  if (record["providerVerified"] !== true) {
    throw new InvalidStripeSettlementContractError(
      "Stripe eligibility evidence MUST be provider-verified — unverified eligibility is structurally unrepresentable (the provider-verified-effects law)",
    );
  }
  const freshness = record["freshness"];
  if (
    freshness === null ||
    typeof freshness !== "object" ||
    typeof (freshness as Record<string, unknown>)["asOf"] !== "string" ||
    typeof (freshness as Record<string, unknown>)["maxAgeSeconds"] !== "number" ||
    !Number.isInteger((freshness as Record<string, unknown>)["maxAgeSeconds"]) ||
    (freshness as Record<string, unknown>)["maxAgeSeconds"] as number <= 0
  ) {
    throw new InvalidStripeSettlementContractError(
      "Stripe eligibility evidence requires freshness { asOf, maxAgeSeconds > 0 } — evidence without a freshness bound is not evidence (the observation law)",
    );
  }
  if (record["awaitingAuthority"] !== STRIPE_CRYPTO_SETTLEMENT_AUTHORITY) {
    throw new InvalidStripeSettlementContractError(
      `Stripe eligibility evidence must carry awaitingAuthority '${STRIPE_CRYPTO_SETTLEMENT_AUTHORITY}' — the actual integration's authority is never implied`,
    );
  }
  return Object.freeze({
    evidenceId: record["evidenceId"] as string,
    stripeAccountRef: record["stripeAccountRef"] as string,
    currency: record["currency"] as string,
    eligible: true,
    providerVerified: true,
    verificationRef: record["verificationRef"] as string,
    observedAt: record["observedAt"] as string,
    freshness: Object.freeze({
      asOf: (freshness as Record<string, unknown>)["asOf"] as string,
      maxAgeSeconds: (freshness as Record<string, unknown>)["maxAgeSeconds"] as number,
    }),
    awaitingAuthority: STRIPE_CRYPTO_SETTLEMENT_AUTHORITY,
  });
}

/**
 * The observation-law freshness probe for Stripe eligibility evidence
 * (isObservationFresh semantics): fresh ⟺ at − asOf ≤ maxAgeSeconds·1000.
 * Fail closed on unparseable timestamps.
 */
export function stripeEligibilityEvidenceIsFresh(
  evidence: StripeCryptoSettlementEligibilityEvidence,
  atMs: number,
): boolean {
  if (!Number.isInteger(atMs) || atMs < 0) {
    throw new InvalidStripeSettlementContractError(
      "stripeEligibilityEvidenceIsFresh: at must be a non-negative integer millisecond instant",
    );
  }
  const asOfMs = Date.parse(evidence.freshness.asOf);
  if (!Number.isFinite(asOfMs)) {
    return false;
  }
  return atMs - asOfMs <= evidence.freshness.maxAgeSeconds * 1000;
}

// ---------------------------------------------------------------------------
// Mode A settlement effects (never fabricated)
// ---------------------------------------------------------------------------

/**
 * A provider-verified Stripe settlement observation — the ONLY shape
 * through which a native Stripe crypto settlement effect exists. Mirrors
 * the rails provider-verification discipline: the provider's own
 * verification outcome (SUCCESS | FAILURE) is trusted; anything else is
 * OUTCOME_UNKNOWN, fail-closed, never guessed.
 */
export type StripeSettlementObservation =
  | {
      readonly observationId: string;
      readonly stripeAccountRef: string;
      readonly observedAt: string;
      readonly verificationStatus: "SUCCESS";
      readonly verificationRef: string;
    }
  | {
      readonly observationId: string;
      readonly stripeAccountRef: string;
      readonly observedAt: string;
      readonly verificationStatus: "FAILURE";
      readonly verificationRef: string;
    }
  | {
      readonly observationId: string;
      readonly stripeAccountRef: string;
      readonly observedAt: string;
      readonly verificationStatus: "OUTCOME_UNKNOWN";
      readonly unknownReason: string;
      readonly verificationRef?: string;
    };

/** Fail-closed validation of a Stripe settlement observation. */
export function validateStripeSettlementObservation(
  candidate: unknown,
): StripeSettlementObservation {
  if (candidate === null || typeof candidate !== "object") {
    throw new InvalidStripeSettlementContractError(
      "a Stripe settlement observation is required — effects are provider-observed, never minted",
    );
  }
  const record = candidate as Readonly<Record<string, unknown>>;
  for (const field of ["observationId", "stripeAccountRef", "observedAt"] as const) {
    if (typeof record[field] !== "string" || (record[field] as string).length === 0) {
      throw new InvalidStripeSettlementContractError(
        `Stripe settlement observation requires a non-empty '${field}'`,
      );
    }
  }
  const status = record["verificationStatus"];
  if (status === "SUCCESS" || status === "FAILURE") {
    if (typeof record["verificationRef"] !== "string" || (record["verificationRef"] as string).length === 0) {
      throw new InvalidStripeSettlementContractError(
        `a ${status} Stripe settlement observation requires the provider verification reference (the provider-verified-effects law)`,
      );
    }
    return Object.freeze({
      observationId: record["observationId"] as string,
      stripeAccountRef: record["stripeAccountRef"] as string,
      observedAt: record["observedAt"] as string,
      verificationStatus: status,
      verificationRef: record["verificationRef"] as string,
    });
  }
  if (status === "OUTCOME_UNKNOWN") {
    if (typeof record["unknownReason"] !== "string" || (record["unknownReason"] as string).length === 0) {
      throw new InvalidStripeSettlementContractError(
        "an OUTCOME_UNKNOWN Stripe settlement observation requires its unknownReason — UNKNOWN is honest and carries its reason (INV-X01)",
      );
    }
    return Object.freeze({
      observationId: record["observationId"] as string,
      stripeAccountRef: record["stripeAccountRef"] as string,
      observedAt: record["observedAt"] as string,
      verificationStatus: "OUTCOME_UNKNOWN" as const,
      unknownReason: record["unknownReason"] as string,
      ...(typeof record["verificationRef"] === "string"
        ? { verificationRef: record["verificationRef"] as string }
        : {}),
    });
  }
  throw new InvalidStripeSettlementContractError(
    `verificationStatus must be SUCCESS | FAILURE | OUTCOME_UNKNOWN (got: ${String(status)}) — never a guessed effect`,
  );
}

// ---------------------------------------------------------------------------
// The Mode B honesty marker
// ---------------------------------------------------------------------------

/**
 * The honest Mode B marker carried by external PaySwap routes compiled for
 * a Stripe-balance intent: native settlement is unavailable FOR THAT ROUTE
 * (absent, stale or ineligible evidence), and the external route says so —
 * never faked equivalence with the native semantics.
 */
export interface StripeNativeSettlementUnavailableMarker {
  readonly notice: typeof STRIPE_NATIVE_SETTLEMENT_UNAVAILABLE_NOTICE;
  readonly reason: string;
  readonly awaitingAuthority: typeof STRIPE_CRYPTO_SETTLEMENT_AUTHORITY;
}

export function stripeNativeSettlementUnavailable(
  reason: string,
): StripeNativeSettlementUnavailableMarker {
  if (reason.length === 0) {
    throw new InvalidStripeSettlementContractError(
      "the Mode B unavailability marker requires its honest reason",
    );
  }
  return Object.freeze({
    notice: STRIPE_NATIVE_SETTLEMENT_UNAVAILABLE_NOTICE,
    reason,
    awaitingAuthority: STRIPE_CRYPTO_SETTLEMENT_AUTHORITY,
  });
}

/**
 * @payswap/merchant-checkout — crypto acceptance activation (P4-W2-003 §3.2).
 *
 * The merchant-facing acceptance layer: an ACTIVATION record that COMPOSES
 * the @payswap/merchant-crypto acceptance contract (assets/chains/
 * constraints/expiry) — a typed view over it, never a copy. The composed
 * `MerchantCryptoAcceptancePolicy` is constructed through the landed
 * `defineMerchantCryptoAcceptancePolicy` (which itself requires the base
 * canonical policy to already declare STABLECOIN_CRYPTO); every evaluation
 * goes through the landed matchers.
 *
 * Laws:
 * - activation requires a VERIFIED merchant (or one already ACTIVE);
 * - deactivation preserves historical policy snapshots (immutable-history
 *   law): the activation record is frozen, deactivation returns a NEW
 *   record, and open checkout sessions keep their own snapshot
 *   (merchant-crypto's offered-assets law);
 * - this layer NEVER widens acceptance: it can only narrow to the composed
 *   crypto policy over the base policy.
 */

import { ValidationError } from "@payswap/protocol";
import type { TimestampMs } from "@payswap/protocol";
import type { AcceptanceRequest, PaymentAcceptancePolicy } from "@payswap/payment";
import type {
  CryptoAcceptanceDecision,
  CryptoAcceptanceRejectionReason,
} from "@payswap/merchant-crypto";
import {
  defineMerchantCryptoAcceptancePolicy,
  evaluateCryptoAcceptance,
  matchesCryptoAcceptance,
  offeredAssets,
} from "@payswap/merchant-crypto";
import type {
  CryptoAcceptanceRequest,
  CryptoAssetAcceptance,
  MerchantCryptoAcceptancePolicy,
  MerchantCryptoAcceptancePolicyId,
} from "@payswap/merchant-crypto";
import { merchantMayActivateCryptoAcceptance } from "./onboarding.js";
import type { MerchantProfile } from "./onboarding.js";

declare const CryptoAcceptanceActivationIdBrand: unique symbol;

/** Branded id of one crypto acceptance activation. */
export type CryptoAcceptanceActivationId = string & {
  readonly [CryptoAcceptanceActivationIdBrand]: "CryptoAcceptanceActivationId";
};

/** Activation lifecycle states. */
export type CryptoAcceptanceActivationState = "ACTIVE" | "DEACTIVATED";

/** Typed rejection reasons at the activation layer. */
export type AcceptanceActivationRejectionReason =
  | "MERCHANT_NOT_VERIFIED"
  | "ACTIVATION_INACTIVE";

/** The activation record: merchant + the COMPOSED crypto acceptance policy. */
export interface CryptoAcceptanceActivation {
  readonly id: CryptoAcceptanceActivationId;
  readonly merchantId: string;
  readonly state: CryptoAcceptanceActivationState;
  /** The composed merchant-crypto policy — the single source of acceptance truth. */
  readonly policy: MerchantCryptoAcceptancePolicy;
  readonly activatedAt: TimestampMs;
  /** Present iff deactivated. The original activation record stays immutable. */
  readonly deactivatedAt?: TimestampMs;
  readonly deactivationReason?: string;
}

/**
 * The checkout-facing typed VIEW over the composed policy: offered assets
 * (a fresh frozen snapshot per merchant-crypto's `offeredAssets`), quote
 * validity and the base policy reference. Derived only through the landed
 * merchant-crypto functions — this layer adds no acceptance vocabulary.
 */
export interface AcceptanceOfferView {
  readonly policyId: MerchantCryptoAcceptancePolicyId;
  readonly basePolicyId: string;
  readonly assets: readonly CryptoAssetAcceptance[];
  readonly quoteValidityMs: bigint;
}

/** Brand a validated string as a `CryptoAcceptanceActivationId`. */
export function asCryptoAcceptanceActivationId(
  value: string,
): CryptoAcceptanceActivationId {
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError(
      "CryptoAcceptanceActivationId must be a non-empty string",
      { value },
    );
  }
  if (value.length > 256) {
    throw new ValidationError("CryptoAcceptanceActivationId exceeds 256 characters", {
      value,
    });
  }
  if (value.trim() !== value) {
    throw new ValidationError(
      "CryptoAcceptanceActivationId must not carry surrounding whitespace",
      { value },
    );
  }
  return value as CryptoAcceptanceActivationId;
}

/**
 * Activate crypto acceptance for a merchant: composes the merchant-crypto
 * acceptance policy (constructed through the LANDED
 * `defineMerchantCryptoAcceptancePolicy` — which enforces that the base
 * canonical policy already declares STABLECOIN_CRYPTO) and requires the
 * merchant to be verified (VERIFIED or ACTIVE onboarding state). Fail-closed.
 */
export function activateCryptoAcceptance(input: {
  readonly id: string;
  readonly merchant: MerchantProfile;
  readonly policyInput: {
    readonly id: string;
    readonly merchantRef: string;
    readonly basePolicyId: string;
    readonly assets: readonly CryptoAssetAcceptance[];
    readonly quoteValidityMs: bigint;
  };
  readonly basePolicy: PaymentAcceptancePolicy;
  readonly now: TimestampMs;
}): CryptoAcceptanceActivation {
  const id = asCryptoAcceptanceActivationId(input.id);
  if (input.merchant === null || typeof input.merchant !== "object") {
    throw new ValidationError("activation requires a MerchantProfile", { id });
  }
  if (input.merchant.id !== input.policyInput.merchantRef) {
    throw new ValidationError(
      "the composed policy must reference the activating merchant exactly",
      { id, merchantId: input.merchant.id, policyMerchantRef: input.policyInput.merchantRef },
    );
  }
  if (!merchantMayActivateCryptoAcceptance(input.merchant)) {
    throw new ValidationError(
      "crypto acceptance activation requires a verified merchant (onboarding state VERIFIED or ACTIVE)",
      { id, merchantId: input.merchant.id, onboardingState: input.merchant.state },
    );
  }
  if (typeof input.now !== "bigint") {
    throw new ValidationError("now must be a bigint TimestampMs", { id });
  }
  const policy = defineMerchantCryptoAcceptancePolicy(
    input.policyInput,
    input.basePolicy,
  );
  return Object.freeze({
    id,
    merchantId: input.merchant.id,
    state: "ACTIVE",
    policy,
    activatedAt: input.now,
  });
}

/**
 * Deactivate crypto acceptance. Returns a NEW frozen record in the
 * DEACTIVATED state; the supplied original is never mutated (immutable
 * history: the historical policy snapshot — the composed policy record — is
 * preserved verbatim inside both records, and previously opened checkout
 * sessions keep their own offered-assets snapshot from open time).
 * Only legal on an ACTIVE activation.
 */
export function deactivateCryptoAcceptance(
  activation: CryptoAcceptanceActivation,
  input: { readonly reason: string; readonly now: TimestampMs },
): CryptoAcceptanceActivation {
  if (
    activation === null ||
    typeof activation !== "object" ||
    typeof activation.id !== "string" ||
    activation.id.length === 0
  ) {
    throw new ValidationError("deactivation requires a CryptoAcceptanceActivation");
  }
  if (typeof input.reason !== "string" || input.reason.length === 0) {
    throw new ValidationError("deactivation requires a non-empty reason", {
      activationId: activation.id,
    });
  }
  if (typeof input.now !== "bigint") {
    throw new ValidationError("now must be a bigint TimestampMs", {
      activationId: activation.id,
    });
  }
  if (activation.state !== "ACTIVE") {
    throw new ValidationError(
      "only an ACTIVE crypto acceptance activation can be deactivated",
      { activationId: activation.id, state: activation.state },
    );
  }
  return Object.freeze({
    ...activation,
    state: "DEACTIVATED",
    deactivatedAt: input.now,
    deactivationReason: input.reason,
  });
}

/**
 * The checkout-facing typed view over the composed policy. Offered assets
 * are re-snapshotted through the LANDED `offeredAssets` (fresh frozen
 * copies) so the view can never alias a mutable list.
 */
export function acceptanceOfferView(
  activation: CryptoAcceptanceActivation,
): AcceptanceOfferView {
  if (
    activation === null ||
    typeof activation !== "object" ||
    typeof activation.policy?.id !== "string"
  ) {
    throw new ValidationError("acceptanceOfferView requires a CryptoAcceptanceActivation");
  }
  const view: AcceptanceOfferView = Object.freeze({
    policyId: activation.policy.id,
    basePolicyId: activation.policy.basePolicyId,
    assets: offeredAssets(activation.policy),
    quoteValidityMs: activation.policy.quoteValidityMs,
  });
  return view;
}

/**
 * Deterministically evaluate a crypto acceptance request against the
 * activation. A DEACTIVATED activation rejects with the typed reason
 * ACTIVATION_INACTIVE (never an exception — a policy decision); an ACTIVE
 * activation delegates to the LANDED `matchesCryptoAcceptance` (the
 * landed rejection reasons pass through verbatim).
 */
export function activationMatches(
  activation: CryptoAcceptanceActivation,
  request: CryptoAcceptanceRequest,
  now: TimestampMs,
): {
  readonly accepted: boolean;
  readonly reasons: readonly (CryptoAcceptanceRejectionReason | AcceptanceActivationRejectionReason)[];
} {
  if (
    activation === null ||
    typeof activation !== "object" ||
    typeof activation.id !== "string"
  ) {
    throw new ValidationError("activationMatches requires a CryptoAcceptanceActivation");
  }
  if (activation.state !== "ACTIVE") {
    return Object.freeze({
      accepted: false,
      reasons: Object.freeze(["ACTIVATION_INACTIVE"] as const),
    });
  }
  const decision: CryptoAcceptanceDecision = matchesCryptoAcceptance(
    activation.policy,
    request,
    now,
  );
  return Object.freeze({
    accepted: decision.accepted,
    reasons: Object.freeze([...decision.reasons]),
  });
}

/**
 * Evaluate a request against BOTH planes through the LANDED
 * `evaluateCryptoAcceptance` (canonical base policy first, then the crypto
 * policy). Requires an ACTIVE activation; a deactivated activation rejects
 * with ACTIVATION_INACTIVE merged with whatever the crypto plane says.
 */
export function activationEvaluate(
  activation: CryptoAcceptanceActivation,
  basePolicy: PaymentAcceptancePolicy,
  request: CryptoAcceptanceRequest,
  baseRequest: AcceptanceRequest,
  now: TimestampMs,
): {
  readonly accepted: boolean;
  readonly reasons: readonly (CryptoAcceptanceRejectionReason | AcceptanceActivationRejectionReason)[];
} {
  if (
    activation === null ||
    typeof activation !== "object" ||
    typeof activation.id !== "string"
  ) {
    throw new ValidationError("activationEvaluate requires a CryptoAcceptanceActivation");
  }
  if (activation.state !== "ACTIVE") {
    return Object.freeze({
      accepted: false,
      reasons: Object.freeze(["ACTIVATION_INACTIVE"] as const),
    });
  }
  const decision: CryptoAcceptanceDecision = evaluateCryptoAcceptance(
    activation.policy,
    basePolicy,
    request,
    baseRequest,
    now,
  );
  return Object.freeze({
    accepted: decision.accepted,
    reasons: Object.freeze([...decision.reasons]),
  });
}

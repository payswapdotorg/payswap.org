/**
 * @payswap/merchant-crypto — merchant crypto acceptance policy (P4-W1-003).
 * Narrows the canonical PaymentAcceptancePolicy (which must already declare
 * the STABLECOIN_CRYPTO method kind) to the specific crypto assets/chains a
 * merchant accepts, with per-asset constraints (min/max, confirmations) and
 * quote-expiry semantics. This policy is a POLICY STATEMENT, never execution
 * authority (the canonical acceptance law); evaluation is deterministic with
 * typed rejection reasons.
 */

import { ValidationError } from '@payswap/protocol';
import type { TimestampMs } from '@payswap/protocol';
import { matchesAcceptance } from '@payswap/payment';
import type {
  AcceptanceDecision,
  AcceptanceRequest,
  PaymentAcceptancePolicy,
} from '@payswap/payment';
import { asChainId, asCryptoAssetId, compareCryptoAmounts } from './assets.js';
import type { ChainId, CryptoAmount, CryptoAssetId } from './assets.js';
import { isQuoteExpired } from './quotes.js';
import type { CryptoQuote } from './quotes.js';

declare const MerchantCryptoAcceptancePolicyIdBrand: unique symbol;

/** Branded id of one merchant crypto acceptance policy. */
export type MerchantCryptoAcceptancePolicyId = string & {
  readonly [MerchantCryptoAcceptancePolicyIdBrand]: 'MerchantCryptoAcceptancePolicyId';
};

/** Typed reason a crypto acceptance request does not match the policy. */
export type CryptoAcceptanceRejectionReason =
  | 'ASSET_NOT_ACCEPTED'
  | 'CHAIN_NOT_ACCEPTED'
  | 'AMOUNT_BELOW_MINIMUM'
  | 'AMOUNT_ABOVE_MAXIMUM'
  | 'QUOTE_EXPIRED'
  | 'QUOTE_ASSET_MISMATCH'
  | 'QUOTE_CHAIN_MISMATCH'
  | 'BASE_POLICY_REJECTED';

/** How many confirmations the merchant requires before treating a payment as settled. */
export interface ConfirmationPolicy {
  readonly requiredConfirmations: bigint;
}

/**
 * One accepted crypto asset: the chains it may be paid on, optional exact
 * min/max amounts (in the asset's OWN minor units, matching the assetId) and
 * the confirmation policy. `minAmount`/`maxAmount` are lower/upper bounds on
 * the payer-facing crypto amount.
 */
export interface CryptoAssetAcceptance {
  readonly assetId: CryptoAssetId;
  readonly chains: readonly ChainId[];
  readonly minAmount?: CryptoAmount;
  readonly maxAmount?: CryptoAmount;
  readonly confirmations: ConfirmationPolicy;
}

/** The merchant-scoped crypto acceptance policy (a narrowing statement). */
export interface MerchantCryptoAcceptancePolicy {
  readonly id: MerchantCryptoAcceptancePolicyId;
  readonly merchantRef: string;
  /** Id of the canonical PaymentAcceptancePolicy this policy narrows. */
  readonly basePolicyId: string;
  readonly assets: readonly CryptoAssetAcceptance[];
  /** How long quotes offered under this policy stay valid. */
  readonly quoteValidityMs: bigint;
}

/** A crypto acceptance request evaluated against the policy. */
export interface CryptoAcceptanceRequest {
  readonly assetId: CryptoAssetId;
  readonly chainId: ChainId;
  readonly amount: CryptoAmount;
  readonly quote?: CryptoQuote;
}

/** The explicit, deterministic crypto acceptance decision. */
export interface CryptoAcceptanceDecision {
  readonly accepted: boolean;
  readonly reasons: readonly CryptoAcceptanceRejectionReason[];
  /** The resolved per-asset acceptance, when the asset is accepted at all. */
  readonly asset?: CryptoAssetAcceptance;
}

/** Brand a validated string as a `MerchantCryptoAcceptancePolicyId`. */
export function asMerchantCryptoAcceptancePolicyId(
  value: string,
): MerchantCryptoAcceptancePolicyId {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError('MerchantCryptoAcceptancePolicyId must be a non-empty string', {
      value,
    });
  }
  if (value.length > 256) {
    throw new ValidationError('MerchantCryptoAcceptancePolicyId exceeds 256 characters', {
      value,
    });
  }
  if (value.trim() !== value) {
    throw new ValidationError(
      'MerchantCryptoAcceptancePolicyId must not carry surrounding whitespace',
      { value },
    );
  }
  return value as MerchantCryptoAcceptancePolicyId;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`${label} must be a non-empty string`, { label });
  }
  return value;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Structural check on a bound amount: it must be a CryptoAmount object whose
 * assetId matches the acceptance's asset (bounds live in the asset's own
 * minor units) and whose value is a non-negative bigint.
 */
function assertBoundAmount(
  amount: CryptoAmount,
  brandedAssetId: CryptoAssetId,
  label: string,
): void {
  if (amount === null || typeof amount !== 'object') {
    throw new ValidationError(`${label} must be a CryptoAmount`, { assetId: brandedAssetId });
  }
  if (typeof amount.value !== 'bigint' || amount.value < 0n) {
    throw new ValidationError(`${label}.value must be a non-negative bigint of minor units`, {
      assetId: brandedAssetId,
    });
  }
  if (amount.assetId !== brandedAssetId) {
    throw new ValidationError(
      `${label} must be denominated in the accepted asset (bounds live in the asset's own minor units)`,
      { assetId: brandedAssetId, boundAssetId: amount.assetId },
    );
  }
}

/**
 * Construct a validated, frozen per-asset acceptance. Chains are branded and
 * must be non-empty and unique; `requiredConfirmations` must be at least one;
 * optional min/max bounds must match the asset and, when both are present,
 * satisfy min ≤ max (exact bigint comparison).
 */
export function defineCryptoAssetAcceptance(input: {
  readonly assetId: string;
  readonly chains: readonly string[];
  readonly minAmount?: CryptoAmount;
  readonly maxAmount?: CryptoAmount;
  readonly requiredConfirmations: bigint;
}): CryptoAssetAcceptance {
  const assetId = asCryptoAssetId(input.assetId);
  if (!Array.isArray(input.chains) || input.chains.length === 0) {
    throw new ValidationError('a crypto asset acceptance must declare at least one chain', {
      assetId,
    });
  }
  const chains = input.chains.map((chain) => asChainId(chain));
  if (new Set<string>(chains).size !== chains.length) {
    throw new ValidationError('accepted chains must not repeat', { assetId, chains: [...chains] });
  }
  if (typeof input.requiredConfirmations !== 'bigint' || input.requiredConfirmations < 1n) {
    throw new ValidationError('requiredConfirmations must be a bigint of at least one', {
      assetId,
    });
  }
  if (input.minAmount !== undefined) {
    assertBoundAmount(input.minAmount, assetId, 'minAmount');
  }
  if (input.maxAmount !== undefined) {
    assertBoundAmount(input.maxAmount, assetId, 'maxAmount');
  }
  if (input.minAmount !== undefined && input.maxAmount !== undefined) {
    if (compareCryptoAmounts(input.minAmount, input.maxAmount) > 0) {
      throw new ValidationError('minAmount must not exceed maxAmount', { assetId });
    }
  }
  return Object.freeze({
    assetId,
    chains: Object.freeze(chains),
    ...(input.minAmount !== undefined ? { minAmount: input.minAmount } : {}),
    ...(input.maxAmount !== undefined ? { maxAmount: input.maxAmount } : {}),
    confirmations: Object.freeze({ requiredConfirmations: input.requiredConfirmations }),
  });
}

function isCryptoAssetAcceptanceShape(value: unknown): value is CryptoAssetAcceptance {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<CryptoAssetAcceptance>;
  return (
    isNonEmptyString(candidate.assetId) &&
    Array.isArray(candidate.chains) &&
    candidate.chains.length > 0 &&
    candidate.confirmations !== null &&
    typeof candidate.confirmations === 'object' &&
    typeof candidate.confirmations.requiredConfirmations === 'bigint' &&
    candidate.confirmations.requiredConfirmations >= 1n
  );
}

/**
 * Construct a validated, frozen merchant crypto acceptance policy. The base
 * canonical policy MUST already declare the STABLECOIN_CRYPTO method kind
 * (this policy narrows it, never widens it) and `input.basePolicyId` must
 * reference it exactly. Assets must be non-empty with unique assetIds
 * (construct them through `defineCryptoAssetAcceptance`).
 */
export function defineMerchantCryptoAcceptancePolicy(
  input: {
    readonly id: string;
    readonly merchantRef: string;
    readonly basePolicyId: string;
    readonly assets: readonly CryptoAssetAcceptance[];
    readonly quoteValidityMs: bigint;
  },
  basePolicy: PaymentAcceptancePolicy,
): MerchantCryptoAcceptancePolicy {
  const id = asMerchantCryptoAcceptancePolicyId(input.id);
  const merchantRef = requireNonEmptyString(input.merchantRef, 'merchantRef');
  const basePolicyId = requireNonEmptyString(input.basePolicyId, 'basePolicyId');
  if (basePolicy === null || typeof basePolicy !== 'object' || !Array.isArray(basePolicy.methods)) {
    throw new ValidationError('basePolicy must be a PaymentAcceptancePolicy', { id });
  }
  if (!basePolicy.methods.includes('STABLECOIN_CRYPTO')) {
    throw new ValidationError(
      'the base acceptance policy must declare the STABLECOIN_CRYPTO method kind',
      { id, basePolicyMethods: [...basePolicy.methods] },
    );
  }
  if (basePolicyId !== basePolicy.id) {
    throw new ValidationError(
      'basePolicyId must reference the base acceptance policy exactly',
      { id, basePolicyId, basePolicyActualId: basePolicy.id },
    );
  }
  if (!Array.isArray(input.assets) || input.assets.length === 0) {
    throw new ValidationError('a merchant crypto acceptance policy must declare at least one asset', {
      id,
    });
  }
  const seenAssetIds = new Set<string>();
  for (const asset of input.assets) {
    if (!isCryptoAssetAcceptanceShape(asset)) {
      throw new ValidationError(
        'each asset acceptance must be a CryptoAssetAcceptance built through defineCryptoAssetAcceptance',
        { id, assetId: (asset as Partial<CryptoAssetAcceptance>)?.assetId },
      );
    }
    if (seenAssetIds.has(asset.assetId)) {
      throw new ValidationError('accepted asset ids must not repeat', { id, assetId: asset.assetId });
    }
    seenAssetIds.add(asset.assetId);
  }
  if (typeof input.quoteValidityMs !== 'bigint' || input.quoteValidityMs <= 0n) {
    throw new ValidationError('quoteValidityMs must be a positive bigint', { id });
  }
  return Object.freeze({
    id,
    merchantRef,
    basePolicyId,
    assets: Object.freeze([...input.assets]),
    quoteValidityMs: input.quoteValidityMs,
  });
}

/**
 * Deterministically evaluate a crypto acceptance request against the crypto
 * policy. Every failure mode is a typed reason on the decision (deduplicated,
 * frozen). Amount/asset coherence: `request.amount.assetId` must equal
 * `request.assetId` — an amount denominated in a different asset is treated
 * as ASSET_NOT_ACCEPTED (the requested asset/amount pair is not one this
 * policy accepts), and the per-asset min/max bounds are not evaluated against
 * an incoherent amount (exact comparison requires a single asset).
 */
export function matchesCryptoAcceptance(
  policy: MerchantCryptoAcceptancePolicy,
  request: CryptoAcceptanceRequest,
  now: TimestampMs,
): CryptoAcceptanceDecision {
  if (policy === null || typeof policy !== 'object') {
    throw new ValidationError('policy must be a MerchantCryptoAcceptancePolicy');
  }
  if (
    request === null ||
    typeof request !== 'object' ||
    typeof request.assetId !== 'string' ||
    typeof request.chainId !== 'string' ||
    request.amount === null ||
    typeof request.amount !== 'object'
  ) {
    throw new ValidationError('request must be a CryptoAcceptanceRequest');
  }
  const reasons: CryptoAcceptanceRejectionReason[] = [];

  const asset = policy.assets.find((candidate) => candidate.assetId === request.assetId);
  if (asset === undefined) {
    reasons.push('ASSET_NOT_ACCEPTED');
  }
  const amountCoherent = request.amount.assetId === request.assetId;
  if (!amountCoherent) {
    reasons.push('ASSET_NOT_ACCEPTED');
  }

  if (asset !== undefined) {
    if (!asset.chains.includes(request.chainId)) {
      reasons.push('CHAIN_NOT_ACCEPTED');
    }
    if (amountCoherent && asset.minAmount !== undefined) {
      if (compareCryptoAmounts(request.amount, asset.minAmount) < 0) {
        reasons.push('AMOUNT_BELOW_MINIMUM');
      }
    }
    if (amountCoherent && asset.maxAmount !== undefined) {
      if (compareCryptoAmounts(request.amount, asset.maxAmount) > 0) {
        reasons.push('AMOUNT_ABOVE_MAXIMUM');
      }
    }
  }

  if (request.quote !== undefined) {
    const quote = request.quote;
    if (quote.assetId !== request.assetId) {
      reasons.push('QUOTE_ASSET_MISMATCH');
    }
    if (quote.chainId !== request.chainId) {
      reasons.push('QUOTE_CHAIN_MISMATCH');
    }
    if (isQuoteExpired(quote, now)) {
      reasons.push('QUOTE_EXPIRED');
    }
  }

  return Object.freeze({
    accepted: reasons.length === 0,
    reasons: Object.freeze([...new Set(reasons)]),
    ...(asset !== undefined ? { asset } : {}),
  });
}

/**
 * Evaluate a crypto acceptance request against BOTH planes: the canonical
 * acceptance law runs FIRST (`matchesAcceptance`); when the base policy
 * rejects, the merged decision lists BASE_POLICY_REJECTED plus whatever
 * crypto reasons also apply (the crypto matcher runs too, and reasons are
 * unioned). When the base policy accepts, the decision is the crypto
 * matcher's result alone. Frozen either way.
 */
export function evaluateCryptoAcceptance(
  policy: MerchantCryptoAcceptancePolicy,
  basePolicy: PaymentAcceptancePolicy,
  request: CryptoAcceptanceRequest,
  baseRequest: AcceptanceRequest,
  now: TimestampMs,
): CryptoAcceptanceDecision {
  const baseDecision: AcceptanceDecision = matchesAcceptance(basePolicy, baseRequest);
  const cryptoDecision = matchesCryptoAcceptance(policy, request, now);
  if (baseDecision.accepted) {
    return cryptoDecision;
  }
  const merged: CryptoAcceptanceRejectionReason[] = ['BASE_POLICY_REJECTED'];
  for (const reason of cryptoDecision.reasons) {
    if (!merged.includes(reason)) {
      merged.push(reason);
    }
  }
  return Object.freeze({
    accepted: false,
    reasons: Object.freeze(merged),
    ...(cryptoDecision.asset !== undefined ? { asset: cryptoDecision.asset } : {}),
  });
}

/**
 * A NEW frozen snapshot of the policy's offered assets (shallow copies of the
 * frozen entries) for checkout sessions: historical facts are immutable, so
 * later policy edits can never rewrite an open session's offer.
 */
export function offeredAssets(
  policy: MerchantCryptoAcceptancePolicy,
): readonly CryptoAssetAcceptance[] {
  if (policy === null || typeof policy !== 'object' || !Array.isArray(policy.assets)) {
    throw new ValidationError('policy must be a MerchantCryptoAcceptancePolicy');
  }
  return Object.freeze(policy.assets.map((asset) => Object.freeze({ ...asset })));
}

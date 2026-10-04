/**
 * @payswap/merchant-crypto — exact crypto quotes (P4-W1-003).
 *
 * A quote binds a fiat-priced amount to a crypto amount through an EXACT
 * rational ratio; fiat.value * ratio.denominator must equal
 * cryptoAmount.value * ratio.numerator (cross-multiplication, INV-F01 — no
 * floats, no rounding, no silent dust). Quotes expire; expiry is a
 * first-class deterministic check.
 */

import { ValidationError } from '@payswap/protocol';
import type { Money, TimestampMs } from '@payswap/protocol';
import type { MaterialTerms } from '@payswap/payment';
import {
  asChainId,
  asCryptoAssetId,
  isCryptoAmountPositive,
  type ChainId,
  type CryptoAmount,
  type CryptoAssetId,
} from './assets.js';

declare const QuoteIdBrand: unique symbol;

/** Branded id of one crypto quote. */
export type QuoteId = string & { readonly [QuoteIdBrand]: 'QuoteId' };

/**
 * EXACT rational exchange ratio: `numerator` fiat minor units per
 * `denominator` crypto minor units. Both terms must be positive bigints;
 * the ratio is only ever used through cross-multiplication, never as a
 * float (INV-F01).
 */
export interface ExactRatio {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

/**
 * An exact crypto quote for one asset on one chain. The fiat amount, crypto
 * amount and ratio satisfy the cross-multiplication invariant exactly; fees
 * share the fiat currency; `validUntil` is strictly after `quotedAt`.
 */
export interface CryptoQuote {
  readonly id: QuoteId;
  readonly assetId: CryptoAssetId;
  readonly chainId: ChainId;
  readonly fiatAmount: Money;
  readonly cryptoAmount: CryptoAmount;
  readonly ratio: ExactRatio;
  readonly fees: Money;
  readonly quotedAt: TimestampMs;
  readonly validUntil: TimestampMs;
  readonly sourceRef: string;
}

/** Raised when a quote violates the exactness or expiry contract. */
export class InvalidCryptoQuoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCryptoQuoteError';
  }
}

/** Brand a validated string as a `QuoteId`. */
export function asQuoteId(value: string): QuoteId {
  return brandId(value, 'QuoteId');
}

function brandId<TBranded extends string>(value: string, kind: string): TBranded {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`${kind} must be a non-empty string`, { kind, value });
  }
  if (value.length > 256) {
    throw new ValidationError(`${kind} exceeds 256 characters`, { kind, value });
  }
  if (value.trim() !== value) {
    throw new ValidationError(`${kind} must not carry surrounding whitespace`, { kind, value });
  }
  return value as TBranded;
}

/**
 * Construct a validated, frozen crypto quote.
 *
 * INV-F01 is structural: the quote is only accepted when
 * `fiatAmount.value * ratio.denominator === cryptoAmount.value * ratio.numerator`
 * exactly — cross-multiplied bigint equality, no floats, no rounding, no
 * silent dust. Anything else throws `InvalidCryptoQuoteError`.
 */
export function defineCryptoQuote(input: {
  readonly id: string;
  readonly assetId: string;
  readonly chainId: string;
  readonly fiatAmount: Money;
  readonly cryptoAmount: CryptoAmount;
  readonly ratio: ExactRatio;
  readonly fees: Money;
  readonly quotedAt: bigint;
  readonly validUntil: bigint;
  readonly sourceRef: string;
}): CryptoQuote {
  const id = asQuoteId(input.id);
  const assetId = asCryptoAssetId(input.assetId);
  const chainId = asChainId(input.chainId);
  const fiatAmount = input.fiatAmount;
  if (fiatAmount === null || typeof fiatAmount !== 'object' || typeof fiatAmount.value !== 'bigint') {
    throw new ValidationError('quote fiatAmount must be exact Money', { id });
  }
  if (fiatAmount.value <= 0n) {
    throw new ValidationError('quote fiatAmount must be positive', { id });
  }
  if (typeof fiatAmount.currency !== 'string' || fiatAmount.currency.length !== 3) {
    throw new ValidationError('quote fiat currency must be an ISO-style code', { id });
  }
  const cryptoAmount = input.cryptoAmount;
  if (cryptoAmount === null || typeof cryptoAmount !== 'object') {
    throw new ValidationError('quote cryptoAmount must be a CryptoAmount', { id });
  }
  if (!isCryptoAmountPositive(cryptoAmount)) {
    throw new ValidationError('quote cryptoAmount must be positive', { id });
  }
  if (cryptoAmount.assetId !== assetId) {
    throw new ValidationError('quote cryptoAmount must be denominated in the quoted asset', { id });
  }
  const ratio = input.ratio;
  if (
    ratio === null ||
    typeof ratio !== 'object' ||
    typeof ratio.numerator !== 'bigint' ||
    typeof ratio.denominator !== 'bigint'
  ) {
    throw new ValidationError('quote ratio must be an ExactRatio of bigints', { id });
  }
  if (ratio.numerator <= 0n || ratio.denominator <= 0n) {
    throw new ValidationError('quote ratio terms must be positive bigints', { id });
  }
  const fees = input.fees;
  if (fees === null || typeof fees !== 'object' || typeof fees.value !== 'bigint') {
    throw new ValidationError('quote fees must be exact Money', { id });
  }
  if (fees.value < 0n) {
    throw new ValidationError('quote fees must be non-negative (zero fees are allowed)', { id });
  }
  if (fees.currency !== fiatAmount.currency) {
    throw new ValidationError('quote fees must share the fiat currency', {
      id,
      fiatCurrency: fiatAmount.currency,
      feeCurrency: fees.currency,
    });
  }
  if (typeof input.quotedAt !== 'bigint' || typeof input.validUntil !== 'bigint') {
    throw new ValidationError('quote timestamps must be bigint TimestampMs', { id });
  }
  if (input.quotedAt >= input.validUntil) {
    throw new ValidationError('quote validUntil must be strictly after quotedAt', { id });
  }
  if (typeof input.sourceRef !== 'string' || input.sourceRef.length === 0) {
    throw new ValidationError('quote sourceRef must be a non-empty string', { id });
  }
  if (input.sourceRef.length > 256) {
    throw new ValidationError('quote sourceRef exceeds 256 characters', { id });
  }
  if (fiatAmount.value * ratio.denominator !== cryptoAmount.value * ratio.numerator) {
    throw new InvalidCryptoQuoteError(
      'quote ratio is inconsistent with the quoted amounts (INV-F01: exact cross-multiplication required)',
    );
  }
  return Object.freeze({
    id,
    assetId,
    chainId,
    fiatAmount,
    cryptoAmount,
    ratio: Object.freeze({ numerator: ratio.numerator, denominator: ratio.denominator }),
    fees,
    quotedAt: input.quotedAt,
    validUntil: input.validUntil,
    sourceRef: input.sourceRef,
  });
}

/**
 * Deterministic expiry check. A quote expires AT its boundary:
 * `isQuoteExpired(quote, quote.validUntil)` is `true` — the last instant a
 * quote is usable is `validUntil - 1n`.
 */
export function isQuoteExpired(quote: CryptoQuote, now: TimestampMs): boolean {
  return now >= quote.validUntil;
}

/**
 * Deterministic canonical rendering of a crypto quote. Field-by-field —
 * never key-order JSON — so two structurally equal quotes always render
 * (and hash) identically.
 */
export function canonicalCryptoQuote(quote: CryptoQuote): string {
  return (
    `cryptoQuote|id:${quote.id}` +
    `|asset:${quote.assetId}` +
    `|chain:${quote.chainId}` +
    `|fiat:${quote.fiatAmount.currency}:${quote.fiatAmount.value}` +
    `|crypto:${quote.cryptoAmount.assetId}:${quote.cryptoAmount.value}` +
    `|ratio:${quote.ratio.numerator}/${quote.ratio.denominator}` +
    `|fees:${quote.fees.currency}:${quote.fees.value}` +
    `|quotedAt:${quote.quotedAt}` +
    `|validUntil:${quote.validUntil}` +
    `|source:${quote.sourceRef}`
  );
}

/** Deterministic hash of a crypto quote (canonical rendering + FNV-1a 64). */
export function cryptoQuoteHash(quote: CryptoQuote): string {
  const canonical = canonicalCryptoQuote(quote);
  // FNV-1a over the canonical string with 64-bit bigint arithmetic —
  // deterministic, dependency-free, never used for security.
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < canonical.length; index += 1) {
    const code = canonical.charCodeAt(index);
    hash ^= BigInt(code);
    hash *= 0x100000001b3n;
    hash &= 0xffff_ffff_ffff_ffffn;
  }
  return `cqh:${hash.toString(16)}`;
}

/**
 * Derive the quote's validity boundary: `quotedAt + validityMs`. The
 * validity window must be a positive bigint duration — a non-positive
 * window would produce a quote that is born expired.
 */
export function quoteValidityWindow(input: {
  readonly quotedAt: bigint;
  readonly validityMs: bigint;
}): TimestampMs {
  if (typeof input.quotedAt !== 'bigint') {
    throw new ValidationError('quote validity window requires a bigint quotedAt');
  }
  if (typeof input.validityMs !== 'bigint' || input.validityMs <= 0n) {
    throw new ValidationError('quote validityMs must be a positive bigint');
  }
  return input.quotedAt + input.validityMs;
}

/**
 * Project a crypto quote onto the canonical `MaterialTerms` of
 * @payswap/payment: the payer-facing material terms of accepting this quote
 * are the quote's fiat amount, currency and fees plus the completion
 * deadline, recourse and settlement destination supplied by the caller.
 * `MaterialTerms` is a plain interface — the object is constructed directly
 * (not via `defineMaterialTerms`) and frozen; the fiat currency is still
 * shape-checked (3-character ISO-style code) so the direct construction
 * cannot bypass the canonical `defineMaterialTerms` currency guard.
 */
export function materialTermsFromQuote(
  quote: CryptoQuote,
  terms: {
    readonly completionMs: bigint;
    readonly recourse: string;
    readonly settlementDestinationId: string;
  },
): MaterialTerms {
  if (quote === null || typeof quote !== 'object') {
    throw new ValidationError('materialTermsFromQuote requires a CryptoQuote');
  }
  if (
    quote.fiatAmount === null ||
    typeof quote.fiatAmount !== 'object' ||
    typeof quote.fiatAmount.currency !== 'string' ||
    quote.fiatAmount.currency.length !== 3
  ) {
    throw new ValidationError('material terms currency must be an ISO-style code');
  }
  if (typeof terms.completionMs !== 'bigint' || terms.completionMs <= 0n) {
    throw new ValidationError('material terms completionMs must be a positive bigint');
  }
  if (typeof terms.recourse !== 'string' || terms.recourse.length === 0) {
    throw new ValidationError('material terms recourse must be a non-empty string');
  }
  if (
    typeof terms.settlementDestinationId !== 'string' ||
    terms.settlementDestinationId.length === 0
  ) {
    throw new ValidationError('material terms settlementDestinationId must be a non-empty string');
  }
  return Object.freeze({
    amount: quote.fiatAmount,
    currency: quote.fiatAmount.currency,
    fees: quote.fees,
    completionMs: terms.completionMs,
    recourse: terms.recourse,
    settlementDestinationId: terms.settlementDestinationId,
  });
}

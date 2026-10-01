/**
 * @payswap/protocol — FX quotes and exact value conversion (W1-003).
 *
 * FROZEN-ARCHITECTURE §10: "No floating-point money. FX values are
 * exact/provenanced."
 *
 * INV-F09: FX rate, fee and spread provenance is retained. An `FxQuote`
 * carries an EXACT rational rate (`numerator/denominator`, both bigint) plus
 * mandatory provenance (who published the rate, under what reference, when)
 * and optional fee/spread disclosures with their own provenance. A quote
 * without provenance cannot be constructed.
 *
 * `convert(money, quote, now)` performs EXACT rational arithmetic:
 *
 *   resultMinor = money.value × numerator / denominator
 *
 * with the SINGLE documented deterministic rounding rule applied only when
 * the rational result is not an integer — **banker's rounding (round half
 * to even)**:
 * - 2·rem < den  → round down (toward zero, magnitude-wise);
 * - 2·rem > den  → round up;
 * - 2·rem = den  → round to the even neighbor (0.5 → 0, 1.5 → 2, 2.5 → 2).
 *
 * The rule is bias-free over repeated conversions and is exercised
 * byte-for-byte in tests. No floating point exists anywhere in this module
 * (INV-F01). Expired quotes are rejected (`now > expiresAt`) — never
 * silently used.
 */

import { type CurrencyCode, type Money, fromMinorUnits } from './money.js';
import { PaySwapError, ValidationError, type PaySwapErrorDetails } from './errors.js';
import { InvalidIdentifierError } from './identifiers.js';
import type { TimestampMs } from './clock.js';

declare const FxQuoteIdBrand: unique symbol;

/** Branded id of one FX quote. */
export type FxQuoteId = string & { readonly [FxQuoteIdBrand]: 'FxQuoteId' };

/** An ordered currency pair: `base` is converted into `quote`. */
export interface FxPair {
  readonly base: CurrencyCode;
  readonly quote: CurrencyCode;
}

/**
 * EXACT rational rate: 1 minor unit of `pair.base` =
 * `numerator / denominator` minor units of `pair.quote`. Both parts are
 * positive bigints; the fraction need not be reduced but must be exact.
 */
export interface FxRate {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

/** Who disclosed an FX fee and under what reference (INV-F09). */
export interface FxFeeProvenance {
  readonly disclosedBy: string;
  readonly reference: string;
  /** Fixed fee attached to the quote, in the quote's currency. */
  readonly amount: Money;
}

/** Who disclosed the FX spread and under what reference (INV-F09). */
export interface FxSpreadProvenance {
  readonly disclosedBy: string;
  readonly reference: string;
  /** Spread in basis points (1 bp = 0.01%), exact bigint. */
  readonly basisPoints: bigint;
}

/**
 * INV-F09 provenance: the rate publication source plus any fee/spread
 * disclosures. Every quote MUST carry rate provenance.
 */
export interface FxProvenance {
  /** Who published the rate, e.g. `provider:fxcorp`. */
  readonly rateSource: string;
  /** The publisher's reference for this exact rate observation. */
  readonly rateSourceRef: string;
  readonly observedAt: TimestampMs;
  readonly fee?: FxFeeProvenance;
  readonly spread?: FxSpreadProvenance;
}

/** One exact, provenanced FX quote valid until `expiresAt`. */
export interface FxQuote {
  readonly id: FxQuoteId;
  readonly pair: FxPair;
  readonly rate: FxRate;
  /** Provider-facing reference for the quote itself. */
  readonly providerRef: string;
  readonly quotedAt: TimestampMs;
  readonly expiresAt: TimestampMs;
  readonly provenance: FxProvenance;
}

/** The quote does not convert the given currency. */
export class FxPairMismatchError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({ code: 'FX_PAIR_MISMATCH', category: 'VALIDATION', message, details });
  }
}

/** The quote is expired at the evaluation time — never silently used. */
export class ExpiredFxQuoteError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({ code: 'FX_QUOTE_EXPIRED', category: 'CONFLICT', message, details });
  }
}

/** The quote's window is not yet open at the evaluation time. */
export class FxQuoteNotYetValidError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({ code: 'FX_QUOTE_NOT_YET_VALID', category: 'CONFLICT', message, details });
  }
}

/** The rate is not a positive exact rational. */
export class InvalidFxRateError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({ code: 'INVALID_FX_RATE', category: 'VALIDATION', message, details });
  }
}

/** Provenance is missing or malformed (INV-F09 is not waivable). */
export class FxProvenanceMissingError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({ code: 'FX_PROVENANCE_MISSING', category: 'VALIDATION', message, details });
  }
}

/** Brand a validated string as an `FxQuoteId`. */
export function asFxQuoteId(value: string): FxQuoteId {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidIdentifierError('FxQuoteId must be a non-empty string', { value });
  }
  if (value.length > 256) {
    throw new InvalidIdentifierError('FxQuoteId exceeds 256 characters', { value });
  }
  if (value.trim() !== value) {
    throw new InvalidIdentifierError('FxQuoteId must not carry surrounding whitespace', { value });
  }
  return value as FxQuoteId;
}

function assertRate(rate: FxRate, quoteId: FxQuoteId): void {
  if (rate === null || typeof rate !== 'object') {
    throw new InvalidFxRateError('rate must be an FxRate object', { quoteId });
  }
  if (typeof rate.numerator !== 'bigint' || typeof rate.denominator !== 'bigint') {
    throw new InvalidFxRateError('rate numerator/denominator must be bigints (INV-F01)', {
      quoteId,
    });
  }
  if (rate.numerator <= 0n || rate.denominator <= 0n) {
    throw new InvalidFxRateError('rate must be a strictly positive rational', {
      quoteId,
      numerator: rate.numerator.toString(),
      denominator: rate.denominator.toString(),
    });
  }
}

function assertProvenance(provenance: FxProvenance, quoteId: FxQuoteId): void {
  if (provenance === null || typeof provenance !== 'object') {
    throw new FxProvenanceMissingError('provenance must be an FxProvenance object', { quoteId });
  }
  if (
    typeof provenance.rateSource !== 'string' ||
    provenance.rateSource.length === 0 ||
    typeof provenance.rateSourceRef !== 'string' ||
    provenance.rateSourceRef.length === 0 ||
    typeof provenance.observedAt !== 'bigint'
  ) {
    throw new FxProvenanceMissingError(
      'rate provenance (rateSource, rateSourceRef, observedAt) is mandatory (INV-F09)',
      { quoteId },
    );
  }
  if (provenance.fee !== undefined) {
    const fee = provenance.fee;
    if (
      typeof fee.disclosedBy !== 'string' ||
      fee.disclosedBy.length === 0 ||
      typeof fee.reference !== 'string' ||
      fee.reference.length === 0 ||
      fee.amount === null ||
      typeof fee.amount !== 'object' ||
      typeof fee.amount.value !== 'bigint' ||
      fee.amount.value < 0n
    ) {
      throw new FxProvenanceMissingError('fee provenance must carry disclosedBy, reference and a non-negative exact amount', {
        quoteId,
      });
    }
  }
  if (provenance.spread !== undefined) {
    const spread = provenance.spread;
    if (
      typeof spread.disclosedBy !== 'string' ||
      spread.disclosedBy.length === 0 ||
      typeof spread.reference !== 'string' ||
      spread.reference.length === 0 ||
      typeof spread.basisPoints !== 'bigint' ||
      spread.basisPoints < 0n
    ) {
      throw new FxProvenanceMissingError(
        'spread provenance must carry disclosedBy, reference and a non-negative bigint basisPoints',
        { quoteId },
      );
    }
  }
}

/**
 * Construct a validated, frozen FX quote. INV-F09 is structural: the quote
 * cannot exist without rate provenance; fee/spread disclosures, when
 * present, must carry their own provenance references. `quotedAt` must not
 * be after `expiresAt`.
 */
export function defineFxQuote(input: {
  readonly id: string;
  readonly pair: FxPair;
  readonly rate: FxRate;
  readonly providerRef: string;
  readonly quotedAt: TimestampMs;
  readonly expiresAt: TimestampMs;
  readonly provenance: FxProvenance;
}): FxQuote {
  const id = asFxQuoteId(input.id);
  if (input.pair === null || typeof input.pair !== 'object') {
    throw new ValidationError('pair must be an FxPair', { quoteId: id });
  }
  if (typeof input.pair.base !== 'string' || input.pair.base.length === 0) {
    throw new ValidationError('pair.base must be a CurrencyCode', { quoteId: id });
  }
  if (typeof input.pair.quote !== 'string' || input.pair.quote.length === 0) {
    throw new ValidationError('pair.quote must be a CurrencyCode', { quoteId: id });
  }
  if (input.pair.base === input.pair.quote) {
    throw new ValidationError('an FX pair must cross two distinct currencies', { quoteId: id });
  }
  if (typeof input.providerRef !== 'string' || input.providerRef.length === 0) {
    throw new ValidationError('providerRef must be a non-empty string', { quoteId: id });
  }
  if (typeof input.quotedAt !== 'bigint' || typeof input.expiresAt !== 'bigint') {
    throw new ValidationError('quotedAt/expiresAt must be bigint TimestampMs', { quoteId: id });
  }
  if (input.expiresAt <= input.quotedAt) {
    throw new ValidationError('quote must expire strictly after it was quoted', { quoteId: id });
  }
  assertRate(input.rate, id);
  assertProvenance(input.provenance, id);
  if (input.provenance.observedAt > input.quotedAt) {
    throw new ValidationError('rate cannot be observed after the quote was made', { quoteId: id });
  }
  if (input.provenance.fee !== undefined && input.provenance.fee.amount.currency !== input.pair.quote) {
    throw new ValidationError('fee amount must be denominated in the pair quote currency', {
      quoteId: id,
    });
  }
  const provenance: FxProvenance = Object.freeze({
    rateSource: input.provenance.rateSource,
    rateSourceRef: input.provenance.rateSourceRef,
    observedAt: input.provenance.observedAt,
    ...(input.provenance.fee !== undefined ? { fee: Object.freeze({ ...input.provenance.fee }) } : {}),
    ...(input.provenance.spread !== undefined
      ? { spread: Object.freeze({ ...input.provenance.spread }) }
      : {}),
  });
  return Object.freeze({
    id,
    pair: Object.freeze({ base: input.pair.base, quote: input.pair.quote }),
    rate: Object.freeze({
      numerator: input.rate.numerator,
      denominator: input.rate.denominator,
    }),
    providerRef: input.providerRef,
    quotedAt: input.quotedAt,
    expiresAt: input.expiresAt,
    provenance,
  });
}

/**
 * Banker's rounding (round half to even) of the exact rational
 * `numerator / denominator`, applied to the MAGNITUDE with the sign
 * re-applied afterwards. `denominator` must be a positive bigint;
 * `numerator` may be any bigint. Deterministic: the same rational always
 * rounds to the same integer.
 */
export function roundHalfToEven(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new InvalidFxRateError('rounding requires a positive denominator', {
      numerator: numerator.toString(),
      denominator: denominator.toString(),
    });
  }
  const negative = numerator < 0n;
  const magnitude = negative ? -numerator : numerator;
  const floor = magnitude / denominator;
  const remainder = magnitude % denominator;
  const twiceRemainder = remainder * 2n;
  let rounded: bigint;
  if (twiceRemainder < denominator) {
    rounded = floor;
  } else if (twiceRemainder > denominator) {
    rounded = floor + 1n;
  } else {
    // Exact half: choose the even neighbor.
    rounded = floor % 2n === 0n ? floor : floor + 1n;
  }
  return negative ? -rounded : rounded;
}

/**
 * Exact conversion under a quote.
 *
 * Rules (all enforced, never silent):
 * - `quote.pair.base` must equal `money.currency` (else `FxPairMismatchError`);
 * - `now` must lie within `[quotedAt, expiresAt]` — an expired quote throws
 *   `ExpiredFxQuoteError`, a not-yet-quoted one `FxQuoteNotYetValidError`;
 * - the result is `money.value × numerator / denominator` in the pair's
 *   quote currency, rounded by documented banker's rounding ONLY when the
 *   exact rational is not already an integer.
 *
 * The output is a new exact `Money`; no floating point is ever touched.
 */
export function convert(money: Money, quote: FxQuote, now: TimestampMs): Money {
  if (money === null || typeof money !== 'object') {
    throw new ValidationError('money must be a Money object');
  }
  if (typeof money.value !== 'bigint') {
    throw new ValidationError('money.value must be a bigint (INV-F01)');
  }
  if (quote === null || typeof quote !== 'object') {
    throw new ValidationError('quote must be an FxQuote');
  }
  if (typeof now !== 'bigint') {
    throw new ValidationError('now must be a bigint TimestampMs');
  }
  if (money.currency !== quote.pair.base) {
    throw new FxPairMismatchError('the quote does not convert the money currency', {
      quoteId: quote.id,
      pairBase: quote.pair.base,
      moneyCurrency: money.currency,
    });
  }
  if (now > quote.expiresAt) {
    throw new ExpiredFxQuoteError('the quote is expired at the evaluation time', {
      quoteId: quote.id,
      expiresAt: quote.expiresAt.toString(),
      now: now.toString(),
    });
  }
  if (now < quote.quotedAt) {
    throw new FxQuoteNotYetValidError('the quote was not yet valid at the evaluation time', {
      quoteId: quote.id,
      quotedAt: quote.quotedAt.toString(),
      now: now.toString(),
    });
  }
  const numerator = money.value * quote.rate.numerator;
  const denominator = quote.rate.denominator;
  // Fast path: already exact.
  if (numerator % denominator === 0n) {
    return fromMinorUnits(quote.pair.quote, numerator / denominator);
  }
  return fromMinorUnits(quote.pair.quote, roundHalfToEven(numerator, denominator));
}

/**
 * The exact (unrounded) conversion as a rational, for audit and allocation
 * purposes: `{ numerator, denominator }` with the original sign. Use this
 * when downstream logic must not lose the sub-minor-unit remainder.
 */
export function exactConversion(
  money: Money,
  quote: FxQuote,
): { readonly numerator: bigint; readonly denominator: bigint } {
  if (money === null || typeof money !== 'object') {
    throw new ValidationError('money must be a Money object');
  }
  if (quote === null || typeof quote !== 'object') {
    throw new ValidationError('quote must be an FxQuote');
  }
  if (money.currency !== quote.pair.base) {
    throw new FxPairMismatchError('the quote does not convert the money currency', {
      quoteId: quote.id,
    });
  }
  return Object.freeze({
    numerator: money.value * quote.rate.numerator,
    denominator: quote.rate.denominator,
  });
}

/** Deterministic canonical serialization of a quote (audit/replay). */
export function canonicalFxQuote(quote: FxQuote): string {
  const fee =
    quote.provenance.fee !== undefined
      ? `|fee:${quote.provenance.fee.disclosedBy}/${quote.provenance.fee.reference}/${quote.provenance.fee.amount.currency}:${quote.provenance.fee.amount.value}`
      : '';
  const spread =
    quote.provenance.spread !== undefined
      ? `|spread:${quote.provenance.spread.disclosedBy}/${quote.provenance.spread.reference}/${quote.provenance.spread.basisPoints}bp`
      : '';
  return (
    `fxQuote|id:${quote.id}` +
    `|pair:${quote.pair.base}/${quote.pair.quote}` +
    `|rate:${quote.rate.numerator}/${quote.rate.denominator}` +
    `|providerRef:${quote.providerRef}` +
    `|quotedAt:${quote.quotedAt}` +
    `|expiresAt:${quote.expiresAt}` +
    `|rateSource:${quote.provenance.rateSource}/${quote.provenance.rateSourceRef}@${quote.provenance.observedAt}` +
    fee +
    spread
  );
}

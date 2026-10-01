import { describe, expect, it } from 'vitest';
import {
  EUR,
  ExpiredFxQuoteError,
  FxPairMismatchError,
  FxProvenanceMissingError,
  FxQuoteNotYetValidError,
  GHS,
  InvalidFxRateError,
  USD,
  canonicalFxQuote,
  convert,
  defineFxQuote,
  exactConversion,
  fromMinorUnits,
  roundHalfToEven,
  type FxQuote,
} from '../src/index.js';

function quote(
  overrides?: Partial<{
    id: string;
    numerator: bigint;
    denominator: bigint;
    expiresAt: bigint;
    quotedAt: bigint;
  }>,
): FxQuote {
  return defineFxQuote({
    id: overrides?.id ?? 'fxq-1',
    pair: { base: USD, quote: GHS },
    rate: {
      numerator: overrides?.numerator ?? 1_507n,
      denominator: overrides?.denominator ?? 100n,
    },
    providerRef: 'provider:fxcorp/quotes/77',
    quotedAt: overrides?.quotedAt ?? 1_000n,
    expiresAt: overrides?.expiresAt ?? 60_000n,
    provenance: {
      rateSource: 'provider:fxcorp',
      rateSourceRef: 'rate/2026-10-01/USD-GHS',
      observedAt: 900n,
      fee: {
        disclosedBy: 'provider:fxcorp',
        reference: 'fee-schedule/v3',
        amount: fromMinorUnits(GHS, 20n),
      },
      spread: {
        disclosedBy: 'provider:fxcorp',
        reference: 'spread-policy/q3',
        basisPoints: 35n,
      },
    },
  });
}

describe('defineFxQuote (INV-F09 — provenance is structural)', () => {
  it('constructs a frozen quote retaining rate, fee and spread provenance', () => {
    const q = quote();
    expect(q.pair.base).toBe(USD);
    expect(q.pair.quote).toBe(GHS);
    expect(q.rate.numerator).toBe(1_507n);
    expect(q.rate.denominator).toBe(100n);
    expect(q.provenance.rateSource).toBe('provider:fxcorp');
    expect(q.provenance.fee?.amount.value).toBe(20n);
    expect(q.provenance.spread?.basisPoints).toBe(35n);
  });

  it('rejects quotes without rate provenance (INV-F09 is not waivable)', () => {
    expect(() =>
      defineFxQuote({
        id: 'fxq-bad',
        pair: { base: USD, quote: EUR },
        rate: { numerator: 92n, denominator: 100n },
        providerRef: 'p',
        quotedAt: 1_000n,
        expiresAt: 60_000n,
        provenance: {
          rateSource: '',
          rateSourceRef: 'ref',
          observedAt: 900n,
        },
      }),
    ).toThrow(FxProvenanceMissingError);
  });

  it('rejects non-positive rational rates and degenerate windows', () => {
    expect(() => quote({ numerator: 0n })).toThrow(InvalidFxRateError);
    expect(() => quote({ denominator: -100n })).toThrow(InvalidFxRateError);
    expect(() => quote({ expiresAt: 500n })).toThrow(/expire strictly after/);
  });

  it('serializes canonically for audit/replay (byte-identical)', () => {
    expect(canonicalFxQuote(quote())).toBe(canonicalFxQuote(quote()));
    expect(canonicalFxQuote(quote())).toContain('rate:1507/100');
    expect(canonicalFxQuote(quote())).toContain('spread:provider:fxcorp/spread-policy/q3/35bp');
  });
});

describe('roundHalfToEven (the documented deterministic rounding rule)', () => {
  it('rounds exact halves to the even neighbor', () => {
    expect(roundHalfToEven(5n, 2n)).toBe(2n); // 2.5 → 2
    expect(roundHalfToEven(7n, 2n)).toBe(4n); // 3.5 → 4
    expect(roundHalfToEven(1n, 2n)).toBe(0n); // 0.5 → 0
    expect(roundHalfToEven(3n, 2n)).toBe(2n); // 1.5 → 2
    expect(roundHalfToEven(25n, 10n)).toBe(2n); // 2.5 → 2
    expect(roundHalfToEven(35n, 10n)).toBe(4n); // 3.5 → 4
  });

  it('rounds non-halves by nearest and preserves sign', () => {
    expect(roundHalfToEven(11n, 10n)).toBe(1n); // 1.1 → 1
    expect(roundHalfToEven(19n, 10n)).toBe(2n); // 1.9 → 2
    expect(roundHalfToEven(15n, 10n)).toBe(2n); // 1.5 → 2
    expect(roundHalfToEven(-15n, 10n)).toBe(-2n); // −1.5 → −2 (even)
    expect(roundHalfToEven(-25n, 10n)).toBe(-2n); // −2.5 → −2 (even)
    expect(roundHalfToEven(-11n, 10n)).toBe(-1n); // −1.1 → −1
  });

  it('is deterministic under repetition', () => {
    const first = Array.from({ length: 25 }, (_, index) => roundHalfToEven(BigInt(index), 2n)).join(',');
    const second = Array.from({ length: 25 }, (_, index) => roundHalfToEven(BigInt(index), 2n)).join(',');
    expect(first).toBe(second);
  });
});

describe('convert (exact rational conversion)', () => {
  it('converts exactly when the rational result is an integer', () => {
    // rate 2/1: 50 USD → 100 GHS
    const q = quote({ numerator: 2n, denominator: 1n });
    const result = convert(fromMinorUnits(USD, 50n), q, 5_000n);
    expect(result.currency).toBe(GHS);
    expect(result.value).toBe(100n);
  });

  it('converts with exact rational arithmetic and applies banker\'s rounding only when needed', () => {
    // rate 1507/100 (15.07): 100n USD → 1507n GHS exactly
    const q = quote();
    expect(convert(fromMinorUnits(USD, 100n), q, 5_000n).value).toBe(1_507n);
    // 1n USD → 15.07 GHS exactly
    expect(convert(fromMinorUnits(USD, 1n), q, 5_000n).value).toBe(15n);
    // rate 1/2: 5n → 2.5 → 2 (banker's), 7n → 3.5 → 4 (banker's)
    const half = quote({ numerator: 1n, denominator: 2n });
    expect(convert(fromMinorUnits(USD, 5n), half, 5_000n).value).toBe(2n);
    expect(convert(fromMinorUnits(USD, 7n), half, 5_000n).value).toBe(4n);
    // determinism: identical inputs → identical outputs, byte-for-byte
    expect(
      Array.from({ length: 10 }, () =>
        convert(fromMinorUnits(USD, 123n), q, 5_000n).value.toString(),
      ).join(','),
    ).toBe(Array.from({ length: 10 }, () => '1854').join(','));
  });

  it('rejects pair mismatches, expired quotes and not-yet-valid quotes', () => {
    const q = quote();
    expect(() => convert(fromMinorUnits(EUR, 100n), q, 5_000n)).toThrow(FxPairMismatchError);
    expect(() => convert(fromMinorUnits(USD, 100n), q, 60_001n)).toThrow(ExpiredFxQuoteError);
    expect(() => convert(fromMinorUnits(USD, 100n), quote({ quotedAt: 3_000n }), 2_999n)).toThrow(
      FxQuoteNotYetValidError,
    );
  });

  it('exposes the unrounded rational for audit (exactConversion)', () => {
    const q = quote(); // 1507/100
    const exact = exactConversion(fromMinorUnits(USD, 5n), q);
    expect(exact.numerator).toBe(7_535n);
    expect(exact.denominator).toBe(100n);
    // and the rounded money matches roundHalfToEven of the same rational
    expect(convert(fromMinorUnits(USD, 5n), q, 5_000n).value).toBe(
      roundHalfToEven(7_535n, 100n),
    );
  });

  it('never touches floating point (INV-F01): inputs are bigint-only', () => {
    const q = quote({ numerator: 3n, denominator: 7n });
    // 3/7 is not representable exactly in binary floating point; bigint
    // rational arithmetic is exact: 7n * 3 / 7 = 3n exactly.
    expect(convert(fromMinorUnits(USD, 7n), q, 5_000n).value).toBe(3n);
    // 1n * 3/7 = 0.42857… → rounds to 0
    expect(convert(fromMinorUnits(USD, 1n), q, 5_000n).value).toBe(0n);
    // 5n * 3/7 = 2.142857… → rounds to 2
    expect(convert(fromMinorUnits(USD, 5n), q, 5_000n).value).toBe(2n);
  });
});

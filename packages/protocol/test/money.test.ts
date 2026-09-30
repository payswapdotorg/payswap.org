import { describe, expect, it } from 'vitest';
import {
  EUR,
  FloatMoneyRejectedError,
  GHS,
  JPY,
  NGN,
  PaySwapError,
  USD,
  ZAR,
  abs,
  add,
  allocate,
  compare,
  currencyCode,
  CurrencyMismatchError,
  CurrencyRedefinitionError,
  equals,
  fromDecimalString,
  fromMinorUnits,
  getCurrencyInfo,
  isNegative,
  isPositive,
  isZero,
  listCurrencies,
  MalformedMoneyStringError,
  multiplyByInteger,
  negate,
  registerCurrency,
  sub,
  UnknownCurrencyError,
  zero,
  type Money,
} from '../src/index.js';

describe('money: float rejection (INV-F01)', () => {
  it('rejects a JS number in fromMinorUnits, including 0.1', () => {
    expect(() => fromMinorUnits(USD, 0.1 as unknown as bigint)).toThrow(FloatMoneyRejectedError);
    expect(() => fromMinorUnits(USD, 0.1 as unknown as bigint)).toThrow(/INV-F01/);
    expect(() => fromMinorUnits(USD, 100 as unknown as bigint)).toThrow(FloatMoneyRejectedError);
    expect(() => fromMinorUnits(USD, Number.MAX_SAFE_INTEGER as unknown as bigint)).toThrow(
      FloatMoneyRejectedError,
    );
  });

  it('rejects a JS number in fromDecimalString', () => {
    expect(() => fromDecimalString(USD, 12.34 as unknown as string)).toThrow(FloatMoneyRejectedError);
  });

  it('rejects a float factor in multiplyByInteger', () => {
    const price = fromMinorUnits(USD, 1234n);
    expect(() => multiplyByInteger(price, 2.5 as unknown as bigint)).toThrow(FloatMoneyRejectedError);
  });

  it('rejects corrupted Money values carrying a JS number (defense in depth)', () => {
    const corrupted = { currency: 'USD', value: 0.1 } as unknown as Money;
    expect(() => add(corrupted, zero(USD))).toThrow(FloatMoneyRejectedError);
  });

  it('float rejections are PaySwapErrors with the stable code', () => {
    try {
      fromMinorUnits(USD, 0.1 as unknown as bigint);
      expect.unreachable('must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(PaySwapError);
      expect((error as FloatMoneyRejectedError).code).toBe('FLOAT_MONEY_REJECTED');
      expect((error as FloatMoneyRejectedError).category).toBe('VALIDATION');
    }
  });
});

describe('money: construction', () => {
  it('constructs from minor units', () => {
    const amount = fromMinorUnits(USD, 1234n);
    expect(amount.currency).toBe('USD');
    expect(amount.value).toBe(1234n);
  });

  it('constructs zero', () => {
    expect(zero(USD).value).toBe(0n);
    expect(isZero(zero(EUR))).toBe(true);
  });

  it('parses exact decimal strings', () => {
    expect(fromDecimalString(USD, '12.34').value).toBe(1234n);
    expect(fromDecimalString(USD, '0.01').value).toBe(1n);
    expect(fromDecimalString(USD, '0').value).toBe(0n);
    expect(fromDecimalString(USD, '007.50').value).toBe(750n);
    expect(fromDecimalString(USD, '-5.00').value).toBe(-500n);
    expect(fromDecimalString(JPY, '1000').value).toBe(1000n);
    expect(fromDecimalString(GHS, '10.55').value).toBe(1055n);
  });

  it('rejects malformed decimal strings', () => {
    for (const bad of ['', 'abc', '1.', '.5', '1.2.3', ' 12.34', '12.34 ', '+12.34', '1e5', '12,34', '-', '--5', '12..34']) {
      expect(() => fromDecimalString(USD, bad), `input ${JSON.stringify(bad)}`).toThrow(
        MalformedMoneyStringError,
      );
    }
  });

  it('rejects extra precision instead of rounding', () => {
    expect(() => fromDecimalString(USD, '12.345')).toThrow(MalformedMoneyStringError);
    expect(() => fromDecimalString(JPY, '12.0')).toThrow(MalformedMoneyStringError);
    expect(() => fromDecimalString(JPY, '12.5')).toThrow(MalformedMoneyStringError);
    try {
      fromDecimalString(USD, '0.001');
      expect.unreachable('must throw');
    } catch (error) {
      expect((error as MalformedMoneyStringError).details?.reason).toBe('EXTRA_PRECISION');
    }
  });

  it('rejects unknown and malformed currencies', () => {
    expect(() => currencyCode('XYZ')).toThrow(UnknownCurrencyError);
    expect(() => currencyCode('usd')).toThrow(UnknownCurrencyError);
    expect(getCurrencyInfo(JPY).minorUnitDigits).toBe(0);
    expect(getCurrencyInfo(USD).minorUnitDigits).toBe(2);
  });
});

describe('money: registry', () => {
  it('seeds the Stage 0 currencies', () => {
    const codes = listCurrencies().map((info) => info.code);
    for (const expected of ['USD', 'EUR', 'GBP', 'JPY', 'GHS', 'NGN', 'KES', 'ZAR']) {
      expect(codes).toContain(expected);
    }
  });

  it('lists currencies deterministically sorted by code', () => {
    const codes = listCurrencies().map((info) => info.code);
    const sorted = [...codes].sort();
    expect(codes).toEqual(sorted);
    expect(listCurrencies().map((info) => info.code)).toEqual(codes);
  });

  it('registerCurrency rejects malformed codes and digit ranges', () => {
    expect(() => currencyCode('XTS')).toThrow(UnknownCurrencyError);
  });

  it('rejects re-registration with different digits and tolerates identical digits', () => {
    const XTS = registerCurrency('XTS', 4);
    expect(fromDecimalString(XTS, '1.2345').value).toBe(12345n);
    // identical re-registration is idempotent
    expect(() => registerCurrency('XTS', 4)).not.toThrow();
    expect(() => registerCurrency('XTS', 2)).toThrow(CurrencyRedefinitionError);
    expect(() => registerCurrency('BAD', 9 as number)).toThrow(PaySwapError);
    expect(() => registerCurrency('bad', 2)).toThrow(PaySwapError);
    expect(() => registerCurrency('US', 2)).toThrow(PaySwapError);
  });
});

describe('money: arithmetic', () => {
  it('adds and subtracts exactly', () => {
    const a = fromMinorUnits(NGN, 1n);
    const b = fromMinorUnits(NGN, 2n);
    expect(add(a, b).value).toBe(3n);
    expect(sub(b, a).value).toBe(1n);
    expect(sub(a, b).value).toBe(-1n);
    // values beyond Number.MAX_SAFE_INTEGER stay exact
    const big = fromMinorUnits(USD, 9007199254740993n);
    expect(add(big, fromMinorUnits(USD, 1n)).value).toBe(9007199254740994n);
  });

  it('enforces same-currency operations', () => {
    const a = fromMinorUnits(USD, 100n);
    const b = fromMinorUnits(EUR, 100n);
    expect(() => add(a, b)).toThrow(CurrencyMismatchError);
    expect(() => sub(a, b)).toThrow(CurrencyMismatchError);
    expect(() => compare(a, b)).toThrow(CurrencyMismatchError);
  });

  it('compares within one currency', () => {
    const a = fromMinorUnits(ZAR, 100n);
    const b = fromMinorUnits(ZAR, 200n);
    expect(compare(a, b)).toBe(-1);
    expect(compare(b, a)).toBe(1);
    expect(compare(a, fromMinorUnits(ZAR, 100n))).toBe(0);
  });

  it('equality is structural; cross-currency equality is simply false', () => {
    expect(equals(fromMinorUnits(USD, 100n), fromMinorUnits(USD, 100n))).toBe(true);
    expect(equals(fromMinorUnits(USD, 100n), fromMinorUnits(USD, 101n))).toBe(false);
    expect(equals(fromMinorUnits(USD, 100n), fromMinorUnits(EUR, 100n))).toBe(false);
  });

  it('negate, abs and sign predicates', () => {
    const m = fromMinorUnits(USD, -500n);
    expect(negate(m).value).toBe(500n);
    expect(abs(m).value).toBe(500n);
    expect(abs(negate(m)).value).toBe(500n);
    expect(isNegative(m)).toBe(true);
    expect(isPositive(negate(m))).toBe(true);
    expect(isZero(zero(USD))).toBe(true);
    expect(isZero(m)).toBe(false);
  });

  it('multiplies by bigint factors exactly', () => {
    const unit = fromMinorUnits(USD, 199n);
    expect(multiplyByInteger(unit, 3n).value).toBe(597n);
    expect(multiplyByInteger(unit, 0n).value).toBe(0n);
    expect(multiplyByInteger(unit, -2n).value).toBe(-398n);
  });
});

describe('money: allocation (deterministic exact split)', () => {
  it('splits 100.00 into 3 parts whose sum is exactly 100.00', () => {
    const total = fromDecimalString(USD, '100');
    const parts = allocate(total, [1, 1, 1]);
    expect(parts.map((p) => p.value.toString())).toEqual(['3334', '3333', '3333']);
    const summed = parts.reduce((acc, p) => add(acc, p), zero(USD));
    expect(equals(summed, total)).toBe(true);
  });

  it('keeps the sum exact across a deterministic case matrix (no dust lost)', () => {
    const cases: readonly { readonly amount: bigint; readonly weights: readonly (number | bigint)[] }[] = [
      { amount: 10000n, weights: [1, 1, 1] },
      { amount: 10000n, weights: [1, 1, 1, 1] },
      { amount: 10000n, weights: [1, 1, 1, 1, 1, 1, 1] },
      { amount: 999n, weights: [2, 3, 5] },
      { amount: 1n, weights: [1, 1, 1] },
      { amount: 7n, weights: [1, 2] },
      { amount: 12345n, weights: [7, 11, 13] },
      { amount: 0n, weights: [3, 1] },
      { amount: 1000000n, weights: [1, 0, 0] },
    ];
    for (const [index, testCase] of cases.entries()) {
      const total = fromMinorUnits(USD, testCase.amount);
      const parts = allocate(total, testCase.weights);
      expect(parts).toHaveLength(testCase.weights.length);
      const summed = parts.reduce((acc, p) => add(acc, p), zero(USD));
      expect(equals(summed, total), `case ${index} must conserve the total`).toBe(true);
    }
  });

  it('allocates negative amounts symmetrically with exact conservation', () => {
    const total = fromMinorUnits(USD, -10000n);
    const parts = allocate(total, [1, 1, 1]);
    expect(parts.map((p) => p.value.toString())).toEqual(['-3334', '-3333', '-3333']);
    expect(equals(parts.reduce((acc, p) => add(acc, p), zero(USD)), total)).toBe(true);
  });

  it('breaks ties deterministically by lowest index', () => {
    const total = fromDecimalString(USD, '0.03');
    const parts = allocate(total, [1, 1, 1]);
    expect(parts.map((p) => p.value.toString())).toEqual(['1', '1', '1']);
    const split = allocate(fromDecimalString(USD, '0.02'), [1, 1, 1]);
    expect(split.map((p) => p.value.toString())).toEqual(['1', '1', '0']);
  });

  it('produces identical outputs for identical inputs (determinism)', () => {
    const total = fromDecimalString(USD, '99.99');
    const first = allocate(total, [3, 5, 7]).map((p) => p.value);
    const second = allocate(total, [3, 5, 7]).map((p) => p.value);
    expect(first).toEqual(second);
  });

  it('respects zero weights only after positive fractional remainders', () => {
    const parts = allocate(fromMinorUnits(USD, 1n), [0, 1]);
    expect(parts.map((p) => p.value.toString())).toEqual(['0', '1']);
  });

  it('rejects invalid weights', () => {
    const total = fromMinorUnits(USD, 100n);
    expect(() => allocate(total, [])).toThrow(PaySwapError);
    expect(() => allocate(total, [0, 0])).toThrow(PaySwapError);
    expect(() => allocate(total, [1, -1])).toThrow(PaySwapError);
    expect(() => allocate(total, [1, 0.5])).toThrow(PaySwapError);
    expect(() => allocate(total, [-1n, 1n])).toThrow(PaySwapError);
  });
});

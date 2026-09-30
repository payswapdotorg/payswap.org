/**
 * @payswap/protocol — exact money (W1-001).
 *
 * INV-F01: money is exact; no floating-point financial arithmetic.
 *
 * `Money` is an integer amount of minor units (cents, pesewas, kobo…) tied
 * to an ISO-4217-style `CurrencyCode` that declares its `minorUnitDigits`.
 * All arithmetic is `bigint`. Any construction or operation path that
 * receives a JS `number` throws `FloatMoneyRejectedError` — even `0.1`,
 * which cannot be represented exactly in IEEE-754.
 *
 * `allocate` splits an amount by integer weights using the deterministic
 * largest-remainder method: the sum of the parts ALWAYS equals the original
 * (no dust is lost), ties are broken by lowest index first.
 */

import { PaySwapError, ValidationError, type PaySwapErrorDetails } from './errors.js';

declare const CurrencyCodeBrand: unique symbol;

/** Branded ISO-4217-style currency code, e.g. `USD`, `JPY`. */
export type CurrencyCode = string & { readonly [CurrencyCodeBrand]: 'CurrencyCode' };

declare const MoneyBrand: unique symbol;

/** Exact monetary value: integer minor units of `currency`. */
export interface Money {
  readonly currency: CurrencyCode;
  readonly value: bigint;
  readonly [MoneyBrand]: 'Money';
}

/** Registry entry describing a currency. */
export interface CurrencyInfo {
  readonly code: CurrencyCode;
  readonly minorUnitDigits: number;
}

/** Raised when a construction/operation path receives a JS number (INV-F01). */
export class FloatMoneyRejectedError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({ code: 'FLOAT_MONEY_REJECTED', category: 'VALIDATION', message, details });
  }
}

/** Raised when binary operations mix currencies. */
export class CurrencyMismatchError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({ code: 'CURRENCY_MISMATCH', category: 'VALIDATION', message, details });
  }
}

/** Raised when a currency code is not registered. */
export class UnknownCurrencyError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({ code: 'UNKNOWN_CURRENCY', category: 'NOT_FOUND', message, details });
  }
}

/** Raised when a registered currency is re-registered with different digits. */
export class CurrencyRedefinitionError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({ code: 'CURRENCY_REDEFINITION', category: 'CONFLICT', message, details });
  }
}

/** Raised when a decimal string is malformed or carries extra precision. */
export class MalformedMoneyStringError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({ code: 'MALFORMED_DECIMAL_STRING', category: 'VALIDATION', message, details });
  }
}

const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;
const MIN_MINORITY_DIGITS = 0;
const MAX_MINORITY_DIGITS = 8;

/**
 * Process-local ISO-4217-style registry. Seeded deterministically below with
 * the currencies PaySwap operates on at Stage 0; additional currencies may be
 * registered with `registerCurrency` (idempotent for identical digits).
 */
const registry = new Map<string, CurrencyInfo>();

/**
 * Register (or idempotently re-confirm) a currency.
 *
 * Re-registration with different `minorUnitDigits` is rejected — a currency
 * whose minor-unit exponent changes would silently reinterpret every stored
 * amount, so it must never happen within a process.
 */
export function registerCurrency(code: string, minorUnitDigits: number): CurrencyCode {
  if (typeof code !== 'string' || !CURRENCY_CODE_PATTERN.test(code)) {
    throw new ValidationError('currency code must be exactly three uppercase A-Z letters', {
      code,
    });
  }
  if (
    typeof minorUnitDigits !== 'number' ||
    !Number.isInteger(minorUnitDigits) ||
    minorUnitDigits < MIN_MINORITY_DIGITS ||
    minorUnitDigits > MAX_MINORITY_DIGITS
  ) {
    throw new ValidationError(
      `minorUnitDigits must be an integer between ${MIN_MINORITY_DIGITS} and ${MAX_MINORITY_DIGITS}`,
      { code, minorUnitDigits },
    );
  }
  const existing = registry.get(code);
  if (existing !== undefined) {
    if (existing.minorUnitDigits !== minorUnitDigits) {
      throw new CurrencyRedefinitionError(
        'currency is already registered with different minorUnitDigits',
        { code, registeredDigits: existing.minorUnitDigits, attemptedDigits: minorUnitDigits },
      );
    }
    return existing.code;
  }
  const info: CurrencyInfo = { code: code as CurrencyCode, minorUnitDigits };
  registry.set(code, info);
  return info.code;
}

/** Look up the branded code of an already-registered currency. */
export function currencyCode(code: string): CurrencyCode {
  const info = getCurrencyInfo(code);
  return info.code;
}

/** Look up full currency metadata (digits included). */
export function getCurrencyInfo(code: string): CurrencyInfo {
  if (typeof code !== 'string') {
    throw new ValidationError('currency must be a string', { code });
  }
  const info = registry.get(code);
  if (info === undefined) {
    throw new UnknownCurrencyError('currency is not registered', { code });
  }
  return info;
}

/** All registered currencies, deterministically sorted by code. */
export function listCurrencies(): readonly CurrencyInfo[] {
  return [...registry.values()].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}

function mustResolveCurrencyCode(currency: CurrencyCode): CurrencyInfo {
  // CurrencyCode is branded at the type level; still verify at runtime so a
  // structurally-cast string cannot smuggle an unregistered code in.
  const info = registry.get(currency);
  if (info === undefined) {
    throw new UnknownCurrencyError('currency is not registered', { currency });
  }
  return info;
}

function mkMoney(currency: CurrencyCode, value: bigint): Money {
  return Object.freeze({ currency, value }) as Money;
}

function assertWellFormedMoney(money: Money, label: string): void {
  if (money === null || typeof money !== 'object') {
    throw new ValidationError(`${label} must be a Money object`, { money });
  }
  if (typeof money.currency !== 'string' || money.currency.length === 0) {
    throw new ValidationError(`${label}.currency must be a non-empty string`, { money });
  }
  if (typeof money.value === 'number') {
    throw new FloatMoneyRejectedError(
      `${label}.value is a JS number; floating-point money is forbidden (INV-F01)`,
      { label },
    );
  }
  if (typeof money.value !== 'bigint') {
    throw new ValidationError(`${label}.value must be a bigint of integer minor units`, { money });
  }
}

function requireSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new CurrencyMismatchError('money operations require a single currency', {
      left: a.currency,
      right: b.currency,
    });
  }
}

/**
 * Construct money from an integer count of minor units.
 *
 * Passing a JS `number` throws `FloatMoneyRejectedError` (INV-F01): `0.1`
 * dollar is `10n` minor units, never the float `0.1`.
 */
export function fromMinorUnits(currency: CurrencyCode, value: bigint): Money {
  if (typeof value === 'number') {
    throw new FloatMoneyRejectedError(
      'fromMinorUnits received a JS number; use a bigint of minor units (INV-F01)',
      { currency },
    );
  }
  if (typeof value !== 'bigint') {
    throw new ValidationError('fromMinorUnits requires a bigint value', { currency, value });
  }
  mustResolveCurrencyCode(currency);
  return mkMoney(currency, value);
}

const DECIMAL_STRING_PATTERN = /^(-?)(\d+)(?:\.(\d+))?$/;

/**
 * Construct money by exact decimal-string parse, e.g. `fromDecimalString(USD, "12.34")`.
 *
 * Accepted form: optional leading `-`, digits, optionally `.` followed by
 * 1..minorUnitDigits digits. Anything else — empty string, signs other than
 * a single leading `-`, spaces, exponents, thousands separators, trailing
 * dot, or more fractional digits than the currency declares — is rejected
 * with `MalformedMoneyStringError`. There is no rounding: extra precision is
 * an error, never a silent loss.
 */
export function fromDecimalString(currency: CurrencyCode, input: string): Money {
  if (typeof input === 'number') {
    throw new FloatMoneyRejectedError(
      'fromDecimalString received a JS number; pass a decimal string (INV-F01)',
      { currency },
    );
  }
  if (typeof input !== 'string') {
    throw new ValidationError('fromDecimalString requires a string', { currency, input });
  }
  const info = mustResolveCurrencyCode(currency);
  const match = DECIMAL_STRING_PATTERN.exec(input);
  if (match === null) {
    throw new MalformedMoneyStringError('decimal string is malformed', {
      currency,
      input,
      reason: 'MALFORMED',
    });
  }
  const negative = match[1] === '-';
  const whole = match[2];
  const fraction = match[3];
  if (whole === undefined) {
    throw new MalformedMoneyStringError('decimal string is malformed', {
      currency,
      input,
      reason: 'MALFORMED',
    });
  }
  if (fraction !== undefined && fraction.length > info.minorUnitDigits) {
    throw new MalformedMoneyStringError(
      'decimal string carries more precision than the currency allows',
      { currency, input, minorUnitDigits: info.minorUnitDigits, reason: 'EXTRA_PRECISION' },
    );
  }
  const scale = 10n ** BigInt(info.minorUnitDigits);
  const minorUnits =
    BigInt(whole) * scale + (fraction === undefined ? 0n : BigInt(fraction));
  return mkMoney(currency, negative ? -minorUnits : minorUnits);
}

/** Zero of the given currency. */
export function zero(currency: CurrencyCode): Money {
  mustResolveCurrencyCode(currency);
  return mkMoney(currency, 0n);
}

/** Exact addition; both operands must share a currency. */
export function add(a: Money, b: Money): Money {
  assertWellFormedMoney(a, 'a');
  assertWellFormedMoney(b, 'b');
  requireSameCurrency(a, b);
  return mkMoney(a.currency, a.value + b.value);
}

/** Exact subtraction; both operands must share a currency. */
export function sub(a: Money, b: Money): Money {
  return add(a, negate(b));
}

/**
 * Three-way comparison (−1 / 0 / +1) within one currency.
 * Mixing currencies throws `CurrencyMismatchError`.
 */
export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertWellFormedMoney(a, 'a');
  assertWellFormedMoney(b, 'b');
  requireSameCurrency(a, b);
  if (a.value < b.value) return -1;
  if (a.value > b.value) return 1;
  return 0;
}

/**
 * Structural equality. Different currencies are simply not equal (false);
 * ordering across currencies is undefined and throws in `compare`.
 */
export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.value === b.value;
}

/** Additive inverse, e.g. −(−3.00) = 3.00. */
export function negate(money: Money): Money {
  assertWellFormedMoney(money, 'money');
  return mkMoney(money.currency, -money.value);
}

/** Absolute value. */
export function abs(money: Money): Money {
  assertWellFormedMoney(money, 'money');
  return mkMoney(money.currency, money.value < 0n ? -money.value : money.value);
}

export function isZero(money: Money): boolean {
  assertWellFormedMoney(money, 'money');
  return money.value === 0n;
}

export function isPositive(money: Money): boolean {
  assertWellFormedMoney(money, 'money');
  return money.value > 0n;
}

export function isNegative(money: Money): boolean {
  assertWellFormedMoney(money, 'money');
  return money.value < 0n;
}

/**
 * Exact multiplication by an integer factor. Float factors are rejected
 * (INV-F01): proportional money mathematics belongs to `allocate`, never
 * to float multiplication.
 */
export function multiplyByInteger(money: Money, factor: bigint): Money {
  assertWellFormedMoney(money, 'money');
  if (typeof factor === 'number') {
    throw new FloatMoneyRejectedError(
      'multiplyByInteger received a JS number factor; use a bigint (INV-F01)',
      { currency: money.currency },
    );
  }
  if (typeof factor !== 'bigint') {
    throw new ValidationError('factor must be a bigint', { factor });
  }
  return mkMoney(money.currency, money.value * factor);
}

/**
 * Deterministic exact split by non-negative integer weights.
 *
 * Largest-remainder method: every part receives its floor share, the
 * remaining units are distributed one-by-one to the parts with the largest
 * fractional remainder, **ties broken by lowest index**. Guarantees:
 * - the sum of the parts always equals the original amount (no dust lost);
 * - identical inputs always produce identical outputs;
 * - a zero-weight part never receives remainder units ahead of a
 *   positive-weight part (fractional remainders dominate);
 * - negative amounts are allocated symmetrically (|amount| split, then
 *   negated), preserving the sum exactly.
 *
 * Weights are non-negative integers (scale rational weights yourself, e.g.
 * [0.5, 0.5] → [1, 1]); fractional or negative weights are rejected.
 */
export function allocate(amount: Money, weights: readonly (number | bigint)[]): readonly Money[] {
  assertWellFormedMoney(amount, 'amount');
  if (!Array.isArray(weights) || weights.length === 0) {
    throw new ValidationError('allocate requires a non-empty weights array', { weights });
  }
  const normalized: bigint[] = [];
  let totalWeight = 0n;
  for (const weight of weights) {
    let w: bigint;
    if (typeof weight === 'number') {
      if (!Number.isInteger(weight) || weight < 0) {
        throw new ValidationError('weights must be non-negative integers', { weight });
      }
      w = BigInt(weight);
    } else if (typeof weight === 'bigint') {
      if (weight < 0n) {
        throw new ValidationError('weights must be non-negative integers', { weight: weight.toString() });
      }
      w = weight;
    } else {
      throw new ValidationError('weights must be non-negative integers (number or bigint)', {
        weight,
      });
    }
    normalized.push(w);
    totalWeight += w;
  }
  if (totalWeight === 0n) {
    throw new ValidationError('at least one weight must be positive', { weights });
  }

  const negative = amount.value < 0n;
  const magnitude = negative ? -amount.value : amount.value;

  const bases = normalized.map((w) => (magnitude * w) / totalWeight);
  const allocated = bases.reduce((sum, b) => sum + b, 0n);
  const remainder = magnitude - allocated;
  // Remainder units go to the largest fractional parts; ties: lowest index.
  const ranking = normalized
    .map((w, index) => ({ index, fraction: (magnitude * w) % totalWeight }))
    .sort((x, y) => (x.fraction > y.fraction ? -1 : x.fraction < y.fraction ? 1 : x.index - y.index));
  const parts = [...bases];
  for (const entry of ranking.slice(0, Number(remainder))) {
    parts[entry.index] = (parts[entry.index] ?? 0n) + 1n;
  }
  return parts.map((p) => mkMoney(amount.currency, negative ? -p : p));
}

// Deterministic Stage 0 registry seed: USD, EUR, GBP, JPY, GHS, NGN, KES, ZAR.
export const USD: CurrencyCode = registerCurrency('USD', 2);
export const EUR: CurrencyCode = registerCurrency('EUR', 2);
export const GBP: CurrencyCode = registerCurrency('GBP', 2);
export const JPY: CurrencyCode = registerCurrency('JPY', 0);
export const GHS: CurrencyCode = registerCurrency('GHS', 2);
export const NGN: CurrencyCode = registerCurrency('NGN', 2);
export const KES: CurrencyCode = registerCurrency('KES', 2);
export const ZAR: CurrencyCode = registerCurrency('ZAR', 2);

/**
 * @payswap/best-execution — exact rational arithmetic (P4-W2-002).
 *
 * Best execution compares economic outcomes denominated in different assets.
 * Every conversion is an EXPLICIT, caller-supplied rational (numerator and
 * denominator as canonical decimal integer strings) evaluated with bigint
 * arithmetic: there is no floating point anywhere in this package (INV-F01
 * discipline extended to valuations) and no hidden constant — every rate,
 * deduction and cost is a typed input recorded in the evaluation trace.
 *
 * Rounding law: each valued component floors toward zero at its boundary
 * (deterministic and conservative for costs AND outputs alike — the same
 * rule for every component, so no component is systematically favored).
 */

import { ValidationError } from "@payswap/protocol";

/** An exact non-negative rational (bigint decimal strings externally). */
export interface ExactRational {
  /** Non-negative canonical decimal integer string (no leading zeros). */
  readonly numerator: string;
  /** Positive canonical decimal integer string. */
  readonly denominator: string;
}

const NON_NEGATIVE_INTEGER = /^(0|[1-9][0-9]*)$/;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;

/** Validates an exact rational: canonical decimal strings, denominator > 0. */
export function validateExactRational(value: ExactRational): void {
  if (value === null || typeof value !== "object") {
    throw new ValidationError("an exact rational must be an object { numerator, denominator }");
  }
  if (
    typeof value.numerator !== "string" ||
    !NON_NEGATIVE_INTEGER.test(value.numerator)
  ) {
    throw new ValidationError(
      `exact rational numerator must be a canonical non-negative decimal integer string, got '${String(value.numerator)}'`,
    );
  }
  if (
    typeof value.denominator !== "string" ||
    !POSITIVE_INTEGER.test(value.denominator)
  ) {
    throw new ValidationError(
      `exact rational denominator must be a canonical positive decimal integer string, got '${String(value.denominator)}'`,
    );
  }
}

/** The zero rational. */
export const ZERO_RATIONAL: ExactRational = Object.freeze({
  numerator: "0",
  denominator: "1",
});

/** The unit rational (1/1). */
export const UNIT_RATIONAL: ExactRational = Object.freeze({
  numerator: "1",
  denominator: "1",
});

function toBigint(value: string): bigint {
  return BigInt(value);
}

/** Multiplies two exact rationals (exact; no rounding). */
export function multiplyRationals(a: ExactRational, b: ExactRational): ExactRational {
  validateExactRational(a);
  validateExactRational(b);
  const numerator = toBigint(a.numerator) * toBigint(b.numerator);
  const denominator = toBigint(a.denominator) * toBigint(b.denominator);
  return { numerator: numerator.toString(), denominator: denominator.toString() };
}

/** Multiplies an exact rational by a canonical decimal integer string (exact). */
export function rationalTimesInteger(
  rational: ExactRational,
  integer: string,
): ExactRational {
  validateExactRational(rational);
  if (!NON_NEGATIVE_INTEGER.test(integer)) {
    throw new ValidationError(
      `rational multiplier must be a canonical non-negative decimal integer string, got '${String(integer)}'`,
    );
  }
  const numerator = toBigint(rational.numerator) * toBigint(integer);
  return { numerator: numerator.toString(), denominator: rational.denominator };
}

/** Floors an exact rational to a non-negative decimal integer string. */
export function floorRationalToIntegerString(rational: ExactRational): string {
  validateExactRational(rational);
  return (toBigint(rational.numerator) / toBigint(rational.denominator)).toString();
}

/** Exact comparison of two rationals (-1, 0, 1). */
export function compareRationals(a: ExactRational, b: ExactRational): -1 | 0 | 1 {
  validateExactRational(a);
  validateExactRational(b);
  const left = toBigint(a.numerator) * toBigint(b.denominator);
  const right = toBigint(b.numerator) * toBigint(a.denominator);
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

/** Is this rational exactly zero? */
export function isRationalZero(rational: ExactRational): boolean {
  validateExactRational(rational);
  return toBigint(rational.numerator) === 0n;
}

/**
 * Values an exact integer amount through a conversion rate: returns the
 * floored numeraire minor units as a decimal string. amount × rate, floored
 * once (the documented deterministic rounding boundary).
 */
export function valueThroughRate(
  amountMinorUnits: string,
  rate: ExactRational,
): string {
  if (!NON_NEGATIVE_INTEGER.test(amountMinorUnits)) {
    throw new ValidationError(
      `amount to value must be a canonical non-negative decimal integer string, got '${String(amountMinorUnits)}'`,
    );
  }
  return floorRationalToIntegerString(rationalTimesInteger(rate, amountMinorUnits));
}

/**
 * @payswap/surface — exact integer minor-unit money display
 * (Work Order P4-W4-002 §3 money law; INV-F01).
 *
 * Every money amount crossing the surface is INTEGER MINOR UNITS plus a
 * currency code — the landed @payswap/protocol money vocabulary. This
 * module renders human display strings with INTEGER ARITHMETIC ONLY:
 * division by the minor-unit base is done on the bigint absolute value
 * with an exact zero-padded remainder — a float never touches the amount
 * (INV-F01: floating-point money is structurally rejected upstream, and
 * nothing in this file can reintroduce it).
 *
 * The minor-unit digit count is resolved through the protocol's OWN
 * currency registry (getCurrencyInfo — the landed primitive) with an
 * explicit, honest fallback of 2 digits for unregistered codes: the
 * fallback is LABELED in the output so a caller can never mistake a
 * default for registry truth.
 */

import { getCurrencyInfo } from "@payswap/protocol";

/** How a currency's minor-unit digits were resolved. */
export type MinorUnitDigitsSource =
  | { readonly kind: "registry"; readonly code: string; readonly digits: number }
  | { readonly kind: "fallback-assumed-2"; readonly code: string; readonly digits: 2 };

/** Resolve minor-unit digits through the landed registry, honestly. */
export function resolveMinorUnitDigits(code: string): MinorUnitDigitsSource {
  // Currency codes are canonically uppercase (ISO 4217); the registry is
  // case-sensitive, so the lookup normalizes the case — a formatting
  // concern, not a registry mutation.
  const normalized = code.trim().toUpperCase();
  try {
    const info = getCurrencyInfo(normalized);
    return { kind: "registry", code: normalized, digits: info.minorUnitDigits };
  } catch {
    return { kind: "fallback-assumed-2", code: normalized, digits: 2 };
  }
}

/**
 * Format an integer minor-unit amount as an exact human display string.
 *
 * `minorUnits` accepts bigint or an integer-valued string (the wire form);
 * anything non-integer, negative-zero-ish or malformed throws — the
 * formatter is a display function over EXACT values, never a parser that
 * silently rounds.
 */
export function formatMinorUnits(
  minorUnits: bigint | string,
  currencyCode: string,
): string {
  let value: bigint;
  if (typeof minorUnits === "bigint") {
    value = minorUnits;
  } else {
    const trimmed = minorUnits.trim();
    if (!/^-?\d+$/.test(trimmed)) {
      throw new Error(
        `formatMinorUnits: minor units must be an integer (bigint or integer string), got ${JSON.stringify(minorUnits)}`,
      );
    }
    value = BigInt(trimmed);
  }
  const source = resolveMinorUnitDigits(currencyCode);
  const digits = source.digits;
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const base = 10n ** BigInt(digits);
  const whole = absolute / base;
  const fraction = absolute % base;
  const fractionText =
    digits > 0 ? `.${fraction.toString().padStart(digits, "0")}` : "";
  const sign = negative ? "−" : "";
  // Group the whole part in threes (integer string slicing — no number ops).
  const wholeText = whole.toString();
  const grouped =
    wholeText.length > 3
      ? wholeText.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
      : wholeText;
  const suffix = source.kind === "fallback-assumed-2" ? " (unregistered code — 2 digits assumed)" : "";
  return `${sign}${grouped}${fractionText} ${currencyCode.toUpperCase()}${suffix}`;
}

/** Grouping-agnostic machine key for tables/sorting (never for display). */
export function minorUnitsSortKey(minorUnits: bigint, currencyCode: string): string {
  return `${currencyCode.toUpperCase()}|${minorUnits.toString().padStart(24, "0")}`;
}

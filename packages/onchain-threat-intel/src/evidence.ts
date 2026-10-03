/**
 * @payswap/onchain-threat-intel — mandatory evidence chains
 * (Work Order P4-W3-003 hard requirement: "security signals link to
 * evidence — a signal without its evidence chain fails validation
 * structurally").
 *
 * Every threat signal carries a ThreatEvidence chain that names:
 * - WHICH OBSERVATION(S) produced it (`observationRefs` — ids of entries in
 *   the observation bundle: spender intelligence, token registry entries,
 *   oracle readings, bridge health, finality/mempool/domain observations,
 *   the simulation observation);
 * - WHICH DIGEST(S) it is bound to (`digestRefs` — the write digest, the
 *   simulation id, the bundle id, quote digests: the content-addressed
 *   anchors of the assessment);
 * - WHICH DELTA(S) it measured (`deltas` — exact structured observed-vs-
 *   expected values: price deviation bps, reorg depth blocks, slippage bps,
 *   unexpected minor-units debits, age in ms).
 *
 * `validateThreatEvidence` fails closed on an empty observation chain or an
 * empty digest chain: a signal without evidence is structurally invalid —
 * it cannot be constructed by any code path in this package (the agent
 * asserts every signal before the assessment is returned).
 *
 * Deltas carry EXACT canonical strings (integer strings or "num/den"
 * rationals) — never floating point (the repo's exact-arithmetic law).
 *
 * Deterministic only: pure data + pure functions.
 */

import { ValidationError } from "@payswap/protocol";

// ---------------------------------------------------------------------------
// Evidence deltas (exact observed-vs-expected records)
// ---------------------------------------------------------------------------

/** Units an evidence delta may carry (closed vocabulary, machine-readable). */
export const EVIDENCE_DELTA_UNITS = [
  "basis_points",
  "blocks",
  "minor_units",
  "milliseconds",
  "count",
  "boolean",
  "rational",
] as const;

export type EvidenceDeltaUnit = (typeof EVIDENCE_DELTA_UNITS)[number];

export function isEvidenceDeltaUnit(
  value: unknown,
): value is EvidenceDeltaUnit {
  return (
    typeof value === "string" &&
    (EVIDENCE_DELTA_UNITS as readonly unknown[]).includes(value)
  );
}

/** Canonical exact-value shapes: integer string or "num/den" rational. */
const INTEGER_PATTERN = /^(0|[1-9][0-9]*)$/;
const RATIONAL_PATTERN = /^(0|[1-9][0-9]*)\/([1-9][0-9]*)$/;
/** "true" | "false" for boolean deltas. */
const BOOLEAN_PATTERN = /^(true|false)$/;
/** Negative integers permitted for signed deltas (e.g. net balances). */
const SIGNED_INTEGER_PATTERN = /^(0|-?[1-9][0-9]*)$/;

/**
 * One exact observed-vs-expected delta. `observed` and `expected` are
 * canonical strings whose syntax is validated per `unit`:
 * - basis_points / count / blocks / milliseconds: non-negative integers;
 * - minor_units: signed integers (a delta may be a net debit);
 * - boolean: "true" | "false";
 * - rational: "num/den" with den > 0.
 */
export interface EvidenceDelta {
  /** Machine label, e.g. `price_deviation_bps`, `reorg_depth_blocks`. */
  readonly label: string;
  readonly unit: EvidenceDeltaUnit;
  /** The exact observed value (canonical string). */
  readonly observed: string;
  /** The exact expected/bounded value (canonical string). */
  readonly expected: string;
}

function validateExactValue(
  value: string,
  unit: EvidenceDeltaUnit,
  label: string,
  field: string,
): void {
  if (value.length === 0) {
    throw new ValidationError(
      `evidence delta '${label}': ${field} must be a non-empty canonical string`,
    );
  }
  const ok =
    unit === "rational"
      ? RATIONAL_PATTERN.test(value)
      : unit === "minor_units"
        ? SIGNED_INTEGER_PATTERN.test(value)
        : unit === "boolean"
          ? BOOLEAN_PATTERN.test(value)
          : INTEGER_PATTERN.test(value);
  if (!ok) {
    throw new ValidationError(
      `evidence delta '${label}': ${field} '${value}' is not a canonical ${unit} value`,
    );
  }
}

/** Validate one evidence delta (fail closed on any malformed field). */
export function validateEvidenceDelta(delta: EvidenceDelta): void {
  if (delta.label.length === 0) {
    throw new ValidationError("evidence delta label must not be empty");
  }
  if (!isEvidenceDeltaUnit(delta.unit)) {
    throw new ValidationError(
      `unknown evidence delta unit '${String(delta.unit)}'`,
    );
  }
  validateExactValue(delta.observed, delta.unit, delta.label, "observed");
  validateExactValue(delta.expected, delta.unit, delta.label, "expected");
}

/** Exact non-negative integer comparison of two canonical strings. */
export function compareExactIntegers(a: string, b: string): -1 | 0 | 1 {
  if (!INTEGER_PATTERN.test(a)) {
    throw new ValidationError(`'${a}' is not a canonical non-negative integer`);
  }
  if (!INTEGER_PATTERN.test(b)) {
    throw new ValidationError(`'${b}' is not a canonical non-negative integer`);
  }
  const left = BigInt(a);
  const right = BigInt(b);
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

/**
 * Exact rational comparison of two "num/den" values (cross-multiplication,
 * BigInt only — no floating point ever).
 */
export function compareExactRationals(a: string, b: string): -1 | 0 | 1 {
  const left = parseRational(a);
  const right = parseRational(b);
  const lhs = left.numerator * right.denominator;
  const rhs = right.numerator * left.denominator;
  if (lhs < rhs) {
    return -1;
  }
  return lhs > rhs ? 1 : 0;
}

/** Parse and validate a "num/den" rational (den > 0). */
export function parseRational(value: string): {
  numerator: bigint;
  denominator: bigint;
} {
  const match = RATIONAL_PATTERN.exec(value);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new ValidationError(
      `'${value}' is not a canonical rational (expected "num/den", den > 0)`,
    );
  }
  return { numerator: BigInt(match[1]), denominator: BigInt(match[2]) };
}

/**
 * The exact |a − b| deviation of two rationals, expressed in basis points
 * and returned as an exact canonical rational "num/den":
 * |a.num/a.den − b.num/b.den| · 10_000 = |a.num·b.den − b.num·a.den|·10_000
 * over a.den·b.den. Deterministic, exact, never negative.
 */
export function rationalDeviationBps(a: string, b: string): string {
  const left = parseRational(a);
  const right = parseRational(b);
  const numerator = left.numerator * right.denominator - right.numerator * left.denominator;
  const absNumerator = numerator < 0n ? -numerator : numerator;
  const denominator = left.denominator * right.denominator;
  return `${absNumerator * 10_000n}/${denominator}`;
}

/**
 * True iff the exact rational `value` is strictly greater than the integer
 * `integerLimit` (exact cross-multiplication; no floating point).
 */
export function rationalExceedsInteger(
  value: string,
  integerLimit: number,
): boolean {
  if (!Number.isInteger(integerLimit) || integerLimit < 0) {
    throw new ValidationError(
      "rationalExceedsInteger requires a non-negative integer limit",
    );
  }
  const rational = parseRational(value);
  return rational.numerator > rational.denominator * BigInt(integerLimit);
}

// ---------------------------------------------------------------------------
// The evidence chain
// ---------------------------------------------------------------------------

/**
 * The mandatory evidence chain of a threat signal. A signal without
 * observations (what was seen) or digests (what content it is bound to) is
 * structurally invalid: `validateThreatEvidence` throws.
 */
export interface ThreatEvidence {
  /** ≥ 1 observation ref: ids of entries in the observation bundle. */
  readonly observationRefs: readonly string[];
  /** ≥ 1 digest ref: content anchors (write digest, simulation id, bundle id...). */
  readonly digestRefs: readonly string[];
  /** Exact observed-vs-expected deltas (when the detection measured one). */
  readonly deltas?: readonly EvidenceDelta[];
  /** Human-readable chain summary (what linked what). */
  readonly note: string;
}

/** Raised when an evidence chain is structurally incomplete/invalid. */
export class ThreatEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThreatEvidenceError";
  }
}

/**
 * Validate a threat evidence chain (fail closed). Rules:
 * 1. at least one observationRef (WHICH observation produced the signal);
 * 2. at least one digestRef (WHICH digest the signal is bound to);
 * 3. every delta well-formed;
 * 4. the note is non-empty (the chain must be explainable).
 *
 * This is the structural enforcement of "security signals link to
 * evidence": an evidence-free signal cannot exist.
 */
export function validateThreatEvidence(
  evidence: ThreatEvidence,
  signalLabel: string,
): void {
  if (evidence.observationRefs.length === 0) {
    throw new ThreatEvidenceError(
      `threat signal '${signalLabel}': an empty observation chain is structurally invalid — every signal must name the observation(s) that produced it`,
    );
  }
  for (const ref of evidence.observationRefs) {
    if (ref.length === 0) {
      throw new ThreatEvidenceError(
        `threat signal '${signalLabel}': observationRefs contains an empty ref`,
      );
    }
  }
  if (evidence.digestRefs.length === 0) {
    throw new ThreatEvidenceError(
      `threat signal '${signalLabel}': an empty digest chain is structurally invalid — every signal must name the content digest(s) it is bound to`,
    );
  }
  for (const ref of evidence.digestRefs) {
    if (ref.length === 0) {
      throw new ThreatEvidenceError(
        `threat signal '${signalLabel}': digestRefs contains an empty ref`,
      );
    }
  }
  for (const delta of evidence.deltas ?? []) {
    validateEvidenceDelta(delta);
  }
  if (evidence.note.length === 0) {
    throw new ThreatEvidenceError(
      `threat signal '${signalLabel}': the evidence note must be non-empty — a chain nobody can read is not a chain`,
    );
  }
}

/** Deterministic deep copy helper (frozen, insert-order preserved). */
export function freezeEvidence(evidence: ThreatEvidence): ThreatEvidence {
  return Object.freeze({
    observationRefs: Object.freeze([...evidence.observationRefs]),
    digestRefs: Object.freeze([...evidence.digestRefs]),
    ...(evidence.deltas === undefined
      ? {}
      : { deltas: Object.freeze(evidence.deltas.map((d) => Object.freeze(d))) }),
    note: evidence.note,
  });
}

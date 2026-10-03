/**
 * @payswap/onchain-threat-intel — calibrated confidence
 * (Work Order P4-W3-003 hard requirement 1: "each signal carries ... a
 * calibrated confidence").
 *
 * Confidence is an EXACT INTEGER in basis points (0–10_000) — never a
 * floating point number (the repo's exact-arithmetic discipline applied to
 * the calibration model itself). Calibration is a deterministic pure
 * function of (detection method, corroborating observation count):
 *
 * - every detection method has an explicit base confidence (the calibration
 *   table, exported — no hidden constants);
 * - independent corroborating observations sharpen the signal by an
 *   explicit per-observation increment, capped;
 * - the result is quantized to whole basis points.
 *
 * The bands (high ≥ 8_500, medium ≥ 6_000, else low) are policy-facing:
 * a low-band signal cannot drive a BLOCK under the default policy floors
 * (./policy.ts) — a weak-evidence suspicion escalates to human
 * confirmation instead of an automated block. Calibrated ≠ arbitrary.
 *
 * Deterministic only: pure functions of explicit inputs.
 */

import { ValidationError } from "@payswap/protocol";

// ---------------------------------------------------------------------------
// Detection methods + the calibration table
// ---------------------------------------------------------------------------

/**
 * How a detection was made. The method determines the BASE confidence of
 * the signal (the calibration table below).
 */
export const DETECTION_METHODS = [
  /** Exact identity comparison failed/succeeded (address, digest, assetId). */
  "exact_identity_match",
  /** A structurally declared field diverged from the certified reference. */
  "structural_mismatch",
  /** A measured exact delta crossed an explicit threshold. */
  "threshold_breach",
  /** A behavioral pattern from intelligence (drain history, incidents). */
  "behavioral_pattern",
  /** Absence of required registry/health coverage (weakest evidence). */
  "registry_absence",
] as const;

export type DetectionMethod = (typeof DETECTION_METHODS)[number];

export function isDetectionMethod(value: unknown): value is DetectionMethod {
  return (
    typeof value === "string" &&
    (DETECTION_METHODS as readonly unknown[]).includes(value)
  );
}

/**
 * The calibration table: base confidence in basis points per method.
 * Explicit, versioned with this package, deterministic.
 */
export const METHOD_BASE_CONFIDENCE_BPS: Readonly<
  Record<DetectionMethod, number>
> = Object.freeze({
  exact_identity_match: 9_900,
  structural_mismatch: 9_000,
  threshold_breach: 8_000,
  behavioral_pattern: 7_000,
  registry_absence: 4_000,
});

/**
 * Per-independent-corroboration confidence increment (basis points), and
 * the cap on corroborating observations that may sharpen a signal.
 */
export const CORROBORATION_INCREMENT_BPS = 300;
export const MAX_CORROBORATING_OBSERVATIONS = 3;
export const MAX_CONFIDENCE_BPS = 10_000;

// ---------------------------------------------------------------------------
// Bands
// ---------------------------------------------------------------------------

/** Confidence bands (exact integer thresholds, basis points). */
export const CONFIDENCE_BAND_THRESHOLDS = Object.freeze({
  /** ≥ 8_500 → high. */
  high: 8_500,
  /** ≥ 6_000 → medium. */
  medium: 6_000,
});

export type ConfidenceBand = "high" | "medium" | "low";

/** Deterministic band of a confidence value (basis points). */
export function confidenceBand(confidenceBps: number): ConfidenceBand {
  assertConfidenceBps(confidenceBps);
  if (confidenceBps >= CONFIDENCE_BAND_THRESHOLDS.high) {
    return "high";
  }
  if (confidenceBps >= CONFIDENCE_BAND_THRESHOLDS.medium) {
    return "medium";
  }
  return "low";
}

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

function assertConfidenceBps(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > MAX_CONFIDENCE_BPS) {
    throw new ValidationError(
      `confidence must be an integer in [0, ${MAX_CONFIDENCE_BPS}] basis points, got '${String(value)}'`,
    );
  }
}

/**
 * Calibrate the confidence of one detection: the method's base confidence,
 * sharpened by independent corroborating observations (capped at
 * MAX_CORROBORATING_OBSERVATIONS increments, clamped at
 * MAX_CONFIDENCE_BPS). Deterministic pure function.
 */
export function calibrateConfidenceBps(
  method: DetectionMethod,
  corroboratingObservations: number,
): number {
  if (!isDetectionMethod(method)) {
    throw new ValidationError(
      `unknown detection method '${String(method)}'`,
    );
  }
  if (
    !Number.isInteger(corroboratingObservations) ||
    corroboratingObservations < 0
  ) {
    throw new ValidationError(
      "corroboratingObservations must be a non-negative integer",
    );
  }
  const capped = Math.min(
    corroboratingObservations,
    MAX_CORROBORATING_OBSERVATIONS,
  );
  const raw =
    METHOD_BASE_CONFIDENCE_BPS[method] + capped * CORROBORATION_INCREMENT_BPS;
  return Math.min(raw, MAX_CONFIDENCE_BPS);
}

/** Validate a confidence value (fail closed). */
export function validateConfidenceBps(confidenceBps: number): void {
  assertConfidenceBps(confidenceBps);
}

/** Render a confidence as a deterministic human string (e.g. "87.00%"). */
export function renderConfidence(confidenceBps: number): string {
  assertConfidenceBps(confidenceBps);
  const whole = Math.floor(confidenceBps / 100);
  const frac = confidenceBps % 100;
  return `${whole}.${frac.toString().padStart(2, "0")}%`;
}

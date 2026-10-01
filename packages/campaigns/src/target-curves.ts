/**
 * @payswap/campaigns — dynamic target curves (W3-005).
 *
 * PARTICIPATION-ENGINEERING §Dynamic incentives: programs may boost
 * participation below the target band, normalize inside the band and taper
 * above it. The emission multipliers live on the immutable IncentiveProgram
 * version (`EmissionPolicy`, W3-004); THIS module supplies the dynamic part —
 * the target curve that decides, at a point in time and a level of observed
 * participation, which emission level applies.
 *
 * Determinism contract (W3-005 §3.3): a target curve is a DETERMINISTIC
 * function of (time, observed participation, program version) — the same
 * inputs always produce the same curve point. Curves are declared as DATA
 * (no closures, no ambient state), fingerprinted with a stable digest, and
 * bound to exactly one program version; a curve change therefore requires a
 * NEW program version (INV-P07 — enforced in campaigns.ts
 * `IncentiveEpochViolationError` when a campaign epoch attempts to rebind a
 * changed curve, cap or band onto the same program version).
 *
 * All arithmetic is exact bigint math (INV-F01): linear interpolation uses
 * documented truncation toward zero; the tolerance band is basis points.
 */

import {
  ValidationError,
  type TimestampMs,
} from '@payswap/protocol';
import { stableDigest } from '@payswap/participation';
import type { EmissionLevel } from '@payswap/participation';

/** Deterministic target curve declarations (data, never closures). */
export type TargetCurveSpec =
  /** One constant target for the whole horizon. */
  | { readonly kind: 'CONSTANT'; readonly target: bigint }
  /** Linear interpolation between two (time, target) anchor points. */
  | {
      readonly kind: 'LINEAR_RAMP';
      readonly from: { readonly at: TimestampMs; readonly target: bigint };
      readonly to: { readonly at: TimestampMs; readonly target: bigint };
    }
  /** Step function: the last step whose `fromAt` <= `at` applies. */
  | {
      readonly kind: 'STEP_BANDS';
      readonly steps: readonly { readonly fromAt: TimestampMs; readonly target: bigint }[];
    };

/** Validate + freeze one curve declaration (throws ValidationError on bad shape). */
export function defineTargetCurve(spec: TargetCurveSpec): TargetCurveSpec {
  if (spec === null || typeof spec !== 'object') {
    throw new ValidationError('spec must be a TargetCurveSpec object');
  }
  switch (spec.kind) {
    case 'CONSTANT': {
      if (typeof spec.target !== 'bigint' || spec.target <= 0n) {
        throw new ValidationError('CONSTANT target must be a positive bigint');
      }
      return Object.freeze({ kind: spec.kind, target: spec.target });
    }
    case 'LINEAR_RAMP': {
      for (const anchor of [spec.from, spec.to]) {
        if (anchor === null || typeof anchor !== 'object') {
          throw new ValidationError('LINEAR_RAMP anchors must be objects');
        }
        if (typeof anchor.at !== 'bigint' || anchor.at < 0n) {
          throw new ValidationError('LINEAR_RAMP anchors must carry non-negative bigint `at`');
        }
        if (typeof anchor.target !== 'bigint' || anchor.target <= 0n) {
          throw new ValidationError('LINEAR_RAMP anchors must carry positive bigint targets');
        }
      }
      if (spec.to.at <= spec.from.at) {
        throw new ValidationError('LINEAR_RAMP must end strictly after it starts');
      }
      return Object.freeze({
        kind: spec.kind,
        from: Object.freeze({ ...spec.from }),
        to: Object.freeze({ ...spec.to }),
      });
    }
    case 'STEP_BANDS': {
      if (!Array.isArray(spec.steps) || spec.steps.length === 0) {
        throw new ValidationError('STEP_BANDS requires a non-empty steps array');
      }
      let previousAt: bigint | undefined;
      for (const step of spec.steps) {
        if (step === null || typeof step !== 'object') {
          throw new ValidationError('STEP_BANDS steps must be objects');
        }
        if (typeof step.fromAt !== 'bigint' || step.fromAt < 0n) {
          throw new ValidationError('STEP_BANDS steps must carry non-negative bigint fromAt');
        }
        if (typeof step.target !== 'bigint' || step.target <= 0n) {
          throw new ValidationError('STEP_BANDS steps must carry positive bigint targets');
        }
        if (previousAt !== undefined && step.fromAt <= previousAt) {
          throw new ValidationError('STEP_BANDS steps must be strictly ascending by fromAt');
        }
        previousAt = step.fromAt;
      }
      return Object.freeze({
        kind: spec.kind,
        steps: Object.freeze(spec.steps.map((step) => Object.freeze({ ...step }))),
      });
    }
  }
  throw new ValidationError('spec.kind is unknown');
}

/** Deterministic fingerprint of one curve declaration (INV-P03 input). */
export function targetCurveDigest(spec: TargetCurveSpec): string {
  switch (spec.kind) {
    case 'CONSTANT':
      return stableDigest(['curve', spec.kind, spec.target.toString()]);
    case 'LINEAR_RAMP':
      return stableDigest([
        'curve',
        spec.kind,
        `${spec.from.at}=${spec.from.target}`,
        `${spec.to.at}=${spec.to.target}`,
      ]);
    case 'STEP_BANDS':
      return stableDigest([
        'curve',
        spec.kind,
        ...spec.steps.map((step) => `${step.fromAt}=${step.target}`),
      ]);
  }
}

/**
 * Evaluate the declared target at a point in time — a PURE deterministic
 * function of (curve spec, time). LINEAR_RAMP interpolates with exact bigint
 * arithmetic (truncation toward zero documented); outside the anchor range
 * the nearest anchor applies (clamped). STEP_BANDS: the last step whose
 * `fromAt` <= `at` applies; before the first step the first step's target is
 * the declared baseline.
 */
export function evaluateTargetCurve(spec: TargetCurveSpec, at: TimestampMs): bigint {
  if (typeof at !== 'bigint') {
    throw new ValidationError('curve evaluation requires a bigint TimestampMs');
  }
  switch (spec.kind) {
    case 'CONSTANT':
      return spec.target;
    case 'LINEAR_RAMP': {
      if (at <= spec.from.at) {
        return spec.from.target;
      }
      if (at >= spec.to.at) {
        return spec.to.target;
      }
      const span = spec.to.at - spec.from.at;
      const rise = spec.to.target - spec.from.target;
      // Exact: from.target + rise * (at - from.at) / span, truncation toward
      // zero documented (bigint division truncates toward zero).
      return spec.from.target + (rise * (at - spec.from.at)) / span;
    }
    case 'STEP_BANDS': {
      let matched = spec.steps[0]?.target;
      if (matched === undefined) {
        throw new ValidationError('STEP_BANDS steps must not be empty');
      }
      for (const step of spec.steps) {
        if (step.fromAt <= at) {
          matched = step.target;
        }
      }
      return matched;
    }
  }
}

/** Declared tolerance band around the target (basis points, 1 bp = 0.01%). */
export interface TargetBand {
  /** Observed participation within ±toleranceBps of target counts IN band. */
  readonly toleranceBps: bigint;
}

/** Validate + freeze one tolerance band declaration. */
export function defineTargetBand(band: TargetBand): TargetBand {
  if (band === null || typeof band !== 'object') {
    throw new ValidationError('band must be a TargetBand object');
  }
  if (typeof band.toleranceBps !== 'bigint' || band.toleranceBps < 0n || band.toleranceBps > 10_000n) {
    throw new ValidationError('band.toleranceBps must be a bigint in [0, 10000]');
  }
  return Object.freeze({ toleranceBps: band.toleranceBps });
}

/** The resolved curve point: everything the emission decision needs. */
export interface CurvePoint {
  /** The declared target at the evaluation time. */
  readonly target: bigint;
  /** The observed participation the decision was made against. */
  readonly observedParticipation: bigint;
  /** Which emission regime applies (consumed with the program EmissionPolicy). */
  readonly emissionLevel: EmissionLevel;
  /** Whether the observation fell inside the declared tolerance band. */
  readonly withinBand: boolean;
  /** Fingerprint of (curve, time, observation, band) — reproducible (INV-P03). */
  readonly digest: string;
}

/**
 * Resolve one curve point: a PURE deterministic function of (curve spec,
 * time, observed participation, band) → target + emission level. The same
 * inputs ALWAYS produce the identical point and digest (INV-P02/P03
 * enforcement side). Below the band → BELOW_TARGET (boost), inside →
 * WITHIN_BAND (normalize), above → ABOVE_TARGET (taper).
 */
export function resolveCurvePoint(
  spec: TargetCurveSpec,
  observation: { readonly at: TimestampMs; readonly observedParticipation: bigint },
  band: TargetBand,
): CurvePoint {
  if (observation === null || typeof observation !== 'object') {
    throw new ValidationError('observation must be an object with at + observedParticipation');
  }
  if (typeof observation.observedParticipation !== 'bigint' || observation.observedParticipation < 0n) {
    throw new ValidationError('observedParticipation must be a non-negative bigint');
  }
  const target = evaluateTargetCurve(spec, observation.at);
  const observed = observation.observedParticipation;
  // Exact band edges: target * (10000 ∓ tolerance) / 10000 (truncation documented).
  const lower = (target * (10_000n - band.toleranceBps)) / 10_000n;
  const upper = (target * (10_000n + band.toleranceBps)) / 10_000n;
  let emissionLevel: EmissionLevel;
  let withinBand: boolean;
  if (observed < lower) {
    emissionLevel = 'BELOW_TARGET';
    withinBand = false;
  } else if (observed > upper) {
    emissionLevel = 'ABOVE_TARGET';
    withinBand = false;
  } else {
    emissionLevel = 'WITHIN_BAND';
    withinBand = true;
  }
  return Object.freeze({
    target,
    observedParticipation: observed,
    emissionLevel,
    withinBand,
    digest: stableDigest([
      targetCurveDigest(spec),
      band.toleranceBps.toString(),
      observation.at.toString(),
      observed.toString(),
      target.toString(),
      emissionLevel,
    ]),
  });
}

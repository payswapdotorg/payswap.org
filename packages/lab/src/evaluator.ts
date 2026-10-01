/**
 * Lab evaluator (W2-004; FROZEN-ARCHITECTURE §19 Lab "evaluation"; LAB.md
 * "Evaluation"; AGENTS.md rule 14).
 *
 * HARD CONSTRAINTS PRECEDE OPTIMIZATION (AGENTS.md rule 14: "Compliance,
 * sanctions, risk, policy and security constraints are hard constraints
 * before soft optimization"). This is enforced three ways:
 *
 * 1. RUNTIME: `evaluateRun` evaluates every hard constraint first and only
 *    then computes optimization contributions; a single hard-constraint
 *    failure marks the run `passed === false` regardless of how good the
 *    optimization score is.
 * 2. TYPE: `RunEvaluationResult.phases` is a TUPLE —
 *    `readonly [HardConstraintsPhase, OptimizationPhase]` — so the compiler
 *    itself guarantees the ordering can never be swapped.
 * 3. RANKING: `compareEvaluations` (see promotion.ts) filters on hard
 *    constraints BEFORE ordering by optimization score.
 *
 * All money-like quantities are exact bigint minor units (INV-F01); the
 * aggregate optimization score is an integer weighted sum — never floating
 * point.
 */

import { canonicalize, fnv1a64 } from "./simulation.js";
import type { SimulationProgram, SimulationRunResult } from "./simulation.js";

// ---------------------------------------------------------------------------
// Vocabulary (shared with Domain Packs)
// ---------------------------------------------------------------------------

/**
 * Hard constraints the built-in evaluator can check from simulation metrics.
 * Domain Packs declare a subset; anything NOT declared is not enforced by
 * this evaluator version.
 */
export const HARD_CONSTRAINT_IDS = [
  "AUTHORIZATION",
  "COMPLIANCE",
  "PRIVACY",
  "DEADLINE",
  "EXPLICIT_CREDIT",
] as const;
export type HardConstraintId = (typeof HARD_CONSTRAINT_IDS)[number];

export function isHardConstraintId(value: unknown): value is HardConstraintId {
  return (
    typeof value === "string" &&
    (HARD_CONSTRAINT_IDS as readonly unknown[]).includes(value)
  );
}

/** A hard constraint declaration inside a Domain Pack. */
export interface HardConstraintSpec {
  readonly constraintId: HardConstraintId;
  readonly description: string;
}

/**
 * Optimization objectives the built-in evaluator can score. All are
 * lower-is-better costs expressed in exact minor units (counts are priced
 * via the evaluation spec penalties so the aggregate stays a bigint).
 */
export const OBJECTIVE_IDS = [
  "TOTAL_COST",
  "ECONOMIC_COMPRESSION",
  "RESILIENCE",
  "LATENCY",
  "LIQUIDITY_LOCKED",
  "COUNTERPARTY_EXPOSURE",
  "OPERATIONAL_COMPLEXITY",
] as const;
export type ObjectiveId = (typeof OBJECTIVE_IDS)[number];

export function isObjectiveId(value: unknown): value is ObjectiveId {
  return (
    typeof value === "string" &&
    (OBJECTIVE_IDS as readonly unknown[]).includes(value)
  );
}

/** An optimization objective declaration with an integer weight (bps). */
export interface ObjectiveSpec {
  readonly objectiveId: ObjectiveId;
  readonly description: string;
  /** Positive integer weight; the aggregate is Σ weight × observed. */
  readonly weightBps: bigint;
}

/** Penalties that price count-based objectives into minor units. */
export interface ObjectivePenalties {
  /** Cost of one external hop for ECONOMIC_COMPRESSION. */
  readonly hopPenaltyMinor: bigint;
  /** Cost of one failed route for RESILIENCE. */
  readonly routeFailurePenaltyMinor: bigint;
  /** Cost of one UNKNOWN outcome awaiting reconciliation for RESILIENCE. */
  readonly unknownOutcomePenaltyMinor: bigint;
  /** Cost of one user-action-required outcome for OPERATIONAL_COMPLEXITY. */
  readonly userActionPenaltyMinor: bigint;
}

/** The full evaluation specification (typically derived from a Domain Pack). */
export interface EvaluationSpec {
  readonly hardConstraints: readonly HardConstraintSpec[];
  readonly objectives: readonly ObjectiveSpec[];
  readonly penalties: ObjectivePenalties;
}

export function defaultEvaluationSpec(): EvaluationSpec {
  return {
    hardConstraints: [
      { constraintId: "AUTHORIZATION", description: "no authorization bypass events" },
      { constraintId: "COMPLIANCE", description: "no adversarial (fraud/collusion/malicious/gaming) demand settles" },
      { constraintId: "PRIVACY", description: "no privacy violations (INV-R02 minimum-context)" },
    ],
    objectives: [
      { objectiveId: "TOTAL_COST", description: "fees + FX spread paid", weightBps: 100n },
      { objectiveId: "ECONOMIC_COMPRESSION", description: "external value moved + hops", weightBps: 100n },
      { objectiveId: "RESILIENCE", description: "degraded exposure + failures + unknowns", weightBps: 100n },
      { objectiveId: "LATENCY", description: "total latency", weightBps: 10n },
      { objectiveId: "LIQUIDITY_LOCKED", description: "liquidity locked by deferral", weightBps: 10n },
      { objectiveId: "COUNTERPARTY_EXPOSURE", description: "explicit network credit exposure", weightBps: 10n },
      { objectiveId: "OPERATIONAL_COMPLEXITY", description: "hops + user actions", weightBps: 10n },
    ],
    penalties: {
      hopPenaltyMinor: 1_000n,
      routeFailurePenaltyMinor: 50_000n,
      unknownOutcomePenaltyMinor: 25_000n,
      userActionPenaltyMinor: 5_000n,
    },
  };
}

// ---------------------------------------------------------------------------
// Phases — hard constraints FIRST (compile-time ordering via a tuple)
// ---------------------------------------------------------------------------

export interface HardConstraintResult {
  readonly constraintId: HardConstraintId;
  readonly passed: boolean;
  /** Human-readable observed value that decided the constraint. */
  readonly observed: string;
}

export interface HardConstraintsPhase {
  readonly phase: "HARD_CONSTRAINTS";
  readonly results: readonly HardConstraintResult[];
  readonly allPassed: boolean;
}

export interface ObjectiveContribution {
  readonly objectiveId: ObjectiveId;
  readonly observedMinor: bigint;
  readonly weightBps: bigint;
  readonly contributionMinor: bigint;
}

export interface OptimizationPhase {
  readonly phase: "OPTIMIZATION";
  readonly contributions: readonly ObjectiveContribution[];
  /** Σ weight × observed. Lower is better. Exact bigint (INV-F01). */
  readonly totalScoreMinor: bigint;
  /**
   * Only meaningful when the hard-constraints phase passed. A run that fails
   * a hard constraint is disqualified regardless of this number.
   */
  readonly disqualificationNote?: string;
}

export interface RunEvaluationResult {
  readonly evaluationId: string;
  readonly scenarioId: string;
  readonly programId: string;
  readonly programVersion: string;
  readonly seed: string;
  /** TUPLE: the compiler guarantees hard constraints are phase[0]. */
  readonly phases: readonly [HardConstraintsPhase, OptimizationPhase];
  readonly passedHardConstraints: boolean;
  readonly totalOptimizationScoreMinor: bigint;
  readonly passed: boolean;
  readonly digest: string;
}

// ---------------------------------------------------------------------------
// Objective observation (pure functions of the metrics + program)
// ---------------------------------------------------------------------------

function observeObjective(
  objectiveId: ObjectiveId,
  run: SimulationRunResult,
  program: SimulationProgram,
  penalties: ObjectivePenalties,
): bigint {
  const m = run.metrics;
  switch (objectiveId) {
    case "TOTAL_COST":
      return m.feesMinor + m.fxSpreadPaidMinor;
    case "ECONOMIC_COMPRESSION":
      return m.externalValueMovedMinor + BigInt(m.hops) * penalties.hopPenaltyMinor;
    case "RESILIENCE":
      return (
        m.degradedRouteExposureMinor +
        BigInt(m.failedNoViableRoute) * penalties.routeFailurePenaltyMinor +
        BigInt(m.unknownOutcomes) * penalties.unknownOutcomePenaltyMinor
      );
    case "LATENCY":
      return BigInt(m.totalLatencyMs);
    case "LIQUIDITY_LOCKED":
      return m.liquidityLockedMinor;
    case "COUNTERPARTY_EXPOSURE":
      return m.creditExposureMinor;
    case "OPERATIONAL_COMPLEXITY":
      return (
        BigInt(m.hops) * penalties.hopPenaltyMinor +
        BigInt(m.userActionRequired) * penalties.userActionPenaltyMinor +
        (program.useNetting ? 0n : 0n)
      );
  }
}

// ---------------------------------------------------------------------------
// Hard-constraint checks (pure functions of the metrics + program)
// ---------------------------------------------------------------------------

function checkHardConstraint(
  constraintId: HardConstraintId,
  run: SimulationRunResult,
  program: SimulationProgram,
): HardConstraintResult {
  const m = run.metrics;
  switch (constraintId) {
    case "AUTHORIZATION":
      return {
        constraintId,
        passed: m.authorizationBypassEvents === 0,
        observed: `authorizationBypassEvents=${m.authorizationBypassEvents}`,
      };
    case "COMPLIANCE":
      return {
        constraintId,
        passed: m.adversarialSettled === 0,
        observed: `adversarialSettled=${m.adversarialSettled}`,
      };
    case "PRIVACY":
      return {
        constraintId,
        passed: m.privacyViolations === 0,
        observed: `privacyViolations=${m.privacyViolations}`,
      };
    case "DEADLINE":
      return {
        constraintId,
        passed: m.deadlineMisses === 0,
        observed: `deadlineMisses=${m.deadlineMisses}`,
      };
    case "EXPLICIT_CREDIT":
      return {
        constraintId,
        // INV-F08: credit is explicit. Using network credit must be declared;
        // undeclared credit exposure is a violation.
        passed: program.useNetworkCredit || m.creditExposureMinor === 0n,
        observed: `creditExposureMinor=${m.creditExposureMinor} declared=${program.useNetworkCredit}`,
      };
  }
}

// ---------------------------------------------------------------------------
// The evaluator
// ---------------------------------------------------------------------------

export interface EvaluateRunInput {
  readonly run: SimulationRunResult;
  readonly program: SimulationProgram;
  readonly spec: EvaluationSpec;
}

/**
 * Evaluates one simulation run. Hard constraints are evaluated FIRST and
 * gate the result; optimization is computed second and can never rescue a
 * hard-constraint failure.
 */
export function evaluateRun(input: EvaluateRunInput): RunEvaluationResult {
  const { run, program, spec } = input;

  // Phase 1 — HARD CONSTRAINTS (always first; tuple position 0).
  const hardResults: HardConstraintResult[] = [];
  for (const constraint of spec.hardConstraints) {
    hardResults.push(checkHardConstraint(constraint.constraintId, run, program));
  }
  const allPassed = hardResults.every((result) => result.passed);
  const hardPhase: HardConstraintsPhase = {
    phase: "HARD_CONSTRAINTS",
    results: Object.freeze(hardResults),
    allPassed,
  };

  // Phase 2 — OPTIMIZATION (only ever informational when phase 1 failed).
  const contributions: ObjectiveContribution[] = [];
  let totalScoreMinor = 0n;
  for (const objective of spec.objectives) {
    const observedMinor = observeObjective(
      objective.objectiveId,
      run,
      program,
      spec.penalties,
    );
    const contributionMinor = observedMinor * objective.weightBps;
    contributions.push({
      objectiveId: objective.objectiveId,
      observedMinor,
      weightBps: objective.weightBps,
      contributionMinor,
    });
    totalScoreMinor += contributionMinor;
  }
  const optimizationPhase: OptimizationPhase = allPassed
    ? {
        phase: "OPTIMIZATION",
        contributions: Object.freeze(contributions),
        totalScoreMinor,
      }
    : {
        phase: "OPTIMIZATION",
        contributions: Object.freeze(contributions),
        totalScoreMinor,
        disqualificationNote:
          "hard-constraint failure: optimization score is informational only",
      };

  const digest = fnv1a64(
    canonicalize({
      scenarioId: run.scenarioId,
      programId: run.programId,
      programVersion: run.programVersion,
      seed: run.seed,
      hardPhase,
      totalScoreMinor,
      passed: allPassed,
    }),
  );

  return Object.freeze({
    evaluationId: `evaluation:${digest}`,
    scenarioId: run.scenarioId,
    programId: run.programId,
    programVersion: run.programVersion,
    seed: run.seed,
    phases: [hardPhase, optimizationPhase] as const,
    passedHardConstraints: allPassed,
    totalOptimizationScoreMinor: totalScoreMinor,
    passed: allPassed,
    digest,
  });
}

// ---------------------------------------------------------------------------
// Robustness evidence (INV-L02)
// ---------------------------------------------------------------------------

export interface RobustnessRunRecord {
  readonly scenarioId: string;
  readonly seed: string;
  readonly passed: boolean;
  readonly totalOptimizationScoreMinor: bigint;
}

export interface RobustnessEvidence {
  readonly robustnessId: string;
  readonly programId: string;
  readonly programVersion: string;
  readonly totalRuns: number;
  readonly passedRuns: number;
  readonly allPassed: boolean;
  /** Worst (highest) optimization score observed across the runs. */
  readonly worstScoreMinor: bigint | undefined;
  /** worst − best (0 means perfectly stable score). */
  readonly scoreSpreadMinor: bigint | undefined;
  readonly runs: readonly RobustnessRunRecord[];
  readonly digest: string;
}

/**
 * Accumulates robustness evidence from a set of evaluations of the SAME
 * program across scenarios and/or seeds (INV-L02: promotion requires
 * robustness evidence, not a single lucky run).
 */
export function accumulateRobustnessEvidence(input: {
  programId: string;
  programVersion: string;
  evaluations: readonly RunEvaluationResult[];
}): RobustnessEvidence {
  const runs: RobustnessRunRecord[] = input.evaluations.map((evaluation) => ({
    scenarioId: evaluation.scenarioId,
    seed: evaluation.seed,
    passed: evaluation.passed,
    totalOptimizationScoreMinor: evaluation.totalOptimizationScoreMinor,
  }));
  const totalRuns = runs.length;
  const passedRuns = runs.filter((record) => record.passed).length;
  const scores = runs.map((record) => record.totalOptimizationScoreMinor);
  const worstScoreMinor = scores.reduce<bigint | undefined>(
    (worst, score) => (worst === undefined || score > worst ? score : worst),
    undefined,
  );
  const bestScoreMinor = scores.reduce<bigint | undefined>(
    (best, score) => (best === undefined || score < best ? score : best),
    undefined,
  );
  const scoreSpreadMinor =
    worstScoreMinor !== undefined && bestScoreMinor !== undefined
      ? worstScoreMinor - bestScoreMinor
      : undefined;

  const digest = fnv1a64(
    canonicalize({
      programId: input.programId,
      programVersion: input.programVersion,
      runs,
    }),
  );

  return Object.freeze({
    robustnessId: `robustness:${digest}`,
    programId: input.programId,
    programVersion: input.programVersion,
    totalRuns,
    passedRuns,
    allPassed: totalRuns > 0 && passedRuns === totalRuns,
    worstScoreMinor,
    scoreSpreadMinor,
    runs: Object.freeze(runs),
    digest,
  });
}

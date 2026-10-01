/**
 * Lab replay and counterfactual (W2-004; FROZEN-ARCHITECTURE §19; LAB.md
 * "Simulation and replay"; INV-L01/L02/P03).
 *
 * Replay uses RECORDED PRODUCTION FACTS WITHOUT REWRITING THEM: the fact
 * set is digested before anything runs, the simulation only ever sees a
 * derived (newly constructed) scenario plan, and the caller's fact objects
 * are never mutated. The replay result references the facts by id + digest
 * only.
 *
 * Deterministic reproducibility (INV-P03 discipline): same facts + same
 * program id/version + same seed → byte-identical result.
 *
 * Counterfactual (INV-L02): the SAME recorded facts are re-run under a
 * variant program and compared against the base replay. Facts stay frozen;
 * only the program differs.
 *
 * INV-L01: every result carries the REPLAY namespace brand and there is no
 * exported conversion from replay results to any production-evidence type.
 */

import {
  canonicalize,
  fnv1a64,
  runSimulation,
} from "./simulation.js";
import type {
  DemandOutcome,
  DemandPlan,
  ScenarioIncident,
  SimulatedLiquidityPool,
  SimulatedRail,
  SimulationProgram,
  SimulationRunResult,
} from "./simulation.js";

export const REPLAY_NAMESPACE = "PAYSWAP_LAB_REPLAY" as const;

/** Phantom brand: replay results are Lab artifacts, never production evidence. */
export interface ReplayNamespaceBrand {
  readonly __payswapReplayNamespace: typeof REPLAY_NAMESPACE;
}

// ---------------------------------------------------------------------------
// Recorded production facts (immutable inputs)
// ---------------------------------------------------------------------------

export type RecordedDemandFact = Readonly<
  Omit<DemandPlan, "atStep"> & { readonly observedAtMs: number }
>;

export type RecordedIncidentFact = Readonly<
  ScenarioIncident & { readonly observedAtMs: number }
>;

/**
 * A recorded production fact set: observed world, observed demands and
 * observed incidents. Constructed via `recordProductionFacts`, which
 * content-digests and deep-freezes it. Historical facts are immutable
 * (AGENTS.md rule 8): replay NEVER rewrites them.
 */
export interface RecordedProductionFacts {
  readonly factsId: string;
  readonly description?: string;
  readonly rails: readonly SimulatedRail[];
  readonly pools: readonly SimulatedLiquidityPool[];
  readonly stepLatencyMs: number;
  readonly demands: readonly RecordedDemandFact[];
  readonly incidents: readonly RecordedIncidentFact[];
  readonly factsDigest: string;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    if (Object.isFrozen(value)) {
      return value;
    }
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/** Records a production fact set: digests and freezes it immutably. */
export function recordProductionFacts(input: {
  factsId: string;
  description?: string;
  rails: readonly SimulatedRail[];
  pools: readonly SimulatedLiquidityPool[];
  stepLatencyMs: number;
  demands: readonly RecordedDemandFact[];
  incidents: readonly RecordedIncidentFact[];
}): RecordedProductionFacts {
  if (input.factsId.length === 0) {
    throw new Error("factsId must not be empty");
  }
  const digestInput = {
    factsId: input.factsId,
    rails: input.rails,
    pools: input.pools,
    stepLatencyMs: input.stepLatencyMs,
    demands: input.demands,
    incidents: input.incidents,
  };
  const factsDigest = fnv1a64(canonicalize(digestInput));
  return deepFreeze({
    factsId: input.factsId,
    ...(input.description !== undefined ? { description: input.description } : {}),
    rails: [...input.rails],
    pools: [...input.pools],
    stepLatencyMs: input.stepLatencyMs,
    demands: [...input.demands],
    incidents: [...input.incidents],
    factsDigest,
  });
}

/** Recomputes a fact set's digest (tamper detection). */
export function recordedFactsDigest(facts: RecordedProductionFacts): string {
  return fnv1a64(
    canonicalize({
      factsId: facts.factsId,
      rails: facts.rails,
      pools: facts.pools,
      stepLatencyMs: facts.stepLatencyMs,
      demands: facts.demands,
      incidents: facts.incidents,
    }),
  );
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

export interface ReplayInput {
  readonly facts: RecordedProductionFacts;
  readonly program: SimulationProgram;
  readonly seed: string;
  /** Quantization: one simulation step per stepMs of observed time. */
  readonly stepMs: number;
}

export interface ReplayResult extends ReplayNamespaceBrand {
  readonly namespace: typeof REPLAY_NAMESPACE;
  readonly replayId: string;
  readonly factsId: string;
  readonly factsDigest: string;
  readonly program: SimulationProgram;
  readonly seed: string;
  readonly stepMs: number;
  readonly run: SimulationRunResult;
  readonly digest: string;
}

function stepOf(observedAtMs: number, stepMs: number): number {
  if (stepMs <= 0) {
    throw new Error("stepMs must be positive");
  }
  return Math.floor(observedAtMs / stepMs);
}

/** Maps recorded facts into a derived scenario plan (no fact is mutated). */
function deriveScenarioPlan(input: ReplayInput): {
  scenarioId: string;
  demands: DemandPlan[];
  incidents: ScenarioIncident[];
} {
  const demands: DemandPlan[] = input.facts.demands.map((fact) => ({
    demandId: fact.demandId,
    atStep: stepOf(fact.observedAtMs, input.stepMs),
    amountMinor: fact.amountMinor,
    currency: fact.currency,
    direction: fact.direction,
    deadlineMs: fact.deadlineMs,
    ...(fact.adversarial !== undefined ? { adversarial: fact.adversarial } : {}),
    ...(fact.partialBps !== undefined ? { partialBps: fact.partialBps } : {}),
    ...(fact.requiresApproval !== undefined ? { requiresApproval: fact.requiresApproval } : {}),
  }));
  const incidents: ScenarioIncident[] = input.facts.incidents.map((fact) => {
    const atStep = stepOf(fact.observedAtMs, input.stepMs);
    switch (fact.incidentType) {
      case "PROVIDER_OUTAGE":
        return { incidentType: "PROVIDER_OUTAGE", atStep, railId: fact.railId };
      case "LIQUIDITY_SHORTAGE":
        return {
          incidentType: "LIQUIDITY_SHORTAGE",
          atStep,
          poolId: fact.poolId,
          drainedMinor: fact.drainedMinor,
        };
      case "FX_VOLATILITY":
        return {
          incidentType: "FX_VOLATILITY",
          atStep,
          spreadIncreaseBps: fact.spreadIncreaseBps,
        };
      case "CONGESTION":
        return {
          incidentType: "CONGESTION",
          atStep,
          addedLatencyMs: fact.addedLatencyMs,
        };
      case "DELAYED_WRITE":
        return { incidentType: "DELAYED_WRITE", atStep, railId: fact.railId };
      case "APPROVAL_DELAY":
        return { incidentType: "APPROVAL_DELAY", atStep, delayMs: fact.delayMs };
    }
  });
  return { scenarioId: `replay:${input.facts.factsId}`, demands, incidents };
}

/**
 * Replays recorded production facts under a program. Deterministic: the
 * same (facts, program, seed, stepMs) always produces the same result. The
 * facts are used READ-ONLY (LAB.md: "Replay uses recorded production facts
 * without rewriting them").
 */
export function runReplay(input: ReplayInput): ReplayResult {
  const factsDigest = recordedFactsDigest(input.facts);
  if (factsDigest !== input.facts.factsDigest) {
    throw new Error(
      `recorded facts '${input.facts.factsId}' digest mismatch: the fact set was tampered with after recording`,
    );
  }
  const plan = deriveScenarioPlan(input);
  const run = runSimulation({
    scenario: {
      scenarioId: plan.scenarioId,
      demands: plan.demands,
      incidents: plan.incidents,
    },
    world: {
      worldId: `replay-world:${input.facts.factsId}`,
      baseCurrency: input.facts.rails[0]?.currency ?? "EUR",
      stepLatencyMs: input.facts.stepLatencyMs,
      rails: input.facts.rails,
      pools: input.facts.pools,
    },
    program: input.program,
    seed: input.seed,
  });
  const digest = fnv1a64(
    canonicalize({
      factsId: input.facts.factsId,
      factsDigest,
      programId: input.program.programId,
      programVersion: input.program.programVersion,
      seed: input.seed,
      stepMs: input.stepMs,
      runDigest: run.digest,
    }),
  );
  return deepFreeze({
    namespace: REPLAY_NAMESPACE,
    __payswapReplayNamespace: REPLAY_NAMESPACE,
    replayId: `replay:${digest}`,
    factsId: input.facts.factsId,
    factsDigest,
    program: input.program,
    seed: input.seed,
    stepMs: input.stepMs,
    run,
    digest,
  });
}

/** Runtime guard: is this value a namespaced replay result? */
export function isReplayResult(value: unknown): value is ReplayResult {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<ReplayResult>;
  return (
    candidate.namespace === REPLAY_NAMESPACE &&
    candidate.__payswapReplayNamespace === REPLAY_NAMESPACE &&
    typeof candidate.replayId === "string" &&
    typeof candidate.digest === "string" &&
    typeof candidate.factsDigest === "string"
  );
}

// ---------------------------------------------------------------------------
// Counterfactual (INV-L02)
// ---------------------------------------------------------------------------

export interface CounterfactualInput {
  readonly facts: RecordedProductionFacts;
  readonly baseProgram: SimulationProgram;
  readonly variantProgram: SimulationProgram;
  readonly seed: string;
  readonly stepMs: number;
}

export interface ReplayDelta {
  readonly settled: number;
  readonly partiallySettled: number;
  readonly failedNoViableRoute: number;
  readonly unknownOutcomes: number;
  readonly feesMinor: bigint;
  readonly fxSpreadPaidMinor: bigint;
  readonly externalValueMovedMinor: bigint;
  readonly adversarialSettled: number;
  readonly deadlineMisses: number;
}

export interface CounterfactualResult extends ReplayNamespaceBrand {
  readonly namespace: typeof REPLAY_NAMESPACE;
  readonly counterfactualId: string;
  readonly base: ReplayResult;
  readonly variant: ReplayResult;
  /** variant − base per metric (positive = variant moved more/paid more). */
  readonly delta: ReplayDelta;
  readonly digest: string;
}

/**
 * Runs a counterfactual: the same recorded facts under a variant program,
 * compared against the base replay (INV-L02 evidence). The facts are used
 * read-only for BOTH branches and are never rewritten.
 */
export function runCounterfactual(input: CounterfactualInput): CounterfactualResult {
  const base = runReplay({
    facts: input.facts,
    program: input.baseProgram,
    seed: input.seed,
    stepMs: input.stepMs,
  });
  const variant = runReplay({
    facts: input.facts,
    program: input.variantProgram,
    seed: input.seed,
    stepMs: input.stepMs,
  });
  const baseMetrics = base.run.metrics;
  const variantMetrics = variant.run.metrics;
  const delta: ReplayDelta = {
    settled: variantMetrics.settled - baseMetrics.settled,
    partiallySettled: variantMetrics.partiallySettled - baseMetrics.partiallySettled,
    failedNoViableRoute:
      variantMetrics.failedNoViableRoute - baseMetrics.failedNoViableRoute,
    unknownOutcomes: variantMetrics.unknownOutcomes - baseMetrics.unknownOutcomes,
    feesMinor: variantMetrics.feesMinor - baseMetrics.feesMinor,
    fxSpreadPaidMinor: variantMetrics.fxSpreadPaidMinor - baseMetrics.fxSpreadPaidMinor,
    externalValueMovedMinor:
      variantMetrics.externalValueMovedMinor - baseMetrics.externalValueMovedMinor,
    adversarialSettled: variantMetrics.adversarialSettled - baseMetrics.adversarialSettled,
    deadlineMisses: variantMetrics.deadlineMisses - baseMetrics.deadlineMisses,
  };
  const digest = fnv1a64(
    canonicalize({
      factsId: input.facts.factsId,
      baseDigest: base.digest,
      variantDigest: variant.digest,
      delta,
    }),
  );
  return deepFreeze({
    namespace: REPLAY_NAMESPACE,
    __payswapReplayNamespace: REPLAY_NAMESPACE,
    counterfactualId: `counterfactual:${digest}`,
    base,
    variant,
    delta,
    digest,
  });
}

// ---------------------------------------------------------------------------
// Outcome observation helpers (used by evidence builders)
// ---------------------------------------------------------------------------

/** Outcome counters for one replay run (deterministic fold). */
export function countOutcomes(run: SimulationRunResult): Record<DemandOutcome, number> {
  const counters: Record<DemandOutcome, number> = {
    SETTLED: 0,
    PARTIALLY_SETTLED: 0,
    FAILED_NO_VIABLE_ROUTE: 0,
    UNKNOWN_REQUIRES_RECONCILIATION: 0,
    USER_ACTION_REQUIRED: 0,
    BLOCKED_FRAUD: 0,
    EXPIRED: 0,
  };
  for (const outcome of run.outcomes) {
    counters[outcome.outcome] += 1;
  }
  return counters;
}

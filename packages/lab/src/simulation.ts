/**
 * Simulation namespace (W2-004; FROZEN-ARCHITECTURE §19 Lab; LAB.md
 * "Simulation and replay"; INV-L01; AGENTS.md rule 7).
 *
 * INV-L01 / AGENTS.md rule 7 — SIMULATION IS NOT PRODUCTION TRUTH:
 * this module is DELIBERATELY self-contained: it has ZERO imports (verified
 * by the boundary test). No export path from here reaches any production
 * rail adapter, connector execution, ledger or authorization code — the
 * simulator is only ever callable from inside the Lab package, and every
 * result it produces is branded with the SIMULATION namespace so it can
 * never be confused with production evidence (there is intentionally NO
 * exported conversion from a simulation result to any production-evidence
 * type).
 *
 * Deterministic by construction: behaviour is a pure function of
 * (scenario plan, world, program, seed). There is no ambient clock, no
 * Math.random, no Date.now — the only pseudo-entropy is a splitmix64 PRNG
 * seeded from the caller-supplied seed string. Money is exact integer
 * minor-unit bigint arithmetic (INV-F01); no floating point anywhere in
 * the financial results.
 */

export const SIMULATION_NAMESPACE = "PAYSWAP_LAB_SIMULATION" as const;

/**
 * Phantom brand carried by every simulation result. It exists only at the
 * type level so a SimulationRunResult is structurally distinct from any
 * production evidence artifact and cannot be assigned where production
 * evidence is demanded (INV-L01).
 */
export interface SimulationNamespaceBrand {
  readonly __payswapSimulationNamespace: typeof SIMULATION_NAMESPACE;
}

// ---------------------------------------------------------------------------
// World model (LAB.md: accounts, obligations, rails, liquidity, FX, incidents)
// ---------------------------------------------------------------------------

/** One simulated payment rail with exact economics (INV-F01: bigint minor units). */
export interface SimulatedRail {
  readonly railId: string;
  /** Currency the rail settles in (may differ from the demand currency → FX). */
  readonly currency: string;
  readonly latencyMs: number;
  readonly fixedFeeMinor: bigint;
  /** Variable fee in basis points of the moved amount. */
  readonly variableFeeBps: bigint;
  /** Base FX spread (basis points) charged when converting into the rail currency. */
  readonly fxSpreadBps?: bigint;
}

/** One simulated liquidity pool backing a rail. */
export interface SimulatedLiquidityPool {
  readonly poolId: string;
  readonly railId: string;
  readonly availableMinor: bigint;
}

/** The simulated world a scenario runs against. Inputs are never mutated. */
export interface SimulatedWorld {
  readonly worldId: string;
  readonly baseCurrency: string;
  /** Latency added per deferred step when a program delays/batches. */
  readonly stepLatencyMs: number;
  readonly rails: readonly SimulatedRail[];
  readonly pools: readonly SimulatedLiquidityPool[];
}

// ---------------------------------------------------------------------------
// Scenario plans: normal demand plus the LAB.md incident taxonomy
// ---------------------------------------------------------------------------

export type DemandDirection = "OUTBOUND" | "INBOUND";

/**
 * The adversarial demand taxonomy the scenario generator must cover
 * (LAB.md "Scenario generation": fraud, collusion, malicious agents,
 * incentive gaming). A screened program blocks all of them; a program that
 * lets one settle fails the evaluator's COMPLIANCE hard constraint.
 */
export const ADVERSARIAL_DEMAND_KINDS = [
  "FRAUD",
  "COLLUSION",
  "MALICIOUS_AGENT",
  "INCENTIVE_GAMING",
] as const;
export type AdversarialDemandKind = (typeof ADVERSARIAL_DEMAND_KINDS)[number];

export function isAdversarialDemandKind(
  value: unknown,
): value is AdversarialDemandKind {
  return (
    typeof value === "string" &&
    (ADVERSARIAL_DEMAND_KINDS as readonly unknown[]).includes(value)
  );
}

/** One planned money-movement demand arriving into the simulated world. */
export interface DemandPlan {
  readonly demandId: string;
  readonly atStep: number;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly direction: DemandDirection;
  readonly deadlineMs: number;
  /** Fraudulent/colluding/malicious/gaming demand; screened programs block it. */
  readonly adversarial?: AdversarialDemandKind;
  /** Provider executes only this fraction (basis points of the amount). */
  readonly partialBps?: bigint;
  /** Demand gated on a customer approval arriving via the approval surface. */
  readonly requiresApproval?: boolean;
}

export type ScenarioIncident =
  | {
      readonly incidentType: "PROVIDER_OUTAGE";
      readonly atStep: number;
      readonly railId: string;
    }
  | {
      readonly incidentType: "LIQUIDITY_SHORTAGE";
      readonly atStep: number;
      readonly poolId: string;
      readonly drainedMinor: bigint;
    }
  | {
      readonly incidentType: "FX_VOLATILITY";
      readonly atStep: number;
      readonly spreadIncreaseBps: bigint;
    }
  | {
      readonly incidentType: "CONGESTION";
      readonly atStep: number;
      readonly addedLatencyMs: number;
    }
  | {
      /** In-flight writes on the rail become UNKNOWN (requires reconciliation). */
      readonly incidentType: "DELAYED_WRITE";
      readonly atStep: number;
      readonly railId: string;
    }
  | {
      readonly incidentType: "APPROVAL_DELAY";
      readonly atStep: number;
      readonly delayMs: number;
    };

export interface SimulationScenarioPlan {
  readonly scenarioId: string;
  readonly description?: string;
  readonly demands: readonly DemandPlan[];
  readonly incidents: readonly ScenarioIncident[];
}

// ---------------------------------------------------------------------------
// Simulation programs (the strategy/candidate under test)
// ---------------------------------------------------------------------------

/**
 * A deterministic routing/settlement policy under simulation. This type is
 * pure data: it carries no authority, no credentials and no protocol-command
 * shape. A candidate is compiled into one of these for evaluation.
 */
export interface SimulationProgram {
  readonly programId: string;
  readonly programVersion: string;
  /** Ordered rail preferences; the first usable rail wins. */
  readonly routePreference: readonly string[];
  /** Batch co-directional demands inside the delay window (netting). */
  readonly useNetting: boolean;
  /** Cover liquidity gaps with explicit network credit (INV-F08 discipline). */
  readonly useNetworkCredit: boolean;
  /** How many steps a demand may be deferred for batching. */
  readonly delayToleranceSteps: number;
  /** Screen fraudulent demands (hard compliance constraint). */
  readonly fraudScreening: boolean;
  /** Context receives only the minimum data required (INV-R02). */
  readonly privacyBounded: boolean;
  /**
   * A program may declare a bypass — the simulator will then settle without
   * authorization and the evaluator's AUTHORIZATION hard constraint fails.
   * Declaring the bypass is the only way to "reach" it; the Lab itself never
   * fabricates authorization (INV-F06/INV-A05 discipline).
   */
  readonly authorizationMode: "PROTOCOL_AUTHORIZED" | "DECLARED_BYPASS";
}

// ---------------------------------------------------------------------------
// Outcomes and metrics
// ---------------------------------------------------------------------------

export type DemandOutcome =
  | "SETTLED"
  | "PARTIALLY_SETTLED"
  | "FAILED_NO_VIABLE_ROUTE"
  | "UNKNOWN_REQUIRES_RECONCILIATION"
  | "USER_ACTION_REQUIRED"
  | "BLOCKED_FRAUD"
  | "EXPIRED";

export interface DemandOutcomeRecord {
  readonly demandId: string;
  readonly outcome: DemandOutcome;
  readonly railId?: string;
  readonly effectiveStep: number;
  readonly latencyMs: number;
  readonly movedMinor: bigint;
  readonly feesMinor: bigint;
}

/**
 * Exact economic/work metrics of a run (FROZEN-ARCHITECTURE §25 EconomicWork;
 * LAB.md "Evaluation"). All money is bigint minor units — never floating
 * point (INV-F01).
 */
export interface SimulationMetrics {
  readonly totalDemands: number;
  readonly settled: number;
  readonly partiallySettled: number;
  readonly failedNoViableRoute: number;
  readonly unknownOutcomes: number;
  readonly userActionRequired: number;
  readonly blockedAdversarial: number;
  readonly expired: number;
  /** Adversarial (fraud/collusion/malicious/gaming) demands that settled — a compliance hard-constraint failure. */
  readonly adversarialSettled: number;
  readonly deadlineMisses: number;
  readonly externalValueMovedMinor: bigint;
  readonly nettedInternallyMinor: bigint;
  readonly hops: number;
  readonly liquidityLockedMinor: bigint;
  readonly feesMinor: bigint;
  readonly fxSpreadPaidMinor: bigint;
  readonly totalLatencyMs: number;
  readonly degradedRouteExposureMinor: bigint;
  readonly creditExposureMinor: bigint;
  readonly authorizationBypassEvents: number;
  readonly privacyViolations: number;
}

/** Every field of SimulationMetrics except the readonly modifier. */
export type MutableSimulationMetrics = { -readonly [K in keyof SimulationMetrics]: SimulationMetrics[K] };

// ---------------------------------------------------------------------------
// Run results (namespaced — INV-L01)
// ---------------------------------------------------------------------------

export interface SimulationRunInput {
  readonly scenario: SimulationScenarioPlan;
  readonly world: SimulatedWorld;
  readonly program: SimulationProgram;
  readonly seed: string;
}

export interface SimulationRunResult extends SimulationNamespaceBrand {
  readonly namespace: typeof SIMULATION_NAMESPACE;
  readonly scenarioId: string;
  readonly programId: string;
  readonly programVersion: string;
  readonly seed: string;
  /** Deterministic digest over (scenario, program id+version, seed, outcomes). */
  readonly digest: string;
  readonly metrics: SimulationMetrics;
  readonly outcomes: readonly DemandOutcomeRecord[];
}

// ---------------------------------------------------------------------------
// Deterministic PRNG (splitmix64) — the ONLY entropy source, caller-seeded
// ---------------------------------------------------------------------------

const MASK64 = 0xffff_ffff_ffff_ffffn;

function foldSeed(seed: string): bigint {
  let hash = 0xcbf2_9ce4_8422_2325n;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= BigInt(seed.charCodeAt(i) & 0xff);
    hash = (hash * 0x100_0000_01b3n) & MASK64;
  }
  return hash;
}

class DeterministicRandom {
  private state: bigint;

  constructor(seed: string) {
    this.state = foldSeed(seed) & MASK64;
  }

  nextUint64(): bigint {
    this.state = (this.state + 0x9e37_79b9_7f4a_7c15n) & MASK64;
    let z = this.state;
    z = ((z ^ (z >> 30n)) * 0xbf58_476d_1ce4_e5b9n) & MASK64;
    z = ((z ^ (z >> 27n)) * 0x94d0_49bb_1331_11ebn) & MASK64;
    return z ^ (z >> 31n);
  }

  /** Deterministic bounded jitter in [0, maxExclusive). */
  nextBounded(maxExclusive: number): number {
    if (maxExclusive <= 0) {
      return 0;
    }
    return Number(this.nextUint64() % BigInt(maxExclusive));
  }
}

// ---------------------------------------------------------------------------
// Canonical digest (local on purpose: this module imports NOTHING, INV-L01)
// ---------------------------------------------------------------------------

/**
 * Canonical, sort-stable JSON text for digests (bigint-aware). Exported for
 * reuse by the OTHER Lab modules (replay/candidates/promotion); simulation.ts
 * itself still imports NOTHING (INV-L01 boundary test).
 */
export function canonicalize(value: unknown): string {
  if (value === null) {
    return "null";
  }
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      return `n:${value.toString()}`;
    case "bigint":
      return `b:${value.toString()}`;
    case "boolean":
      return value ? "true" : "false";
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalize(item)).join(",")}]`;
      }
      const record = value as Readonly<Record<string, unknown>>;
      const keys = Object.keys(record).sort();
      const parts: string[] = [];
      for (const key of keys) {
        parts.push(`${JSON.stringify(key)}:${canonicalize(record[key])}`);
      }
      return `{${parts.join(",")}}`;
    }
    default:
      throw new Error(`simulation digest: unsupported value of type '${typeof value}'`);
  }
}

/** FNV-1a 64 digest over canonical text (deterministic, import-free). */
export function fnv1a64(text: string): string {
  let hash = 0xcbf2_9ce4_8422_2325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i) & 0xff);
    hash = (hash * 0x100_0000_01b3n) & MASK64;
  }
  return `simfnv1a64:${hash.toString(16).padStart(16, "0")}`;
}

/** Deterministic digest of a simulation run's truth-relevant content. */
export function simulationDigest(
  scenarioId: string,
  program: SimulationProgram,
  seed: string,
  metrics: SimulationMetrics,
  outcomes: readonly DemandOutcomeRecord[],
): string {
  return fnv1a64(
    canonicalize({
      scenarioId,
      program: {
        programId: program.programId,
        programVersion: program.programVersion,
        routePreference: [...program.routePreference],
        useNetting: program.useNetting,
        useNetworkCredit: program.useNetworkCredit,
        delayToleranceSteps: program.delayToleranceSteps,
        fraudScreening: program.fraudScreening,
        privacyBounded: program.privacyBounded,
        authorizationMode: program.authorizationMode,
      },
      seed,
      metrics,
      outcomes,
    }),
  );
}

// ---------------------------------------------------------------------------
// Runtime guard (INV-L01)
// ---------------------------------------------------------------------------

/** Runtime guard: is this value a namespaced simulation result? */
export function isSimulationResult(value: unknown): value is SimulationRunResult {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<SimulationRunResult>;
  return (
    candidate.namespace === SIMULATION_NAMESPACE &&
    candidate.__payswapSimulationNamespace === SIMULATION_NAMESPACE &&
    typeof candidate.scenarioId === "string" &&
    typeof candidate.digest === "string" &&
    typeof candidate.metrics === "object" &&
    candidate.metrics !== null &&
    Array.isArray(candidate.outcomes)
  );
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

interface WorkingRail {
  readonly railId: string;
  readonly currency: string;
  readonly latencyMs: number;
  readonly fixedFeeMinor: bigint;
  readonly variableFeeBps: bigint;
  readonly fxSpreadBps: bigint;
  available: boolean;
  degraded: boolean;
  pendingUnknown: boolean;
}

interface WorkingPool {
  readonly poolId: string;
  readonly railId: string;
  availableMinor: bigint;
}

interface DeferredDemand {
  readonly demand: DemandPlan;
  readonly effectiveStep: number;
  readonly deferredSteps: number;
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

function emptyMetrics(): MutableSimulationMetrics {
  return {
    totalDemands: 0,
    settled: 0,
    partiallySettled: 0,
    failedNoViableRoute: 0,
    unknownOutcomes: 0,
    userActionRequired: 0,
    blockedAdversarial: 0,
    expired: 0,
    adversarialSettled: 0,
    deadlineMisses: 0,
    externalValueMovedMinor: 0n,
    nettedInternallyMinor: 0n,
    hops: 0,
    liquidityLockedMinor: 0n,
    feesMinor: 0n,
    fxSpreadPaidMinor: 0n,
    totalLatencyMs: 0,
    degradedRouteExposureMinor: 0n,
    creditExposureMinor: 0n,
    authorizationBypassEvents: 0,
    privacyViolations: 0,
  };
}

/**
 * Runs one deterministic simulation. Same (scenario, world, program, seed) →
 * deep-equal result, always. Inputs are never mutated; the result is
 * deep-frozen and namespaced (INV-L01).
 */
export function runSimulation(input: SimulationRunInput): SimulationRunResult {
  const { scenario, world, program, seed } = input;
  if (scenario.demands.length === 0 && scenario.incidents.length === 0) {
    // A scenario with no events is legal (empty world proof) but must still
    // produce a deterministic, namespaced result.
  }

  const random = new DeterministicRandom(`${seed}:${scenario.scenarioId}`);

  const rails = new Map<string, WorkingRail>();
  for (const rail of world.rails) {
    rails.set(rail.railId, {
      railId: rail.railId,
      currency: rail.currency,
      latencyMs: rail.latencyMs,
      fixedFeeMinor: rail.fixedFeeMinor,
      variableFeeBps: rail.variableFeeBps,
      fxSpreadBps: rail.fxSpreadBps ?? 0n,
      available: true,
      degraded: false,
      pendingUnknown: false,
    });
  }
  const pools = new Map<string, WorkingPool>();
  for (const pool of world.pools) {
    pools.set(pool.poolId, {
      poolId: pool.poolId,
      railId: pool.railId,
      availableMinor: pool.availableMinor,
    });
  }

  let fxExtraBps = 0n;
  let congestionMs = 0;
  let approvalDelayMs = 0;
  const metrics = emptyMetrics();
  metrics.totalDemands = scenario.demands.length;

  const outcomes: DemandOutcomeRecord[] = [];

  // -- schedule demands: immediate or deferred into a batching window -------
  const deferred: DeferredDemand[] = [];
  const immediate: DemandPlan[] = [];
  const window = program.useNetting || program.delayToleranceSteps > 0
    ? program.delayToleranceSteps
    : 0;
  for (const demand of scenario.demands) {
    // Adversarial screening (fraud/collusion/malicious/gaming) happens at
    // arrival, before any routing.
    if (program.fraudScreening === true && demand.adversarial !== undefined) {
      metrics.blockedAdversarial += 1;
      outcomes.push({
        demandId: demand.demandId,
        outcome: "BLOCKED_FRAUD",
        effectiveStep: demand.atStep,
        latencyMs: 0,
        movedMinor: 0n,
        feesMinor: 0n,
      });
      continue;
    }
    if (window > 0) {
      const effectiveStep = demand.atStep + window;
      deferred.push({ demand, effectiveStep, deferredSteps: window });
      metrics.liquidityLockedMinor += demand.amountMinor;
    } else {
      immediate.push(demand);
    }
  }

  // Pending queue: (demand, effectiveStep) pairs awaiting their step.
  const pending: DeferredDemand[] = [...deferred];

  // -- incident application + demand processing, step by step ---------------
  const lastDemandStep = scenario.demands.reduce(
    (max, demand) => Math.max(max, demand.atStep),
    0,
  );
  const horizon = lastDemandStep + window + 1;

  interface BatchRecord {
    readonly railId: string;
    readonly effectiveStep: number;
    readonly outboundMinor: bigint;
    readonly inboundMinor: bigint;
    readonly fixedFeeMinor: bigint;
    readonly variableFeesMinor: bigint;
    readonly fxSpreadPaidMinor: bigint;
    readonly memberDemandIds: readonly string[];
  }
  const batches: BatchRecord[] = [];

  const poolForRail = (railId: string): WorkingPool | undefined => {
    for (const pool of pools.values()) {
      if (pool.railId === railId) {
        return pool;
      }
    }
    return undefined;
  };

  const chooseRail = (
    demand: DemandPlan,
  ): { rail: WorkingRail; usedCreditMinor: bigint } | undefined => {
    // Pass 1: currency-matching rails only (no FX). Pass 2: fall back to
    // cross-currency rails, which convert at their spread (rail.fxSpreadBps
    // + scenario FX volatility), tracked exactly in bigint minor units
    // (INV-F01/F09 discipline).
    const tryRails = (
      matchingOnly: boolean,
    ): { rail: WorkingRail; usedCreditMinor: bigint } | undefined => {
      for (const railId of program.routePreference) {
        const rail = rails.get(railId);
        if (rail === undefined || !rail.available) {
          continue;
        }
        if (matchingOnly && rail.currency !== demand.currency) {
          continue;
        }
        const pool = poolForRail(rail.railId);
        if (pool !== undefined && pool.availableMinor < demand.amountMinor) {
          if (program.useNetworkCredit) {
            const gap = demand.amountMinor - pool.availableMinor;
            pool.availableMinor = 0n;
            return { rail, usedCreditMinor: gap };
          }
          continue; // insufficient liquidity without credit → next rail
        }
        if (pool !== undefined) {
          pool.availableMinor -= demand.amountMinor;
        }
        return { rail, usedCreditMinor: 0n };
      }
      return undefined;
    };
    return tryRails(true) ?? tryRails(false);
  };

  const settleOne = (
    demand: DemandPlan,
    effectiveStep: number,
    deferredSteps: number,
  ): void => {
    const chosen = chooseRail(demand);
    if (chosen === undefined) {
      outcomes.push({
        demandId: demand.demandId,
        outcome: "FAILED_NO_VIABLE_ROUTE",
        effectiveStep,
        latencyMs: 0,
        movedMinor: 0n,
        feesMinor: 0n,
      });
      metrics.failedNoViableRoute += 1;
      return;
    }
    const { rail, usedCreditMinor } = chosen;
    metrics.creditExposureMinor += usedCreditMinor;

    const conversion = rail.currency !== demand.currency;
    const conversionSpreadBps = conversion
      ? rail.fxSpreadBps + fxExtraBps
      : 0n;
    const variableBps = rail.variableFeeBps;

    let movedMinor = demand.amountMinor;
    let outcome: DemandOutcome = "SETTLED";
    if (demand.partialBps !== undefined) {
      movedMinor = (demand.amountMinor * demand.partialBps) / 10_000n;
      outcome = "PARTIALLY_SETTLED";
    }

    const fees =
      rail.fixedFeeMinor + (movedMinor * (variableBps + conversionSpreadBps)) / 10_000n;
    const fxSpread = (movedMinor * conversionSpreadBps) / 10_000n;

    const jitterMs = random.nextBounded(101);
    const latencyMs =
      rail.latencyMs + congestionMs + deferredSteps * world.stepLatencyMs + jitterMs;

    if (rail.pendingUnknown) {
      // The external write is delayed: the outcome is UNKNOWN and requires
      // reconciliation (INV-X01: UNKNOWN is never FAILED and never success).
      outcomes.push({
        demandId: demand.demandId,
        outcome: "UNKNOWN_REQUIRES_RECONCILIATION",
        railId: rail.railId,
        effectiveStep,
        latencyMs,
        movedMinor: 0n,
        feesMinor: fees,
      });
      metrics.unknownOutcomes += 1;
      metrics.feesMinor += fees;
      return;
    }

    if (demand.requiresApproval === true) {
      const approvalLatency = latencyMs + approvalDelayMs;
      if (approvalLatency > demand.deadlineMs) {
        // A pending customer approval is a legitimate waiting terminal state,
        // not a failure and not UNKNOWN.
        outcomes.push({
          demandId: demand.demandId,
          outcome: "USER_ACTION_REQUIRED",
          railId: rail.railId,
          effectiveStep,
          latencyMs: approvalLatency,
          movedMinor: 0n,
          feesMinor: 0n,
        });
        metrics.userActionRequired += 1;
        return;
      }
    }

    if (latencyMs > demand.deadlineMs) {
      outcomes.push({
        demandId: demand.demandId,
        outcome: "EXPIRED",
        railId: rail.railId,
        effectiveStep,
        latencyMs,
        movedMinor: 0n,
        feesMinor: 0n,
      });
      metrics.expired += 1;
      metrics.deadlineMisses += 1;
      return;
    }

    if (outcome === "SETTLED") {
      metrics.settled += 1;
      if (demand.adversarial !== undefined) {
        metrics.adversarialSettled += 1;
      }
      if (program.authorizationMode === "DECLARED_BYPASS") {
        metrics.authorizationBypassEvents += 1;
      }
    } else {
      metrics.partiallySettled += 1;
    }

    // Record a batch (netting coalesces same-rail same-step demands).
    batches.push({
      railId: rail.railId,
      effectiveStep,
      outboundMinor: demand.direction === "OUTBOUND" ? movedMinor : 0n,
      inboundMinor: demand.direction === "INBOUND" ? movedMinor : 0n,
      fixedFeeMinor: rail.fixedFeeMinor,
      variableFeesMinor: (movedMinor * (variableBps + conversionSpreadBps)) / 10_000n,
      fxSpreadPaidMinor: fxSpread,
      memberDemandIds: [demand.demandId],
    });
    outcomes.push({
      demandId: demand.demandId,
      outcome,
      railId: rail.railId,
      effectiveStep,
      latencyMs,
      movedMinor,
      feesMinor: fees,
    });
    metrics.totalLatencyMs += latencyMs;
    if (rail.degraded) {
      metrics.degradedRouteExposureMinor += movedMinor;
    }
  };

  // Merge same-(rail, step) batches when netting is enabled: internalized
  // value never moves externally (economic compression, §25).
  const coalesceBatches = (): void => {
    if (!program.useNetting) {
      for (const batch of batches) {
        metrics.externalValueMovedMinor +=
          batch.outboundMinor + batch.inboundMinor;
        metrics.feesMinor += batch.fixedFeeMinor + batch.variableFeesMinor;
        metrics.fxSpreadPaidMinor += batch.fxSpreadPaidMinor;
        metrics.hops += 1;
      }
      return;
    }
    const groups = new Map<string, BatchRecord[]>();
    for (const batch of batches) {
      const key = `${batch.railId}@${batch.effectiveStep}`;
      const list = groups.get(key) ?? [];
      list.push(batch);
      groups.set(key, list);
    }
    for (const group of groups.values()) {
      const first = group[0];
      if (first === undefined) {
        continue;
      }
      const outboundMinor = group.reduce((sum, b) => sum + b.outboundMinor, 0n);
      const inboundMinor = group.reduce((sum, b) => sum + b.inboundMinor, 0n);
      const internalized = 2n * (outboundMinor < inboundMinor ? outboundMinor : inboundMinor);
      metrics.nettedInternallyMinor += internalized;
      metrics.externalValueMovedMinor += outboundMinor + inboundMinor - internalized;
      const fixedFees = group.reduce((sum, b) => sum + b.fixedFeeMinor, 0n);
      const variableFees = group.reduce((sum, b) => sum + b.variableFeesMinor, 0n);
      const fxSpread = group.reduce((sum, b) => sum + b.fxSpreadPaidMinor, 0n);
      metrics.feesMinor += fixedFees + variableFees;
      metrics.fxSpreadPaidMinor += fxSpread;
      metrics.hops += 1;
    }
  };

  const incidentsByStep = new Map<number, ScenarioIncident[]>();
  for (const incident of scenario.incidents) {
    const list = incidentsByStep.get(incident.atStep) ?? [];
    list.push(incident);
    incidentsByStep.set(incident.atStep, list);
  }

  const processDemand = (demand: DemandPlan, effectiveStep: number, deferredSteps: number): void => {
    // Privacy discipline: a program that is not privacy-bounded pulls more
    // context than the minimum required for every demand it processes.
    if (program.privacyBounded === false) {
      metrics.privacyViolations += 1;
    }
    settleOne(demand, effectiveStep, deferredSteps);
  };

  for (let step = 0; step <= horizon; step += 1) {
    const incidents = incidentsByStep.get(step) ?? [];
    for (const incident of incidents) {
      switch (incident.incidentType) {
        case "PROVIDER_OUTAGE": {
          const rail = rails.get(incident.railId);
          if (rail !== undefined) {
            rail.available = false;
          }
          break;
        }
        case "LIQUIDITY_SHORTAGE": {
          const pool = pools.get(incident.poolId);
          if (pool !== undefined) {
            pool.availableMinor =
              pool.availableMinor > incident.drainedMinor
                ? pool.availableMinor - incident.drainedMinor
                : 0n;
          }
          break;
        }
        case "FX_VOLATILITY": {
          fxExtraBps += incident.spreadIncreaseBps;
          break;
        }
        case "CONGESTION": {
          congestionMs += incident.addedLatencyMs;
          for (const rail of rails.values()) {
            rail.degraded = true;
          }
          break;
        }
        case "DELAYED_WRITE": {
          const rail = rails.get(incident.railId);
          if (rail !== undefined) {
            rail.pendingUnknown = true;
          }
          break;
        }
        case "APPROVAL_DELAY": {
          approvalDelayMs += incident.delayMs;
          break;
        }
      }
    }

    // Immediate demands fire at their own step.
    for (const demand of immediate) {
      if (demand.atStep === step) {
        processDemand(demand, step, 0);
      }
    }
    // Deferred demands fire at their effective step.
    for (const entry of pending) {
      if (entry.effectiveStep === step) {
        processDemand(entry.demand, entry.effectiveStep, entry.deferredSteps);
      }
    }
  }

  coalesceBatches();

  const frozenMetrics: SimulationMetrics = deepFreeze({ ...metrics }) as SimulationMetrics;
  const frozenOutcomes = deepFreeze([...outcomes]) as readonly DemandOutcomeRecord[];

  const digest = simulationDigest(
    scenario.scenarioId,
    program,
    seed,
    frozenMetrics,
    frozenOutcomes,
  );

  return deepFreeze({
    namespace: SIMULATION_NAMESPACE,
    __payswapSimulationNamespace: SIMULATION_NAMESPACE,
    scenarioId: scenario.scenarioId,
    programId: program.programId,
    programVersion: program.programVersion,
    seed,
    digest,
    metrics: frozenMetrics,
    outcomes: frozenOutcomes,
  }) as SimulationRunResult;
}

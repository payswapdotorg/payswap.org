/**
 * Lab scenario generation and the MANDATORY BASELINE SUITE (W2-004;
 * FROZEN-ARCHITECTURE §19; LAB.md "Scenario generation" + "Promotion").
 *
 * The baseline suite covers the full LAB.md scenario taxonomy: normal
 * demand plus liquidity shortages, provider outages, FX volatility,
 * delayed writes, approval delays, fraud, collusion, malicious agents,
 * incentive gaming, partial payments, congestion and adversarial model
 * behavior.
 *
 * The mandatory baseline candidate set (LAB.md "Promotion") contains:
 * 1. deterministic/generalist;
 * 2. hand-designed;
 * 3. searched (output of the deterministic search plug-in);
 * 4. incumbent production candidate (provider-native, PASS_THROUGH_NATIVE,
 *    INV-C08).
 *
 * Everything here is pure data: fixed amounts, fixed steps, no ambient
 * clock, no Math.random. The only entropy in any run is the caller-supplied
 * seed (see simulation.ts).
 */

import type { ExecutionMode } from "@payswap/connectors";
import type { LabScenarioTypeId } from "./domain-packs.js";
import { PAYMENT_ROUTING_DOMAIN_PACK } from "./domain-packs.js";
import type {
  DemandPlan,
  ScenarioIncident,
  SimulatedWorld,
  SimulationProgram,
  SimulationScenarioPlan,
} from "./simulation.js";

// ---------------------------------------------------------------------------
// Lab scenarios
// ---------------------------------------------------------------------------

export interface LabScenario {
  readonly scenarioId: string;
  readonly domainPackId: string;
  readonly scenarioType: LabScenarioTypeId;
  readonly description: string;
  readonly world: SimulatedWorld;
  readonly plan: SimulationScenarioPlan;
}

// ---------------------------------------------------------------------------
// The baseline world (deterministic, shared by the baseline suite)
// ---------------------------------------------------------------------------

export const BASELINE_WORLD: SimulatedWorld = {
  worldId: "lab.baseline-world",
  baseCurrency: "EUR",
  stepLatencyMs: 250,
  rails: [
    {
      railId: "rail-a",
      currency: "EUR",
      latencyMs: 400,
      fixedFeeMinor: 25n,
      variableFeeBps: 10n,
    },
    {
      railId: "rail-b",
      currency: "EUR",
      latencyMs: 350,
      fixedFeeMinor: 40n,
      variableFeeBps: 8n,
    },
    {
      railId: "rail-c",
      currency: "USD",
      latencyMs: 600,
      fixedFeeMinor: 15n,
      variableFeeBps: 12n,
      fxSpreadBps: 20n,
    },
    {
      railId: "rail-d",
      currency: "EUR",
      latencyMs: 1_500,
      fixedFeeMinor: 5n,
      variableFeeBps: 4n,
    },
  ],
  pools: [
    { poolId: "pool-a", railId: "rail-a", availableMinor: 10_000_000n },
    { poolId: "pool-b", railId: "rail-b", availableMinor: 8_000_000n },
    { poolId: "pool-c", railId: "rail-c", availableMinor: 6_000_000n },
    { poolId: "pool-d", railId: "rail-d", availableMinor: 1_200_000n },
  ],
};

const DEFAULT_DEADLINE_MS = 10_000;

function demand(
  demandId: string,
  atStep: number,
  amountMinor: bigint,
  extra?: Partial<Pick<DemandPlan, "adversarial" | "partialBps" | "requiresApproval" | "currency" | "direction" | "deadlineMs">>,
): DemandPlan {
  return {
    demandId,
    atStep,
    amountMinor,
    currency: extra?.currency ?? "EUR",
    direction: extra?.direction ?? "OUTBOUND",
    deadlineMs: extra?.deadlineMs ?? DEFAULT_DEADLINE_MS,
    ...(extra?.adversarial !== undefined ? { adversarial: extra.adversarial } : {}),
    ...(extra?.partialBps !== undefined ? { partialBps: extra.partialBps } : {}),
    ...(extra?.requiresApproval !== undefined ? { requiresApproval: extra.requiresApproval } : {}),
  };
}

function scenario(
  scenarioId: string,
  scenarioType: LabScenarioTypeId,
  description: string,
  demands: readonly DemandPlan[],
  incidents: readonly ScenarioIncident[] = [],
): LabScenario {
  return {
    scenarioId,
    domainPackId: PAYMENT_ROUTING_DOMAIN_PACK.packId,
    scenarioType,
    description,
    world: BASELINE_WORLD,
    plan: {
      scenarioId,
      description,
      demands: [...demands],
      incidents: [...incidents],
    },
  };
}

// ---------------------------------------------------------------------------
// The baseline suite — one scenario per taxonomy entry (LAB.md)
// ---------------------------------------------------------------------------

const BASELINE_SCENARIOS: readonly LabScenario[] = Object.freeze([
  scenario(
    "lab.baseline.normal-demand",
    "NORMAL_DEMAND",
    "steady outbound and inbound demand, no incidents",
    [
      demand("d-normal-1", 0, 250_000n),
      demand("d-normal-2", 1, 120_000n, { direction: "INBOUND" }),
      demand("d-normal-3", 2, 90_000n),
      demand("d-normal-4", 3, 310_000n, { direction: "INBOUND" }),
      demand("d-normal-5", 4, 60_000n),
    ],
  ),
  scenario(
    "lab.baseline.liquidity-shortage",
    "LIQUIDITY_SHORTAGE",
    "the primary pool is drained mid-flight; routes must fall back",
    [
      demand("d-liq-1", 0, 500_000n),
      demand("d-liq-2", 5, 700_000n),
      demand("d-liq-3", 6, 400_000n),
    ],
    [
      {
        incidentType: "LIQUIDITY_SHORTAGE",
        atStep: 4,
        poolId: "pool-a",
        drainedMinor: 9_500_000n,
      },
    ],
  ),
  scenario(
    "lab.baseline.provider-outage",
    "PROVIDER_OUTAGE",
    "rail-a goes down at step 2; demand must re-route",
    [
      demand("d-out-1", 0, 200_000n),
      demand("d-out-2", 3, 240_000n),
      demand("d-out-3", 4, 150_000n),
    ],
    [
      {
        incidentType: "PROVIDER_OUTAGE",
        atStep: 2,
        railId: "rail-a",
      },
    ],
  ),
  scenario(
    "lab.baseline.fx-volatility",
    "FX_VOLATILITY",
    "cross-currency spread widens sharply at step 1",
    [
      demand("d-fx-1", 0, 300_000n, { currency: "USD" }),
      demand("d-fx-2", 2, 180_000n, { currency: "USD" }),
      demand("d-fx-3", 3, 220_000n),
    ],
    [
      {
        incidentType: "FX_VOLATILITY",
        atStep: 1,
        spreadIncreaseBps: 150n,
      },
    ],
  ),
  scenario(
    "lab.baseline.delayed-write",
    "DELAYED_WRITE",
    "in-flight writes on rail-b become UNKNOWN and require reconciliation",
    [
      demand("d-dw-1", 0, 260_000n),
      demand("d-dw-2", 3, 140_000n),
    ],
    [
      {
        incidentType: "DELAYED_WRITE",
        atStep: 2,
        railId: "rail-b",
      },
    ],
  ),
  scenario(
    "lab.baseline.approval-delay",
    "APPROVAL_DELAY",
    "a customer approval is delayed beyond the deadline window",
    [
      demand("d-ap-1", 0, 180_000n, { requiresApproval: true, deadlineMs: 5_000 }),
      demand("d-ap-2", 2, 130_000n),
    ],
    [
      {
        incidentType: "APPROVAL_DELAY",
        atStep: 1,
        delayMs: 8_000,
      },
    ],
  ),
  scenario(
    "lab.baseline.fraud",
    "FRAUD",
    "fraudulent demands arrive alongside legitimate ones",
    [
      demand("d-fr-1", 0, 220_000n),
      demand("d-fr-2", 1, 95_000n, { adversarial: "FRAUD" }),
      demand("d-fr-3", 2, 160_000n),
    ],
  ),
  scenario(
    "lab.baseline.collusion",
    "COLLUSION",
    "colluding counterparties attempt circular value extraction",
    [
      demand("d-col-1", 0, 140_000n),
      demand("d-col-2", 1, 75_000n, { adversarial: "COLLUSION" }),
      demand("d-col-3", 2, 55_000n, { adversarial: "COLLUSION", direction: "INBOUND" }),
    ],
  ),
  scenario(
    "lab.baseline.malicious-agent",
    "MALICIOUS_AGENT",
    "a malicious agent instance issues unauthorized movement demands",
    [
      demand("d-ma-1", 0, 210_000n),
      demand("d-ma-2", 1, 640_000n, { adversarial: "MALICIOUS_AGENT" }),
    ],
  ),
  scenario(
    "lab.baseline.incentive-gaming",
    "INCENTIVE_GAMING",
    "demands engineered to farm participation incentives",
    [
      demand("d-ig-1", 0, 30_000n),
      demand("d-ig-2", 1, 20_000n, { adversarial: "INCENTIVE_GAMING" }),
      demand("d-ig-3", 2, 25_000n, { adversarial: "INCENTIVE_GAMING" }),
      demand("d-ig-4", 3, 28_000n),
    ],
  ),
  scenario(
    "lab.baseline.partial-payment",
    "PARTIAL_PAYMENT",
    "the provider executes only part of the demanded amount",
    [
      demand("d-pp-1", 0, 400_000n, { partialBps: 6_000n }),
      demand("d-pp-2", 1, 250_000n),
      demand("d-pp-3", 2, 180_000n, { partialBps: 4_500n }),
    ],
  ),
  scenario(
    "lab.baseline.congestion",
    "CONGESTION",
    "network-wide congestion degrades every rail's latency",
    [
      demand("d-con-1", 0, 170_000n),
      demand("d-con-2", 3, 190_000n),
      demand("d-con-3", 4, 120_000n, { deadlineMs: 3_000 }),
    ],
    [
      {
        incidentType: "CONGESTION",
        atStep: 1,
        addedLatencyMs: 2_500,
      },
    ],
  ),
  scenario(
    "lab.baseline.adversarial-model-behavior",
    "ADVERSARIAL_MODEL_BEHAVIOR",
    "an adversarially-behaving model routes a demand it must not touch",
    [
      demand("d-amb-1", 0, 260_000n),
      demand("d-amb-2", 1, 480_000n, { adversarial: "MALICIOUS_AGENT" }),
      demand("d-amb-3", 2, 150_000n),
    ],
  ),
]);

// ---------------------------------------------------------------------------
// Baseline candidate programs (LAB.md "Promotion": mandatory baseline suite)
// ---------------------------------------------------------------------------

export type BaselineCandidateKind =
  | "DETERMINISTIC_GENERALIST"
  | "HAND_DESIGNED"
  | "SEARCHED"
  | "INCUMBENT_PRODUCTION";

export interface BaselineCandidate {
  readonly baselineKind: BaselineCandidateKind;
  readonly label: string;
  /**
   * One of the three explicit execution modes; all three modes appear in the
   * baseline candidate set as EXPLICIT side-by-side candidates (LAB.md).
   */
  readonly executionMode: ExecutionMode;
  readonly program: SimulationProgram;
  /** INV-C08: the incumbent provider-native baseline. */
  readonly isIncumbentBaseline: boolean;
}

/** Baseline 1 — deterministic/generalist (LAB.md). */
export const BASELINE_DETERMINISTIC_GENERALIST_PROGRAM: SimulationProgram = {
  programId: "baseline.deterministic-generalist",
  programVersion: "1.0.0",
  routePreference: ["rail-a", "rail-b", "rail-c", "rail-d"],
  useNetting: false,
  useNetworkCredit: false,
  delayToleranceSteps: 0,
  fraudScreening: true,
  privacyBounded: true,
  authorizationMode: "PROTOCOL_AUTHORIZED",
};

/** Baseline 2 — hand-designed (LAB.md). */
export const BASELINE_HAND_DESIGNED_PROGRAM: SimulationProgram = {
  programId: "baseline.hand-designed",
  programVersion: "1.0.0",
  routePreference: ["rail-b", "rail-a", "rail-c", "rail-d"],
  useNetting: true,
  useNetworkCredit: true,
  delayToleranceSteps: 2,
  fraudScreening: true,
  privacyBounded: true,
  authorizationMode: "PROTOCOL_AUTHORIZED",
};

/**
 * Baseline 3 — searched (LAB.md): the greedy multi-provider program shape
 * produced by the deterministic search plug-in over the baseline world.
 * Kept as data here so the baseline suite is usable without running a
 * search first; search.test.ts asserts the plug-in reproduces this shape.
 */
export const BASELINE_SEARCHED_PROGRAM: SimulationProgram = {
  programId: "search.deterministic-baseline.optimized-multi-provider",
  programVersion: "1.0.0",
  routePreference: ["rail-d", "rail-b", "rail-a", "rail-c"],
  useNetting: true,
  useNetworkCredit: true,
  delayToleranceSteps: 2,
  fraudScreening: true,
  privacyBounded: true,
  authorizationMode: "PROTOCOL_AUTHORIZED",
};

/**
 * Baseline 4 — incumbent production candidate (LAB.md): the provider-native
 * optimization/recovery exposed by the incumbent connector, executed
 * PASS_THROUGH_NATIVE (INV-C08). It is NOT assumed inferior: the evaluator
 * compares it against the composed candidates under identical hard
 * constraints and evidence requirements.
 */
export const BASELINE_INCUMBENT_PROGRAM: SimulationProgram = {
  programId: "baseline.incumbent-native",
  programVersion: "1.0.0",
  routePreference: ["rail-a"],
  useNetting: false,
  useNetworkCredit: false,
  delayToleranceSteps: 0,
  fraudScreening: true,
  privacyBounded: true,
  authorizationMode: "PROTOCOL_AUTHORIZED",
};

export const BASELINE_CANDIDATES: readonly BaselineCandidate[] = Object.freeze([
  {
    baselineKind: "DETERMINISTIC_GENERALIST",
    label: "deterministic generalist: preference-ordered, no batching",
    executionMode: "COMPOSED_PAYSWAP",
    program: BASELINE_DETERMINISTIC_GENERALIST_PROGRAM,
    isIncumbentBaseline: false,
  },
  {
    baselineKind: "HAND_DESIGNED",
    label: "hand-designed: latency-first preference, netting + explicit credit",
    executionMode: "COMPOSED_PAYSWAP",
    program: BASELINE_HAND_DESIGNED_PROGRAM,
    isIncumbentBaseline: false,
  },
  {
    baselineKind: "SEARCHED",
    label: "searched: greedy multi-provider with netting and explicit credit",
    executionMode: "OPTIMIZED_MULTI_PROVIDER",
    program: BASELINE_SEARCHED_PROGRAM,
    isIncumbentBaseline: false,
  },
  {
    baselineKind: "INCUMBENT_PRODUCTION",
    label: "incumbent production candidate: provider-native, pass-through",
    executionMode: "PASS_THROUGH_NATIVE",
    program: BASELINE_INCUMBENT_PROGRAM,
    isIncumbentBaseline: true,
  },
]);

// ---------------------------------------------------------------------------
// The suite accessor
// ---------------------------------------------------------------------------

export interface BaselineSuite {
  readonly suiteId: string;
  readonly version: string;
  readonly domainPackId: string;
  readonly scenarios: readonly LabScenario[];
  readonly candidates: readonly BaselineCandidate[];
}

/** Default seed for baseline runs (deterministic, caller-overridable). */
export const BASELINE_SEED = "lab.baseline.seed.v1";

/**
 * Returns the mandatory baseline suite (LAB.md "Promotion"). Deterministic:
 * every call returns structurally identical data.
 */
export function getBaselineSuite(): BaselineSuite {
  return {
    suiteId: "lab.baseline-suite",
    version: "1.0.0",
    domainPackId: PAYMENT_ROUTING_DOMAIN_PACK.packId,
    scenarios: BASELINE_SCENARIOS,
    candidates: BASELINE_CANDIDATES,
  };
}

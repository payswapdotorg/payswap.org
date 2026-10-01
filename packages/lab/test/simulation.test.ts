import { describe, expect, it } from "vitest";
import {
  ADVERSARIAL_DEMAND_KINDS,
  isAdversarialDemandKind,
  isSimulationResult,
  runSimulation,
  SIMULATION_NAMESPACE,
} from "@payswap/lab";
import type {
  DemandPlan,
  SimulatedWorld,
  SimulationProgram,
  SimulationScenarioPlan,
} from "@payswap/lab";

/**
 * Simulation determinism, namespacing and behaviour (W2-004; INV-L01/F01;
 * LAB.md "Simulation and replay").
 */

const WORLD: SimulatedWorld = {
  worldId: "test-world",
  baseCurrency: "EUR",
  stepLatencyMs: 100,
  rails: [
    {
      railId: "rail-eur",
      currency: "EUR",
      latencyMs: 300,
      fixedFeeMinor: 10n,
      variableFeeBps: 5n,
    },
    {
      railId: "rail-usd",
      currency: "USD",
      latencyMs: 500,
      fixedFeeMinor: 20n,
      variableFeeBps: 8n,
      fxSpreadBps: 25n,
    },
  ],
  pools: [
    { poolId: "pool-eur", railId: "rail-eur", availableMinor: 1_000_000n },
    { poolId: "pool-usd", railId: "rail-usd", availableMinor: 500_000n },
  ],
};

const PROGRAM: SimulationProgram = {
  programId: "test.program",
  programVersion: "1.0.0",
  routePreference: ["rail-eur", "rail-usd"],
  useNetting: false,
  useNetworkCredit: false,
  delayToleranceSteps: 0,
  fraudScreening: true,
  privacyBounded: true,
  authorizationMode: "PROTOCOL_AUTHORIZED",
};

function plan(
  scenarioId: string,
  demands: readonly DemandPlan[],
  incidents: SimulationScenarioPlan["incidents"] = [],
): SimulationScenarioPlan {
  return { scenarioId, demands: [...demands], incidents: [...incidents] };
}

function demand(demandId: string, amountMinor: bigint, extra?: Partial<DemandPlan>): DemandPlan {
  return {
    demandId,
    atStep: 0,
    amountMinor,
    currency: "EUR",
    direction: "OUTBOUND",
    deadlineMs: 60_000,
    ...(extra ?? {}),
  };
}

const SEED = "test-seed";

describe("simulation determinism (LAB.md, INV-P03 discipline)", () => {
  it("same (scenario, world, program, seed) → deep-equal results", () => {
    const scenario = plan("s1", [
      demand("d1", 100_000n),
      demand("d2", 50_000n, { direction: "INBOUND", atStep: 1 }),
    ]);
    const runA = runSimulation({ scenario, world: WORLD, program: PROGRAM, seed: SEED });
    const runB = runSimulation({ scenario, world: WORLD, program: PROGRAM, seed: SEED });
    expect(runA).toEqual(runB);
    expect(runA.digest).toBe(runB.digest);
  });

  it("a different seed produces a different digest", () => {
    const scenario = plan("s1", [demand("d1", 100_000n)]);
    const runA = runSimulation({ scenario, world: WORLD, program: PROGRAM, seed: SEED });
    const runB = runSimulation({ scenario, world: WORLD, program: PROGRAM, seed: "other-seed" });
    expect(runA.digest).not.toBe(runB.digest);
  });

  it("a different program version produces a different digest", () => {
    const scenario = plan("s1", [demand("d1", 100_000n)]);
    const programV2: SimulationProgram = { ...PROGRAM, programVersion: "2.0.0" };
    const runA = runSimulation({ scenario, world: WORLD, program: PROGRAM, seed: SEED });
    const runB = runSimulation({ scenario, world: WORLD, program: programV2, seed: SEED });
    expect(runA.digest).not.toBe(runB.digest);
  });

  it("inputs are never mutated and results are frozen", () => {
    const scenario = plan("s1", [demand("d1", 100_000n)]);
    const scenarioSnapshot = JSON.stringify(scenario, (_, value) =>
      typeof value === "bigint" ? `bigint:${value}` : value,
    );
    const worldSnapshot = JSON.stringify(WORLD, (_, value) =>
      typeof value === "bigint" ? `bigint:${value}` : value,
    );
    const result = runSimulation({ scenario, world: WORLD, program: PROGRAM, seed: SEED });
    expect(JSON.stringify(scenario, (_, value) => (typeof value === "bigint" ? `bigint:${value}` : value))).toBe(
      scenarioSnapshot,
    );
    expect(JSON.stringify(WORLD, (_, value) => (typeof value === "bigint" ? `bigint:${value}` : value))).toBe(
      worldSnapshot,
    );
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.metrics)).toBe(true);
    expect(Object.isFrozen(result.outcomes)).toBe(true);
  });

  it("an empty scenario still yields a deterministic namespaced result", () => {
    const result = runSimulation({
      scenario: plan("empty", []),
      world: WORLD,
      program: PROGRAM,
      seed: SEED,
    });
    expect(result.namespace).toBe(SIMULATION_NAMESPACE);
    expect(result.metrics.totalDemands).toBe(0);
    expect(result.outcomes).toEqual([]);
  });
});

describe("simulation namespacing (INV-L01)", () => {
  it("results carry the simulation namespace brand and pass the runtime guard", () => {
    const result = runSimulation({
      scenario: plan("s1", [demand("d1", 100_000n)]),
      world: WORLD,
      program: PROGRAM,
      seed: SEED,
    });
    expect(isSimulationResult(result)).toBe(true);
    expect(result.__payswapSimulationNamespace).toBe(SIMULATION_NAMESPACE);
  });

  it("the runtime guard rejects non-simulation values", () => {
    expect(isSimulationResult(null)).toBe(false);
    expect(isSimulationResult(42)).toBe(false);
    expect(isSimulationResult({ namespace: "SOMETHING_ELSE" })).toBe(false);
    expect(isSimulationResult({})).toBe(false);
  });
});

describe("simulation economics (INV-F01 exact bigint arithmetic)", () => {
  it("settles a normal demand with exact fees on the preferred rail", () => {
    const result = runSimulation({
      scenario: plan("s1", [demand("d1", 100_000n)]),
      world: WORLD,
      program: PROGRAM,
      seed: SEED,
    });
    expect(result.metrics.settled).toBe(1);
    expect(result.outcomes[0]?.railId).toBe("rail-eur");
    // fees = fixed 10 + 100_000 * 5bps / 10_000 = 10 + 50 = 60
    expect(result.metrics.feesMinor).toBe(60n);
    expect(result.metrics.externalValueMovedMinor).toBe(100_000n);
    expect(result.metrics.hops).toBe(1);
  });

  it("netting internalizes matching opposite flows on the same rail and step", () => {
    const nettingProgram: SimulationProgram = {
      ...PROGRAM,
      useNetting: true,
      delayToleranceSteps: 1,
    };
    const result = runSimulation({
      scenario: plan("s-net", [
        demand("d-out", 100_000n, { direction: "OUTBOUND", atStep: 0 }),
        demand("d-in", 60_000n, { direction: "INBOUND", atStep: 0 }),
      ]),
      world: WORLD,
      program: nettingProgram,
      seed: SEED,
    });
    // internalized = 2 * min(100k, 60k) = 120k; external = 160k - 120k = 40k
    expect(result.metrics.nettedInternallyMinor).toBe(120_000n);
    expect(result.metrics.externalValueMovedMinor).toBe(40_000n);
    expect(result.metrics.settled).toBe(2);
  });

  it("cross-currency routing pays the declared FX spread exactly", () => {
    const usdProgram: SimulationProgram = {
      ...PROGRAM,
      routePreference: ["rail-usd"],
    };
    // An EUR demand routed onto the USD rail converts at the declared spread.
    const result = runSimulation({
      scenario: plan("s-fx", [demand("d1", 200_000n)]),
      world: WORLD,
      program: usdProgram,
      seed: SEED,
    });
    // fxSpread = 200_000 * 25bps / 10_000 = 500
    expect(result.metrics.fxSpreadPaidMinor).toBe(500n);
    // fees = fixed 20 + 200_000 * (8+25)bps / 10_000 = 20 + 660 = 680
    expect(result.metrics.feesMinor).toBe(680n);
    expect(result.outcomes[0]?.railId).toBe("rail-usd");
  });

  it("FX volatility widens the spread paid on conversions", () => {
    const usdProgram: SimulationProgram = {
      ...PROGRAM,
      routePreference: ["rail-usd"],
    };
    const calm = runSimulation({
      scenario: plan("s-fx-calm", [demand("d1", 200_000n)]),
      world: WORLD,
      program: usdProgram,
      seed: SEED,
    });
    const volatile = runSimulation({
      scenario: plan("s-fx-vol", [demand("d1", 200_000n)], [
        { incidentType: "FX_VOLATILITY", atStep: 0, spreadIncreaseBps: 100n },
      ]),
      world: WORLD,
      program: usdProgram,
      seed: SEED,
    });
    expect(volatile.metrics.fxSpreadPaidMinor).toBe(2_500n); // (25+100)bps on 200k
    expect(volatile.metrics.fxSpreadPaidMinor).toBeGreaterThan(calm.metrics.fxSpreadPaidMinor);
  });

  it("an outage forces fallback to the next rail in the preference", () => {
    const result = runSimulation({
      scenario: plan(
        "s-outage",
        [demand("d1", 100_000n, { atStep: 1 })],
        [{ incidentType: "PROVIDER_OUTAGE", atStep: 0, railId: "rail-eur" }],
      ),
      world: WORLD,
      program: PROGRAM,
      seed: SEED,
    });
    expect(result.metrics.settled).toBe(1);
    expect(result.outcomes[0]?.railId).toBe("rail-usd");
  });

  it("insufficient liquidity without credit fails over; with credit it draws explicit credit", () => {
    const big = demand("d1", 2_000_000n, { currency: "USD" }); // pool-usd 500k, pool-eur 1M
    const noCredit = runSimulation({
      scenario: plan("s-liquidity", [big]),
      world: WORLD,
      program: PROGRAM,
      seed: SEED,
    });
    expect(noCredit.metrics.failedNoViableRoute).toBe(1);
    expect(noCredit.metrics.settled).toBe(0);

    const withCredit = runSimulation({
      scenario: plan("s-liquidity", [big]),
      world: WORLD,
      program: { ...PROGRAM, useNetworkCredit: true },
      seed: SEED,
    });
    expect(withCredit.metrics.settled).toBe(1);
    expect(withCredit.metrics.creditExposureMinor).toBe(1_500_000n);
  });
});

describe("failure taxonomy (INV-X01: UNKNOWN is not FAILED)", () => {
  it("a delayed write yields UNKNOWN_REQUIRES_RECONCILIATION, never FAILED", () => {
    const result = runSimulation({
      scenario: plan(
        "s-delayed-write",
        [demand("d1", 100_000n, { atStep: 1 })],
        [{ incidentType: "DELAYED_WRITE", atStep: 0, railId: "rail-eur" }],
      ),
      world: WORLD,
      program: PROGRAM,
      seed: SEED,
    });
    expect(result.metrics.unknownOutcomes).toBe(1);
    expect(result.outcomes[0]?.outcome).toBe("UNKNOWN_REQUIRES_RECONCILIATION");
    expect(result.metrics.failedNoViableRoute).toBe(0);
  });

  it("an approval that misses the deadline becomes USER_ACTION_REQUIRED, not a failure", () => {
    const result = runSimulation({
      scenario: plan(
        "s-approval",
        [demand("d1", 100_000n, { requiresApproval: true, deadlineMs: 500 })],
        [{ incidentType: "APPROVAL_DELAY", atStep: 0, delayMs: 5_000 }],
      ),
      world: WORLD,
      program: PROGRAM,
      seed: SEED,
    });
    expect(result.metrics.userActionRequired).toBe(1);
    expect(result.metrics.settled).toBe(0);
    expect(result.metrics.failedNoViableRoute).toBe(0);
  });

  it("a partial payment is recorded as PARTIALLY_SETTLED", () => {
    const result = runSimulation({
      scenario: plan("s-partial", [
        demand("d1", 100_000n, { partialBps: 6_000n }),
      ]),
      world: WORLD,
      program: PROGRAM,
      seed: SEED,
    });
    expect(result.metrics.partiallySettled).toBe(1);
    expect(result.outcomes[0]?.movedMinor).toBe(60_000n);
  });
});

describe("adversarial demand taxonomy (LAB.md scenario generation)", () => {
  it("screens every adversarial kind when screening is enabled", () => {
    for (const kind of ADVERSARIAL_DEMAND_KINDS) {
      const result = runSimulation({
        scenario: plan(`s-adv-${kind}`, [demand("d1", 100_000n, { adversarial: kind })]),
        world: WORLD,
        program: PROGRAM,
        seed: SEED,
      });
      expect(result.metrics.blockedAdversarial).toBe(1);
      expect(result.outcomes[0]?.outcome).toBe("BLOCKED_FRAUD");
    }
  });

  it("an unscreened adversarial demand settles and is counted (compliance violation)", () => {
    const result = runSimulation({
      scenario: plan("s-adv-open", [demand("d1", 100_000n, { adversarial: "FRAUD" })]),
      world: WORLD,
      program: { ...PROGRAM, fraudScreening: false },
      seed: SEED,
    });
    expect(result.metrics.settled).toBe(1);
    expect(result.metrics.adversarialSettled).toBe(1);
  });

  it("isAdversarialDemandKind guards the taxonomy", () => {
    expect(isAdversarialDemandKind("COLLUSION")).toBe(true);
    expect(isAdversarialDemandKind("NOT_A_KIND")).toBe(false);
    expect(isAdversarialDemandKind(7)).toBe(false);
  });
});

describe("program discipline metrics (authorization, privacy)", () => {
  it("a declared authorization bypass is recorded per settled demand", () => {
    const result = runSimulation({
      scenario: plan("s-bypass", [demand("d1", 100_000n)]),
      world: WORLD,
      program: { ...PROGRAM, authorizationMode: "DECLARED_BYPASS" },
      seed: SEED,
    });
    expect(result.metrics.authorizationBypassEvents).toBe(1);
  });

  it("a non-privacy-bounded program records one violation per processed demand", () => {
    const result = runSimulation({
      scenario: plan("s-privacy", [demand("d1", 100_000n)]),
      world: WORLD,
      program: { ...PROGRAM, privacyBounded: false },
      seed: SEED,
    });
    expect(result.metrics.privacyViolations).toBe(1);
  });
});

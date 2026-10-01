import { describe, expect, it } from "vitest";
import {
  accumulateRobustnessEvidence,
  defaultEvaluationSpec,
  evaluateRun,
  runSimulation,
} from "@payswap/lab";
import type {
  SimulationProgram,
  SimulatedWorld,
} from "@payswap/lab";

/**
 * Evaluator: HARD CONSTRAINTS PRECEDE OPTIMIZATION (W2-004 acceptance;
 * AGENTS.md rule 14; LAB.md "Evaluation") + robustness evidence (INV-L02).
 */

const WORLD: SimulatedWorld = {
  worldId: "eval-world",
  baseCurrency: "EUR",
  stepLatencyMs: 100,
  rails: [
    {
      railId: "rail-cheap",
      currency: "EUR",
      latencyMs: 900,
      fixedFeeMinor: 1n,
      variableFeeBps: 1n,
    },
    {
      railId: "rail-pricey",
      currency: "EUR",
      latencyMs: 200,
      fixedFeeMinor: 90n,
      variableFeeBps: 90n,
    },
  ],
  pools: [
    { poolId: "pool-cheap", railId: "rail-cheap", availableMinor: 1_000_000n },
    { poolId: "pool-pricey", railId: "rail-pricey", availableMinor: 1_000_000n },
  ],
};

const SCENARIO = {
  scenarioId: "eval-scenario",
  demands: [
    {
      demandId: "d1",
      atStep: 0,
      amountMinor: 100n,
      currency: "EUR",
      direction: "OUTBOUND" as const,
      deadlineMs: 60_000,
      adversarial: "FRAUD" as const,
    },
    {
      demandId: "d2",
      atStep: 0,
      amountMinor: 300_000n,
      currency: "EUR",
      direction: "INBOUND" as const,
      deadlineMs: 60_000,
    },
  ],
  incidents: [],
};

const GOOD_PROGRAM: SimulationProgram = {
  programId: "good",
  programVersion: "1.0.0",
  routePreference: ["rail-pricey", "rail-cheap"],
  useNetting: false,
  useNetworkCredit: false,
  delayToleranceSteps: 0,
  fraudScreening: true,
  privacyBounded: true,
  authorizationMode: "PROTOCOL_AUTHORIZED",
};

// A cheap-but-lawless program: routes on the cheapest rail, but lets the
// fraudulent demand through (compliance violation) and bypasses
// authorization on every settled demand.
const LAWLESS_PROGRAM: SimulationProgram = {
  programId: "lawless",
  programVersion: "1.0.0",
  routePreference: ["rail-cheap"],
  useNetting: false,
  useNetworkCredit: false,
  delayToleranceSteps: 0,
  fraudScreening: false,
  privacyBounded: true,
  authorizationMode: "DECLARED_BYPASS",
};

describe("hard constraints are evaluated BEFORE optimization (AGENTS.md rule 14)", () => {
  it("phases is an ordered tuple: HARD_CONSTRAINTS first, then OPTIMIZATION", () => {
    const run = runSimulation({
      scenario: SCENARIO,
      world: WORLD,
      program: GOOD_PROGRAM,
      seed: "eval-seed",
    });
    const evaluation = evaluateRun({ run, program: GOOD_PROGRAM, spec: defaultEvaluationSpec() });
    expect(evaluation.phases[0]?.phase).toBe("HARD_CONSTRAINTS");
    expect(evaluation.phases[1]?.phase).toBe("OPTIMIZATION");
  });

  it("a hard-constraint failure disqualifies a candidate even with a BETTER optimization score", () => {
    const spec = defaultEvaluationSpec();
    const goodRun = runSimulation({
      scenario: SCENARIO,
      world: WORLD,
      program: GOOD_PROGRAM,
      seed: "eval-seed",
    });
    const lawlessRun = runSimulation({
      scenario: SCENARIO,
      world: WORLD,
      program: LAWLESS_PROGRAM,
      seed: "eval-seed",
    });
    const good = evaluateRun({ run: goodRun, program: GOOD_PROGRAM, spec });
    const lawless = evaluateRun({ run: lawlessRun, program: LAWLESS_PROGRAM, spec });

    // The lawless program is genuinely CHEAPER on the optimization
    // objectives (cheapest rail, fewer hops)...
    expect(lawless.totalOptimizationScoreMinor).toBeLessThan(good.totalOptimizationScoreMinor);
    // ...but it fails the hard constraints and is disqualified.
    expect(lawless.passed).toBe(false);
    expect(lawless.passedHardConstraints).toBe(false);
    expect(good.passed).toBe(true);

    const failures = lawless.phases[0]?.results.filter((result) => !result.passed) ?? [];
    const failedIds = failures.map((result) => result.constraintId).sort();
    expect(failedIds).toEqual(["AUTHORIZATION", "COMPLIANCE"]);
    expect(lawless.phases[1]?.disqualificationNote).toContain("informational only");
  });

  it("evaluation is deterministic and content-digested", () => {
    const spec = defaultEvaluationSpec();
    const run = runSimulation({
      scenario: SCENARIO,
      world: WORLD,
      program: GOOD_PROGRAM,
      seed: "eval-seed",
    });
    const a = evaluateRun({ run, program: GOOD_PROGRAM, spec });
    const b = evaluateRun({ run, program: GOOD_PROGRAM, spec });
    expect(a).toEqual(b);
    expect(a.digest).toBe(b.digest);
  });

  it("the aggregate optimization score is exact integer minor units (INV-F01)", () => {
    const run = runSimulation({
      scenario: SCENARIO,
      world: WORLD,
      program: GOOD_PROGRAM,
      seed: "eval-seed",
    });
    const evaluation = evaluateRun({ run, program: GOOD_PROGRAM, spec: defaultEvaluationSpec() });
    expect(typeof evaluation.totalOptimizationScoreMinor).toBe("bigint");
    for (const contribution of evaluation.phases[1]?.contributions ?? []) {
      expect(contribution.contributionMinor).toBe(
        contribution.observedMinor * contribution.weightBps,
      );
    }
  });
});

describe("domain-specific hard constraints (deadline, explicit credit)", () => {
  it("an undeclared credit draw violates EXPLICIT_CREDIT (INV-F08)", () => {
    const world: SimulatedWorld = {
      ...WORLD,
      pools: [{ poolId: "pool-cheap", railId: "rail-cheap", availableMinor: 10_000n }],
    };
    const program: SimulationProgram = {
      ...GOOD_PROGRAM,
      routePreference: ["rail-cheap", "rail-pricey"],
      useNetworkCredit: false,
    };
    const run = runSimulation({
      scenario: SCENARIO,
      world,
      program,
      seed: "eval-seed",
    });
    // Both demands draw on rail-cheap's tiny pool: d1 drains it, d2 falls
    // back to rail-pricey — no credit is possible without the declaration.
    expect(run.metrics.creditExposureMinor).toBe(0n);
    const spec = {
      ...defaultEvaluationSpec(),
      hardConstraints: [
        { constraintId: "EXPLICIT_CREDIT" as const, description: "credit must be declared" },
      ],
    };
    const evaluation = evaluateRun({ run, program, spec });
    expect(evaluation.passed).toBe(true);
  });

  it("a deadline miss violates the DEADLINE hard constraint when the pack declares it", () => {
    const tightScenario = {
      ...SCENARIO,
      demands: [
        {
          demandId: "d-late",
          atStep: 0,
          amountMinor: 100_000n,
          currency: "EUR",
          direction: "OUTBOUND" as const,
          deadlineMs: 10,
        },
      ],
    };
    const run = runSimulation({
      scenario: tightScenario,
      world: WORLD,
      program: GOOD_PROGRAM,
      seed: "eval-seed",
    });
    expect(run.metrics.deadlineMisses).toBe(1);
    const spec = {
      ...defaultEvaluationSpec(),
      hardConstraints: [
        { constraintId: "DEADLINE" as const, description: "no deadline misses" },
      ],
    };
    const evaluation = evaluateRun({ run, program: GOOD_PROGRAM, spec });
    expect(evaluation.passed).toBe(false);
    expect(evaluation.phases[0]?.results[0]?.constraintId).toBe("DEADLINE");
  });
});

describe("robustness evidence (INV-L02)", () => {
  it("accumulates across scenarios and seeds, tracking worst case and spread", () => {
    const spec = defaultEvaluationSpec();
    const evaluations = ["seed-a", "seed-b", "seed-c"].flatMap((seed) =>
      [SCENARIO, { ...SCENARIO, scenarioId: "eval-scenario-2" }].map((scenario) => {
        const run = runSimulation({ scenario, world: WORLD, program: GOOD_PROGRAM, seed });
        return evaluateRun({ run, program: GOOD_PROGRAM, spec });
      }),
    );
    const robustness = accumulateRobustnessEvidence({
      programId: GOOD_PROGRAM.programId,
      programVersion: GOOD_PROGRAM.programVersion,
      evaluations,
    });
    expect(robustness.totalRuns).toBe(6);
    expect(robustness.passedRuns).toBe(6);
    expect(robustness.allPassed).toBe(true);
    expect(robustness.worstScoreMinor).not.toBeUndefined();
    expect(robustness.scoreSpreadMinor).not.toBeUndefined();
  });

  it("one failing run makes allPassed false — a single lucky run is not robustness", () => {
    const spec = defaultEvaluationSpec();
    const goodRun = runSimulation({
      scenario: SCENARIO,
      world: WORLD,
      program: GOOD_PROGRAM,
      seed: "seed-a",
    });
    const badRun = runSimulation({
      scenario: SCENARIO,
      world: WORLD,
      program: LAWLESS_PROGRAM,
      seed: "seed-a",
    });
    const robustness = accumulateRobustnessEvidence({
      programId: "mixed",
      programVersion: "1.0.0",
      evaluations: [
        evaluateRun({ run: goodRun, program: GOOD_PROGRAM, spec }),
        evaluateRun({ run: badRun, program: LAWLESS_PROGRAM, spec }),
      ],
    });
    expect(robustness.totalRuns).toBe(2);
    expect(robustness.passedRuns).toBe(1);
    expect(robustness.allPassed).toBe(false);
  });

  it("robustness evidence is deterministic", () => {
    const spec = defaultEvaluationSpec();
    const build = () => {
      const run = runSimulation({
        scenario: SCENARIO,
        world: WORLD,
        program: GOOD_PROGRAM,
        seed: "seed-a",
      });
      return accumulateRobustnessEvidence({
        programId: GOOD_PROGRAM.programId,
        programVersion: GOOD_PROGRAM.programVersion,
        evaluations: [evaluateRun({ run, program: GOOD_PROGRAM, spec })],
      });
    };
    expect(build()).toEqual(build());
  });
});

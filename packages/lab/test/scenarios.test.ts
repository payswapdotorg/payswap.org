import { describe, expect, it } from "vitest";
import {
  BASELINE_CANDIDATES,
  BASELINE_WORLD,
  getBaselineSuite,
  LAB_SCENARIO_TYPE_IDS,
} from "@payswap/lab";
import {
  BASELINE_SEED,
  PAYMENT_ROUTING_DOMAIN_PACK,
  defaultEvaluationSpec,
  evaluateRun,
  runSimulation,
} from "@payswap/lab";

/**
 * The mandatory BASELINE SUITE (W2-004 acceptance: "baseline suite exists";
 * LAB.md "Scenario generation" + "Promotion").
 */

describe("baseline suite (LAB.md)", () => {
  const suite = getBaselineSuite();

  it("exists, is deterministic and covers every scenario taxonomy entry", () => {
    const again = getBaselineSuite();
    expect(again).toEqual(suite);
    expect(suite.scenarios.length).toBeGreaterThanOrEqual(13);
    const covered = new Set(suite.scenarios.map((scenario) => scenario.scenarioType));
    const missing = [...LAB_SCENARIO_TYPE_IDS].filter(
      (type) => !covered.has(type),
    );
    expect(missing).toEqual([]);
  });

  it("every scenario belongs to the payment-routing domain pack and the shared world", () => {
    for (const scenario of suite.scenarios) {
      expect(scenario.domainPackId).toBe(PAYMENT_ROUTING_DOMAIN_PACK.packId);
      expect(scenario.world).toEqual(BASELINE_WORLD);
      expect(scenario.plan.demands.length).toBeGreaterThan(0);
    }
  });

  it("every scenario is runnable and deterministic across repeated runs", () => {
    const program = BASELINE_CANDIDATES[0]?.program;
    if (program === undefined) {
      throw new Error("baseline candidates must not be empty");
    }
    for (const scenario of suite.scenarios) {
      const runA = runSimulation({
        scenario: scenario.plan,
        world: scenario.world,
        program,
        seed: BASELINE_SEED,
      });
      const runB = runSimulation({
        scenario: scenario.plan,
        world: scenario.world,
        program,
        seed: BASELINE_SEED,
      });
      expect(runA).toEqual(runB);
    }
  });
});

describe("baseline candidate set (LAB.md mandatory baselines)", () => {
  const suite = getBaselineSuite();

  it("contains exactly the four mandatory baseline kinds", () => {
    const kinds = BASELINE_CANDIDATES.map((candidate) => candidate.baselineKind);
    expect(kinds).toEqual([
      "DETERMINISTIC_GENERALIST",
      "HAND_DESIGNED",
      "SEARCHED",
      "INCUMBENT_PRODUCTION",
    ]);
  });

  it("presents ALL THREE execution modes as explicit side-by-side candidates", () => {
    const modes = new Set(BASELINE_CANDIDATES.map((candidate) => candidate.executionMode));
    expect(modes.has("PASS_THROUGH_NATIVE")).toBe(true);
    expect(modes.has("COMPOSED_PAYSWAP")).toBe(true);
    expect(modes.has("OPTIMIZED_MULTI_PROVIDER")).toBe(true);
  });

  it("marks exactly the incumbent production candidate as the incumbent baseline (INV-C08)", () => {
    const incumbents = BASELINE_CANDIDATES.filter(
      (candidate) => candidate.isIncumbentBaseline,
    );
    expect(incumbents.map((candidate) => candidate.baselineKind)).toEqual([
      "INCUMBENT_PRODUCTION",
    ]);
    expect(incumbents[0]?.executionMode).toBe("PASS_THROUGH_NATIVE");
  });

  it("runs GREEN: every baseline candidate passes the hard-constraint trio on the whole suite", () => {
    // AUTHORIZATION / COMPLIANCE / PRIVACY — the Lab default hard
    // constraints (AGENTS.md rule 14). Every baseline candidate screens
    // adversarial demand, stays protocol-authorized and privacy-bounded.
    const spec = defaultEvaluationSpec();
    const seeds = [BASELINE_SEED, `${BASELINE_SEED}:b`];
    for (const candidate of suite.candidates) {
      for (const scenario of suite.scenarios) {
        for (const seed of seeds) {
          const run = runSimulation({
            scenario: scenario.plan,
            world: scenario.world,
            program: candidate.program,
            seed,
          });
          const evaluation = evaluateRun({ run, program: candidate.program, spec });
          expect({
            candidate: candidate.baselineKind,
            scenario: scenario.scenarioId,
            seed,
            passed: evaluation.passedHardConstraints,
          }).toEqual({
            candidate: candidate.baselineKind,
            scenario: scenario.scenarioId,
            seed,
            passed: true,
          });
        }
      }
    }
  });
});

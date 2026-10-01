import { describe, expect, it } from "vitest";
import { USD, fromMinorUnits } from "@payswap/protocol";
import {
  comparePromotionCandidates,
  defaultEvaluationSpec,
  evaluateRun,
  getBaselineSuite,
  runSimulation,
} from "@payswap/lab";
import type { RankedPromotionCandidate } from "@payswap/lab";
import { runPspIncumbentJourney } from "../src/journeys/psp-incumbent.js";
import { ACCEPTANCE_AXES } from "../src/harness.js";
import { expectAxesCovered, expectJourneyPasses } from "./journey-helpers.js";

describe("Journey: incumbent-preserving PSP execution (W1-007)", () => {
  const outcome = runPspIncumbentJourney();

  it("passes every acceptance axis INCLUDING the PASS_THROUGH_NATIVE baseline", () => {
    expectJourneyPasses(outcome.journey);
  });

  it("asserts all six acceptance axes", () => {
    expectAxesCovered(outcome.journey, ACCEPTANCE_AXES);
  });

  it("executes PASS_THROUGH_NATIVE through the incumbent in one step", () => {
    expect(outcome.details.planMode).toBe("PASS_THROUGH_NATIVE");
    expect(outcome.details.preservesNativeFlow).toBe(true);
    expect(outcome.details.incumbentProviderName).toBe("psp-native");
    expect(outcome.details.plan.steps).toHaveLength(1);
    expect(outcome.details.offerFees).toEqual(fromMinorUnits(USD, 2_400n));
  });

  it("represents the incumbent's native optimization as a benchmark baseline (INV-C08)", () => {
    expect(outcome.details.benchmarkBaselineCapabilities).toContain("cap.native.card.collect");
  });

  it("passes the SAME uniform gate wall in every mode (INV-C07)", () => {
    expect(outcome.details.uniformGateResults).toHaveLength(3);
    for (const gate of outcome.details.uniformGateResults) {
      expect({ candidateId: gate.candidateId, mode: gate.mode, passed: gate.passed }).toMatchObject({
        passed: true,
      });
    }
  });

  it("certifies the incumbent baseline as available (registered instance, observed AVAILABLE)", () => {
    expect(outcome.details.incumbentInstanceAvailable).toBe(true);
    expect(outcome.details.incumbentProviderName).toBe("psp-native");
  });

  it("includes the candidate comparison record against composed/multi-provider candidates (no mode prior)", () => {
    // The Lab's baseline suite is composed HERE (test layer) per the
    // repo-wide simulation-isolation boundary (INV-L01, AGENTS rule 7):
    // evidence-only ranking with NO mode prior — the incumbent is never
    // assumed inferior (nor superior).
    const suite = getBaselineSuite();
    const spec = defaultEvaluationSpec();
    const scenario = suite.scenarios[0];
    expect(scenario).toBeDefined();
    if (scenario === undefined) return;
    const byKind = (kind: string) => suite.candidates.find((c) => c.baselineKind === kind);
    const incumbent = byKind("INCUMBENT_PRODUCTION");
    const composed = byKind("HAND_DESIGNED");
    const multiProvider = byKind("SEARCHED");
    expect(incumbent).toBeDefined();
    expect(composed).toBeDefined();
    expect(multiProvider).toBeDefined();
    if (!incumbent || !composed || !multiProvider) return;
    const evaluations = [
      { candidateId: "lab:incumbent-production", executionMode: incumbent.executionMode, isIncumbentBaseline: incumbent.isIncumbentBaseline, program: incumbent.program },
      { candidateId: "lab:hand-designed", executionMode: composed.executionMode, isIncumbentBaseline: composed.isIncumbentBaseline, program: composed.program },
      { candidateId: "lab:searched", executionMode: multiProvider.executionMode, isIncumbentBaseline: multiProvider.isIncumbentBaseline, program: multiProvider.program },
    ].map((input) => ({
      candidateId: input.candidateId,
      executionMode: input.executionMode,
      isIncumbentBaseline: input.isIncumbentBaseline,
      evaluation: evaluateRun({
        run: runSimulation({
          scenario: scenario.plan,
          world: scenario.world,
          program: input.program,
          seed: "journey.psp-incumbent.seed",
        }),
        program: input.program,
        spec,
      }),
    }));
    const ranking: readonly RankedPromotionCandidate[] = comparePromotionCandidates(evaluations);
    expect(ranking).toHaveLength(3);
    const incumbentRank = ranking.find((r) => r.isIncumbentBaseline);
    expect(incumbentRank?.candidateId).toBe("lab:incumbent-production");
    expect(new Set(ranking.map((r) => r.rank)).size).toBe(3);
    // Hard constraints first, then score — no mode-based prior.
    const sorted = [...ranking].sort((a, b) => a.rank - b.rank);
    for (let i = 1; i < sorted.length; i += 1) {
      const prev = sorted[i - 1];
      const curr = sorted[i];
      if (prev && curr && prev.passedHardConstraints && !curr.passedHardConstraints) {
        throw new Error("ranking must rank hard-constraint passers first");
      }
    }
  });

  it("settles the pass-through payment with protocol-declared finality", () => {
    expect(outcome.details.chain.settlements[0]?.finality.state).toBe("FINAL");
    expect(outcome.details.chain.settlements[0]?.instruction.amount).toEqual(fromMinorUnits(USD, 80_000n));
  });
});

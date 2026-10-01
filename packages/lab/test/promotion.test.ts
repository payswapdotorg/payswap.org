import { describe, expect, it } from "vitest";
import {
  PromotionLedger,
  comparePromotionCandidates,
  defaultEvaluationSpec,
  evaluateRun,
  requiredEvidenceForTarget,
  runSimulation,
} from "@payswap/lab";
import type { PromotionEvidenceRef, SimulationProgram } from "@payswap/lab";

/**
 * Shadow/canary promotion (W2-004 acceptance; LAB.md "Promotion";
 * INV-L02/L03; INV-C08 side-by-side comparison without a composition prior).
 */

function evidence(kinds: readonly PromotionEvidenceRef["kind"][]): PromotionEvidenceRef[] {
  return kinds.map((kind, index) => ({
    evidenceId: `ev-${kind}-${index}`,
    kind,
    artifactRef: `artifacts/${kind}-${index}`,
    contentDigest: `digest-${kind}-${index}`,
  }));
}

const FULL_TRIPLE = evidence(["REPLAY", "COUNTERFACTUAL", "ROBUSTNESS"]);

describe("promotion evidence gating (INV-L02)", () => {
  it("requires the replay/counterfactual/robustness triple to reach SHADOW", () => {
    const ledger = new PromotionLedger();
    // Advance legally to VALIDATED first; SHADOW is then reachable and ONLY
    // the INV-L02 evidence bundle can block it.
    ledger.orderPromotion({
      candidateId: "cand-1",
      candidateVersion: 1,
      targetStage: "BENCHMARKED",
      evidence: evidence(["BASELINE_SUITE_EVALUATION"]),
      orderedAt: "t0",
    });
    ledger.orderPromotion({
      candidateId: "cand-1",
      candidateVersion: 1,
      targetStage: "VALIDATED",
      evidence: FULL_TRIPLE,
      orderedAt: "t0.5",
    });
    expect(() =>
      ledger.orderPromotion({
        candidateId: "cand-1",
        candidateVersion: 1,
        targetStage: "SHADOW",
        evidence: [],
        orderedAt: "t1",
      }),
    ).toThrow(/INV-L02/);

    expect(() =>
      ledger.orderPromotion({
        candidateId: "cand-1",
        candidateVersion: 1,
        targetStage: "SHADOW",
        evidence: evidence(["REPLAY", "ROBUSTNESS"]),
        orderedAt: "t2",
      }),
    ).toThrow(/COUNTERFACTUAL/);
  });

  it("advances DRAFT → BENCHMARKED → VALIDATED → SHADOW with the required evidence", () => {
    const ledger = new PromotionLedger();
    const toBenchmarked = ledger.orderPromotion({
      candidateId: "cand-1",
      candidateVersion: 1,
      targetStage: "BENCHMARKED",
      evidence: evidence(["BASELINE_SUITE_EVALUATION"]),
      orderedAt: "t1",
    });
    expect(toBenchmarked.fromStage).toBe("DRAFT");
    expect(toBenchmarked.toStage).toBe("BENCHMARKED");

    const toValidated = ledger.orderPromotion({
      candidateId: "cand-1",
      candidateVersion: 1,
      targetStage: "VALIDATED",
      evidence: FULL_TRIPLE,
      orderedAt: "t2",
    });
    expect(toValidated.toStage).toBe("VALIDATED");

    const toShadow = ledger.orderPromotion({
      candidateId: "cand-1",
      candidateVersion: 1,
      targetStage: "SHADOW",
      evidence: FULL_TRIPLE,
      orderedAt: "t3",
    });
    expect(toShadow.toStage).toBe("SHADOW");
    expect(ledger.currentStage("cand-1")).toBe("SHADOW");
  });

  it("CANARY additionally requires a shadow report; PRODUCTION a canary report too", () => {
    const ledger = new PromotionLedger();
    ledger.orderPromotion({
      candidateId: "cand-2",
      candidateVersion: 1,
      targetStage: "BENCHMARKED",
      evidence: evidence(["BASELINE_SUITE_EVALUATION"]),
      orderedAt: "t1",
    });
    ledger.orderPromotion({
      candidateId: "cand-2",
      candidateVersion: 1,
      targetStage: "VALIDATED",
      evidence: FULL_TRIPLE,
      orderedAt: "t2",
    });
    ledger.orderPromotion({
      candidateId: "cand-2",
      candidateVersion: 1,
      targetStage: "SHADOW",
      evidence: FULL_TRIPLE,
      orderedAt: "t3",
    });
    expect(() =>
      ledger.orderPromotion({
        candidateId: "cand-2",
        candidateVersion: 1,
        targetStage: "CANARY",
        evidence: FULL_TRIPLE,
        orderedAt: "t4",
      }),
    ).toThrow(/SHADOW_REPORT/);

    ledger.orderPromotion({
      candidateId: "cand-2",
      candidateVersion: 1,
      targetStage: "CANARY",
      evidence: evidence(["REPLAY", "COUNTERFACTUAL", "ROBUSTNESS", "SHADOW_REPORT"]),
      orderedAt: "t5",
    });
    expect(() =>
      ledger.orderPromotion({
        candidateId: "cand-2",
        candidateVersion: 1,
        targetStage: "PRODUCTION",
        evidence: evidence([
          "REPLAY",
          "COUNTERFACTUAL",
          "ROBUSTNESS",
          "SHADOW_REPORT",
        ]),
        orderedAt: "t6",
      }),
    ).toThrow(/CANARY_REPORT/);
  });

  it("requiredEvidenceForTarget mirrors the LAB.md stage contract", () => {
    expect(requiredEvidenceForTarget("BENCHMARKED")).toEqual(["BASELINE_SUITE_EVALUATION"]);
    expect(requiredEvidenceForTarget("SHADOW")).toEqual(["REPLAY", "COUNTERFACTUAL", "ROBUSTNESS"]);
    expect(requiredEvidenceForTarget("CANARY")).toContain("SHADOW_REPORT");
    expect(requiredEvidenceForTarget("PRODUCTION")).toContain("CANARY_REPORT");
    expect(requiredEvidenceForTarget("RETIRED")).toEqual([]);
  });
});

describe("promotion is versioned and reversible (INV-L03)", () => {
  function advancedLedger(): PromotionLedger {
    const ledger = new PromotionLedger();
    ledger.orderPromotion({
      candidateId: "cand-3",
      candidateVersion: 4,
      targetStage: "BENCHMARKED",
      evidence: evidence(["BASELINE_SUITE_EVALUATION"]),
      orderedAt: "t1",
    });
    ledger.orderPromotion({
      candidateId: "cand-3",
      candidateVersion: 4,
      targetStage: "VALIDATED",
      evidence: FULL_TRIPLE,
      orderedAt: "t2",
    });
    ledger.orderPromotion({
      candidateId: "cand-3",
      candidateVersion: 4,
      targetStage: "SHADOW",
      evidence: FULL_TRIPLE,
      orderedAt: "t3",
    });
    ledger.orderPromotion({
      candidateId: "cand-3",
      candidateVersion: 4,
      targetStage: "CANARY",
      evidence: evidence(["REPLAY", "COUNTERFACTUAL", "ROBUSTNESS", "SHADOW_REPORT"]),
      orderedAt: "t4",
    });
    ledger.orderPromotion({
      candidateId: "cand-3",
      candidateVersion: 4,
      targetStage: "PRODUCTION",
      evidence: evidence([
        "REPLAY",
        "COUNTERFACTUAL",
        "ROBUSTNESS",
        "SHADOW_REPORT",
        "CANARY_REPORT",
      ]),
      orderedAt: "t5",
    });
    return ledger;
  }

  it("stage skipping is rejected", () => {
    const ledger = new PromotionLedger();
    expect(() =>
      ledger.orderPromotion({
        candidateId: "cand-skip",
        candidateVersion: 1,
        targetStage: "SHADOW",
        evidence: FULL_TRIPLE,
        orderedAt: "t0",
      }),
    ).toThrow(/one stage at a time/);
    expect(() =>
      ledger.orderPromotion({
        candidateId: "cand-skip",
        candidateVersion: 1,
        targetStage: "PRODUCTION",
        evidence: FULL_TRIPLE,
        orderedAt: "t0",
      }),
    ).toThrow(/illegal stage transition/);
  });

  it("every order references an immutable published candidate version", () => {
    const ledger = advancedLedger();
    for (const order of ledger.historyFor("cand-3")) {
      expect(order.candidateVersion).toBe(4);
      expect(typeof order.orderDigest).toBe("string");
      expect(order.orderDigest.length).toBeGreaterThan(0);
    }
  });

  it("a rollback APPENDS to history and moves the active stage back (never rewrites)", () => {
    const ledger = advancedLedger();
    const historyBefore = ledger.historyFor("cand-3").map((order) => order.orderId);
    const rollback = ledger.orderRollback({
      candidateId: "cand-3",
      candidateVersion: 4,
      toStage: "VALIDATED",
      reason: "canary regression detected",
      orderedAt: "t6",
    });
    expect(rollback.orderKind).toBe("ROLLBACK");
    expect(rollback.fromStage).toBe("PRODUCTION");
    expect(rollback.toStage).toBe("VALIDATED");
    expect(ledger.currentStage("cand-3")).toBe("VALIDATED");

    const historyAfter = ledger.historyFor("cand-3").map((order) => order.orderId);
    expect(historyAfter.slice(0, historyBefore.length)).toEqual(historyBefore);
    expect(historyAfter.length).toBe(historyBefore.length + 1);
  });

  it("retirement is terminal but the history remains queryable", () => {
    const ledger = advancedLedger();
    const retire = ledger.retire({
      candidateId: "cand-3",
      candidateVersion: 4,
      reason: "superseded",
      orderedAt: "t7",
    });
    expect(retire.toStage).toBe("RETIRED");
    expect(ledger.historyFor("cand-3").length).toBe(6);
    expect(() =>
      ledger.orderRollback({
        candidateId: "cand-3",
        candidateVersion: 4,
        toStage: "VALIDATED",
        reason: "late",
        orderedAt: "t8",
      }),
    ).toThrow(/retired/);
  });

  it("rollback targets must be EARLIER than the current stage", () => {
    const ledger = new PromotionLedger();
    ledger.orderPromotion({
      candidateId: "cand-4",
      candidateVersion: 1,
      targetStage: "BENCHMARKED",
      evidence: evidence(["BASELINE_SUITE_EVALUATION"]),
      orderedAt: "t1",
    });
    expect(() =>
      ledger.orderRollback({
        candidateId: "cand-4",
        candidateVersion: 1,
        toStage: "PRODUCTION",
        reason: "forward is not rollback",
        orderedAt: "t2",
      }),
    ).toThrow(/earlier/);
  });
});

describe("side-by-side candidate comparison (INV-C07/C08: no composition prior)", () => {
  // Real evaluations: deterministic world with a cheap and a pricey rail.
  const WORLD: Parameters<typeof runSimulation>[0]["world"] = {
    worldId: "compare-world",
    baseCurrency: "EUR",
    stepLatencyMs: 100,
    rails: [
      {
        railId: "rail-cheap",
        currency: "EUR",
        latencyMs: 800,
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
    scenarioId: "compare-scenario",
    demands: [
      {
        demandId: "d1",
        atStep: 0,
        amountMinor: 100_000n,
        currency: "EUR",
        direction: "OUTBOUND" as const,
        deadlineMs: 60_000,
      },
    ],
    incidents: [],
  };

  function programOf(
    programId: string,
    routePreference: readonly string[],
    overrides?: Partial<SimulationProgram>,
  ): SimulationProgram {
    return {
      programId,
      programVersion: "1.0.0",
      routePreference,
      useNetting: false,
      useNetworkCredit: false,
      delayToleranceSteps: 0,
      fraudScreening: true,
      privacyBounded: true,
      authorizationMode: "PROTOCOL_AUTHORIZED",
      ...(overrides ?? {}),
    };
  }

  function evaluate(program: SimulationProgram): ReturnType<typeof evaluateRun> {
    const run = runSimulation({ scenario: SCENARIO, world: WORLD, program, seed: "cmp" });
    return evaluateRun({ run, program, spec: defaultEvaluationSpec() });
  }

  it("ranks PASS_THROUGH_NATIVE above composed candidates when the incumbent scores better", () => {
    const ranked = comparePromotionCandidates([
      {
        candidateId: "cand-native",
        executionMode: "PASS_THROUGH_NATIVE",
        isIncumbentBaseline: true,
        evaluation: evaluate(programOf("native", ["rail-cheap"])),
      },
      {
        candidateId: "cand-composed",
        executionMode: "COMPOSED_PAYSWAP",
        isIncumbentBaseline: false,
        evaluation: evaluate(programOf("composed", ["rail-pricey"])),
      },
      {
        candidateId: "cand-multi",
        executionMode: "OPTIMIZED_MULTI_PROVIDER",
        isIncumbentBaseline: false,
        evaluation: evaluate(programOf("multi", ["rail-pricey", "rail-cheap"])),
      },
    ]);
    expect(ranked[0]?.candidateId).toBe("cand-native");
    expect(ranked[0]?.isIncumbentBaseline).toBe(true);
    expect(ranked.map((entry) => entry.rank)).toEqual([1, 2, 3]);
  });

  it("ranks a composed candidate above the incumbent when IT scores better (both directions)", () => {
    const ranked = comparePromotionCandidates([
      {
        candidateId: "cand-native",
        executionMode: "PASS_THROUGH_NATIVE",
        isIncumbentBaseline: true,
        evaluation: evaluate(programOf("native", ["rail-pricey"])),
      },
      {
        candidateId: "cand-composed",
        executionMode: "COMPOSED_PAYSWAP",
        isIncumbentBaseline: false,
        evaluation: evaluate(programOf("composed", ["rail-cheap"])),
      },
    ]);
    expect(ranked[0]?.candidateId).toBe("cand-composed");
    expect(ranked[1]?.candidateId).toBe("cand-native");
  });

  it("hard-constraint failures rank below every passing candidate regardless of score", () => {
    const ranked = comparePromotionCandidates([
      {
        candidateId: "cand-cheap-but-lawless",
        executionMode: "COMPOSED_PAYSWAP",
        isIncumbentBaseline: false,
        evaluation: evaluate(
          programOf("lawless", ["rail-cheap"], {
            fraudScreening: false,
            authorizationMode: "DECLARED_BYPASS",
          }),
        ),
      },
      {
        candidateId: "cand-sound",
        executionMode: "PASS_THROUGH_NATIVE",
        isIncumbentBaseline: true,
        evaluation: evaluate(programOf("sound", ["rail-pricey"])),
      },
    ]);
    expect(ranked[0]?.candidateId).toBe("cand-sound");
    expect(ranked[0]?.passedHardConstraints).toBe(true);
    expect(ranked[1]?.candidateId).toBe("cand-cheap-but-lawless");
    expect(ranked[1]?.passedHardConstraints).toBe(false);
  });

  it("equal scores tie-break deterministically on candidateId", () => {
    const ranked = comparePromotionCandidates([
      {
        candidateId: "cand-a",
        executionMode: "COMPOSED_PAYSWAP",
        isIncumbentBaseline: false,
        evaluation: evaluate(programOf("tie-a", ["rail-cheap"])),
      },
      {
        candidateId: "cand-b",
        executionMode: "COMPOSED_PAYSWAP",
        isIncumbentBaseline: false,
        evaluation: evaluate(programOf("tie-b", ["rail-cheap"])),
      },
    ]);
    expect(ranked.map((entry) => entry.candidateId)).toEqual(["cand-a", "cand-b"]);
    expect(ranked[0]?.totalOptimizationScoreMinor).toBe(ranked[1]?.totalOptimizationScoreMinor);
  });
});

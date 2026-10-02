import { describe, expect, it } from "vitest";
import {
  type ConformanceCertificationReport,
  conformanceProfileSet,
  formatConformanceSummary,
  runCrossProviderConformance,
} from "../src/conformance/runner.js";
import {
  CONFORMANCE_GATE_NAMES,
  CONFORMANCE_SCENARIO_IDS,
} from "../src/conformance/model.js";

describe("Cross-provider conformance certification (P2-W2-003)", () => {
  const reportPromise: Promise<ConformanceCertificationReport> =
    runCrossProviderConformance();

  it("certifies the merged production provider set (Wave 1 + Wave 2)", () => {
    expect(conformanceProfileSet.profiles.map((p) => p.providerName)).toEqual(
      expect.arrayContaining(["stripe", "paystack", "flutterwave"]),
    );
  });

  it("exercises every one of the 13 work-order lifecycle scenarios", async () => {
    const report = await reportPromise;
    expect(report.scenarioIds).toEqual(CONFORMANCE_SCENARIO_IDS);
    expect(report.scenarioIds).toHaveLength(13);
    // every scenario is EXECUTED by at least one provider — no scenario is
    // waved off across the whole provider set
    for (const s of report.scenarios) {
      expect(s.executed, `${s.scenarioId} executed by no provider`).toBeGreaterThan(0);
      expect(s.failed, `${s.scenarioId} has FAIL verdicts`).toBe(0);
    }
  });

  it("accounts for every (provider × scenario) pair — no silent skips", async () => {
    const report = await reportPromise;
    const expectedPairs = conformanceProfileSet.profiles.length * 13;
    expect(report.totalPairs).toBe(expectedPairs);
    expect(report.totalPairs).toBe(report.executedPairs + report.notApplicablePairs);
    expect(report.verdicts).toHaveLength(expectedPairs);
  });

  it("runs the four SHARED gates on every executed pair (the acceptance line 2)", async () => {
    const report = await reportPromise;
    const executed = report.verdicts.filter((v) => v.verdict !== "NOT_APPLICABLE");
    expect(executed.length).toBe(report.executedPairs);
    for (const v of executed) {
      expect(
        v.gateChecks.map((g) => g.gate).sort(),
        `${v.providerName}/${v.scenarioId} gate set`,
      ).toEqual([...CONFORMANCE_GATE_NAMES].sort());
      for (const g of v.gateChecks) {
        expect(
          g.passed,
          `${v.providerName}/${v.scenarioId} gate ${g.gate}: ${g.summary}`,
        ).toBe(true);
      }
    }
  });

  it("carries an honest, non-empty basis for every NOT_APPLICABLE pair", async () => {
    const report = await reportPromise;
    for (const v of report.verdicts) {
      if (v.verdict !== "NOT_APPLICABLE") continue;
      const basis = v.notes[0];
      expect(basis, `${v.providerName}/${v.scenarioId} N/A basis`).toBeDefined();
      expect(basis).toMatch(/^NOT_APPLICABLE: .+$/);
      expect((basis ?? "").length).toBeGreaterThan("NOT_APPLICABLE: ".length + 10);
    }
  });

  it("passes every executed pair — the certification verdict", async () => {
    const report = await reportPromise;
    expect(report.failedPairs).toBe(0);
    expect(report.passedPairs).toBe(report.executedPairs);
    expect(report.executedPairs).toBeGreaterThan(0);
    expect(report.allPassed).toBe(true);
  });

  it("is deterministic: two full runs produce identical reports", async () => {
    const a = await runCrossProviderConformance();
    const b = await runCrossProviderConformance();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("formats an honest human-readable summary", async () => {
    const report = await reportPromise;
    const text = formatConformanceSummary(report);
    expect(text).toContain("P2-W2-003 cross-provider conformance certification");
    expect(text).toContain(`allPassed: ${report.allPassed}`);
    expect(text).toContain("provider roll-up:");
    expect(text).toContain("scenario roll-up:");
    for (const p of report.providers) {
      expect(text).toContain(p.providerName);
    }
    // every N/A basis is visible in the summary — nothing hidden
    for (const p of report.providers) {
      for (const basis of Object.values(p.notApplicableBases)) {
        expect(text).toContain(basis);
      }
    }
    expect(text.length).toBeGreaterThan(200);
  });
});

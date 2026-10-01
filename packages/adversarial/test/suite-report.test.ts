import { describe, expect, it } from "vitest";
import { FAULT_FAMILIES, PACKAGE_NAME } from "../src/index.js";
import { runAdversarialSuite, suiteDeterministic, suitePassed } from "../src/index.js";
import { standardAdversarialSuite } from "./adversarial-helpers.js";

/**
 * The W2-007 adversarial suite report: all eleven fault families run against
 * the REAL subsystems (security planes and the Lab replay wired at the test
 * layer), every family and invariant covered, every verdict recomputed, and
 * the whole report digest-deterministic.
 */

describe("W2-007 adversarial suite report", () => {
  it("runs every fault family against the real subsystems and passes overall", async () => {
    const report = await runAdversarialSuite(standardAdversarialSuite());
    expect(PACKAGE_NAME).toBe("@payswap/adversarial");
    expect(report.suiteId).toBe("payswap.adversarial-suite");
    expect(report.workOrder).toBe("W2-007");
    expect(report.faultCount).toBe(FAULT_FAMILIES.length);
    expect(report.faultCount).toBe(11);
    expect(suitePassed(report)).toBe(true);
    expect(report.overallPassed).toBe(true);
  });

  it("covers every W2-007 fault family exactly once", async () => {
    const report = await runAdversarialSuite(standardAdversarialSuite());
    expect(report.familyCoverage.length).toBe(FAULT_FAMILIES.length);
    for (const coverage of report.familyCoverage) {
      expect(coverage.asserted, `family ${coverage.family} must be asserted`).toBe(true);
      expect(coverage.passed, `family ${coverage.family} must pass`).toBe(true);
      expect(coverage.faultId).toBeDefined();
    }
    const families = report.verdicts.map((verdict) => verdict.family);
    expect(new Set(families).size).toBe(families.length);
    for (const family of FAULT_FAMILIES) {
      expect(families, `missing family ${family}`).toContain(family);
    }
  });

  it("exercises a broad invariant set with every probe held", async () => {
    const report = await runAdversarialSuite(standardAdversarialSuite());
    expect(report.invariantCount).toBeGreaterThanOrEqual(25);
    for (const coverage of report.invariantCoverage) {
      expect(coverage.held, `invariant ${coverage.invariantId} must hold`).toBe(true);
      expect(coverage.probedBy.length).toBeGreaterThan(0);
    }
    const invariantIds = report.invariantCoverage.map((coverage) => coverage.invariantId);
    // One probe per W2-007 invariant family axis (financial, failure,
    // authorization, agents, capabilities, participation, security,
    // operations, evidence).
    for (const expected of [
      "INV-F03",
      "INV-F04",
      "INV-F05",
      "INV-F07",
      "INV-X01",
      "INV-X02",
      "INV-X03",
      "INV-X04",
      "INV-A01",
      "INV-A02",
      "INV-A04",
      "INV-A05",
      "INV-G02",
      "INV-G03",
      "INV-C04",
      "INV-C06",
      "INV-P01",
      "INV-P02",
      "INV-P03",
      "INV-P04",
      "INV-P05",
      "INV-P06",
      "INV-S01",
      "INV-S02",
      "INV-S03",
      "INV-S04",
      "INV-O01",
      "INV-O02",
      "INV-E01",
      "INV-E02",
      "INV-E04",
      "INV-E05",
    ]) {
      expect(invariantIds, `missing invariant ${expected}`).toContain(expected);
    }
  });

  it("produces a deterministic digest (identical re-run)", async () => {
    const first = await runAdversarialSuite(standardAdversarialSuite());
    const second = await runAdversarialSuite(standardAdversarialSuite());
    expect(suiteDeterministic(first, second)).toBe(true);
    expect(first.digest).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
    expect(first.verdicts.map((v) => v.faultId)).toEqual(
      second.verdicts.map((v) => v.faultId),
    );
  });

  it("fails closed when a family is missing from the scenario list", async () => {
    const scenarios = standardAdversarialSuite().slice(0, 10);
    const report = await runAdversarialSuite(scenarios);
    expect(report.faultCount).toBe(10);
    expect(report.overallPassed).toBe(false);
    expect(report.familyCoverage.some((coverage) => !coverage.asserted)).toBe(true);
  });
});

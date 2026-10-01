import { describe, expect, it } from "vitest";
import { ACCEPTANCE_AXES } from "../src/harness.js";
import { JOURNEYS, certifyAllJourneys } from "../src/certification.js";
import type { JourneyCertificationReport } from "../src/certification.js";

describe("Journey certification report (W1-007)", () => {
  const reportPromise: Promise<JourneyCertificationReport> = certifyAllJourneys();

  it("certifies all 12 journeys of the work order", async () => {
    const report = await reportPromise;
    expect(report.journeyCount).toBe(12);
    expect(report.certifications.map((c) => c.journeyId)).toEqual([
      "p2p",
      "merchant-checkout",
      "cross-border",
      "payroll-batch",
      "credit",
      "incentive-liquidity",
      "psp-incumbent",
      "customer-action",
      "recurring-mandate",
      "refund-dispute",
      "multi-provider-fallback",
      "external-funds",
    ]);
    expect(JOURNEYS).toHaveLength(12);
  });

  it("every journey passes with evidence references for every claim", async () => {
    const report = await reportPromise;
    for (const certification of report.certifications) {
      expect({ journeyId: certification.journeyId, passed: certification.passed }).toMatchObject({
        passed: true,
      });
      expect(certification.assertions.length).toBeGreaterThan(0);
      expect(certification.invariantsExercised.length).toBeGreaterThan(0);
      for (const invariant of certification.invariantsExercised) {
        expect(typeof invariant.id).toBe("string");
        expect(invariant.proof.length).toBeGreaterThan(0);
      }
    }
  });

  it("covers every acceptance axis across the suite", async () => {
    const report = await reportPromise;
    expect(report.axisCoverage.map((c) => c.axis).sort()).toEqual([...ACCEPTANCE_AXES].sort());
    for (const coverage of report.axisCoverage) {
      expect({ axis: coverage.axis, passed: coverage.passed }).toMatchObject({ passed: true });
      expect(coverage.assertedByJourneys.length).toBeGreaterThan(0);
    }
  });

  it("certifies PASS_THROUGH_NATIVE as an available baseline", async () => {
    const report = await reportPromise;
    expect(report.passThroughNativeBaselineCertified).toBe(true);
    const baseline = report.axisCoverage.find((c) => c.axis === "PASS_THROUGH_NATIVE_BASELINE");
    expect(baseline?.assertedByJourneys).toContain("psp-incumbent");
  });

  it("overall suite verdict passes and the report digest is deterministic", async () => {
    const report = await reportPromise;
    expect(report.overallPassed).toBe(true);
    expect(report.digest).toMatch(/^fnv1a64:/);
    const second = await certifyAllJourneys();
    // contentDigest is bigint-safe; identical digests over the full content
    // prove the suite is deterministic end-to-end.
    expect(second.digest).toBe(report.digest);
    expect(second.certifications.map((c) => `${c.journeyId}:${c.passed}`).join("|")).toBe(
      report.certifications.map((c) => `${c.journeyId}:${c.passed}`).join("|"),
    );
    expect(second.overallPassed).toBe(report.overallPassed);
    expect(second.generatedAt).toBe(report.generatedAt);
  });
});

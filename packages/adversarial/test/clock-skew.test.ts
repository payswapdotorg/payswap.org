import { describe, expect, it } from "vitest";
import { clockSkewScenario, runScenario } from "../src/index.js";
import { runAndExpectScenario } from "./adversarial-helpers.js";

/**
 * W2-007 fault family — clock skew. No retroactive authorization (INV-A02),
 * terminal monotonicity (INV-X04), retry safety (INV-O01) and evidence
 * provenance caps (INV-E04) all hold under a backwards clock jump.
 */

const CANDIDATES = ["INV-A02", "INV-X04", "INV-O01", "INV-E04"] as const;

describe("W2-007 fault family — clock skew", () => {
  it("injects the backwards jump, holds every candidate invariant and completes the recovery path", async () => {
    const verdict = await runAndExpectScenario(clockSkewScenario(), "clock-skew", CANDIDATES);
    expect(verdict.faultId).toBe("fault:clock-skew:1");
  });

  it("never resurrects an expired grant through clock regression", async () => {
    const verdict = await runScenario(clockSkewScenario());
    const inva02 = verdict.probes.find((p) => p.invariantId === "INV-A02");
    expect(inva02?.held).toBe(true);
    expect(inva02?.proof).toContain("EXPIRED");
    expect(inva02?.proof).toContain("never resurrect");
  });

  it("detects the epoch regression and keeps terminal transitions monotonic", async () => {
    const verdict = await runScenario(clockSkewScenario());
    const regression = verdict.injectionChecks.find((check) =>
      check.detail.includes("regression"),
    );
    expect(regression?.ok).toBe(true);
    expect(regression?.detail).toContain("EpochRegressionError");
    const invx04 = verdict.probes.find((p) => p.invariantId === "INV-X04");
    expect(invx04?.proof).toContain("TerminalStateViolationError");
  });

  it("caps UI/browser evidence regardless of claims or clock (INV-E04)", async () => {
    const verdict = await runScenario(clockSkewScenario());
    const inve04 = verdict.probes.find((p) => p.invariantId === "INV-E04");
    expect(inve04?.held).toBe(true);
    expect(inve04?.proof).toContain("P0");
    expect(inve04?.proof).toContain("P1");
  });
});

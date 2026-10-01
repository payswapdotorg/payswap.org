import { describe, expect, it } from "vitest";
import { partialPaymentScenario, runScenario } from "../src/index.js";
import { runAndExpectScenario } from "./adversarial-helpers.js";

/**
 * W2-007 fault family — partial-payment edges. Partial execution is
 * disclosed (never silently SUCCEEDED), reservations never exceed
 * authorized available value (INV-F04), netting preserves gross (INV-F07),
 * the journal balances exactly (INV-F03), provider state stays lossless
 * (INV-C06).
 */

const CANDIDATES = ["INV-F07", "INV-F04", "INV-F03", "INV-C06"] as const;

describe("W2-007 fault family — partial-payment edges", () => {
  it("injects the partial capture, holds every candidate invariant and completes the recovery path", async () => {
    const verdict = await runAndExpectScenario(partialPaymentScenario(), "partial-payment", CANDIDATES);
    expect(verdict.faultId).toBe("fault:partial-payment:1");
  });

  it("surfaces the partial effect as PARTIALLY_EXECUTED", async () => {
    const verdict = await runScenario(partialPaymentScenario());
    const partial = verdict.injectionChecks.find((check) =>
      check.detail.includes("PARTIALLY_EXECUTED"),
    );
    expect(partial?.ok).toBe(true);
    expect(partial?.detail).toContain("never silently SUCCEEDED");
  });

  it("refuses the over-reservation without side effects (INV-F04)", async () => {
    const verdict = await runScenario(partialPaymentScenario());
    const invf04 = verdict.probes.find((p) => p.invariantId === "INV-F04");
    expect(invf04?.held).toBe(true);
    expect(invf04?.proof).toContain("InsufficientAvailableFundsError");
    expect(invf04?.proof).toContain("no side effects");
  });

  it("preserves gross obligations behind the net position (INV-F07)", async () => {
    const verdict = await runScenario(partialPaymentScenario());
    const invf07 = verdict.probes.find((p) => p.invariantId === "INV-F07");
    expect(invf07?.held).toBe(true);
    expect(invf07?.proof).toContain("7000 owed by A");
    expect(invf07?.proof).toContain("3000 owed by B");
  });

  it("completes with evidence on a balanced journal (recovery)", async () => {
    const verdict = await runScenario(partialPaymentScenario());
    expect(verdict.recoveryPath.length).toBe(5);
    expect(verdict.recoveryPath[3]?.description).toContain("Completion landed with evidence");
    const invf03 = verdict.probes.find((p) => p.invariantId === "INV-F03");
    expect(invf03?.proof).toContain("trial balance");
  });
});

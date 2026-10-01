import { describe, expect, it } from "vitest";
import { ambiguousProviderScenario, runScenario } from "../src/index.js";
import { runAndExpectScenario } from "./adversarial-helpers.js";

/**
 * W2-007 fault family — ambiguous provider outcomes. UNKNOWN is never FAILED
 * (INV-X01), blind retries are refused (INV-X02), reconciliation is the only
 * authority out (INV-X03), provider state stays lossless (INV-C06).
 */

const CANDIDATES = ["INV-X01", "INV-X02", "INV-X03", "INV-C06"] as const;

describe("W2-007 fault family — ambiguous provider outcomes", () => {
  it("injects the ambiguity, holds every candidate invariant and completes the recovery path", async () => {
    const verdict = await runAndExpectScenario(
      ambiguousProviderScenario(),
      "ambiguous-provider",
      CANDIDATES,
    );
    expect(verdict.faultId).toBe("fault:ambiguous-provider:1");
  });

  it("preserves UNKNOWN — never maps it to FAILED", async () => {
    const verdict = await runScenario(ambiguousProviderScenario());
    const invx01 = verdict.probes.find((p) => p.invariantId === "INV-X01");
    expect(invx01?.held).toBe(true);
    expect(invx01?.proof).toContain("never mapped to FAILED");
  });

  it("refuses the blind retry with AttemptRetryForbiddenError", async () => {
    const verdict = await runScenario(ambiguousProviderScenario());
    const blindRetry = verdict.injectionChecks.find((check) =>
      check.detail.includes("blind retry"),
    );
    expect(blindRetry?.ok).toBe(true);
    expect(blindRetry?.detail).toContain("AttemptRetryForbiddenError");
  });

  it("recovers via reconciliation then a SAFE_TO_RETRY retry", async () => {
    const verdict = await runScenario(ambiguousProviderScenario());
    expect(verdict.recoveryPath.length).toBe(5);
    expect(verdict.recoveryPath[2]?.description).toContain("Reconciliation case opened");
    expect(verdict.recoveryPath[4]?.description).toContain("Safe retry");
    const invx03 = verdict.probes.find((p) => p.invariantId === "INV-X03");
    expect(invx03?.proof).toContain("att:amb:retry-1");
  });
});

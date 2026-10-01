import { describe, expect, it } from "vitest";
import { maliciousAgentsScenario, runScenario } from "../src/index.js";
import { runAndExpectScenario } from "./adversarial-helpers.js";

/**
 * W2-007 fault family — malicious agents. Proposals never mutate financial
 * truth (INV-G03), child authority stays attenuated (INV-A01), no
 * unrestricted money-movement tool exists (INV-A04), and suggestions cannot
 * override constraints (INV-A05).
 */

const CANDIDATES = ["INV-A01", "INV-G03", "INV-A04", "INV-A05"] as const;

describe("W2-007 fault family — malicious agents", () => {
  it("injects every malicious path, holds every candidate invariant and completes the recovery path", async () => {
    const verdict = await runAndExpectScenario(maliciousAgentsScenario(), "malicious-agents", CANDIDATES);
    expect(verdict.faultId).toBe("fault:malicious-agents:1");
  });

  it("rejects the command-shape proposal smuggled at depth", async () => {
    const verdict = await runScenario(maliciousAgentsScenario());
    const invg03 = verdict.probes.find((p) => p.invariantId === "INV-G03");
    expect(invg03?.held).toBe(true);
    expect(invg03?.proof).toContain("ProtocolCommandShapeError");
  });

  it("denies every unrestricted-transfer request with a recorded reason", async () => {
    const verdict = await runScenario(maliciousAgentsScenario());
    const inva04 = verdict.probes.find((p) => p.invariantId === "INV-A04");
    expect(inva04?.held).toBe(true);
    expect(inva04?.proof).toContain("canWriteFinancialState:false");
    const construction = verdict.injectionChecks.find((check) =>
      check.detail.includes("cannot even be constructed"),
    );
    expect(construction?.ok).toBe(true);
  });

  it("refuses authority widening on every dimension", async () => {
    const verdict = await runScenario(maliciousAgentsScenario());
    const inva01 = verdict.probes.find((p) => p.invariantId === "INV-A01");
    expect(inva01?.held).toBe(true);
    expect(inva01?.proof).toContain("actions");
    expect(inva01?.proof).toContain("limits.perTransactionAmount");
    expect(inva01?.proof).toContain("expiry");
  });

  it("keeps the honest attenuated path working (recovery)", async () => {
    const verdict = await runScenario(maliciousAgentsScenario());
    expect(verdict.recoveryPath.length).toBe(5);
    expect(verdict.recoveryPath[3]?.description).toContain("Honest attenuated grant");
    expect(verdict.recoveryPath[4]?.description).toContain("Scoped execution grant");
    const inva05 = verdict.probes.find((p) => p.invariantId === "INV-A05");
    expect(inva05?.proof).toContain("per_transaction_limit_exceeded");
  });
});

import { describe, expect, it } from "vitest";
import { providerOutageScenario, runScenario } from "../src/index.js";
import { buildOutageReplay, runAndExpectScenario } from "./adversarial-helpers.js";

/**
 * W2-007 fault family — provider outage. The in-flight write under outage
 * surfaces as UNKNOWN (INV-X01/X02), the case resolves through
 * reconciliation (INV-X03), incidents feed evidence (INV-S04), the outbox
 * never silently loses (INV-O02), and the frozen W2-006 replay-fault
 * contract verifies over a REAL Lab replay.
 */

const CANDIDATES = ["INV-X01", "INV-X02", "INV-X03", "INV-S04", "INV-O02"] as const;

describe("W2-007 fault family — provider outage", () => {
  it("injects the outage, holds every candidate invariant and completes the recovery path", async () => {
    const verdict = await runAndExpectScenario(
      providerOutageScenario({ replay: buildOutageReplay() }),
      "provider-outage",
      CANDIDATES,
    );
    expect(verdict.faultId).toBe("fault:provider-outage:1");
  });

  it("surfaces the in-flight write as UNKNOWN requiring reconciliation (never FAILED)", async () => {
    const verdict = await runScenario(providerOutageScenario({ replay: buildOutageReplay() }));
    const invx01 = verdict.probes.find((p) => p.invariantId === "INV-X01");
    expect(invx01?.held).toBe(true);
    expect(invx01?.proof).toContain("never mapped to FAILED");
  });

  it("evidences the outage window and probes recovery before resuming (INV-S04)", async () => {
    const verdict = await runScenario(providerOutageScenario({ replay: buildOutageReplay() }));
    const invs04 = verdict.probes.find((p) => p.invariantId === "INV-S04");
    expect(invs04?.held).toBe(true);
    expect(invs04?.proof).toContain("status-page:inc-77:start");
    expect(invs04?.proof).toContain("status-page:inc-77:resolved");
  });

  it("verifies the frozen W2-006 PROVIDER_OUTAGE contract over the real Lab replay", async () => {
    const verdict = await runScenario(providerOutageScenario({ replay: buildOutageReplay() }));
    const contract = verdict.injectionChecks.find((check) =>
      check.detail.includes("W2-006"),
    );
    expect(contract?.ok).toBe(true);
    expect(verdict.evidenceRefs.some((ref) => ref.startsWith("fnv1a64:"))).toBe(true);
  });

  it("recovers through probes, reconciliation, finality and the outbox re-drain", async () => {
    const verdict = await runScenario(providerOutageScenario({ replay: buildOutageReplay() }));
    expect(verdict.recoveryPath.length).toBe(7);
    expect(verdict.recoveryPath[3]?.description).toContain("probed");
    expect(verdict.recoveryPath[5]?.description).toContain("Finality declared");
    expect(verdict.recoveryPath[6]?.description).toContain("re-drained");
  });
});

import { describe, expect, it } from "vitest";
import { duplicatedCommandsScenario, runScenario } from "../src/index.js";
import { runAndExpectScenario } from "./adversarial-helpers.js";

/**
 * W2-007 fault family — duplicated commands. The replay must return the ONE
 * authoritative result (INV-F05), never double-post the journal (INV-F03),
 * stay retry-safe on the outbox (INV-O01) and refuse evidence rewrites
 * (INV-E05).
 */

const CANDIDATES = ["INV-F05", "INV-F03", "INV-O01", "INV-E05"] as const;

describe("W2-007 fault family — duplicated commands", () => {
  it("injects the duplicate replay, holds every candidate invariant and completes the recovery path", async () => {
    const verdict = await runAndExpectScenario(
      duplicatedCommandsScenario(),
      "duplicated-commands",
      CANDIDATES,
    );
    expect(verdict.faultId).toBe("fault:duplicated-commands:1");
  });

  it("proves one idempotency key maps to one authoritative result", async () => {
    const verdict = await runScenario(duplicatedCommandsScenario());
    const invf05 = verdict.probes.find((p) => p.invariantId === "INV-F05");
    expect(invf05?.held).toBe(true);
    expect(invf05?.proof).toContain("one authoritative result");
  });

  it("proves the journal was not double-posted by the replay", async () => {
    const verdict = await runScenario(duplicatedCommandsScenario());
    const invf03 = verdict.probes.find((p) => p.invariantId === "INV-F03");
    expect(invf03?.held).toBe(true);
    expect(invf03?.proof).toContain("did NOT double-post");
  });

  it("refuses the mutated re-binding with CONFLICT", async () => {
    const verdict = await runScenario(duplicatedCommandsScenario());
    const conflictCheck = verdict.injectionChecks.find((detail) =>
      detail.detail.includes("CONFLICT"),
    );
    expect(conflictCheck?.ok).toBe(true);
  });

  it("documents the exact recovery path (replay → conflict refusal → unchanged state)", async () => {
    const verdict = await runScenario(duplicatedCommandsScenario());
    expect(verdict.recoveryPath.length).toBe(5);
    expect(verdict.recoveryPath[0]?.description).toContain("REPLAY");
    expect(verdict.recoveryPath[1]?.description).toContain("CONFLICT");
    expect(verdict.recoveryPath[3]?.description).toContain("unchanged");
    expect(verdict.recoveryPath[4]?.description).toContain("rewrite rejected");
  });
});

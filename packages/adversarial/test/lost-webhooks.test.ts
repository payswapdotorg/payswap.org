import { describe, expect, it } from "vitest";
import { lostWebhooksScenario, runScenario } from "../src/index.js";
import { runAndExpectScenario } from "./adversarial-helpers.js";

/**
 * W2-007 fault family — lost webhooks. The committed mutation's outbox event
 * is never silently lost (INV-O02); the ambiguity resolves only through the
 * re-fetch + reconciliation path (INV-X03) with lossless provider state
 * (INV-C06), immutable evidence history (INV-E05) and execution evidence
 * (INV-E02).
 */

const CANDIDATES = ["INV-X03", "INV-O02", "INV-E05", "INV-C06", "INV-E02"] as const;

describe("W2-007 fault family — lost webhooks", () => {
  it("injects the webhook loss, holds every candidate invariant and completes the recovery path", async () => {
    const verdict = await runAndExpectScenario(lostWebhooksScenario(), "lost-webhooks", CANDIDATES);
    expect(verdict.faultId).toBe("fault:lost-webhooks:1");
  });

  it("keeps the outbox event PENDING through the loss (no silent loss)", async () => {
    const verdict = await runScenario(lostWebhooksScenario());
    const invo02 = verdict.probes.find((p) => p.invariantId === "INV-O02");
    expect(invo02?.held).toBe(true);
    expect(invo02?.proof).toContain("exactly one re-drain published");
  });

  it("recovers through external-object re-fetch and reconciliation only", async () => {
    const verdict = await runScenario(lostWebhooksScenario());
    const invx03 = verdict.probes.find((p) => p.invariantId === "INV-X03");
    expect(invx03?.held).toBe(true);
    expect(invx03?.proof).toContain("reconciliation case case:lw:1");
    expect(verdict.recoveryPath.length).toBe(5);
    expect(verdict.recoveryPath[1]?.description).toContain("re-fetched");
    expect(verdict.recoveryPath[3]?.description).toContain("resolved");
  });

  it("proves the re-fetch history is append-only", async () => {
    const verdict = await runScenario(lostWebhooksScenario());
    const inve05 = verdict.probes.find((p) => p.invariantId === "INV-E05");
    expect(inve05?.held).toBe(true);
    expect(inve05?.proof).toContain("ProviderRevisionConflictError");
  });
});

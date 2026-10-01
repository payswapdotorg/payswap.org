import { describe, expect, it } from "vitest";
import { accountTakeoverScenario, runScenario } from "../src/index.js";
import { buildAccountTakeoverPlane, runAndExpectScenario } from "./adversarial-helpers.js";

/**
 * W2-007 fault family — account takeover / SIM-swap-like signals. The REAL
 * security immune system (epochs, quarantine, capability gate) is wired
 * through the structural plane; the epoch bump revokes stale authorizations
 * (INV-S02/A02), quarantine blocks cached-capability re-entry (INV-S03), and
 * recovery is a fresh epoch-current authorization with a signed approval
 * artifact (INV-E01).
 */

const CANDIDATES = ["INV-S02", "INV-A02", "INV-S03", "INV-E01"] as const;

describe("W2-007 fault family — account takeover (SIM-swap-like signal)", () => {
  it("injects the takeover, holds every candidate invariant and completes the recovery path", async () => {
    const verdict = await runAndExpectScenario(
      accountTakeoverScenario({ security: buildAccountTakeoverPlane() }),
      "account-takeover",
      CANDIDATES,
    );
    expect(verdict.faultId).toBe("fault:account-takeover:1");
  });

  it("revokes the temporally-valid authorization through the epoch bump", async () => {
    const verdict = await runScenario(accountTakeoverScenario({ security: buildAccountTakeoverPlane() }));
    const invs02 = verdict.probes.find((p) => p.invariantId === "INV-S02");
    expect(invs02?.held).toBe(true);
    expect(invs02?.proof).toContain("StaleAuthorizationEpochError");
    expect(invs02?.proof).toContain("stale_security_epoch");
  });

  it("denies the quarantined key's cached capability re-entry", async () => {
    const verdict = await runScenario(accountTakeoverScenario({ security: buildAccountTakeoverPlane() }));
    const invs03 = verdict.probes.find((p) => p.invariantId === "INV-S03");
    expect(invs03?.held).toBe(true);
    expect(invs03?.proof).toContain("cached AVAILABLE capability view was refused");
  });

  it("recovers ONLY through re-verification issuing a fresh epoch-current authorization", async () => {
    const verdict = await runScenario(accountTakeoverScenario({ security: buildAccountTakeoverPlane() }));
    expect(verdict.recoveryPath.length).toBe(6);
    expect(verdict.recoveryPath[0]?.description).toContain("epoch advanced");
    expect(verdict.recoveryPath[3]?.description).toContain("NEW epoch-current authorization");
    expect(verdict.recoveryPath[5]?.description).toContain("signed approval artifact");
    const inve01 = verdict.probes.find((p) => p.invariantId === "INV-E01");
    expect(inve01?.proof).toContain("request_hash_mismatch");
  });
});

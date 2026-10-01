import { describe, expect, it } from "vitest";
import { packageCompromiseScenario, runScenario } from "../src/index.js";
import { buildPackageCompromisePlane, runAndExpectScenario } from "./adversarial-helpers.js";

/**
 * W2-007 fault family — package compromise. The advisory restricts globally
 * (INV-S01), the package can never write financial state (INV-C04), the
 * sealed release is immutable (INV-G02), and cached capability state cannot
 * re-enter quarantine (INV-S03).
 */

const CANDIDATES = ["INV-S01", "INV-C04", "INV-G02", "INV-S03"] as const;

describe("W2-007 fault family — package compromise", () => {
  it("injects the compromise, holds every candidate invariant and completes the recovery path", async () => {
    const verdict = await runAndExpectScenario(
      packageCompromiseScenario({ security: buildPackageCompromisePlane() }),
      "package-compromise",
      CANDIDATES,
    );
    expect(verdict.faultId).toBe("fault:package-compromise:1");
  });

  it("restricts the affected package globally through the advisory", async () => {
    const verdict = await runScenario(
      packageCompromiseScenario({ security: buildPackageCompromisePlane() }),
    );
    const invs01 = verdict.probes.find((p) => p.invariantId === "INV-S01");
    expect(invs01?.held).toBe(true);
    expect(invs01?.proof).toContain("restricted=true");
  });

  it("proves the compromised package cannot write financial state", async () => {
    const verdict = await runScenario(
      packageCompromiseScenario({ security: buildPackageCompromisePlane() }),
    );
    const invc04 = verdict.probes.find((p) => p.invariantId === "INV-C04");
    expect(invc04?.held).toBe(true);
    expect(invc04?.proof).toContain("canWriteFinancialState:false");
    expect(invc04?.proof).toContain("FinalityNotProtocolAuthorizedError");
  });

  it("proves the sealed release is immutable (remediation requires a new version)", async () => {
    const verdict = await runScenario(
      packageCompromiseScenario({ security: buildPackageCompromisePlane() }),
    );
    const invg02 = verdict.probes.find((p) => p.invariantId === "INV-G02");
    expect(invg02?.held).toBe(true);
    expect(invg02?.proof).toContain("frozen");
    expect(invg02?.proof).toContain("different content hash");
  });

  it("recovers via patched v2, advisory closure and evidenced quarantine release", async () => {
    const verdict = await runScenario(
      packageCompromiseScenario({ security: buildPackageCompromisePlane() }),
    );
    expect(verdict.recoveryPath.length).toBe(6);
    expect(verdict.recoveryPath[4]?.description).toContain("patched v2 published");
    expect(verdict.recoveryPath[5]?.description).toContain("quarantine released");
  });
});

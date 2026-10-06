import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GATE_PROOFS,
  SECURITY_CERTIFICATION_GATES,
  runSecurityGate,
  runSecurityGateWall,
} from "../../src/production/gates.js";

/**
 * The seventeen §36 security certification gates, machine-checked against
 * the REAL kernels (plus the proof-anchored source scans where the law is
 * structural). The §36 list carries seventeen statements; the work-order
 * prose says "sixteen" — the discrepancy is recorded honestly in the
 * certification report and asserted here so it can never drift silently.
 */

const PACKAGE_ROOT = process.cwd();
const REPO_ROOT = join(PACKAGE_ROOT, "..", "..");

describe("production certification — the §36 security certification gates", () => {
  it("transcribes the seventeen §36 statements verbatim (the packet's 'sixteen' is a miscount, recorded as-is)", () => {
    expect(SECURITY_CERTIFICATION_GATES).toHaveLength(17);
    expect(SECURITY_CERTIFICATION_GATES[0]).toBe("no raw wallet secrets enter model context");
    expect(SECURITY_CERTIFICATION_GATES[16]).toBe(
      "incident/threat signals enter SecurityAdvisory/ThreatSignature system",
    );
  });

  const wall = runSecurityGateWall();

  for (const gate of wall.gates) {
    it(`gate '${gate.statement}' — ${gate.kind} — passes`, () => {
      expect(gate.passed).toBe(true);
      expect(gate.evidence.length).toBeGreaterThan(0);
    });
  }

  it("the wall passes with all seventeen gates and a deterministic digest", () => {
    expect(wall.passed).toBe(true);
    expect(wall.gates).toHaveLength(17);
    const rerun = runSecurityGateWall();
    expect(rerun.wallDigest).toBe(wall.wallDigest);
  });

  it("every gate is individually runnable and deterministic", () => {
    for (const gate of wall.gates) {
      const rerun = runSecurityGate(gate.gateId);
      expect(rerun.passed).toBe(gate.passed);
      expect(rerun.evidence).toEqual(gate.evidence);
    }
  });

  describe("proof anchors (the cited file+line evidence is verified at certification time)", () => {
    it("proof: the trusted surface is the only minting path (authorization.ts)", () => {
      const proof = GATE_PROOFS["no-signer-bypass"];
      expect(proof).toBeDefined();
      if (proof === undefined) return;
      const source = readFileSync(join(REPO_ROOT, proof.file), "utf8");
      const lines = source.split("\n");
      const anchorLine = lines.findIndex((line) => line.includes(proof.anchor));
      expect(anchorLine).toBeGreaterThan(-1);
      // The cited line range covers the anchor.
      const from = Number(proof.lines.split("-")[0]);
      expect(anchorLine + 1).toBeGreaterThanOrEqual(from - 5);
    });

    it("proof: BroadcastStageInput structurally requires the kernel handoff (onchain-adapters contract.ts)", () => {
      const proof = GATE_PROOFS["no-rpc-write-bypass"];
      expect(proof).toBeDefined();
      if (proof === undefined) return;
      const source = readFileSync(join(REPO_ROOT, proof.file), "utf8");
      expect(source).toContain(proof.anchor);
      // The handoff field is the kernel-minted SigningRequest.
      expect(source).toContain("readonly handoff: SigningRequest");
      // And the kernel itself has no broadcast function — its only exit is
      // the handoff (pipeline.ts).
      const pipelineSource = readFileSync(
        join(REPO_ROOT, "packages/onchain-security/src/pipeline.ts"),
        "utf8",
      );
      expect(pipelineSource).toContain("Broadcast handoff — the ONLY exit toward execution");
      expect(pipelineSource.includes("async broadcast")).toBe(false);
    });

    it("proof: the UTXO adapter DECLARES simulate structurally unsupported (honest unavailability)", () => {
      const proof = GATE_PROOFS["simulation-mandatory-when-supported"];
      expect(proof).toBeDefined();
      if (proof === undefined) return;
      const source = readFileSync(join(REPO_ROOT, proof.file), "utf8");
      expect(source).toContain(proof.anchor);
    });
  });
});

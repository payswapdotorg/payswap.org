import { describe, expect, it } from "vitest";
import { runComposedDeploymentExercise } from "./deployment-machinery.js";
import {
  CERTIFICATION_RELEASE_SHA,
  DEPLOYMENT_CLI_RECEIPT_FILES,
} from "../../src/production/deployment.js";

/**
 * The P4-W4-003 deployment + rollback exercise: the deterministic
 * machinery (in-process, the same functions the deployment scripts drive)
 * plus verification of the committed CLI receipts captured by running the
 * real scripts against a LOCAL record/probe target.
 */

describe("production certification — deployment + rollback exercise", () => {
  const exercise = runComposedDeploymentExercise();

  it("the deterministic exercise passes with receipts", () => {
    expect(exercise.passed).toBe(true);
    expect(exercise.receipts.length).toBeGreaterThanOrEqual(6);
  });

  it("records a deployment (the deploy:record machinery: manifests, four machine checkers, ordered plan)", () => {
    const receipt = exercise.receipts.find((entry: { receiptId: string; passed: boolean; summary: string }) => entry.receiptId === "deploy:record-machine-checks");
    expect(receipt?.passed).toBe(true);
    expect(receipt?.summary).toContain("deployment order true");
  });

  it("declares the eleven release gates", () => {
    const receipt = exercise.receipts.find((entry: { receiptId: string; passed: boolean; summary: string }) => entry.receiptId === "deploy:record-eleven-gates");
    expect(receipt?.passed).toBe(true);
    expect(receipt?.summary).toContain("observability");
    expect(receipt?.summary).toContain("rollback");
  });

  it("records the provider rollout release record (the rollout:record machinery)", () => {
    const receipt = exercise.receipts.find((entry: { receiptId: string; passed: boolean; summary: string }) => entry.receiptId === "rollout:record");
    expect(receipt?.passed).toBe(true);
    expect(receipt?.summary).toContain("stripe");
    expect(receipt?.summary).toContain("non-connections");
  });

  it("records a rollback: the provider rollback rehearsal (deactivate → evidence-gated re-activation)", () => {
    const receipt = exercise.receipts.find((entry: { receiptId: string; passed: boolean; summary: string }) => entry.receiptId === "rollback:provider-rehearsal");
    expect(receipt?.passed).toBe(true);
    expect(receipt?.summary).toContain("RE_ACTIVATION_WITH_FRESH_EVIDENCE:SATISFIED");
  });

  it("records a rollback: the production promotion ledger promote → ROLLED_BACK", () => {
    const receipt = exercise.receipts.find((entry: { receiptId: string; passed: boolean; summary: string }) => entry.receiptId === "rollback:promotion-ledger");
    expect(receipt?.passed).toBe(true);
    expect(receipt?.summary).toContain("ROLLED_BACK");
  });

  it("records a rollback: the restore/replay procedure (INV-O04)", () => {
    const receipt = exercise.receipts.find((entry: { receiptId: string; passed: boolean; summary: string }) => entry.receiptId === "rollback:restore-replay-procedure");
    expect(receipt?.passed).toBe(true);
    expect(receipt?.summary).toContain("freeze-writes");
  });

  it("is deterministic (identical exercise digest on re-run)", () => {
    const rerun = runComposedDeploymentExercise();
    expect(rerun.exerciseDigest).toBe(exercise.exerciseDigest);
  });

  describe("the committed CLI receipts (captured against the LOCAL record/probe target)", () => {
    it("declares the expected receipt files", () => {
      expect(DEPLOYMENT_CLI_RECEIPT_FILES.map((entry) => entry.file)).toEqual([
        "deploy-record.json",
        "runtime-plane-probe.txt",
        "runtime-plane-probe-reprobe.txt",
        "provider-rollout.json",
      ]);
    });

    it("deploy-record.json: machine checks green, eleven gates, honest NOT-EXECUTABLE runtime verdicts", async () => {
      const { readFileSync, existsSync } = await import("node:fs");
      const { join } = await import("node:path");
      const path = join(process.cwd(), "evidence", "deployment", "deploy-record.json");
      expect(existsSync(path)).toBe(true);
      const record = JSON.parse(readFileSync(path, "utf8")) as {
        release: { sha: string; battery: string };
        overall: { machine_checks: boolean };
        gates: { gateId: string; verdict: string }[];
      };
      expect(record.release.sha).toBe(CERTIFICATION_RELEASE_SHA);
      expect(record.overall.machine_checks).toBe(true);
      expect(record.gates).toHaveLength(11);
      const runtime = record.gates.filter((gate) => gate.verdict.includes("RUNTIME PLANE"));
      // The honest NOT-EXECUTABLE / DECLARED-unwired verdicts stand (the
      // probe failed closed at the vault gate — never smoothed into PASS).
      expect(runtime.length).toBeGreaterThanOrEqual(3);
      expect(
        runtime.every(
          (gate) => gate.verdict.startsWith("NOT-EXECUTABLE") || gate.verdict.startsWith("DECLARED"),
        ),
      ).toBe(true);
    });

    it("runtime-plane-probe receipts: the fail-closed refusal recorded verbatim (both attempts)", async () => {
      const { readFileSync, existsSync } = await import("node:fs");
      const { join } = await import("node:path");
      for (const file of ["runtime-plane-probe.txt", "runtime-plane-probe-reprobe.txt"]) {
        const path = join(process.cwd(), "evidence", "deployment", file);
        expect(existsSync(path)).toBe(true);
        const receipt = readFileSync(path, "utf8");
        // The honest refusal: the vault bindings are absent in the
        // certification sandbox; the probe fails closed rather than
        // fabricating a PASS.
        expect(receipt).toContain("not set (vault)");
        expect(receipt).toContain("exit: 1");
      }
    });

    it("provider-rollout.json: the deterministic rollout release record", async () => {
      const { readFileSync, existsSync } = await import("node:fs");
      const { join } = await import("node:path");
      const path = join(process.cwd(), "evidence", "deployment", "provider-rollout.json");
      expect(existsSync(path)).toBe(true);
      const record = JSON.parse(readFileSync(path, "utf8")) as {
        releaseId: string;
        connectedProviders: { providerName: string }[];
        nonConnections: unknown[];
        parity: { passed: boolean };
      };
      expect(record.releaseId).toContain("provider-rollout-20261002");
      expect(record.connectedProviders.map((provider) => provider.providerName)).toEqual([
        "stripe",
        "paystack",
        "flutterwave",
      ]);
      expect(record.nonConnections.length).toBeGreaterThan(0);
      expect(record.parity.passed).toBe(true);
    });
  });
});

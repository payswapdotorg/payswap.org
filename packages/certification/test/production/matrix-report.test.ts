import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { readdirSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PRODUCTION_JOURNEYS } from "../../src/production/journeys/index.js";
import { runSecurityGateWall } from "../../src/production/gates.js";
import { runComposedDeploymentExercise } from "./deployment-machinery.js";
import { runNoSimulatedSuccessAudit } from "../../src/production/audit.js";
import { deriveCertificationMatrix } from "../../src/production/matrix.js";
import {
  FORBIDDEN_SAFETY_CLAIM,
  SAFETY_OBJECTIVE,
  buildCertificationReport,
  serializeCertificationReport,
} from "../../src/production/report.js";
import { CERTIFICATION_MATRIX_AREAS } from "../../src/production/matrix.js";

/**
 * The fourteen-area certification matrix and the certification report:
 * every verdict derived (never asserted without evidence), the §37 safety
 * objective VERBATIM as the only safety claim, and the committed report
 * evidence file with its regeneration twin (the W2-003 evidence pattern).
 */

const PACKAGE_ROOT = process.cwd();
const REPO_ROOT = join(PACKAGE_ROOT, "..", "..");

function listSourceFiles(dir: string): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "src") {
        found.push(...listSourceFiles(full));
      }
    } else if (entry.endsWith(".ts") && dir.endsWith("src")) {
      found.push(full);
    }
  }
  return found;
}

function buildInputs() {
  const journeys = PRODUCTION_JOURNEYS.map((journey) => journey.run());
  const gateWall = runSecurityGateWall();
  const deployment = runComposedDeploymentExercise();
  const audit = runNoSimulatedSuccessAudit({
    readFile: (path) => readFileSync(path, "utf8"),
    fileExists: (path) => {
      try {
        statSync(path);
        return true;
      } catch {
        return false;
      }
    },
    listSourceFiles: (packageDir) => listSourceFiles(join(packageDir, "src")),
    workspaceRoot: REPO_ROOT,
  });
  const matrix = deriveCertificationMatrix({ gateWall, deployment, audit });
  return { journeys, gateWall, deployment, audit, matrix };
}

describe("production certification — the fourteen-area matrix", () => {
  it("certifies exactly the fourteen handoff areas (the packet's 'fifteen' is a miscount, recorded as-is)", () => {
    expect(CERTIFICATION_MATRIX_AREAS).toHaveLength(14);
    expect(CERTIFICATION_MATRIX_AREAS[0]).toBe("web-ui");
    expect(CERTIFICATION_MATRIX_AREAS[13]).toBe("rollback");
  });

  it("derives every area's verdict from its sources (all fourteen CERTIFIED)", () => {
    const { matrix } = buildInputs();
    expect(matrix.areas).toHaveLength(14);
    expect(matrix.allCertified).toBe(true);
    for (const area of matrix.areas) {
      expect(area.verdict).toBe("CERTIFIED");
      expect(area.evidenceSummary).toContain("recomputed green");
    }
  });

  it("is deterministic (identical matrix digest on re-derivation)", () => {
    const first = buildInputs().matrix;
    const second = buildInputs().matrix;
    expect(second.matrixDigest).toBe(first.matrixDigest);
  });
});

describe("production certification — the certification report", () => {
  const inputs = buildInputs();
  const report = buildCertificationReport(inputs);

  it("carries the release identity of the pinned base", () => {
    expect(report.release.sha).toBe("bf414753a8dce86b7d3afafbd447ecf74dd3e497");
    expect(report.workOrder).toBe("P4-W4-003");
  });

  it("records all nine journeys passed with digests", () => {
    expect(report.journeysSummary).toEqual({ passed: 9, total: 9 });
    expect(report.journeys.every((journey) => journey.passed && journey.journeyDigest.startsWith("fnv1a64:"))).toBe(true);
  });

  it("records all seventeen security gates passed", () => {
    expect(report.securityGatesSummary).toEqual({ passed: 17, total: 17 });
    expect(report.securityGates.some((gate) => gate.kind === "MACHINE+PROOF" && gate.proof?.file.includes("authorization.ts"))).toBe(true);
  });

  it("records the matrix (fourteen areas certified) and the deployment receipts", () => {
    expect(report.matrix.allCertified).toBe(true);
    expect(report.matrix.areas).toHaveLength(14);
    expect(report.deployment.passed).toBe(true);
    expect(report.deployment.cliReceipts.length).toBe(4);
  });

  it("records the audit method + clean result", () => {
    expect(report.audit.findingCount).toBe(0);
    expect(report.audit.passed).toBe(true);
    expect(report.audit.evidenceBackedSuccess.definitiveStatesWithoutEvidence).toBe(0);
  });

  it("carries the §37 safety objective VERBATIM as the ONLY safety claim", () => {
    expect(report.safetyObjective).toBe(SAFETY_OBJECTIVE);
    expect(SAFETY_OBJECTIVE).toBe(
      "PaySwap provides a systematically stronger safety workflow than a raw transaction UI by inserting deterministic simulation, policy, route validation, security analysis, human-readable authorization, postcondition verification and continuous monitoring before and after execution.",
    );
    // The forbidden claim never appears anywhere in the report.
    const serialized = serializeCertificationReport(report);
    expect(serialized.includes(FORBIDDEN_SAFETY_CLAIM)).toBe(false);
    expect(serialized.includes("guaranteed safer")).toBe(false);
  });

  it("records the honest findings (the packet discrepancies + environmental facts, as-is)", () => {
    expect(report.findings.some((finding) => finding.includes("seventeen"))).toBe(true);
    expect(report.findings.some((finding) => finding.includes("FOURTEEN"))).toBe(true);
    expect(report.findings.some((finding) => finding.includes("fails CLOSED"))).toBe(true);
    expect(report.findings.some((finding) => finding.includes("lags git history"))).toBe(true);
  });

  it("certifies overall with the exact statement of what passed", () => {
    expect(report.overall.verdict).toBe("CERTIFIED");
    expect(report.overall.statement).toContain("9/9 acceptance journeys");
    expect(report.overall.statement).toContain("17/17 security certification gates");
    expect(report.overall.statement).toContain("14/14 matrix areas");
    expect(report.overall.statement).toContain("nothing stronger");
  });

  it("is deterministic (identical report digest on rebuild)", () => {
    const rerun = buildCertificationReport(buildInputs());
    expect(rerun.reportDigest).toBe(report.reportDigest);
  });

  describe("the committed evidence file (evidence/certification-report.json)", () => {
    const evidencePath = join(PACKAGE_ROOT, "evidence", "certification-report.json");

    it("regenerates when CERTIFICATION_WRITE_EVIDENCE=1 (the W2-003 pattern)", () => {
      if (process.env.CERTIFICATION_WRITE_EVIDENCE === "1") {
        mkdirSync(join(PACKAGE_ROOT, "evidence"), { recursive: true });
        writeFileSync(evidencePath, serializeCertificationReport(report));
      }
      expect(existsSync(evidencePath)).toBe(true);
    });

    it("the committed twin matches the freshly derived report byte-for-byte", () => {
      const committed = readFileSync(evidencePath, "utf8");
      expect(committed).toBe(serializeCertificationReport(report));
    });

    it("the committed report re-digests to its recorded digest", () => {
      const committed = JSON.parse(readFileSync(evidencePath, "utf8")) as {
        reportDigest: string;
      };
      expect(committed.reportDigest).toBe(report.reportDigest);
    });
  });
});

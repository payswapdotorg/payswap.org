import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AUDIT_MARKER_PATTERNS,
  AUDIT_SCOPE_PACKAGES,
  runNoSimulatedSuccessAudit,
} from "../../src/production/audit.js";

/**
 * The P4-W4-003 no-simulated-success audit: a systematic scan for
 * simulated success in the wired production-journey paths. The scanner
 * runs over the REAL workspace sources through the test-layer fs bridge
 * (src stays free of node imports — the boundary law).
 */

const PACKAGE_ROOT = process.cwd();
const REPO_ROOT = join(PACKAGE_ROOT, "..", "..");

function listSourceFiles(dir: string): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    // Only src/** is scanned (the wired production paths); test fixtures
    // are declared doubles by construction and are out of scope.
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

function runAudit() {
  return runNoSimulatedSuccessAudit({
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
}

describe("production certification — the no-simulated-success audit", () => {
  const audit = runAudit();

  it("scans the declared scope (every composed package's src tree)", () => {
    expect(AUDIT_SCOPE_PACKAGES.length).toBeGreaterThanOrEqual(19);
    // The scan was not vacuous: it observed hits across the scope.
    expect(audit.markerHits.length).toBeGreaterThan(0);
  });

  it("the method is recorded (patterns + scope + allowance contexts)", () => {
    expect(audit.method.markerPatterns).toEqual([...AUDIT_MARKER_PATTERNS]);
    expect(audit.method.scope).toEqual([...AUDIT_SCOPE_PACKAGES]);
    expect(audit.method.allowanceContexts.length).toBeGreaterThan(0);
  });

  it("reports ZERO findings outside the declared allowance contexts (clean scan)", () => {
    expect(audit.findings).toEqual([]);
    expect(audit.passed).toBe(true);
  });

  it("classifies every observed hit (the allowance contexts are the certified packages' own vocabularies)", () => {
    const classifications = new Set(audit.markerHits.map((hit) => hit.classification));
    // Every hit is either an allowance context or a finding; with zero
    // findings, all hits are classified allowances — each one listed in
    // the committed report for review.
    for (const hit of audit.markerHits) {
      expect([
        "ALLOWED_LAB_TIER_VOCABULARY",
        "ALLOWED_SIMULATION_OBSERVATION_VOCABULARY",
        "ALLOWED_ADVERSARIAL_FIXTURE_DOCUMENTATION",
        "FINDING",
      ]).toContain(hit.classification);
    }
    // Sanity: the Lab-tier vocabulary really was exercised (the Lab walk
    // is a declared, law-isolated tier — not a hidden simulation).
    expect(
      audit.markerHits.some((hit) => hit.classification === "ALLOWED_LAB_TIER_VOCABULARY"),
    ).toBe(true);
    void classifications;
  });

  it("every definitive journey state is evidence-backed (recomputed over all nine journeys)", () => {
    expect(audit.evidenceBackedSuccess.checkedJourneyStages).toBeGreaterThanOrEqual(45);
    expect(audit.evidenceBackedSuccess.definitiveStatesWithoutEvidence).toBe(0);
    expect(audit.evidenceBackedSuccess.passed).toBe(true);
  });

  it("honest unavailability renders verbatim where a rail is unsupported (the W4-001 law)", () => {
    expect(audit.honestUnavailability.stripeNoticeVerbatim).toBe(true);
    expect(audit.honestUnavailability.passed).toBe(true);
  });

  it("the audit is deterministic (identical digest + findings on re-run)", () => {
    const rerun = runAudit();
    expect(rerun.auditDigest).toBe(audit.auditDigest);
    expect(rerun.findings).toEqual(audit.findings);
  });
});

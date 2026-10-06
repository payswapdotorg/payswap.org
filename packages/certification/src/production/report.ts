/**
 * @payswap/certification — the P4-W4-003 certification report.
 *
 * The DETERMINISTIC, GENERATED, COMMITTED report: per-journey verdicts
 * with digests, the seventeen §36 gate verdicts, the fourteen-area matrix
 * with receipts, the deployment/rollback receipts, the no-simulated-
 * success audit — and the §37 safety objective VERBATIM as the ONLY
 * safety claim.
 *
 * Regeneration is env-flag-guarded (CERTIFICATION_WRITE_EVIDENCE=1);
 * the verification twin re-derives the report from the same deterministic
 * inputs and requires byte-identical canonical serialization.
 */

import { contentDigest, canonicalString } from "../digest.js";
import { PRODUCTION_JOURNEYS } from "./journeys/index.js";
import type { ProductionJourneyOutcome } from "./contract.js";
import { journeyPassed } from "./contract.js";
import { runSecurityGateWall } from "./gates.js";
import type { SecurityGateWallResult } from "./gates.js";
import { deriveCertificationMatrix } from "./matrix.js";
import type { CertificationMatrixResult } from "./matrix.js";
import type { DeploymentExerciseResult } from "./deployment.js";
import { runNoSimulatedSuccessAudit } from "./audit.js";
import type { NoSimulatedSuccessAuditResult } from "./audit.js";
import {
  CERTIFICATION_RELEASE_BATTERY,
  CERTIFICATION_RELEASE_SHA,
  CERTIFICATION_AUTHORIZED_AT,
  DEPLOYMENT_CLI_RECEIPT_FILES,
} from "./deployment.js";

/**
 * §37 safety objective — VERBATIM, the engineering acceptance target. This
 * is the ONLY safety claim the certification report may carry: evidence
 * comes from the certification tests, never marketing language.
 */
export const SAFETY_OBJECTIVE =
  "PaySwap provides a systematically stronger safety workflow than a raw transaction UI by inserting deterministic simulation, policy, route validation, security analysis, human-readable authorization, postcondition verification and continuous monitoring before and after execution." as const;

/** The safety claim the report must NEVER make (§37 names it explicitly). */
export const FORBIDDEN_SAFETY_CLAIM =
  "PaySwap is guaranteed safer than direct blockchain interaction." as const;

export interface CertificationReport {
  readonly reportId: "payswap.production-certification-report";
  readonly workOrder: "P4-W4-003";
  readonly spec: "docs/UNIVERSAL-MONEY-HANDOFF-FULL-2026-10-02.md §34 P4-W4-003, §35, §36, §37";
  readonly release: {
    readonly sha: string;
    readonly battery: string;
    readonly authorizedAt: string;
  };
  readonly journeys: readonly {
    readonly journeyId: string;
    readonly letter: string;
    readonly title: string;
    readonly passed: boolean;
    readonly journeyDigest: string;
    readonly stageCount: number;
    readonly assertionCount: number;
  }[];
  readonly journeysSummary: { readonly passed: number; readonly total: number };
  readonly securityGates: readonly {
    readonly gateId: string;
    readonly statement: string;
    readonly kind: "MACHINE" | "MACHINE+PROOF";
    readonly passed: boolean;
    readonly evidence: readonly string[];
    readonly proof?: { readonly file: string; readonly lines: string; readonly law: string };
  }[];
  readonly securityGatesSummary: { readonly passed: number; readonly total: number };
  readonly matrix: {
    readonly areas: readonly {
      readonly areaId: string;
      readonly title: string;
      readonly verdict: string;
      readonly journeys: readonly string[];
      readonly gates: readonly string[];
      readonly receipts: readonly string[];
    }[];
    readonly allCertified: boolean;
    readonly matrixDigest: string;
  };
  readonly deployment: {
    readonly receipts: readonly {
      readonly receiptId: string;
      readonly surface: string;
      readonly passed: boolean;
      readonly summary: string;
    }[];
    readonly cliReceipts: readonly {
      readonly file: string;
      readonly surface: string;
      readonly expectations: readonly string[];
    }[];
    readonly passed: boolean;
  };
  readonly audit: {
    readonly method: {
      readonly markerPatterns: readonly string[];
      readonly scope: readonly string[];
    };
    readonly markerHitCount: number;
    readonly findingCount: number;
    readonly evidenceBackedSuccess: {
      readonly checkedJourneyStages: number;
      readonly definitiveStatesWithoutEvidence: number;
    };
    readonly honestUnavailabilityNoticeVerbatim: boolean;
    readonly passed: boolean;
  };
  readonly findings: readonly string[];
  readonly safetyObjective: typeof SAFETY_OBJECTIVE;
  readonly overall: {
    readonly verdict: "CERTIFIED" | "NOT_CERTIFIED";
    readonly statement: string;
  };
  readonly reportDigest: string;
}

/** Honest findings the certification records as-is (never smoothed). */
function collectFindings(input: {
  readonly journeys: readonly ProductionJourneyOutcome[];
  readonly gateWall: SecurityGateWallResult;
  readonly matrix: CertificationMatrixResult;
  readonly deployment: DeploymentExerciseResult;
  readonly audit: NoSimulatedSuccessAuditResult;
}): readonly string[] {
  const findings: string[] = [];
  for (const outcome of input.journeys) {
    if (!journeyPassed(outcome)) {
      findings.push(`JOURNEY FAILURE: ${outcome.journeyId} — ${outcome.assertions.filter((entry) => !entry.passed).map((entry) => entry.summary).join("; ")}`);
    }
  }
  for (const gate of input.gateWall.gates) {
    if (!gate.passed) {
      findings.push(`SECURITY GATE FAILURE: ${gate.gateId} (${gate.statement}) — evidence: ${gate.evidence.join("; ")}`);
    }
  }
  if (!input.matrix.allCertified) {
    findings.push(`MATRIX: not all areas certified — ${input.matrix.areas.filter((area) => area.verdict !== "CERTIFIED").map((area) => area.areaId).join(", ")}`);
  }
  for (const receipt of input.deployment.receipts) {
    if (!receipt.passed) {
      findings.push(`DEPLOYMENT RECEIPT FAILURE: ${receipt.receiptId} — ${receipt.summary}`);
    }
  }
  for (const finding of input.audit.findings) {
    findings.push(`NO-SIMULATED-SUCCESS AUDIT FINDING: ${finding.file}:${finding.line} [${finding.pattern}] ${finding.text}`);
  }
  // Honest notes (recorded even when everything passed — the certifier
  // reports the packet discrepancies and environmental facts as-is).
  findings.push(
    "NOTE (packet discrepancy, recorded as-is): the work-order prose says \"sixteen\" security certification gates while the §36 list itself carries SEVENTEEN statements; this certification checks ALL seventeen, verbatim.",
  );
  findings.push(
    "NOTE (packet discrepancy, recorded as-is): the work-order prose says \"fifteen-area\" certification matrix while the §34 P4-W4-003 list and the work order's own area enumeration carry FOURTEEN areas; this certification certifies all fourteen.",
  );
  findings.push(
    "NOTE (environmental fact, recorded as-is): the runtime-plane probe (deploy:probe) fails CLOSED in the certification sandbox — no vault bindings exist here (PAYSWAP_PRODUCTION_URL/PAYSWAP_RUNTIME_PROBE_SECRET/PAYSWAP_DATABASE_URL_PROD absent). The refusal output is the honest receipt (committed under evidence/deployment/); the deployment record's runtime-plane gates keep their honest NOT-EXECUTABLE verdicts. A live probe executes only in the operator console's environment with vault-resolved bindings.",
  );
  findings.push(
    "NOTE (repository state, recorded as-is): spec/development-state/phase-4-state.json lags git history at the pinned base — the W2-003 and W4-002 merges are not yet recorded in the state file (TL-pending state commits). This certification certifies the ASSEMBLED SYSTEM at the pinned base commit, which includes both merges.",
  );
  findings.push(
    "NOTE (certification scope, recorded as-is): the runtime-plane (live worker processes, database/queue wiring, hosted surfaces) is NOT deployed by this release — the zero-provider law (topology §2) keeps the rail-adapter role undeployed, and the deployment record certifies at platform/contract level with the honest NOT-EXECUTABLE runtime verdicts.",
  );
  return findings;
}

export interface CertificationInputs {
  readonly journeys: readonly ProductionJourneyOutcome[];
  readonly gateWall: SecurityGateWallResult;
  readonly matrix: CertificationMatrixResult;
  readonly deployment: DeploymentExerciseResult;
  readonly audit: NoSimulatedSuccessAuditResult;
}

/** Assemble the certification report from the real inputs (deterministic). */
export function buildCertificationReport(input: CertificationInputs & {
  readonly audit: NoSimulatedSuccessAuditResult;
}): CertificationReport {
  const findings = collectFindings(input);
  const journeysPassedCount = input.journeys.filter((outcome) => journeyPassed(outcome)).length;
  const gatesPassedCount = input.gateWall.gates.filter((gate) => gate.passed).length;
  const overallPassed =
    journeysPassedCount === input.journeys.length
    && gatesPassedCount === input.gateWall.gates.length
    && input.matrix.allCertified
    && input.deployment.passed
    && input.audit.passed;

  const report = {
    reportId: "payswap.production-certification-report" as const,
    workOrder: "P4-W4-003" as const,
    spec: "docs/UNIVERSAL-MONEY-HANDOFF-FULL-2026-10-02.md §34 P4-W4-003, §35, §36, §37" as const,
    release: {
      sha: CERTIFICATION_RELEASE_SHA,
      battery: CERTIFICATION_RELEASE_BATTERY,
      authorizedAt: CERTIFICATION_AUTHORIZED_AT,
    },
    journeys: input.journeys.map((outcome, index) => ({
      journeyId: outcome.journeyId,
      letter: PRODUCTION_JOURNEYS[index]?.letter ?? "?",
      title: outcome.title,
      passed: journeyPassed(outcome),
      journeyDigest: outcome.journeyDigest,
      stageCount: outcome.stages.length,
      assertionCount: outcome.assertions.length,
    })),
    journeysSummary: {
      passed: journeysPassedCount,
      total: input.journeys.length,
    },
    securityGates: input.gateWall.gates.map((gate) => ({
      gateId: gate.gateId,
      statement: gate.statement,
      kind: gate.kind,
      passed: gate.passed,
      evidence: gate.evidence,
      ...(gate.proof !== undefined
        ? { proof: { file: gate.proof.file, lines: gate.proof.lines, law: gate.proof.law } }
        : {}),
    })),
    securityGatesSummary: {
      passed: gatesPassedCount,
      total: input.gateWall.gates.length,
    },
    matrix: {
      areas: input.matrix.areas.map((area) => ({
        areaId: area.areaId,
        title: area.title,
        verdict: area.verdict,
        journeys: area.journeys,
        gates: area.gates,
        receipts: area.receipts,
      })),
      allCertified: input.matrix.allCertified,
      matrixDigest: input.matrix.matrixDigest,
    },
    deployment: {
      receipts: input.deployment.receipts.map((receipt) => ({
        receiptId: receipt.receiptId,
        surface: receipt.surface,
        passed: receipt.passed,
        summary: receipt.summary,
      })),
      cliReceipts: DEPLOYMENT_CLI_RECEIPT_FILES.map((entry) => ({
        file: entry.file,
        surface: entry.surface,
        expectations: [...entry.expectations],
      })),
      passed: input.deployment.passed,
    },
    audit: {
      method: {
        markerPatterns: input.audit.method.markerPatterns,
        scope: input.audit.method.scope,
      },
      markerHitCount: input.audit.markerHits.length,
      findingCount: input.audit.findings.length,
      evidenceBackedSuccess: {
        checkedJourneyStages: input.audit.evidenceBackedSuccess.checkedJourneyStages,
        definitiveStatesWithoutEvidence: input.audit.evidenceBackedSuccess.definitiveStatesWithoutEvidence,
      },
      honestUnavailabilityNoticeVerbatim: input.audit.honestUnavailability.stripeNoticeVerbatim,
      passed: input.audit.passed,
    },
    findings,
    safetyObjective: SAFETY_OBJECTIVE,
    overall: {
      verdict: overallPassed ? ("CERTIFIED" as const) : ("NOT_CERTIFIED" as const),
      statement: overallPassed
        ? `P4-W4-003 production certification: ${journeysPassedCount}/${input.journeys.length} acceptance journeys passed (A–I), ${gatesPassedCount}/${input.gateWall.gates.length} security certification gates passed (§36), ${input.matrix.areas.filter((area) => area.verdict === "CERTIFIED").length}/${input.matrix.areas.length} matrix areas certified, deployment/rollback receipts green, no-simulated-success audit clean. The safety claim is exactly the §37 engineering acceptance objective quoted verbatim below — nothing stronger.`
        : `P4-W4-003 production certification: NOT CERTIFIED — see findings.`,
    },
    reportDigest: "",
  };
  return Object.freeze({
    ...report,
    reportDigest: contentDigest(report),
  });
}

/** Canonical serialization (deterministic — the committed file's twin). */
export function serializeCertificationReport(report: CertificationReport): string {
  return JSON.stringify(report, null, 2) + "\n";
}

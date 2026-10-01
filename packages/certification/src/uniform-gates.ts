/**
 * THE uniform gate wall (W2-006; FROZEN-ARCHITECTURE §2A; ADR-006; INV-C07;
 * LAB.md "Promotion"; AGENTS.md rules 14/20).
 *
 * PASS_THROUGH_NATIVE, COMPOSED_PAYSWAP and OPTIMIZED_MULTI_PROVIDER share
 * the SAME authorization/compliance/evidence gates. There is ONE gate
 * pipeline, ONE requirements object and NO mode parameter anywhere in the
 * decision path:
 *
 * 1. TYPE-LEVEL: the decision core `evaluateUniformGates` consumes
 *    `UniformGateDecisionInput` = the candidate shape with `executionMode`
 *    and `isIncumbentBaseline` OMITTED — the decision input structurally
 *    CANNOT carry the execution mode or any incumbent flag, so no
 *    mode-specific branch is even expressible;
 * 2. VALUE-LEVEL: `UNIFORM_GATE_REQUIREMENTS` is a single frozen constant
 *    (all three gates, protocol authorization required by literal type,
 *    compliance clearance required by literal type, the INV-L02 evidence
 *    triple) — identical for every candidate of every mode;
 * 3. SOURCE-LEVEL: the package boundary test statically asserts the
 *    decision core never reads the mode (see test/boundary.test.ts).
 *
 * Provider-native optimization candidates (the incumbent baseline of
 * INV-C08) are gated IDENTICALLY: an incumbent-native candidate is rejected
 * whenever any gate fails — being the provider's own optimization never
 * confers a bypass (INV-C07, AGENTS.md rule 20).
 *
 * Deterministic only: a pure function of (candidate, requirements).
 */

import { isExecutionMode } from "@payswap/connectors";
import type { ExecutionMode } from "@payswap/connectors";
import { contentDigest } from "./digest.js";

// ---------------------------------------------------------------------------
// The wall: gate ids + THE requirements object
// ---------------------------------------------------------------------------

export const UNIFORM_GATE_IDS = ["AUTHORIZATION", "COMPLIANCE", "EVIDENCE"] as const;
export type UniformGateId = (typeof UNIFORM_GATE_IDS)[number];

export function isUniformGateId(value: unknown): value is UniformGateId {
  return (
    typeof value === "string" &&
    (UNIFORM_GATE_IDS as readonly unknown[]).includes(value)
  );
}

/** The evidence kinds every mode must present (the INV-L02 triple). */
export const UNIFORM_REQUIRED_EVIDENCE_KINDS = [
  "REPLAY",
  "COUNTERFACTUAL",
  "ROBUSTNESS",
] as const;

/**
 * THE uniform requirements. `requireProtocolAuthorization` and
 * `requireComplianceClearance` are literal `true` types: they cannot be
 * declared false, omitted or disabled by any caller, for any mode.
 */
export interface UniformGateRequirements {
  readonly requireProtocolAuthorization: true;
  readonly requireComplianceClearance: true;
  readonly requiredGates: readonly UniformGateId[];
  readonly requiredEvidenceKinds: readonly string[];
}

/** THE single requirements object for ALL three execution modes. */
export const UNIFORM_GATE_REQUIREMENTS: UniformGateRequirements = Object.freeze({
  requireProtocolAuthorization: true,
  requireComplianceClearance: true,
  requiredGates: Object.freeze([...UNIFORM_GATE_IDS]),
  requiredEvidenceKinds: Object.freeze([...UNIFORM_REQUIRED_EVIDENCE_KINDS]),
});

/** Raised for malformed candidates. */
export class UniformGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UniformGateError";
  }
}

// ---------------------------------------------------------------------------
// Candidate + gate inputs
// ---------------------------------------------------------------------------

/** Authorization lineage evidence (why the action is allowed — INV-E01). */
export interface AuthorizationEvidenceLineageRef {
  readonly authorizationRef: string;
  readonly evidenceRef: string;
  /** Network security epoch at which the authorization was issued (INV-S02). */
  readonly issuedAtEpoch: bigint;
}

/** A policy/evidence-backed compliance clearance (INV-R04). */
export interface ComplianceClearanceRef {
  readonly clearanceId: string;
  readonly policyRef: string;
  readonly evidenceRef: string;
}

/** One evidence artifact backing the candidate (INV-L02). */
export interface UniformEvidenceRef {
  readonly evidenceId: string;
  readonly kind: string;
  readonly artifactRef: string;
  readonly contentDigest: string;
}

/**
 * A candidate crossing the wall. `executionMode` and `isIncumbentBaseline`
 * are ATTRIBUTION fields: they ride along for reporting and are
 * structurally excluded from the gate decision (see UniformGateDecisionInput).
 */
export interface UniformGateCandidate {
  readonly candidateId: string;
  readonly executionMode: ExecutionMode;
  /** True for the provider-native optimization incumbent baseline (INV-C08). */
  readonly isIncumbentBaseline: boolean;
  readonly authorizationEvidence: readonly AuthorizationEvidenceLineageRef[];
  readonly complianceClearances: readonly ComplianceClearanceRef[];
  readonly evidence: readonly UniformEvidenceRef[];
}

/**
 * THE decision input: the candidate with `executionMode` and
 * `isIncumbentBaseline` structurally removed. The uniform gate decision is
 * a pure function of this shape — it CANNOT see the mode.
 */
export type UniformGateDecisionInput = Omit<
  UniformGateCandidate,
  "executionMode" | "isIncumbentBaseline"
>;

// ---------------------------------------------------------------------------
// The decision core + the wall
// ---------------------------------------------------------------------------

/** One uniform gate check result. */
export interface UniformGateCheck {
  readonly gateId: UniformGateId;
  readonly passed: boolean;
  readonly violations: readonly string[];
}

/**
 * THE decision core — ONE pipeline for ALL three execution modes. This
 * function receives no execution mode and no incumbent flag (enforced by
 * the UniformGateDecisionInput type), so its output is identical for
 * identical authorization/compliance/evidence submissions, whatever the
 * mode of the candidate they came from.
 */
export function evaluateUniformGates(
  decision: UniformGateDecisionInput,
  requirements: UniformGateRequirements,
): readonly UniformGateCheck[] {
  if (decision.candidateId.length === 0) {
    throw new UniformGateError("candidateId must not be empty");
  }
  const checks: UniformGateCheck[] = [];

  // -- AUTHORIZATION gate (INV-C07: no mode can bypass protocol authorization)
  const authViolations: string[] = [];
  if (requirements.requireProtocolAuthorization !== true) {
    // Unreachable by type; kept as a fail-closed guard for untyped callers.
    authViolations.push("requirements must require protocol authorization");
  }
  if (decision.authorizationEvidence.length === 0) {
    authViolations.push(
      "no authorization lineage evidence was presented: every execution mode (including the provider-native pass-through) requires protocol authorization (INV-C07)",
    );
  }
  for (const ref of decision.authorizationEvidence) {
    if (ref.authorizationRef.length === 0 || ref.evidenceRef.length === 0) {
      authViolations.push(
        `authorization evidence '${ref.authorizationRef}' is incomplete (authorizationRef + evidenceRef required)`,
      );
    }
    if (ref.issuedAtEpoch < 0n) {
      authViolations.push(
        `authorization evidence '${ref.authorizationRef}' carries a negative issuance epoch`,
      );
    }
  }
  checks.push({
    gateId: "AUTHORIZATION",
    passed: authViolations.length === 0,
    violations: Object.freeze(authViolations),
  });

  // -- COMPLIANCE gate (INV-R04: compliance blocks are policy/evidence backed)
  const complianceViolations: string[] = [];
  if (requirements.requireComplianceClearance !== true) {
    complianceViolations.push("requirements must require compliance clearance");
  }
  if (decision.complianceClearances.length === 0) {
    complianceViolations.push(
      "no compliance clearance was presented: compliance, sanctions, risk and policy constraints are hard constraints before soft optimization (AGENTS.md rule 14)",
    );
  }
  for (const clearance of decision.complianceClearances) {
    if (
      clearance.clearanceId.length === 0 ||
      clearance.policyRef.length === 0 ||
      clearance.evidenceRef.length === 0
    ) {
      complianceViolations.push(
        `compliance clearance '${clearance.clearanceId}' is incomplete (clearanceId + policyRef + evidenceRef required)`,
      );
    }
  }
  checks.push({
    gateId: "COMPLIANCE",
    passed: complianceViolations.length === 0,
    violations: Object.freeze(complianceViolations),
  });

  // -- EVIDENCE gate (INV-L02: the replay/counterfactual/robustness triple)
  const evidenceViolations: string[] = [];
  const presentKinds = new Set(decision.evidence.map((ref) => ref.kind));
  for (const kind of requirements.requiredEvidenceKinds) {
    if (!presentKinds.has(kind)) {
      evidenceViolations.push(
        `required evidence kind '${kind}' is missing (INV-L02)`,
      );
    }
  }
  for (const ref of decision.evidence) {
    if (
      ref.evidenceId.length === 0 ||
      ref.artifactRef.length === 0 ||
      ref.contentDigest.length === 0
    ) {
      evidenceViolations.push(
        `evidence reference '${ref.evidenceId}' is incomplete`,
      );
    }
  }
  checks.push({
    gateId: "EVIDENCE",
    passed: evidenceViolations.length === 0,
    violations: Object.freeze(evidenceViolations),
  });

  return Object.freeze(
    checks.filter((check) => requirements.requiredGates.includes(check.gateId)),
  );
}

/** The wall result: attribution (mode, incumbent flag) + the gate checks. */
export interface UniformGateWallResult {
  readonly candidateId: string;
  readonly executionMode: ExecutionMode;
  readonly isIncumbentBaseline: boolean;
  /** THE requirements object the wall used — the same object for every mode. */
  readonly requirements: UniformGateRequirements;
  readonly gateChecks: readonly UniformGateCheck[];
  readonly passed: boolean;
  readonly wallDigest: string;
}

/**
 * THE uniform gate wall: runs the single decision core over the candidate's
 * authorization/compliance/evidence submissions and attaches the attribution
 * fields (mode, incumbent flag) to the RESULT ONLY. Identical submissions
 * produce identical gate checks for every mode.
 */
export function runUniformGateWall(
  candidate: UniformGateCandidate,
): UniformGateWallResult {
  if (!isExecutionMode(candidate.executionMode)) {
    throw new UniformGateError(
      `candidate '${candidate.candidateId}' does not carry an explicit execution mode (INV-C07)`,
    );
  }
  if (candidate.candidateId.length === 0) {
    throw new UniformGateError("candidateId must not be empty");
  }
  // THE decision: mode and incumbent flag are structurally absent here.
  const gateChecks = evaluateUniformGates(
    {
      candidateId: candidate.candidateId,
      authorizationEvidence: candidate.authorizationEvidence,
      complianceClearances: candidate.complianceClearances,
      evidence: candidate.evidence,
    },
    UNIFORM_GATE_REQUIREMENTS,
  );
  const passed = gateChecks.every((check) => check.passed);
  const wallDigest = contentDigest({
    candidateId: candidate.candidateId,
    gateChecks,
    passed,
  });
  return Object.freeze({
    candidateId: candidate.candidateId,
    executionMode: candidate.executionMode,
    isIncumbentBaseline: candidate.isIncumbentBaseline,
    requirements: UNIFORM_GATE_REQUIREMENTS,
    gateChecks,
    passed,
    wallDigest,
  });
}

/** Thrown by `assertUniformGateWall` when any gate fails — for every mode. */
export class UniformGateRejectionError extends Error {
  readonly candidateId: string;
  readonly gateChecks: readonly UniformGateCheck[];

  constructor(candidateId: string, gateChecks: readonly UniformGateCheck[]) {
    const failed = gateChecks.filter((check) => !check.passed);
    super(
      `Candidate '${candidateId}' was rejected by the uniform gate wall: ${failed
        .map((check) => `${check.gateId} (${check.violations.join("; ")})`)
        .join(" | ")}`,
    );
    this.name = "UniformGateRejectionError";
    this.candidateId = candidateId;
    this.gateChecks = gateChecks;
  }
}

/**
 * Throwing variant of the wall. Provider-native optimization candidates
 * (the incumbent baseline) are gated IDENTICALLY: a failing gate rejects
 * them exactly like every other candidate.
 */
export function assertUniformGateWall(
  candidate: UniformGateCandidate,
): UniformGateWallResult {
  const result = runUniformGateWall(candidate);
  if (!result.passed) {
    throw new UniformGateRejectionError(candidate.candidateId, result.gateChecks);
  }
  return result;
}

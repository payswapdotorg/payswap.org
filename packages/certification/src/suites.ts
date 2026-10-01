/**
 * Certification suites (W2-006; FROZEN-ARCHITECTURE §LAB / §2A; LAB.md
 * "Promotion" / "Evaluation"; INV-C03, INV-C05..C09, INV-SC04, INV-L02).
 *
 * A certification SUITE is a versioned, parameterized definition of what a
 * component of a given kind must present to be certified for production:
 * the required EVIDENCE KINDS plus the required GATE RESULTS. Every
 * production strategy / organization / agent package / connector is
 * certifiable — the suite vocabulary is total over the certifiable kinds
 * (`CERTIFIABLE_COMPONENT_KINDS`).
 *
 * Connector certification is a first-class suite consumer: it verifies the
 * capability hierarchy (definition → implementation → instance →
 * observation chain), the connected-instance scope (INV-C05), provider-state
 * preservation in the lossless envelope (INV-C06), explicit execution modes
 * under protocol authorization (INV-C07) and external-funds observation
 * semantics (INV-C09). The connector vocabulary itself is owned by the
 * connectors package and consumed here — never redefined.
 *
 * Deterministic only: every decision is a pure function of the suite, the
 * submitted evidence/gate results and the registry snapshots; timestamps are
 * declared by the caller.
 */

import { ValidationError } from "@payswap/protocol";
import {
  isExecutionMode,
  isProviderStateFamily,
  validateExternalFundsPositionObservation,
} from "@payswap/connectors";
import type {
  CapabilityDefinition,
  ConnectedCapabilityInstance,
  ConnectorRegistry,
  ExternalFundsPositionObservation,
  ProviderStateEnvelope,
} from "@payswap/connectors";
import { contentDigest } from "./digest.js";

// ---------------------------------------------------------------------------
// Certifiable component kinds + suite vocabulary
// ---------------------------------------------------------------------------

/**
 * The component kinds that can be certified for production. Strategy = a
 * Lab-promoted production candidate; organization = a released organization
 * version; agent_package = a versioned agent package; connector = a
 * connector capability chain exposed through the connectors registry.
 */
export const CERTIFIABLE_COMPONENT_KINDS = [
  "strategy",
  "organization",
  "agent_package",
  "connector",
] as const;
export type CertifiableComponentKind = (typeof CERTIFIABLE_COMPONENT_KINDS)[number];

export function isCertifiableComponentKind(
  value: unknown,
): value is CertifiableComponentKind {
  return (
    typeof value === "string" &&
    (CERTIFIABLE_COMPONENT_KINDS as readonly unknown[]).includes(value)
  );
}

/** Evidence kinds a certification suite can require. */
export const SUITE_EVIDENCE_KINDS = [
  "BASELINE_SUITE_EVALUATION",
  "REPLAY",
  "COUNTERFACTUAL",
  "ROBUSTNESS",
  "SHADOW_REPORT",
  "CANARY_REPORT",
  "SECURITY_REVIEW",
  "AUDIT",
  "ATTESTATION",
  "TEST_RUN",
] as const;
export type SuiteEvidenceKind = (typeof SUITE_EVIDENCE_KINDS)[number];

export function isSuiteEvidenceKind(value: unknown): value is SuiteEvidenceKind {
  return (
    typeof value === "string" &&
    (SUITE_EVIDENCE_KINDS as readonly unknown[]).includes(value)
  );
}

/**
 * Gate ids a certification suite can require. The five connector-specific
 * gates map one-to-one onto the connector certification axes (hierarchy,
 * scope, provider-state, execution modes, external funds); the four general
 * gates (authorization/compliance/evidence/security) apply to every kind.
 */
export const SUITE_GATE_IDS = [
  "AUTHORIZATION_GATE",
  "COMPLIANCE_GATE",
  "EVIDENCE_GATE",
  "SECURITY_GATE",
  "HIERARCHY_GATE",
  "SCOPE_GATE",
  "PROVIDER_STATE_GATE",
  "EXECUTION_MODE_GATE",
  "EXTERNAL_FUNDS_GATE",
] as const;
export type SuiteGateId = (typeof SUITE_GATE_IDS)[number];

export function isSuiteGateId(value: unknown): value is SuiteGateId {
  return (
    typeof value === "string" &&
    (SUITE_GATE_IDS as readonly unknown[]).includes(value)
  );
}

/** Raised for invalid suite operations. */
export class CertificationSuiteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CertificationSuiteError";
  }
}

/**
 * One versioned suite definition. Suites are historical protocol facts
 * (AGENTS.md rule 8): registering a new version of a suite APPENDS to the
 * registry and never rewrites a prior version.
 */
export interface CertificationSuite {
  readonly suiteId: string;
  readonly suiteVersion: number;
  readonly componentKind: CertifiableComponentKind;
  readonly description: string;
  readonly requiredEvidenceKinds: readonly SuiteEvidenceKind[];
  readonly requiredGates: readonly SuiteGateId[];
}

/** The subject a suite evaluates. */
export interface SuiteSubjectRef {
  readonly componentKind: CertifiableComponentKind;
  readonly subjectId: string;
  readonly version: string;
}

/** One evidence submission backing a certification run. */
export interface SuiteEvidenceSubmission {
  readonly evidenceId: string;
  readonly kind: SuiteEvidenceKind;
  readonly artifactRef: string;
  readonly contentDigest: string;
}

/** One submitted gate result (produced by the gate owners). */
export interface SuiteGateResult {
  readonly gateId: SuiteGateId;
  readonly passed: boolean;
  readonly note?: string;
}

/** The outcome of evaluating a subject against a suite. */
export interface SuiteEvaluationResult {
  readonly subject: SuiteSubjectRef;
  readonly suiteId: string;
  readonly suiteVersion: number;
  readonly passed: boolean;
  readonly missingEvidenceKinds: readonly SuiteEvidenceKind[];
  readonly failedGates: readonly SuiteGateId[];
  readonly missingGates: readonly SuiteGateId[];
  readonly evaluationDigest: string;
}

// ---------------------------------------------------------------------------
// Default suites, parameterized by component kind
// ---------------------------------------------------------------------------

function suite(
  componentKind: CertifiableComponentKind,
  suiteVersion: number,
  requiredEvidenceKinds: readonly SuiteEvidenceKind[],
  requiredGates: readonly SuiteGateId[],
): CertificationSuite {
  return Object.freeze({
    suiteId: `suite:${componentKind}`,
    suiteVersion,
    componentKind,
    description: `Default production certification suite for ${componentKind} components (W2-006).`,
    requiredEvidenceKinds: Object.freeze([...requiredEvidenceKinds]),
    requiredGates: Object.freeze([...requiredGates]),
  });
}

/**
 * The default production certification suite for a component kind.
 *
 * - strategy: the full INV-L02 promotion bundle plus shadow/canary reports —
 *   a production strategy must carry replay/counterfactual/robustness
 *   evidence and the staged deployment reports;
 * - organization / agent_package: attestations, tests, audit and the four
 *   general gates;
 * - connector: the five connector axes plus the general gates.
 *
 * Every certifiable kind has a suite: no production component kind is
 * uncertifiable by construction.
 */
export function defaultSuiteFor(
  componentKind: CertifiableComponentKind,
): CertificationSuite {
  switch (componentKind) {
    case "strategy":
      return suite(
        "strategy",
        1,
        [
          "BASELINE_SUITE_EVALUATION",
          "REPLAY",
          "COUNTERFACTUAL",
          "ROBUSTNESS",
          "SHADOW_REPORT",
          "CANARY_REPORT",
          "SECURITY_REVIEW",
        ],
        [
          "AUTHORIZATION_GATE",
          "COMPLIANCE_GATE",
          "EVIDENCE_GATE",
          "SECURITY_GATE",
        ],
      );
    case "organization":
      return suite(
        "organization",
        1,
        ["ATTESTATION", "TEST_RUN", "SECURITY_REVIEW"],
        [
          "AUTHORIZATION_GATE",
          "COMPLIANCE_GATE",
          "EVIDENCE_GATE",
          "SECURITY_GATE",
        ],
      );
    case "agent_package":
      return suite(
        "agent_package",
        1,
        ["TEST_RUN", "AUDIT", "SECURITY_REVIEW"],
        ["EVIDENCE_GATE", "SECURITY_GATE"],
      );
    case "connector":
      return suite(
        "connector",
        1,
        ["TEST_RUN", "ATTESTATION"],
        [
          "AUTHORIZATION_GATE",
          "EVIDENCE_GATE",
          "SECURITY_GATE",
          "HIERARCHY_GATE",
          "SCOPE_GATE",
          "PROVIDER_STATE_GATE",
          "EXECUTION_MODE_GATE",
          "EXTERNAL_FUNDS_GATE",
        ],
      );
  }
}

/**
 * The append-only suite registry: registering a new version of a suite id
 * appends; prior versions stay queryable forever (AGENTS.md rule 8).
 */
export class CertificationSuiteRegistry {
  private readonly byId = new Map<string, CertificationSuite[]>();

  /** Registers a suite version. The same (suiteId, suiteVersion) cannot repeat. */
  register(definition: CertificationSuite): CertificationSuite {
    if (definition.suiteId.length === 0) {
      throw new CertificationSuiteError("suiteId must not be empty");
    }
    if (!isCertifiableComponentKind(definition.componentKind)) {
      throw new CertificationSuiteError(
        `unknown certifiable component kind '${String(definition.componentKind)}'`,
      );
    }
    if (definition.suiteVersion < 1) {
      throw new CertificationSuiteError("suiteVersion must be >= 1");
    }
    if (definition.description.length === 0) {
      throw new CertificationSuiteError("description must not be empty");
    }
    for (const kind of definition.requiredEvidenceKinds) {
      if (!isSuiteEvidenceKind(kind)) {
        throw new CertificationSuiteError(
          `unknown required evidence kind '${String(kind)}'`,
        );
      }
    }
    for (const gateId of definition.requiredGates) {
      if (!isSuiteGateId(gateId)) {
        throw new CertificationSuiteError(
          `unknown required gate '${String(gateId)}'`,
        );
      }
    }
    const history = this.byId.get(definition.suiteId) ?? [];
    if (
      history.some((entry) => entry.suiteVersion === definition.suiteVersion)
    ) {
      throw new CertificationSuiteError(
        `suite '${definition.suiteId}' version ${definition.suiteVersion} is already registered (suites are versioned history — publish a new version instead)`,
      );
    }
    const stored: CertificationSuite = Object.freeze({
      ...definition,
      requiredEvidenceKinds: Object.freeze([...definition.requiredEvidenceKinds]),
      requiredGates: Object.freeze([...definition.requiredGates]),
    });
    this.byId.set(definition.suiteId, [...history, stored]);
    return stored;
  }

  /** Every registered version of a suite id, oldest first (append-only). */
  historyFor(suiteId: string): readonly CertificationSuite[] {
    return [...(this.byId.get(suiteId) ?? [])];
  }

  /** The latest registered version of a suite id, if any. */
  latest(suiteId: string): CertificationSuite | undefined {
    const history = this.byId.get(suiteId) ?? [];
    return history[history.length - 1];
  }

  /** Latest suite registered for a component kind, or the default suite. */
  forComponentKind(
    componentKind: CertifiableComponentKind,
  ): CertificationSuite {
    const known = this.historyFor(`suite:${componentKind}`);
    const latest = known[known.length - 1];
    return latest ?? defaultSuiteFor(componentKind);
  }

  /** All registered suites in registration order. */
  list(): readonly CertificationSuite[] {
    const out: CertificationSuite[] = [];
    for (const history of this.byId.values()) {
      out.push(...history);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Suite evaluation (required evidence kinds + gate results)
// ---------------------------------------------------------------------------

/**
 * Evaluates a subject against a suite: every required evidence kind must be
 * covered by a submission, every required gate must have a PASSING result.
 * Missing evidence, missing gates and failed gates are all reported; the
 * evaluation passes only when all three lists are empty.
 */
export function evaluateSuite(input: {
  readonly suite: CertificationSuite;
  readonly subject: SuiteSubjectRef;
  readonly evidence: readonly SuiteEvidenceSubmission[];
  readonly gateResults: readonly SuiteGateResult[];
}): SuiteEvaluationResult {
  if (!isCertifiableComponentKind(input.subject.componentKind)) {
    throw new CertificationSuiteError(
      `subject has unknown component kind '${String(input.subject.componentKind)}'`,
    );
  }
  if (input.subject.subjectId.length === 0) {
    throw new CertificationSuiteError("subjectId must not be empty");
  }
  if (input.subject.version.length === 0) {
    throw new CertificationSuiteError("subject version must not be empty");
  }
  if (input.suite.componentKind !== input.subject.componentKind) {
    throw new CertificationSuiteError(
      `suite '${input.suite.suiteId}' certifies ${input.suite.componentKind} components; the subject is a ${input.subject.componentKind}`,
    );
  }
  for (const submission of input.evidence) {
    if (
      submission.evidenceId.length === 0 ||
      submission.artifactRef.length === 0 ||
      submission.contentDigest.length === 0 ||
      !isSuiteEvidenceKind(submission.kind)
    ) {
      throw new CertificationSuiteError(
        `incomplete evidence submission '${submission.evidenceId}'`,
      );
    }
  }
  for (const result of input.gateResults) {
    if (!isSuiteGateId(result.gateId)) {
      throw new CertificationSuiteError(
        `unknown gate id '${String(result.gateId)}'`,
      );
    }
  }

  const presentEvidence = new Set(input.evidence.map((ref) => ref.kind));
  const missingEvidenceKinds = input.suite.requiredEvidenceKinds.filter(
    (kind) => !presentEvidence.has(kind),
  );

  const resultsByGate = new Map(input.gateResults.map((r) => [r.gateId, r]));
  const missingGates = input.suite.requiredGates.filter(
    (gateId) => !resultsByGate.has(gateId),
  );
  const failedGates = input.suite.requiredGates.filter((gateId) => {
    const result = resultsByGate.get(gateId);
    return result !== undefined && !result.passed;
  });

  const passed =
    missingEvidenceKinds.length === 0 &&
    missingGates.length === 0 &&
    failedGates.length === 0;
  const evaluationDigest = contentDigest({
    subject: input.subject,
    suiteId: input.suite.suiteId,
    suiteVersion: input.suite.suiteVersion,
    evidence: input.evidence,
    gateResults: input.gateResults,
    passed,
  });
  return Object.freeze({
    subject: input.subject,
    suiteId: input.suite.suiteId,
    suiteVersion: input.suite.suiteVersion,
    passed,
    missingEvidenceKinds: Object.freeze([...missingEvidenceKinds]),
    failedGates: Object.freeze([...failedGates]),
    missingGates: Object.freeze([...missingGates]),
    evaluationDigest,
  });
}

// ---------------------------------------------------------------------------
// Subject artifact verification (structural views over the owning packages)
// ---------------------------------------------------------------------------

/**
 * Structural view of a Lab candidate (the strategy subject). The Lab package
 * owns the concrete shape; certification consumes it structurally so the
 * boundary rules stay intact. The concrete candidate objects are assignable
 * to this view.
 */
export interface StructuralStrategyCandidate {
  readonly candidateId: string;
  /** Explicit execution mode (validated here — INV-C07). */
  readonly executionMode: string;
  readonly stage: string;
  readonly evidence: readonly { readonly evidenceId: string; readonly kind: string }[];
}

/** Structural view of a released organization version (agents package). */
export interface StructuralReleasedOrganization {
  readonly id: string;
  readonly version: number;
  readonly release: {
    readonly releasedAt: number;
    readonly contentHash: string;
  };
  readonly safetyPolicy: {
    readonly hardConstraints: readonly string[];
  };
}

/** Structural view of a versioned agent package (agents package). */
export interface StructuralAgentPackage {
  readonly id: string;
  readonly version: number;
  readonly provenance: {
    readonly source: string;
    readonly contentHash: string;
    readonly createdAt: number;
  };
  readonly evaluationSuiteRef: string;
}

/** One subject-artifact violation found during verification. */
export interface SubjectViolation {
  readonly componentKind: CertifiableComponentKind;
  readonly subjectId: string;
  readonly problem: string;
}

function verifyStrategyArtifact(
  artifact: StructuralStrategyCandidate,
): readonly SubjectViolation[] {
  const violations: SubjectViolation[] = [];
  if (artifact.candidateId.length === 0) {
    violations.push({
      componentKind: "strategy",
      subjectId: artifact.candidateId,
      problem: "candidateId must not be empty",
    });
  }
  if (!isExecutionMode(artifact.executionMode)) {
    violations.push({
      componentKind: "strategy",
      subjectId: artifact.candidateId,
      problem: `executionMode '${String(artifact.executionMode)}' is not an explicit execution mode (INV-C07)`,
    });
  }
  if (artifact.evidence.length === 0) {
    violations.push({
      componentKind: "strategy",
      subjectId: artifact.candidateId,
      problem: "a certifiable strategy must carry at least one evidence reference (INV-L02)",
    });
  }
  return violations;
}

function verifyOrganizationArtifact(
  artifact: StructuralReleasedOrganization,
): readonly SubjectViolation[] {
  const violations: SubjectViolation[] = [];
  if (artifact.id.length === 0) {
    violations.push({
      componentKind: "organization",
      subjectId: artifact.id,
      problem: "organization id must not be empty",
    });
  }
  if (artifact.version < 1) {
    violations.push({
      componentKind: "organization",
      subjectId: artifact.id,
      problem: "released organization version must be >= 1",
    });
  }
  if (artifact.release.contentHash.length === 0) {
    violations.push({
      componentKind: "organization",
      subjectId: artifact.id,
      problem: "released organization must be content-addressed (INV-G02)",
    });
  }
  if (artifact.safetyPolicy.hardConstraints.length === 0) {
    violations.push({
      componentKind: "organization",
      subjectId: artifact.id,
      problem: "a production organization must declare hard constraints (AGENTS.md rule 14)",
    });
  }
  return violations;
}

function verifyAgentPackageArtifact(
  artifact: StructuralAgentPackage,
): readonly SubjectViolation[] {
  const violations: SubjectViolation[] = [];
  if (artifact.id.length === 0) {
    violations.push({
      componentKind: "agent_package",
      subjectId: artifact.id,
      problem: "package id must not be empty",
    });
  }
  if (artifact.version < 1) {
    violations.push({
      componentKind: "agent_package",
      subjectId: artifact.id,
      problem: "agent package version must be >= 1",
    });
  }
  if (
    artifact.provenance.source.length === 0 ||
    artifact.provenance.contentHash.length === 0
  ) {
    violations.push({
      componentKind: "agent_package",
      subjectId: artifact.id,
      problem: "agent package provenance must be complete (source + contentHash)",
    });
  }
  if (artifact.evaluationSuiteRef.length === 0) {
    violations.push({
      componentKind: "agent_package",
      subjectId: artifact.id,
      problem: "agent package must reference its evaluation suite",
    });
  }
  return violations;
}

/** The certifiable subject artifact, discriminated by component kind. */
export type CertifiableSubjectArtifact =
  | { readonly componentKind: "strategy"; readonly artifact: StructuralStrategyCandidate }
  | { readonly componentKind: "organization"; readonly artifact: StructuralReleasedOrganization }
  | { readonly componentKind: "agent_package"; readonly artifact: StructuralAgentPackage };

/**
 * Verifies a subject artifact of kind strategy / organization / agent
 * package against the structural certification requirements. Connector
 * subjects are certified through `certifyConnector` (the connector axis
 * checks below).
 */
export function verifySubjectArtifact(
  subject: CertifiableSubjectArtifact,
): readonly SubjectViolation[] {
  switch (subject.componentKind) {
    case "strategy":
      return verifyStrategyArtifact(subject.artifact);
    case "organization":
      return verifyOrganizationArtifact(subject.artifact);
    case "agent_package":
      return verifyAgentPackageArtifact(subject.artifact);
  }
}

// ---------------------------------------------------------------------------
// Connector certification: hierarchy / scope / provider state / modes /
// external funds (INV-C05..C09)
// ---------------------------------------------------------------------------

/** Hierarchy (chain completeness) check result. */
export interface HierarchyCheck {
  readonly complete: boolean;
  readonly gaps: readonly string[];
}

/** One connected-instance scope violation (INV-C05). */
export interface ScopeViolation {
  readonly instanceId: string;
  readonly problem: string;
}

/** One provider-state preservation violation (INV-C06). */
export interface ProviderStateViolation {
  readonly instanceId: string;
  readonly problem: string;
}

/** One execution-mode declaration violation (INV-C07). */
export interface ExecutionModeViolation {
  readonly capabilityId: string;
  readonly problem: string;
}

/** One external-funds observation violation (INV-C09). */
export interface ExternalFundsViolation {
  readonly observationId: string;
  readonly problem: string;
}

/**
 * The connector certification result. `externalFundsTreatedAsCustody` is a
 * literal false: external funds observations are observations of external
 * state and can never become PaySwap custody (INV-C09) — the type itself
 * documents and enforces the semantics.
 */
export interface ConnectorCertificationResult {
  readonly passed: boolean;
  readonly hierarchy: HierarchyCheck;
  readonly scopeViolations: readonly ScopeViolation[];
  readonly providerStateViolations: readonly ProviderStateViolation[];
  readonly executionModeViolations: readonly ExecutionModeViolation[];
  readonly externalFundsViolations: readonly ExternalFundsViolation[];
  readonly externalFundsTreatedAsCustody: false;
  readonly certificationDigest: string;
}

/**
 * INV-C05 — connected-instance scope verification. A connected instance must
 * be scoped to a REAL provider account/tenant with an ACTIVE authorization,
 * a credential scope, non-empty geography/currency scope, no missing
 * permissions and positive eligibility. A provider catalogue claim never
 * reaches this check: the registry refuses to register catalogue entries as
 * instances in the first place.
 */
export function verifyConnectedInstanceScope(
  instance: ConnectedCapabilityInstance,
): readonly ScopeViolation[] {
  const violations: ScopeViolation[] = [];
  if (instance.accountRef.length === 0 || instance.tenantRef.length === 0) {
    violations.push({
      instanceId: instance.instanceId,
      problem: "must be scoped to a real provider account/tenant (INV-C05)",
    });
  }
  if (instance.authorization.status !== "ACTIVE") {
    violations.push({
      instanceId: instance.instanceId,
      problem: `authorization status is '${instance.authorization.status}' (must be ACTIVE for production certification)`,
    });
  }
  if (instance.credentialScope.credentialRef.length === 0) {
    violations.push({
      instanceId: instance.instanceId,
      problem: "credential scope must reference a real credential",
    });
  }
  if (instance.geography.countries.length === 0) {
    violations.push({
      instanceId: instance.instanceId,
      problem: "geography scope must not be empty",
    });
  }
  if (instance.currencies.length === 0) {
    violations.push({
      instanceId: instance.instanceId,
      problem: "currency scope must not be empty",
    });
  }
  if (instance.permissionState.missing.length > 0) {
    violations.push({
      instanceId: instance.instanceId,
      problem: `missing required permissions: ${instance.permissionState.missing.join(", ")}`,
    });
  }
  if (!instance.eligibility.eligible) {
    violations.push({
      instanceId: instance.instanceId,
      problem: `account is not eligible: ${instance.eligibility.reasons.join("; ")}`,
    });
  }
  return violations;
}

/**
 * INV-C06 — provider-state preservation verification. The envelope must
 * carry the raw provider-native state VERBATIM (never erased or flattened),
 * an additive classification (valid family + lifecycle step), the revision
 * history, a privacy scope declaration and observation timestamps. The raw
 * state stays opaque here: certification verifies preservation, never
 * interpretation.
 */
export function verifyProviderStatePreservation(
  envelope: ProviderStateEnvelope,
): readonly ProviderStateViolation[] {
  const violations: ProviderStateViolation[] = [];
  const label = envelope.object.externalId;
  if (envelope.provider.name.length === 0 || envelope.provider.version.length === 0) {
    violations.push({
      instanceId: label,
      problem: "envelope must identify its provider (name + version)",
    });
  }
  if (envelope.object.objectType.length === 0 || label.length === 0) {
    violations.push({
      instanceId: label,
      problem: "envelope must identify the external object (type + externalId)",
    });
  }
  if (envelope.revision.length === 0) {
    violations.push({
      instanceId: label,
      problem: "envelope must carry the provider revision",
    });
  }
  if (envelope.state === undefined || envelope.state === null) {
    violations.push({
      instanceId: label,
      problem: "raw provider-native state is missing: the envelope must preserve it verbatim (INV-C06)",
    });
  }
  if (!isProviderStateFamily(envelope.classification.family)) {
    violations.push({
      instanceId: label,
      problem: `classification family '${String(envelope.classification.family)}' is not a known provider-state family`,
    });
  }
  if (envelope.classification.lifecycleStep.length === 0) {
    violations.push({
      instanceId: label,
      problem: "classification must carry the provider-declared lifecycle step",
    });
  }
  for (const transition of envelope.history) {
    if (transition.toRevision.length === 0) {
      violations.push({
        instanceId: label,
        problem: "state history transitions must carry toRevision",
      });
    }
  }
  if (envelope.privacy.constraints.length === 0 && envelope.privacy.shareableFields.length === 0) {
    violations.push({
      instanceId: label,
      problem: "privacy scope declaration must be present (constraints or shareable fields)",
    });
  }
  if (envelope.timestamps.observedAt.length === 0) {
    violations.push({
      instanceId: label,
      problem: "envelope must carry the observation timestamp",
    });
  }
  return violations;
}

/**
 * INV-C07 — execution-mode declaration verification. The capability
 * definition must declare at least one explicit, valid, duplicate-free
 * execution mode and declare protocol authorization as a literal true: no
 * mode — including the provider-native pass-through — can bypass protocol
 * authorization.
 */
export function verifyExecutionModesDeclaration(
  definition: CapabilityDefinition,
): readonly ExecutionModeViolation[] {
  const violations: ExecutionModeViolation[] = [];
  if (definition.executionModes.length === 0) {
    violations.push({
      capabilityId: definition.capabilityId,
      problem: "must declare at least one explicit execution mode (INV-C07)",
    });
  }
  const seen = new Set<string>();
  for (const mode of definition.executionModes) {
    if (!isExecutionMode(mode)) {
      violations.push({
        capabilityId: definition.capabilityId,
        problem: `unknown execution mode '${String(mode)}' (INV-C07)`,
      });
    }
    if (seen.has(mode)) {
      violations.push({
        capabilityId: definition.capabilityId,
        problem: `duplicate execution mode '${String(mode)}'`,
      });
    }
    seen.add(mode);
  }
  if (definition.authorization.protocolAuthorization !== true) {
    violations.push({
      capabilityId: definition.capabilityId,
      problem: "protocolAuthorization must be declared true: no execution mode can bypass protocol authorization (INV-C07)",
    });
  }
  return violations;
}

/**
 * INV-C09 — external-funds observation semantics verification. Every
 * submitted observation must pass the connectors package's own validation
 * (mandatory freshness + provenance + the nominal observation brand). The
 * certification result records — by type — that these are observations,
 * never PaySwap custody.
 */
export function verifyExternalFundsObservation(
  observation: ExternalFundsPositionObservation,
): readonly ExternalFundsViolation[] {
  try {
    validateExternalFundsPositionObservation(observation);
    return [];
  } catch (error) {
    if (error instanceof ValidationError) {
      return [
        {
          observationId: observation.observationId,
          problem: error.message,
        },
      ];
    }
    throw error;
  }
}

/**
 * Runs the full connector certification over a real connectors registry:
 * the definition → implementation → instance → observation hierarchy for
 * every in-scope capability (chain sweep + per-capability coverage), the
 * connected-instance scope (INV-C05), provider-state preservation (INV-C06),
 * the execution-mode declarations (INV-C07) and the external-funds
 * observation semantics (INV-C09).
 *
 * Scope: `capabilityIds` restricts the sweep; when omitted, every registered
 * definition is certified.
 */
export function certifyConnector(input: {
  readonly registry: ConnectorRegistry;
  readonly capabilityIds?: readonly string[];
  readonly externalFundsObservations?: readonly ExternalFundsPositionObservation[];
}): ConnectorCertificationResult {
  if (input.registry === null || typeof input.registry !== "object") {
    throw new CertificationSuiteError("a connectors registry is required");
  }
  const registry = input.registry;
  const scope =
    input.capabilityIds !== undefined
      ? [...input.capabilityIds]
      : registry.allDefinitions().map((definition) => definition.capabilityId);
  if (scope.length === 0) {
    throw new CertificationSuiteError(
      "connector certification requires at least one capability in scope",
    );
  }

  // -- HIERARCHY_GATE: chain completeness + per-capability coverage ----------
  const gaps: string[] = [];
  const sweep = registry.validateChain();
  for (const gap of sweep.gaps) {
    gaps.push(`${gap.link}:${gap.ref} — ${gap.problem}`);
  }
  for (const capabilityId of scope) {
    const definition = registry.definition(capabilityId);
    if (definition === undefined) {
      gaps.push(`definition:${capabilityId} — no registered definition`);
      continue;
    }
    if (registry.allImplementations().every((impl) => impl.capabilityId !== capabilityId)) {
      gaps.push(`implementation:${capabilityId} — no registered implementation`);
    }
    const instances = registry.instancesForCapability(capabilityId);
    if (instances.length === 0) {
      gaps.push(`instance:${capabilityId} — no connected instance exposes this capability`);
    }
    for (const instance of instances) {
      if (registry.observationsFor(instance.instanceId).length === 0) {
        gaps.push(`observation:${instance.instanceId} — registered instance has no observations`);
      }
    }
  }

  // -- SCOPE_GATE (INV-C05) --------------------------------------------------
  const scopeViolations: ScopeViolation[] = [];
  const instances = scope.flatMap((capabilityId) =>
    registry.instancesForCapability(capabilityId),
  );
  for (const instance of instances) {
    scopeViolations.push(...verifyConnectedInstanceScope(instance));
  }

  // -- PROVIDER_STATE_GATE (INV-C06) + EXECUTION_MODE_GATE (INV-C07) ---------
  const providerStateViolations: ProviderStateViolation[] = [];
  const executionModeViolations: ExecutionModeViolation[] = [];
  for (const capabilityId of scope) {
    const definition = registry.definition(capabilityId);
    if (definition === undefined) {
      continue;
    }
    executionModeViolations.push(...verifyExecutionModesDeclaration(definition));
    for (const instance of registry.instancesForCapability(capabilityId)) {
      const latest = registry.latestObservationFor(instance.instanceId);
      if (latest === undefined) {
        continue;
      }
      if (latest.externalState !== undefined) {
        providerStateViolations.push(
          ...verifyProviderStatePreservation(latest.externalState),
        );
      } else if (definition.requiredCustomerActions.length > 0) {
        // The capability declares a customer-action surface: the observation
        // chain must preserve the lossless envelope to carry it (INV-C06).
        providerStateViolations.push({
          instanceId: instance.instanceId,
          problem: "latest observation carries no ProviderStateEnvelope although the capability declares required customer actions (INV-C06)",
        });
      }
    }
  }

  // -- EXTERNAL_FUNDS_GATE (INV-C09) -----------------------------------------
  const externalFundsViolations: ExternalFundsViolation[] = [];
  for (const observation of input.externalFundsObservations ?? []) {
    externalFundsViolations.push(...verifyExternalFundsObservation(observation));
  }

  const passed =
    gaps.length === 0 &&
    scopeViolations.length === 0 &&
    providerStateViolations.length === 0 &&
    executionModeViolations.length === 0 &&
    externalFundsViolations.length === 0;
  const certificationDigest = contentDigest({
    scope,
    gaps,
    scopeViolations,
    providerStateViolations,
    executionModeViolations,
    externalFundsViolations,
    passed,
  });
  return Object.freeze({
    passed,
    hierarchy: Object.freeze({ complete: gaps.length === 0, gaps: Object.freeze(gaps) }),
    scopeViolations: Object.freeze(scopeViolations),
    providerStateViolations: Object.freeze(providerStateViolations),
    executionModeViolations: Object.freeze(executionModeViolations),
    externalFundsViolations: Object.freeze(externalFundsViolations),
    externalFundsTreatedAsCustody: false,
    certificationDigest,
  });
}

// ---------------------------------------------------------------------------
// Suite gate results derived from a connector certification
// ---------------------------------------------------------------------------

/**
 * Converts a connector certification result into suite gate results: one
 * entry per connector gate id, mapped from the corresponding axis. Used to
 * feed `evaluateSuite` with the connector default suite.
 */
export function connectorSuiteGateResults(
  result: ConnectorCertificationResult,
): readonly SuiteGateResult[] {
  return [
    {
      gateId: "HIERARCHY_GATE",
      passed: result.hierarchy.complete,
      note: result.hierarchy.complete
        ? "definition → implementation → instance → observation chain complete"
        : result.hierarchy.gaps.join("; "),
    },
    {
      gateId: "SCOPE_GATE",
      passed: result.scopeViolations.length === 0,
      note: result.scopeViolations.map((v) => `${v.instanceId}: ${v.problem}`).join("; "),
    },
    {
      gateId: "PROVIDER_STATE_GATE",
      passed: result.providerStateViolations.length === 0,
      note: result.providerStateViolations
        .map((v) => `${v.instanceId}: ${v.problem}`)
        .join("; "),
    },
    {
      gateId: "EXECUTION_MODE_GATE",
      passed: result.executionModeViolations.length === 0,
      note: result.executionModeViolations
        .map((v) => `${v.capabilityId}: ${v.problem}`)
        .join("; "),
    },
    {
      gateId: "EXTERNAL_FUNDS_GATE",
      passed: result.externalFundsViolations.length === 0,
      note: result.externalFundsViolations
        .map((v) => `${v.observationId}: ${v.problem}`)
        .join("; "),
    },
  ];
}

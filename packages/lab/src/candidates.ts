/**
 * Lab candidate registry (W2-004; FROZEN-ARCHITECTURE §19; LAB.md
 * "Promotion"; INV-G03/G02).
 *
 * INV-G03 — an agent/Lab proposal NEVER mutates financial truth. A Lab
 * candidate is a PROPOSAL artifact:
 * - it composes certified smart-contract capabilities, ServiceAccess
 *   capabilities, connector capabilities and participation mechanisms into a
 *   candidate Organization DRAFT (pure data owned by @payswap/agents);
 * - the composed organization carries NO budgets and NO delegation edges:
 *   the Lab cannot grant spending authority, only the protocol authority
 *   path can (AGENTS.md rules 1/5);
 * - the registry exposes no API that accepts or produces a protocol
 *   command, authorization artifact or ledger write.
 *
 * INV-G02 discipline at the Lab level: a PUBLISHED candidate version is an
 * immutable, content-addressed snapshot. Changes require a new version;
 * history is never silently rewritten (AGENTS.md rule 8).
 */

import type {
  AgentBody,
  AgentInstance,
  AgentPrincipalRef,
  OrganizationDraft,
  VersionedRef,
} from "@payswap/agents";
import type { ExecutionMode } from "@payswap/connectors";
import { canonicalize, fnv1a64 } from "./simulation.js";
import type { SimulationProgram } from "./simulation.js";
import type { LabBuildingBlockKind } from "./domain-packs.js";

// ---------------------------------------------------------------------------
// Candidate shapes
// ---------------------------------------------------------------------------

/** Lab-side lifecycle before promotion takes over (promotion.ts owns SHADOW+). */
export const CANDIDATE_STAGES = ["DRAFT", "BENCHMARKED", "VALIDATED"] as const;
export type CandidateStage = (typeof CANDIDATE_STAGES)[number];

/** Reference to one building block composed into the candidate. */
export interface CandidateBuildingBlockRef {
  readonly blockKind: LabBuildingBlockKind;
  readonly blockId: string;
  readonly version: string;
}

/** Evidence attached to a candidate while it matures. */
export type CandidateEvidenceKind =
  | "BASELINE_SUITE_EVALUATION"
  | "REPLAY"
  | "COUNTERFACTUAL"
  | "ROBUSTNESS";

export interface CandidateEvidenceRef {
  readonly evidenceId: string;
  readonly kind: CandidateEvidenceKind;
  readonly artifactRef: string;
  readonly contentDigest: string;
}

export interface LabCandidate {
  readonly candidateId: string;
  readonly title: string;
  readonly domainPackId: string;
  readonly origin: string;
  readonly executionMode: ExecutionMode;
  readonly program: SimulationProgram;
  readonly buildingBlocks: readonly CandidateBuildingBlockRef[];
  /**
   * The composed candidate organization (a DRAFT — never released, never
   * budgeted, never delegated; INV-G03).
   */
  readonly organization: OrganizationDraft;
  readonly evidence: readonly CandidateEvidenceRef[];
  readonly stage: CandidateStage;
}

/** An immutable, content-addressed published candidate version. */
export interface PublishedCandidateVersion {
  readonly candidateId: string;
  readonly version: number;
  readonly snapshot: LabCandidate;
  readonly publishedAt: string;
  readonly contentDigest: string;
}

// ---------------------------------------------------------------------------
// Composition into candidate Organizations (INV-G03)
// ---------------------------------------------------------------------------

export const LAB_PROPOSAL_ONLY_CONSTRAINT =
  "LAB_COMPOSITION_IS_A_PROPOSAL_NOT_A_GRANT";

export interface ComposeCandidateOrganizationInput {
  readonly candidateId: string;
  readonly domainPackId: string;
  readonly body: VersionedRef<AgentBody>;
  readonly principal: AgentPrincipalRef;
  readonly domainHardConstraints: readonly string[];
  readonly buildingBlocks: readonly CandidateBuildingBlockRef[];
  readonly evaluationSuiteRef: string;
}

/**
 * Composes building blocks into a candidate Organization DRAFT.
 *
 * The draft is deliberately authority-free: no budgets (a Lab proposal
 * carries no spending authority), no delegation edges (no mandate is
 * granted), no communication edges, ephemeral isolated memory, and a
 * safety policy whose FIRST hard constraint is the proposal-only rule
 * (INV-G03). Releasing, budgeting or delegating happens exclusively on the
 * protocol authority path outside the Lab.
 */
export function composeCandidateOrganization(
  input: ComposeCandidateOrganizationInput,
): OrganizationDraft {
  const instance: AgentInstance = {
    id: `${input.candidateId}:instance-1`,
    bodyRef: input.body,
    principal: input.principal,
    runtimeState: { status: "IDLE" },
  };
  return {
    id: `org:${input.candidateId}`,
    version: 1,
    bodies: [input.body],
    instances: [instance],
    communicationEdges: [],
    delegationEdges: [],
    memory: { scope: "isolated", retention: "ephemeral" },
    budgets: [],
    evaluators: [{ evaluationSuiteRef: input.evaluationSuiteRef }],
    termination: {
      conditions: ["HARD_CONSTRAINT_VIOLATION", "EVALUATION_REGRESSION"],
      requiresHumanApproval: true,
    },
    safetyPolicy: {
      hardConstraints: [
        LAB_PROPOSAL_ONLY_CONSTRAINT,
        ...input.domainHardConstraints,
      ],
      escalationSurfaceRef: "protocol://financial-authority/escalation",
    },
  };
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/** Deep-freezes plain data (bigint-safe) so published snapshots are immutable. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    if (Object.isFrozen(value)) {
      return value;
    }
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

export class CandidateRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CandidateRegistryError";
  }
}

/**
 * The Lab candidate registry (LAB.md "Director — candidate registry").
 * Deterministic in-memory store: insertion order is preserved; published
 * versions are immutable snapshots.
 */
export class CandidateRegistry {
  private readonly candidates = new Map<string, LabCandidate>();
  private readonly published = new Map<string, PublishedCandidateVersion[]>();
  private nextVersion = new Map<string, number>();

  /** Creates a candidate draft composed from searchable building blocks. */
  createDraft(input: {
    candidateId: string;
    title: string;
    domainPackId: string;
    origin: string;
    executionMode: ExecutionMode;
    program: SimulationProgram;
    buildingBlocks: readonly CandidateBuildingBlockRef[];
    body: VersionedRef<AgentBody>;
    principal: AgentPrincipalRef;
    domainHardConstraints: readonly string[];
    evaluationSuiteRef: string;
  }): LabCandidate {
    if (input.candidateId.length === 0) {
      throw new CandidateRegistryError("candidateId must not be empty");
    }
    if (this.candidates.has(input.candidateId)) {
      throw new CandidateRegistryError(
        `candidate '${input.candidateId}' already exists`,
      );
    }
    const organization = composeCandidateOrganization({
      candidateId: input.candidateId,
      domainPackId: input.domainPackId,
      body: input.body,
      principal: input.principal,
      domainHardConstraints: input.domainHardConstraints,
      buildingBlocks: input.buildingBlocks,
      evaluationSuiteRef: input.evaluationSuiteRef,
    });
    const candidate: LabCandidate = {
      candidateId: input.candidateId,
      title: input.title,
      domainPackId: input.domainPackId,
      origin: input.origin,
      executionMode: input.executionMode,
      program: input.program,
      buildingBlocks: [...input.buildingBlocks],
      organization,
      evidence: [],
      stage: "DRAFT",
    };
    this.candidates.set(input.candidateId, candidate);
    return candidate;
  }

  get(candidateId: string): LabCandidate | undefined {
    return this.candidates.get(candidateId);
  }

  /** Deterministic listing (creation order). */
  list(): readonly LabCandidate[] {
    return [...this.candidates.values()];
  }

  /**
   * Attaches evidence. BASELINE_SUITE_EVALUATION moves DRAFT → BENCHMARKED;
   * the full INV-L02 triple (REPLAY + COUNTERFACTUAL + ROBUSTNESS) moves
   * BENCHMARKED → VALIDATED.
   */
  attachEvidence(input: {
    candidateId: string;
    evidence: readonly CandidateEvidenceRef[];
  }): LabCandidate {
    const candidate = this.candidates.get(input.candidateId);
    if (candidate === undefined) {
      throw new CandidateRegistryError(
        `unknown candidate '${input.candidateId}'`,
      );
    }
    const merged = [...candidate.evidence, ...input.evidence];
    const kinds = new Set(merged.map((ref) => ref.kind));
    let stage: CandidateStage = candidate.stage;
    if (stage === "DRAFT" && kinds.has("BASELINE_SUITE_EVALUATION")) {
      stage = "BENCHMARKED";
    }
    if (
      stage === "BENCHMARKED" &&
      kinds.has("REPLAY") &&
      kinds.has("COUNTERFACTUAL") &&
      kinds.has("ROBUSTNESS")
    ) {
      stage = "VALIDATED";
    }
    const updated: LabCandidate = { ...candidate, evidence: merged, stage };
    this.candidates.set(input.candidateId, updated);
    return updated;
  }

  /**
   * Publishes an immutable, content-addressed version snapshot. Published
   * versions can never be modified afterwards (INV-G02 discipline); further
   * changes require publishing a NEW version.
   */
  publishVersion(input: {
    candidateId: string;
    publishedAt: string;
  }): PublishedCandidateVersion {
    const candidate = this.candidates.get(input.candidateId);
    if (candidate === undefined) {
      throw new CandidateRegistryError(
        `unknown candidate '${input.candidateId}'`,
      );
    }
    const version = (this.nextVersion.get(input.candidateId) ?? 0) + 1;
    this.nextVersion.set(input.candidateId, version);
    const contentDigest = fnv1a64(
      canonicalize({
        candidateId: candidate.candidateId,
        version,
        candidate,
      }),
    );
    const published: PublishedCandidateVersion = deepFreeze({
      candidateId: candidate.candidateId,
      version,
      snapshot: deepFreeze(candidate),
      publishedAt: input.publishedAt,
      contentDigest,
    });
    const existing = this.published.get(input.candidateId) ?? [];
    this.published.set(input.candidateId, [...existing, published]);
    return published;
  }

  listPublishedVersions(candidateId: string): readonly PublishedCandidateVersion[] {
    return [...(this.published.get(candidateId) ?? [])];
  }

  getPublishedVersion(
    candidateId: string,
    version: number,
  ): PublishedCandidateVersion | undefined {
    return (this.published.get(candidateId) ?? []).find(
      (published) => published.version === version,
    );
  }
}

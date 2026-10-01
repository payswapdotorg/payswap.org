/**
 * Expert qualification, matching and Arena-compatible resolution records
 * (W2-005; FROZEN-ARCHITECTURE §18 "Human fallback"; LAB.md "Arena bridge";
 * INV-L04).
 *
 * The §18 flow this module implements:
 *   CapabilityCase → requirements → qualified match → ExpertTask →
 *   ExpertResolution version → protocol decision/evidence → learning.
 *
 * INV-L04 — expert resolutions are VERSIONED and historical versions remain
 * for learning. `ExpertResolutionLedger` keeps one resolution chain per task;
 * superseding appends version N+1 and NEVER removes version N (LAB.md
 * "Production learning": later better resolutions COEXIST with historical
 * versions; never rewrite a historical record to make a later candidate look
 * better).
 *
 * EVIDENCE, NEVER HIDDEN AUTHORITY (LAB.md "Arena bridge": "Expert output
 * becomes evidence and a learning artifact, not a hidden protocol override";
 * AGENTS.md rules 1/5/11):
 * - an ExpertResolution carries findings, a recommendation and evidence refs
 *   ONLY — there is no mandate, grant, approval, epoch authorization or
 *   ledger write anywhere in its shape;
 * - the ONLY consumable form of an expert resolution is
 *   `resolutionToEvidenceArtifact`, which produces a branded
 *   ResolutionEvidenceArtifact (a typed protocol §24 Expert-family EVIDENCE
 *   token input, an immutable content-addressed learning artifact);
 * - the module exposes no API that turns a resolution into an authorization,
 *   a trust mutation or a financial effect. Any protocol decision built on
 *   expert output happens on the protocol authority path, outside this
 *   package, with the artifact as evidence.
 *
 * Arena compatibility: resolution records follow the same versioning
 * discipline as the Lab's immutable published candidate versions /
 * promotion orders (versioned, content-addressed, append-only history). The
 * Lab package itself is NOT imported (its boundary test forbids any other
 * package's src importing it); compatibility is structural.
 *
 * Deterministic only: no ambient clock, no randomness; expert ordering is a
 * total deterministic order.
 */

import type { CapabilityCase } from "./capability-cases.js";
import type { EvidenceRef } from "./quarantine.js";
import { contentDigest } from "./signatures.js";

// ---------------------------------------------------------------------------
// Qualification contracts
// ---------------------------------------------------------------------------

/** Ordered expertise levels (index order = strength order). */
export const EXPERT_LEVELS = ["practitioner", "expert", "senior"] as const;
export type ExpertLevel = (typeof EXPERT_LEVELS)[number];

export function isExpertLevel(value: unknown): value is ExpertLevel {
  return (
    typeof value === "string" &&
    (EXPERT_LEVELS as readonly unknown[]).includes(value)
  );
}

function levelRank(level: ExpertLevel): number {
  return EXPERT_LEVELS.indexOf(level);
}

/**
 * One qualification an expert holds. A qualification is itself evidence
 * (certification artifact) — an expert without qualification provenance is
 * not qualified, whatever they claim (AGENTS.md: no unrecorded authority).
 */
export interface ExpertQualification {
  readonly skillId: string;
  readonly level: ExpertLevel;
  readonly qualificationEvidence: EvidenceRef;
}

/** A registered expert (Tier 5 human fallback, FROZEN-ARCHITECTURE §25). */
export interface ExpertProfile {
  readonly expertId: string;
  readonly displayName: string;
  readonly qualifications: readonly ExpertQualification[];
  /** Jurisdictions the expert may serve (ISO-3166 alpha-2 style codes). */
  readonly jurisdictions: readonly string[];
  /** An inactive expert never matches. */
  readonly active: boolean;
}

/** One requirement the Arena bridge demands from a resolving expert. */
export interface ExpertRequirement {
  readonly skillId: string;
  readonly minLevel: ExpertLevel;
  /** When set, the expert must serve this jurisdiction. */
  readonly jurisdiction?: string;
}

/** Raised for invalid expert-bridge operations. */
export class ExpertBridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExpertBridgeError";
  }
}

// ---------------------------------------------------------------------------
// Deterministic matching (§18: requirements → qualified match)
// ---------------------------------------------------------------------------

/** The deterministic match of one expert against a requirement set. */
export interface ExpertMatch {
  readonly expertId: string;
  readonly qualified: boolean;
  /** Skill requirements satisfied (skillId + the level that satisfied it). */
  readonly satisfied: readonly { readonly skillId: string; readonly viaLevel: ExpertLevel }[];
  /** Unmet requirements, in requirement order, with the deterministic reason. */
  readonly unmet: readonly {
    readonly skillId: string;
    readonly reason:
      | "skill_missing"
      | "level_insufficient"
      | "jurisdiction_not_served"
      | "expert_inactive";
  }[];
}

function satisfiesRequirement(
  qualification: ExpertQualification,
  requirement: ExpertRequirement,
): boolean {
  return (
    qualification.skillId === requirement.skillId &&
    levelRank(qualification.level) >= levelRank(requirement.minLevel)
  );
}

/**
 * Match one expert against the requirements. Qualified iff ACTIVE, every
 * skill is held at >= minLevel, and every jurisdiction requirement is
 * served. Fail-closed: missing skill, insufficient level, unserved
 * jurisdiction and inactive experts are all unqualified.
 */
export function matchExpert(
  expert: ExpertProfile,
  requirements: readonly ExpertRequirement[],
): ExpertMatch {
  const satisfied: { skillId: string; viaLevel: ExpertLevel }[] = [];
  const unmet: {
    skillId: string;
    reason:
      | "skill_missing"
      | "level_insufficient"
      | "jurisdiction_not_served"
      | "expert_inactive";
  }[] = [];
  if (!expert.active) {
    for (const requirement of requirements) {
      unmet.push({ skillId: requirement.skillId, reason: "expert_inactive" });
    }
    return { expertId: expert.expertId, qualified: false, satisfied, unmet };
  }
  for (const requirement of requirements) {
    if (
      requirement.jurisdiction !== undefined &&
      !expert.jurisdictions.includes(requirement.jurisdiction)
    ) {
      unmet.push({
        skillId: requirement.skillId,
        reason: "jurisdiction_not_served",
      });
      continue;
    }
    let best: ExpertQualification | undefined;
    for (const qualification of expert.qualifications) {
      if (qualification.skillId !== requirement.skillId) {
        continue;
      }
      if (
        best === undefined ||
        levelRank(qualification.level) > levelRank(best.level)
      ) {
        best = qualification;
      }
    }
    if (best === undefined) {
      unmet.push({ skillId: requirement.skillId, reason: "skill_missing" });
      continue;
    }
    if (levelRank(best.level) < levelRank(requirement.minLevel)) {
      unmet.push({ skillId: requirement.skillId, reason: "level_insufficient" });
      continue;
    }
    satisfied.push({ skillId: requirement.skillId, viaLevel: best.level });
  }
  return {
    expertId: expert.expertId,
    qualified: unmet.length === 0,
    satisfied,
    unmet,
  };
}

/**
 * Match every expert against the requirements. Deterministic order:
 * qualified experts first; within each class, by (satisfied count DESC,
 * expertId ASC) — a total order with no ties.
 */
export function matchExperts(
  experts: readonly ExpertProfile[],
  requirements: readonly ExpertRequirement[],
): readonly ExpertMatch[] {
  const matches = experts.map((expert) => matchExpert(expert, requirements));
  return Object.freeze(
    matches.sort((left, right) => {
      const leftQualified = left.qualified ? 1 : 0;
      const rightQualified = right.qualified ? 1 : 0;
      if (leftQualified !== rightQualified) {
        return rightQualified - leftQualified;
      }
      if (left.satisfied.length !== right.satisfied.length) {
        return right.satisfied.length - left.satisfied.length;
      }
      return left.expertId < right.expertId
        ? -1
        : left.expertId > right.expertId
          ? 1
          : 0;
    }),
  );
}

// ---------------------------------------------------------------------------
// Expert tasks (§18: qualified match → ExpertTask)
// ---------------------------------------------------------------------------

export type ExpertTaskStatus = "dispatched" | "resolved";

/**
 * One dispatched expert task: a capability case handed to the
 * deterministically-selected qualified expert under explicit requirements.
 */
export interface ExpertTask {
  readonly taskId: string;
  readonly caseId: string;
  readonly component: { readonly kind: string; readonly id: string };
  readonly requirements: readonly ExpertRequirement[];
  readonly matchedExpertId: string;
  readonly dispatchedAt: number;
  readonly status: ExpertTaskStatus;
}

/**
 * The expert task board (Arena dispatch). Deterministic: the dispatched
 * expert is always the first qualified match in `matchExperts` order.
 */
export class ExpertTaskBoard {
  private readonly tasksById = new Map<string, ExpertTask>();
  private readonly order: string[] = [];

  /**
   * Dispatches a task for a capability case. Throws ExpertBridgeError when
   * no active expert satisfies the requirements — the Arena bridge fails
   * closed instead of dispatching to an unqualified expert (a resolution
   * from an unqualified expert would be evidence with no provenance).
   */
  dispatch(input: {
    taskId: string;
    case: CapabilityCase;
    requirements: readonly ExpertRequirement[];
    experts: readonly ExpertProfile[];
    at: number;
  }): ExpertTask {
    if (input.taskId.length === 0) {
      throw new ExpertBridgeError("taskId must not be empty");
    }
    if (input.requirements.length === 0) {
      throw new ExpertBridgeError(
        "a dispatched task requires at least one qualification requirement",
      );
    }
    for (const requirement of input.requirements) {
      if (requirement.skillId.length === 0) {
        throw new ExpertBridgeError("requirement skillId must not be empty");
      }
      if (!isExpertLevel(requirement.minLevel)) {
        throw new ExpertBridgeError(
          `unknown expert level '${String(requirement.minLevel)}'`,
        );
      }
    }
    if (this.tasksById.has(input.taskId)) {
      throw new ExpertBridgeError(`task '${input.taskId}' already exists`);
    }
    const ranked = matchExperts(input.experts, input.requirements);
    const first = ranked[0];
    if (first === undefined || !first.qualified) {
      throw new ExpertBridgeError(
        `no qualified expert for task '${input.taskId}' (${input.requirements
          .map((requirement) => `${requirement.skillId}>=${requirement.minLevel}`)
          .join(", ")}); the Arena bridge does not dispatch to unqualified experts`,
      );
    }
    const task: ExpertTask = Object.freeze({
      taskId: input.taskId,
      caseId: input.case.caseId,
      component: Object.freeze({
        kind: input.case.component.kind,
        id: input.case.component.id,
      }),
      requirements: Object.freeze([...input.requirements]),
      matchedExpertId: first.expertId,
      dispatchedAt: input.at,
      status: "dispatched",
    });
    this.tasksById.set(input.taskId, task);
    this.order.push(input.taskId);
    return task;
  }

  byId(taskId: string): ExpertTask | undefined {
    return this.tasksById.get(taskId);
  }

  /** All tasks in dispatch order. */
  list(): readonly ExpertTask[] {
    return this.order.map((id) => this.tasksById.get(id) as ExpertTask);
  }
}

// ---------------------------------------------------------------------------
// Versioned resolutions (§18: ExpertResolution version; INV-L04)
// ---------------------------------------------------------------------------

/**
 * One version of an expert resolution for one task. Versions are immutable;
 * superseding creates version N+1 and the historical versions remain
 * retrievable forever (INV-L04).
 *
 * The shape is EVIDENCE-ONLY: findings, a recommendation and evidence refs.
 * There is deliberately no authorization, mandate, grant, approval, epoch or
 * financial field anywhere in this contract.
 */
export interface ExpertResolution {
  /** Stable across versions of the same task. */
  readonly resolutionId: string;
  readonly taskId: string;
  readonly caseId: string;
  readonly expertId: string;
  /** 1-based version; increments on supersession. */
  readonly version: number;
  readonly findings: readonly string[];
  readonly recommendation: string;
  readonly evidence: readonly EvidenceRef[];
  readonly resolvedAt: number;
  readonly contentDigest: string;
  /** Set on historical versions when superseded (never on the current one). */
  readonly supersededBy?: number;
}

/** Raised for invalid resolution operations. */
export class ExpertResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExpertResolutionError";
  }
}

function validateEvidence(evidence: readonly EvidenceRef[]): void {
  for (const ref of evidence) {
    if (
      ref.evidenceId.length === 0 ||
      ref.artifactRef.length === 0 ||
      ref.contentDigest.length === 0
    ) {
      throw new ExpertResolutionError("resolution evidence refs must be complete");
    }
  }
}

/**
 * The expert resolution ledger: versioned, append-only, immutable history.
 * One resolution chain per task; `recordResolution` opens the chain at
 * version 1 and `recordSupersedingResolution` appends the next version.
 * Historical versions are never removed or edited (INV-L04).
 */
export class ExpertResolutionLedger {
  private readonly chains = new Map<string, ExpertResolution[]>();

  /**
   * Records the FIRST resolution version for a dispatched task. The expert
   * must be the one the task was dispatched to (provenance: the resolution
   * names who produced it).
   */
  recordResolution(input: {
    task: ExpertTask;
    expertId: string;
    findings: readonly string[];
    recommendation: string;
    evidence: readonly EvidenceRef[];
    resolvedAt: number;
  }): ExpertResolution {
    if (this.chains.has(input.task.taskId)) {
      throw new ExpertResolutionError(
        `task '${input.task.taskId}' already has a resolution; use recordSupersedingResolution to append a new version`,
      );
    }
    if (input.expertId !== input.task.matchedExpertId) {
      throw new ExpertResolutionError(
        `resolution for task '${input.task.taskId}' must come from the dispatched expert '${input.task.matchedExpertId}', not '${input.expertId}'`,
      );
    }
    return this.append(input.task, input);
  }

  /**
   * INV-L04 — appends the NEXT version for a task that already has a
   * resolution. The previous version stays in the chain (marked superseded)
   * and remains fully retrievable for learning.
   */
  recordSupersedingResolution(input: {
    task: ExpertTask;
    expertId: string;
    findings: readonly string[];
    recommendation: string;
    evidence: readonly EvidenceRef[];
    resolvedAt: number;
  }): ExpertResolution {
    const chain = this.chains.get(input.task.taskId);
    if (chain === undefined) {
      throw new ExpertResolutionError(
        `task '${input.task.taskId}' has no resolution to supersede; use recordResolution first`,
      );
    }
    if (input.expertId !== input.task.matchedExpertId) {
      throw new ExpertResolutionError(
        `resolution for task '${input.task.taskId}' must come from the dispatched expert '${input.task.matchedExpertId}', not '${input.expertId}'`,
      );
    }
    const latest = chain[chain.length - 1];
    if (latest === undefined || input.resolvedAt < latest.resolvedAt) {
      throw new ExpertResolutionError(
        `superseding resolution at ${input.resolvedAt} cannot precede version ${latest?.version ?? 0} resolved at ${latest?.resolvedAt ?? 0}`,
      );
    }
    return this.append(input.task, input);
  }

  private append(
    task: ExpertTask,
    input: {
      expertId: string;
      findings: readonly string[];
      recommendation: string;
      evidence: readonly EvidenceRef[];
      resolvedAt: number;
    },
  ): ExpertResolution {
    if (input.recommendation.length === 0) {
      throw new ExpertResolutionError("recommendation must not be empty");
    }
    if (input.evidence.length === 0) {
      throw new ExpertResolutionError(
        "an expert resolution requires at least one evidence ref (expert output without evidence is not evidence)",
      );
    }
    validateEvidence(input.evidence);
    const chain = this.chains.get(task.taskId) ?? [];
    const version = chain.length + 1;
    const resolutionId = `expert-resolution:${task.taskId}`;
    const resolution: ExpertResolution = Object.freeze({
      resolutionId,
      taskId: task.taskId,
      caseId: task.caseId,
      expertId: input.expertId,
      version,
      findings: Object.freeze([...input.findings]),
      recommendation: input.recommendation,
      evidence: Object.freeze([...input.evidence]),
      resolvedAt: input.resolvedAt,
      contentDigest: contentDigest({
        resolutionId,
        taskId: task.taskId,
        caseId: task.caseId,
        expertId: input.expertId,
        version,
        findings: input.findings,
        recommendation: input.recommendation,
        evidence: input.evidence,
        resolvedAt: input.resolvedAt,
      }),
    });
    if (chain.length > 0) {
      const previous = chain[chain.length - 1];
      if (previous !== undefined) {
        const superseded: ExpertResolution = Object.freeze({
          ...previous,
          supersededBy: version,
        });
        chain[chain.length - 1] = superseded;
      }
    }
    chain.push(resolution);
    this.chains.set(task.taskId, chain);
    return resolution;
  }

  /** Current (latest) resolution version for a task, when one exists. */
  currentForTask(taskId: string): ExpertResolution | undefined {
    const chain = this.chains.get(taskId);
    return chain === undefined || chain.length === 0
      ? undefined
      : chain[chain.length - 1];
  }

  /**
   * INV-L04 — the FULL version history for a task, version order, historical
   * versions included and marked superseded.
   */
  versionHistoryForTask(taskId: string): readonly ExpertResolution[] {
    return [...(this.chains.get(taskId) ?? [])];
  }

  /** All resolution chains, insertion order of tasks. */
  listTaskIds(): readonly string[] {
    return [...this.chains.keys()];
  }
}

// ---------------------------------------------------------------------------
// Evidence artifacts — the ONLY consumable form of expert output
// ---------------------------------------------------------------------------

/**
 * Namespace brand of expert evidence artifacts: a typed §24 Expert-family
 * EVIDENCE token input. Exists at the type level so a
 * ResolutionEvidenceArtifact is structurally distinct from every
 * authorization / trust / financial artifact and can never be assigned where
 * authority is demanded.
 */
export const EXPERT_EVIDENCE_NAMESPACE = "PAYSWAP_EXPERT_EVIDENCE" as const;
export interface ExpertEvidenceNamespaceBrand {
  readonly __payswapExpertEvidence: typeof EXPERT_EVIDENCE_NAMESPACE;
}

/**
 * The immutable evidence/learning artifact produced from an expert
 * resolution. This is what the protocol side (and the Arena/Lab learning
 * pipeline) consumes: evidence + findings + recommendation, content-
 * addressed and versioned. It is NOT authority: any protocol decision that
 * builds on it must travel the protocol authorization path, which re-checks
 * policy, compliance and security (INV-A05: suggestions cannot override
 * constraints).
 */
export interface ResolutionEvidenceArtifact extends ExpertEvidenceNamespaceBrand {
  readonly artifactId: string;
  readonly resolutionId: string;
  readonly version: number;
  readonly taskId: string;
  readonly caseId: string;
  readonly expertId: string;
  readonly findings: readonly string[];
  readonly recommendation: string;
  readonly evidence: readonly EvidenceRef[];
  readonly producedAt: number;
  readonly contentDigest: string;
  readonly namespace: typeof EXPERT_EVIDENCE_NAMESPACE;
}

/**
 * Converts a resolution into its evidence artifact — the ONLY conversion
 * this package offers for expert output. There is intentionally no
 * conversion to any authorization, trust or financial type.
 */
export function resolutionToEvidenceArtifact(
  resolution: ExpertResolution,
): ResolutionEvidenceArtifact {
  return Object.freeze({
    __payswapExpertEvidence: EXPERT_EVIDENCE_NAMESPACE,
    artifactId: `expert-evidence:${resolution.taskId}:v${resolution.version}`,
    resolutionId: resolution.resolutionId,
    version: resolution.version,
    taskId: resolution.taskId,
    caseId: resolution.caseId,
    expertId: resolution.expertId,
    findings: resolution.findings,
    recommendation: resolution.recommendation,
    evidence: resolution.evidence,
    producedAt: resolution.resolvedAt,
    contentDigest: resolution.contentDigest,
    namespace: EXPERT_EVIDENCE_NAMESPACE,
  });
}

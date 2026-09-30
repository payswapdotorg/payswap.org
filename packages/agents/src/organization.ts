import { contentDigest } from "./canonical.js";
import type { AmountSpec } from "./amount.js";
import type { AgentInstance } from "./instance.js";
import type { VersionedRef } from "./instance.js";
import type { AgentBody } from "./body.js";
import type { MandateRef } from "@payswap/trust";

/**
 * Organization contracts (FROZEN-ARCHITECTURE §7, INV-G02).
 *
 * An Organization is a versioned graph of Bodies/Instances with communication
 * edges, delegation edges, memory, budgets, evaluators, termination and safety
 * policy. Releasing a version freezes a content hash; released versions are
 * IMMUTABLE — history is never silently rewritten (AGENTS.md rule 8).
 */

/**
 * Budget amounts use the exact AmountSpec consolidated onto @payswap/trust
 * (whose exact arithmetic is backed by @payswap/protocol) (INV-F01).
 */

export interface OrganizationBudget {
  readonly budgetId: string;
  readonly scope: string;
  readonly amount: AmountSpec;
}

export interface CommunicationEdge {
  readonly fromInstanceId: string;
  readonly toInstanceId: string;
  readonly channel: string;
}

/**
 * Reference to the mandate that authorizes one delegation edge. Full mandate
 * semantics live in the trust domain.
 *
 * W2-002 CONSOLIDATION: this is the @payswap/trust MandateRef; the alias keeps
 * the Stage-0 @payswap/agents export name.
 */
export type DelegationMandateRef = MandateRef;

export interface DelegationEdge {
  readonly fromInstanceId: string;
  readonly toInstanceId: string;
  readonly mandateRef: DelegationMandateRef;
}

export interface OrganizationMemoryPolicy {
  readonly scope: "shared" | "isolated";
  readonly retention: "ephemeral" | "session" | "persistent";
}

export interface EvaluatorRef {
  readonly evaluationSuiteRef: string;
}

export interface TerminationPolicy {
  readonly conditions: readonly string[];
  readonly requiresHumanApproval: boolean;
}

export interface SafetyPolicy {
  readonly hardConstraints: readonly string[];
  readonly escalationSurfaceRef: string;
}

/** A mutable, not-yet-released organization version. */
export interface OrganizationDraft {
  readonly id: string;
  readonly version: number;
  readonly bodies: readonly VersionedRef<AgentBody>[];
  readonly instances: readonly AgentInstance[];
  readonly communicationEdges: readonly CommunicationEdge[];
  readonly delegationEdges: readonly DelegationEdge[];
  readonly memory: OrganizationMemoryPolicy;
  readonly budgets: readonly OrganizationBudget[];
  readonly evaluators: readonly EvaluatorRef[];
  readonly termination: TerminationPolicy;
  readonly safetyPolicy: SafetyPolicy;
}

export interface OrganizationRelease {
  readonly releasedAt: number;
  readonly contentHash: string;
}

/** A released organization version: immutable and content-addressed (INV-G02). */
export interface ReleasedOrganization extends OrganizationDraft {
  readonly release: OrganizationRelease;
}

/** Raised when a draft violates organization graph invariants. */
export class OrganizationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrganizationValidationError";
  }
}

/** Raised on any mutation attempt against a released organization (INV-G02). */
export class ReleasedOrganizationImmutableError extends Error {
  constructor(orgId: string, version: number) {
    super(
      `Organization ${orgId}@${version} is released and immutable: create a new version instead`,
    );
    this.name = "ReleasedOrganizationImmutableError";
  }
}

export function isReleased(
  org: OrganizationDraft | ReleasedOrganization,
): org is ReleasedOrganization {
  return (
    typeof (org as ReleasedOrganization).release === "object" &&
    (org as ReleasedOrganization).release !== null
  );
}

function validateDraft(draft: OrganizationDraft): void {
  if (draft.id.length === 0) {
    throw new OrganizationValidationError("organization id must not be empty");
  }
  if (draft.version < 1) {
    throw new OrganizationValidationError("organization version must be >= 1");
  }
  const instanceIds = new Set<string>();
  for (const instance of draft.instances) {
    if (instanceIds.has(instance.id)) {
      throw new OrganizationValidationError(`duplicate instance id '${instance.id}'`);
    }
    instanceIds.add(instance.id);
  }
  const bodyIds = new Set(draft.bodies.map((body) => body.id));
  for (const instance of draft.instances) {
    if (!bodyIds.has(instance.bodyRef.id)) {
      throw new OrganizationValidationError(
        `instance '${instance.id}' references unknown body '${instance.bodyRef.id}'`,
      );
    }
  }
  for (const edge of draft.communicationEdges) {
    if (!instanceIds.has(edge.fromInstanceId) || !instanceIds.has(edge.toInstanceId)) {
      throw new OrganizationValidationError(
        `communication edge ${edge.fromInstanceId} -> ${edge.toInstanceId} references an unknown instance`,
      );
    }
  }
  for (const edge of draft.delegationEdges) {
    if (!instanceIds.has(edge.fromInstanceId) || !instanceIds.has(edge.toInstanceId)) {
      throw new OrganizationValidationError(
        `delegation edge ${edge.fromInstanceId} -> ${edge.toInstanceId} references an unknown instance`,
      );
    }
  }
}

function deepFreeze(value: object): void {
  if (Object.isFrozen(value)) {
    return;
  }
  Object.freeze(value);
  for (const key of Object.keys(value)) {
    const child = (value as Readonly<Record<string, unknown>>)[key];
    if (child !== null && typeof child === "object") {
      deepFreeze(child);
    }
  }
}

function deepClone<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => deepClone(item)) as unknown as T;
  }
  const source = value as Readonly<Record<string, unknown>>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    result[key] = deepClone(source[key]);
  }
  return result as T;
}

/**
 * Release a draft: validates the graph, computes the content hash over the
 * canonical serialization, attaches the release record and deep-freezes the
 * result. Released versions are immutable (INV-G02).
 */
export function releaseOrganization(
  draft: OrganizationDraft,
  releasedAt: number,
): ReleasedOrganization {
  if (isReleased(draft)) {
    throw new ReleasedOrganizationImmutableError(draft.id, draft.version);
  }
  validateDraft(draft);
  const contentHash = contentDigest(draft);
  const released: ReleasedOrganization = {
    ...deepClone(draft),
    release: { releasedAt, contentHash },
  };
  deepFreeze(released);
  return released;
}

/**
 * Amend an organization. Released organizations are immutable: amending one
 * throws ReleasedOrganizationImmutableError. Drafts are amended by producing
 * a new draft object via the mutator; the target itself is not mutated.
 */
export function amendOrganization(
  target: OrganizationDraft | ReleasedOrganization,
  mutator: (draft: OrganizationDraft) => OrganizationDraft,
): OrganizationDraft {
  if (isReleased(target)) {
    throw new ReleasedOrganizationImmutableError(target.id, target.version);
  }
  return mutator(deepClone(target));
}

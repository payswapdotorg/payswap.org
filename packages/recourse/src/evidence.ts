/**
 * @payswap/recourse — dispute and recourse evidence (W1-006).
 *
 * Dispute/recourse evidence ATTACHES to the settlement evidence graph
 * (consumed from @payswap/settlement — this package never redefines the
 * evidence vocabulary):
 *
 * - INV-E01/E02: full lineage queryable — a dispute's evidence nodes record
 *   under the dispute's own actionRef and LINK to the original transaction's
 *   evidence nodes, so `chainOf`/`lineageForAction` walk the complete chain
 *   from adjudication back to the original authorization/execution/outcome
 *   evidence.
 * - INV-E05: historical evidence is immutable — enforced by the consumed
 *   EvidenceGraph (`EvidenceMutationError` on any content difference;
 *   identical re-record is an idempotent replay).
 * - INV-E04: provenance caps — `maxEffectiveEvidenceLevel` consumes the
 *   settlement proof-policies capping so a UI/browser artifact never proves
 *   more than its authenticated provenance, no matter what it claims.
 *
 * This module only mints dispute/recourse-flavoured nodes through the
 * settlement graph's own `record` path and derives deterministic lineage
 * queries on top of it.
 */

import { ValidationError } from '@payswap/protocol';
import type { PaySwapErrorDetails, IdFactory, TimestampMs } from '@payswap/protocol';
import { effectiveEvidenceLevel } from '@payswap/settlement';
import type {
  ActionEvidenceLineage,
  EvidenceGraph,
  EvidenceNode,
  EvidenceNodeDraft,
  EvidenceNodeKind,
  EvidenceProvenance,
  ProofLevel,
} from '@payswap/settlement';

/** Evidence node ids minted for dispute/recourse records. */
export const DISPUTE_EVIDENCE_PREFIX = 'rev' as const;

const EVIDENCE_KINDS: readonly EvidenceNodeKind[] = [
  'AUTHORIZATION',
  'EXECUTION',
  'OUTCOME',
  'RECONCILIATION',
  'PROOF',
  'RECEIPT',
];

/** A presented evidence node does not exist in the settlement evidence graph. */
export class UnknownDisputeEvidenceError extends ValidationError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super(message, details);
    this.name = 'UnknownDisputeEvidenceError';
  }
}

/** Draft for one dispute/recourse evidence node. */
export interface DisputeEvidenceDraft {
  /** The dispute (or recourse artifact) this evidence belongs to. */
  readonly actionRef: string;
  readonly kind: EvidenceNodeKind;
  readonly claimedLevel: ProofLevel;
  readonly provenance: EvidenceProvenance;
  /** Opaque artifact payload; the graph stores only its deterministic hash. */
  readonly payload: string;
  /**
   * Parent node ids — typically the original transaction's evidence nodes,
   * which is what makes the full lineage queryable (INV-E01/E02).
   */
  readonly links: readonly string[];
  readonly recordedAt: TimestampMs;
}

/**
 * Record one dispute/recourse evidence node into the SETTLEMENT evidence
 * graph (append-only, INV-E05). The node id is minted deterministically from
 * the injected id factory. Returns the frozen node.
 */
export function recordDisputeEvidence(
  graph: EvidenceGraph,
  draft: DisputeEvidenceDraft,
  deps: { readonly ids: IdFactory },
): EvidenceNode {
  if (graph === null || typeof graph !== 'object') {
    throw new ValidationError('graph must be a settlement EvidenceGraph');
  }
  if (draft === null || typeof draft !== 'object') {
    throw new ValidationError('draft must be a DisputeEvidenceDraft object');
  }
  if (typeof draft.actionRef !== 'string' || draft.actionRef.length === 0) {
    throw new ValidationError('draft.actionRef must be a non-empty string');
  }
  if (!EVIDENCE_KINDS.includes(draft.kind)) {
    throw new ValidationError(`draft.kind is not a declared evidence kind: ${String(draft.kind)}`);
  }
  const nodeDraft: EvidenceNodeDraft = {
    nodeId: deps.ids.mintId(DISPUTE_EVIDENCE_PREFIX),
    kind: draft.kind,
    actionRef: draft.actionRef,
    claimedLevel: draft.claimedLevel,
    provenance: draft.provenance,
    payload: draft.payload,
    links: draft.links,
    recordedAt: draft.recordedAt,
  };
  return graph.record(nodeDraft);
}

/**
 * Resolve evidence refs against the settlement evidence graph. Every ref must
 * exist (fail closed) — a dispute cannot cite evidence that was never
 * recorded. Returns the frozen nodes in ref order.
 */
export function resolveEvidenceRefs(
  graph: EvidenceGraph,
  evidenceRefs: readonly string[],
): readonly EvidenceNode[] {
  if (!Array.isArray(evidenceRefs)) {
    throw new ValidationError('evidenceRefs must be an array of node ids');
  }
  const nodes: EvidenceNode[] = [];
  for (const ref of evidenceRefs) {
    if (typeof ref !== 'string' || ref.length === 0) {
      throw new ValidationError('evidence refs must be non-empty node ids');
    }
    const node = graph.node(ref);
    if (node === undefined) {
      throw new UnknownDisputeEvidenceError(
        `cited evidence node '${ref}' does not exist in the settlement evidence graph`,
        { evidenceRef: ref },
      );
    }
    nodes.push(node);
  }
  return Object.freeze(nodes);
}

/**
 * The full evidence lineage of one dispute/recourse action (INV-E01/E02).
 * Delegates to the settlement graph's `lineageForAction` — authorization,
 * execution, outcome, reconciliation, proof and receipt chains, separately
 * queryable at any time.
 */
export function disputeEvidenceLineage(
  graph: EvidenceGraph,
  actionRef: string,
): ActionEvidenceLineage {
  return graph.lineageForAction(actionRef);
}

/**
 * INV-E04-consumed strength: the strongest EFFECTIVE level across the
 * presented nodes. Each node is capped by its authenticated provenance via
 * the settlement `effectiveEvidenceLevel` — a screenshot never proves P3
 * because it claims to.
 */
export function maxEffectiveEvidenceLevel(
  nodes: readonly EvidenceNode[],
): ProofLevel | undefined {
  if (!Array.isArray(nodes)) {
    throw new ValidationError('nodes must be an array of EvidenceNode');
  }
  let best: ProofLevel | undefined;
  for (const node of nodes) {
    const level = effectiveEvidenceLevel(node);
    if (best === undefined || levelRank(level) > levelRank(best)) {
      best = level;
    }
  }
  return best;
}

/**
 * Does the presented evidence meet the required threshold? Returns both the
 * verdict and the achieved level so callers record WHY a decision passed.
 */
export function evidenceMeetsThreshold(
  nodes: readonly EvidenceNode[],
  required: ProofLevel,
): { readonly met: boolean; readonly achieved: ProofLevel | undefined } {
  const achieved = maxEffectiveEvidenceLevel(nodes);
  if (achieved === undefined) {
    return Object.freeze({ met: false, achieved: undefined });
  }
  return Object.freeze({ met: levelRank(achieved) >= levelRank(required), achieved });
}

function levelRank(level: ProofLevel): number {
  return ['P0', 'P1', 'P2', 'P3', 'P4', 'P5'].indexOf(level);
}

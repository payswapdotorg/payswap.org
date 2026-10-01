/**
 * @payswap/settlement — the evidence graph (W1-004).
 *
 * SECURITY-EVIDENCE-RECOURSE "Evidence lineage": every consequential
 * operation records authorization lineage (why allowed), execution lineage
 * (what action occurred), outcome lineage (what was observed), provenance,
 * timestamp/epoch and links to protocol objects.
 *
 * - INV-E01: every consequential action has authorization evidence —
 *   `lineageForAction(actionRef)` returns the authorization chain of the
 *   action, queryable at any time.
 * - INV-E02: every external effect has execution evidence — the same query
 *   returns the execution + outcome chains.
 * - INV-E05: historical evidence is immutable — nodes are frozen, the graph
 *   is append-only, and re-recording an existing node id with DIFFERENT
 *   content throws `EvidenceMutationError`. Identical re-records are
 *   idempotent (replay-safe).
 * - INV-E04: UI/browser artifacts are never stronger than their
 *   authenticated provenance — `effectiveEvidenceLevel` caps a
 *   `UI_BROWSER_ARTIFACT` node at P0 (bare screenshot/assertion) or P1 (when
 *   the artifact carries authenticated provenance), no matter what level the
 *   evidence CLAIMS.
 */

import { ValidationError } from "@payswap/protocol";
import type { PaySwapErrorDetails, TimestampMs } from "@payswap/protocol";
import type { ProofLevel } from "./proof-policies.js";

/** What the evidence node documents (mirrors the evidence-lineage taxonomy). */
export type EvidenceNodeKind =
  | "AUTHORIZATION"
  | "EXECUTION"
  | "OUTCOME"
  | "RECONCILIATION"
  | "PROOF"
  | "RECEIPT";

/**
 * Where the evidence came from. The provenance determines its maximum
 * believable strength (INV-E04).
 */
export type EvidenceProvenance =
  | { readonly source: "PROTOCOL_LEDGER" }
  | { readonly source: "AUTHENTICATED_PROVIDER"; readonly providerName: string }
  | { readonly source: "INDEPENDENT_OBSERVER"; readonly observerRef: string }
  | { readonly source: "OPERATOR"; readonly operatorRef: string }
  | { readonly source: "UI_BROWSER_ARTIFACT"; readonly authenticated: boolean };

/** One immutable node in the evidence graph. */
export interface EvidenceNode {
  readonly nodeId: string;
  readonly kind: EvidenceNodeKind;
  /** The consequential action this evidence belongs to (attempt/instruction id). */
  readonly actionRef: string;
  /** The level this evidence CLAIMS to prove (capped by provenance — INV-E04). */
  readonly claimedLevel: ProofLevel;
  readonly provenance: EvidenceProvenance;
  /** Deterministic binding hash of the underlying artifact payload. */
  readonly payloadHash: string;
  /** Parent node ids — the lineage this evidence continues. */
  readonly links: readonly string[];
  readonly recordedAt: TimestampMs;
}

/** Input accepted by `EvidenceGraph.record`. */
export interface EvidenceNodeDraft {
  readonly nodeId: string;
  readonly kind: EvidenceNodeKind;
  readonly actionRef: string;
  readonly claimedLevel: ProofLevel;
  readonly provenance: EvidenceProvenance;
  /** Opaque artifact payload; the node stores only its deterministic hash. */
  readonly payload: string;
  readonly links: readonly string[];
  readonly recordedAt: TimestampMs;
}

/** The queryable lineage of one consequential action (INV-E01/E02). */
export interface ActionEvidenceLineage {
  readonly actionRef: string;
  readonly authorization: readonly EvidenceNode[];
  readonly execution: readonly EvidenceNode[];
  readonly outcome: readonly EvidenceNode[];
  readonly reconciliation: readonly EvidenceNode[];
  readonly proof: readonly EvidenceNode[];
  readonly receipt: readonly EvidenceNode[];
  readonly all: readonly EvidenceNode[];
}

/** INV-E05 violation: recorded evidence was mutated. */
export class EvidenceMutationError extends ValidationError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super(message, details);
    this.name = "EvidenceMutationError";
  }
}

/** No node exists under the given id. */
export class UnknownEvidenceNodeError extends ValidationError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super(message, details);
    this.name = "UnknownEvidenceNodeError";
  }
}

const EVIDENCE_KINDS: readonly EvidenceNodeKind[] = [
  "AUTHORIZATION",
  "EXECUTION",
  "OUTCOME",
  "RECONCILIATION",
  "PROOF",
  "RECEIPT",
];

/** Deterministic FNV-1a 64 over a string (binding, never security). */
function fnv1a64(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    hash ^= BigInt(code);
    hash *= 0x100000001b3n;
    hash &= 0xffff_ffff_ffff_ffffn;
  }
  return hash.toString(16);
}

/** Deterministic canonical rendering of a node (field-by-field, never JSON key order). */
function canonicalEvidenceNode(node: EvidenceNode): string {
  const provenance = (() => {
    switch (node.provenance.source) {
      case "PROTOCOL_LEDGER":
        return "PROTOCOL_LEDGER";
      case "AUTHENTICATED_PROVIDER":
        return `AUTHENTICATED_PROVIDER:${node.provenance.providerName}`;
      case "INDEPENDENT_OBSERVER":
        return `INDEPENDENT_OBSERVER:${node.provenance.observerRef}`;
      case "OPERATOR":
        return `OPERATOR:${node.provenance.operatorRef}`;
      case "UI_BROWSER_ARTIFACT":
        return `UI_BROWSER_ARTIFACT:${node.provenance.authenticated ? "AUTHENTICATED" : "UNAUTHENTICATED"}`;
    }
  })();
  return (
    `evidence|id:${node.nodeId}|kind:${node.kind}|action:${node.actionRef}` +
    `|claimed:${node.claimedLevel}|provenance:${provenance}` +
    `|payloadHash:${node.payloadHash}|links:[${node.links.join(",")}]` +
    `|recordedAt:${node.recordedAt}`
  );
}

function isEvidenceNodeKind(value: unknown): value is EvidenceNodeKind {
  return typeof value === "string" && (EVIDENCE_KINDS as readonly string[]).includes(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isProvenanceShaped(value: unknown): value is EvidenceProvenance {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<EvidenceProvenance>;
  switch (candidate.source) {
    case "PROTOCOL_LEDGER":
      return true;
    case "AUTHENTICATED_PROVIDER":
      return typeof candidate.providerName === "string" && candidate.providerName.length > 0;
    case "INDEPENDENT_OBSERVER":
      return typeof candidate.observerRef === "string" && candidate.observerRef.length > 0;
    case "OPERATOR":
      return typeof candidate.operatorRef === "string" && candidate.operatorRef.length > 0;
    case "UI_BROWSER_ARTIFACT":
      return typeof candidate.authenticated === "boolean";
    default:
      return false;
  }
}

/**
 * The append-only, queryable evidence graph. Deterministic reference
 * implementation: nodes are stored as frozen records in recording order;
 * history is never rewritten (INV-E05).
 */
export class EvidenceGraph {
  readonly #nodes = new Map<string, EvidenceNode>();
  readonly #order: EvidenceNode[] = [];
  readonly #byAction = new Map<string, EvidenceNode[]>();

  /**
   * Record one evidence node (append-only, INV-E05). Re-recording an existing
   * node id with byte-identical content is an idempotent replay; ANY content
   * difference throws `EvidenceMutationError`.
   */
  record(draft: EvidenceNodeDraft): EvidenceNode {
    if (draft === null || typeof draft !== "object") {
      throw new ValidationError("evidence draft must be an EvidenceNodeDraft object");
    }
    if (!isNonEmptyString(draft.nodeId)) {
      throw new ValidationError("evidence draft nodeId must be a non-empty string");
    }
    if (!isEvidenceNodeKind(draft.kind)) {
      throw new ValidationError(`evidence draft kind is not declared: ${String(draft.kind)}`);
    }
    if (!isNonEmptyString(draft.actionRef)) {
      throw new ValidationError("evidence draft actionRef must be a non-empty string");
    }
    if (typeof draft.claimedLevel !== "string" || !["P0", "P1", "P2", "P3", "P4", "P5"].includes(draft.claimedLevel)) {
      throw new ValidationError("evidence draft claimedLevel must be a declared proof level");
    }
    if (!isProvenanceShaped(draft.provenance)) {
      throw new ValidationError("evidence draft provenance must be a declared EvidenceProvenance");
    }
    if (typeof draft.payload !== "string") {
      throw new ValidationError("evidence draft payload must be a string");
    }
    if (typeof draft.recordedAt !== "bigint") {
      throw new ValidationError("evidence draft recordedAt must be a bigint TimestampMs");
    }
    if (!Array.isArray(draft.links)) {
      throw new ValidationError("evidence draft links must be an array of node ids");
    }
    for (const link of draft.links) {
      if (!isNonEmptyString(link)) {
        throw new ValidationError("evidence draft links must be non-empty node ids");
      }
      if (!this.#nodes.has(link)) {
        throw new UnknownEvidenceNodeError(
          `evidence '${draft.nodeId}' links to unknown parent '${link}' — lineage must be recorded bottom-up`,
          { nodeId: draft.nodeId, link },
        );
      }
    }

    const node: EvidenceNode = Object.freeze({
      nodeId: draft.nodeId,
      kind: draft.kind,
      actionRef: draft.actionRef,
      claimedLevel: draft.claimedLevel,
      provenance: Object.freeze({ ...draft.provenance }) as EvidenceProvenance,
      payloadHash: `evh:${fnv1a64(draft.payload)}`,
      links: Object.freeze([...draft.links]),
      recordedAt: draft.recordedAt,
    });

    const existing = this.#nodes.get(node.nodeId);
    if (existing !== undefined) {
      if (canonicalEvidenceNode(existing) !== canonicalEvidenceNode(node)) {
        // INV-E05: historical evidence is immutable.
        throw new EvidenceMutationError(
          `INV-E05: evidence '${node.nodeId}' is already recorded and immutable`,
          { nodeId: node.nodeId, recordedPayloadHash: existing.payloadHash, attemptedPayloadHash: node.payloadHash },
        );
      }
      return existing; // idempotent replay of identical evidence
    }

    this.#nodes.set(node.nodeId, node);
    this.#order.push(node);
    const list = this.#byAction.get(node.actionRef) ?? [];
    list.push(node);
    this.#byAction.set(node.actionRef, list);
    return node;
  }

  /** One node by id (frozen, immutable). */
  node(nodeId: string): EvidenceNode | undefined {
    return this.#nodes.get(nodeId);
  }

  /** INV-E05 guard: does the recorded node differ from the draft content? */
  conflictsWith(draft: EvidenceNodeDraft): boolean {
    const existing = this.#nodes.get(draft.nodeId);
    if (existing === undefined) {
      return false;
    }
    const candidate: EvidenceNode = Object.freeze({
      nodeId: draft.nodeId,
      kind: draft.kind,
      actionRef: draft.actionRef,
      claimedLevel: draft.claimedLevel,
      provenance: draft.provenance,
      payloadHash: `evh:${fnv1a64(draft.payload)}`,
      links: Object.freeze([...draft.links]),
      recordedAt: draft.recordedAt,
    });
    return canonicalEvidenceNode(existing) !== canonicalEvidenceNode(candidate);
  }

  /**
   * INV-E01/E02: the queryable evidence lineage of one consequential action.
   * Authorization, execution and outcome chains are returned separately so a
   * caller can prove "why allowed" AND "what happened" for any action.
   */
  lineageForAction(actionRef: string): ActionEvidenceLineage {
    if (!isNonEmptyString(actionRef)) {
      throw new ValidationError("actionRef must be a non-empty string");
    }
    const all = [...(this.#byAction.get(actionRef) ?? [])];
    const byKind = (kind: EvidenceNodeKind): readonly EvidenceNode[] =>
      Object.freeze(all.filter((node) => node.kind === kind));
    return Object.freeze({
      actionRef,
      authorization: byKind("AUTHORIZATION"),
      execution: byKind("EXECUTION"),
      outcome: byKind("OUTCOME"),
      reconciliation: byKind("RECONCILIATION"),
      proof: byKind("PROOF"),
      receipt: byKind("RECEIPT"),
      all: Object.freeze(all),
    });
  }

  /**
   * The full lineage chain of one node: the node followed by its transitive
   * parents (deterministic breadth-first order, cycle-safe).
   */
  chainOf(nodeId: string): readonly EvidenceNode[] {
    const start = this.#nodes.get(nodeId);
    if (start === undefined) {
      throw new UnknownEvidenceNodeError(`no evidence node exists under '${nodeId}'`, { nodeId });
    }
    const visited = new Set<string>([start.nodeId]);
    const chain: EvidenceNode[] = [start];
    const queue: EvidenceNode[] = [start];
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) continue;
      for (const link of current.links) {
        if (visited.has(link)) continue;
        const parent = this.#nodes.get(link);
        if (parent === undefined) continue;
        visited.add(parent.nodeId);
        chain.push(parent);
        queue.push(parent);
      }
    }
    return Object.freeze(chain);
  }

  /** All nodes in recording order (audit view). */
  allNodes(): readonly EvidenceNode[] {
    return Object.freeze([...this.#order]);
  }

  /** Deterministic canonical rendering of one node (INV-E05 replay equality). */
  canonicalNode(nodeId: string): string {
    const node = this.#nodes.get(nodeId);
    if (node === undefined) {
      throw new UnknownEvidenceNodeError(`no evidence node exists under '${nodeId}'`, { nodeId });
    }
    return canonicalEvidenceNode(node);
  }
}

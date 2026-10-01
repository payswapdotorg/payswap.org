/**
 * CapabilityCase — security-relevant incidents and observations linked to
 * components (W2-005; FROZEN-ARCHITECTURE §17 signals + §18 human fallback;
 * INV-S04).
 *
 * INV-S04 — incidents FEED evidence and security learning. Every capability
 * case carries explicit evidence refs and, on every lifecycle event, appends
 * an immutable `SecurityLearningRecord` (content-addressed, namespaced) to
 * the learning feed. The feed is the Arena/production-learning consumption
 * surface: it is additive, append-only and never rewritten (AGENTS.md rule
 * 8; LAB.md "Production learning": "Outcomes become immutable trajectories,
 * ... security incidents and expert resolutions. Never rewrite a historical
 * record to make a later candidate look better.").
 *
 * Signals follow SECURITY-EVIDENCE-RECOURSE.md: device/SIM/account changes,
 * beneficiary changes, graph anomalies, velocity, provider incidents,
 * agent/package behavior, verification failures, expert findings and
 * coordinated abuse.
 *
 * Deterministic only: no ambient clock, no randomness.
 */

import type { ComponentIdentity, ComponentRef } from "./signatures.js";
import { contentDigest, isComponentKind } from "./signatures.js";
import type { EvidenceRef } from "./quarantine.js";

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

/** Security signal classes (SECURITY-EVIDENCE-RECOURSE.md "Signals include"). */
export const SECURITY_SIGNAL_KINDS = [
  "device_change",
  "sim_change",
  "account_change",
  "beneficiary_change",
  "graph_anomaly",
  "velocity",
  "provider_incident",
  "agent_behavior",
  "package_behavior",
  "verification_failure",
  "expert_finding",
  "coordinated_abuse",
] as const;

export type SecuritySignalKind = (typeof SECURITY_SIGNAL_KINDS)[number];

export function isSecuritySignalKind(
  value: unknown,
): value is SecuritySignalKind {
  return (
    typeof value === "string" &&
    (SECURITY_SIGNAL_KINDS as readonly unknown[]).includes(value)
  );
}

/** One observed security signal with provenance. */
export interface SecuritySignal {
  readonly signalKind: SecuritySignalKind;
  readonly observedAt: number;
  readonly detail: string;
  /** Who/what observed the signal (observation provenance). */
  readonly sourceRef: string;
}

// ---------------------------------------------------------------------------
// Capability cases
// ---------------------------------------------------------------------------

export const CAPABILITY_CASE_KINDS = ["incident", "observation"] as const;
export type CapabilityCaseKind = (typeof CAPABILITY_CASE_KINDS)[number];

export const CAPABILITY_CASE_STATUSES = [
  "open",
  "escalated",
  "resolved",
] as const;
export type CapabilityCaseStatus = (typeof CAPABILITY_CASE_STATUSES)[number];

/**
 * A security-relevant incident or observation linked to one component. The
 * W2-005 incident record: feeds evidence (evidence refs), the advisory
 * pipeline (escalation) and the expert Arena bridge (./experts.js consumes
 * cases as the dispatch input of the §18 human-fallback flow).
 */
export interface CapabilityCase {
  readonly caseId: string;
  readonly kind: CapabilityCaseKind;
  readonly title: string;
  /** The component the case is linked to. */
  readonly component: ComponentIdentity;
  readonly signal: SecuritySignal;
  readonly evidence: readonly EvidenceRef[];
  /** Signatures that matched the case input, when any. */
  readonly matchedSignatureRefs?: readonly string[];
  /** Advisories issued from this case, when any. */
  readonly relatedAdvisoryRefs?: readonly string[];
  readonly openedAt: number;
  readonly status: CapabilityCaseStatus;
  /** Present iff status is resolved. */
  readonly resolvedAt?: number;
  readonly resolutionNote?: string;
}

/** Append-only case lifecycle event. */
export type CapabilityCaseEvent =
  | { readonly eventType: "opened"; readonly record: CapabilityCase }
  | { readonly eventType: "evidence_attached"; readonly caseId: string; readonly evidence: readonly EvidenceRef[] }
  | { readonly eventType: "escalated"; readonly caseId: string; readonly at: number }
  | { readonly eventType: "resolved"; readonly caseId: string; readonly at: number; readonly resolutionNote: string };

/** Raised for invalid case operations. */
export class CapabilityCaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapabilityCaseError";
  }
}

// ---------------------------------------------------------------------------
// The learning feed (INV-S04)
// ---------------------------------------------------------------------------

/**
 * Namespace brand of every learning artifact produced by the immune system.
 * Exists only at the type level: a SecurityLearningRecord is structurally
 * distinct from any authorization/financial artifact and carries the
 * namespace string at runtime for downstream (Arena/Lab) consumption.
 */
export const SECURITY_LEARNING_NAMESPACE = "PAYSWAP_SECURITY_LEARNING" as const;
export interface SecurityLearningNamespaceBrand {
  readonly __payswapSecurityLearning: typeof SECURITY_LEARNING_NAMESPACE;
}

/**
 * An immutable learning record emitted from a capability case event.
 * Arena-compatible shape: content-addressed (contentDigest), versioned by
 * sequence, namespaced — structurally aligned with the Lab's immutable
 * versioned artifacts so production learning can consume it without any
 * conversion ambiguity.
 */
export interface SecurityLearningRecord extends SecurityLearningNamespaceBrand {
  readonly learningId: string;
  /** 1-based sequence within the case, in event order. */
  readonly sequence: number;
  readonly caseId: string;
  readonly component: ComponentIdentity;
  readonly signalKind: SecuritySignalKind;
  readonly caseStatus: CapabilityCaseStatus;
  readonly recordedAt: number;
  /** Digest of the case snapshot at the moment the record was emitted. */
  readonly contentDigest: string;
  readonly namespace: typeof SECURITY_LEARNING_NAMESPACE;
}

// ---------------------------------------------------------------------------
// The case ledger
// ---------------------------------------------------------------------------

function caseDigest(record: CapabilityCase): string {
  return contentDigest({
    caseId: record.caseId,
    kind: record.kind,
    title: record.title,
    component: record.component,
    signal: record.signal,
    evidence: record.evidence,
    matchedSignatureRefs: record.matchedSignatureRefs ?? [],
    relatedAdvisoryRefs: record.relatedAdvisoryRefs ?? [],
    openedAt: record.openedAt,
    status: record.status,
    resolvedAt: record.resolvedAt ?? null,
    resolutionNote: record.resolutionNote ?? null,
  });
}

/**
 * The capability case ledger: append-only lifecycle, immutable learning
 * feed. Every state transition appends a case event AND a learning record —
 * resolving or escalating a case never removes or rewrites what came before
 * (INV-C03 discipline: history is preserved for in-flight and retired
 * components alike).
 */
export class CapabilityCaseLedger {
  private readonly casesById = new Map<string, CapabilityCase>();
  private readonly order: string[] = [];
  private readonly events: CapabilityCaseEvent[] = [];
  private readonly learning: SecurityLearningRecord[] = [];

  /** Opens a case with mandatory signal + at least one evidence ref. */
  open(input: {
    caseId: string;
    kind: CapabilityCaseKind;
    title: string;
    component: ComponentIdentity;
    signal: SecuritySignal;
    evidence: readonly EvidenceRef[];
    matchedSignatureRefs?: readonly string[];
    openedAt: number;
  }): CapabilityCase {
    if (input.caseId.length === 0) {
      throw new CapabilityCaseError("caseId must not be empty");
    }
    if (input.title.length === 0) {
      throw new CapabilityCaseError("title must not be empty");
    }
    if (!isComponentKind(input.component.kind)) {
      throw new CapabilityCaseError(
        `unknown component kind '${String(input.component.kind)}'`,
      );
    }
    if (input.component.id.length === 0) {
      throw new CapabilityCaseError("component id must not be empty");
    }
    if (!isSecuritySignalKind(input.signal.signalKind)) {
      throw new CapabilityCaseError(
        `unknown signal kind '${String(input.signal.signalKind)}'`,
      );
    }
    if (input.signal.sourceRef.length === 0) {
      throw new CapabilityCaseError("signal sourceRef must not be empty");
    }
    if (input.evidence.length === 0) {
      throw new CapabilityCaseError(
        "a capability case requires at least one evidence ref (INV-S04: incidents feed evidence)",
      );
    }
    if (this.casesById.has(input.caseId)) {
      throw new CapabilityCaseError(`case '${input.caseId}' already exists`);
    }
    const record: CapabilityCase = Object.freeze({
      caseId: input.caseId,
      kind: input.kind,
      title: input.title,
      component: input.component,
      signal: input.signal,
      evidence: Object.freeze([...input.evidence]),
      ...(input.matchedSignatureRefs === undefined
        ? {}
        : { matchedSignatureRefs: Object.freeze([...input.matchedSignatureRefs]) }),
      openedAt: input.openedAt,
      status: "open",
    });
    this.casesById.set(input.caseId, record);
    this.order.push(input.caseId);
    this.events.push({ eventType: "opened", record });
    this.emitLearning(record, input.openedAt);
    return record;
  }

  /** Attaches additional evidence to an open/escalated case. */
  attachEvidence(input: {
    caseId: string;
    evidence: readonly EvidenceRef[];
    at: number;
  }): CapabilityCase {
    const record = this.expectCase(input.caseId);
    if (record.status === "resolved") {
      throw new CapabilityCaseError(
        `case '${input.caseId}' is resolved; evidence can only attach to open or escalated cases`,
      );
    }
    if (input.evidence.length === 0) {
      throw new CapabilityCaseError("evidence to attach must not be empty");
    }
    const updated: CapabilityCase = Object.freeze({
      ...record,
      evidence: Object.freeze([...record.evidence, ...input.evidence]),
    });
    this.casesById.set(input.caseId, updated);
    this.events.push({
      eventType: "evidence_attached",
      caseId: input.caseId,
      evidence: Object.freeze([...input.evidence]),
    });
    this.emitLearning(updated, input.at);
    return updated;
  }

  /** Escalates an open case (advisory/expert pipeline hand-off). */
  escalate(input: { caseId: string; at: number }): CapabilityCase {
    const record = this.expectCase(input.caseId);
    if (record.status === "resolved") {
      throw new CapabilityCaseError(
        `case '${input.caseId}' is resolved and cannot escalate`,
      );
    }
    if (record.status === "escalated") {
      throw new CapabilityCaseError(`case '${input.caseId}' is already escalated`);
    }
    const updated: CapabilityCase = Object.freeze({
      ...record,
      status: "escalated",
    });
    this.casesById.set(input.caseId, updated);
    this.events.push({
      eventType: "escalated",
      caseId: input.caseId,
      at: input.at,
    });
    this.emitLearning(updated, input.at);
    return updated;
  }

  /** Resolves an open/escalated case with a resolution note. */
  resolve(input: { caseId: string; at: number; resolutionNote: string }): CapabilityCase {
    const record = this.expectCase(input.caseId);
    if (record.status === "resolved") {
      throw new CapabilityCaseError(`case '${input.caseId}' is already resolved`);
    }
    if (input.resolutionNote.length === 0) {
      throw new CapabilityCaseError("resolutionNote must not be empty");
    }
    const updated: CapabilityCase = Object.freeze({
      ...record,
      status: "resolved",
      resolvedAt: input.at,
      resolutionNote: input.resolutionNote,
    });
    this.casesById.set(input.caseId, updated);
    this.events.push({
      eventType: "resolved",
      caseId: input.caseId,
      at: input.at,
      resolutionNote: input.resolutionNote,
    });
    this.emitLearning(updated, input.at);
    return updated;
  }

  byId(caseId: string): CapabilityCase | undefined {
    return this.casesById.get(caseId);
  }

  /** All cases in creation order. */
  list(): readonly CapabilityCase[] {
    return this.order.map((id) => this.casesById.get(id) as CapabilityCase);
  }

  /** Cases linked to a component (kind + id [+ version when present])). */
  casesForComponent(component: ComponentRef): readonly CapabilityCase[] {
    return this.list().filter(
      (record) =>
        record.component.kind === component.kind &&
        record.component.id === component.id,
    );
  }

  /**
   * INV-S04 — the full immutable learning feed, in emission order.
   * Arena/production-learning consumption surface.
   */
  learningFeed(): readonly SecurityLearningRecord[] {
    return [...this.learning];
  }

  /** Learning records emitted for one case, in emission order. */
  learningRecordsFor(caseId: string): readonly SecurityLearningRecord[] {
    return this.learning.filter((record) => record.caseId === caseId);
  }

  /** Append-only case lifecycle history. Never rewritten. */
  history(): readonly CapabilityCaseEvent[] {
    return [...this.events];
  }

  private expectCase(caseId: string): CapabilityCase {
    const record = this.casesById.get(caseId);
    if (record === undefined) {
      throw new CapabilityCaseError(`unknown case '${caseId}'`);
    }
    return record;
  }

  private emitLearning(record: CapabilityCase, recordedAt: number): void {
    const sequence = this.learningRecordsFor(record.caseId).length + 1;
    this.learning.push(
      Object.freeze({
        __payswapSecurityLearning: SECURITY_LEARNING_NAMESPACE,
        learningId: `learning:${record.caseId}:${sequence}`,
        sequence,
        caseId: record.caseId,
        component: record.component,
        signalKind: record.signal.signalKind,
        caseStatus: record.status,
        recordedAt,
        contentDigest: caseDigest(record),
        namespace: SECURITY_LEARNING_NAMESPACE,
      }),
    );
  }
}

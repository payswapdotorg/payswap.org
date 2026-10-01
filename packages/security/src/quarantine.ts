/**
 * Quarantine and the composed immune-system gate (W2-005; FROZEN-
 * ARCHITECTURE §17; SECURITY-EVIDENCE-RECOURSE.md; INV-S03, INV-S01/S02).
 *
 * INV-S03 — a quarantined component can NEVER regain access through cached
 * capability state. Capability state (e.g. a CapabilityGraphStore entry with
 * capabilityState AVAILABLE, or any two-axis effective availability resolved
 * earlier) is a CACHE — an observation of the past. `authorizeCapabilityUse`
 * consults the quarantine ledger and the advisory registry FIRST and treats
 * the cached availability as evidence-free noise: a cached AVAILABLE can
 * never bypass an active quarantine.
 *
 * Reversibility: quarantine is released ONLY through EXPLICIT remediation
 * plus closure of every advisory that caused it (SECURITY-EVIDENCE-RECOURSE
 * "quarantine is reversible only through explicit remediation + advisory
 * closure"). `QuarantineLedger.release` enforces both preconditions and
 * fails closed otherwise.
 *
 * History (INV-C03 discipline): the ledger keeps an append-only event log;
 * releasing a quarantine appends a `released` event and never rewrites the
 * `quarantined` events that preceded it. Retired/quarantined history stays
 * queryable forever.
 *
 * Deterministic only: no ambient clock, no randomness.
 */

import type { EffectiveAvailability } from "@payswap/capabilities";
import type { ComponentIdentity, ComponentRef } from "./signatures.js";
import { componentKey, isComponentKind } from "./signatures.js";
import type {
  ComponentRestriction,
  SecurityAdvisory,
  SecurityAdvisoryRegistry,
} from "./advisories.js";
import type {
  EpochScopedAuthorization,
  SecurityEpochAuthority,
} from "./epochs.js";
import { checkSensitiveActionAuthorization } from "./epochs.js";

// ---------------------------------------------------------------------------
// Evidence refs (shared with capability-cases/experts; declared here first
// because release requires remediation evidence)
// ---------------------------------------------------------------------------

/** Reference to an immutable evidence artifact (content-addressed). */
export interface EvidenceRef {
  readonly evidenceId: string;
  readonly artifactRef: string;
  readonly contentDigest: string;
}

// ---------------------------------------------------------------------------
// Quarantine ledger
// ---------------------------------------------------------------------------

/** A quarantine record. Immutable; release appends a new event, never edits. */
export interface QuarantineRecord {
  readonly quarantineId: string;
  readonly component: ComponentRef;
  readonly reason: string;
  /** Advisories whose enforcement created this quarantine. */
  readonly advisoryRefs: readonly string[];
  readonly quarantinedAt: number;
  readonly status: "active" | "released";
  readonly releasedAt?: number;
  readonly releaseNote?: string;
  /** Remediation evidence presented at release, when released. */
  readonly remediationEvidence?: readonly EvidenceRef[];
}

/** Append-only quarantine lifecycle event. */
export type QuarantineEvent =
  | { readonly eventType: "quarantined"; readonly record: QuarantineRecord }
  | {
      readonly eventType: "released";
      readonly quarantineId: string;
      readonly releasedAt: number;
      readonly releaseNote: string;
      readonly remediationEvidence: readonly EvidenceRef[];
    };

/** Raised for invalid quarantine operations. */
export class QuarantineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuarantineError";
  }
}

/** Remediation presented for a release (work order: explicit remediation). */
export interface QuarantineRemediation {
  readonly releaseNote: string;
  /** Non-empty remediation evidence is MANDATORY for release. */
  readonly evidence: readonly EvidenceRef[];
}

/**
 * The quarantine ledger: append-only, deterministic. Quarantine creation is
 * ordered by the caller (typically the SecurityGate enforcing an advisory);
 * release requires every driving advisory to be CLOSED and explicit
 * remediation evidence to be present.
 */
export class QuarantineLedger {
  private readonly recordsById = new Map<string, QuarantineRecord>();
  private readonly order: string[] = [];
  private readonly events: QuarantineEvent[] = [];
  private nextSequence = 1;

  /** Quarantines a component. The record references its driving advisories. */
  quarantine(input: {
    component: ComponentRef;
    reason: string;
    advisoryRefs: readonly string[];
    at: number;
  }): QuarantineRecord {
    if (!isComponentKind(input.component.kind)) {
      throw new QuarantineError(
        `unknown component kind '${String(input.component.kind)}'`,
      );
    }
    if (input.component.id.length === 0) {
      throw new QuarantineError("component id must not be empty");
    }
    if (input.reason.length === 0) {
      throw new QuarantineError("quarantine reason must not be empty");
    }
    const key = componentKey(input.component);
    const active = this.activeRecordsFor(input.component);
    if (active.length > 0) {
      throw new QuarantineError(
        `component '${key}' is already quarantined (${active
          .map((record) => record.quarantineId)
          .join(", ")})`,
      );
    }
    const quarantineId = `quarantine:${key}:${this.nextSequence}`;
    this.nextSequence += 1;
    const record: QuarantineRecord = Object.freeze({
      quarantineId,
      component: input.component,
      reason: input.reason,
      advisoryRefs: Object.freeze([...input.advisoryRefs]),
      quarantinedAt: input.at,
      status: "active",
    });
    this.recordsById.set(quarantineId, record);
    this.order.push(quarantineId);
    this.events.push({ eventType: "quarantined", record });
    return record;
  }

  /**
   * Releases a quarantine. Reversible ONLY through explicit remediation +
   * advisory closure:
   * 1. the record must exist and be active;
   * 2. EVERY advisory referenced by the record must be CLOSED in the supplied
   *    advisory registry (with verified remediation — enforced at closure);
   * 3. the remediation evidence must be non-empty.
   * Appends a `released` event; the history of the quarantine is preserved.
   */
  release(input: {
    quarantineId: string;
    remediation: QuarantineRemediation;
    advisories: SecurityAdvisoryRegistry;
    at: number;
  }): QuarantineRecord {
    const record = this.recordsById.get(input.quarantineId);
    if (record === undefined) {
      throw new QuarantineError(
        `unknown quarantine '${input.quarantineId}'`,
      );
    }
    if (record.status === "released") {
      throw new QuarantineError(
        `quarantine '${input.quarantineId}' is already released`,
      );
    }
    if (input.remediation.releaseNote.length === 0) {
      throw new QuarantineError("release note must not be empty");
    }
    if (input.remediation.evidence.length === 0) {
      throw new QuarantineError(
        "quarantine release requires explicit remediation evidence (an empty remediation can never release a quarantine)",
      );
    }
    for (const evidence of input.remediation.evidence) {
      if (
        evidence.evidenceId.length === 0 ||
        evidence.artifactRef.length === 0 ||
        evidence.contentDigest.length === 0
      ) {
        throw new QuarantineError("remediation evidence refs must be complete");
      }
    }
    const openAdvisories: string[] = [];
    for (const advisoryRef of record.advisoryRefs) {
      const advisory = input.advisories.byId(advisoryRef);
      if (advisory === undefined) {
        throw new QuarantineError(
          `quarantine '${input.quarantineId}' references unknown advisory '${advisoryRef}'`,
        );
      }
      if (advisory.status !== "closed") {
        openAdvisories.push(advisoryRef);
      }
    }
    if (openAdvisories.length > 0) {
      throw new QuarantineError(
        `quarantine '${input.quarantineId}' cannot be released while advisories remain active: ${openAdvisories.join(", ")} (close them with verified remediation first)`,
      );
    }
    if (input.at < record.quarantinedAt) {
      throw new QuarantineError(
        `release at ${input.at} is before the quarantine at ${record.quarantinedAt}`,
      );
    }
    const released: QuarantineRecord = Object.freeze({
      ...record,
      status: "released",
      releasedAt: input.at,
      releaseNote: input.remediation.releaseNote,
      remediationEvidence: Object.freeze([...input.remediation.evidence]),
    });
    this.recordsById.set(input.quarantineId, released);
    this.events.push({
      eventType: "released",
      quarantineId: input.quarantineId,
      releasedAt: input.at,
      releaseNote: input.remediation.releaseNote,
      remediationEvidence: Object.freeze([...input.remediation.evidence]),
    });
    return released;
  }

  byId(quarantineId: string): QuarantineRecord | undefined {
    return this.recordsById.get(quarantineId);
  }

  /** All records in creation order. */
  list(): readonly QuarantineRecord[] {
    return this.order.map((id) => this.recordsById.get(id) as QuarantineRecord);
  }

  /** Records for one component (kind + id), creation order, any status. */
  recordsFor(component: ComponentRef): readonly QuarantineRecord[] {
    return this.list().filter(
      (record) => record.component.kind === component.kind &&
        record.component.id === component.id,
    );
  }

  private activeRecordsFor(component: ComponentRef): readonly QuarantineRecord[] {
    return this.recordsFor(component).filter(
      (record) => record.status === "active",
    );
  }

  /** True iff the component has an ACTIVE quarantine (the INV-S03 gate). */
  isQuarantined(component: ComponentRef): boolean {
    return this.activeRecordsFor(component).length > 0;
  }

  /**
   * Active quarantine records for a component, creation order. Used by the
   * access gate to attach the driving quarantine ids to a rejection.
   */
  activeQuarantinesFor(component: ComponentRef): readonly QuarantineRecord[] {
    return this.activeRecordsFor(component);
  }

  /** Append-only lifecycle history. Never rewritten (INV-C03 discipline). */
  history(): readonly QuarantineEvent[] {
    return [...this.events];
  }
}

// ---------------------------------------------------------------------------
// Capability access gate (INV-S03: cached state can never bypass quarantine)
// ---------------------------------------------------------------------------

/**
 * A CACHED view of a capability: what some earlier observation resolved
 * (two-axis effective availability from @payswap/capabilities, or any other
 * cached state). This is the input the immune system must NOT trust.
 */
export interface CachedCapabilityView {
  readonly capabilityId: string;
  readonly sourceId: string;
  readonly effectiveAvailability: EffectiveAvailability;
  /**
   * Components that provide/back the capability (extension, package, agent
   * key). A quarantine on any provider blocks the capability too.
   */
  readonly providedBy?: readonly ComponentRef[];
}

export type CapabilityAccessRejectReason =
  | "quarantined"
  | "quarantined_provider"
  | "restricted"
  | "restricted_provider"
  | "retired"
  | "retired_provider";

export type CapabilityAccessDecision =
  | { readonly decision: "ALLOW" }
  | {
      readonly decision: "REJECT";
      readonly reason: CapabilityAccessRejectReason;
      readonly componentKey: string;
      readonly advisoryRefs: readonly string[];
      readonly quarantineIds: readonly string[];
    };

/** The immune-system state consulted by the access gate. */
export interface SecurityEnforcementState {
  readonly advisories: SecurityAdvisoryRegistry;
  readonly quarantine: QuarantineLedger;
}

function decisionFor(
  reason: CapabilityAccessRejectReason,
  component: ComponentRef,
  driving: ComponentRestriction,
  quarantineIds: readonly string[],
): CapabilityAccessDecision {
  return {
    decision: "REJECT",
    reason,
    componentKey: componentKey(component),
    advisoryRefs: driving.advisoryRefs,
    quarantineIds,
  };
}

/**
 * INV-S03 — the capability access gate.
 *
 * Evaluation order is the whole point:
 * 1. quarantine ledger (for the capability AND every provider);
 * 2. active-advisory restriction view (for the capability AND every
 *    provider; retire > quarantine > restrict);
 * 3. ONLY THEN would the cached availability matter — and by then it cannot
 *    change the outcome: a cached AVAILABLE is an observation of the PAST and
 *    never an authority (INV-C01 separates capability state from source
 *    availability; the immune system separates BOTH from security state).
 *
 * Deterministic: a pure function of (view, enforcement state). Note the
 * cached `effectiveAvailability` field is deliberately NEVER read in the
 * decision path — the test suite proves a cached AVAILABLE cannot bypass an
 * active quarantine.
 */
export function authorizeCapabilityUse(
  view: CachedCapabilityView,
  security: SecurityEnforcementState,
): CapabilityAccessDecision {
  if (view.capabilityId.length === 0) {
    throw new QuarantineError("capability view requires a capabilityId");
  }
  const capability: ComponentRef = {
    kind: "capability",
    id: view.capabilityId,
  };
  const related: readonly ComponentRef[] = [
    capability,
    ...(view.providedBy ?? []),
  ];

  for (const component of related) {
    const activeQuarantines =
      security.quarantine.activeQuarantinesFor(component);
    if (activeQuarantines.length > 0) {
      const identity: ComponentIdentity = {
        kind: component.kind,
        id: component.id,
      };
      return decisionFor(
        component.kind === "capability" ? "quarantined" : "quarantined_provider",
        component,
        security.advisories.restrictionFor(identity),
        activeQuarantines.map((record) => record.quarantineId),
      );
    }
  }
  for (const component of related) {
    const restriction = security.advisories.restrictionFor({
      kind: component.kind,
      id: component.id,
    });
    if (restriction.retired) {
      return decisionFor(
        component.kind === "capability" ? "retired" : "retired_provider",
        component,
        restriction,
        [],
      );
    }
    if (restriction.quarantined) {
      return decisionFor(
        component.kind === "capability" ? "quarantined" : "quarantined_provider",
        component,
        restriction,
        security.quarantine
          .activeQuarantinesFor(component)
          .map((record) => record.quarantineId),
      );
    }
    if (restriction.restricted) {
      return decisionFor(
        component.kind === "capability" ? "restricted" : "restricted_provider",
        component,
        restriction,
        [],
      );
    }
  }
  return { decision: "ALLOW" };
}

// ---------------------------------------------------------------------------
// Restricted-component rejection for delegated actions
// ---------------------------------------------------------------------------

/**
 * Raised when a delegated action is attempted by/through a restricted or
 * quarantined component (the W2-005 acceptance: "security epoch can restrict
 * vulnerable package/agent/extension" — the enforcement side of that).
 */
export class RestrictedComponentError extends Error {
  readonly componentKey: string;
  readonly advisoryRefs: readonly string[];

  constructor(
    componentKey: string,
    advisoryRefs: readonly string[],
    action: string,
  ) {
    super(
      `Component '${componentKey}' is restricted (${advisoryRefs.join(", ")}) and cannot perform sensitive action '${action}'`,
    );
    this.name = "RestrictedComponentError";
    this.componentKey = componentKey;
    this.advisoryRefs = advisoryRefs;
  }
}

// ---------------------------------------------------------------------------
// The composed gate + advisory enforcement
// ---------------------------------------------------------------------------

/** What enforcing one advisory did (deterministic record). */
export interface EnforcementRecord {
  readonly advisoryId: string;
  readonly action: SecurityAdvisory["action"];
  readonly quarantinedComponents: readonly ComponentRef[];
  readonly epochAdvanced: boolean;
  readonly enforcedAt: number;
}

/**
 * The composed immune-system gate: advisory registry + quarantine ledger +
 * network security epoch authority, with one deterministic enforcement and
 * check surface. This is the object a runtime (W2-006 / W3-x adapters) holds
 * to consult the immune system.
 *
 * SECURITY-EVIDENCE-RECOURSE.md: "SecurityAdvisory can advance SecurityEpoch
 * and restrict, quarantine or retire affected components." `enforceAdvisory`
 * implements exactly that, with the epoch advance EXPLICIT (opt-in) so the
 * caller controls when every epoch-scoped authorization in the network is
 * invalidated.
 */
export class SecurityGate {
  readonly advisories: SecurityAdvisoryRegistry;
  readonly quarantine: QuarantineLedger;
  readonly epochs: SecurityEpochAuthority;

  constructor(input: SecurityEnforcementState & {
    readonly epochs: SecurityEpochAuthority;
  }) {
    this.advisories = input.advisories;
    this.quarantine = input.quarantine;
    this.epochs = input.epochs;
  }

  /**
   * Enforces a PUBLISHED advisory:
   * - `restrict`/`retire`: the restriction is computed live from the active
   *   advisory set (nothing extra to build);
   * - `quarantine`: creates a quarantine record for every affected component
   *   (kind + id), referencing the advisory;
   * - `advanceEpoch: true`: advances the network security epoch with the
   *   advisory as provenance, invalidating every epoch-scoped authorization
   *   issued at a lower epoch.
   */
  enforceAdvisory(
    advisory: SecurityAdvisory,
    options?: { advanceEpoch?: boolean },
  ): EnforcementRecord {
    const quarantinedComponents: ComponentRef[] = [];
    if (advisory.action === "quarantine") {
      for (const affected of advisory.affected) {
        const component: ComponentRef = {
          kind: affected.kind,
          id: affected.id,
        };
        // Idempotent: an already-quarantined component is not re-quarantined.
        if (!this.quarantine.isQuarantined(component)) {
          this.quarantine.quarantine({
            component,
            reason: advisory.title,
            advisoryRefs: [advisory.advisoryId],
            at: advisory.provenance.publishedAt,
          });
          quarantinedComponents.push(component);
        }
      }
    }
    let epochAdvanced = false;
    if (options?.advanceEpoch === true) {
      this.epochs.advance({
        reason: `advisory ${advisory.advisoryId}: ${advisory.title}`,
        at: advisory.provenance.publishedAt,
        advisoryRef: advisory.advisoryId,
      });
      epochAdvanced = true;
    }
    return {
      advisoryId: advisory.advisoryId,
      action: advisory.action,
      quarantinedComponents: Object.freeze(quarantinedComponents),
      epochAdvanced,
      enforcedAt: advisory.provenance.publishedAt,
    };
  }

  /** INV-S03 capability access gate (see authorizeCapabilityUse). */
  authorizeCapabilityUse(view: CachedCapabilityView): CapabilityAccessDecision {
    return authorizeCapabilityUse(view, {
      advisories: this.advisories,
      quarantine: this.quarantine,
    });
  }

  /**
   * The full sensitive delegated-action gate:
   * 1. INV-S02/A02 — epoch + expiry check through ./epochs.js;
   * 2. the acting agent (authorization.agentRef) and its package must not be
   *    restricted/quarantined/retired (advisory view, computed globally);
   * 3. any components the action is routed THROUGH must not be either.
   *
   * Throws StaleAuthorizationEpochError / AuthorizationExpiredError /
   * RestrictedComponentError. Fail-closed on every axis.
   */
  checkSensitiveAction(input: {
    authorization: EpochScopedAuthorization;
    at: number;
    /** Additional components the action is routed through (e.g. package, extension). */
    viaComponents?: readonly ComponentRef[];
  }): void {
    checkSensitiveActionAuthorization(
      input.authorization,
      this.epochs,
      input.at,
    );
    const related: ComponentRef[] = [];
    if (input.authorization.agentRef !== undefined) {
      related.push({ kind: "agent_key", id: input.authorization.agentRef });
    }
    related.push(...(input.viaComponents ?? []));
    for (const component of related) {
      const restriction = this.advisories.restrictionFor({
        kind: component.kind,
        id: component.id,
      });
      if (restriction.restricted) {
        throw new RestrictedComponentError(
          componentKey(component),
          restriction.advisoryRefs,
          input.authorization.actionClass,
        );
      }
    }
  }
}

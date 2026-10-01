/**
 * Security advisories (W2-005; FROZEN-ARCHITECTURE §17; SECURITY-EVIDENCE-
 * RECOURSE.md "SecurityAdvisory can advance SecurityEpoch and restrict,
 * quarantine or retire affected components").
 *
 * INV-S01 — an advisory restricts affected components GLOBALLY. The
 * restriction view computed here has NO scope parameter: there is no tenant,
 * no source, no principal and no capability-graph view through which a
 * restricted component could appear unrestricted. Whatever identity is
 * presented — from any source, any graph, any network partition that has
 * observed the advisory — `restrictionFor` answers the same. The registry is
 * the single network-wide source of truth.
 *
 * Lifecycle: advisories are historical protocol facts (AGENTS.md rule 8).
 * The registry keeps an APPEND-ONLY event log (PUBLISHED / CLOSED);
 * `history()` is never rewritten. Closing an advisory requires verified
 * remediation — the precondition for quarantine release (./quarantine.js).
 *
 * Deterministic only: every decision is a pure function of the registry
 * state and the input; fail-closed on malformed input.
 */

import { ValidationError } from "@payswap/protocol";
import type { ComponentIdentity, ComponentKind, VersionRange } from "./signatures.js";
import {
  componentKey,
  contentDigest,
  isComponentKind,
  versionInRange,
} from "./signatures.js";

// ---------------------------------------------------------------------------
// Advisory contracts
// ---------------------------------------------------------------------------

export const ADVISORY_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type AdvisorySeverity = (typeof ADVISORY_SEVERITIES)[number];

export function isAdvisorySeverity(value: unknown): value is AdvisorySeverity {
  return (
    typeof value === "string" &&
    (ADVISORY_SEVERITIES as readonly unknown[]).includes(value)
  );
}

/**
 * The enforcement actions an advisory can order, in increasing strength
 * (SECURITY-EVIDENCE-RECOURSE.md): restrict < quarantine < retire.
 * Quarantine execution is owned by ./quarantine.js; restriction and
 * retirement are computed live from the active advisory set here.
 */
export const ADVISORY_ACTIONS = ["restrict", "quarantine", "retire"] as const;
export type AdvisoryAction = (typeof ADVISORY_ACTIONS)[number];

export function isAdvisoryAction(value: unknown): value is AdvisoryAction {
  return (
    typeof value === "string" &&
    (ADVISORY_ACTIONS as readonly unknown[]).includes(value)
  );
}

/** One affected component with an optional affected-version range. */
export interface AffectedComponentRef {
  readonly kind: ComponentKind;
  readonly id: string;
  readonly versionRange?: VersionRange;
}

/** How to remediate the vulnerability (work order: severity, affected ranges, remediation). */
export interface RemediationGuidance {
  readonly summary: string;
  /** First version containing the fix, when one exists. */
  readonly patchedVersion?: string;
  /** Interim mitigations, in declared order. */
  readonly workarounds: readonly string[];
}

/** Mandatory advisory provenance (AGENTS.md worker rules). */
export interface AdvisoryProvenance {
  readonly declaredBy: string;
  readonly contentHash: string;
  readonly publishedAt: number;
}

export type AdvisoryStatus = "active" | "closed";

/** A published security advisory. Immutable once published. */
export interface SecurityAdvisory {
  readonly advisoryId: string;
  readonly title: string;
  readonly severity: AdvisorySeverity;
  readonly description: string;
  readonly affected: readonly AffectedComponentRef[];
  readonly action: AdvisoryAction;
  readonly remediation: RemediationGuidance;
  readonly provenance: AdvisoryProvenance;
  readonly status: AdvisoryStatus;
  /** Present iff status is closed. */
  readonly closedAt?: number;
  /** Present iff status is closed. */
  readonly closureNote?: string;
}

/** Append-only advisory lifecycle event (AGENTS.md rule 8). */
export type AdvisoryEvent =
  | { readonly eventType: "published"; readonly advisory: SecurityAdvisory }
  | {
      readonly eventType: "closed";
      readonly advisoryId: string;
      readonly closedAt: number;
      readonly closureNote: string;
      readonly remediationVerified: boolean;
    };

/** Raised for invalid advisory operations. */
export class SecurityAdvisoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecurityAdvisoryError";
  }
}

// ---------------------------------------------------------------------------
// The global restriction view (INV-S01)
// ---------------------------------------------------------------------------

/**
 * The effective restriction of one component identity, computed from EVERY
 * active advisory. There is deliberately no scope parameter: the same
 * component identity is restricted identically across the whole network
 * model (INV-S01).
 */
export interface ComponentRestriction {
  /** Component this restriction describes (kind + id + version). */
  readonly component: ComponentIdentity;
  /** True when any active advisory orders `restrict` or stronger. */
  readonly restricted: boolean;
  /** True when any active advisory orders `quarantine` or stronger. */
  readonly quarantined: boolean;
  /** True when any active advisory orders `retire`. */
  readonly retired: boolean;
  /** Active advisories driving the strongest action, most severe first. */
  readonly advisoryRefs: readonly string[];
}

const SEVERITY_RANK: Readonly<Record<AdvisorySeverity, number>> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

function actionAtLeast(action: AdvisoryAction, floor: AdvisoryAction): boolean {
  const rank: Readonly<Record<AdvisoryAction, number>> = {
    restrict: 0,
    quarantine: 1,
    retire: 2,
  };
  return rank[action] >= rank[floor];
}

/**
 * Does the advisory's affected set cover this identity (kind + id + range)?
 *
 * RESTRICTION IS FAIL-CLOSED (contrast with signature matching in
 * ./signatures.js, which is evidence-generating and therefore fail-open):
 * when an advisory is version-scoped and the presented identity carries no
 * version, the component is treated as AFFECTED — the network restricts what
 * it cannot verify as safe.
 */
export function advisoryAffects(
  advisory: SecurityAdvisory,
  identity: ComponentIdentity,
): boolean {
  for (const affected of advisory.affected) {
    if (affected.kind !== identity.kind || affected.id !== identity.id) {
      continue;
    }
    const range = affected.versionRange;
    if (range === undefined) {
      return true;
    }
    if (identity.version === undefined) {
      // Version-scoped advisory, version unknown: fail closed (affected).
      return true;
    }
    if (versionInRange(identity.version, range)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/** Input for publishing an advisory; provenance contentHash is computed. */
export interface PublishAdvisoryInput {
  readonly advisoryId: string;
  readonly title: string;
  readonly severity: AdvisorySeverity;
  readonly description: string;
  readonly affected: readonly AffectedComponentRef[];
  readonly action: AdvisoryAction;
  readonly remediation: RemediationGuidance;
  readonly declaredBy: string;
  readonly publishedAt: number;
}

/**
 * The network-wide security advisory registry: append-only lifecycle,
 * deterministic ordering (publication order), content-addressed advisories.
 *
 * INV-S01: `restrictionFor` is the GLOBAL restriction view — no matter where
 * in the network model a component identity is presented (any capability
 * graph source, any principal, any tenant), the answer is identical, because
 * the active advisory set is the single source of truth.
 */
export class SecurityAdvisoryRegistry {
  private readonly advisoriesById = new Map<string, SecurityAdvisory>();
  private readonly events: AdvisoryEvent[] = [];
  private readonly order: string[] = [];

  /** Publishes a new advisory. It is ACTIVE immediately and globally. */
  publish(input: PublishAdvisoryInput): SecurityAdvisory {
    if (input.advisoryId.length === 0) {
      throw new SecurityAdvisoryError("advisoryId must not be empty");
    }
    if (input.title.length === 0) {
      throw new SecurityAdvisoryError("title must not be empty");
    }
    if (input.declaredBy.length === 0) {
      throw new SecurityAdvisoryError("declaredBy must not be empty");
    }
    if (!isAdvisorySeverity(input.severity)) {
      throw new ValidationError(`unknown advisory severity '${String(input.severity)}'`);
    }
    if (!isAdvisoryAction(input.action)) {
      throw new ValidationError(`unknown advisory action '${String(input.action)}'`);
    }
    if (input.remediation.summary.length === 0) {
      throw new SecurityAdvisoryError("remediation summary must not be empty");
    }
    if (input.affected.length === 0) {
      throw new SecurityAdvisoryError(
        "an advisory must affect at least one component (an empty advisory cannot restrict anything)",
      );
    }
    for (const affected of input.affected) {
      if (!isComponentKind(affected.kind)) {
        throw new SecurityAdvisoryError(
          `unknown affected component kind '${String(affected.kind)}'`,
        );
      }
      if (affected.id.length === 0) {
        throw new SecurityAdvisoryError("affected component id must not be empty");
      }
    }
    if (this.advisoriesById.has(input.advisoryId)) {
      throw new SecurityAdvisoryError(
        `advisory '${input.advisoryId}' already exists`,
      );
    }
    const advisory: SecurityAdvisory = Object.freeze({
      advisoryId: input.advisoryId,
      title: input.title,
      severity: input.severity,
      description: input.description,
      affected: Object.freeze([...input.affected]),
      action: input.action,
      remediation: input.remediation,
      provenance: Object.freeze({
        declaredBy: input.declaredBy,
        contentHash: contentDigest({
          advisoryId: input.advisoryId,
          title: input.title,
          severity: input.severity,
          description: input.description,
          affected: input.affected,
          action: input.action,
          remediation: input.remediation,
        }),
        publishedAt: input.publishedAt,
      }),
      status: "active",
    });
    this.advisoriesById.set(input.advisoryId, advisory);
    this.order.push(input.advisoryId);
    this.events.push({ eventType: "published", advisory });
    return advisory;
  }

  /**
   * Closes an advisory. Requires `remediationVerified: true` — closure is the
   * precondition for quarantine release (./quarantine.js), so an unverified
   * remediation can never unlock a quarantined component through closure.
   * Appends a `closed` event; the `published` event remains in history.
   */
  close(input: {
    advisoryId: string;
    closedAt: number;
    closureNote: string;
    remediationVerified: boolean;
  }): SecurityAdvisory {
    const advisory = this.advisoriesById.get(input.advisoryId);
    if (advisory === undefined) {
      throw new SecurityAdvisoryError(`unknown advisory '${input.advisoryId}'`);
    }
    if (advisory.status === "closed") {
      throw new SecurityAdvisoryError(
        `advisory '${input.advisoryId}' is already closed`,
      );
    }
    if (!input.remediationVerified) {
      throw new SecurityAdvisoryError(
        `advisory '${input.advisoryId}' cannot be closed without verified remediation (quarantine release depends on closure)`,
      );
    }
    if (input.closureNote.length === 0) {
      throw new SecurityAdvisoryError("closureNote must not be empty");
    }
    if (input.closedAt < advisory.provenance.publishedAt) {
      throw new SecurityAdvisoryError(
        `closedAt ${input.closedAt} is before the advisory publication at ${advisory.provenance.publishedAt}`,
      );
    }
    const closed: SecurityAdvisory = Object.freeze({
      ...advisory,
      status: "closed",
      closedAt: input.closedAt,
      closureNote: input.closureNote,
    });
    this.advisoriesById.set(input.advisoryId, closed);
    this.events.push({
      eventType: "closed",
      advisoryId: input.advisoryId,
      closedAt: input.closedAt,
      closureNote: input.closureNote,
      remediationVerified: input.remediationVerified,
    });
    return closed;
  }

  byId(advisoryId: string): SecurityAdvisory | undefined {
    return this.advisoriesById.get(advisoryId);
  }

  /** All advisories in publication order. */
  list(): readonly SecurityAdvisory[] {
    return this.order.map((id) => this.advisoriesById.get(id) as SecurityAdvisory);
  }

  /** Active advisories in publication order. */
  listActive(): readonly SecurityAdvisory[] {
    return this.list().filter((advisory) => advisory.status === "active");
  }

  /**
   * INV-S01 global restriction view. Deterministic: same registry state +
   * same identity → same answer, for every caller in the network model.
   */
  restrictionFor(identity: ComponentIdentity): ComponentRestriction {
    const driving: SecurityAdvisory[] = [];
    for (const advisory of this.listActive()) {
      if (advisoryAffects(advisory, identity)) {
        driving.push(advisory);
      }
    }
    // Most severe first, then publication order; deterministic total order.
    driving.sort((a, b) => {
      const rank = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
      if (rank !== 0) {
        return rank;
      }
      return a.advisoryId < b.advisoryId ? -1 : a.advisoryId > b.advisoryId ? 1 : 0;
    });
    const quarantined = driving.some((advisory) =>
      actionAtLeast(advisory.action, "quarantine"),
    );
    const retired = driving.some((advisory) => advisory.action === "retire");
    const restricted = driving.length > 0;
    return Object.freeze({
      component: identity,
      restricted,
      quarantined,
      retired,
      advisoryRefs: Object.freeze(driving.map((advisory) => advisory.advisoryId)),
    });
  }

  /**
   * True iff the component identity is restricted by any active advisory.
   * The scope-free twin of `restrictionFor` for hot paths.
   */
  isRestricted(identity: ComponentIdentity): boolean {
    return this.restrictionFor(identity).restricted;
  }

  /** Append-only lifecycle history. Never rewritten (AGENTS.md rule 8). */
  history(): readonly AdvisoryEvent[] {
    return [...this.events];
  }

  /** Deterministic label for logs/tests: kind:id of every active restriction. */
  activeRestrictedKeys(): readonly string[] {
    const keys = new Set<string>();
    for (const advisory of this.listActive()) {
      for (const affected of advisory.affected) {
        keys.add(componentKey(affected));
      }
    }
    return [...keys].sort();
  }
}

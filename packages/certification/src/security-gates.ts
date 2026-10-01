/**
 * Security review gates (W2-006; FROZEN-ARCHITECTURE §17; SECURITY-
 * EVIDENCE-RECOURSE.md "Security immune system"; INV-S01..S04, INV-A02).
 *
 * The security review gate screens a certification/promotion subject against
 * the immune-system state BEFORE any production promotion order can exist:
 * active advisories (global restriction view, INV-S01), the quarantine
 * ledger (INV-S03) and the network security epoch (INV-S02/A02). A FAILED
 * security review is terminal for the promotion attempt — the companion
 * promotion ledger (./promotion.js) HALTS the order irreversibly; only a NEW
 * order carrying remediation evidence can ever promote the subject again.
 *
 * BOUNDARY DESIGN — structural consumption. This package deliberately does
 * NOT import the immune-system package in its source: that package's own
 * boundary rules forbid any other package's src importing it while it is
 * unconsumed, so the consumption here is STRUCTURAL, exactly like the Arena
 * compatibility pattern used elsewhere in the repository. The view
 * interfaces below are structural subsets of the immune-system types; the
 * real registry/ledger/epoch-authority/gate objects are assignable to them
 * (proven by the package tests, which drive the REAL objects through these
 * gates). No vocabulary is redefined: the component kinds, advisory
 * severities/actions and statuses mirror the owning package's unions.
 *
 * Deterministic only: every decision is a pure function of the subject, the
 * supplied immune-state views and nothing else.
 */

import { contentDigest } from "./digest.js";

// ---------------------------------------------------------------------------
// Structural views of the immune-system state (INV-S01..S03)
// ---------------------------------------------------------------------------

/** Structural view of one component identity the immune system can restrict. */
export interface StructuralComponentIdentity {
  readonly kind: string;
  readonly id: string;
  readonly version?: string;
}

/** Kind + id pair; the minimal unversioned identity used by quarantine. */
export interface StructuralComponentRef {
  readonly kind: string;
  readonly id: string;
}

/** Structural view of one affected-component reference inside an advisory. */
export interface StructuralAffectedComponentRef {
  readonly kind: string;
  readonly id: string;
}

/**
 * Structural view of an active security advisory. The version range of the
 * affected entries is deliberately NOT part of the view: the review matches
 * by kind + id only, which treats every version of an affected component as
 * affected — the FAIL-CLOSED projection.
 */
export interface StructuralAdvisory {
  readonly advisoryId: string;
  readonly severity: string;
  readonly action: string;
  readonly affected: readonly StructuralAffectedComponentRef[];
}

/** Structural view of the global restriction view result (INV-S01). */
export interface StructuralComponentRestriction {
  readonly restricted: boolean;
  readonly quarantined: boolean;
  readonly retired: boolean;
  readonly advisoryRefs: readonly string[];
}

/** Structural view of one active quarantine record. */
export interface StructuralQuarantineRecord {
  readonly quarantineId: string;
}

/** Structural view of the advisory registry (the real registry is assignable). */
export interface StructuralAdvisoryRegistry {
  listActive(): readonly StructuralAdvisory[];
  restrictionFor(
    identity: StructuralComponentIdentity,
  ): StructuralComponentRestriction;
  byId(
    advisoryId: string,
  ): { readonly advisoryId: string; readonly status: string } | undefined;
}

/** Structural view of the quarantine ledger (the real ledger is assignable). */
export interface StructuralQuarantineLedger {
  isQuarantined(component: StructuralComponentRef): boolean;
  activeQuarantinesFor(
    component: StructuralComponentRef,
  ): readonly StructuralQuarantineRecord[];
}

/** Structural view of the network epoch authority (INV-S02). */
export interface StructuralEpochAuthority {
  currentEpoch(): { readonly value: bigint };
}

/**
 * The composed immune-state view consumed by the security review gate. The
 * real composed immune-system gate object (advisory registry + quarantine
 * ledger + epoch authority) is structurally assignable to this interface.
 */
export interface StructuralImmuneState {
  readonly advisories: StructuralAdvisoryRegistry;
  readonly quarantine: StructuralQuarantineLedger;
  readonly epochs: StructuralEpochAuthority;
}

// ---------------------------------------------------------------------------
// The review subject
// ---------------------------------------------------------------------------

/**
 * The subject of a security review: what is being screened, the component
 * identities that back it (agent packages, bodies, extensions, capabilities,
 * connected instances…) and the network security epoch at which the
 * promotion authorization was issued.
 */
export interface SecurityReviewSubject {
  readonly componentKind: string;
  readonly subjectId: string;
  readonly version: string;
  readonly screenedComponents: readonly StructuralComponentIdentity[];
  /** Network epoch at which the promotion authorization was issued (INV-S02). */
  readonly authorizationIssuedAtEpoch: bigint;
}

/** Raised when the review subject itself is malformed. */
export class SecurityReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecurityReviewError";
  }
}

// ---------------------------------------------------------------------------
// The gate outcome
// ---------------------------------------------------------------------------

export type SecurityGateFailure =
  | {
      readonly failure: "component_restricted";
      readonly componentKey: string;
      readonly advisoryRefs: readonly string[];
    }
  | {
      readonly failure: "component_quarantined";
      readonly componentKey: string;
      readonly advisoryRefs: readonly string[];
      readonly quarantineIds: readonly string[];
    }
  | {
      readonly failure: "component_retired";
      readonly componentKey: string;
      readonly advisoryRefs: readonly string[];
    }
  | {
      readonly failure: "stale_authorization_epoch";
      readonly issuedAtEpoch: bigint;
      readonly currentEpoch: bigint;
    }
  | {
      readonly failure: "active_advisory_affects_subject";
      readonly advisoryId: string;
      readonly advisoryAction: string;
      readonly advisorySeverity: string;
    };

/** The security review outcome. Failures are terminal for the attempt. */
export type SecurityReviewOutcome =
  | {
      readonly passed: true;
      readonly screened: number;
      readonly currentEpoch: bigint;
      readonly reviewDigest: string;
    }
  | {
      readonly passed: false;
      readonly screened: number;
      readonly currentEpoch: bigint;
      readonly failures: readonly SecurityGateFailure[];
      readonly reviewDigest: string;
    };

function structuralAdvisoryAffects(
  advisory: StructuralAdvisory,
  identity: StructuralComponentIdentity,
): boolean {
  for (const affected of advisory.affected) {
    if (affected.kind === identity.kind && affected.id === identity.id) {
      return true;
    }
  }
  return false;
}

function componentKeyOf(identity: StructuralComponentIdentity): string {
  return `${identity.kind}:${identity.id}`;
}

function assertSubject(subject: SecurityReviewSubject): void {
  if (subject.subjectId.length === 0) {
    throw new SecurityReviewError("subjectId must not be empty");
  }
  if (subject.version.length === 0) {
    throw new SecurityReviewError("subject version must not be empty");
  }
  if (subject.screenedComponents.length === 0) {
    throw new SecurityReviewError(
      "a security review must screen at least one component identity",
    );
  }
  for (const component of subject.screenedComponents) {
    if (component.kind.length === 0 || component.id.length === 0) {
      throw new SecurityReviewError(
        "screened component identities require kind and id",
      );
    }
  }
}

/**
 * Runs the security review gate over a subject against the immune state.
 *
 * Evaluation order (fail-closed on every axis):
 * 1. INV-S02/A02 — the epoch gate: the promotion authorization must have
 *    been issued at the CURRENT network security epoch;
 * 2. INV-S03 — the quarantine ledger: any actively quarantined screened
 *    component (or its providers) blocks the review;
 * 3. INV-S01 — the global advisory restriction view: restricted, quarantined
 *    or retired components block the review, wherever in the network model
 *    they were presented from;
 * 4. defense in depth — every active advisory whose affected set covers a
 *    screened component with a quarantine/retire action blocks the review
 *    even if the ledger has no (or no longer has an) active record.
 *
 * Deterministic: a pure function of (subject, immune state).
 */
export function runSecurityReview(input: {
  readonly subject: SecurityReviewSubject;
  readonly immune: StructuralImmuneState;
}): SecurityReviewOutcome {
  assertSubject(input.subject);
  const subject = input.subject;
  const immune = input.immune;
  const currentEpoch = immune.epochs.currentEpoch().value;
  const failures: SecurityGateFailure[] = [];

  // 1. Epoch gate (INV-S02/A02): stale epoch-scoped authorizations are dead.
  if (subject.authorizationIssuedAtEpoch < currentEpoch) {
    failures.push({
      failure: "stale_authorization_epoch",
      issuedAtEpoch: subject.authorizationIssuedAtEpoch,
      currentEpoch,
    });
  }

  const ref = (identity: StructuralComponentIdentity): StructuralComponentRef => ({
    kind: identity.kind,
    id: identity.id,
  });

  // 2. Quarantine ledger first (INV-S03): cached capability state can never
  //    bypass an active quarantine — the review never consults any cached
  //    availability at all.
  const ledgerQuarantined = new Set<string>();
  for (const component of subject.screenedComponents) {
    if (immune.quarantine.isQuarantined(ref(component))) {
      const active = immune.quarantine.activeQuarantinesFor(ref(component));
      const restriction = immune.advisories.restrictionFor(component);
      ledgerQuarantined.add(componentKeyOf(component));
      failures.push({
        failure: "component_quarantined",
        componentKey: componentKeyOf(component),
        advisoryRefs: restriction.advisoryRefs,
        quarantineIds: active.map((record) => record.quarantineId),
      });
    }
  }

  // 3. Global advisory restriction view (INV-S01). A component already
  //    reported through the quarantine ledger (the stronger, record-backed
  //    axis) is not reported twice.
  for (const component of subject.screenedComponents) {
    const key = componentKeyOf(component);
    const restriction = immune.advisories.restrictionFor(component);
    if (restriction.retired) {
      failures.push({
        failure: "component_retired",
        componentKey: key,
        advisoryRefs: restriction.advisoryRefs,
      });
    } else if (restriction.quarantined && !ledgerQuarantined.has(key)) {
      failures.push({
        failure: "component_quarantined",
        componentKey: key,
        advisoryRefs: restriction.advisoryRefs,
        quarantineIds: immune.quarantine
          .activeQuarantinesFor(ref(component))
          .map((record) => record.quarantineId),
      });
    } else if (restriction.restricted && !restriction.quarantined) {
      failures.push({
        failure: "component_restricted",
        componentKey: key,
        advisoryRefs: restriction.advisoryRefs,
      });
    }
  }

  // 4. Defense in depth: advisory-level screening of the active set.
  for (const advisory of immune.advisories.listActive()) {
    if (
      advisory.action !== "quarantine" &&
      advisory.action !== "retire"
    ) {
      continue;
    }
    for (const component of subject.screenedComponents) {
      if (structuralAdvisoryAffects(advisory, component)) {
        failures.push({
          failure: "active_advisory_affects_subject",
          advisoryId: advisory.advisoryId,
          advisoryAction: advisory.action,
          advisorySeverity: advisory.severity,
        });
        break;
      }
    }
  }

  const screened = subject.screenedComponents.length;
  const reviewDigest = contentDigest({
    subject: {
      componentKind: subject.componentKind,
      subjectId: subject.subjectId,
      version: subject.version,
      screenedComponents: subject.screenedComponents,
    },
    currentEpoch,
    failureCount: failures.length,
  });
  if (failures.length === 0) {
    return Object.freeze({
      passed: true,
      screened,
      currentEpoch,
      reviewDigest,
    });
  }
  return Object.freeze({
    passed: false,
    screened,
    currentEpoch,
    failures: Object.freeze(failures),
    reviewDigest,
  });
}

// ---------------------------------------------------------------------------
// Remediation evidence (the only path back after a halt)
// ---------------------------------------------------------------------------

/**
 * Remediation evidence presented with a NEW promotion order after a security
 * halt: the halted order it remediates, the advisories whose verified
 * remediation closed them, and the immutable evidence artifacts. This is the
 * ONLY input that can ever release a halt — there is no override, no
 * emergency bypass and no re-submission of the halted order itself.
 */
export interface RemediationEvidence {
  readonly evidenceId: string;
  readonly artifactRef: string;
  readonly contentDigest: string;
}

export interface RemediationPackage {
  /** The halt being remediated. */
  readonly haltedOrderRef: string;
  /** Advisories that were closed with verified remediation. */
  readonly closedAdvisoryRefs: readonly string[];
  /** Non-empty immutable evidence artifacts. */
  readonly evidence: readonly RemediationEvidence[];
}

/**
 * Verifies a remediation package against the immune state: the referenced
 * advisories must exist and be CLOSED (closure itself requires verified
 * remediation in the owning package), and the evidence must be non-empty and
 * complete. Returns the violation list — empty means the remediation is
 * valid.
 */
export function verifyRemediationPackage(input: {
  readonly remediation: RemediationPackage;
  readonly immune: StructuralImmuneState;
}): readonly string[] {
  const violations: string[] = [];
  if (input.remediation.haltedOrderRef.length === 0) {
    violations.push("remediation must reference the halted order it remediates");
  }
  if (input.remediation.closedAdvisoryRefs.length === 0) {
    violations.push(
      "remediation must reference at least one closed advisory (the halt was security-driven)",
    );
  }
  if (input.remediation.evidence.length === 0) {
    violations.push(
      "remediation evidence is MANDATORY: an empty remediation can never release a security halt",
    );
  }
  for (const evidence of input.remediation.evidence) {
    if (
      evidence.evidenceId.length === 0 ||
      evidence.artifactRef.length === 0 ||
      evidence.contentDigest.length === 0
    ) {
      violations.push(`remediation evidence '${evidence.evidenceId}' is incomplete`);
    }
  }
  for (const advisoryRef of input.remediation.closedAdvisoryRefs) {
    const advisory = input.immune.advisories.byId(advisoryRef);
    if (advisory === undefined) {
      violations.push(
        `remediation references unknown advisory '${advisoryRef}' (fail closed)`,
      );
    } else if (advisory.status !== "closed") {
      violations.push(
        `advisory '${advisoryRef}' is still ${advisory.status}: a halt cannot be remediated while the driving advisory is open`,
      );
    }
  }
  return violations;
}

/**
 * @payswap/operations — the operator action catalog (W3-007).
 *
 * Authority: spec/work-items/W3-007.md ("operators can diagnose UNKNOWN,
 * security quarantine, incentive disputes and rail outages") +
 * AGENTS.md rule 2 (every consequential financial effect has both
 * authorization lineage and evidence lineage) + rule 10 (user approval is a
 * trusted-surface operation; a chat message is not authority).
 *
 * The operator-action law: NO action exists in this catalog without
 *  1. an AUTHORITY LEVEL that gates who may execute it (attenuated
 *     delegation — INV-A01);
 *  2. at least one EVIDENCE REQUIREMENT — an operator action without an
 *     evidence artifact cannot exist (the campaigns OperatorControlLog
 *     refuses empty evidence for exactly this reason);
 *  3. a ROLLBACK PATH (reversible, compensating action, or irreversible
 *     with a full audit trail) — never "unknown rollback";
 *  4. a RUNBOOK ENTRY that documents symptom → diagnosis → action →
 *     verification (operator-actions reference runbook entry IDs that the
 *     runbook assembly must produce — dangling references fail the check);
 *  5. a VERSION — operator procedures evolve; historical records stay
 *     immutable (INV-E05) and callers bind to the version they executed.
 *
 * Deterministic only: declarations + checkers; executing the actions is the
 * production operator console's job, which consumes this catalog.
 */

// ---------------------------------------------------------------------------
// Authority levels (attenuated delegation — INV-A01)
// ---------------------------------------------------------------------------

export const OPERATOR_AUTHORITY_LEVELS = [
  "OPERATOR",
  "SENIOR_OPERATOR",
  "SECURITY_OFFICER",
  "PROTOCOL_LEAD",
] as const;
export type OperatorAuthorityLevel =
  (typeof OPERATOR_AUTHORITY_LEVELS)[number];

export function isOperatorAuthorityLevel(
  value: unknown,
): value is OperatorAuthorityLevel {
  return (
    typeof value === "string" &&
    (OPERATOR_AUTHORITY_LEVELS as readonly unknown[]).includes(value)
  );
}

/** Ordinal of authority — higher may act at lower levels (attenuation). */
const AUTHORITY_ORDER: Readonly<Record<OperatorAuthorityLevel, number>> =
  Object.freeze({
    OPERATOR: 1,
    SENIOR_OPERATOR: 2,
    SECURITY_OFFICER: 3,
    PROTOCOL_LEAD: 4,
  });

export function authoritySatisfies(
  held: OperatorAuthorityLevel,
  required: OperatorAuthorityLevel,
): boolean {
  return AUTHORITY_ORDER[held] >= AUTHORITY_ORDER[required];
}

// ---------------------------------------------------------------------------
// Evidence requirements and rollback paths
// ---------------------------------------------------------------------------

export interface EvidenceRequirement {
  /** What the evidence artifact must show. */
  readonly kind: string;
  readonly description: string;
  /** Minimum number of distinct evidence artifacts required. */
  readonly minimum: number;
}

export type RollbackMode =
  | "REVERSIBLE"
  | "COMPENSATING_ACTION"
  | "IRREVERSIBLE_WITH_AUDIT";

export interface RollbackPath {
  readonly mode: RollbackMode;
  readonly description: string;
  /** For COMPENSATING_ACTION: the action that undoes this one. */
  readonly compensatingActionId?: string;
  /**
   * For REVERSIBLE/COMPENSATING_ACTION: how long the path stays viable.
   * IRREVERSIBLE_WITH_AUDIT declares the audit trail instead.
   */
  readonly reversalWindow?: string;
}

// ---------------------------------------------------------------------------
// The action declaration and catalog
// ---------------------------------------------------------------------------

export interface OperatorActionDeclaration {
  readonly actionId: string;
  /** Procedure version — historical records bind to the executed version. */
  readonly version: number;
  readonly title: string;
  readonly description: string;
  readonly authorityLevel: OperatorAuthorityLevel;
  /** ≥1 evidence requirement — an unevidenced operator action cannot exist. */
  readonly evidence: readonly EvidenceRequirement[];
  readonly rollback: RollbackPath;
  /** The runbook entry documenting the procedure (must exist). */
  readonly runbookEntryId: string;
  /** The observability event emitted when the action executes. */
  readonly emitsEvent: string;
  readonly invariants: readonly string[];
}

/** The operator action catalog (W3-007). */
export const OPERATOR_ACTIONS: readonly OperatorActionDeclaration[] =
  Object.freeze([
    {
      actionId: "pause-campaign",
      version: 1,
      title: "Pause an incentive campaign",
      description:
        "Pause a participation campaign; pause mints a new campaign epoch (history is never rewritten, INV-P07) and stops new accruals while in-flight rewards settle.",
      authorityLevel: "OPERATOR",
      evidence: [
        {
          kind: "control-action-record",
          description:
            "A digest-chained OperatorControlLog ControlActionRecord with non-empty reason and evidence references (the log refuses empty evidence).",
          minimum: 1,
        },
      ],
      rollback: {
        mode: "REVERSIBLE",
        description:
          "Resume the campaign — resume mints the next epoch; paused-window accruals stay absent by design (not backfilled).",
        compensatingActionId: "resume-campaign",
        reversalWindow: "until the campaign's effective end epoch",
      },
      runbookEntryId: "rb-campaign-pause-resume",
      emitsEvent: "campaign.control-action",
      invariants: ["INV-P07"],
    },
    {
      actionId: "resume-campaign",
      version: 1,
      title: "Resume a paused incentive campaign",
      description:
        "Resume a paused campaign; resume mints a new campaign epoch and is valid only for a paused, non-closed campaign.",
      authorityLevel: "OPERATOR",
      evidence: [
        {
          kind: "control-action-record",
          description:
            "A digest-chained OperatorControlLog ControlActionRecord with non-empty reason and evidence references.",
          minimum: 1,
        },
      ],
      rollback: {
        mode: "REVERSIBLE",
        description:
          "Pause the campaign again (another epoch) — no accrued rewards are affected.",
        compensatingActionId: "pause-campaign",
        reversalWindow: "until the campaign's effective end epoch",
      },
      runbookEntryId: "rb-campaign-pause-resume",
      emitsEvent: "campaign.control-action",
      invariants: ["INV-P07"],
    },
    {
      actionId: "release-quarantine",
      version: 1,
      title: "Release a component from security quarantine",
      description:
        "Release a quarantined component after the owning advisory closes or remediates. Release requires a NEW security epoch so quarantined components cannot regain access through cached capability state (INV-S03) — every sensitive delegated action re-checks the epoch (INV-S02).",
      authorityLevel: "SECURITY_OFFICER",
      evidence: [
        {
          kind: "advisory-closure",
          description:
            "The closed security advisory that imposed the quarantine, with its remediation guidance satisfied.",
          minimum: 1,
        },
        {
          kind: "remediation-record",
          description:
            "A remediation record for the affected component demonstrating the vulnerability is fixed (advisory remediation guidance satisfied).",
          minimum: 1,
        },
        {
          kind: "epoch-bump-record",
          description:
            "The security epoch bump executed atomically with the release, so cached capability state cannot survive.",
          minimum: 1,
        },
      ],
      rollback: {
        mode: "COMPENSATING_ACTION",
        description:
          "Re-quarantine the component by publishing a new advisory (or re-imposing under the incident) and bump the epoch again; any access granted between release and re-quarantine is in the enforcement audit.",
        compensatingActionId: "bump-security-epoch",
        reversalWindow: "immediate — use the incident channel",
      },
      runbookEntryId: "rb-security-quarantine",
      emitsEvent: "security.quarantine-release-requested",
      invariants: ["INV-S01", "INV-S02", "INV-S03"],
    },
    {
      actionId: "trigger-reconciliation",
      version: 1,
      title: "Trigger reconciliation for an ambiguous effect",
      description:
        "Open (or force-schedule) a reconciliation case for an UNKNOWN execution attempt or settlement outcome. Reconciliation is the AUTHORITATIVE resolution path for external ambiguity (INV-X03) — the trigger never writes an outcome itself, it schedules the case with its evidence.",
      authorityLevel: "OPERATOR",
      evidence: [
        {
          kind: "ambiguity-evidence",
          description:
            "The execution evidence showing the ambiguous external effect (attempt record, provider state envelope, or rail incident classification).",
          minimum: 1,
        },
      ],
      rollback: {
        mode: "REVERSIBLE",
        description:
          "Closing the case without resolution (withdrawn) is always available; the case itself is an append-only record and stays in history (INV-E05).",
        reversalWindow: "until the case resolves",
      },
      runbookEntryId: "rb-unknown-outcome",
      emitsEvent: "reconciliation.case-opened",
      invariants: ["INV-X01", "INV-X02", "INV-X03"],
    },
    {
      actionId: "rail-cutover",
      version: 1,
      title: "Cut over from one rail to an alternate",
      description:
        "Move execution from an unhealthy or retiring rail to an alternate connected instance. In-flight attempts on the old rail must be drained or reconciled FIRST (INV-X02 — no blind retry); the cutover must respect ConnectedCapabilityInstance scope on the target (INV-C05/INV-NC04 — the target must actually be reachable and authorized).",
      authorityLevel: "SENIOR_OPERATOR",
      evidence: [
        {
          kind: "rail-incident",
          description:
            "The rail incident record classifying the outage (or the retirement plan) motivating the cutover.",
          minimum: 1,
        },
        {
          kind: "in-flight-drain-report",
          description:
            "A report showing every in-flight attempt on the old rail is terminal or has an open reconciliation case.",
          minimum: 1,
        },
        {
          kind: "target-capability-authorization",
          description:
            "The target rail's ConnectedCapabilityInstance showing actual account authorization, eligibility, geography/currency scope.",
          minimum: 1,
        },
      ],
      rollback: {
        mode: "COMPENSATING_ACTION",
        description:
          "Cut back to the original rail once its incident closes (in-flight attempts on the alternate must drain/reconcile first); both cutovers append to the rail incident record.",
        compensatingActionId: "rail-cutover",
        reversalWindow: "while the original rail remains authorized",
      },
      runbookEntryId: "rb-rail-outage",
      emitsEvent: "rail.cutover-executed",
      invariants: ["INV-X02", "INV-C05", "INV-NC04"],
    },
    {
      actionId: "bump-security-epoch",
      version: 1,
      title: "Bump the security epoch",
      description:
        "Advance the security epoch so authorizations minted under earlier epochs stop authorizing sensitive delegated actions (INV-A02/INV-S02). Required atomically with quarantine release and with rotation of authorization-sensitive keys (webhook signing key).",
      authorityLevel: "SECURITY_OFFICER",
      evidence: [
        {
          kind: "epoch-bump-reason",
          description:
            "The reason record: the advisory, key-rotation procedure, or quarantine release the bump accompanies.",
          minimum: 1,
        },
      ],
      rollback: {
        mode: "IRREVERSIBLE_WITH_AUDIT",
        description:
          "Epoch advancement cannot be undone (re-dispatching stale authorizations is exactly what the bump prevents); the compensating path is issuing fresh authorizations under the new epoch for legitimately affected principals, with the full enforcement audit retained (INV-E05).",
      },
      runbookEntryId: "rb-security-epoch-bump",
      emitsEvent: "security.epoch-bumped",
      invariants: ["INV-A02", "INV-S02", "INV-E05"],
    },
  ]);

export function operatorAction(
  actionId: string,
): OperatorActionDeclaration | undefined {
  return OPERATOR_ACTIONS.find((action) => action.actionId === actionId);
}

// ---------------------------------------------------------------------------
// Catalog checker — authority + evidence + rollback + runbook linkage
// ---------------------------------------------------------------------------

export interface ActionCatalogViolation {
  readonly actionId: string;
  readonly detail: string;
}

export interface ActionCatalogReport {
  readonly passed: boolean;
  readonly violations: readonly ActionCatalogViolation[];
}

/**
 * Check the operator-action catalog: every action has a valid authority
 * level, at least one evidence requirement (≥1 artifact), a declared
 * rollback path with the fields its mode requires, a referenced runbook
 * entry that exists in the supplied index, a declared emitted event, and
 * compensating-action references that resolve inside the catalog.
 */
export function checkOperatorActionCatalog(
  actions: readonly OperatorActionDeclaration[] = OPERATOR_ACTIONS,
  runbookEntryIds: readonly string[],
): ActionCatalogReport {
  const known = new Set(runbookEntryIds);
  const ids = new Set(actions.map((action) => action.actionId));
  const violations: ActionCatalogViolation[] = [];

  if (actions.length === 0) {
    return { passed: false, violations: [{ actionId: "*", detail: "empty catalog" }] };
  }

  for (const action of actions) {
    if (!isOperatorAuthorityLevel(action.authorityLevel)) {
      violations.push({
        actionId: action.actionId,
        detail: `invalid authority level '${String(action.authorityLevel)}'`,
      });
    }
    if (action.version < 1) {
      violations.push({
        actionId: action.actionId,
        detail: "version must be a positive integer",
      });
    }
    const evidenceMinimums = action.evidence.filter(
      (requirement) => requirement.minimum < 1,
    );
    if (action.evidence.length === 0 || evidenceMinimums.length > 0) {
      violations.push({
        actionId: action.actionId,
        detail: "every action needs ≥1 evidence requirement with minimum ≥1",
      });
    }
    if (action.rollback.mode === "COMPENSATING_ACTION") {
      if (
        action.rollback.compensatingActionId === undefined ||
        !ids.has(action.rollback.compensatingActionId)
      ) {
        violations.push({
          actionId: action.actionId,
          detail: "compensating action rollback must reference a catalog action",
        });
      }
    }
    if (action.rollback.mode === "IRREVERSIBLE_WITH_AUDIT") {
      if (action.rollback.compensatingActionId !== undefined) {
        violations.push({
          actionId: action.actionId,
          detail: "irreversible-with-audit rollback cannot declare a compensating action",
        });
      }
    }
    if (!known.has(action.runbookEntryId)) {
      violations.push({
        actionId: action.actionId,
        detail: `runbook entry '${action.runbookEntryId}' does not exist (dangling reference)`,
      });
    }
    if (!action.emitsEvent) {
      violations.push({
        actionId: action.actionId,
        detail: "action declares no emitted observability event",
      });
    }
  }

  const duplicates = ids.size !== actions.length;
  if (duplicates) {
    violations.push({
      actionId: "*",
      detail: "duplicate actionId in catalog",
    });
  }

  return { passed: violations.length === 0, violations };
}

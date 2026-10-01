/**
 * @payswap/operations — the assembled operator runbook (W3-007).
 *
 * The runbook principle: SYMPTOM → DIAGNOSIS → ACTION → VERIFICATION.
 * Assembly is the whole game:
 *
 *  - RECOVERY PLAYBOOKS become runbook entries (each scenario's symptom,
 *    diagnosis, action and verification carry over);
 *  - SUPPLEMENTARY OPERATIONS ENTRIES cover the operational conditions that
 *    alert but are not incident playbooks (parity drift, secret exposure,
 *    outbox backlog, browser journey failures, campaign controls,
 *    epoch bumps) — no alert exists without its entry;
 *  - OPERATOR ACTIONS and ALERT RULES reference entries by ID; the
 *    assembled index is the single source of truth for existence;
 *  - `checkRunbookIntegrity` enforces the no-orphan-alerts law and the
 *    no-dangling-reference law in BOTH directions: every alert maps to an
 *    entry, every operator action maps to an entry, and every entry lists
 *    the signals (events/alerts) that route operators into it.
 *
 * Deterministic only: pure assembly over declared data.
 */

import type { AlertRule } from "./observability.js";
import { ALERT_RULES } from "./observability.js";
import type { OperatorActionDeclaration } from "./operator-actions.js";
import { OPERATOR_ACTIONS } from "./operator-actions.js";
import type { RecoveryPlaybook } from "./recovery.js";
import { RECOVERY_PLAYBOOKS } from "./recovery.js";

// ---------------------------------------------------------------------------
// Runbook entries
// ---------------------------------------------------------------------------

export interface RunbookEntry {
  readonly entryId: string;
  readonly title: string;
  /** The observable condition that routes an operator here. */
  readonly symptom: string;
  readonly diagnosis: readonly string[];
  readonly action: readonly string[];
  readonly verification: readonly string[];
  /** Operator actions documented by this entry (must exist in the catalog). */
  readonly operatorActionIds: readonly string[];
  /** The invariants this entry protects/makes observable. */
  readonly invariants: readonly string[];
  /** The observability event names that signal this entry. */
  readonly signals: readonly string[];
  readonly source:
    | "RECOVERY_PLAYBOOK"
    | "OPERATIONS_ENTRY"
    | "DRILL_ENTRY";
}

/** Supplementary operational entries (non-incident conditions that alert). */
const OPERATIONS_ENTRIES: readonly RunbookEntry[] = Object.freeze([
  {
    entryId: "rb-outbox-backlog",
    title: "Outbox backlog growing",
    symptom:
      "outbox.backlog-growing alert: the outbox drain is falling behind committed mutations — events are delayed (never lost while the contract holds).",
    diagnosis: [
      "Check the drain rate vs enqueue rate by eventId — is the publisher slow or the enqueue rate spiking?",
      "Check for fail-stopped drains: an ambiguous publication (outbox.publication-ambiguous) halts the drain until its reconciliation case resolves.",
      "Check publisher health and the deterministic backoff schedule — attempts and next-eligibility are pure functions of state (INV-O01).",
    ],
    action: [
      "Resolve any ambiguous publication through the UNKNOWN-outcome entry first (the drain cannot resume past it).",
      "Scale the draining worker role (the outbox is a table drain; single-writer discipline stays per aggregate).",
      "If a publisher is systematically failing, cut over its rail per the rail-outage entry — the outbox itself never drops events.",
    ],
    verification: [
      "Backlog depth returns to zero and outbox.record-published events resume for every committed mutation (INV-O02).",
      "The weekly no-loss drill (drill-outbox-no-loss) stays green.",
    ],
    operatorActionIds: [],
    invariants: ["INV-O01", "INV-O02"],
    signals: ["outbox.backlog-growing"],
    source: "OPERATIONS_ENTRY",
  },
  {
    entryId: "rb-outbox-ambiguity",
    title: "Ambiguous outbox publication (drain fail-stopped)",
    symptom:
      "outbox.publication-ambiguous alert: a publisher threw ExternalAmbiguityError; the drain FAILS STOP, the record stays PENDING with attempts untouched, and no blind retry is scheduled.",
    diagnosis: [
      "Identify the record by eventId/commandId — which external sink produced the ambiguity.",
      "Determine whether the sink observed the write: query the sink-side state for the event id.",
    ],
    action: [
      "Open/resolve a reconciliation case for the ambiguous publication (reconciliation is authoritative, INV-X03).",
      "After resolution, resume the drain — the record publishes or is marked per the resolution; it is NEVER coerced to FAILED while ambiguous (INV-X01).",
    ],
    verification: [
      "The record leaves PENDING with a resolution-backed status and evidence.",
      "No duplicate external effect was created by the resumed drain (publishers are idempotent, at-least-once).",
    ],
    operatorActionIds: ["trigger-reconciliation"],
    invariants: ["INV-O01", "INV-O02", "INV-X01", "INV-X02", "INV-X03"],
    signals: ["outbox.publication-ambiguous"],
    source: "OPERATIONS_ENTRY",
  },
  {
    entryId: "rb-retry-safety",
    title: "Retry-safety drill (INV-O01)",
    symptom:
      "The scheduled retry-safety drill is due (or a retry-related regression is suspected): async commands must be retry-safe with single-effect semantics.",
    diagnosis: [
      "Confirm the drill environment reflects the current release (canary publisher/adapter with injected transient failures).",
    ],
    action: [
      "Run drill-retry-safety (recovery.ts): transient-failure retries follow the deterministic backoff; redelivered idempotency keys produce ONE authoritative result; ambiguous writes fail-stop with no automatic retry.",
    ],
    verification: [
      "The drill completes with all four checks green: deterministic backoff, single-effect retries, fail-stop on ambiguity, exactly-once-after-resolution publication.",
    ],
    operatorActionIds: [],
    invariants: ["INV-O01", "INV-F05", "INV-X02"],
    signals: ["deployment.gate-result"],
    source: "DRILL_ENTRY",
  },
  {
    entryId: "rb-parity-drift",
    title: "Preview/production configuration drift",
    symptom:
      "deployment.parity-drift-detected alert (or the release gate's parity check failed): preview and production manifests differ outside the explicit environment allowlist.",
    diagnosis: [
      "Run verifyEnvironmentParity over the two manifests — the report lists per-service version drift and unexpected config differences.",
      "Classify the drift: forgotten promotion (preview ahead of production) vs divergence (someone edited production directly).",
    ],
    action: [
      "Promote the drifted configuration through the normal release path (preview exists to prove the production shape).",
      "For direct-production edits: either promote the same change to preview or revert production — parity is the contract, not a preference.",
    ],
    verification: [
      "verifyEnvironmentParity passes: same service set, same versions, differences only on PARITY_ALLOWED_DIFFERENCES.",
      "The release gate's parity check is green on the next deploy.",
    ],
    operatorActionIds: [],
    invariants: [],
    signals: ["deployment.parity-drift-detected", "deployment.gate-result"],
    source: "OPERATIONS_ENTRY",
  },
  {
    entryId: "rb-secret-exposure",
    title: "Secret exposure detected in a config artifact",
    symptom:
      "secrets.exposure-detected alert (or the §6 gate-3 scan failed): a config artifact contains a secret VALUE or a direct (non-`*_REF`) secret key.",
    diagnosis: [
      "Run checkSecretReferenceHygiene over the offending manifest — the report lists forbidden keys and embedded secret values per service.",
      "Identify the artifact's provenance: which deploy/PR introduced it.",
    ],
    action: [
      "Remove the exposed value from the artifact immediately; rotate the exposed secret through its rotation procedure (secrets.ts) — exposure invalidates the key's confidentiality.",
      "For authorization-sensitive keys (webhook signing), execute the epoch bump as part of the rotation so authorizations under the exposed key are refused (INV-A02).",
      "Purge the value from git history where feasible and record the incident (INV-S04 feeds security learning).",
    ],
    verification: [
      "checkSecretReferenceHygiene passes on the corrected manifest.",
      "The rotated key resolves and the old (exposed) key is revoked with evidence.",
    ],
    operatorActionIds: ["bump-security-epoch"],
    invariants: ["INV-A02", "INV-S04"],
    signals: ["secrets.exposure-detected"],
    source: "OPERATIONS_ENTRY",
  },
  {
    entryId: "rb-browser-journey-failure",
    title: "Browser journey verification failure",
    symptom:
      "browser-journey-failed alert (or the §6 gate-7 check failed): a browser journey run failed one of its six checks — console errors, dead buttons, missing screenshot, or missing real API wiring.",
    diagnosis: [
      "Read the failing run's report (recordBrowserVerificationRun): which journey and which check failed.",
      "For console errors: capture the console log and locate the throwing surface.",
      "For dead buttons: the no-dead-buttons contract — a non-terminal state with zero available actions — points at the view-model fold.",
      "For wiring: confirm the surface consumes the @payswap/api handler (a bypassed or fabricated path is a contract violation, not a shortcut).",
    ],
    action: [
      "Fix the surface so the view is a one-to-one projection of authority state — never infer success from a spinner disappearing or failure from an unreachable network.",
      "Re-run the six checks (desktop, responsive/mobile, console-error, key interactions, screenshot artifact, real API wiring evidence).",
    ],
    verification: [
      "The browser verification report for the journey passes all six checks with evidence references.",
      "checkBrowserJourneyContracts stays green (contracts match the view-model state tables).",
    ],
    operatorActionIds: [],
    invariants: ["INV-E04", "INV-X01"],
    signals: ["browser.verification-run"],
    source: "OPERATIONS_ENTRY",
  },
  {
    entryId: "rb-campaign-pause-resume",
    title: "Pause / resume an incentive campaign",
    symptom:
      "An operator needs to stop new accruals on a campaign (quality issue, dispute wave, funding correction) — or resume a previously paused one.",
    diagnosis: [
      "Confirm the campaign's current epoch and state by campaignId — paused campaigns can resume; closed campaigns cannot.",
      "Confirm in-flight rewards' settlement state — pause stops accruals, it does not cancel already-settled obligations.",
    ],
    action: [
      "Execute pause-campaign (or resume-campaign) with a non-empty reason and evidence references — the OperatorControlLog refuses empty evidence and mints a new epoch (INV-P07).",
      "For systemic attribution problems, follow the incentive-dispute-clawback entry before resuming.",
    ],
    verification: [
      "campaign.control-action event fires with the campaignId; the campaign's next accrual evaluation runs under the new epoch.",
      "The control log's digest chain verifies (append-only, tamper-evident).",
    ],
    operatorActionIds: ["pause-campaign", "resume-campaign"],
    invariants: ["INV-P07"],
    signals: ["campaign.control-action"],
    source: "OPERATIONS_ENTRY",
  },
  {
    entryId: "rb-security-epoch-bump",
    title: "Bump the security epoch",
    symptom:
      "A security event requires invalidating existing sensitive delegated authorizations: key rotation of authorization-sensitive secrets, quarantine release, or a suspected authorization compromise.",
    diagnosis: [
      "Identify the reason record (rotation procedure, advisory, or release) that requires the bump.",
      "Inventory the sensitive delegated actions currently in flight — epoch bumps invalidate their authorizations by design (INV-A02).",
    ],
    action: [
      "Execute bump-security-epoch with the reason evidence; every sensitive delegated action re-checks the epoch on next authorization (INV-S02).",
      "Notify affected principals where legitimate in-flight approvals must be re-issued under the new epoch.",
    ],
    verification: [
      "security.epoch-bumped fires with the new epoch.",
      "A stale-epoch authorization attempt is denied with an enforcement record; fresh authorizations succeed.",
    ],
    operatorActionIds: ["bump-security-epoch"],
    invariants: ["INV-A02", "INV-S02", "INV-E05"],
    signals: ["security.epoch-bumped"],
    source: "OPERATIONS_ENTRY",
  },
]);

/** Playbooks become entries 1:1 (symptom → diagnosis → action → verification). */
function playbookToEntry(playbook: RecoveryPlaybook): RunbookEntry {
  return {
    entryId: playbook.runbookEntryId,
    title: playbook.scenario,
    symptom: playbook.symptom,
    diagnosis: playbook.diagnosis,
    action: playbook.steps.map(
      (step) =>
        `${step.stepId}: ${step.description}${
          step.operatorActionId === undefined
            ? ""
            : ` [operator action: ${step.operatorActionId}]`
        }`,
    ),
    verification: playbook.verification,
    operatorActionIds: playbook.steps
      .map((step) => step.operatorActionId)
      .filter((id): id is string => id !== undefined),
    invariants: playbook.invariantsExercised,
    signals: [],
    source: "RECOVERY_PLAYBOOK",
  };
}

/** The signals (taxonomy event names) that route into each playbook entry. */
const PLAYBOOK_SIGNALS: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    "rb-unknown-outcome": [
      "execution.attempt.outcome-unknown",
      "execution.attempt.awaiting-reconciliation",
      "reconciliation.case-opened",
      "reconciliation.case-resolved",
    ],
    "rb-security-quarantine": [
      "security.quarantine-imposed",
      "security.advisory-published",
      "security.capability-access-denied-by-quarantine",
    ],
    "rb-incentive-dispute-clawback": [
      "campaign.incentive-dispute-opened",
      "participation.clawback-adjustment",
    ],
    "rb-rail-outage": ["rail.outage-detected", "rail.incident-classified"],
    "rb-restore-replay": ["deployment.restore-replay-drill"],
  });

/**
 * Assemble the indexed operations runbook: playbooks + operations entries,
 * each annotated with the alert IDs and event signals that route into it.
 */
export function buildOperationsRunbook(input?: {
  readonly playbooks?: readonly RecoveryPlaybook[];
  readonly alerts?: readonly AlertRule[];
}): readonly RunbookEntry[] {
  const playbooks = input?.playbooks ?? RECOVERY_PLAYBOOKS;
  const alerts = input?.alerts ?? ALERT_RULES;

  const entries: RunbookEntry[] = [
    ...playbooks.map((playbook) => {
      const entry = playbookToEntry(playbook);
      const eventSignals = PLAYBOOK_SIGNALS[entry.entryId] ?? [];
      return {
        ...entry,
        signals: eventSignals,
      };
    }),
    ...OPERATIONS_ENTRIES,
  ];

  // attach alert IDs to their entries' signals
  for (const alert of alerts) {
    const entry = entries.find((candidate) => candidate.entryId === alert.runbookEntryId);
    if (entry !== undefined) {
      const alertSignal = `alert:${alert.alertId}`;
      const index = entries.indexOf(entry);
      entries[index] = {
        ...entry,
        signals: [...entry.signals, alertSignal],
      };
    }
  }

  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.entryId)) {
      throw new Error(`runbook assembly produced duplicate entry '${entry.entryId}'`);
    }
    seen.add(entry.entryId);
  }
  return entries;
}

/** The assembled runbook (the single indexed source of truth). */
export const OPERATIONS_RUNBOOK: readonly RunbookEntry[] = Object.freeze(
  buildOperationsRunbook(),
);

/** The assembled runbook's entry IDs (existence source for references). */
export const OPERATIONS_RUNBOOK_ENTRY_IDS: readonly string[] = OPERATIONS_RUNBOOK.map(
  (entry) => entry.entryId,
);

/** Look up an entry by ID. */
export function runbookEntry(entryId: string): RunbookEntry | undefined {
  return OPERATIONS_RUNBOOK.find((entry) => entry.entryId === entryId);
}

/** Resolve the runbook entry an alert routes to (throws on orphans). */
export function runbookEntryForAlert(alert: AlertRule): RunbookEntry {
  const entry = runbookEntry(alert.runbookEntryId);
  if (entry === undefined) {
    throw new Error(
      `orphan alert '${alert.alertId}': runbook entry '${alert.runbookEntryId}' does not exist`,
    );
  }
  return entry;
}

/** All entries that list a given operator action. */
export function entriesForOperatorAction(
  action: OperatorActionDeclaration,
): readonly RunbookEntry[] {
  return OPERATIONS_RUNBOOK.filter((entry) =>
    entry.operatorActionIds.includes(action.actionId),
  );
}

// ---------------------------------------------------------------------------
// Integrity checks — no orphan alerts, no dangling references
// ---------------------------------------------------------------------------

export interface RunbookIntegrityReport {
  readonly passed: boolean;
  readonly entryCount: number;
  readonly orphanAlerts: readonly string[];
  readonly danglingActionReferences: readonly string[];
  readonly emptySignals: readonly string[];
  readonly incompleteEntries: readonly string[];
}

/**
 * The runbook integrity check:
 *  1. NO ORPHAN ALERTS — every alert rule's runbookEntryId exists;
 *  2. NO DANGLING REFERENCES — every operator action's runbookEntryId
 *     exists, and every entry's operatorActionIds resolve in the catalog;
 *  3. NO SILENT ENTRIES — every entry declares at least one signal
 *     (event or alert) that routes operators into it;
 *  4. COMPLETE ENTRIES — symptom, diagnosis, action and verification are
 *     all non-empty (the runbook principle, structural).
 */
export function checkRunbookIntegrity(input?: {
  readonly entries?: readonly RunbookEntry[];
  readonly alerts?: readonly AlertRule[];
  readonly actions?: readonly OperatorActionDeclaration[];
}): RunbookIntegrityReport {
  const entries = input?.entries ?? OPERATIONS_RUNBOOK;
  const alerts = input?.alerts ?? ALERT_RULES;
  const actions = input?.actions ?? OPERATOR_ACTIONS;

  const entryIds = new Set(entries.map((entry) => entry.entryId));
  const actionIds = new Set(actions.map((action) => action.actionId));

  const orphanAlerts = alerts
    .filter((alert) => !entryIds.has(alert.runbookEntryId))
    .map((alert) => alert.alertId);

  const danglingActionReferences: string[] = [];
  for (const action of actions) {
    if (!entryIds.has(action.runbookEntryId)) {
      danglingActionReferences.push(
        `${action.actionId} -> ${action.runbookEntryId}`,
      );
    }
  }
  for (const entry of entries) {
    for (const actionId of entry.operatorActionIds) {
      if (!actionIds.has(actionId)) {
        danglingActionReferences.push(`${entry.entryId} -> ${actionId}`);
      }
    }
  }

  const emptySignals = entries
    .filter((entry) => entry.signals.length === 0)
    .map((entry) => entry.entryId);

  const incompleteEntries = entries
    .filter(
      (entry) =>
        !entry.symptom ||
        entry.diagnosis.length === 0 ||
        entry.action.length === 0 ||
        entry.verification.length === 0,
    )
    .map((entry) => entry.entryId);

  return {
    passed:
      orphanAlerts.length === 0 &&
      danglingActionReferences.length === 0 &&
      emptySignals.length === 0 &&
      incompleteEntries.length === 0,
    entryCount: entries.length,
    orphanAlerts,
    danglingActionReferences,
    emptySignals,
    incompleteEntries,
  };
}

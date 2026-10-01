/**
 * @payswap/operations — recovery playbooks (W3-007).
 *
 * Authority: spec/work-items/W3-007.md acceptance ("operators can diagnose
 * UNKNOWN, security quarantine, incentive disputes and rail outages") +
 * the runbook principle: every procedure is SYMPTOM → DIAGNOSIS → ACTION →
 * VERIFICATION, and every action referenced by a playbook step must be an
 * evidenced operator action from operator-actions.ts.
 *
 * Playbooks are DATA assembled into the indexed runbook (runbook.ts). The
 * five W3-007 diagnosis scenarios are covered by playbooks, plus the two
 * operational resilience drills that the deployment gates require:
 *  - retry-safety drill (INV-O01);
 *  - outbox no-loss drill (INV-O02);
 *  - restore/replay drill (INV-O04) — the reconstruction procedure itself
 *    lives in deployment.ts (RESTORE_REPLAY_PROCEDURE) and the playbook
 *    references it.
 *
 * Deterministic only: declarations + a coverage checker. Executing a
 * playbook is the production operator console's job.
 */

// ---------------------------------------------------------------------------
// Playbook shapes
// ---------------------------------------------------------------------------

export interface RecoveryStep {
  readonly stepId: string;
  readonly description: string;
  /** The evidenced operator action this step executes, if any. */
  readonly operatorActionId?: string;
  /** Automated steps run through the platform; manual steps need an operator. */
  readonly automated: boolean;
}

export interface RecoveryPlaybook {
  readonly playbookId: string;
  /** The runbook entry this playbook backs (assembly links them). */
  readonly runbookEntryId: string;
  readonly scenario: string;
  /** What the operator sees (the alert/surface). */
  readonly symptom: string;
  /** How to confirm the diagnosis (queries over protocol IDs). */
  readonly diagnosis: readonly string[];
  readonly steps: readonly RecoveryStep[];
  /** How to verify the recovery worked (protocol-ID-keyed checks). */
  readonly verification: readonly string[];
  readonly invariantsExercised: readonly string[];
  readonly escalation: string;
}

/** A rehearsed drill: scheduled verification of a resilience property. */
export interface OperationalDrill {
  readonly drillId: string;
  readonly title: string;
  /** How often the drill must run for the release gate to stay green. */
  readonly cadence: string;
  readonly procedure: readonly string[];
  readonly invariantsExercised: readonly string[];
  readonly runbookEntryId: string;
}

// ---------------------------------------------------------------------------
// The recovery playbooks
// ---------------------------------------------------------------------------

export const RECOVERY_PLAYBOOKS: readonly RecoveryPlaybook[] = Object.freeze([
  {
    playbookId: "pb-unknown-outcome",
    runbookEntryId: "rb-unknown-outcome",
    scenario: "UNKNOWN execution/settlement outcome",
    symptom:
      "execution.attempt.outcome-unknown alert: an attempt's external outcome cannot be determined (timeout, provider error, connection lost mid-write); the browser surface renders the honest `reconciling` view with the reconciliation path surfaced — never a failure.",
    diagnosis: [
      "Query the attempt by attemptId — the execution evidence shows the ambiguity (no terminal provider state, ExternalAmbiguityError recorded).",
      "Pull the ProviderStateEnvelope by attemptId — the provider's native state (including provider-side external IDs/revisions) decides what is already knowable (INV-C06: never lossy-mapped).",
      "Check for an existing reconciliation case on the attempt — reconciliation is the AUTHORITATIVE resolution path (INV-X03).",
      "Confirm the command was NOT blindly retried: the idempotency registrar must show the original command still mapped to the in-flight/UNKNOWN attempt (INV-F05, INV-X02).",
    ],
    steps: [
      {
        stepId: "stop-automatic-retries",
        description:
          "Verify no blind retry is scheduled: the outbox drain and execution plane fail-stop on ambiguity; if any scheduled retry exists, cancel it (UNKNOWN external writes cannot be blindly retried, INV-X02).",
        automated: true,
      },
      {
        stepId: "open-reconciliation-case",
        description:
          "Open a reconciliation case keyed to the attempt and its obligation, attaching the execution evidence and provider state envelope.",
        operatorActionId: "trigger-reconciliation",
        automated: false,
      },
      {
        stepId: "observe-provider-state",
        description:
          "Observe the provider's native state for the external ID(s) in the envelope; the observation — not optimism — determines what happened (INV-C09 semantics: observations are observations).",
        automated: true,
      },
      {
        stepId: "record-authoritative-resolution",
        description:
          "Record the reconciliation resolution (SUCCEEDED/FAILED with evidence): ONLY the reconciliation authority changes the terminal presentation of an ambiguous effect (INV-X03/X04).",
        automated: true,
      },
      {
        stepId: "resume-outbox-drain",
        description:
          "After resolution, resume the outbox drain — the previously fail-stopped record publishes with its reconciliation case reference.",
        automated: true,
      },
    ],
    verification: [
      "The attempt shows a terminal state with evidence lineage (INV-E02/E03) and the reconciliation case is resolved with a resolution record.",
      "settlement.terminal-transition.* fired with settlementId+obligationId+evidenceId correlation keys.",
      "No second external effect exists for the same command (idempotency registrar shows one authoritative result, INV-F05).",
    ],
    invariantsExercised: ["INV-X01", "INV-X02", "INV-X03", "INV-F05", "INV-C06"],
    escalation:
      "If the provider cannot produce a decisive observation within the case SLA, escalate to the reconciliation worker owner; a case may never be closed by guessing (no UNKNOWN → FAILED coercion).",
  },
  {
    playbookId: "pb-security-quarantine",
    runbookEntryId: "rb-security-quarantine",
    scenario: "Security quarantine of a component",
    symptom:
      "security-quarantine-imposed alert: a security advisory quarantined a component (adapter, extension, package); capability accesses through it are denied with an enforcement record.",
    diagnosis: [
      "Read the advisory by advisoryId — its severity, affected components and remediation guidance (INV-S01: advisories restrict affected components globally).",
      "Check the current security epoch and the quarantine record — enforcement is epoch-checked (INV-S02).",
      "Confirm cached capability state is NOT serving the quarantined component: accesses must deny through the enforcement path, not through stale cache (INV-S03).",
      "Inventory affected in-flight executions keyed by attemptId — which journeys slow down or need re-routing.",
    ],
    steps: [
      {
        stepId: "verify-restriction-scope",
        description:
          "Confirm the restriction's scope: which components the advisory restricts/quarantines and which flows depend on them.",
        automated: true,
      },
      {
        stepId: "re-route-execution",
        description:
          "Where an alternate authorized ConnectedCapabilityInstance exists, re-route execution through the rail cutover operator action (target must be actually reachable and authorized, INV-NC04).",
        operatorActionId: "rail-cutover",
        automated: false,
      },
      {
        stepId: "remediate",
        description:
          "Remediate the affected component per the advisory's guidance; record the remediation evidence (INV-S04: incidents feed evidence and security learning).",
        automated: false,
      },
      {
        stepId: "release-with-epoch-bump",
        description:
          "Release the quarantine ONLY after remediation evidence exists, atomically with a security epoch bump so cached capability state cannot survive (INV-S02/S03).",
        operatorActionId: "release-quarantine",
        automated: false,
      },
    ],
    verification: [
      "security.epoch-bumped and security.quarantine-release-requested events are correlated to the advisoryId and new epoch.",
      "Capability accesses through the released component succeed again, and a stale-epoch authorization attempt is denied with an enforcement record.",
      "The advisory shows its closure with remediation references (evidence immutable, INV-E05).",
    ],
    invariantsExercised: ["INV-S01", "INV-S02", "INV-S03", "INV-S04", "INV-A02"],
    escalation:
      "Unremediable component: retire it (advisory action `retire`) and keep the quarantine — never release without remediation evidence.",
  },
  {
    playbookId: "pb-incentive-dispute-clawback",
    runbookEntryId: "rb-incentive-dispute-clawback",
    scenario: "Incentive dispute requiring a clawback",
    symptom:
      "incentive-dispute-opened / clawback-adjustment-created alerts: a participant disputes a reward, or anti-gaming review (INV-P04) invalidated an attribution; a clawback is required.",
    diagnosis: [
      "Load the dispute or anti-gaming finding by campaignId — which accruals are challenged and why.",
      "Re-derive the reward from evidence plus the program version (INV-P03: reward calculations are reproducible) — confirm the challenged amount.",
      "Confirm the budget reservation still covers the adjustment, and the accrual's attribution chain (INV-P02: deterministic and auditable).",
      "Check the participant's contribution history and current reward state (settled vs pending).",
    ],
    steps: [
      {
        stepId: "verify-claim",
        description:
          "Re-run the reward derivation and the anti-Sybil/anti-collusion checks; the dispute resolution must be evidence-based, not negotiated (INV-P03/P04).",
        automated: true,
      },
      {
        stepId: "pause-campaign-if-systemic",
        description:
          "If the invalidity is systemic (attribution bug, collusion ring), pause the campaign first to stop further accruals; pause mints a new epoch (INV-P07).",
        operatorActionId: "pause-campaign",
        automated: false,
      },
      {
        stepId: "create-clawback-adjustment",
        description:
          "Create the clawback as a SEPARATE adjustment obligation through the same clearing machinery — never a silent edit of history (INV-P06: clawbacks create separate adjustment obligations; contribution history remains).",
        automated: true,
      },
      {
        stepId: "settle-adjustment",
        description:
          "Net/settle the adjustment obligation with evidence lineage; if the reward was already paid, the adjustment nets against future rewards or pursues recourse explicitly.",
        automated: true,
      },
    ],
    verification: [
      "participation.clawback-adjustment event fired, correlated to the adjustment obligationId and campaignId.",
      "The participant's contribution history is UNCHANGED — only a new adjustment obligation exists (INV-P06).",
      "The reward ledger reconciles: original accrual + adjustment = settled position, reproducible from evidence + program version (INV-P03).",
    ],
    invariantsExercised: ["INV-P02", "INV-P03", "INV-P04", "INV-P06", "INV-P07"],
    escalation:
      "Collusion ring or fraud indicators: escalate to the security plane (advisory if a component is implicated) and the protocol lead for recourse options.",
  },
  {
    playbookId: "pb-rail-outage",
    runbookEntryId: "rb-rail-outage",
    scenario: "Rail outage / provider degradation",
    symptom:
      "rail-outage-detected alert: a configured rail is failing or degraded; attempts through it are failing or timing out.",
    diagnosis: [
      "Classify the incident by railId — the rail incident recorder's classification decides the outcome semantics (UNKNOWN incidents route to the reconciliation playbook, never to blind retry).",
      "Measure in-flight attempts on the rail keyed by attemptId — which are terminal, which are ambiguous.",
      "Check alternate rails' ConnectedCapabilityInstances for actual authorization/eligibility/geography-currency scope on the needed corridor (INV-C05/INV-NC04).",
      "Check whether terms change on the alternate rail — material term changes require user reauthorization, never silent switch.",
    ],
    steps: [
      {
        stepId: "open-incidents-for-ambiguous-attempts",
        description:
          "For every ambiguous in-flight attempt, open a reconciliation case (INV-X02/X03) — the outage never converts UNKNOWN into FAILED.",
        operatorActionId: "trigger-reconciliation",
        automated: true,
      },
      {
        stepId: "execute-cutover",
        description:
          "Execute the rail cutover to the authorized alternate with the incident, drain-report and target-capability evidence attached.",
        operatorActionId: "rail-cutover",
        automated: false,
      },
      {
        stepId: "surface-term-changes",
        description:
          "Journeys whose material terms change on the alternate rail must land on REAUTHORIZATION_REQUIRED — users approve the new terms explicitly.",
        automated: true,
      },
      {
        stepId: "restore-original-rail",
        description:
          "When the incident closes, cut back with the same evidence discipline (drain or reconcile the alternate's in-flight attempts first).",
        operatorActionId: "rail-cutover",
        automated: false,
      },
    ],
    verification: [
      "rail.cutover-executed events correlate to the railId and the drained attempt set.",
      "No attempt shows a terminal state without evidence; ambiguous attempts all have open/resolved reconciliation cases.",
      "Journeys on the alternate rail either preserve terms or pass through REAUTHORIZATION_REQUIRED.",
    ],
    invariantsExercised: ["INV-X01", "INV-X02", "INV-X03", "INV-C05", "INV-NC04"],
    escalation:
      "No authorized alternate exists for the corridor: surface NO_VIABLE_ROUTE honestly on affected journeys and escalate to the protocol lead — never fabricate a route.",
  },
  {
    playbookId: "pb-restore-replay",
    runbookEntryId: "rb-restore-replay",
    scenario: "State reconstruction after restore (INV-O04 drill)",
    symptom:
      "Data-loss or corruption event requiring a restore: authoritative state must be reconstructed from the journal (or the scheduled restore/replay drill is due — restore/replay must be PROVEN able to reconstruct authoritative state).",
    diagnosis: [
      "Identify the last verified backup point and the journal tail after it.",
      "Confirm the outbox position at the backup point — committed mutations' events must replay.",
      "Inventory in-flight attempts at the backup point for post-restore ambiguity.",
    ],
    steps: [
      {
        stepId: "freeze-writes",
        description:
          "Freeze protocol command intake so no new authoritative mutations race the restore.",
        automated: true,
      },
      {
        stepId: "restore-and-replay",
        description:
          "Execute the RESTORE_REPLAY_PROCEDURE (deployment.ts): restore the append-only journal, replay committed events (idempotency keys keep replays single-effect, INV-F05), drain the outbox (INV-O02), open reconciliation cases for unverifiable external effects (INV-X03), rebuild projections (INV-F02).",
        automated: true,
      },
      {
        stepId: "verify-reconstruction",
        description:
          "Verify every terminal state matches its evidence and every balance projection recomputes from the journal; UNKNOWN outcomes stay UNKNOWN until reconciled (INV-X01).",
        automated: true,
      },
    ],
    verification: [
      "deployment.restore-replay-drill event fires with the drill's evidence reference.",
      "Post-restore balance projections equal the pre-incident values modulo replayed committed mutations — recomputed from the journal, not from a cached projection.",
      "No committed mutation lost its outbox event (INV-O02); replays were single-effect (INV-F05).",
    ],
    invariantsExercised: ["INV-O04", "INV-O02", "INV-F02", "INV-F05", "INV-X01", "INV-X03"],
    escalation:
      "Journal gap beyond the backup: escalate to the protocol lead — the gap must be reconciled against provider-side evidence before reopening intake.",
  },
]);

// ---------------------------------------------------------------------------
// Operational resilience drills (INV-O01 / INV-O02)
// ---------------------------------------------------------------------------

export const OPERATIONAL_DRILLS: readonly OperationalDrill[] = Object.freeze([
  {
    drillId: "drill-retry-safety",
    title: "Retry-safety drill (async commands)",
    cadence: "weekly and before every release gate",
    procedure: [
      "Inject a deterministic transient failure into a canary publisher/adapter and confirm the async command retries with the deterministic backoff schedule — the attempt count and next-eligibility are pure functions of state (INV-O01).",
      "Re-deliver the same command under the same idempotency key and confirm ONE authoritative result (INV-F05) — retries are single-effect.",
      "Force an ambiguous external write and confirm the retry machinery FAILS STOP: no automatic retry is scheduled for the UNKNOWN outcome (INV-X02).",
      "Confirm the resumed drain publishes exactly once per event id after resolution (at-least-once with idempotent publishers).",
    ],
    invariantsExercised: ["INV-O01", "INV-F05", "INV-X02"],
    runbookEntryId: "rb-retry-safety",
  },
  {
    drillId: "drill-outbox-no-loss",
    title: "Outbox no-loss drill (committed mutations)",
    cadence: "weekly and before every release gate",
    procedure: [
      "Commit a batch of journal mutations with their outbox records enqueued in the SAME transaction; crash the process BEFORE any drain.",
      "Restart and drain: every committed mutation's event publishes (INV-O02) — a committed mutation without its event is a contract violation.",
      "Kill the process between publish and mark-PUBLISHED; restart and re-drain: the record re-publishes (at-least-once) and the idempotent consumer applies it once — no loss, no duplicate effect.",
      "Force an ambiguous publication and confirm the record stays PENDING (never FAILED) and the drain requires reconciliation before resuming.",
    ],
    invariantsExercised: ["INV-O02", "INV-O01", "INV-X01"],
    runbookEntryId: "rb-outbox-backlog",
  },
  {
    drillId: "drill-restore-replay",
    title: "Restore/replay drill (authoritative reconstruction)",
    cadence: "monthly",
    procedure: [
      "Execute the pb-restore-replay playbook against a staging copy of production-shaped data.",
      "Verify reconstruction: journal-replayed projections, outbox drain, reconciliation of unverifiable external effects (deployment.ts RESTORE_REPLAY_PROCEDURE).",
    ],
    invariantsExercised: ["INV-O04", "INV-F02"],
    runbookEntryId: "rb-restore-replay",
  },
]);

// ---------------------------------------------------------------------------
// Coverage checker
// ---------------------------------------------------------------------------

export interface RecoveryCoverageViolation {
  readonly scenario: string;
  readonly detail: string;
}

export interface RecoveryCoverageReport {
  readonly passed: boolean;
  readonly coveredScenarios: readonly string[];
  readonly violations: readonly RecoveryCoverageViolation[];
}

/** The five W3-007 acceptance scenarios that must have playbooks. */
export const REQUIRED_RECOVERY_SCENARIOS: readonly string[] = Object.freeze([
  "UNKNOWN execution/settlement outcome",
  "Security quarantine of a component",
  "Incentive dispute requiring a clawback",
  "Rail outage / provider degradation",
  "State reconstruction after restore (INV-O04 drill)",
]);

/**
 * Check recovery coverage: every required scenario has a playbook with a
 * non-empty symptom, diagnosis, steps and verification; every playbook step
 * that references an operator action resolves in the supplied catalog; and
 * the INV-O01/INV-O02 resilience drills exist with their procedures.
 */
export function checkRecoveryCoverage(
  playbooks: readonly RecoveryPlaybook[] = RECOVERY_PLAYBOOKS,
  knownOperatorActionIds: readonly string[],
  drills: readonly OperationalDrill[] = OPERATIONAL_DRILLS,
): RecoveryCoverageReport {
  const actions = new Set(knownOperatorActionIds);
  const violations: RecoveryCoverageViolation[] = [];

  const coveredScenarios = playbooks.map((playbook) => playbook.scenario);
  for (const scenario of REQUIRED_RECOVERY_SCENARIOS) {
    if (!coveredScenarios.includes(scenario)) {
      violations.push({
        scenario,
        detail: "required scenario has no recovery playbook",
      });
    }
  }

  for (const playbook of playbooks) {
    if (!playbook.symptom || !playbook.escalation) {
      violations.push({
        scenario: playbook.scenario,
        detail: "playbook must declare a symptom and an escalation path",
      });
    }
    if (
      playbook.diagnosis.length === 0 ||
      playbook.steps.length === 0 ||
      playbook.verification.length === 0
    ) {
      violations.push({
        scenario: playbook.scenario,
        detail: "playbook needs symptom → diagnosis → action → verification",
      });
    }
    if (playbook.invariantsExercised.length === 0) {
      violations.push({
        scenario: playbook.scenario,
        detail: "playbook declares no exercised invariants",
      });
    }
    for (const step of playbook.steps) {
      if (step.operatorActionId !== undefined) {
        if (!actions.has(step.operatorActionId)) {
          violations.push({
            scenario: playbook.scenario,
            detail: `step '${step.stepId}' references unknown operator action '${step.operatorActionId}'`,
          });
        }
      }
    }
  }

  const drillInvariants = drills.flatMap((drill) => drill.invariantsExercised);
  if (!drillInvariants.includes("INV-O01")) {
    violations.push({
      scenario: "retry-safety drill",
      detail: "no drill exercises INV-O01 (async commands are retry-safe)",
    });
  }
  if (!drillInvariants.includes("INV-O02")) {
    violations.push({
      scenario: "outbox no-loss drill",
      detail: "no drill exercises INV-O02 (outbox no-loss)",
    });
  }
  if (!drillInvariants.includes("INV-O04")) {
    violations.push({
      scenario: "restore/replay drill",
      detail: "no drill exercises INV-O04 (restore/replay reconstruction)",
    });
  }
  for (const drill of drills) {
    if (drill.procedure.length === 0) {
      violations.push({
        scenario: drill.title,
        detail: "drill declares no procedure",
      });
    }
  }

  return {
    passed: violations.length === 0,
    coveredScenarios,
    violations,
  };
}

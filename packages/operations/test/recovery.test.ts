import { describe, expect, it } from "vitest";

import { OPERATOR_ACTIONS } from "../src/operator-actions.js";
import {
  OPERATIONAL_DRILLS,
  RECOVERY_PLAYBOOKS,
  REQUIRED_RECOVERY_SCENARIOS,
  checkRecoveryCoverage,
  type RecoveryPlaybook,
} from "../src/recovery.js";
import {
  OPERATIONS_RUNBOOK,
  checkRunbookIntegrity,
  entriesForOperatorAction,
  runbookEntry,
  runbookEntryForAlert,
} from "../src/runbook.js";
import { ALERT_RULES } from "../src/observability.js";

// ---------------------------------------------------------------------------
// Recovery playbook coverage (W3-007 acceptance)
// ---------------------------------------------------------------------------

describe("recovery playbooks", () => {
  it("covers ALL five required scenarios", () => {
    const report = checkRecoveryCoverage(
      RECOVERY_PLAYBOOKS,
      OPERATOR_ACTIONS.map((action) => action.actionId),
    );
    expect(report.passed).toBe(true);
    expect(report.violations).toEqual([]);
    for (const scenario of REQUIRED_RECOVERY_SCENARIOS) {
      expect(report.coveredScenarios).toContain(scenario);
    }
  });

  it("every playbook follows symptom → diagnosis → action → verification", () => {
    for (const playbook of RECOVERY_PLAYBOOKS) {
      expect(playbook.symptom.length).toBeGreaterThan(0);
      expect(playbook.diagnosis.length).toBeGreaterThan(0);
      expect(playbook.steps.length).toBeGreaterThan(0);
      expect(playbook.verification.length).toBeGreaterThan(0);
      expect(playbook.escalation.length).toBeGreaterThan(0);
      expect(playbook.invariantsExercised.length).toBeGreaterThan(0);
    }
  });

  it("the UNKNOWN playbook never converts UNKNOWN to FAILED (INV-X01/X02/X03)", () => {
    const unknown = RECOVERY_PLAYBOOKS.find(
      (playbook) => playbook.playbookId === "pb-unknown-outcome",
    );
    expect(unknown).toBeDefined();
    expect(unknown?.invariantsExercised).toEqual(
      expect.arrayContaining(["INV-X01", "INV-X02", "INV-X03"]),
    );
    expect(unknown?.steps.some((s) => s.operatorActionId === "trigger-reconciliation")).toBe(
      true,
    );
  });

  it("the quarantine playbook releases only with remediation + epoch bump (INV-S01..S03)", () => {
    const quarantine = RECOVERY_PLAYBOOKS.find(
      (playbook) => playbook.playbookId === "pb-security-quarantine",
    );
    expect(quarantine?.invariantsExercised).toEqual(
      expect.arrayContaining(["INV-S01", "INV-S02", "INV-S03"]),
    );
    expect(
      quarantine?.steps.some((s) => s.operatorActionId === "release-quarantine"),
    ).toBe(true);
  });

  it("the clawback playbook creates SEPARATE adjustment obligations (INV-P06)", () => {
    const clawback = RECOVERY_PLAYBOOKS.find(
      (playbook) => playbook.playbookId === "pb-incentive-dispute-clawback",
    );
    expect(clawback?.invariantsExercised).toContain("INV-P06");
    expect(
      clawback?.verification.some((v) => v.includes("contribution history")),
    ).toBe(true);
    expect(
      clawback?.steps.some((s) => s.operatorActionId === "pause-campaign"),
    ).toBe(true);
  });

  it("the rail-outage playbook drains or reconciles before cutover (INV-X02)", () => {
    const outage = RECOVERY_PLAYBOOKS.find(
      (playbook) => playbook.playbookId === "pb-rail-outage",
    );
    expect(outage?.invariantsExercised).toContain("INV-X02");
    expect(outage?.steps.some((s) => s.operatorActionId === "rail-cutover")).toBe(true);
  });

  it("the restore/replay playbook reconstructs authoritative state (INV-O04)", () => {
    const restore = RECOVERY_PLAYBOOKS.find(
      (playbook) => playbook.playbookId === "pb-restore-replay",
    );
    expect(restore?.invariantsExercised).toContain("INV-O04");
    expect(restore?.steps.length).toBeGreaterThan(0);
  });

  it("the checker DETECTS a missing required scenario", () => {
    const partial: RecoveryPlaybook[] = RECOVERY_PLAYBOOKS.filter(
      (playbook) => playbook.playbookId !== "pb-rail-outage",
    );
    const report = checkRecoveryCoverage(
      partial,
      OPERATOR_ACTIONS.map((action) => action.actionId),
    );
    expect(report.passed).toBe(false);
    expect(
      report.violations.some((v) =>
        v.detail.includes("no recovery playbook"),
      ),
    ).toBe(true);
  });

  it("the checker DETECTS steps referencing unknown operator actions", () => {
    const broken: RecoveryPlaybook = {
      ...RECOVERY_PLAYBOOKS[0]!,
      playbookId: "pb-broken",
      steps: [
        {
          stepId: "s1",
          description: "references a nonexistent action",
          operatorActionId: "does-not-exist",
          automated: false,
        },
      ],
    };
    const report = checkRecoveryCoverage(
      [...RECOVERY_PLAYBOOKS, broken],
      OPERATOR_ACTIONS.map((action) => action.actionId),
    );
    expect(report.passed).toBe(false);
    expect(
      report.violations.some((v) =>
        v.detail.includes("unknown operator action"),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Operational resilience drills (INV-O01 / INV-O02 / INV-O04)
// ---------------------------------------------------------------------------

describe("operational resilience drills", () => {
  it("declares the retry-safety and outbox no-loss drills", () => {
    const ids = OPERATIONAL_DRILLS.map((drill) => drill.drillId);
    expect(ids).toContain("drill-retry-safety");
    expect(ids).toContain("drill-outbox-no-loss");
    expect(ids).toContain("drill-restore-replay");
  });

  it("the retry-safety drill exercises INV-O01 with fail-stop semantics", () => {
    const retryDrill = OPERATIONAL_DRILLS.find(
      (drill) => drill.drillId === "drill-retry-safety",
    );
    expect(retryDrill?.invariantsExercised).toContain("INV-O01");
    expect(retryDrill?.procedure.length).toBeGreaterThan(0);
    expect(
      retryDrill?.procedure.some((step) => step.includes("FAILS STOP")),
    ).toBe(true);
  });

  it("the outbox drill exercises INV-O02 losslessness", () => {
    const outboxDrill = OPERATIONAL_DRILLS.find(
      (drill) => drill.drillId === "drill-outbox-no-loss",
    );
    expect(outboxDrill?.invariantsExercised).toContain("INV-O02");
    expect(
      outboxDrill?.procedure.some((step) =>
        step.includes("SAME transaction"),
      ),
    ).toBe(true);
  });

  it("every drill references an existing runbook entry", () => {
    const entryIds = new Set(
      OPERATIONS_RUNBOOK.map((entry) => entry.entryId),
    );
    for (const drill of OPERATIONAL_DRILLS) {
      expect(entryIds.has(drill.runbookEntryId)).toBe(true);
      expect(drill.procedure.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// The assembled runbook
// ---------------------------------------------------------------------------

describe("the assembled operations runbook", () => {
  it("passes the integrity check (no orphan alerts, no dangling references)", () => {
    const report = checkRunbookIntegrity();
    expect(report.passed).toBe(true);
    expect(report.orphanAlerts).toEqual([]);
    expect(report.danglingActionReferences).toEqual([]);
    expect(report.emptySignals).toEqual([]);
    expect(report.incompleteEntries).toEqual([]);
    expect(report.entryCount).toBeGreaterThan(0);
  });

  it("contains the five scenario entries plus the operational entries", () => {
    const ids = OPERATIONS_RUNBOOK.map((entry) => entry.entryId);
    expect(ids).toEqual(
      expect.arrayContaining([
        "rb-unknown-outcome",
        "rb-security-quarantine",
        "rb-incentive-dispute-clawback",
        "rb-rail-outage",
        "rb-restore-replay",
        "rb-outbox-backlog",
        "rb-outbox-ambiguity",
        "rb-retry-safety",
        "rb-parity-drift",
        "rb-secret-exposure",
        "rb-browser-journey-failure",
        "rb-campaign-pause-resume",
        "rb-security-epoch-bump",
      ]),
    );
  });

  it("every entry follows symptom → diagnosis → action → verification", () => {
    for (const entry of OPERATIONS_RUNBOOK) {
      expect(entry.symptom.length).toBeGreaterThan(0);
      expect(entry.diagnosis.length).toBeGreaterThan(0);
      expect(entry.action.length).toBeGreaterThan(0);
      expect(entry.verification.length).toBeGreaterThan(0);
    }
  });

  it("every alert resolves to its runbook entry (routing)", () => {
    for (const alert of ALERT_RULES) {
      const entry = runbookEntryForAlert(alert);
      expect(entry.entryId).toBe(alert.runbookEntryId);
      expect(entry.signals).toContain(`alert:${alert.alertId}`);
    }
  });

  it("every operator action's entry lists it back (bidirectional linkage)", () => {
    for (const action of OPERATOR_ACTIONS) {
      const entry = runbookEntry(action.runbookEntryId);
      expect(entry).toBeDefined();
      expect(entry?.operatorActionIds).toContain(action.actionId);
      expect(entriesForOperatorAction(action).length).toBeGreaterThan(0);
    }
  });

  it("every entry declares at least one routing signal (no silent entries)", () => {
    for (const entry of OPERATIONS_RUNBOOK) {
      expect(entry.signals.length).toBeGreaterThan(0);
    }
  });

  it("the integrity check DETECTS an orphan alert", () => {
    const report = checkRunbookIntegrity({
      alerts: [
        ...ALERT_RULES,
        {
          alertId: "orphan-alert",
          title: "routes nowhere",
          condition: "never",
          events: ["outbox.backlog-growing"],
          severity: "ticket",
          routes: ["ops-queue"],
          runbookEntryId: "rb-does-not-exist",
          invariants: [],
        },
      ],
    });
    expect(report.passed).toBe(false);
    expect(report.orphanAlerts).toEqual(["orphan-alert"]);
  });

  it("the integrity check DETECTS entries with empty signals", () => {
    const base = OPERATIONS_RUNBOOK[0]!;
    const report = checkRunbookIntegrity({
      entries: [...OPERATIONS_RUNBOOK, { ...base, entryId: "rb-silent", signals: [] }],
    });
    expect(report.passed).toBe(false);
    expect(report.emptySignals).toEqual(["rb-silent"]);
  });
});

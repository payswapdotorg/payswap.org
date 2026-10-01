import { describe, expect, it } from "vitest";

import { OPERATIONS_RUNBOOK_ENTRY_IDS } from "../src/runbook.js";
import {
  OPERATOR_ACTIONS,
  authoritySatisfies,
  checkOperatorActionCatalog,
  operatorAction,
  type OperatorActionDeclaration,
} from "../src/operator-actions.js";

// ---------------------------------------------------------------------------
// The operator-action catalog: authority + evidence + rollback (W3-007)
// ---------------------------------------------------------------------------

describe("operator action catalog", () => {
  it("the catalog passes its own integrity check", () => {
    const report = checkOperatorActionCatalog(
      OPERATOR_ACTIONS,
      OPERATIONS_RUNBOOK_ENTRY_IDS,
    );
    expect(report.passed).toBe(true);
    expect(report.violations).toEqual([]);
  });

  it("contains the six W3-007 operator actions", () => {
    const ids = OPERATOR_ACTIONS.map((action) => action.actionId);
    expect(ids).toEqual(
      expect.arrayContaining([
        "pause-campaign",
        "resume-campaign",
        "release-quarantine",
        "trigger-reconciliation",
        "rail-cutover",
        "bump-security-epoch",
      ]),
    );
  });

  it("EVERY action declares an authority level", () => {
    for (const action of OPERATOR_ACTIONS) {
      expect([
        "OPERATOR",
        "SENIOR_OPERATOR",
        "SECURITY_OFFICER",
        "PROTOCOL_LEAD",
      ]).toContain(action.authorityLevel);
    }
  });

  it("EVERY action requires at least one evidence artifact", () => {
    for (const action of OPERATOR_ACTIONS) {
      expect(action.evidence.length).toBeGreaterThan(0);
      for (const requirement of action.evidence) {
        expect(requirement.minimum).toBeGreaterThanOrEqual(1);
        expect(requirement.description.length).toBeGreaterThan(0);
      }
    }
  });

  it("EVERY action declares a rollback path", () => {
    for (const action of OPERATOR_ACTIONS) {
      expect(["REVERSIBLE", "COMPENSATING_ACTION", "IRREVERSIBLE_WITH_AUDIT"]).toContain(
        action.rollback.mode,
      );
      expect(action.rollback.description.length).toBeGreaterThan(0);
      if (action.rollback.mode === "COMPENSATING_ACTION") {
        const compensating = operatorAction(
          action.rollback.compensatingActionId ?? "",
        );
        expect(compensating).toBeDefined();
      }
    }
  });

  it("quarantine release is gated to the security officer and requires an epoch bump", () => {
    const release = operatorAction("release-quarantine");
    expect(release?.authorityLevel).toBe("SECURITY_OFFICER");
    const kinds = release?.evidence.map((e) => e.kind);
    expect(kinds).toContain("epoch-bump-record");
    expect(release?.invariants).toContain("INV-S03");
  });

  it("rail cutover requires drained in-flight attempts and target authorization (INV-X02/C05)", () => {
    const cutover = operatorAction("rail-cutover");
    const kinds = cutover?.evidence.map((e) => e.kind);
    expect(kinds).toContain("in-flight-drain-report");
    expect(kinds).toContain("target-capability-authorization");
    expect(cutover?.invariants).toContain("INV-X02");
    expect(cutover?.invariants).toContain("INV-C05");
  });

  it("epoch bump is irreversible with a full audit trail and compensating-free rollback", () => {
    const bump = operatorAction("bump-security-epoch");
    expect(bump?.rollback.mode).toBe("IRREVERSIBLE_WITH_AUDIT");
    expect(bump?.rollback.compensatingActionId).toBeUndefined();
    expect(bump?.invariants).toContain("INV-A02");
  });

  it("every action references an existing runbook entry and a declared event", () => {
    const entryIds = new Set(OPERATIONS_RUNBOOK_ENTRY_IDS);
    for (const action of OPERATOR_ACTIONS) {
      expect(entryIds.has(action.runbookEntryId)).toBe(true);
      expect(action.emitsEvent).toBeTruthy();
      expect(action.version).toBeGreaterThanOrEqual(1);
    }
  });

  it("the checker DETECTS missing evidence, bad authority and dangling references", () => {
    const broken: OperatorActionDeclaration = {
      actionId: "broken-action",
      version: 1,
      title: "broken",
      description: "violates every rule",
      authorityLevel: "WIZARD" as "OPERATOR",
      evidence: [],
      rollback: {
        mode: "COMPENSATING_ACTION",
        description: "points nowhere",
        compensatingActionId: "does-not-exist",
      },
      runbookEntryId: "rb-does-not-exist",
      emitsEvent: "",
      invariants: [],
    };
    const report = checkOperatorActionCatalog([broken], []);
    expect(report.passed).toBe(false);
    expect(
      report.violations.some((v) => v.detail.includes("authority level")),
    ).toBe(true);
    expect(
      report.violations.some((v) => v.detail.includes("evidence")),
    ).toBe(true);
    expect(
      report.violations.some((v) => v.detail.includes("compensating action")),
    ).toBe(true);
    expect(
      report.violations.some((v) => v.detail.includes("runbook entry")),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Authority attenuation (INV-A01)
// ---------------------------------------------------------------------------

describe("operator authority levels", () => {
  it("higher authority satisfies lower requirements", () => {
    expect(authoritySatisfies("PROTOCOL_LEAD", "OPERATOR")).toBe(true);
    expect(authoritySatisfies("SECURITY_OFFICER", "SENIOR_OPERATOR")).toBe(true);
    expect(authoritySatisfies("SENIOR_OPERATOR", "SENIOR_OPERATOR")).toBe(true);
  });

  it("lower authority cannot satisfy higher requirements (attenuation)", () => {
    expect(authoritySatisfies("OPERATOR", "SECURITY_OFFICER")).toBe(false);
    expect(authoritySatisfies("OPERATOR", "SENIOR_OPERATOR")).toBe(false);
    expect(authoritySatisfies("SENIOR_OPERATOR", "PROTOCOL_LEAD")).toBe(false);
  });

  it("only security officers may act on security-level actions", () => {
    for (const action of OPERATOR_ACTIONS) {
      if (action.authorityLevel === "SECURITY_OFFICER") {
        expect(authoritySatisfies("OPERATOR", "SECURITY_OFFICER")).toBe(false);
      }
    }
  });
});

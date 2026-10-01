import { describe, expect, it } from "vitest";

import { OPERATIONS_RUNBOOK } from "../src/runbook.js";
import {
  ALERT_RULES,
  CORE_PROTOCOL_ID_KINDS,
  DASHBOARDS,
  OBSERVABLE_TERMINAL_STATES,
  OBSERVABILITY_EVENT_TAXONOMY,
  PROTOCOL_CORRELATION_KEY_KINDS,
  alertsForEvent,
  checkDashboardsAgainstTaxonomy,
  checkEventTaxonomyCorrelation,
  resolveAlertRoutes,
} from "../src/observability.js";

// ---------------------------------------------------------------------------
// Protocol-ID correlation for every event (W3-007 acceptance)
// ---------------------------------------------------------------------------

describe("event taxonomy correlation", () => {
  it("the declared taxonomy passes the correlation check", () => {
    const report = checkEventTaxonomyCorrelation();
    expect(report.passed).toBe(true);
    expect(report.violations).toEqual([]);
    expect(report.eventCount).toBeGreaterThan(0);
  });

  it("EVERY event declares at least one protocol-ID correlation key", () => {
    for (const declaration of OBSERVABILITY_EVENT_TAXONOMY) {
      expect(declaration.requiredCorrelationKeys.length).toBeGreaterThan(0);
    }
  });

  it("every journey/economic event is keyed to a CORE protocol ID", () => {
    const coreCategories = new Set([
      "terminal-transition",
      "unknown-outcome",
      "reconciliation",
      "outbox",
      "participation",
    ]);
    for (const declaration of OBSERVABILITY_EVENT_TAXONOMY) {
      if (coreCategories.has(declaration.category)) {
        const hasCoreKey = declaration.requiredCorrelationKeys.some((key) =>
          CORE_PROTOCOL_ID_KINDS.includes(key),
        );
        expect(hasCoreKey).toBe(true);
      }
    }
  });

  it("every correlation key is a declared protocol-ID kind", () => {
    for (const declaration of OBSERVABILITY_EVENT_TAXONOMY) {
      for (const key of declaration.requiredCorrelationKeys) {
        expect(PROTOCOL_CORRELATION_KEY_KINDS).toContain(key);
      }
    }
  });

  it("every observable terminal state has a transition event — including UNKNOWN (INV-X01)", () => {
    const names = new Set(
      OBSERVABILITY_EVENT_TAXONOMY.map((event) => event.eventName),
    );
    for (const state of OBSERVABLE_TERMINAL_STATES) {
      expect(names.has(`settlement.terminal-transition.${state.toLowerCase()}`)).toBe(
        true,
      );
    }
    const unknownEvent = OBSERVABILITY_EVENT_TAXONOMY.find(
      (event) => event.eventName === "settlement.terminal-transition.unknown",
    );
    expect(unknownEvent).toBeDefined();
    expect(unknownEvent?.invariants).toContain("INV-X01");
    // the UNKNOWN transition routes to reconciliation, not failure
    expect(unknownEvent?.requiredCorrelationKeys).toContain(
      "reconciliationCaseId",
    );
  });

  it("the checker DETECTS an event with no correlation key", () => {
    const report = checkEventTaxonomyCorrelation([
      {
        eventName: "broken.no-correlation",
        category: "terminal-transition",
        description: "no keys",
        requiredCorrelationKeys: [],
        invariants: [],
      },
    ]);
    expect(report.passed).toBe(false);
    expect(report.violations[0]?.detail).toContain("no required correlation key");
  });

  it("the checker DETECTS an economic event without a core protocol ID", () => {
    const report = checkEventTaxonomyCorrelation([
      {
        eventName: "broken.not-core-keyed",
        category: "terminal-transition",
        description: "only keyed by a non-core kind",
        requiredCorrelationKeys: ["requestId"],
        invariants: [],
      },
    ]);
    expect(report.passed).toBe(false);
    expect(
      report.violations.some((violation) =>
        violation.detail.includes("core protocol ID"),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Dashboards
// ---------------------------------------------------------------------------

describe("dashboard declarations", () => {
  it("every panel groups by a protocol ID and references declared events", () => {
    const report = checkDashboardsAgainstTaxonomy();
    expect(report.passed).toBe(true);
    expect(report.violations).toEqual([]);
  });

  it("declares the operator-facing dashboards", () => {
    const ids = DASHBOARDS.map((dashboard) => dashboard.dashboardId);
    expect(ids).toEqual(
      expect.arrayContaining([
        "payments-operations",
        "delivery-health",
        "security-posture",
        "participation-health",
        "release-readiness",
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// Alert rules — routing and the no-orphan-alerts law
// ---------------------------------------------------------------------------

describe("alert rules", () => {
  it("EVERY alert routes to an existing runbook entry (no orphan alerts)", () => {
    const entryIds = new Set(
      OPERATIONS_RUNBOOK.map((entry) => entry.entryId),
    );
    for (const alert of ALERT_RULES) {
      expect(entryIds.has(alert.runbookEntryId)).toBe(true);
    }
  });

  it("every alert references declared taxonomy events", () => {
    const names = new Set(
      OBSERVABILITY_EVENT_TAXONOMY.map((event) => event.eventName),
    );
    for (const alert of ALERT_RULES) {
      expect(alert.events.length).toBeGreaterThan(0);
      for (const eventName of alert.events) {
        expect(names.has(eventName)).toBe(true);
      }
    }
  });

  it("severity routes expand to the routing channels", () => {
    for (const alert of ALERT_RULES) {
      const routes = resolveAlertRoutes(alert);
      if (alert.severity === "page") {
        expect(routes).toContain("on-call-payments");
        expect(routes).toContain("incident-commander");
      }
      if (alert.severity === "ticket") {
        expect(routes).toContain("ops-queue");
      }
      if (alert.severity === "review") {
        expect(routes).toContain("daily-ops-review");
      }
    }
  });

  it("alerts can be resolved from their triggering events", () => {
    expect(alertsForEvent("security.quarantine-imposed").map((a) => a.alertId)).toEqual([
      "security-quarantine-imposed",
    ]);
    expect(alertsForEvent("outbox.backlog-growing").map((a) => a.alertId)).toEqual([
      "outbox-backlog-growing",
    ]);
    expect(alertsForEvent("nonexistent.event")).toEqual([]);
  });

  it("UNKNOWN, quarantine, clawback and rail alerts exist for the W3-007 scenarios", () => {
    const alertIds = new Set(ALERT_RULES.map((alert) => alert.alertId));
    expect(alertIds.has("unknown-outcome-open")).toBe(true);
    expect(alertIds.has("security-quarantine-imposed")).toBe(true);
    expect(alertIds.has("incentive-dispute-opened")).toBe(true);
    expect(alertIds.has("clawback-adjustment-created")).toBe(true);
    expect(alertIds.has("rail-outage-detected")).toBe(true);
  });
});

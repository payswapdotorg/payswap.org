/**
 * @payswap/operations — correlated observability model (W3-007).
 *
 * Authority: spec/experience/DEPLOYMENT-TOPOLOGY.md §4 (Observability
 * posture: vendor-neutral sink; every terminal-state transition, UNKNOWN
 * outcome and reconciliation resolution is observable; request correlation
 * via the response envelope's requestId) + §6 gate 10.
 *
 * The correlation law: EVERY observability event is keyed by PROTOCOL
 * IDENTIFIERS (obligation / attempt / settlement / evidence / command /
 * event / reconciliation-case IDs). A log, trace or metric that cannot be
 * joined back to the protocol object it describes is a contract violation
 * — `checkEventTaxonomyCorrelation` enforces it over the declared taxonomy.
 *
 * Alerting law (the runbook principle): NO ORPHAN ALERTS — every alert
 * declaration MUST reference an existing runbook entry, because an alert
 * that fires without a symptom → diagnosis → action → verification path
 * trains operators to ignore it. `checkNoOrphanAlerts` enforces it.
 *
 * Deterministic only: the taxonomy, dashboards and alert rules are DATA;
 * the checkers are pure functions. No metrics I/O happens here.
 */

// ---------------------------------------------------------------------------
// Protocol correlation keys
// ---------------------------------------------------------------------------

/**
 * The protocol-ID kinds every observability event may correlate to. The
 * core financial set (first six) keys any event about economic state;
 * the remainder key the security, participation, rail and ops planes.
 */
export const PROTOCOL_CORRELATION_KEY_KINDS = [
  "commandId",
  "eventId",
  "obligationId",
  "attemptId",
  "settlementId",
  "evidenceId",
  "reconciliationCaseId",
  "requestId",
  "campaignId",
  "advisoryId",
  "securityEpoch",
  "railId",
] as const;
export type ProtocolCorrelationKeyKind =
  (typeof PROTOCOL_CORRELATION_KEY_KINDS)[number];

/** The core financial protocol-ID set (journey/event correlation floor). */
export const CORE_PROTOCOL_ID_KINDS: readonly ProtocolCorrelationKeyKind[] =
  Object.freeze([
    "commandId",
    "eventId",
    "obligationId",
    "attemptId",
    "settlementId",
    "evidenceId",
  ]);

export function isProtocolCorrelationKeyKind(
  value: unknown,
): value is ProtocolCorrelationKeyKind {
  return (
    typeof value === "string" &&
    (PROTOCOL_CORRELATION_KEY_KINDS as readonly unknown[]).includes(value)
  );
}

// ---------------------------------------------------------------------------
// The event taxonomy
// ---------------------------------------------------------------------------

export const OBSERVABILITY_EVENT_CATEGORIES = [
  "terminal-transition",
  "unknown-outcome",
  "reconciliation",
  "outbox",
  "security",
  "participation",
  "rail",
  "campaign",
  "deployment",
  "browser-verification",
] as const;
export type ObservabilityEventCategory =
  (typeof OBSERVABILITY_EVENT_CATEGORIES)[number];

export interface ObservabilityEventDeclaration {
  /** Dotted, stable event name, e.g. `settlement.terminal-transition`. */
  readonly eventName: string;
  readonly category: ObservabilityEventCategory;
  readonly description: string;
  /** ≥1 protocol-ID kind — the correlation contract. */
  readonly requiredCorrelationKeys: readonly ProtocolCorrelationKeyKind[];
  /** Invariants this event makes observable. */
  readonly invariants: readonly string[];
}

/** The terminal states whose transitions MUST be observable (§4 posture). */
export const OBSERVABLE_TERMINAL_STATES: readonly string[] = Object.freeze([
  "FULFILLED",
  "WAITING",
  "USER_ACTION_REQUIRED",
  "NO_VIABLE_ROUTE",
  "COMPLIANCE_BLOCKED",
  "EXPIRED",
  "CANCELLED",
  "FAILED",
  "UNKNOWN",
]);

/** The observability event taxonomy — the single source for sinks. */
export const OBSERVABILITY_EVENT_TAXONOMY: readonly ObservabilityEventDeclaration[] =
  Object.freeze([
    // -- terminal transitions (one event per observable terminal state) ----
    ...OBSERVABLE_TERMINAL_STATES.map(
      (state): ObservabilityEventDeclaration => ({
        eventName: `settlement.terminal-transition.${state.toLowerCase()}`,
        category: "terminal-transition",
        description: `Settlement reached the ${state} terminal state; terminal transitions are monotonic except explicit recovery states (INV-X04).`,
        requiredCorrelationKeys:
          state === "UNKNOWN"
            ? ["settlementId", "obligationId", "reconciliationCaseId"]
            : ["settlementId", "obligationId", "evidenceId"],
        invariants:
          state === "UNKNOWN" ? ["INV-X01", "INV-X04"] : ["INV-X04", "INV-E03"],
      }),
    ),
    // -- UNKNOWN / ambiguity (INV-X01/X02/X03) ----------------------------
    {
      eventName: "execution.attempt.outcome-unknown",
      category: "unknown-outcome",
      description:
        "An execution attempt's external outcome is UNKNOWN; it is never mapped to FAILED and never blindly retried — reconciliation owns the resolution.",
      requiredCorrelationKeys: ["attemptId", "obligationId"],
      invariants: ["INV-X01", "INV-X02"],
    },
    {
      eventName: "execution.attempt.awaiting-reconciliation",
      category: "unknown-outcome",
      description:
        "An execution attempt entered an ambiguity state that blocks until its reconciliation case resolves.",
      requiredCorrelationKeys: ["attemptId", "reconciliationCaseId"],
      invariants: ["INV-X03"],
    },
    // -- reconciliation ----------------------------------------------------
    {
      eventName: "reconciliation.case-opened",
      category: "reconciliation",
      description:
        "A reconciliation case opened for an ambiguous external effect; the case is the authoritative resolution path.",
      requiredCorrelationKeys: [
        "reconciliationCaseId",
        "attemptId",
        "obligationId",
      ],
      invariants: ["INV-X03"],
    },
    {
      eventName: "reconciliation.case-resolved",
      category: "reconciliation",
      description:
        "A reconciliation case resolved with an authoritative outcome and evidence.",
      requiredCorrelationKeys: [
        "reconciliationCaseId",
        "settlementId",
        "evidenceId",
      ],
      invariants: ["INV-X03", "INV-E03"],
    },
    // -- outbox (INV-O01 / INV-O02) ---------------------------------------
    {
      eventName: "outbox.record-published",
      category: "outbox",
      description:
        "An outbox record was published after its publisher resolved successfully; the record only now marks PUBLISHED.",
      requiredCorrelationKeys: ["eventId", "commandId"],
      invariants: ["INV-O01", "INV-O02"],
    },
    {
      eventName: "outbox.publication-ambiguous",
      category: "outbox",
      description:
        "An outbox publication outcome is UNKNOWN (publisher threw ExternalAmbiguityError); the drain fails-stop, the record stays PENDING and reconciliation is required before further attempts.",
      requiredCorrelationKeys: ["eventId", "commandId", "reconciliationCaseId"],
      invariants: ["INV-O01", "INV-O02", "INV-X01", "INV-X02"],
    },
    {
      eventName: "outbox.backlog-growing",
      category: "outbox",
      description:
        "Outbox backlog is growing — committed financial mutations risk delayed (never lost) event delivery.",
      requiredCorrelationKeys: ["eventId"],
      invariants: ["INV-O02"],
    },
    // -- security (INV-S01..S04, INV-A02) ----------------------------------
    {
      eventName: "security.quarantine-imposed",
      category: "security",
      description:
        "A component was quarantined by advisory; restricted components cannot regain access through cached capability state (INV-S03).",
      requiredCorrelationKeys: ["advisoryId", "securityEpoch"],
      invariants: ["INV-S01", "INV-S03"],
    },
    {
      eventName: "security.quarantine-release-requested",
      category: "security",
      description:
        "An operator requested quarantine release; the release is an evidenced operator action with epoch bump.",
      requiredCorrelationKeys: ["advisoryId", "securityEpoch"],
      invariants: ["INV-S01", "INV-S02"],
    },
    {
      eventName: "security.epoch-bumped",
      category: "security",
      description:
        "The security epoch advanced; sensitive delegated actions re-check the epoch on every authorization (INV-S02).",
      requiredCorrelationKeys: ["securityEpoch"],
      invariants: ["INV-A02", "INV-S02"],
    },
    {
      eventName: "security.advisory-published",
      category: "security",
      description:
        "A security advisory was published and may restrict affected components globally (INV-S01).",
      requiredCorrelationKeys: ["advisoryId"],
      invariants: ["INV-S01", "INV-S04"],
    },
    {
      eventName: "security.capability-access-denied-by-quarantine",
      category: "security",
      description:
        "A capability access request was denied because a quarantine or stale epoch blocked it — the enforcement record is observable.",
      requiredCorrelationKeys: ["advisoryId", "securityEpoch", "requestId"],
      invariants: ["INV-S02", "INV-S03"],
    },
    // -- participation / campaigns (INV-P06, INV-P07) ---------------------
    {
      eventName: "participation.clawback-adjustment",
      category: "participation",
      description:
        "A clawback created a separate adjustment obligation; contribution history remains (INV-P06).",
      requiredCorrelationKeys: ["obligationId", "campaignId"],
      invariants: ["INV-P06"],
    },
    {
      eventName: "campaign.control-action",
      category: "campaign",
      description:
        "An operator control action (pause/resume/close/cap-adjust/suppress) minted a new campaign epoch with evidence.",
      requiredCorrelationKeys: ["campaignId"],
      invariants: ["INV-P07"],
    },
    {
      eventName: "campaign.incentive-dispute-opened",
      category: "campaign",
      description:
        "An incentive dispute opened; resolution may lead to a clawback adjustment obligation.",
      requiredCorrelationKeys: ["campaignId", "obligationId"],
      invariants: ["INV-P06"],
    },
    // -- rails ---------------------------------------------------------------
    {
      eventName: "rail.incident-classified",
      category: "rail",
      description:
        "A rail incident was classified with its outcome; UNKNOWN incidents route to reconciliation.",
      requiredCorrelationKeys: ["railId", "attemptId"],
      invariants: ["INV-X01", "INV-X03"],
    },
    {
      eventName: "rail.outage-detected",
      category: "rail",
      description:
        "A rail outage was detected; fallback requires explicit term-change reauthorization when material terms change.",
      requiredCorrelationKeys: ["railId"],
      invariants: [],
    },
    {
      eventName: "rail.cutover-executed",
      category: "rail",
      description:
        "A rail cutover executed; in-flight attempts were drained or reconciled before the switch (INV-X02).",
      requiredCorrelationKeys: ["railId", "attemptId"],
      invariants: ["INV-X02"],
    },
    // -- deployment / ops (§6 gates) ----------------------------------------
    {
      eventName: "deployment.gate-result",
      category: "deployment",
      description:
        "A deployment gate produced its verdict; failures block release.",
      requiredCorrelationKeys: ["requestId"],
      invariants: [],
    },
    {
      eventName: "deployment.parity-drift-detected",
      category: "deployment",
      description:
        "Preview/production parity verification detected drift outside the explicit allowlist.",
      requiredCorrelationKeys: ["requestId"],
      invariants: [],
    },
    {
      eventName: "browser.verification-run",
      category: "browser-verification",
      description:
        "A browser-journey verification run produced its report (six checks per journey).",
      requiredCorrelationKeys: ["attemptId", "requestId"],
      invariants: ["INV-E04"],
    },
    {
      eventName: "secrets.exposure-detected",
      category: "deployment",
      description:
        "Secret-reference hygiene detected a secret VALUE or non-reference secret key in a config artifact.",
      requiredCorrelationKeys: ["requestId"],
      invariants: [],
    },
    {
      eventName: "deployment.restore-replay-drill",
      category: "deployment",
      description:
        "A restore/replay drill verified authoritative state reconstruction from the journal (INV-O04).",
      requiredCorrelationKeys: ["eventId"],
      invariants: ["INV-O04", "INV-F02"],
    },
  ]);

// ---------------------------------------------------------------------------
// Dashboards — as data (vendor-neutral sink)
// ---------------------------------------------------------------------------

export interface DashboardPanel {
  readonly panelId: string;
  readonly title: string;
  /** The event names feeding the panel. */
  readonly events: readonly string[];
  /** The protocol-ID kind every series on the panel groups by. */
  readonly correlatedBy: ProtocolCorrelationKeyKind;
}

export interface DashboardDeclaration {
  readonly dashboardId: string;
  readonly title: string;
  readonly panels: readonly DashboardPanel[];
}

/** The operator dashboards. Panel series ALWAYS group by a protocol ID. */
export const DASHBOARDS: readonly DashboardDeclaration[] = Object.freeze([
  {
    dashboardId: "payments-operations",
    title: "Payments operations",
    panels: [
      {
        panelId: "terminal-state-outcomes",
        title: "Terminal-state outcomes over time",
        events: OBSERVABLE_TERMINAL_STATES.map(
          (state) => `settlement.terminal-transition.${state.toLowerCase()}`,
        ),
        correlatedBy: "settlementId",
      },
      {
        panelId: "unknown-outcomes-awaiting-reconciliation",
        title: "UNKNOWN outcomes awaiting reconciliation",
        events: [
          "execution.attempt.outcome-unknown",
          "execution.attempt.awaiting-reconciliation",
          "reconciliation.case-opened",
        ],
        correlatedBy: "reconciliationCaseId",
      },
      {
        panelId: "reconciliation-resolution-latency",
        title: "Reconciliation resolution latency",
        events: ["reconciliation.case-opened", "reconciliation.case-resolved"],
        correlatedBy: "reconciliationCaseId",
      },
    ],
  },
  {
    dashboardId: "delivery-health",
    title: "Delivery health (outbox/queues)",
    panels: [
      {
        panelId: "outbox-backlog-depth",
        title: "Outbox backlog depth",
        events: ["outbox.record-published", "outbox.backlog-growing"],
        correlatedBy: "eventId",
      },
      {
        panelId: "ambiguous-publications",
        title: "Ambiguous outbox publications (fail-stop)",
        events: ["outbox.publication-ambiguous"],
        correlatedBy: "eventId",
      },
    ],
  },
  {
    dashboardId: "security-posture",
    title: "Security posture",
    panels: [
      {
        panelId: "quarantine-enforcement",
        title: "Quarantine impositions and denied accesses",
        events: [
          "security.quarantine-imposed",
          "security.capability-access-denied-by-quarantine",
          "security.quarantine-release-requested",
        ],
        correlatedBy: "advisoryId",
      },
      {
        panelId: "epoch-advancements",
        title: "Security epoch advancements",
        events: ["security.epoch-bumped"],
        correlatedBy: "securityEpoch",
      },
    ],
  },
  {
    dashboardId: "participation-health",
    title: "Participation and incentives health",
    panels: [
      {
        panelId: "campaign-control-actions",
        title: "Campaign control actions",
        events: ["campaign.control-action"],
        correlatedBy: "campaignId",
      },
      {
        panelId: "incentive-disputes-and-clawbacks",
        title: "Incentive disputes and clawback adjustments",
        events: [
          "campaign.incentive-dispute-opened",
          "participation.clawback-adjustment",
        ],
        correlatedBy: "campaignId",
      },
    ],
  },
  {
    dashboardId: "release-readiness",
    title: "Release readiness (deployment gates)",
    panels: [
      {
        panelId: "gate-outcomes",
        title: "Deployment gate outcomes",
        events: [
          "deployment.gate-result",
          "deployment.parity-drift-detected",
          "secrets.exposure-detected",
          "browser.verification-run",
          "deployment.restore-replay-drill",
        ],
        correlatedBy: "requestId",
      },
    ],
  },
]);

// ---------------------------------------------------------------------------
// Alert rules — as data, every one routed to a runbook entry
// ---------------------------------------------------------------------------

export type AlertSeverity = "page" | "ticket" | "review";

export interface AlertRule {
  readonly alertId: string;
  readonly title: string;
  /** Human-readable triggering condition over the event taxonomy. */
  readonly condition: string;
  readonly events: readonly string[];
  readonly severity: AlertSeverity;
  /** Routing channels for this severity. */
  readonly routes: readonly string[];
  /**
   * The runbook entry that owns this alert — REQUIRED, no orphan alerts.
   * Must exist in the assembled runbook (checkNoOrphanAlerts).
   */
  readonly runbookEntryId: string;
  readonly invariants: readonly string[];
}

export const ALERT_SEVERITY_ROUTES: Readonly<
  Record<AlertSeverity, readonly string[]>
> = Object.freeze({
  page: ["on-call-payments", "incident-commander"],
  ticket: ["ops-queue"],
  review: ["daily-ops-review"],
});

/** The alert rules. Every entry links a runbook entry (no orphans). */
export const ALERT_RULES: readonly AlertRule[] = Object.freeze([
  {
    alertId: "unknown-outcome-open",
    title: "UNKNOWN execution outcomes present",
    condition:
      "execution.attempt.outcome-unknown or execution.attempt.awaiting-reconciliation observed and not yet linked to an open reconciliation case",
    events: [
      "execution.attempt.outcome-unknown",
      "execution.attempt.awaiting-reconciliation",
    ],
    severity: "page",
    routes: [...ALERT_SEVERITY_ROUTES.page],
    runbookEntryId: "rb-unknown-outcome",
    invariants: ["INV-X01", "INV-X02"],
  },
  {
    alertId: "reconciliation-backlog-sla",
    title: "Reconciliation backlog breaching SLA",
    condition:
      "cases opened (reconciliation.case-opened) exceed resolved (reconciliation.case-resolved) beyond the SLA window",
    events: ["reconciliation.case-opened", "reconciliation.case-resolved"],
    severity: "page",
    routes: [...ALERT_SEVERITY_ROUTES.page],
    runbookEntryId: "rb-unknown-outcome",
    invariants: ["INV-X03"],
  },
  {
    alertId: "outbox-backlog-growing",
    title: "Outbox backlog growing",
    condition: "outbox.backlog-growing observed",
    events: ["outbox.backlog-growing"],
    severity: "page",
    routes: [...ALERT_SEVERITY_ROUTES.page],
    runbookEntryId: "rb-outbox-backlog",
    invariants: ["INV-O02"],
  },
  {
    alertId: "outbox-publication-ambiguous",
    title: "Ambiguous outbox publication (drain fail-stopped)",
    condition: "outbox.publication-ambiguous observed",
    events: ["outbox.publication-ambiguous"],
    severity: "page",
    routes: [...ALERT_SEVERITY_ROUTES.page],
    runbookEntryId: "rb-outbox-ambiguity",
    invariants: ["INV-O01", "INV-O02", "INV-X01", "INV-X02"],
  },
  {
    alertId: "security-quarantine-imposed",
    title: "Component quarantined by advisory",
    condition: "security.quarantine-imposed observed",
    events: ["security.quarantine-imposed"],
    severity: "page",
    routes: [...ALERT_SEVERITY_ROUTES.page],
    runbookEntryId: "rb-security-quarantine",
    invariants: ["INV-S01", "INV-S03"],
  },
  {
    alertId: "security-advisory-published",
    title: "Security advisory published",
    condition: "security.advisory-published observed",
    events: ["security.advisory-published"],
    severity: "page",
    routes: [...ALERT_SEVERITY_ROUTES.page],
    runbookEntryId: "rb-security-quarantine",
    invariants: ["INV-S01", "INV-S04"],
  },
  {
    alertId: "incentive-dispute-opened",
    title: "Incentive dispute opened",
    condition: "campaign.incentive-dispute-opened observed",
    events: ["campaign.incentive-dispute-opened"],
    severity: "ticket",
    routes: [...ALERT_SEVERITY_ROUTES.ticket],
    runbookEntryId: "rb-incentive-dispute-clawback",
    invariants: ["INV-P06"],
  },
  {
    alertId: "clawback-adjustment-created",
    title: "Clawback adjustment obligation created",
    condition: "participation.clawback-adjustment observed",
    events: ["participation.clawback-adjustment"],
    severity: "ticket",
    routes: [...ALERT_SEVERITY_ROUTES.ticket],
    runbookEntryId: "rb-incentive-dispute-clawback",
    invariants: ["INV-P06"],
  },
  {
    alertId: "rail-outage-detected",
    title: "Rail outage detected",
    condition: "rail.outage-detected observed for a configured rail",
    events: ["rail.outage-detected", "rail.incident-classified"],
    severity: "page",
    routes: [...ALERT_SEVERITY_ROUTES.page],
    runbookEntryId: "rb-rail-outage",
    invariants: [],
  },
  {
    alertId: "parity-drift-detected",
    title: "Preview/production configuration drift",
    condition: "deployment.parity-drift-detected observed",
    events: ["deployment.parity-drift-detected"],
    severity: "ticket",
    routes: [...ALERT_SEVERITY_ROUTES.ticket],
    runbookEntryId: "rb-parity-drift",
    invariants: [],
  },
  {
    alertId: "secret-exposure-detected",
    title: "Secret exposure detected in a config artifact",
    condition: "secrets.exposure-detected observed",
    events: ["secrets.exposure-detected"],
    severity: "page",
    routes: [...ALERT_SEVERITY_ROUTES.page],
    runbookEntryId: "rb-secret-exposure",
    invariants: [],
  },
  {
    alertId: "browser-journey-failed",
    title: "Browser journey verification failed",
    condition:
      "browser.verification-run reported a failed check (console errors, dead button, missing screenshot, missing API wiring)",
    events: ["browser.verification-run"],
    severity: "ticket",
    routes: [...ALERT_SEVERITY_ROUTES.ticket],
    runbookEntryId: "rb-browser-journey-failure",
    invariants: ["INV-E04"],
  },
  {
    alertId: "restore-replay-drill-stale",
    title: "Restore/replay drill not run within window",
    condition:
      "no deployment.restore-replay-drill event within the required drill window",
    events: ["deployment.restore-replay-drill"],
    severity: "review",
    routes: [...ALERT_SEVERITY_ROUTES.review],
    runbookEntryId: "rb-restore-replay",
    invariants: ["INV-O04"],
  },
]);

// ---------------------------------------------------------------------------
// Checkers
// ---------------------------------------------------------------------------

export interface CorrelationViolation {
  readonly eventName: string;
  readonly detail: string;
}

export interface EventTaxonomyReport {
  readonly passed: boolean;
  readonly eventCount: number;
  readonly violations: readonly CorrelationViolation[];
}

/**
 * The correlation contract check: every declared event
 *  1. has at least one required correlation key;
 *  2. uses only declared protocol-ID kinds;
 *  3. carries at least one CORE financial protocol ID whenever it describes
 *     journey/economic state (terminal transitions, UNKNOWN outcomes,
 *     reconciliation, outbox, participation clawbacks);
 *  4. the terminal states observable per §4 are exactly the declared list
 *     and each has its transition event.
 */
export function checkEventTaxonomyCorrelation(
  taxonomy: readonly ObservabilityEventDeclaration[] = OBSERVABILITY_EVENT_TAXONOMY,
): EventTaxonomyReport {
  const violations: CorrelationViolation[] = [];
  const names = new Set<string>();

  const coreKeyedCategories = new Set<ObservabilityEventCategory>([
    "terminal-transition",
    "unknown-outcome",
    "reconciliation",
    "outbox",
    "participation",
  ]);

  for (const declaration of taxonomy) {
    if (names.has(declaration.eventName)) {
      violations.push({
        eventName: declaration.eventName,
        detail: "duplicate event name in taxonomy",
      });
    }
    names.add(declaration.eventName);

    if (declaration.requiredCorrelationKeys.length === 0) {
      violations.push({
        eventName: declaration.eventName,
        detail: "no required correlation key — every event must correlate to a protocol ID",
      });
    }
    for (const key of declaration.requiredCorrelationKeys) {
      if (!isProtocolCorrelationKeyKind(key)) {
        violations.push({
          eventName: declaration.eventName,
          detail: `unknown correlation key kind '${String(key)}'`,
        });
      }
    }
    if (
      coreKeyedCategories.has(declaration.category) &&
      !declaration.requiredCorrelationKeys.some((key) =>
        CORE_PROTOCOL_ID_KINDS.includes(key),
      )
    ) {
      violations.push({
        eventName: declaration.eventName,
        detail: "journey/economic event is not keyed to a core protocol ID (obligation/attempt/settlement/evidence/command/event)",
      });
    }
  }

  for (const state of OBSERVABLE_TERMINAL_STATES) {
    if (!names.has(`settlement.terminal-transition.${state.toLowerCase()}`)) {
      violations.push({
        eventName: `settlement.terminal-transition.${state.toLowerCase()}`,
        detail: `terminal state ${state} has no transition event (§4 observability posture)`,
      });
    }
  }

  return {
    passed: violations.length === 0,
    eventCount: taxonomy.length,
    violations,
  };
}

/** Every dashboard panel's events exist in the taxonomy. */
export function checkDashboardsAgainstTaxonomy(
  dashboards: readonly DashboardDeclaration[] = DASHBOARDS,
  taxonomy: readonly ObservabilityEventDeclaration[] = OBSERVABILITY_EVENT_TAXONOMY,
): { passed: boolean; violations: string[] } {
  const names = new Set(taxonomy.map((declaration) => declaration.eventName));
  const violations: string[] = [];
  for (const dashboard of dashboards) {
    for (const panel of dashboard.panels) {
      if (panel.events.length === 0) {
        violations.push(`${dashboard.dashboardId}/${panel.panelId}: no events`);
      }
      if (!isProtocolCorrelationKeyKind(panel.correlatedBy)) {
        violations.push(
          `${dashboard.dashboardId}/${panel.panelId}: panel groups by non-protocol key`,
        );
      }
      for (const eventName of panel.events) {
        if (!names.has(eventName)) {
          violations.push(
            `${dashboard.dashboardId}/${panel.panelId}: unknown event '${eventName}'`,
          );
        }
      }
    }
  }
  return { passed: violations.length === 0, violations };
}

/**
 * Alert-routing resolution: which channels an alert fans out to. Severity
 * routes are expanded from ALERT_SEVERITY_ROUTES (single source).
 */
export function resolveAlertRoutes(alert: AlertRule): readonly string[] {
  const severityRoutes = ALERT_SEVERITY_ROUTES[alert.severity];
  const routes = [...alert.routes];
  for (const route of severityRoutes) {
    if (!routes.includes(route)) {
      routes.push(route);
    }
  }
  return routes;
}

/** All alerts whose triggering events include the given event name. */
export function alertsForEvent(
  eventName: string,
  rules: readonly AlertRule[] = ALERT_RULES,
): readonly AlertRule[] {
  return rules.filter((rule) => rule.events.includes(eventName));
}

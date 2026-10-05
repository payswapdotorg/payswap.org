/**
 * @payswap/surface — the eleven operational areas (P4-W4-002 §3.2).
 *
 * The navigation IA of the universal interface, DERIVED from the Stripe UX
 * research corpus (docs/ux-research/stripe/**, the Phase-1 public-surface
 * survey + the dashboard IA proposal — the Phase-2 authenticated survey is
 * NOT available and nothing here claims it). Every area cites the research
 * document(s) its placement derives from: the TL audits this mapping
 * against the corpus (see packages/web/RESEARCH-MAPPING.md for the full
 * row-by-row audit table).
 *
 * This registry is DATA for any renderer: the web sidebar, a mobile tab
 * bar, an extension popup. `route` is the canonical web route; host apps
 * may map ids to their own navigation, but the AREA SET and ORDER are the
 * versioned contract.
 */

import { surfaceProvenance, type SurfaceContractProvenance } from "./version.js";

/** The eleven operational areas — the fixed, versioned vocabulary. */
export type UniversalAreaId =
  | "overview"
  | "payments"
  | "accounts"
  | "activity"
  | "opportunities"
  | "connections"
  | "capabilities"
  | "security"
  | "reports"
  | "developers"
  | "settings";

/**
 * What an area renders when the backend provides nothing yet — the
 * RESEARCH-mandated designed empty state (Stripe-style empty states name
 * the object, explain why it is empty, and offer the next action). The
 * surface records the honest fact; the renderer phrases it.
 */
export interface AreaEmptyStateContract {
  /** Why the area is empty (a fact about configured authority). */
  readonly reason: string;
  /** The real next action offered (route or outcome action id). */
  readonly nextAction: { readonly kind: "route" | "outcome"; readonly value: string };
}

export interface UniversalArea {
  readonly id: UniversalAreaId;
  readonly label: string;
  readonly route: string;
  /** One-line people-language purpose. */
  readonly purpose: string;
  /**
   * The research documents this area's placement derives from
   * (auditable citations — file names under docs/ux-research/stripe/).
   */
  readonly researchCitations: readonly string[];
  /** The honest empty-state contract when no backend data exists. */
  readonly emptyState: AreaEmptyStateContract;
  readonly provenance: SurfaceContractProvenance;
}

const AREAS: readonly UniversalArea[] = Object.freeze([
  {
    id: "overview",
    label: "Overview",
    route: "/app",
    purpose: "The home view: what needs attention, recent activity, quick outcomes.",
    researchCitations: ["navigation.md", "dashboard-pages.md", "pay-swap-ux-mapping.md"],
    emptyState: {
      reason: "No session-scoped observations yet — the overview renders only what the authoritative API provides.",
      nextAction: { kind: "route", value: "/app/payments" },
    },
    provenance: surfaceProvenance("P4-W4-002"),
  },
  {
    id: "payments",
    label: "Payments",
    route: "/app/payments",
    purpose: "Money in and money out: pay, receive, move — plus the payment object spine.",
    researchCitations: ["payments.md", "navigation.md", "workflow-patterns.md"],
    emptyState: {
      reason: "No connected payment capability yet — journeys start from connected instances only.",
      nextAction: { kind: "route", value: "/app/connections" },
    },
    provenance: surfaceProvenance("P4-W4-002"),
  },
  {
    id: "accounts",
    label: "Accounts",
    route: "/app/accounts",
    purpose:
      "Balances and positions across providers — every number an OBSERVATION of an external provider, never PaySwap custody.",
    researchCitations: ["balances.md", "pay-swap-ux-mapping.md"],
    emptyState: {
      reason: "No provider balance observations exist — external provider balances are observations, and none have been observed in this deployment.",
      nextAction: { kind: "route", value: "/app/connections" },
    },
    provenance: surfaceProvenance("P4-W4-002"),
  },
  {
    id: "activity",
    label: "Activity",
    route: "/app/activity",
    purpose: "The chronological ledger of actions with their honest states and evidence links.",
    researchCitations: ["dashboard-pages.md", "payments.md", "component-patterns.md"],
    emptyState: {
      reason: "No recorded activity yet — activity rows come from authoritative journey records, never from the UI.",
      nextAction: { kind: "route", value: "/app/payments" },
    },
    provenance: surfaceProvenance("P4-W4-002"),
  },
  {
    id: "opportunities",
    label: "Opportunities",
    route: "/app/opportunities",
    purpose: "Discovered opportunities with honest risk and eligibility — never guaranteed returns.",
    researchCitations: ["pay-swap-ux-mapping.md", "dashboard-pages.md"],
    emptyState: {
      reason: "No opportunity observations yet — discovery runs on real capability observations only.",
      nextAction: { kind: "route", value: "/app/capabilities" },
    },
    provenance: surfaceProvenance("P4-W4-002"),
  },
  {
    id: "connections",
    label: "Connections",
    route: "/app/connections",
    purpose:
      "The connected-instance model: a provider catalogue capability is never a connection — execution is scoped to actual account authorization.",
    researchCitations: ["connect.md", "settings.md", "pay-swap-ux-mapping.md"],
    emptyState: {
      reason: "No connected instances yet — the catalogue is browsable, but nothing is authorized until you connect.",
      nextAction: { kind: "route", value: "/connect" },
    },
    provenance: surfaceProvenance("P4-W4-002"),
  },
  {
    id: "capabilities",
    label: "Capabilities",
    route: "/app/capabilities",
    purpose: "The honest capability and coverage explorer over recorded provider-probe evidence.",
    researchCitations: ["developers.md", "public-pages.md", "pay-swap-ux-mapping.md"],
    emptyState: {
      reason: "Capability coverage renders from recorded probe evidence — the public explorer carries the same honesty.",
      nextAction: { kind: "route", value: "/capabilities" },
    },
    provenance: surfaceProvenance("P4-W4-002"),
  },
  {
    id: "security",
    label: "Security",
    route: "/app/security",
    purpose:
      "Human-readable warnings and blocks — the BLOCK/ALLOW/UNKNOWN gate vocabulary in people language with typed drill-down.",
    researchCitations: ["risk.md", "pay-swap-ux-mapping.md"],
    emptyState: {
      reason: "No gate records yet — security findings appear here as they occur in real journeys.",
      nextAction: { kind: "route", value: "/security" },
    },
    provenance: surfaceProvenance("P4-W4-002"),
  },
  {
    id: "reports",
    label: "Reports",
    route: "/app/reports",
    purpose: "Reporting over evidence-backed records — every figure traceable to its evidence.",
    researchCitations: ["reports.md", "dashboard-pages.md"],
    emptyState: {
      reason: "No reportable records yet — reports generate from the same evidence the activity ledger records.",
      nextAction: { kind: "route", value: "/app/activity" },
    },
    provenance: surfaceProvenance("P4-W4-002"),
  },
  {
    id: "developers",
    label: "Developers",
    route: "/app/developers",
    purpose: "The developer surface: API surface, webhooks, keys — test/live visibly distinct.",
    researchCitations: ["developers.md", "settings.md"],
    emptyState: {
      reason: "The developer surface renders the same contracts the programmatic clients consume.",
      nextAction: { kind: "route", value: "/app/developers" },
    },
    provenance: surfaceProvenance("P4-W4-002"),
  },
  {
    id: "settings",
    label: "Settings",
    route: "/app/settings",
    purpose: "Account, role and session preferences — mode switches visible and honest.",
    researchCitations: ["settings.md", "navigation.md"],
    emptyState: {
      reason: "Settings render from the session's own authority — nothing is configurable without one.",
      nextAction: { kind: "route", value: "/app/settings" },
    },
    provenance: surfaceProvenance("P4-W4-002"),
  },
] as const);

export const UNIVERSAL_AREAS: readonly UniversalArea[] = AREAS;

export const UNIVERSAL_AREA_IDS: readonly UniversalAreaId[] = AREAS.map((area) => area.id);

export function universalAreaById(id: UniversalAreaId): UniversalArea {
  const found = AREAS.find((area) => area.id === id);
  if (found === undefined) {
    throw new Error(`universalAreaById: unknown universal area id ${JSON.stringify(id)}`);
  }
  return found;
}

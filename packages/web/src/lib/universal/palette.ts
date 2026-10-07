/**
 * The universal palette extension (P4-W4-002 §3.3; search/command entries by
 * UX-005).
 *
 * The certified Command Center palette (P3-W2-002, lib/cc/palette.ts) is
 * EXTENDED — never replaced — with the universal interface's surface:
 *
 * - the six-verb COMMAND entries (pay · request · invoice · link · convert ·
 *   withdraw, contract 06 §3/§4) — the Commands group, bound to their real
 *   workflow routes (the same six the search surface parses typed input
 *   against through the @payswap/ux grammar);
 * - the five OUTCOME ACTIONS (Pay / Receive / Move / Convert / Checkout),
 *   verb-first, each bound to its real journey route;
 * - GO-TO entries for the universal areas that are visible in the current
 *   role derivation (the same visibility law as the sidebar group);
 * - the SEARCH NAVIGATION entries with synonyms (contract 06 §3: navigation
 *   matched on title + synonyms).
 *
 * Every command maps to a REAL route (no placeholder commands, no fake
 * matches); the palette is keyboard-accessible via the shared
 * @payswap/design CommandPalette primitive the shell already renders.
 */

import type { ProductRole } from "@payswap/ux";
import { deriveNavigationForRole, PRODUCT_NAVIGATION } from "@payswap/ux";
import { OUTCOME_REGISTRY, UNIVERSAL_AREAS } from "@payswap/surface";

import { appRouteForNavItemId } from "@/lib/cc/routes";
import { deriveCcPalette, derivePaletteCommands, type PaletteCommandSpec } from "@/lib/cc/palette";
import { deriveUniversalAreaViews } from "./areas";

/** Where each outcome action's journey starts (real routes only). */
const OUTCOME_HREF: Readonly<Record<string, string>> = Object.freeze({
  pay: "/app/payments?start=1",
  receive: "/app/collections?start=1",
  move: "/app/payouts?start=1",
  convert: "/app/convert",
  checkout: "/app/checkout",
} as const);

export function deriveUniversalPalette(role: ProductRole | null): {
  readonly commands: readonly PaletteCommandSpec[];
  readonly actions: readonly PaletteCommandSpec[];
  readonly goTo: readonly PaletteCommandSpec[];
} {
  const base = deriveCcPalette(role);
  const nav = deriveNavigationForRole(PRODUCT_NAVIGATION, role ?? "merchant");
  const areaViews = deriveUniversalAreaViews(nav);

  const outcomeActions: readonly PaletteCommandSpec[] = OUTCOME_REGISTRY.map((action) => ({
    id: `universal-action-${action.id}`,
    label:
      action.id === "receive"
        ? "Receive — request money from a payer"
        : action.id === "move"
          ? "Move money to another account"
          : action.id === "convert"
            ? "Convert between currencies"
            : action.id === "checkout"
              ? "Checkout — the merchant payment journey"
              : "Pay a recipient",
    group: "Outcome actions",
    href: OUTCOME_HREF[action.id] ?? "/app",
    keywords: `${action.label} ${action.outcomeLine}`,
  }));

  const areaGoTo: readonly PaletteCommandSpec[] = areaViews
    .filter((view) => view.visible)
    .map((view) => ({
      id: `universal-goto-${view.area.id}`,
      label: view.area.label,
      group: "Universal areas",
      href: view.area.route,
      keywords: view.area.purpose,
    }));

  return {
    // The six-verb command grammar entries (contract 06 §3 — UX-005): the
    // Commands group leads the palette, the same six the search surface
    // parses typed input against.
    commands: derivePaletteCommands(),
    actions: [...outcomeActions, ...base.actions],
    goTo: [...areaGoTo, ...base.goTo],
  };
}

/** The area registry for renderers that want it directly (typed data). */
export const UNIVERSAL_AREA_MODEL = UNIVERSAL_AREAS;

// ---------------------------------------------------------------------------
// Navigation search entries with synonyms (contract 06 §3 — UX-005)
// ---------------------------------------------------------------------------

/** One Navigation-group entry: a real page, matched on title + synonyms. */
export interface SearchNavigationEntry {
  readonly id: string;
  readonly label: string;
  /** The chip rendered beside the label (the sidebar group it belongs to). */
  readonly group: string;
  readonly href: string;
  /** Match synonyms (contract 06 §3: "matched on title + synonyms"). */
  readonly synonyms: readonly string[];
}

/**
 * Synonyms per navigation title (matched on title + synonyms, contract 06
 * §3). Keys are the SIDEBAR/go-to labels the role projections actually
 * render (the five persistent rows, the workload-group items, and the
 * Settings/Developers sections); the projection-aware consumer labels
 * ("My balances") still match through the keyword tokens (the object nouns).
 * Additive, pure data.
 */
const NAV_SYNONYMS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  // — persistent money-object rows —
  Home: ["overview", "dashboard", "start", "command center"],
  Balances: ["wallet", "funds", "available", "incoming", "settle", "settlement", "withdraw", "payout"],
  Transactions: ["activity", "history", "ledger", "movements"],
  Customers: ["contacts", "guests", "directory", "payers"],
  Catalog: ["products", "prices", "links", "coupons", "perks"],
  // — Accept group —
  Analytics: ["payments", "money in", "charges", "accept"],
  Checkout: ["hosted", "journey", "in person", "qr"],
  Disputes: ["chargeback", "evidence", "risk"],
  Risk: ["chargeback", "fraud", "disputes"],
  "In-person/QR": ["pos", "physical", "store", "qr"],
  "Agentic/links": ["payment links", "no code", "share"],
  // — Bill group —
  Overview: ["billing", "recurring"],
  Subscriptions: ["recurring", "plans", "billing"],
  Invoices: ["invoice", "bill", "billing"],
  "Usage-based": ["metered", "usage"],
  "Dunning/Recovery": ["failed payments", "retry", "recovery"],
  // — Insights group —
  Reports: ["insights", "analytics", "exports", "metrics", "data pipeline"],
  "Custom metrics": ["metrics", "kpis"],
  Exports: ["export", "csv", "data"],
  "Data pipeline": ["etl", "warehouse", "sync"],
  // — Capabilities group —
  Installed: ["apps", "integrations", "capabilities"],
  Browse: ["marketplace", "apps", "discover"],
  // — More group —
  "Tax/Compliance": ["tax", "vat", "compliance"],
  "Connect/marketplace-payouts": ["connect", "providers", "rails", "external accounts"],
  Identity: ["verification", "kyc"],
  Issuing: ["cards", "spend"],
  Workflows: ["automation", "rules"],
  Projects: ["developers", "api keys", "workspaces"],
  // — account sections —
  Settings: ["preferences", "configuration", "customize", "account", "profile"],
  Developers: ["api keys", "projects", "docs", "integration", "webhooks"],
});

function synonymsFor(label: string, fallbackKeywords: string): readonly string[] {
  // Consumer projections relabel rows ("Balances" → "My balances") — the
  // synonym table keys on the registry label, so the projection prefix is
  // stripped before the lookup (roles never re-axis; the words stay).
  const listed = NAV_SYNONYMS[label] ?? NAV_SYNONYMS[label.replace(/^My /, "")];
  const keywordTokens = fallbackKeywords
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 1 && token !== label.toLowerCase());
  return Object.freeze([...(listed ?? []), ...new Set(keywordTokens)]);
}

/**
 * Derive the Navigation group (contract 06 §3): every page the role's
 * sidebar projection exposes (rows + workload-group items, the same model as
 * the ⌘K Go-to section) plus the Settings/Developers sections — each matched
 * on title + synonyms, each bound to its real /app route. Roles never
 * re-axis: the same visibility law as the sidebar (a hidden-for-role surface
 * is not offered).
 */
export function deriveSearchNavigation(role: ProductRole | null): readonly SearchNavigationEntry[] {
  const base = deriveCcPalette(role);
  const nav = deriveNavigationForRole(PRODUCT_NAVIGATION, role ?? "merchant");
  const visible = new Set(nav.items.map((view) => view.item.id));

  const entries: SearchNavigationEntry[] = base.goTo.map((command) => ({
    id: command.id,
    label: command.label,
    group: command.group,
    href: command.href,
    synonyms: synonymsFor(command.label, command.keywords ?? ""),
  }));

  // Settings sections: matched on title + synonyms, offered when the role's
  // derivation can see them (the same law as the journey actions).
  const EXTRA_SECTIONS: ReadonlyArray<{
    readonly navItemId: "settings" | "developers";
    readonly label: string;
    readonly group: string;
  }> = [
    { navItemId: "settings", label: "Settings", group: "Account" },
    { navItemId: "developers", label: "Developers", group: "Account" },
  ];
  for (const section of EXTRA_SECTIONS) {
    if (!visible.has(section.navItemId)) {
      continue;
    }
    entries.push({
      id: `nav-${section.navItemId}`,
      label: section.label,
      group: section.group,
      href: appRouteForNavItemId(section.navItemId),
      synonyms: synonymsFor(section.label, ""),
    });
  }
  return Object.freeze(entries);
}

/**
 * Command Center route binding (P3-W2-002; object-model sidebar binding by
 * UX-003, contracts 01 §3 / 09 §2).
 *
 * The certified navigation models declare their routes on canonical IA
 * prefixes: the legacy product navigation (`@payswap/ux` product-ia.ts
 * `PRODUCT_NAVIGATION`, `/command-center/*`-shaped ids) and the UX-002
 * object-model sidebar registry (`SIDEBAR` — 5 persistent money-object rows
 * + 5 workload groups). The deployed web surface mounts the Command Center
 * at `/app/*`. This module is the ONE binding between the models and the
 * deployment: it derives an /app route for every navigation target (TOTAL —
 * every sidebar row and every group item resolves to a REAL route; law: no
 * nav target 404s) and resolves an active section from a pathname.
 *
 * Binding doctrine (contract 09 §2 "unactivated capabilities render hub
 * pages, never blank or 404"): a registry route whose dedicated surface has
 * not shipped yet binds to the NEAREST REAL surface of its family — the
 * binding table below names the justification for every such fold. When the
 * dedicated surface ships, its binding becomes direct and the fold
 * disappears; nothing here ever invents a route that does not exist.
 *
 * Pure data derivation only; consumes the certified models, never redefines
 * them.
 */

import { navigationItems, navItemById } from "@payswap/ux";
import type { ProductNavItemId } from "@payswap/ux";
import { PRODUCT_NAVIGATION } from "@payswap/ux";
import {
  CREATE_MENU_ITEMS,
  SIDEBAR,
  navGroupTestId,
  navItemTestId,
  type CreateMenuItem,
  type Sidebar,
  type SidebarGroup,
  type SidebarRow,
} from "@payswap/ux";

/** Where the Command Center is mounted in this deployment. */
export const COMMAND_CENTER_BASE = "/app" as const;

/** The overview nav item is the Command Center root itself. */
const ROOT_NAV_ITEM_ID = "overview" as const;

// ---------------------------------------------------------------------------
// Legacy product-navigation binding (P3-W2-002 — unchanged)
// ---------------------------------------------------------------------------

/**
 * The /app route for one navigation item id. Every id in the certified model
 * resolves (unknown ids throw — fail closed, the same doctrine as
 * `navItemById`).
 */
export function appRouteForNavItemId(id: ProductNavItemId): string {
  navItemById(id, PRODUCT_NAVIGATION); // fail-closed existence check
  return id === ROOT_NAV_ITEM_ID ? COMMAND_CENTER_BASE : `${COMMAND_CENTER_BASE}/${id}`;
}

/** Every (nav item, /app route) pair, in navigation order. */
export function appRoutes(): ReadonlyArray<readonly [ProductNavItemId, string]> {
  return navigationItems(PRODUCT_NAVIGATION).map(
    (item) => [item.id, appRouteForNavItemId(item.id)] as const,
  );
}

// ---------------------------------------------------------------------------
// Object-model sidebar binding (UX-003 — contract 01 §3)
// ---------------------------------------------------------------------------

/**
 * The TOTAL binding from every `SIDEBAR` registry route (rows + group
 * items) onto a REAL `/app/*` route of this deployment. Direct bindings
 * first, then family folds — each fold names its honest justification.
 * Every target below exists as a `page.tsx` (test-enforced against the
 * filesystem).
 */
const SIDEBAR_ROUTE_BINDINGS: Readonly<Record<string, string>> = Object.freeze({
  // — persistent money-object rows (direct) —
  "/": COMMAND_CENTER_BASE,
  "/balances": `${COMMAND_CENTER_BASE}/balances`,
  "/transactions": `${COMMAND_CENTER_BASE}/transactions`,
  "/customers": `${COMMAND_CENTER_BASE}/customers`,
  "/catalog": `${COMMAND_CENTER_BASE}/catalog`,

  // — Accept (payments family) —
  "/payments": `${COMMAND_CENTER_BASE}/payments`, // direct: the payments surface
  "/checkout": `${COMMAND_CENTER_BASE}/checkout`, // direct: the checkout journey
  "/disputes": `${COMMAND_CENTER_BASE}/disputes`, // direct: the disputes surface
  // Risk & disputes are ONE lifecycle family (contract 09 §2 "Risk &
  // disputes"); the shared surface serves both until a dedicated risk
  // surface ships.
  "/risk": `${COMMAND_CENTER_BASE}/disputes`,
  // In-person/QR acceptance is a checkout modality (contract 09 §2
  // Transactions-empty ladder lists "Accept in person (QR)" as an
  // acceptance integration); the checkout surface is the acceptance hub.
  "/in-person": `${COMMAND_CENTER_BASE}/checkout`,
  // Payment links live in the Catalog family (contract 09 §2 Catalog:
  // "Products · Prices · Links · Coupons/Perks — same page family").
  "/payment-links": `${COMMAND_CENTER_BASE}/catalog`,

  // — Bill (recurring) —
  "/billing": `${COMMAND_CENTER_BASE}/billing`, // direct: the billing family hub
  // Subscriptions, invoices, usage-based and dunning/recovery are billing
  // family facets (contract 09 §2); the billing hub serves them until their
  // dedicated tabs ship with the workflows wave.
  "/billing/subscriptions": `${COMMAND_CENTER_BASE}/billing`,
  "/invoices": `${COMMAND_CENTER_BASE}/billing`,
  "/billing/usage": `${COMMAND_CENTER_BASE}/billing`,
  "/billing/dunning": `${COMMAND_CENTER_BASE}/billing`,

  // — Insights (reporting) —
  "/reports": `${COMMAND_CENTER_BASE}/reports`, // direct: the reports surface
  // Custom metrics, exports and the data pipeline are reporting facets;
  // the reports surface is the insights hub until they ship.
  "/insights/metrics": `${COMMAND_CENTER_BASE}/reports`,
  "/insights/exports": `${COMMAND_CENTER_BASE}/reports`,
  "/insights/data-pipeline": `${COMMAND_CENTER_BASE}/reports`,

  // — Capabilities (apps/marketplace) —
  "/capabilities/installed": `${COMMAND_CENTER_BASE}/capabilities`,
  "/capabilities/browse": `${COMMAND_CENTER_BASE}/capabilities`,

  // — More (pressure valve) —
  // Tax/compliance configuration is account-level (contract 09 §2 Settings:
  // "Personal vs Account groups"); Settings serves it until a dedicated
  // surface ships.
  "/tax": `${COMMAND_CENTER_BASE}/settings`,
  // Connecting external rails and marketplace payouts is exactly the
  // connections surface (contract 09 §2 "Account connections").
  "/connect": `${COMMAND_CENTER_BASE}/connections`,
  // Identity verification is account-level (same Settings doctrine as tax).
  "/identity": `${COMMAND_CENTER_BASE}/settings`,
  // Issuing spending instruments is a credit-line capability; the credit
  // surface is the nearest family hub until a dedicated one ships.
  "/issuing": `${COMMAND_CENTER_BASE}/credit`,
  // Workflows are the automation family; agents are the automation
  // executors (contract 09 §2 "Agentic/links"), so the agents surface is
  // the hub until the workflows surface ships.
  "/workflows": `${COMMAND_CENTER_BASE}/agents`,
  // Projects are developer workspaces (API keys per project); the
  // developers surface is the family hub.
  "/projects": `${COMMAND_CENTER_BASE}/developers`,
});

/** One sidebar navigation target: a persistent row or a workload-group item. */
export interface SidebarNavTarget {
  /** Registry id ('home' | 'balances' | … | 'checkout' | …). */
  readonly id: string;
  /** Canonical registry label (projection-aware labels derive separately). */
  readonly label: string;
  /** The registry's canonical IA route (e.g. '/billing/subscriptions'). */
  readonly route: string;
  /** The REAL /app route this target binds to in this deployment. */
  readonly appRoute: string;
  /** Stable test hook (nav.item.<slug> per contract 01 §2.5). */
  readonly testId: string;
  /** The workload group's test id when this target lives in a group. */
  readonly groupTestId: string | null;
}

function rowTarget(row: SidebarRow): SidebarNavTarget {
  return {
    id: row.id,
    label: row.label,
    route: row.route,
    appRoute: sidebarRouteBinding(row.route),
    testId: row.testId,
    groupTestId: null,
  };
}

function groupItemTarget(group: SidebarGroup, item: { slug: string; label: string; route: string }): SidebarNavTarget {
  return {
    id: item.slug,
    label: item.label,
    route: item.route,
    appRoute: sidebarRouteBinding(item.route),
    testId: navItemTestId(item.slug),
    groupTestId: navGroupTestId(group.slug),
  };
}

/**
 * The bound /app route for one registry route. Every registry route
 * resolves (unknown routes throw — fail closed, the same doctrine as
 * `appRouteForNavItemId`; a new registry entry without a binding is a
 * compile-of-data error we refuse to render around).
 */
export function sidebarRouteBinding(route: string): string {
  const bound = SIDEBAR_ROUTE_BINDINGS[route];
  if (bound === undefined) {
    throw new Error(`unbound sidebar registry route: ${route}`);
  }
  return bound;
}

/** The /app route for a sidebar persistent row. */
export function appRouteForSidebarRow(row: SidebarRow): string {
  return sidebarRouteBinding(row.route);
}

/** The /app route for a sidebar group item. */
export function appRouteForSidebarGroupItem(item: { route: string }): string {
  return sidebarRouteBinding(item.route);
}

/** Every sidebar navigation target (rows first, then group items, registry order). */
export function sidebarNavTargets(sidebar: Sidebar = SIDEBAR): readonly SidebarNavTarget[] {
  return [
    ...sidebar.rows.map(rowTarget),
    ...sidebar.groups.flatMap((group) => group.items.map((item) => groupItemTarget(group, item))),
  ];
}

// ---------------------------------------------------------------------------
// Create split-button routing (contract 01 §6 — UX-003 deliverable 3)
// ---------------------------------------------------------------------------

/** The route each Create-menu entry opens (work-order-mandated targets). */
const CREATE_ITEM_ROUTES: Readonly<Record<CreateMenuItem["id"], string>> = Object.freeze({
  pay: `${COMMAND_CENTER_BASE}/payments`,
  request: `${COMMAND_CENTER_BASE}/payments?start=1`,
  invoice: `${COMMAND_CENTER_BASE}/billing`,
  "payment-link": `${COMMAND_CENTER_BASE}/catalog?new=link`,
  convert: `${COMMAND_CENTER_BASE}/convert`,
});

/** The /app route one Create-menu entry routes to (fail-closed). */
export function appRouteForCreateMenuItem(id: CreateMenuItem["id"]): string {
  const route = CREATE_ITEM_ROUTES[id];
  if (route === undefined) {
    throw new Error(`unbound create-menu item: ${id}`);
  }
  return route;
}

/** Every Create-menu entry with its bound route (the shell's CreateMenu data). */
export function createMenuTargets(
  items: readonly CreateMenuItem[] = CREATE_MENU_ITEMS,
): ReadonlyArray<readonly [CreateMenuItem, string]> {
  return items.map((item) => [item, appRouteForCreateMenuItem(item.id)] as const);
}

// ---------------------------------------------------------------------------
// Pathname resolution (legacy sections + sidebar targets)
// ---------------------------------------------------------------------------

export interface ResolvedAppSection {
  readonly kind: "SECTION";
  readonly navItemId: ProductNavItemId;
  readonly route: string;
}

/** A pathname that resolves onto an object-model sidebar target. */
export interface ResolvedAppSidebarRoute {
  readonly kind: "SIDEBAR";
  readonly target: SidebarNavTarget;
  readonly route: string;
}

export type AppSectionResolution =
  | ResolvedAppSection
  | ResolvedAppSidebarRoute
  | { readonly kind: "NOT_APP" }
  | { readonly kind: "UNKNOWN_SECTION"; readonly path: string };

/** Registry routes bound to a given /app route, keyed for reverse lookup. */
const SIDEBAR_TARGETS_BY_APP_ROUTE: ReadonlyMap<string, readonly SidebarNavTarget[]> =
  groupTargetsByAppRoute(sidebarNavTargets());

function groupTargetsByAppRoute(
  targets: readonly SidebarNavTarget[],
): ReadonlyMap<string, readonly SidebarNavTarget[]> {
  const map = new Map<string, SidebarNavTarget[]>();
  for (const target of targets) {
    const existing = map.get(target.appRoute);
    if (existing === undefined) {
      map.set(target.appRoute, [target]);
    } else {
      existing.push(target);
    }
  }
  return map;
}

/**
 * Resolve a pathname against the Command Center route model. `/app` and every
 * `/app/<section>` that matches a LEGACY nav item resolves to its section
 * (the deployed page truth); a top-level `/app/<slug>` that matches a sidebar
 * ROW binding (home surface family: balances, transactions, customers,
 * catalog) resolves to its sidebar target; an /app path that matches nothing
 * is UNKNOWN_SECTION (the honest deep-link notice — never a silent
 * redirect); anything outside /app is NOT_APP.
 */
export function resolveAppSection(pathname: string): AppSectionResolution {
  if (pathname === COMMAND_CENTER_BASE) {
    return { kind: "SECTION", navItemId: ROOT_NAV_ITEM_ID, route: COMMAND_CENTER_BASE };
  }
  if (!pathname.startsWith(`${COMMAND_CENTER_BASE}/`)) {
    return { kind: "NOT_APP" };
  }
  const slug = pathname.slice(COMMAND_CENTER_BASE.length + 1);
  if (slug.includes("/")) {
    return { kind: "UNKNOWN_SECTION", path: pathname };
  }
  const legacy = appRoutes().find(([, route]) => route === pathname);
  if (legacy !== undefined) {
    return { kind: "SECTION", navItemId: legacy[0], route: legacy[1] };
  }
  const sidebarTargets = SIDEBAR_TARGETS_BY_APP_ROUTE.get(pathname);
  if (sidebarTargets !== undefined) {
    // The persistent-row target owns the resolution when one binds here;
    // group items that fold onto a legacy route above never reach this arm.
    const row = sidebarTargets.find((target) => target.groupTestId === null);
    const owner = row ?? sidebarTargets[0]!;
    return { kind: "SIDEBAR", target: owner, route: owner.appRoute };
  }
  return { kind: "UNKNOWN_SECTION", path: pathname };
}

/**
 * The deepest KNOWN /app route for a pathname (shell breadcrumb/active-state
 * helper): nested paths (object detail routes like /app/payments/<id>) resolve
 * to their collection's route so the sidebar can mark the family honestly;
 * unknown paths fall back to the Command Center root. Purely presentational
 * — the page itself still decides what renders (deep links never silently
 * redirect).
 */
export function deepestKnownAppRoute(pathname: string): string {
  const resolution = resolveAppSection(pathname);
  if (resolution.kind === "SECTION" || resolution.kind === "SIDEBAR") {
    return resolution.route;
  }
  if (resolution.kind === "NOT_APP") {
    return COMMAND_CENTER_BASE;
  }
  // UNKNOWN_SECTION (nested or unmatched): peel trailing segments until a
  // known route matches, so detail pages keep their collection active.
  const segments = pathname.slice(COMMAND_CENTER_BASE.length + 1).split("/");
  while (segments.length > 1) {
    segments.pop();
    const candidate = `${COMMAND_CENTER_BASE}/${segments.join("/")}`;
    const candidateResolution = resolveAppSection(candidate);
    if (candidateResolution.kind === "SECTION" || candidateResolution.kind === "SIDEBAR") {
      return candidateResolution.route;
    }
  }
  return COMMAND_CENTER_BASE;
}

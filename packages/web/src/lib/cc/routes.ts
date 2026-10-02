/**
 * Command Center route binding (P3-W2-002).
 *
 * The certified navigation model (`@payswap/ux` product-ia.ts) declares its
 * routes on the canonical `/command-center/*` prefix (the product IA's own
 * route model). The deployed web surface mounts the Command Center at
 * `/app/*` (the surface Wave 1 shipped and the deployment records reference).
 * This module is the ONE binding between the two: it derives an /app route
 * for every navigation item id (total — every nav item resolves, law 4) and
 * resolves an active section from a pathname.
 *
 * Pure data derivation only; consumes the certified model, never redefines it.
 */

import { navigationItems, navItemById } from "@payswap/ux";
import type { ProductNavItemId } from "@payswap/ux";
import { PRODUCT_NAVIGATION } from "@payswap/ux";

/** Where the Command Center is mounted in this deployment. */
export const COMMAND_CENTER_BASE = "/app" as const;

/** The overview nav item is the Command Center root itself. */
const ROOT_NAV_ITEM_ID = "overview" as const;

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

export interface ResolvedAppSection {
  readonly kind: "SECTION";
  readonly navItemId: ProductNavItemId;
  readonly route: string;
}

export type AppSectionResolution =
  | ResolvedAppSection
  | { readonly kind: "NOT_APP" }
  | { readonly kind: "UNKNOWN_SECTION"; readonly path: string };

/**
 * Resolve a pathname against the Command Center route model. `/app` and every
 * `/app/<section>` that matches a nav item resolves to its section; an /app
 * path that matches nothing is UNKNOWN_SECTION (the honest deep-link notice
 * — never a silent redirect); anything outside /app is NOT_APP.
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
  const match = appRoutes().find(([, route]) => route === pathname);
  if (match === undefined) {
    return { kind: "UNKNOWN_SECTION", path: pathname };
  }
  return { kind: "SECTION", navItemId: match[0], route: match[1] };
}

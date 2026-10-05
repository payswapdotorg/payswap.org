/**
 * The universal area navigation binding (P4-W4-002 §3.2).
 *
 * The eleven-area IA lives in @payswap/surface (the versioned, React-free
 * contract). THIS module binds it into the deployed web surface:
 *
 * - each area's route is the surface's canonical route (total binding —
 *   every area resolves);
 * - VISIBILITY follows the certified role derivation (the @payswap/ux
 *   law): an area bound to a certified nav item is visible exactly when
 *   that item is visible for the role (e.g. Opportunities and Developers
 *   are excluded for the merchant derivation — the existing shell tests
 *   assert that law and the universal layer must not violate it);
 * - areas with no certified counterpart (Overview root, Accounts,
 *   Connections, Security, Reports) are visible to every authenticated
 *   role — they render honest states, so hiding them would hide honesty;
 * - the two outcome-only routes (Convert, Checkout) resolve for active
 *   highlighting but are NOT sidebar areas (they are journeys reached
 *   through the outcome launcher and the palette).
 *
 * Pure data derivation; consumes the surface contract, never redefines it.
 */

import type { RoleNavigationView } from "@payswap/ux";
import { UNIVERSAL_AREAS, type UniversalArea, type UniversalAreaId } from "@payswap/surface";

/** Areas bound to a certified nav item inherit ITS role visibility. */
const CERTIFIED_BINDING: Partial<Record<UniversalAreaId, string>> = {
  payments: "payments",
  activity: "activity",
  opportunities: "opportunities",
  capabilities: "capabilities",
  developers: "developers",
  settings: "settings",
};

/** Outcome-only routes (journeys, not sidebar areas). */
export const OUTCOME_ROUTES: ReadonlyArray<{
  readonly outcomeId: "convert" | "checkout";
  readonly route: string;
}> = Object.freeze([
  { outcomeId: "convert", route: "/app/convert" },
  { outcomeId: "checkout", route: "/app/checkout" },
] as const);

export interface UniversalAreaView {
  readonly area: UniversalArea;
  readonly route: string;
  readonly visible: boolean;
}

/** The area views for one role derivation (ordered, visibility-derived). */
export function deriveUniversalAreaViews(nav: RoleNavigationView): readonly UniversalAreaView[] {
  const visibleCertified = new Set<string>(nav.items.map((view) => view.item.id));
  return UNIVERSAL_AREAS.map((area) => {
    const bound = CERTIFIED_BINDING[area.id];
    return {
      area,
      route: area.route,
      visible: bound === undefined ? true : visibleCertified.has(bound),
    };
  });
}

/** Resolve a pathname to a universal area route (or null). */
export function resolveUniversalAreaRoute(pathname: string): string | null {
  const match = UNIVERSAL_AREAS.find((area) => area.route === pathname);
  if (match !== undefined) {
    return match.route;
  }
  return OUTCOME_ROUTES.find((entry) => entry.route === pathname)?.route ?? null;
}

/** The visible areas for the sidebar's universal group. */
export function visibleUniversalAreas(nav: RoleNavigationView): readonly UniversalArea[] {
  return deriveUniversalAreaViews(nav)
    .filter((view) => view.visible)
    .map((view) => view.area);
}

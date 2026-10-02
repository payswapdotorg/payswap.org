/**
 * Command Center palette derivation (P3-W2-002).
 *
 * Pure derivation of the ⌘K CommandPalette command model from the certified
 * contracts — Actions (verb-first, from the journey/navigation bindings) and
 * Go-to (every section the current role's derived navigation exposes). The
 * shell maps each derived command to a real navigation; there are no
 * placeholder commands. Every journey action respects the role-derived
 * visibility of its bound navigation item (a role that cannot see Payments
 * is not offered "Pay a recipient").
 */

import type { ProductNavItemId, ProductRole, RoleNavigationView } from "@payswap/ux";
import { deriveNavigationForRole } from "@payswap/ux";
import { PRODUCT_NAVIGATION } from "@payswap/ux";

import { appRouteForNavItemId } from "./routes";

/** One palette command as derived data (the shell attaches the navigation). */
export interface PaletteCommandSpec {
  readonly id: string;
  readonly label: string;
  /** Suffix chip (the group the command renders under). */
  readonly group: string;
  readonly href: string;
  readonly keywords?: string;
}

/** The verb-first journey actions, bound to their navigation items. */
const JOURNEY_ACTIONS: ReadonlyArray<{
  readonly id: string;
  readonly label: string;
  readonly group: string;
  readonly navItemId: ProductNavItemId;
  readonly hrefSuffix?: string;
  readonly keywords: string;
}> = [
  {
    id: "action-pay",
    label: "Pay a recipient",
    group: "Money movement",
    navItemId: "payments",
    hrefSuffix: "?start=1",
    keywords: "send payment pay recipient money",
  },
  {
    id: "action-collect",
    label: "Collect from a payer",
    group: "Money movement",
    navItemId: "collections",
    hrefSuffix: "?start=1",
    keywords: "request collect invoice payer",
  },
  {
    id: "action-payout",
    label: "Request a payout",
    group: "Money movement",
    navItemId: "payouts",
    hrefSuffix: "?start=1",
    keywords: "withdraw payout disburse destination",
  },
  {
    id: "action-connect",
    label: "Connect a provider",
    group: "Capabilities",
    navItemId: "capabilities",
    keywords: "connect provider capability",
  },
  {
    id: "action-evidence",
    label: "View evidence for an action",
    group: "Trust",
    navItemId: "evidence",
    keywords: "evidence proof provenance artifact",
  },
  {
    id: "action-capabilities",
    label: "Browse provider capabilities",
    group: "Capabilities",
    navItemId: "capabilities",
    keywords: "providers capabilities health coverage",
  },
  {
    id: "action-settings",
    label: "Open settings",
    group: "Account",
    navItemId: "settings",
    keywords: "settings session role preferences",
  },
] as const;

/**
 * The "Connect a provider" action links to the connection flows owned by the
 * parallel work stream (P3-W1-002) — linked by route string per the work
 * order; the route resolves when that plane merges.
 */
const CONNECT_ROUTE = "/connect" as const;

/**
 * The role used to derive the palette before any role preference exists
 * (the same default the shell's navigation derivation uses — the merchant
 * view is the product's primary persona and declares no exclusive
 * capability; see the shell layout for the honesty note).
 */
export const DEFAULT_PALETTE_ROLE: ProductRole = "merchant";

/**
 * Derive the Actions section: journey starts whose bound navigation item is
 * visible for the role.
 */
export function derivePaletteActions(role: ProductRole | null): readonly PaletteCommandSpec[] {
  const nav: RoleNavigationView = deriveNavigationForRole(
    PRODUCT_NAVIGATION,
    role ?? DEFAULT_PALETTE_ROLE,
  );
  const visible = new Set(nav.items.map((view) => view.item.id));
  return JOURNEY_ACTIONS.flatMap((action) => {
    if (!visible.has(action.navItemId)) {
      return [];
    }
    const href =
      action.id === "action-connect"
        ? CONNECT_ROUTE
        : `${appRouteForNavItemId(action.navItemId)}${action.hrefSuffix ?? ""}`;
    return [
      {
        id: action.id,
        label: action.label,
        group: action.group,
        href,
        keywords: action.keywords,
      },
    ];
  });
}

/** The certified group labels, keyed by group id (data, not hardcode). */
const GROUP_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  PRODUCT_NAVIGATION.groups.map((group) => [group.id, group.label]),
);

/**
 * Derive the Go-to section: every section the current role's derived
 * navigation exposes, labeled with its nav label and chipped with its group.
 */
export function derivePaletteGoTo(role: ProductRole | null): readonly PaletteCommandSpec[] {
  const nav: RoleNavigationView = deriveNavigationForRole(
    PRODUCT_NAVIGATION,
    role ?? DEFAULT_PALETTE_ROLE,
  );
  return nav.items.map((view) => ({
    id: `goto-${view.item.id}`,
    label: view.item.label,
    group: GROUP_LABELS[view.item.group] ?? view.item.group,
    href: appRouteForNavItemId(view.item.id),
    keywords: view.item.summary,
  }));
}

/** The full palette model the shell renders (Actions first, then Go-to). */
export interface CcPaletteModel {
  readonly actions: readonly PaletteCommandSpec[];
  readonly goTo: readonly PaletteCommandSpec[];
}

export function deriveCcPalette(role: ProductRole | null): CcPaletteModel {
  return {
    actions: derivePaletteActions(role),
    goTo: derivePaletteGoTo(role),
  };
}

/**
 * The universal palette extension (P4-W4-002 §3.3).
 *
 * The certified Command Center palette (P3-W2-002, lib/cc/palette.ts) is
 * EXTENDED — never replaced — with the universal interface's surface:
 *
 * - the five OUTCOME ACTIONS (Pay / Receive / Move / Convert / Checkout),
 *   verb-first, each bound to its real journey route;
 * - GO-TO entries for the universal areas that are visible in the current
 *   role derivation (the same visibility law as the sidebar group).
 *
 * Every command maps to a REAL route (no placeholder commands, no fake
 * matches); the palette is keyboard-accessible via the shared
 * @payswap/design CommandPalette primitive the shell already renders.
 */

import type { ProductRole } from "@payswap/ux";
import { deriveNavigationForRole, PRODUCT_NAVIGATION } from "@payswap/ux";
import { OUTCOME_REGISTRY, UNIVERSAL_AREAS } from "@payswap/surface";

import { deriveCcPalette, type PaletteCommandSpec } from "@/lib/cc/palette";
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
    actions: [...outcomeActions, ...base.actions],
    goTo: [...areaGoTo, ...base.goTo],
  };
}

/** The area registry for renderers that want it directly (typed data). */
export const UNIVERSAL_AREA_MODEL = UNIVERSAL_AREAS;

/**
 * Command Center palette derivation (P3-W2-002; object-model nav entries by
 * UX-003).
 *
 * Pure derivation of the ⌘K CommandPalette command model from the certified
 * contracts — Actions (verb-first, from the journey/navigation bindings) and
 * Go-to (the object-model sidebar registry: the five persistent rows +
 * every workload-group item the role's projection exposes, each bound to
 * its REAL /app route). The shell maps each derived command to a real
 * navigation; there are no placeholder commands. Every journey action
 * respects the role-derived visibility of its bound navigation item (a role
 * that cannot see Payments is not offered "Pay a recipient").
 */

import type { CommandVerb, ProductNavItemId, ProductRole } from "@payswap/ux";
import { deriveNavigationForRole, projectSidebar } from "@payswap/ux";
import { PRODUCT_NAVIGATION } from "@payswap/ux";

import { appRouteForNavItemId, appRouteForSidebarGroupItem, appRouteForSidebarRow } from "./routes";

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

/** The palette chip for the persistent money-object rows (contract 01 §3). */
const ROW_GROUP_LABEL = "Money objects" as const;

/**
 * Derive the Actions section: journey starts whose bound navigation item is
 * visible for the role.
 */
export function derivePaletteActions(role: ProductRole | null): readonly PaletteCommandSpec[] {
  const nav = deriveNavigationForRole(
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

/**
 * Derive the Go-to section from the OBJECT-MODEL SIDEBAR registry (UX-003):
 * the five persistent rows (projection-aware labels — a consumer projection
 * says "My balances") plus every workload-group item the role's projection
 * exposes, each bound to its real /app route. Unbound registry entries are
 * impossible (the route binding is total); a registry entry whose route
 * folds onto a shared surface keeps its own label and keywords so search
 * finds it by the workload name.
 */
export function derivePaletteGoTo(role: ProductRole | null): readonly PaletteCommandSpec[] {
  const projection = projectSidebar(role ?? DEFAULT_PALETTE_ROLE);
  const rows = projection.rows.map((view) => ({
    id: `goto-${view.row.id}`,
    label: view.label,
    group: ROW_GROUP_LABEL,
    href: appRouteForSidebarRow(view.row),
    keywords: `${view.row.object} ${view.row.label}`,
  }));
  const groupItems = projection.groups
    .filter((view) => view.visible)
    .flatMap((view) =>
      view.group.items.map((item) => ({
        id: `goto-${item.slug}`,
        label: item.label,
        group: view.group.label,
        href: appRouteForSidebarGroupItem(item),
        keywords: `${item.label} ${view.group.label}`,
      })),
    );
  return [...rows, ...groupItems];
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

// ---------------------------------------------------------------------------
// The six-verb command grammar entries (contract 06 §3/§4 — UX-005)
// ---------------------------------------------------------------------------

/**
 * One entry of the Commands group: the grammar verbs `pay · request ·
 * invoice · link · convert · withdraw` (the same six as `COMMAND_VERBS` in
 * @payswap/ux — this table only binds them to THIS deployment's real routes
 * and their search synonyms; the grammar itself is never re-defined here).
 */
export interface CommandGrammarEntry {
  readonly verb: CommandVerb;
  readonly id: string;
  readonly label: string;
  /** What the verb does, in one honest line (rendered as the row detail). */
  readonly detail: string;
  readonly group: "Commands";
  /** Match synonyms for the entry (title + synonyms, contract 06 §3). */
  readonly keywords: string;
  /** The workflow surface this verb opens when nothing is parsed. */
  readonly href: string;
}

/**
 * The six verbs and their REAL route targets (work-order-mandated):
 * - pay → /app/payments?start=1 (the W1 create-payment workflow);
 * - request → the W1 form (the certified CreateMenu `c r` target; a dedicated
 *   request-mode toggle inside W1 does not exist yet — the form is the target);
 * - invoice → /app/billing (the billing family hub);
 * - link → /app/payments/link (the W2 payment-link builder);
 * - convert → /app/convert (the conversion journey);
 * - withdraw → /app/balances (the Balances withdraw flow — the routing kind
 *   `balances-withdraw-flow` in @payswap/ux COMMAND_VERB_ROUTING; the
 *   surface's Withdraw action proceeds to the real payout journey).
 */
export const COMMAND_GRAMMAR_ENTRIES: readonly CommandGrammarEntry[] = Object.freeze([
  Object.freeze({
    verb: "pay",
    id: "command-pay",
    label: "Pay",
    detail: "Send money to a recipient (opens the payment form)",
    group: "Commands",
    keywords: "pay send money recipient usdc transfer",
    href: "/app/payments?start=1",
  }),
  Object.freeze({
    verb: "request",
    id: "command-request",
    label: "Request",
    detail: "Request money from a payer (opens the payment form)",
    group: "Commands",
    keywords: "request collect ask payer invoice money",
    href: "/app/payments?start=1",
  }),
  Object.freeze({
    verb: "invoice",
    id: "command-invoice",
    label: "Invoice",
    detail: "Bill a customer — the billing surface",
    group: "Commands",
    keywords: "invoice bill customer subscription recurring",
    href: "/app/billing",
  }),
  Object.freeze({
    verb: "link",
    id: "command-link",
    label: "Link",
    detail: "Create a no-code payment link",
    group: "Commands",
    keywords: "link payment-link share product checkout donate",
    href: "/app/payments/link",
  }),
  Object.freeze({
    verb: "convert",
    id: "command-convert",
    label: "Convert",
    detail: "Convert between currencies and rails",
    group: "Commands",
    keywords: "convert swap exchange currency rail",
    href: "/app/convert",
  }),
  Object.freeze({
    verb: "withdraw",
    id: "command-withdraw",
    label: "Withdraw",
    detail: "Withdraw to a connected destination (Balances withdraw flow)",
    group: "Commands",
    keywords: "withdraw payout cash out destination bank",
    href: "/app/balances",
  }),
] as const);

/** The Commands-group entries as palette command specs (the ⌘K palette). */
export function derivePaletteCommands(): readonly PaletteCommandSpec[] {
  return COMMAND_GRAMMAR_ENTRIES.map((entry) => ({
    id: entry.id,
    label: `${entry.label} — ${entry.detail.replace(/\s*\(.*\)$/, "")}`,
    group: entry.group,
    href: entry.href,
    keywords: `${entry.verb} ${entry.keywords}`,
  }));
}

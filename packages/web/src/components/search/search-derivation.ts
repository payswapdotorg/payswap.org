/**
 * UX-005 — the universal search/command surface: the PURE derivation engine
 * (contract 06 §3–§5).
 *
 * ONE surface does BOTH (§1): finding resources and executing intentions.
 * This module derives the grouped, ranked result model from pure inputs —
 * the typed query, the role, the injected contact directory, the honest
 * resources read and the local recents — with NO DOM, NO network, NO clock
 * (the component owns those). Everything the contract mandates is derived
 * here so the battery can pin it:
 *
 * - COMMANDS (§3.1/§4): the six verbs `pay · request · invoice · link ·
 *   convert · withdraw`, typed input parsed through the UX-002 grammar
 *   (`parseCommand`); a missing parameter is an ABSENT field, never a parse
 *   error — the workflow form opens PRE-FILLED and asks for the rest;
 *   ambiguity renders disambiguation chips (which Alice? which target
 *   asset?) — never a dead end, never a guess;
 * - RESOURCES (§3.2): payments rows through the honest payments-plane fold
 *   (masked IDs, exact amounts, StatusChip state); the other spec'd types
 *   render their honest not-configured states — never fake results;
 * - NAVIGATION (§3.3): pages + settings sections, matched on title +
 *   synonyms;
 * - NO-RESULT (§5): "No matches for '<q>'" + closest suggestions + the
 *   "Create payment for '<q>'?" intent-turn (the miss becomes an intent);
 * - ZERO-STATE (§5): recents + "New payment" quick actions.
 *
 * Money law: amounts are the VERBATIM grammar tokens; the pre-fill href
 * carries EXACT minor units (BigInt `parseAmountToMinorUnits`) — no float
 * ever touches a money path (AGENTS.md rule 3).
 */

import type {
  CommandModifier,
  CommandVerb,
  ContactDirectoryEntry,
  DisambiguationChip,
  NoResultIntentTurn,
  ProductRole,
  WorkflowFormPrefill,
} from "@payswap/ux";
import {
  noResultIntentTurn,
  parseCommand,
  resolveCounterparty,
  workflowFormPrefillFromIntent,
} from "@payswap/ux";
import { fuzzyMatch } from "@payswap/design";

import { COMMAND_GRAMMAR_ENTRIES } from "@/lib/cc/palette";
import { deriveSearchNavigation } from "@/lib/universal/palette";
import type { PaymentRecordView } from "@/app/app/payments/_view/payment-view";
import {
  formatEventTimestamp,
  formatMoney,
  parseAmountToMinorUnits,
} from "@/app/app/payments/_view/payment-view";
import type { PaymentsReadResult } from "@/app/app/payments/_server/payments-plane";

import type {
  SearchPaymentRow,
  SearchRecentEntry,
  SearchResourcesResult,
} from "./search-types";

// ---------------------------------------------------------------------------
// Identifier masking (contract 06 §3: list cells carry masked IDs)
// ---------------------------------------------------------------------------

/**
 * Mask a public identifier for list-cell display: short ids render verbatim,
 * long ids keep a 10-char head + 4-char tail ("pay_test_usdc_base_to_eur" →
 * "pay_test_u…_to_eur"? no — head…tail). The FULL id stays the detail
 * route's href; only the display is masked.
 */
export function maskIdentifier(id: string): string {
  if (id.length <= 16) {
    return id;
  }
  return `${id.slice(0, 10)}…${id.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// The honest payments fold (Resources group data source)
// ---------------------------------------------------------------------------

/**
 * The env-var NAMES the honest unconfigured state teaches. These mirror the
 * plane's own constants (`API_BASE_URL_ENV_VAR`, `TEST_FIXTURES_ENV_VAR`)
 * without importing the server plane module into the client-shared
 * derivation — the equality is TEST-ENFORCED (names only; values never
 * render on a surface).
 */
const SEARCH_API_ENV_VAR_NAME = "NEXT_PUBLIC_PAYSWAP_API_URL";
const SEARCH_FIXTURES_ENV_VAR_NAME = "WEB_APP_TEST_PAYMENT_FIXTURES";

/** How many payments rows one query renders (ranked by recency of creation). */
const MAX_PAYMENT_ROWS = 8;

/**
 * Fold one payments-plane read into the Resources-group result (pure; the
 * server action injects the plane read):
 * - ok → the query-matching rows (id/counterparty/description/amount/
 *   method masked-line, case-insensitive substring), list-cell shaped with
 *   masked IDs and exact pre-formatted amounts;
 * - every non-ok outcome keeps its OWN status — the honest-state ladder,
 *   never "no results" in place of an unconfigured or failed read.
 */
export function foldPaymentsReadForSearch(
  read: PaymentsReadResult<readonly PaymentRecordView[]>,
  query: string,
): SearchResourcesResult {
  if (read.status !== "ok") {
    if (read.status === "http-error" || read.status === "network-error") {
      return { status: read.status, message: read.message };
    }
    return { status: read.status };
  }
  const needle = query.trim().toLowerCase();
  const rows: SearchPaymentRow[] = [];
  for (const payment of read.data) {
    if (needle.length > 0 && !paymentMatchesQuery(payment, needle)) {
      continue;
    }
    rows.push({
      id: payment.id,
      maskedId: maskIdentifier(payment.id),
      state: payment.state,
      ...(payment.stateDetail === undefined ? {} : { stateDetail: payment.stateDetail }),
      amount: formatMoney(payment.amount),
      counterparty: payment.counterparty.name,
      ...(payment.description === undefined ? {} : { description: payment.description }),
      createdAt: formatEventTimestamp(payment.createdAt),
      ...(payment.method === undefined ? {} : { methodLine: payment.method.maskedLine }),
    });
    if (rows.length >= MAX_PAYMENT_ROWS) {
      break;
    }
  }
  return {
    status: "ok",
    source: read.source,
    payments: Object.freeze(rows),
  };
}

/** Case-insensitive substring match over a payment's searchable text. */
function paymentMatchesQuery(payment: PaymentRecordView, needle: string): boolean {
  const haystack = [
    payment.id,
    payment.counterparty.name,
    payment.counterparty.email ?? "",
    payment.description ?? "",
    formatMoney(payment.amount),
    payment.amount.currency,
    payment.method?.maskedLine ?? "",
    payment.method?.rail ?? "",
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}

// ---------------------------------------------------------------------------
// Matching + ranking (deterministic; ties break on registry order)
// ---------------------------------------------------------------------------

/** Deterministic match score (0 = no match). Higher is better. */
export function matchScore(query: string, fields: readonly string[]): number {
  const q = query.trim().toLowerCase();
  if (q.length === 0) {
    return 0;
  }
  let best = 0;
  for (const field of fields) {
    const f = field.toLowerCase();
    if (f === q) {
      best = Math.max(best, 40);
    } else if (f.startsWith(q)) {
      best = Math.max(best, 32);
    } else if (new RegExp(`\\b${escapeRegExp(q)}`).test(f)) {
      best = Math.max(best, 24);
    } else if (f.includes(q)) {
      best = Math.max(best, 16);
    } else if (fuzzyMatch(q, f)) {
      best = Math.max(best, 6);
    }
  }
  return best;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// The pre-fill href seam (missing parameters PRE-FILL — never a parse error)
// ---------------------------------------------------------------------------

/** The closed asset set the W1/W2 workflow forms offer (their certified CURRENCIES). */
const ASSET_CANDIDATES: readonly string[] = Object.freeze(["USDC", "EUR", "USD", "GHS"]);

export interface CommandChoices {
  /** The counterparty the operator picked from a disambiguation chip (if any). */
  readonly counterpartyName?: string;
  /** The target asset the operator picked from an asset chip (if any). */
  readonly asset?: string;
}

/**
 * An asset CODE in the shape the grammar itself accepts (any alphanumeric
 * token — the grammar validates `[a-z0-9]+` before it lands in assetText,
 * and real codes range 2–10 chars: USD, EUR, GHS, ETH, USDC…). This guard
 * exists only to keep an EMPTY/blank value honest — never to re-validate
 * what the grammar already certified (a 3-char-only check would silently
 * mis-basis 4-char codes like USDC onto the fiat default).
 */
function isAssetCode(asset: string): boolean {
  return /^[A-Z0-9]{2,10}$/.test(asset);
}

/**
 * The target href for one parsed (partial) intent: the verb's REAL workflow
 * surface, carrying the pre-fill in the link:
 * - pay/request → `/app/payments?start=1` + `to` · `amount` (EXACT minor
 *   units) · `asset` (the code the minor units were computed with — ALWAYS
 *   carried alongside `amount`, so the consumer re-derives the same text;
 *   "USD" is the fiat-default basis when the grammar parsed no asset) — the
 *   W1 pre-fill seam (the page seeds the form's initial state from it);
 * - link → `/app/payments/link` + `amount` (exact minor units) · `currency`
 *   · `name` — the params the W2 builder page consumes TODAY;
 * - convert → `/app/convert` + `from`/`to` asset codes + `amount` (exact
 *   minor units, from-asset exponent) — the page renders the parsed request
 *   honestly through the journey surface's display-only `request` model;
 * - invoice → `/app/billing`; withdraw → `/app/balances` (the withdraw flow).
 *
 * Money law: `amount` params are exact BigInt minor units and the asset the
 * exponent came from is stated in the same link — an unparseable amount
 * omits the param (never a wrong number ships). Chosen chips win over the
 * raw parsed text.
 */
export function commandPrefillHref(
  prefill: WorkflowFormPrefill,
  choices: CommandChoices = {},
): string {
  const asset = (choices.asset ?? prefill.assetText ?? "").trim().toUpperCase();
  const counterparty = (choices.counterpartyName ?? prefill.counterpartyText ?? "").trim();
  const toModifier = prefill.modifiers.find((modifier) => modifier.key === "to")?.value ?? "";

  switch (prefill.verb) {
    case "pay":
    case "request": {
      const params = new URLSearchParams();
      if (counterparty.length > 0) {
        params.set("to", counterparty);
      }
      // The conversion basis: the parsed/chosen asset when it is a code,
      // else the fiat default (assetExponent's own default). The SAME code
      // ships as the `asset` param whenever an amount ships, so the W1 page
      // re-derives the identical amount text (formatMinorUnits is exact).
      const conversionAsset = isAssetCode(asset) ? asset : "USD";
      const minor = parseAmountToMinorUnits(prefill.amountText, conversionAsset);
      if (minor !== null) {
        params.set("amount", minor);
        params.set("asset", conversionAsset);
      } else if (isAssetCode(asset)) {
        params.set("asset", asset);
      }
      return withParams("/app/payments?start=1", params);
    }
    case "link": {
      const params = new URLSearchParams();
      const conversionAsset = isAssetCode(asset) ? asset : "USD";
      const minor = parseAmountToMinorUnits(prefill.amountText, conversionAsset);
      if (minor !== null) {
        params.set("amount", minor);
        params.set("currency", conversionAsset);
      }
      if (counterparty.length > 0) {
        params.set("name", counterparty.slice(0, 80));
      }
      return withParams("/app/payments/link", params);
    }
    case "convert": {
      const params = new URLSearchParams();
      if (asset.length > 0) {
        params.set("from", asset);
      }
      const target = (choices.asset ?? toModifier ?? "").trim().toUpperCase();
      if (target.length > 0) {
        params.set("to", target);
      }
      // The amount ships as exact minor units of the FROM asset (the
      // exponent the consumer needs is the one stated in `from`).
      if (isAssetCode(asset)) {
        const minor = parseAmountToMinorUnits(prefill.amountText, asset);
        if (minor !== null) {
          params.set("amount", minor);
        }
      }
      return withParams("/app/convert", params);
    }
    case "invoice":
      return "/app/billing";
    case "withdraw":
      return "/app/balances";
  }
}

function withParams(base: string, params: URLSearchParams): string {
  const suffix = params.toString();
  return suffix.length === 0 ? base : `${base}${base.includes("?") ? "&" : "?"}${suffix}`;
}

/** Display-name form of a typed token ("alice" → "Alice"). */
function displayToken(token: string): string {
  return token.length === 0 ? token : token[0]!.toUpperCase() + token.slice(1);
}

/**
 * The human pre-fill summary line (rendered under the parsed command):
 * "Pre-fill: Alice · 100 · USDC — the form asks for: amount, asset"; a
 * conversion states its target ("Pre-fill: 2 · ETH → USDC").
 */
export function prefillSummaryLine(
  prefill: WorkflowFormPrefill,
  choices: CommandChoices = {},
): string | null {
  const parts: string[] = [];
  const counterparty = choices.counterpartyName ?? prefill.counterpartyText;
  if (counterparty !== undefined && counterparty.trim().length > 0) {
    parts.push(displayToken(counterparty.trim()));
  }
  if (prefill.amountText !== undefined && prefill.amountText.length > 0) {
    parts.push(prefill.amountText);
  }
  const asset = choices.asset ?? prefill.assetText;
  if (asset !== undefined && asset.trim().length > 0) {
    parts.push(asset.trim().toUpperCase());
  }
  if (parts.length === 0 && prefill.verb !== "convert") {
    return null;
  }
  let line = parts.length > 0 ? `Pre-fill: ${parts.join(" · ")}` : "Pre-fill";
  if (prefill.verb === "convert") {
    const target = (
      choices.asset ??
      prefill.modifiers.find((modifier) => modifier.key === "to")?.value ??
      ""
    )
      .trim()
      .toUpperCase();
    const source = (choices.asset ?? prefill.assetText ?? "").trim().toUpperCase();
    if (target.length > 0 && target !== source) {
      line = `${line} → ${target}`;
    }
  }
  if (prefill.missingFields.length > 0) {
    return `${line} — the form asks for: ${prefill.missingFields.join(", ")}`;
  }
  return line;
}

/**
 * The no-result intent-turn's target (contract 06 §5): the miss routes to
 * the W1 create-payment workflow PRE-FILLED with the query — carried as the
 * payment's DESCRIPTION seed (a free-text miss names what the payment is
 * FOR; it is never guessed into a counterparty — the form's own combobox
 * offers the add-contact disambiguation when a name is intended).
 */
export function createPaymentIntentTurnHref(turn: NoResultIntentTurn): string {
  const params = new URLSearchParams();
  const seed = turn.query.trim().slice(0, 200);
  if (seed.length > 0) {
    params.set("description", seed);
  }
  return withParams("/app/payments?start=1", params);
}

// ---------------------------------------------------------------------------
// The result model
// ---------------------------------------------------------------------------

/** One Commands-group hit (contract 06 §3.1/§4). */
export interface SearchCommandHit {
  readonly kind: "command";
  readonly id: string;
  readonly verb: CommandVerb;
  /** "Pay Alice 100 USDC" (parsed) or "Pay" (entry). */
  readonly label: string;
  readonly detail: string;
  readonly href: string;
  readonly prefillLine: string | null;
  /** Disambiguation chips (which Alice? which target asset?) — never dead-ends. */
  readonly chips: readonly DisambiguationChip[];
  /** Parsed modifiers (`key:value`), carried verbatim for display. */
  readonly modifiers: readonly CommandModifier[];
  readonly testId: string;
}

/** One Resources-group payments row (contract 06 §3.2). */
export interface SearchPaymentHit {
  readonly kind: "payment";
  readonly id: string;
  readonly row: SearchPaymentRow;
  readonly href: string;
  readonly testId: string;
}

/** One Resources-group honest-state row (a type that has no data plane yet). */
export interface SearchResourceStateHit {
  readonly kind: "resource-state";
  readonly id: string;
  readonly label: string;
  /** The honest state sentence (env-var names only, never values). */
  readonly stateLine: string;
  readonly href: string | null;
  readonly testId: string;
}

/** One Navigation-group hit (contract 06 §3.3). */
export interface SearchNavigationHit {
  readonly kind: "navigation";
  readonly id: string;
  readonly label: string;
  readonly group: string;
  readonly href: string;
  readonly testId: string;
}

/** One zero-state quick action / recent / no-result suggestion (contract 06 §5). */
export interface SearchQuickHit {
  readonly kind: "quick" | "recent" | "suggestion";
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
  readonly href: string;
  readonly testId: string;
}

export type SearchItem =
  | SearchCommandHit
  | SearchPaymentHit
  | SearchResourceStateHit
  | SearchNavigationHit
  | SearchQuickHit;

/** A result group (listbox group semantics; ↑↓ within, ⇥ across). */
export interface SearchGroup {
  readonly id: "commands" | "resources" | "navigation" | "recents" | "quick" | "no-result";
  readonly label: string;
  readonly items: readonly SearchItem[];
}

/** The full derived result model for the current query. */
export interface SearchResults {
  readonly groups: readonly SearchGroup[];
  /** The no-result intent-turn (null unless nothing matched). */
  readonly noResult: NoResultIntentTurn | null;
  /** Closest suggestions for a no-result query. */
  readonly suggestions: readonly SearchQuickHit[];
  /** True while the honest resources read is in flight for this query. */
  readonly resourcesPending: boolean;
}

export interface DeriveSearchResultsInput {
  readonly query: string;
  readonly role: ProductRole | null;
  /** The operator's contact directory (injected; empty is honest). */
  readonly directory: readonly ContactDirectoryEntry[];
  readonly choices?: CommandChoices;
  /** The honest resources read for this query (null = not loaded yet). */
  readonly resources: SearchResourcesResult | null;
  /** Local recents (contract 06 §5 — localStorage only, never server). */
  readonly recents: readonly SearchRecentEntry[];
}

/**
 * Derive the contract-06 §3 result model for the current query (pure,
 * total, deterministic):
 * - empty query → the ZERO-STATE (recents + quick actions);
 * - verb-leading query → the parsed command hit leads the Commands group
 *   (pre-filled, chips for ambiguity), the six entries still match below;
 * - payments rows render through the honest read; the other resource types
 *   render their honest not-configured states;
 * - navigation matches on title + synonyms;
 * - nothing anywhere → the no-result group: "No matches for '<q>'" + the
 *   closest suggestions + the "Create payment for '<q>'?" intent-turn (the
 *   miss becomes an intent — contract 06 §5).
 */
export function deriveSearchResults(input: DeriveSearchResultsInput): SearchResults {
  const query = input.query.trim();
  if (query.length === 0) {
    return deriveZeroState(input.recents);
  }

  const groups: SearchGroup[] = [];
  const commands = deriveCommandHits(query, input.directory, input.choices ?? {});
  if (commands.length > 0) {
    groups.push({ id: "commands", label: "Commands", items: commands });
  }
  const resources = deriveResourceItems(query, input.resources);
  if (resources.items.length > 0 || resources.pending) {
    groups.push({ id: "resources", label: "Resources", items: resources.items });
  }
  const navigation = deriveNavigationHits(query, input.role);
  if (navigation.length > 0) {
    groups.push({ id: "navigation", label: "Navigation", items: navigation });
  }

  if (groups.length === 0) {
    const parse = parseCommand(query);
    const suggestions =
      parse.kind === "COMMAND" ? [] : closestSuggestions(query, input.role);
    const turn = noResultIntentTurn(query);
    // The no-result group (contract 06 §5): the message is the group label,
    // the closest suggestions render first (Enter takes the top hit), and
    // the intent-turn closes the group as the emphasized final action.
    groups.push({
      id: "no-result",
      label: `No matches for '${query}'`,
      items: Object.freeze([
        ...suggestions,
        {
          kind: "quick" as const,
          id: "intent-turn",
          label: turn.label,
          detail:
            "The miss becomes an intent — the create-payment form opens pre-filled with this text as its description.",
          href: createPaymentIntentTurnHref(turn),
          testId: "search.opt.intent-turn",
        },
      ]),
    });
    return {
      groups: Object.freeze(groups),
      noResult: turn,
      suggestions,
      resourcesPending: input.resources === null,
    };
  }
  return {
    groups: Object.freeze(groups),
    noResult: null,
    suggestions: [],
    resourcesPending: input.resources === null,
  };
}

/** The zero-state (contract 06 §5): recents + "New payment" quick actions. */
function deriveZeroState(recents: readonly SearchRecentEntry[]): SearchResults {
  const groups: SearchGroup[] = [];
  const recentItems: SearchQuickHit[] = recents.slice(0, 5).map((entry) => ({
    kind: "recent" as const,
    id: `recent-${entry.id}`,
    label: entry.label,
    ...(entry.detail === undefined ? {} : { detail: entry.detail }),
    href: entry.href,
    testId: `search.opt.recent-${entry.id}`,
  }));
  if (recentItems.length > 0) {
    groups.push({ id: "recents", label: "Recents", items: Object.freeze(recentItems) });
  }
  groups.push({ id: "quick", label: "Quick actions", items: deriveQuickActions() });
  return { groups: Object.freeze(groups), noResult: null, suggestions: [], resourcesPending: false };
}

/** The "New payment" quick actions (real routes only). */
export function deriveQuickActions(): readonly SearchQuickHit[] {
  return Object.freeze([
    {
      kind: "quick",
      id: "quick-new-payment",
      label: "New payment",
      detail: "The create-payment workflow — compose, fund, confirm",
      href: "/app/payments?start=1",
      testId: "search.opt.quick-new-payment",
    },
    {
      kind: "quick",
      id: "quick-payment-link",
      label: "Payment link",
      detail: "A no-code collection link (the builder)",
      href: "/app/payments/link",
      testId: "search.opt.quick-payment-link",
    },
    {
      kind: "quick",
      id: "quick-convert",
      label: "Convert",
      detail: "Convert between currencies",
      href: "/app/convert",
      testId: "search.opt.quick-convert",
    },
  ]);
}

/**
 * The Commands-group hits for a query: the PARSED verb leads (pre-filled
 * through the grammar, chips for ambiguity), then every verb whose entry
 * matches the query text (title + synonyms). Pure — the grammar is consumed
 * from @payswap/ux, never re-defined.
 */
export function deriveCommandHits(
  query: string,
  directory: readonly ContactDirectoryEntry[],
  choices: CommandChoices,
): readonly SearchCommandHit[] {
  const hits: SearchCommandHit[] = [];
  const parse = parseCommand(query);

  if (parse.kind === "COMMAND") {
    const intent = parse.intent;
    const prefill = workflowFormPrefillFromIntent(intent);
    const entry =
      COMMAND_GRAMMAR_ENTRIES.find((candidate) => candidate.verb === intent.verb) ?? null;
    if (entry !== null) {
      const labelTokens = [entry.label];
      const counterparty = choices.counterpartyName ?? prefill.counterpartyText;
      if (counterparty !== undefined && counterparty.trim().length > 0) {
        labelTokens.push(displayToken(counterparty.trim()));
      }
      if (prefill.amountText !== undefined && prefill.amountText.length > 0) {
        labelTokens.push(prefill.amountText);
      }
      const asset = choices.asset ?? prefill.assetText;
      if (asset !== undefined && asset.trim().length > 0) {
        labelTokens.push(asset.trim().toUpperCase());
      }
      hits.push({
        kind: "command",
        id: entry.id,
        verb: entry.verb,
        label: labelTokens.join(" "),
        detail: entry.detail,
        href: commandPrefillHref(prefill, choices),
        prefillLine: prefillSummaryLine(prefill, choices),
        chips: disambiguationChips(prefill, directory, choices),
        modifiers: intent.modifiers,
        testId: `search.opt.${entry.id}`,
      });
    }
  }

  // The remaining verbs still match by title + synonyms (a non-verb query
  // sees only this arm — the unified surface's search lane), ranked by
  // match score with registry order breaking ties.
  const matched: Array<{ hit: SearchCommandHit; score: number; order: number }> = [];
  for (const entry of COMMAND_GRAMMAR_ENTRIES) {
    if (parse.kind === "COMMAND" && parse.intent.verb === entry.verb) {
      continue;
    }
    const score = matchScore(query, [entry.verb, entry.label, entry.detail, entry.keywords]);
    if (score > 0) {
      matched.push({
        order: matched.length,
        score,
        hit: {
          kind: "command",
          id: entry.id,
          verb: entry.verb,
          label: entry.label,
          detail: entry.detail,
          href: entry.href,
          prefillLine: null,
          chips: [],
          modifiers: [],
          testId: `search.opt.${entry.id}`,
        },
      });
    }
  }
  matched.sort((a, b) => b.score - a.score || a.order - b.order);
  hits.push(...matched.map((candidate) => candidate.hit));
  return Object.freeze(hits);
}

/**
 * The disambiguation chips for a parsed command (contract 06 §4 — never
 * dead-ends): counterparty candidates through the certified
 * `resolveCounterparty` (zero matches → the inline "Add contact" chip), and
 * — for a conversion with no target asset — the closed asset set the
 * workflow forms themselves offer.
 */
function disambiguationChips(
  prefill: WorkflowFormPrefill,
  directory: readonly ContactDirectoryEntry[],
  choices: CommandChoices,
): readonly DisambiguationChip[] {
  const chips: DisambiguationChip[] = [];
  if (
    choices.counterpartyName === undefined &&
    prefill.counterpartyText !== undefined &&
    prefill.counterpartyText.trim().length > 0
  ) {
    chips.push(...resolveCounterparty(prefill.counterpartyText.trim(), directory).chips);
  }
  if (choices.asset === undefined && prefill.verb === "convert") {
    // The TARGET is known only through a `to` modifier (or a picked chip —
    // excluded by the outer condition). assetText is the SOURCE asset: its
    // presence never implies a target ("convert 2 eth" still asks "to what?").
    const hasTarget = prefill.modifiers.some((modifier) => modifier.key === "to");
    if (!hasTarget) {
      chips.push(
        ...ASSET_CANDIDATES.map((asset) => ({
          kind: "asset-candidate" as const,
          label: asset,
          value: asset,
        })),
      );
    }
  }
  return Object.freeze(chips);
}

/** The Resources-group items for a query: payments rows + honest states. */
function deriveResourceItems(
  query: string,
  resources: SearchResourcesResult | null,
): { readonly items: readonly SearchItem[]; readonly pending: boolean } {
  const items: SearchItem[] = [];
  const needle = query.trim().toLowerCase();

  if (resources !== null && resources.status === "ok") {
    for (const row of resources.payments ?? []) {
      // Re-check the CURRENT query against the served rows (the read may
      // trail the typed text by a debounce tick — never show a stale match).
      const haystack = [
        row.id,
        row.counterparty,
        row.description ?? "",
        row.amount,
        row.methodLine ?? "",
      ]
        .join(" ")
        .toLowerCase();
      if (needle.length > 0 && !haystack.includes(needle)) {
        continue;
      }
      items.push({
        kind: "payment",
        id: `payment-${row.id}`,
        row,
        href: `/app/payments/${encodeURIComponent(row.id)}`,
        testId: `search.opt.payment-${row.id}`,
      });
    }
  }

  // The honest states: payments (when its read is not ok) + every other
  // spec'd type until its data plane ships — matched by type name, so a
  // query about something else never drags them in.
  const stateRows = resourceStateRows(resources);
  for (const state of stateRows) {
    if (matchScore(query, state.matchFields) > 0) {
      items.push(state.hit);
    }
  }
  return { items: Object.freeze(items), pending: resources === null };
}

interface ResourceStateRow {
  readonly matchFields: readonly string[];
  readonly hit: SearchResourceStateHit;
}

/** The honest state rows for the spec'd resource types (contract 07 ladder). */
function resourceStateRows(resources: SearchResourcesResult | null): readonly ResourceStateRow[] {
  const rows: ResourceStateRow[] = [];

  if (resources === null || resources.status === "ok") {
    // Payments either served rows or served an honest empty — no state row.
    if (resources !== null && resources.status === "ok" && (resources.payments ?? []).length === 0) {
      rows.push({
        matchFields: ["payments", "money in", "charges"],
        hit: {
          kind: "resource-state",
          id: "resource-payments-empty",
          label: "Payments",
          stateLine:
            "No payments match this query in your account — the collection itself states the honest totals.",
          href: "/app/payments",
          testId: "search.opt.resource-payments-empty",
        },
      });
    }
  } else if (resources.status === "unconfigured") {
    rows.push({
      matchFields: ["payments", "money in", "charges"],
      hit: {
        kind: "resource-state",
        id: "resource-payments-unconfigured",
        label: "Payments",
        stateLine:
          "Payments search: nothing is configured — the authoritative API runtime (" +
          SEARCH_API_ENV_VAR_NAME +
          ") or the clearly-marked test fixtures (" +
          SEARCH_FIXTURES_ENV_VAR_NAME +
          ") teach the fill path. Env-var names only; no records are fabricated.",
        href: "/app/payments",
        testId: "search.opt.resource-payments-unconfigured",
      },
    });
  } else if (resources.status === "preview-no-session") {
    rows.push({
      matchFields: ["payments", "money in", "charges"],
      hit: {
        kind: "resource-state",
        id: "resource-payments-preview",
        label: "Payments",
        stateLine:
          "Payments search: the marked preview carries no session — no records are read, and nothing renders as if it were yours. Sign in to search your payments.",
        href: null,
        testId: "search.opt.resource-payments-preview",
      },
    });
  } else {
    rows.push({
      matchFields: ["payments", "money in", "charges"],
      hit: {
        kind: "resource-state",
        id: "resource-payments-error",
        label: "Payments",
        stateLine: `Payments search did not complete — ${resources.message ?? "the transport answered without detail"}. The verbatim answer is the truth that rendered here; nothing is fabricated in its place.`,
        href: "/app/payments",
        testId: "search.opt.resource-payments-error",
      },
    });
  }

  rows.push(
    {
      matchFields: ["customers", "contacts", "guests", "directory", "payers"],
      hit: {
        kind: "resource-state",
        id: "resource-customers",
        label: "Customers / Contacts",
        stateLine:
          "Customers search: not configured yet — customer records arrive with the customers plane; the Customers hub states its own honest status. No results are fabricated.",
        href: "/app/customers",
        testId: "search.opt.resource-customers",
      },
    },
    {
      matchFields: ["settlements", "settle", "payouts", "rails"],
      hit: {
        kind: "resource-state",
        id: "resource-settlements",
        label: "Settlements",
        stateLine:
          "Settlements search: not configured yet — settlements are observed per rail on Balances (its Settlements tab states the honest status). No results are fabricated.",
        href: "/app/balances",
        testId: "search.opt.resource-settlements",
      },
    },
    {
      matchFields: ["refunds", "returns", "reversals"],
      hit: {
        kind: "resource-state",
        id: "resource-refunds",
        label: "Refunds",
        stateLine:
          "Refunds search: not configured yet — refunds render inside each payment's detail with their registry reasons. No results are fabricated.",
        href: "/app/payments",
        testId: "search.opt.resource-refunds",
      },
    },
    {
      matchFields: ["products", "links", "prices", "catalog", "coupons"],
      hit: {
        kind: "resource-state",
        id: "resource-products-links",
        label: "Products / Links",
        stateLine:
          "Products & links search: not configured yet — products, prices and links live in the Catalog (its Links tab states the honest status). No results are fabricated.",
        href: "/app/catalog",
        testId: "search.opt.resource-products-links",
      },
    },
  );
  return rows;
}

/** The Navigation-group hits: title + synonyms, role-visible pages only. */
function deriveNavigationHits(query: string, role: ProductRole | null): readonly SearchNavigationHit[] {
  const entries = deriveSearchNavigation(role);
  const scored = entries
    .map((entry, index) => ({
      entry,
      index,
      score: matchScore(query, [entry.label, ...entry.synonyms]),
    }))
    .filter((candidate) => candidate.score > 0);
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return Object.freeze(
    scored.map(({ entry }) => ({
      kind: "navigation" as const,
      id: entry.id,
      label: entry.label,
      group: entry.group,
      href: entry.href,
      testId: `search.opt.${entry.id}`,
    })),
  );
}

/**
 * The closest suggestions for a no-result query: commands + navigation
 * ranked by deterministic character-bigram similarity (a graded near-miss
 * metric — exact/substring matching already failed, else this would not be
 * a no-result query). Pure; ties break on registry order.
 */
function closestSuggestions(query: string, role: ProductRole | null): readonly SearchQuickHit[] {
  const candidates: Array<{ label: string; href: string; score: number; order: number }> = [];
  for (const entry of COMMAND_GRAMMAR_ENTRIES) {
    candidates.push({
      label: entry.label,
      href: entry.href,
      score: bigramSimilarity(query, `${entry.verb} ${entry.label} ${entry.keywords}`),
      order: candidates.length,
    });
  }
  deriveSearchNavigation(role).forEach((entry) => {
    candidates.push({
      label: entry.label,
      href: entry.href,
      score: bigramSimilarity(query, `${entry.label} ${entry.synonyms.join(" ")}`),
      order: candidates.length,
    });
  });
  return Object.freeze(
    candidates
      .filter((candidate) => candidate.score > 0.15)
      .sort((a, b) => b.score - a.score || a.order - b.order)
      .slice(0, 3)
      .map((candidate, index) => ({
        kind: "suggestion" as const,
        id: `suggestion-${index}`,
        label: candidate.label,
        href: candidate.href,
        testId: `search.opt.suggestion-${index}`,
      })),
  );
}

/** Sørensen–Dice coefficient of character bigrams (0–1, deterministic). */
function bigramSimilarity(a: string, b: string): number {
  const bigrams = (value: string): Map<string, number> => {
    const normalized = value.toLowerCase().replace(/[^a-z0-9]/g, "");
    const map = new Map<string, number>();
    for (let index = 0; index + 1 < normalized.length; index += 1) {
      const gram = normalized.slice(index, index + 2);
      map.set(gram, (map.get(gram) ?? 0) + 1);
    }
    return map;
  };
  const left = bigrams(a);
  const right = bigrams(b);
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let shared = 0;
  let leftTotal = 0;
  for (const count of left.values()) {
    leftTotal += count;
  }
  for (const [gram, count] of left) {
    shared += Math.min(count, right.get(gram) ?? 0);
  }
  let rightTotal = 0;
  for (const count of right.values()) {
    rightTotal += count;
  }
  return (2 * shared) / (leftTotal + rightTotal);
}

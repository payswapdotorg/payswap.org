import { describe, expect, it } from "vitest";

/**
 * UX-005 — the search/command derivation battery (contract 06 §3–§5).
 *
 * Pure-engine tests: every contract behavior is derived here, with NO DOM,
 * NO network and NO clock — the component test (universal-search.test.tsx)
 * covers the DOM/keyboard half. The honesty laws are pinned where they
 * bite: non-ok resources reads keep their OWN status (never "no results"),
 * amounts are exact minor units (never floats), and a miss becomes the
 * create-payment intent (never a dead end).
 */

import type { ContactDirectoryEntry, NoResultIntentTurn, WorkflowFormPrefill } from "@payswap/ux";
import { workflowFormPrefillFromText } from "@payswap/ux";

import { PAY_TEST_SUCCEEDED_CROSS_RAIL } from "../src/app/app/payments/_server/test-fixtures";
import { COMMAND_GRAMMAR_ENTRIES } from "../src/lib/cc/palette";
import {
  commandPrefillHref,
  deriveCommandHits,
  deriveQuickActions,
  deriveSearchResults,
  foldPaymentsReadForSearch,
  maskIdentifier,
  type SearchCommandHit,
} from "../src/components/search/search-derivation";
import { createPaymentIntentTurnHref } from "../src/components/search/search-derivation";
import type { SearchRecentEntry } from "../src/components/search/search-types";

const DIRECTORY: readonly ContactDirectoryEntry[] = [
  { id: "cus_test_amara", displayName: "Amara Okafor" },
  { id: "cus_test_alice", displayName: "Alice Devlin" },
];

// ---------------------------------------------------------------------------
// Identifier masking (contract 06 §3: list cells carry masked IDs)
// ---------------------------------------------------------------------------

describe("maskIdentifier", () => {
  it("short ids render verbatim", () => {
    expect(maskIdentifier("pay_1234567890")).toBe("pay_1234567890");
  });

  it("long ids keep a 10-char head + 4-char tail; the full id stays the href", () => {
    expect(maskIdentifier("pay_test_usdc_base_to_eur")).toBe("pay_test_u…_eur");
  });
});

// ---------------------------------------------------------------------------
// The honest payments fold (Resources group data source)
// ---------------------------------------------------------------------------

describe("foldPaymentsReadForSearch", () => {
  it("ok folds query-matching rows with masked IDs, exact amounts, chips-ready state", () => {
    const result = foldPaymentsReadForSearch(
      { status: "ok", source: "test-fixtures", data: [PAY_TEST_SUCCEEDED_CROSS_RAIL] },
      "amara",
    );
    expect(result.status).toBe("ok");
    expect(result.source).toBe("test-fixtures");
    expect(result.payments).toHaveLength(1);
    const row = result.payments![0]!;
    expect(row.id).toBe("pay_test_usdc_base_to_eur");
    expect(row.maskedId).toBe("pay_test_u…_eur");
    expect(row.amount).toBe("25 USDC");
    expect(row.state).toBe("succeeded");
    expect(row.counterparty).toBe("Amara Okafor");
    expect(row.methodLine).toBe("Wallet 0x12…ab90");
  });

  it("a non-matching query folds to zero rows — the read stays ok (honest empty)", () => {
    const result = foldPaymentsReadForSearch(
      { status: "ok", source: "test-fixtures", data: [PAY_TEST_SUCCEEDED_CROSS_RAIL] },
      "zzzz-no-such-thing",
    );
    expect(result.status).toBe("ok");
    expect(result.payments).toEqual([]);
  });

  it("every non-ok outcome keeps its OWN status — never folded into 'no results'", () => {
    expect(foldPaymentsReadForSearch({ status: "unconfigured" }, "amara")).toEqual({
      status: "unconfigured",
    });
    expect(foldPaymentsReadForSearch({ status: "preview-no-session" }, "amara")).toEqual({
      status: "preview-no-session",
    });
    expect(
      foldPaymentsReadForSearch(
        { status: "http-error", statusCode: 503, message: "verbatim" },
        "amara",
      ),
    ).toEqual({ status: "http-error", message: "verbatim" });
    expect(
      foldPaymentsReadForSearch({ status: "network-error", message: "offline" }, "amara"),
    ).toEqual({ status: "network-error", message: "offline" });
  });
});

// ---------------------------------------------------------------------------
// The pre-fill href seam — the 15-phrase battery (contract 06 §6 acceptance)
// ---------------------------------------------------------------------------

describe("commandPrefillHref — the 15 representative phrasings route to pre-filled workflows", () => {
  const cases: ReadonlyArray<{ readonly text: string; readonly href: string }> = [
    { text: "pay alice 100 usdc", href: "/app/payments?start=1&to=alice&amount=100000000&asset=USDC" },
    { text: "pay 25 usdc", href: "/app/payments?start=1&amount=25000000&asset=USDC" },
    { text: "pay", href: "/app/payments?start=1" },
    { text: "request bob 50 eur", href: "/app/payments?start=1&to=bob&amount=5000&asset=EUR" },
    { text: "request 500", href: "/app/payments?start=1&amount=50000&asset=USD" },
    { text: "invoice acme 1200 usd", href: "/app/billing" },
    { text: "invoice", href: "/app/billing" },
    { text: "link 30 usd", href: "/app/payments/link?amount=3000&currency=USD" },
    { text: "link", href: "/app/payments/link" },
    { text: "convert 2 eth to usdc", href: "/app/convert?from=ETH&to=USDC&amount=2000000000000000000" },
    { text: "convert 500 usd to eur", href: "/app/convert?from=USD&to=EUR&amount=50000" },
    { text: "withdraw 300 usdc", href: "/app/balances" },
    { text: "withdraw", href: "/app/balances" },
    { text: "request carol", href: "/app/payments?start=1&to=carol" },
    { text: "pay dave 75 gbp rail:ethereum", href: "/app/payments?start=1&to=dave&amount=7500&asset=GBP" },
  ];

  it("the battery has exactly 15 phrasings (the contract's own number)", () => {
    expect(cases).toHaveLength(15);
  });

  it("every phrasing routes to its verb's REAL workflow with exact-minor-unit pre-fill", () => {
    for (const { text, href } of cases) {
      const prefill = prefillFor(text);
      expect(commandPrefillHref(prefill)).toBe(href);
    }
  });
});

describe("commandPrefillHref — money law", () => {
  it("an unparseable amount omits the param — never a wrong number ships", () => {
    // A 3-decimal USD amount (exponent 2 — the extra digit rejects).
    const href = commandPrefillHref(prefillFor("pay alice 25.123 usd"));
    expect(href).toBe("/app/payments?start=1&to=alice&asset=USD");
    expect(href).not.toContain("amount=");
  });

  it("the fiat default basis is USD when no asset parsed (stated alongside the amount)", () => {
    expect(commandPrefillHref(prefillFor("pay 100"))).toBe(
      "/app/payments?start=1&amount=10000&asset=USD",
    );
  });
});

/** Every verb-leading phrasing parses (the grammar's law); search-lane text does not. */
function prefillFor(text: string): WorkflowFormPrefill {
  const prefill = workflowFormPrefillFromText(text);
  if (prefill === undefined) {
    throw new Error(`expected a command prefill for: ${text}`);
  }
  return prefill;
}

// ---------------------------------------------------------------------------
// Disambiguation (contract 06 §4 — never a dead end, never a guess)
// ---------------------------------------------------------------------------

describe("deriveCommandHits — ambiguity resolves through chips", () => {
  it("a counterparty token matching directory entries yields one candidate chip per match", () => {
    const hits = deriveCommandHits("pay alice 100 usdc", DIRECTORY, {});
    const parsed = hits[0]!;
    expect(parsed.kind).toBe("command");
    const chips = parsed.chips.filter((chip) => chip.kind === "counterparty-candidate");
    expect(chips).toHaveLength(1);
    expect(chips[0]!.label).toBe("Alice Devlin");
  });

  it("zero matches yield the inline 'Add contact' chip — never a dead end", () => {
    const hits = deriveCommandHits("pay zephyr 100 usdc", DIRECTORY, {});
    const chips = hits[0]!.chips;
    expect(chips).toContainEqual({
      kind: "add-contact",
      label: "Add contact 'zephyr'",
      value: "zephyr",
    });
  });

  it("a conversion with no target asset yields the closed asset-candidate set", () => {
    const hits = deriveCommandHits("convert 2 eth", [], {});
    const chips = hits[0]!.chips.filter((chip) => chip.kind === "asset-candidate");
    expect(chips.map((chip) => chip.value)).toEqual(["USDC", "EUR", "USD", "GHS"]);
  });

  it("a picked choice wins over the typed text (chips are a choice, not a guess)", () => {
    const hits = deriveCommandHits("pay alice 100 usdc", DIRECTORY, { counterpartyName: "Alice Devlin" });
    // URLSearchParams encodes a space as '+' — the standard form-component encoding.
    expect(hits[0]!.href).toContain("to=Alice+Devlin");
    expect(hits[0]!.chips).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The grouped result model (contract 06 §3)
// ---------------------------------------------------------------------------

describe("deriveSearchResults — the grouped, ranked result model", () => {
  it("an empty query derives the ZERO-STATE: recents + quick actions", () => {
    const recents: readonly SearchRecentEntry[] = [
      { id: "recent-x", label: "Payments page", href: "/app/payments", at: 1 },
    ];
    const results = deriveSearchResults({
      query: "",
      role: "merchant",
      directory: [],
      resources: null,
      recents,
    });
    expect(results.groups.map((group) => group.id)).toEqual(["recents", "quick"]);
    expect(results.groups[0]!.items[0]!.kind).toBe("recent");
    expect(results.noResult).toBeNull();
  });

  it("the quick actions are the real routes (New payment / Payment link / Convert)", () => {
    const actions = deriveQuickActions();
    expect(actions.map((action) => action.href)).toEqual([
      "/app/payments?start=1",
      "/app/payments/link",
      "/app/convert",
    ]);
  });

  it("a verb-leading query puts the parsed command FIRST in the Commands group", () => {
    const results = deriveSearchResults({
      query: "pay alice 100 usdc",
      role: "merchant",
      directory: [],
      resources: null,
      recents: [],
    });
    const commands = results.groups.find((group) => group.id === "commands");
    expect(commands).toBeDefined();
    expect(commands!.items[0]!.kind).toBe("command");
    const parsed = commands!.items[0] as SearchCommandHit;
    expect(parsed.verb).toBe("pay");
    expect(parsed.label).toBe("Pay Alice 100 USDC");
    expect(parsed.prefillLine).toBe("Pre-fill: Alice · 100 · USDC");
  });

  it("a non-verb query still matches commands by title + synonyms (the search lane)", () => {
    const results = deriveSearchResults({
      query: "invoice",
      role: "merchant",
      directory: [],
      resources: null,
      recents: [],
    });
    const commands = results.groups.find((group) => group.id === "commands");
    expect(commands!.items.length).toBeGreaterThanOrEqual(1);
    expect(commands!.items[0]!.kind).toBe("command");
  });

  it("ok resources render payments rows in the Resources group", () => {
    const results = deriveSearchResults({
      query: "amara",
      role: "merchant",
      directory: [],
      resources: {
        status: "ok",
        source: "test-fixtures",
        payments: [
          {
            id: "pay_test_usdc_base_to_eur",
            maskedId: "pay_test_u…_eur",
            state: "succeeded",
            amount: "25 USDC",
            counterparty: "Amara Okafor",
            createdAt: "2026-10-06 09:12 UTC",
          },
        ],
      },
      recents: [],
    });
    const resources = results.groups.find((group) => group.id === "resources");
    expect(resources).toBeDefined();
    const row = resources!.items[0]!;
    expect(row.kind).toBe("payment");
    expect((row as { href: string }).href).toBe("/app/payments/pay_test_usdc_base_to_eur");
  });

  it("an unconfigured read renders the honest state row — never fake results, never 'no results'", () => {
    const results = deriveSearchResults({
      query: "payments",
      role: "merchant",
      directory: [],
      resources: { status: "unconfigured" },
      recents: [],
    });
    const resources = results.groups.find((group) => group.id === "resources");
    expect(resources).toBeDefined();
    const stateRow = resources!.items.find((item) => item.kind === "resource-state");
    expect(stateRow).toBeDefined();
  });

  it("nothing anywhere → the no-result group with the intent-turn LAST", () => {
    // A RESOLVED empty read (not null — null means "read in flight", which
    // honestly keeps the pending Resources group alive; the pending group is
    // not a match). An ok-empty read with nothing else matching = no-result.
    const results = deriveSearchResults({
      query: "zzqq-nothing-matches",
      role: "merchant",
      directory: [],
      resources: { status: "ok", source: "test-fixtures", payments: [] },
      recents: [],
    });
    expect(results.groups).toHaveLength(1);
    const group = results.groups[0]!;
    expect(group.id).toBe("no-result");
    expect(group.label).toBe("No matches for 'zzqq-nothing-matches'");
    const last = group.items[group.items.length - 1]!;
    expect(last.kind).toBe("quick");
    expect((last as { id: string }).id).toBe("intent-turn");
    expect(results.noResult).not.toBeNull();
  });

  it("navigation matches on title + synonyms", () => {
    const results = deriveSearchResults({
      query: "balances",
      role: "merchant",
      directory: [],
      resources: null,
      recents: [],
    });
    const navigation = results.groups.find((group) => group.id === "navigation");
    expect(navigation).toBeDefined();
    expect(navigation!.items.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// The no-result intent turn (contract 06 §5 — the miss becomes an intent)
// ---------------------------------------------------------------------------

describe("createPaymentIntentTurnHref", () => {
  it("carries the miss as the payment DESCRIPTION seed on the W1 route", () => {
    const turn = noResultTurnFor("coffee with ama");
    // URLSearchParams encodes a space as '+' — the standard form encoding.
    expect(createPaymentIntentTurnHref(turn)).toBe(
      "/app/payments?start=1&description=coffee+with+ama",
    );
  });
});

function noResultTurnFor(query: string): NoResultIntentTurn {
  const results = deriveSearchResults({
    query,
    role: "merchant",
    directory: [],
    resources: { status: "ok", source: "test-fixtures", payments: [] },
    recents: [],
  });
  if (results.noResult === null) {
    throw new Error("expected a no-result turn");
  }
  return results.noResult;
}

// ---------------------------------------------------------------------------
// The grammar entries registry (consumed by the palette's Commands group)
// ---------------------------------------------------------------------------

describe("COMMAND_GRAMMAR_ENTRIES", () => {
  it("binds exactly the six verbs to real routes", () => {
    expect(COMMAND_GRAMMAR_ENTRIES.map((entry) => entry.verb)).toEqual([
      "pay",
      "request",
      "invoice",
      "link",
      "convert",
      "withdraw",
    ]);
    for (const entry of COMMAND_GRAMMAR_ENTRIES) {
      expect(entry.href.startsWith("/app/")).toBe(true);
    }
  });
});

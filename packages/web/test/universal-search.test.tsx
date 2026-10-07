// @vitest-environment jsdom
/**
 * UX-005 — the universal search/command surface, component half (contract 06).
 *
 * The DOM/keyboard battery: "/" focuses the field from anywhere (suppressed
 * while an editable target has focus), Esc restores the prior focus, the
 * grouped results render with listbox semantics, the keyboard model moves
 * ↑/↓ within a group and ⇥ across groups (through the disambiguation chips
 * first), ⏎ executes the active hit (recording the recent LOCALLY), and
 * every result derives from the injected honest read — never a fabricated
 * row.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const routerPush = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: routerPush,
    refresh: () => undefined,
    back: () => undefined,
    forward: () => undefined,
    prefetch: () => undefined,
  }),
  usePathname: () => "/app",
  useSearchParams: () => new URLSearchParams(),
}));

import { UniversalSearch } from "../src/components/search/universal-search";
import type { SearchResourcesResult } from "../src/components/search/search-types";

afterEach(() => {
  cleanup();
  routerPush.mockClear();
});

type SearchProps = Parameters<typeof UniversalSearch>[0];

/** An in-memory Storage double (recents persist LOCALLY, never the server). */
function memoryStore(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => Array.from(data.keys())[index] ?? null,
    removeItem: (key: string) => void data.delete(key),
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

function renderSearch(overrides: Partial<SearchProps> = {}): void {
  const props: SearchProps = {
    role: "merchant",
    directory: [],
    queryResources: async () => ({ status: "unconfigured" }) as SearchResourcesResult,
    recentsStore: memoryStore(),
    ...overrides,
  };
  render(<UniversalSearch {...props} />);
}

const INPUT = () => screen.getByTestId("search-input");

describe('"/" focuses the search field from anywhere (contract 06 §2)', () => {
  it("a bare '/' keydown focuses the field and opens the zero-state", () => {
    renderSearch();
    expect(screen.queryByTestId("search-menu")).toBeNull();
    // Dispatched on the body (bubbling to the window listener) so the event
    // is act-wrapped and its target is a real non-editable element — exactly
    // what a browser delivers for a '/' pressed outside any input.
    fireEvent.keyDown(document.body, { key: "/" });
    expect(document.activeElement).toBe(INPUT());
    expect(screen.getByTestId("search-menu")).toBeDefined();
  });

  it("'/' is suppressed while an editable target is focused (the chord discipline)", () => {
    renderSearch();
    const outside = document.createElement("input");
    outside.type = "text";
    document.body.appendChild(outside);
    outside.focus();
    fireEvent.keyDown(outside, { key: "/" });
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it("Esc closes and restores the prior focus (never a dead key)", () => {
    renderSearch();
    const outside = document.createElement("button");
    outside.type = "button";
    outside.textContent = "Prior stop";
    document.body.appendChild(outside);
    outside.focus();
    fireEvent.keyDown(document.body, { key: "/" });
    expect(document.activeElement).toBe(INPUT());
    fireEvent.keyDown(INPUT(), { key: "Escape" });
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });
});

describe("the zero-state (contract 06 §5): recents + 'New payment' quick actions", () => {
  it("focus with no query shows the quick actions on their real routes", () => {
    renderSearch();
    fireEvent.focus(INPUT());
    expect(screen.getByText("New payment")).toBeDefined();
    expect(screen.getByText("Payment link")).toBeDefined();
    expect(screen.getByText("Convert")).toBeDefined();
  });

  it("stored recents render from the LOCAL store (never the server)", () => {
    renderSearch({
      recentsStore: memoryStore({
        "ps-search-recents": JSON.stringify([
          { id: "recent-pay", label: "Pay Alice 100 USDC", href: "/app/payments?start=1", at: 1 },
        ]),
      }),
    });
    fireEvent.focus(INPUT());
    expect(screen.getByText("Pay Alice 100 USDC")).toBeDefined();
  });
});

describe("a typed command parses, pre-fills and executes (contract 06 §4)", () => {
  it("'pay alice 100 usdc' leads the Commands group with the pre-fill line and chips", async () => {
    renderSearch();
    fireEvent.focus(INPUT());
    fireEvent.change(INPUT(), { target: { value: "pay alice 100 usdc" } });
    await waitFor(() => {
      expect(screen.getByText("Pay Alice 100 USDC")).toBeDefined();
    });
    expect(screen.getByText(/Pre-fill: Alice · 100 · USDC/)).toBeDefined();
    // Zero directory matches → the inline Add-contact chip (never a dead end).
    expect(screen.getByText("Add contact 'alice'")).toBeDefined();
  });

  it("Enter executes the parsed command: routes pre-filled and records the recent locally", async () => {
    const store = memoryStore();
    renderSearch({ recentsStore: store });
    fireEvent.focus(INPUT());
    fireEvent.change(INPUT(), { target: { value: "pay alice 100 usdc" } });
    await waitFor(() => {
      expect(screen.getByText("Pay Alice 100 USDC")).toBeDefined();
    });
    fireEvent.keyDown(INPUT(), { key: "Enter" });
    expect(routerPush).toHaveBeenCalledWith(
      "/app/payments?start=1&to=alice&amount=100000000&asset=USDC",
    );
    await waitFor(() => {
      expect(store.getItem("ps-search-recents")).toContain("Pay Alice 100 USDC");
    });
  });

  it("a picked disambiguation chip wins over the typed token (a choice, not a guess)", async () => {
    renderSearch({
      directory: [{ id: "cus_test_alice", displayName: "Alice Devlin" }],
    });
    fireEvent.focus(INPUT());
    fireEvent.change(INPUT(), { target: { value: "pay alice 100 usdc" } });
    await waitFor(() => {
      expect(screen.getByText("Alice Devlin")).toBeDefined();
    });
    fireEvent.click(screen.getByText("Alice Devlin"));
    fireEvent.keyDown(INPUT(), { key: "Enter" });
    // URLSearchParams encodes a space as '+' — the standard form encoding.
    expect(routerPush).toHaveBeenCalledWith(
      expect.stringContaining("to=Alice+Devlin"),
    );
  });
});

describe("the honest resources read drives the Resources group (never fabricated)", () => {
  it("an ok read renders payment rows as list cells with StatusChip state", async () => {
    renderSearch({
      queryResources: async () =>
        ({
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
        }) as SearchResourcesResult,
    });
    fireEvent.focus(INPUT());
    fireEvent.change(INPUT(), { target: { value: "amara" } });
    await waitFor(() => {
      expect(screen.getByText(/25 USDC — Amara Okafor/)).toBeDefined();
    });
  });

  it("an unconfigured read renders the honest state row — not 'no results'", async () => {
    renderSearch();
    fireEvent.focus(INPUT());
    // 'settlem' matches the settlements state row (title + synonyms) without
    // colliding with the command entries or the placeholder text.
    fireEvent.change(INPUT(), { target: { value: "settlements" } });
    await waitFor(() => {
      expect(screen.getByTestId("search.opt.resource-settlements")).toBeDefined();
    });
  });
});

describe("the no-result state (contract 06 §5): the miss becomes an intent", () => {
  it("nothing matching renders 'No matches' + the create-payment intent-turn", async () => {
    // A resolved ok-empty read (the default unconfigured read would keep the
    // honest state rows alive, which are matches — not a no-result state).
    const okEmpty = async () =>
      ({ status: "ok", source: "test-fixtures", payments: [] }) as SearchResourcesResult;
    renderSearch({ queryResources: okEmpty });
    fireEvent.focus(INPUT());
    fireEvent.change(INPUT(), { target: { value: "zzqq-nothing-here" } });
    await waitFor(() => {
      // The label renders in the group header AND the derived screen-reader
      // announcement (contract 06 §5: results are announced) — both count.
      expect(screen.getAllByText(/No matches for 'zzqq-nothing-here'/).length).toBeGreaterThanOrEqual(1);
    });
    const turn = screen.getByText("Create payment for 'zzqq-nothing-here'?");
    expect(turn).toBeDefined();
  });

  it("Enter on the intent-turn routes to W1 with the description seed", async () => {
    const okEmpty = async () =>
      ({ status: "ok", source: "test-fixtures", payments: [] }) as SearchResourcesResult;
    renderSearch({ queryResources: okEmpty });
    fireEvent.focus(INPUT());
    fireEvent.change(INPUT(), { target: { value: "zzqq-nothing-here" } });
    await waitFor(() => {
      expect(screen.getByText("Create payment for 'zzqq-nothing-here'?")).toBeDefined();
    });
    // The intent-turn closes the no-result group (the LAST item).
    fireEvent.keyDown(INPUT(), { key: "End" });
    fireEvent.keyDown(INPUT(), { key: "Enter" });
    expect(routerPush).toHaveBeenCalledWith(
      "/app/payments?start=1&description=zzqq-nothing-here",
    );
  });
});

describe("keyboard-only end-to-end (contract 06 §6): arrows, Tab, Enter, Home/End", () => {
  it("↑/↓ move within a group; ⇥ moves across groups; ⏎ executes", async () => {
    renderSearch();
    fireEvent.focus(INPUT());
    fireEvent.change(INPUT(), { target: { value: "pay" } });
    await waitFor(() => {
      expect(screen.getByTestId("search-menu")).toBeDefined();
    });
    const input = INPUT();
    expect(input.getAttribute("aria-activedescendant")).toBeTruthy();
    const firstId = input.getAttribute("aria-activedescendant");

    // ↓ moves within the Commands group; the active descendant changes.
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).not.toBe(firstId);

    // ⇥ crosses into the next group (the resources/navigation lane).
    fireEvent.keyDown(input, { key: "Tab" });
    const afterTab = input.getAttribute("aria-activedescendant");
    expect(afterTab).toBeTruthy();

    // Home returns to the very first option; ⏎ executes it.
    fireEvent.keyDown(input, { key: "Home" });
    expect(input.getAttribute("aria-activedescendant")).toBe(firstId);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(routerPush).toHaveBeenCalledWith("/app/payments?start=1");
  });

  it("combobox + listbox semantics hold (aria-expanded, aria-activedescendant, role)", async () => {
    renderSearch();
    const input = INPUT();
    expect(input.getAttribute("role")).toBe("combobox");
    expect(input.getAttribute("aria-expanded")).toBe("false");
    fireEvent.focus(input);
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(input.getAttribute("aria-controls")).toBeTruthy();
    const listbox = screen.getByTestId("search-menu");
    expect(listbox.getAttribute("role")).toBe("listbox");
  });
});

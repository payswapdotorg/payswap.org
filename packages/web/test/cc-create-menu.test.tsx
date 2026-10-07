// @vitest-environment jsdom
/**
 * UX-003 — the global Create split-button (contract 01 §6 / 03 §2.9).
 *
 * The shell mounts @payswap/design's CreateMenu with the five canonical
 * creations, each carrying its VISIBLE, globally-active keyboard chord
 * (`c p` / `c r` / `c i` / `c l` / `c v`), routing to the work-order
 * targets. These tests pin the WIRING (the web-side route binding, not the
 * design package's own menu semantics):
 *  - `createMenuTargets` is total: every CREATE_MENU_ITEMS entry binds to
 *    its mandated /app route, and unknown ids fail closed;
 *  - the rendered menu shows the five labels + visible chords;
 *  - chords fire GLOBALLY (no menu open, no pointer) and route to the real
 *    targets;
 *  - chords never fire while a text input is focused (typing "cp" in a
 *    description field must stay typing);
 *  - Escape resets an armed chord.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { CreateMenu, type CreateMenuItem as DesignCreateMenuItem } from "@payswap/design";
import { CREATE_MENU_ITEMS } from "@payswap/ux";

import { appRouteForCreateMenuItem, createMenuTargets } from "../src/lib/cc/routes";

const pushes = vi.hoisted(() => ({ routes: [] as string[] }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: (href: string) => {
      pushes.routes.push(href);
    },
    refresh: () => undefined,
    back: () => undefined,
    forward: () => undefined,
    prefetch: () => undefined,
  }),
  usePathname: () => "/app",
  useSearchParams: () => new URLSearchParams(),
}));

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  pushes.routes.length = 0;
});

/** The shell's exact wiring: createMenuTargets → CreateMenu items. */
function shellCreateItems(): readonly DesignCreateMenuItem[] {
  return createMenuTargets().map(([item, route]) => ({
    id: item.id,
    label: item.label,
    chord: item.chord,
    onSelect: () => {
      pushes.routes.push(route);
    },
  }));
}

function pressKey(key: string, target?: Element | null): void {
  fireEvent.keyDown(target ?? window, { key });
}

describe("create menu: the route binding is total and fail-closed", () => {
  it("binds every CREATE_MENU_ITEMS entry to its work-order-mandated route", () => {
    expect(createMenuTargets()).toEqual([
      [CREATE_MENU_ITEMS[0], "/app/payments"], // Pay
      [CREATE_MENU_ITEMS[1], "/app/payments?start=1"], // Request
      [CREATE_MENU_ITEMS[2], "/app/billing"], // Invoice
      [CREATE_MENU_ITEMS[3], "/app/catalog?new=link"], // Payment link
      [CREATE_MENU_ITEMS[4], "/app/convert"], // Convert
    ]);
  });

  it("covers the five canonical verbs with their chords", () => {
    expect(CREATE_MENU_ITEMS.map((item) => `${item.label}:${item.chord}`)).toEqual([
      "Pay:c p",
      "Request:c r",
      "Invoice:c i",
      "Payment link:c l",
      "Convert:c v",
    ]);
  });

  it("fails closed on unknown create-menu ids", () => {
    expect(() => appRouteForCreateMenuItem("not-a-verb" as never)).toThrow();
  });
});

describe("create menu: the five creations render with visible chords", () => {
  it("opens on the toggle and shows each label with its chord", () => {
    render(<CreateMenu items={[...shellCreateItems()]} />);
    fireEvent.click(
      screen.getByRole("button", { name: /more create actions/i }),
    );
    const menu = screen.getByRole("menu", { name: "Create" });
    for (const [label, chord] of [
      ["Pay", "c p"],
      ["Request", "c r"],
      ["Invoice", "c i"],
      ["Payment link", "c l"],
      ["Convert", "c v"],
    ] as const) {
      const item = screen.getByRole("menuitem", { name: label });
      expect(menu.contains(item)).toBe(true);
      // The chord renders as visible <kbd>c</kbd><kbd>p</kbd> nodes.
      const kbdText = Array.from(item.querySelectorAll("kbd")).map((kbd) => kbd.textContent);
      expect(kbdText.join("")).toBe(chord.replace(" ", ""));
    }
    // The primary split action shows its chord too (Pay + c p).
    expect(
      screen.getByRole("button", { name: /^pay/i }).textContent,
    ).toContain("c");
  });
});

describe("create menu: chords are active globally and route for real", () => {
  it("fires c p → /app/payments with the menu closed (no pointer, no open menu)", () => {
    render(<CreateMenu items={[...shellCreateItems()]} />);
    expect(screen.queryByRole("menu")).toBeNull();
    pressKey("c");
    pressKey("p");
    expect(pushes.routes).toEqual(["/app/payments"]);
  });

  it.each([
    ["c r", "/app/payments?start=1"],
    ["c i", "/app/billing"],
    ["c l", "/app/catalog?new=link"],
    ["c v", "/app/convert"],
  ])("fires %s → %s", (chord, expected) => {
    render(<CreateMenu items={[...shellCreateItems()]} />);
    const [first, second] = chord.split(" ") as [string, string];
    pressKey(first);
    pressKey(second);
    expect(pushes.routes).toEqual([expected]);
  });

  it("never fires while a text input is focused (typing stays typing)", () => {
    render(
      <>
        <CreateMenu items={[...shellCreateItems()]} />
        <input type="text" aria-label="Payment description" />
      </>,
    );
    const input = screen.getByLabelText("Payment description");
    input.focus();
    pressKey("c", input);
    pressKey("p", input);
    expect(pushes.routes).toEqual([]);
    expect(document.activeElement).toBe(input);
  });

  it("Escape resets an armed chord (c then Escape then p does nothing)", () => {
    render(<CreateMenu items={[...shellCreateItems()]} />);
    pressKey("c");
    pressKey("Escape");
    pressKey("p");
    expect(pushes.routes).toEqual([]);
  });

  it("never fires while a modifier is held (⌘P stays the browser print)", () => {
    render(<CreateMenu items={[...shellCreateItems()]} />);
    fireEvent.keyDown(window, { key: "c", metaKey: true });
    fireEvent.keyDown(window, { key: "p", metaKey: true });
    expect(pushes.routes).toEqual([]);
  });
});

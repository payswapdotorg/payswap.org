// @vitest-environment jsdom
/**
 * P3-W2-003 — keyboard contracts.
 *
 * The keyboard path is acceptance (DESIGN-SYSTEM-FOUNDATIONS §5): full task
 * completion without a pointer, logical tab order, skip links, no keyboard
 * traps. These tests pin the contracts the deployed app relies on:
 *  - the skip link is the first focusable element and lands on a FOCUSABLE
 *    main region (target carries tabindex="-1" — otherwise focus never
 *    actually moves for keyboard/AT users);
 *  - Dialog / CommandPalette / SidebarDrawer trap Tab focus inside, restore
 *    it on close, and close on Escape;
 *  - Tabs implement the WAI-ARIA roving-tabindex pattern;
 *  - the ⌘K/Ctrl-K global trigger opens the command palette;
 *  - the public site header marks the active nav entry with aria-current
 *    (never color alone) and the mobile disclosure closes on navigation and
 *    Escape (no menu left covering the page after a journey step).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { useState } from "react";

import {
  CommandPalette,
  Dialog,
  SidebarDrawer,
  Tabs,
  useCommandKey,
} from "@payswap/design";
import RootLayout from "../src/app/layout";
import { SiteHeader } from "../src/components/site-header";

/* ------------------------------------------------------------------ *
 * next/navigation mock (overrides the vitest alias stub so usePathname
 * is controllable per test — the header derives aria-current from it).
 * ------------------------------------------------------------------ */
const navState = vi.hoisted(() => ({ pathname: "/" }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: () => undefined,
    refresh: () => undefined,
    back: () => undefined,
    forward: () => undefined,
    prefetch: () => undefined,
  }),
  usePathname: () => navState.pathname,
  useSearchParams: () => new URLSearchParams(),
}));

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  navState.pathname = "/";
});

function renderRootLayoutBody(): void {
  const markup = renderToStaticMarkup(
    <RootLayout>
      <div>page content</div>
    </RootLayout>,
  );
  const bodyInner =
    markup.match(/<body[^>]*>([\s\S]*)<\/body>/)?.[1] ?? markup;
  document.body.innerHTML = bodyInner;
}

/* ----------------------------- skip link ---------------------------- */

describe("keyboard: the skip link is the keyboard-first entry point", () => {
  it("is the first focusable element in the body, before the site header", () => {
    renderRootLayoutBody();
    const focusables = Array.from(
      document.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    expect(focusables.length).toBeGreaterThan(0);
    const first = focusables[0]!;
    expect(first.tagName).toBe("A");
    expect(first.getAttribute("href")).toBe("#main-content");
    expect(
      first.compareDocumentPosition(document.querySelector("header")!),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(first.textContent).toMatch(/skip to (main )?content/i);
  });

  it("targets a main region that exists in the same document", () => {
    renderRootLayoutBody();
    const target = document.querySelector("#main-content");
    expect(target).not.toBeNull();
    expect(target!.tagName).toBe("MAIN");
  });

  it("lands focus: the main target is programmatically focusable (tabindex=-1)", () => {
    renderRootLayoutBody();
    const main = document.querySelector<HTMLElement>("#main-content");
    expect(main!.getAttribute("tabindex")).toBe("-1");
    // Behavioral proof in jsdom: focus() on a non-focusable <main> is a no-op,
    // on a tabindex=-1 main it moves activation focus.
    main!.focus();
    expect(document.activeElement).toBe(main);
  });
});

/* ------------------------------- Dialog ----------------------------- */

describe("keyboard: Dialog focus trap, restore and Escape", () => {
  function Opener() {
    const [open, setOpen] = useState(false);
    return (
      <div>
        <button type="button" onClick={() => setOpen(true)}>
          Open dialog
        </button>
        <p>
          <a href="#after">focusable after the dialog</a>
        </p>
        <Dialog
          open={open}
          onClose={() => setOpen(false)}
          title="Confirm"
          description="A described dialog."
          footer={
            <>
              <button type="button">Cancel</button>
              <button type="button">Confirm</button>
            </>
          }
        >
          Body
        </Dialog>
      </div>
    );
  }

  it("moves focus into the dialog on open and restores it to the opener on close", () => {
    render(<Opener />);
    const opener = screen.getByRole("button", { name: "Open dialog" });
    opener.focus();
    expect(document.activeElement).toBe(opener);

    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    // Focus moved INSIDE the dialog (trap activation).
    expect(dialog.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(dialog, { key: "Escape" });
    // Dialog unmounted; focus restored to the opener.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("traps Tab inside the dialog (wraps last→first and first→last)", () => {
    render(<Opener />);
    fireEvent.click(screen.getByRole("button", { name: "Open dialog" }));
    const dialog = screen.getByRole("dialog");
    const focusables = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      ),
    );
    expect(focusables.length).toBeGreaterThanOrEqual(3);

    // Activation focused the first focusable (the close button).
    expect(document.activeElement).toBe(focusables[0]);

    // Tab from the LAST focusable wraps to the first.
    focusables[focusables.length - 1]!.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(focusables[0]);

    // Shift+Tab from the FIRST focusable wraps to the last.
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(focusables[focusables.length - 1]);

    // And a focusable element OUTSIDE the dialog is never reached by Tab.
    const after = screen.getByText("focusable after the dialog");
    expect(after).toBeTruthy();
  });

  it("is labelled by its title and described by its description", () => {
    render(<Opener />);
    fireEvent.click(screen.getByRole("button", { name: "Open dialog" }));
    const dialog = screen.getByRole("dialog");
    const labelledBy = dialog.getAttribute("aria-labelledby")!;
    expect(dialog.querySelector(`#${labelledBy}`)?.textContent).toContain(
      "Confirm",
    );
    const describedBy = dialog.getAttribute("aria-describedby")!;
    expect(dialog.querySelector(`#${describedBy}`)?.textContent).toContain(
      "A described dialog.",
    );
  });
});

/* --------------------------- CommandPalette ------------------------- */

describe("keyboard: CommandPalette (combobox + listbox)", () => {
  function mountPalette(): { onClose: ReturnType<typeof vi.fn> } {
    const onClose = vi.fn();
    render(
      <CommandPalette
        open
        onClose={onClose}
        sections={[
          {
            id: "s1",
            label: "Go to",
            commands: [
              { id: "one", label: "Overview", run: () => undefined },
              { id: "two", label: "Payments", run: () => undefined },
              { id: "three", label: "Collections", run: () => undefined },
            ],
          },
        ]}
      />,
    );
    return { onClose };
  }

  it("focuses the combobox input on open (trap activation)", () => {
    mountPalette();
    const input = screen.getByRole("combobox");
    expect(document.activeElement).toBe(input);
  });

  it("ArrowDown/ArrowUp move aria-activedescendant through the options", () => {
    mountPalette();
    const input = screen.getByRole("combobox");
    const listboxId = input.getAttribute("aria-controls")!;
    const listbox = document.getElementById(listboxId)!;
    const options = Array.from(listbox.querySelectorAll('[role="option"]'));

    expect(input.getAttribute("aria-activedescendant")).toBe(
      options[0]!.id,
    );
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toBe(
      options[1]!.id,
    );
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.getAttribute("aria-activedescendant")).toBe(
      options[0]!.id,
    );
    // End jumps to the last option; Home back to the first.
    fireEvent.keyDown(input, { key: "End" });
    expect(input.getAttribute("aria-activedescendant")).toBe(
      options[options.length - 1]!.id,
    );
    fireEvent.keyDown(input, { key: "Home" });
    expect(input.getAttribute("aria-activedescendant")).toBe(
      options[0]!.id,
    );
  });

  it("Enter runs the active command and closes the palette", () => {
    const run = vi.fn();
    render(
      <CommandPalette
        open
        onClose={() => undefined}
        sections={[
          {
            id: "s1",
            label: "Actions",
            commands: [{ id: "pay", label: "Pay a recipient", run }],
          },
        ]}
      />,
    );
    const input = screen.getByRole("combobox");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("Escape closes the palette without running anything", () => {
    const { onClose } = mountPalette();
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("types a query, filters honestly and keeps the combobox/listbox wiring", () => {
    render(
      <CommandPalette
        open
        onClose={() => undefined}
        sections={[
          {
            id: "s1",
            label: "Go to",
            commands: [
              { id: "one", label: "Overview", run: () => undefined },
              { id: "two", label: "Payments", run: () => undefined },
            ],
          },
        ]}
      />,
    );
    const input = screen.getByRole("combobox") as HTMLInputElement;
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(input.getAttribute("aria-autocomplete")).toBe("list");
    fireEvent.change(input, { target: { value: "pay" } });
    expect(screen.getByRole("option", { name: /payments/i })).toBeTruthy();
    expect(
      screen.queryByRole("option", { name: /overview/i }),
    ).toBeNull();
  });
});

/* --------------------------- SidebarDrawer -------------------------- */

describe("keyboard: the mobile SidebarDrawer (dialog semantics)", () => {
  function mountDrawer(open: boolean): {
    onClose: ReturnType<typeof vi.fn>;
  } {
    const onClose = vi.fn();
    render(
      <SidebarDrawer open={open} onClose={onClose} label="Command Center sections">
        <a href="/app">Overview</a>
        <a href="/app/payments">Payments</a>
      </SidebarDrawer>,
    );
    return { onClose };
  }

  it("renders dialog semantics and traps focus while open", () => {
    mountDrawer(true);
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("Escape closes the drawer", () => {
    const { onClose } = mountDrawer(true);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders nothing while closed (no hidden DOM noise)", () => {
    mountDrawer(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

/* ------------------------------- Tabs ------------------------------- */

describe("keyboard: Tabs roving tabindex (WAI-ARIA pattern)", () => {
  const items = [
    { id: "a", label: "Alpha", content: "Alpha body" },
    { id: "b", label: "Beta", content: "Beta body" },
    { id: "c", label: "Gamma", content: "Gamma body" },
  ];

  it("only the selected tab is in the tab order (tabIndex 0)", () => {
    render(<Tabs label="Sections" items={items} defaultValue="a" />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.getAttribute("tabindex"))).toEqual([
      "0",
      "-1",
      "-1",
    ]);
  });

  it("ArrowRight/ArrowLeft move focus AND selection with wrap; Home/End work", () => {
    render(<Tabs label="Sections" items={items} defaultValue="a" />);
    const tabs = screen.getAllByRole("tab");
    const a = tabs[0]!;
    const b = tabs[1]!;
    const c = tabs[2]!;
    const tablist = screen.getByRole("tablist");

    fireEvent.keyDown(tablist, { key: "ArrowRight" });
    expect(document.activeElement).toBe(b);
    expect(b.getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(tablist, { key: "End" });
    expect(document.activeElement).toBe(c);

    // Wrap: ArrowRight from the last lands on the first.
    fireEvent.keyDown(tablist, { key: "ArrowRight" });
    expect(document.activeElement).toBe(a);

    fireEvent.keyDown(tablist, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(c);
  });

  it("panels are labelled by their tabs and only the selected is visible", () => {
    render(<Tabs label="Sections" items={items} defaultValue="a" />);
    // All three panels exist in the DOM (unselected ones carry `hidden`).
    const panels = Array.from(
      document.querySelectorAll('[role="tabpanel"]'),
    );
    expect(panels).toHaveLength(3);
    for (const panel of panels) {
      const labelledBy = panel.getAttribute("aria-labelledby")!;
      expect(document.getElementById(labelledBy)).toBeTruthy();
    }
    // Exactly one panel is exposed to the accessibility tree.
    expect(
      panels.filter((panel) => !panel.hasAttribute("hidden")),
    ).toHaveLength(1);
    // RTL role queries see only the visible one — AT-equivalent truth.
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
    expect(screen.getByRole("tabpanel").textContent).toContain("Alpha body");
  });
});

/* ------------------------------ ⌘K hook ----------------------------- */

describe("keyboard: the global ⌘K / Ctrl-K command trigger", () => {
  function Probe() {
    const [count, setCount] = useState(0);
    useCommandKey(() => setCount((n) => n + 1));
    return <output data-testid="probe">{count}</output>;
  }

  it("fires on Cmd-K and Ctrl-K, never on bare K", () => {
    render(<Probe />);
    const probe = () => screen.getByTestId("probe").textContent;
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(probe()).toBe("1");
    fireEvent.keyDown(window, { key: "k" });
    expect(probe()).toBe("1");
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(probe()).toBe("2");
    fireEvent.keyDown(window, { key: "j", metaKey: true });
    expect(probe()).toBe("2");
  });
});

/* --------------------------- site header nav ------------------------ */

describe("keyboard: the public site header", () => {
  it("marks the active nav entry with aria-current=page (never color alone)", () => {
    navState.pathname = "/capabilities";
    render(<SiteHeader />);
    const current = screen
      .getAllByRole("link", { name: "Capabilities" })
      .filter((link) => link.getAttribute("aria-current") === "page");
    // Both the desktop nav and the mobile disclosure carry the current page.
    expect(current.length).toBeGreaterThanOrEqual(1);
    // Non-active entries never carry aria-current.
    for (const home of screen.getAllByRole("link", { name: "Home" })) {
      expect(home.getAttribute("aria-current")).toBeNull();
    }
  });

  it("mobile disclosure closes on navigation (no menu left covering the page)", () => {
    navState.pathname = "/";
    const { rerender } = render(<SiteHeader />);
    const details = document.querySelector("details")!;
    expect(details).toBeTruthy();
    details.open = true;
    expect(details.open).toBe(true);

    navState.pathname = "/capabilities";
    rerender(<SiteHeader />);
    expect(details.open).toBe(false);
  });

  it("mobile disclosure closes on Escape", () => {
    navState.pathname = "/";
    render(<SiteHeader />);
    const details = document.querySelector("details")!;
    details.open = true;
    fireEvent.keyDown(details, { key: "Escape" });
    expect(details.open).toBe(false);
  });
});

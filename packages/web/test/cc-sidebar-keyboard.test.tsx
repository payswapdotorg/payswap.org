// @vitest-environment jsdom
/**
 * UX-003 — keyboard traversal of the object-model sidebar (contract 01 §8:
 * "keyboard-only users can traverse the entire nav").
 *
 * The workload groups render as an ACCORDION: the group toggle is a real
 * button (Enter/Space activate), the collapsed panel is `hidden` so Tab
 * never reaches it until the group opens, opening one group closes the
 * previous (one open at a time), and every group item is a real anchor
 * (deep-linkable, focusable, Enter activates natively). The five persistent
 * rows are always focusable anchors — never hidden by any projection.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { projectSidebar, SIDEBAR_GROUP_SLUGS } from "@payswap/ux";

import { CcNavContent } from "../src/components/cc/cc-nav-content";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

function renderNav(role: Parameters<typeof projectSidebar>[0] = "merchant"): void {
  render(<CcNavContent sidebar={projectSidebar(role)} activeRoute="/app" />);
}

function toggleFor(slug: string): HTMLElement {
  return document.querySelector(`[data-testid="nav.group.${slug}"] button`)!;
}

function panelFor(slug: string): HTMLElement {
  const toggle = toggleFor(slug);
  return document.getElementById(toggle.getAttribute("aria-controls")!)!;
}

describe("sidebar keyboard: the five persistent rows are always traversable", () => {
  it("renders the rows as real focusable anchors in registry order", () => {
    renderNav();
    const rows = Array.from(
      document.querySelectorAll('[data-testid="nav.rows"] a'),
    ) as HTMLAnchorElement[];
    expect(rows.map((row) => row.getAttribute("data-testid"))).toEqual([
      "nav.item.home",
      "nav.item.balances",
      "nav.item.transactions",
      "nav.item.customers",
      "nav.item.catalog",
    ]);
    expect(rows.map((row) => row.getAttribute("href"))).toEqual([
      "/app",
      "/app/balances",
      "/app/transactions",
      "/app/customers",
      "/app/catalog",
    ]);
    for (const row of rows) {
      expect(row.getAttribute("tabindex")).not.toBe("-1");
    }
  });

  it("keeps the rows traversable for every role projection (never hidden)", () => {
    for (const role of [
      "merchant",
      "supplier",
      "lp",
      "lender",
      "borrower",
      "developer",
      "expert",
      "network-operator",
    ] as const) {
      cleanup();
      renderNav(role);
      const rows = Array.from(
        document.querySelectorAll('[data-testid="nav.rows"] a'),
      );
      expect(rows).toHaveLength(5);
    }
  });
});

describe("sidebar keyboard: the workload-group accordion", () => {
  it("group toggles are real buttons with honest aria-expanded/aria-controls wiring", () => {
    renderNav();
    for (const slug of SIDEBAR_GROUP_SLUGS) {
      const toggle = toggleFor(slug);
      expect(toggle.tagName).toBe("BUTTON");
      // The merchant projection pins its first emphasized group (accept)
      // open on mount; every other group is collapsed by default.
      expect(toggle.getAttribute("aria-expanded")).toBe(
        slug === "accept" ? "true" : "false",
      );
      expect(toggle.getAttribute("aria-controls")).toBeTruthy();
      expect(document.getElementById(toggle.getAttribute("aria-controls")!)).toBeTruthy();
    }
  });

  it("collapsed panels are hidden — Tab never reaches their items until the group opens", () => {
    renderNav();
    for (const slug of SIDEBAR_GROUP_SLUGS.filter((s) => s !== "accept")) {
      expect(panelFor(slug).getAttribute("hidden")).toBe("");
    }
    // A collapsed group's anchor exists in the DOM (deep-linkable markup)
    // but sits inside the hidden panel, so Tab cannot reach it.
    const collapsedAnchor = panelFor("more").querySelector("a")!;
    expect(collapsedAnchor.getAttribute("data-testid")).toBe("nav.item.tax-compliance");
  });

  it("Enter opens a collapsed group; opening one closes the previous (accordion, one open at a time)", () => {
    renderNav();
    // accept is pinned open on mount; more is collapsed.
    const accept = toggleFor("accept");
    const more = toggleFor("more");
    fireEvent.keyDown(more, { key: "Enter" });
    fireEvent.click(more);
    expect(more.getAttribute("aria-expanded")).toBe("true");
    expect(panelFor("more").getAttribute("hidden")).toBeNull();
    expect(accept.getAttribute("aria-expanded")).toBe("false");
    expect(panelFor("accept").getAttribute("hidden")).toBe("");
  });

  it("an open group's items are focusable anchors; keyboard focus reaches them after opening", () => {
    renderNav();
    // accept is pinned open on mount for the merchant projection.
    const firstItem = panelFor("accept").querySelector("a")!;
    firstItem.focus();
    expect(document.activeElement).toBe(firstItem);
    expect(firstItem.getAttribute("href")).toBe("/app/payments");
  });

  it("the role projection's first emphasized group pins open on mount", () => {
    // The merchant projection emphasizes accept + bill → accept is pinned.
    renderNav("merchant");
    expect(toggleFor("accept").getAttribute("aria-expanded")).toBe("true");
    // The lp projection emphasizes insights → insights is pinned instead.
    cleanup();
    renderNav("lp");
    expect(toggleFor("insights").getAttribute("aria-expanded")).toBe("true");
    expect(toggleFor("accept").getAttribute("aria-expanded")).toBe("false");
  });
});

describe("sidebar keyboard: projection visibility is honest for hidden groups", () => {
  it("the borrower projection hides insights/capabilities entirely (not just visually)", () => {
    renderNav("borrower");
    expect(document.querySelector('[data-testid="nav.group.insights"]')).toBeNull();
    expect(document.querySelector('[data-testid="nav.group.capabilities"]')).toBeNull();
    // The pressure valve is never hidden.
    expect(document.querySelector('[data-testid="nav.group.more"]')).toBeTruthy();
  });
});

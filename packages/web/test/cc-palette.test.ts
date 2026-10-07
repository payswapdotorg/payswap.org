import { describe, expect, it } from "vitest";

import { deriveCcPalette, derivePaletteActions, derivePaletteGoTo } from "../src/lib/cc/palette";
import { SIDEBAR, projectSidebar } from "@payswap/ux";

/**
 * P3-W2-002 / UX-003 — the ⌘K palette derivation: Go-to is the OBJECT-MODEL
 * sidebar (the five persistent rows + every group item the role's projection
 * exposes, each bound to its real /app route); Actions are the real journey
 * starts, role-filtered through the legacy capability table; nothing
 * placeholder.
 */

describe("palette derivation", () => {
  it("Go-to covers the five persistent rows plus every visible group item for the default role", () => {
    const goTo = derivePaletteGoTo("merchant");
    const hrefs = goTo.map((command) => command.href);
    // The five money objects lead, in registry order, with projection-aware
    // labels under the "Money objects" chip.
    const rows = goTo.filter((command) => command.group === "Money objects");
    expect(rows.map((command) => command.href)).toEqual([
      "/app",
      "/app/balances",
      "/app/transactions",
      "/app/customers",
      "/app/catalog",
    ]);
    // Every group item of the (merchant: all-visible) projection is offered.
    const groupItemCount = SIDEBAR.groups.reduce(
      (count, group) => count + group.items.length,
      0,
    );
    expect(hrefs.length).toBe(5 + groupItemCount);
  });

  it("Go-to projects roles WITHOUT re-axing (borrower keeps the rows, hides its default-hidden groups)", () => {
    const merchant = derivePaletteGoTo("merchant");
    const borrower = derivePaletteGoTo("borrower");
    // The five persistent rows are NEVER hidden for any role.
    for (const rowHref of [
      "/app",
      "/app/balances",
      "/app/transactions",
      "/app/customers",
      "/app/catalog",
    ]) {
      expect(borrower.map((command) => command.href)).toContain(rowHref);
    }
    // The consumer projection re-labels the money objects (contract 10 §2).
    const borrowerRows = borrower.filter((command) => command.group === "Money objects");
    expect(borrowerRows.map((command) => command.label)).toContain("My balances");
    expect(borrowerRows.map((command) => command.label)).toContain("My payments");
    // The borrower's default view hides the insights + capabilities groups —
    // and nothing else; a merchant sees them.
    expect(
      borrower.map((command) => command.group),
    ).not.toContain("Insights");
    expect(
      borrower.map((command) => command.group),
    ).not.toContain("Capabilities");
    expect(merchant.map((command) => command.group)).toContain("Insights");
    expect(merchant.map((command) => command.group)).toContain("Capabilities");
    expect(borrower.length).toBe(
      5 +
        projectSidebar("borrower").groups
          .filter((view) => view.visible)
          .reduce((count, view) => count + view.group.items.length, 0),
    );
  });

  it("Actions are the verb-first journey starts with role filtering", () => {
    const actions = derivePaletteActions("merchant");
    const labels = actions.map((action) => action.label);
    expect(labels).toContain("Pay a recipient");
    expect(labels).toContain("Collect from a payer");
    expect(labels).toContain("Request a payout");
    expect(labels).toContain("Connect a provider");
    // The expert role cannot see Payments — the Pay action must not appear.
    const expertLabels = derivePaletteActions("expert").map((action) => action.label);
    expect(expertLabels).not.toContain("Pay a recipient");
    expect(expertLabels).not.toContain("Request a payout");
  });

  it("journey-start actions carry the ?start=1 deep-link parameter", () => {
    const pay = derivePaletteActions("merchant").find((action) => action.id === "action-pay");
    expect(pay?.href).toBe("/app/payments?start=1");
    const collect = derivePaletteActions("merchant").find((action) => action.id === "action-collect");
    expect(collect?.href).toBe("/app/collections?start=1");
  });

  it("links Connect to the parallel plane's /connect route string", () => {
    const connect = derivePaletteActions("merchant").find((action) => action.id === "action-connect");
    expect(connect?.href).toBe("/connect");
  });

  it("every command id is unique across both sections", () => {
    const palette = deriveCcPalette("merchant");
    const ids = [...palette.actions, ...palette.goTo].map((command) => command.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every go-to command carries a real group chip from the sidebar model", () => {
    for (const command of derivePaletteGoTo("lp")) {
      expect(command.group.length).toBeGreaterThan(0);
      expect([
        "Money objects",
        "Accept",
        "Bill",
        "Insights",
        "Capabilities",
        "More",
      ]).toContain(command.group);
    }
  });
});

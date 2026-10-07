// @vitest-environment jsdom
/**
 * UX-003 — the Balances surface anatomy (contract 09 §2 Balances + workflow
 * contract 04 W5): header (total in display currency + Withdraw + Add funds
 * + Manage schedule + Add rail) → Incoming vs Available table per asset/rail
 * with "Settle <cadence>" as an INLINE STATUS → tabs (Settlements · Top-ups
 * · All activity · Statements & reconciliation) with honest hub/empty
 * content. The payout list keeps the W5 anatomy — failure-reason and retry
 * affordances present even while empty. Honesty law: unobserved balances
 * render "—", never a fabricated zero; totals render only when observed.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  BalancesHeader,
  BalancesRailTable,
  BalancesTabs,
} from "../src/components/shell/balances-blocks";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("balances: the header anatomy (contract 09 §2)", () => {
  it("renders the total in display currency — honestly absent until observed", () => {
    const html = renderToStaticMarkup(
      <BalancesHeader totalDisplay={null} displayCurrency={null} />,
    );
    expect(html).toContain('data-testid="balances-total"');
    expect(html).toContain("—");
    expect(html).toContain("No balances recorded yet");
  });

  it("renders the observed total with its display currency", () => {
    const html = renderToStaticMarkup(
      <BalancesHeader totalDisplay="1,204.10" displayCurrency="EUR" />,
    );
    expect(html).toContain("1,204.10");
    expect(html).toContain("EUR");
    expect(html).not.toContain("No balances recorded yet");
  });

  it("carries all four header actions, each routing to its real flow (no dead buttons)", () => {
    const html = renderToStaticMarkup(
      <BalancesHeader totalDisplay={null} displayCurrency={null} />,
    );
    for (const [label, href] of [
      ["Withdraw", "/app/payouts"],
      ["Add funds", "/connect"],
      ["Manage schedule", "/app/settings"],
      ["Add rail", "/connect"],
    ] as const) {
      expect(html).toContain(label);
      expect(html).toContain(`href="${href}"`);
    }
  });
});

describe("balances: the Incoming vs Available table per asset/rail", () => {
  it("zero-state: no rails connected — the empty teaches the fill path", () => {
    const html = renderToStaticMarkup(<BalancesRailTable rows={[]} />);
    expect(html).toContain('data-testid="balances-rails-empty"');
    expect(html).toContain("No rails connected yet");
    expect(html).toContain("Add a rail");
  });

  it("renders per-rail rows; unobserved values are —, never zeros (observations, not custody)", () => {
    const html = renderToStaticMarkup(
      <BalancesRailTable
        rows={[
          { rail: "Stripe", asset: "EUR", incoming: null, available: null, settlement: null },
          {
            rail: "Base",
            asset: "USDC",
            incoming: "8.00 USDC",
            available: "90.00 USDC",
            settlement: "Settle daily",
          },
        ]}
      />,
    );
    for (const column of ["Rail", "Asset", "Incoming", "Available", "Settlement"]) {
      expect(html).toContain(column);
    }
    expect(html).toContain("Stripe");
    expect(html).toContain("Base");
    expect(html).toContain("—");
    expect(html).toContain("Not scheduled");
    expect(html).toContain("8.00 USDC");
    expect(html).toContain("Settle daily");
    // The observation doctrine is stated on the surface.
    expect(html).not.toContain("custod");
  });

  it("renders \"Settle <cadence>\" as an INLINE STATUS node (a status, not a setting)", () => {
    const html = renderToStaticMarkup(
      <BalancesRailTable
        rows={[
          {
            rail: "Base",
            asset: "USDC",
            incoming: null,
            available: null,
            settlement: "Settle weekly",
          },
        ]}
      />,
    );
    expect(html).toContain('data-testid="balances-settle-status"');
    expect(html).toContain("Settle weekly");
  });
});

describe("balances: the tabs are Settlements · Top-ups · All activity · Statements & reconciliation", () => {
  it("renders the four contract tabs with Settlements selected by default", () => {
    render(<BalancesTabs />);
    for (const label of ["Settlements", "Top-ups", "All activity", "Statements & reconciliation"]) {
      expect(
        screen.getByRole("tab", { name: new RegExp(label, "i") }),
      ).toBeTruthy();
    }
    expect(
      screen.getByRole("tab", { name: /settlements/i }).getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("the Settlements panel keeps the W5 anatomy — failure-reason and retry columns present even while empty", () => {
    const html = renderToStaticMarkup(<BalancesTabs />);
    for (const column of ["Amount", "Status", "Rail", "Expected date", "Net", "Failure reason"]) {
      expect(html).toContain(column);
    }
    expect(html).toContain("No settlements yet");
    expect(html).toContain("human reason and a retry affordance");
  });

  it("Top-ups tab: honest empty explaining the non-custodial fill path", () => {
    render(<BalancesTabs />);
    fireEvent.click(screen.getByRole("tab", { name: /top-ups/i }));
    expect(
      screen.getByRole("tab", { name: /top-ups/i }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByText(/No top-ups yet/i)).toBeTruthy();
    expect(screen.getByText(/non-custodial/i)).toBeTruthy();
  });

  it("All activity tab: honest empty linking the full Activity feed", () => {
    render(<BalancesTabs />);
    fireEvent.click(screen.getByRole("tab", { name: /all activity/i }));
    expect(screen.getByText(/No balance activity yet/i)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /open the full activity feed/i }).getAttribute("href"),
    ).toBe("/app/activity");
  });

  it("Statements & reconciliation tab: honest empty pointing at Reports", () => {
    render(<BalancesTabs />);
    fireEvent.click(
      screen.getByRole("tab", { name: /statements & reconciliation/i }),
    );
    expect(screen.getByText(/Statements render monthly per rail/i)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /open reports/i }).getAttribute("href"),
    ).toBe("/app/reports");
  });
});

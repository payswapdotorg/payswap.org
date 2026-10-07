import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { CONSUMER_ROW_LABELS, projectSidebar } from "@payswap/ux";
import { SIDEBAR_PERSISTENT_ROW_IDS } from "@payswap/ux";

import { CcNavContent } from "../src/components/cc/cc-nav-content";
import { deriveCcRenderState, sidebarForState } from "../src/lib/cc/render-state";
import {
  effectiveSidebarProjection,
  parseProjectionPreference,
  type CcSessionResolution,
} from "../src/lib/cc/session-seam";
import { ProjectionSwitch } from "../src/components/consumer/projection-switch";

/**
 * UX-006 — the projection seam (contract 10 §6: "merchant CAN switch
 * projections — same account, two projections"): the fail-closed cookie
 * parse, the effective-projection derivation (preference wins, role default
 * otherwise, merchant the default), the round-trip at the SIDEBAR-LABEL
 * level through the UX-002 projection API (never a re-axing), the switch
 * control's markup, and the session-honesty law (a projection preference is
 * a view derivation — it never authenticates, never unlocks, never changes
 * the render state).
 */

const NOT_WIRED: CcSessionResolution = {
  status: "not-wired",
  reason: "the authentication/session plane is not configured in this deployment",
};

describe("projection seam: parseProjectionPreference fails closed", () => {
  it("accepts exactly the two real projections", () => {
    expect(parseProjectionPreference("consumer")).toBe("consumer");
    expect(parseProjectionPreference("merchant")).toBe("merchant");
  });

  it("rejects absent, empty and malformed values (merchant stays the default)", () => {
    expect(parseProjectionPreference(undefined)).toBeNull();
    expect(parseProjectionPreference(null)).toBeNull();
    expect(parseProjectionPreference("")).toBeNull();
    expect(parseProjectionPreference("admin")).toBeNull();
    expect(parseProjectionPreference("CONSUMER")).toBeNull();
  });
});

describe("projection seam: effectiveSidebarProjection (preference wins; role default otherwise)", () => {
  it("no preference: every role keeps its own default projection", () => {
    expect(effectiveSidebarProjection("merchant", null)).toBe("merchant");
    expect(effectiveSidebarProjection("borrower", null)).toBe("consumer");
    expect(effectiveSidebarProjection("developer", null)).toBe("merchant");
  });

  it("no preference and no role: merchant (the default)", () => {
    expect(effectiveSidebarProjection(null, null)).toBe("merchant");
  });

  it("the explicit preference overrides the role default — BOTH ways (the round trip)", () => {
    // A merchant switches to the consumer view on the same account.
    expect(effectiveSidebarProjection("merchant", "consumer")).toBe("consumer");
    // A borrower switches back to the merchant view.
    expect(effectiveSidebarProjection("borrower", "merchant")).toBe("merchant");
  });
});

describe("projection seam: the sidebar round-trip through the UX-002 projection API", () => {
  const merchantSidebar = projectSidebar("merchant");
  const consumerSidebar = projectSidebar("merchant", { projection: "consumer" });

  it("the consumer projection re-labels the SAME rows (never a re-axing)", () => {
    expect(consumerSidebar.projection).toBe("consumer");
    expect(merchantSidebar.projection).toBe("merchant");
    // Same ids, same routes, same order — only the labels change.
    expect(consumerSidebar.rows.map((view) => view.row.id)).toEqual(
      merchantSidebar.rows.map((view) => view.row.id),
    );
    expect(consumerSidebar.rows.map((view) => view.row.route)).toEqual(
      merchantSidebar.rows.map((view) => view.row.route),
    );
    expect(consumerSidebar.rows.map((view) => view.row.id)).toEqual([
      ...SIDEBAR_PERSISTENT_ROW_IDS,
    ]);
  });

  it("the consumer labels are exactly the contract-10 §2 vocabulary", () => {
    expect(consumerSidebar.rows.map((view) => view.label)).toEqual(
      SIDEBAR_PERSISTENT_ROW_IDS.map((id) => CONSUMER_ROW_LABELS[id]),
    );
  });

  it("the nav content renders the consumer labels through the projection (what the cookie feeds)", () => {
    const html = renderToStaticMarkup(
      <CcNavContent sidebar={consumerSidebar} activeRoute="/app" />,
    );
    for (const label of ["My balances", "My payments", "My contacts", "My requests"]) {
      expect(html).toContain(label);
    }
    // The merchant labels are replaced in the row links.
    expect(html).not.toContain(">Balances<");
    expect(html).not.toContain(">Transactions<");
    expect(html).not.toContain(">Customers<");
    expect(html).not.toContain(">Catalog<");
    // The persistent rows are NEVER hidden and their routes are unchanged.
    for (const [id, route] of [
      ["home", "/app"],
      ["balances", "/app/balances"],
      ["transactions", "/app/transactions"],
      ["customers", "/app/customers"],
      ["catalog", "/app/catalog"],
    ] as const) {
      expect(html).toContain(`data-testid="nav.item.${id}"`);
      expect(html).toContain(`href="${route}"`);
    }
  });

  it("switching back: the same nav content renders the merchant labels again", () => {
    const html = renderToStaticMarkup(
      <CcNavContent sidebar={merchantSidebar} activeRoute="/app" />,
    );
    expect(html).toContain(">Balances<");
    expect(html).toContain(">Transactions<");
    expect(html).not.toContain("My payments");
  });
});

describe("projection seam: the switch control", () => {
  it("offers both projections with the current one marked (works without JavaScript)", () => {
    const html = renderToStaticMarkup(<ProjectionSwitch projection="merchant" />);
    expect(html).toContain('data-testid="projection-switch"');
    expect(html).toContain('value="merchant"');
    expect(html).toContain('value="consumer"');
    expect(html.match(/checked(?:="")?/g)?.length).toBe(1);
    expect(html).toContain("Merchant view (default)");
    expect(html).toContain("Consumer view");
  });

  it("marks the consumer side when the projection is consumer", () => {
    const html = renderToStaticMarkup(<ProjectionSwitch projection="consumer" />);
    // The consumer radio is the checked one (last checked input is consumer).
    const consumerInput = html.match(/<input[^>]*value="consumer"[^>]*>/)?.[0] ?? "";
    expect(consumerInput).toMatch(/checked/);
    const merchantInput = html.match(/<input[^>]*value="merchant"[^>]*>/)?.[0] ?? "";
    expect(merchantInput).not.toMatch(/checked/);
  });

  it("states the honesty law on its face (never an authentication)", () => {
    const html = renderToStaticMarkup(<ProjectionSwitch projection="consumer" />);
    expect(html).toContain("never changes your session or your authority");
    expect(html).toContain("same account, same objects, two projections");
  });
});

describe("projection seam: session honesty is preserved (the projection is a view derivation only)", () => {
  it("the projection preference never changes the render state — preview stays marked, gates stay closed", () => {
    // A not-wired deployment with a role preference renders the marked
    // preview; the projection preference cannot alter that derivation.
    const withProjectionCookie = deriveCcRenderState(NOT_WIRED, "merchant");
    const withoutProjectionCookie = deriveCcRenderState(NOT_WIRED, "merchant");
    expect(withProjectionCookie).toEqual(withoutProjectionCookie);
    expect(withProjectionCookie.preview).toBe(true);
    expect(withProjectionCookie.gated).toBe(false);
    // No role at all: the honest gate.
    expect(deriveCcRenderState(NOT_WIRED, null).gated).toBe(true);
  });

  it("the projection derivation consumes only (role, preference) — never the session", () => {
    // The seam's projection half is a pure function of the role and the
    // cookie: no session input exists for it to consult, so no projection
    // value can ever authenticate, unlock or gate anything.
    expect(effectiveSidebarProjection("merchant", "consumer")).toBe("consumer");
    expect(effectiveSidebarProjection(null, "consumer")).toBe("consumer");
  });
});

describe("projection seam: the LAYOUT wiring (sidebarForState re-labels for the render)", () => {
  const state = (projectionPreference: "merchant" | "consumer" | null) =>
    deriveCcRenderState(NOT_WIRED, "merchant", projectionPreference);

  it("no preference: the merchant sidebar labels (the default)", () => {
    const sidebar = sidebarForState(state(null));
    expect(sidebar.projection).toBe("merchant");
    expect(sidebar.rows.map((view) => view.label)).toContain("Balances");
    expect(sidebar.rows.map((view) => view.label)).not.toContain("My balances");
  });

  it("the consumer preference re-labels the SAME rows through the render state (never a re-axing)", () => {
    const merchantSidebar = sidebarForState(state(null));
    const consumerSidebar = sidebarForState(state("consumer"));
    expect(consumerSidebar.projection).toBe("consumer");
    // Same ids, routes, order — only the labels change (contract 10 §6).
    expect(consumerSidebar.rows.map((view) => view.row.id)).toEqual(
      merchantSidebar.rows.map((view) => view.row.id),
    );
    expect(consumerSidebar.rows.map((view) => view.row.route)).toEqual(
      merchantSidebar.rows.map((view) => view.row.route),
    );
    expect(consumerSidebar.rows.map((view) => view.label)).toContain("My balances");
  });

  it("an explicit merchant preference overrides a consumer-default role", () => {
    const borrower = deriveCcRenderState(NOT_WIRED, "borrower", "merchant");
    expect(sidebarForState(borrower).projection).toBe("merchant");
  });
});

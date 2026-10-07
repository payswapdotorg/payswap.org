import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { CcNavContent } from "../src/components/cc/cc-nav-content";
import { CcAuthGate } from "../src/components/cc/cc-auth-gate";
import { CcSectionNotYetAvailable } from "../src/components/cc/cc-section-not-yet";
import { deriveCcRenderState } from "../src/lib/cc/render-state";
import { resolveCcSession } from "../src/lib/cc/session-seam";
import {
  SIDEBAR,
  SIDEBAR_PERSISTENT_ROW_IDS,
  SIDEBAR_GROUP_SLUGS,
  projectSidebar,
} from "@payswap/ux";

/**
 * P3-W2-002 / UX-003 — the shell's server-renderable surfaces: the
 * object-model sidebar from the UX-002 registry (exactly 5 persistent rows
 * + workload groups, role PROJECTIONS never re-axing), the honest auth gate
 * (Wave-1's pattern, no pretend login), and the honest not-yet sections.
 */

function text(html: string): string {
  return html.replace(/<!--.*?-->/g, "");
}

describe("command center navigation content", () => {
  it("renders exactly the FIVE persistent rows, in registry order, with stable testids (contract 01 §3)", () => {
    const html = renderToStaticMarkup(
      <CcNavContent sidebar={projectSidebar("merchant")} activeRoute="/app" />,
    );
    const rows = html.match(/data-testid="nav\.item\.[a-z-]+"/g) ?? [];
    const rowIds = rows
      .map((match) => match.slice("data-testid=\"nav.item.".length, -1))
      .filter((id) => (SIDEBAR_PERSISTENT_ROW_IDS as readonly string[]).includes(id));
    expect(rowIds).toEqual([...SIDEBAR_PERSISTENT_ROW_IDS]);
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

  it("renders the five workload groups with stable nav.group.<slug> testids and their items", () => {
    const html = renderToStaticMarkup(
      <CcNavContent sidebar={projectSidebar("merchant")} activeRoute="/app" />,
    );
    for (const slug of SIDEBAR_GROUP_SLUGS) {
      expect(html).toContain(`data-testid="nav.group.${slug}"`);
    }
    // Group items render as real anchors (deep-linkable) even while the
    // accordion is collapsed — the registry shape is the truth.
    for (const item of ["payments-analytics", "checkout", "invoices", "reports", "installed", "workflows"]) {
      expect(html).toContain(`data-testid="nav.item.${item}"`);
    }
    expect(html).toContain('href="/app/payments"');
    expect(html).toContain('href="/app/billing"');
    expect(html).toContain('href="/app/reports"');
    expect(html).toContain('href="/app/capabilities"');
  });

  it("marks the active route with aria-current=page (never color alone)", () => {
    const raw = renderToStaticMarkup(
      <CcNavContent sidebar={projectSidebar("merchant")} activeRoute="/app/payments" />,
    );
    const current = raw.match(/<a[^>]*aria-current="page"[^>]*>/)?.[0] ?? "";
    expect(current).toContain('href="/app/payments"');
  });

  it("projects roles WITHOUT re-axing: the borrower sees consumer labels and hides insights/capabilities, but the five rows stay", () => {
    const projected = projectSidebar("borrower");
    expect(projected.projection).toBe("consumer");
    const html = text(
      renderToStaticMarkup(<CcNavContent sidebar={projected} activeRoute="/app" />),
    );
    // Consumer mental model labels (contract 10 §2).
    expect(html).toContain("My balances");
    expect(html).toContain("My payments");
    expect(html).not.toContain(">Balances<");
    // Hidden role-default groups are absent; every other group stays.
    expect(html).not.toContain('data-testid="nav.group.insights"');
    expect(html).not.toContain('data-testid="nav.group.capabilities"');
    expect(html).toContain('data-testid="nav.group.more"');
    // The persistent rows are NEVER hidden.
    for (const id of SIDEBAR_PERSISTENT_ROW_IDS) {
      expect(html).toContain(`data-testid="nav.item.${id}"`);
    }
  });

  it("renders the registry itself exactly (5 rows + 5 groups, stable order)", () => {
    expect(SIDEBAR.rows.map((row) => row.id)).toEqual([...SIDEBAR_PERSISTENT_ROW_IDS]);
    expect(SIDEBAR.groups.map((group) => group.slug)).toEqual([...SIDEBAR_GROUP_SLUGS]);
  });
});

describe("the honest authentication gate", () => {
  async function gateHtml(navItemId: "overview" | "payments" = "overview"): Promise<string> {
    const session = await resolveCcSession();
    const state = deriveCcRenderState(session, null);
    return text(renderToStaticMarkup(<CcAuthGate navItemId={navItemId} state={state} />));
  }

  it("states the honest not-wired truth with no pretend login", async () => {
    const html = await gateHtml();
    expect(html).toContain("authentication required");
    expect(html).toContain("not yet wired in this deployment");
    expect(html).toContain("no demo mode, no sample data and no pretend login");
    expect(html).toContain("Only real, verified state is rendered here");
  });

  it("contains NO credential capture and NO financial claims", async () => {
    const raw = await gateHtml();
    expect(raw).not.toContain('type="password"');
    expect(raw).not.toContain('type="email"');
    expect(raw).not.toMatch(/\$\s?\d/);
    expect(raw).not.toContain("Your balance");
  });

  it("offers the clearly-marked role preview switcher (all eight roles)", async () => {
    const html = await gateHtml();
    expect(html).toContain("View as role (preview)");
    expect(html).toContain("never an authentication");
    for (const role of ["merchant", "supplier", "lp", "lender", "borrower", "developer", "expert", "network-operator"]) {
      expect(html).toContain(`value="${role}"`);
    }
  });

  it("carries section-specific copy per deep link", async () => {
    const html = await gateHtml("payments");
    expect(html).toContain("Payments — authentication required");
    expect(html).toContain("serves the authenticated payments surface");
  });

  it("links back to the public surfaces", async () => {
    const html = await gateHtml();
    expect(html).toContain('href="/"');
    expect(html).toContain('href="/capabilities"');
    expect(html).toContain('href="/security"');
  });
});

describe("the honest not-yet sections", () => {
  it("renders the certified summary, the honest reason and the bound journeys", () => {
    const html = text(renderToStaticMarkup(<CcSectionNotYetAvailable navItemId="billing" />));
    expect(html).toContain("Billing");
    expect(html).toContain("Not yet live in this deployment");
    expect(html).toContain("remittance allocations");
    expect(html).toContain("Nothing here is simulated");
    expect(html).toContain("billing.manage");
  });

  it("lists the journey bindings for a journey-bound section", () => {
    const html = text(renderToStaticMarkup(<CcSectionNotYetAvailable navItemId="disputes" />));
    expect(html).toContain("INV-C06");
  });
});

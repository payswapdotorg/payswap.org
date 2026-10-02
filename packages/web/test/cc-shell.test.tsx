import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { CcNavContent } from "../src/components/cc/cc-nav-content";
import { CcAuthGate } from "../src/components/cc/cc-auth-gate";
import { CcSectionNotYetAvailable } from "../src/components/cc/cc-section-not-yet";
import { deriveCcRenderState } from "../src/lib/cc/render-state";
import { resolveCcSession } from "../src/lib/cc/session-seam";
import { deriveNavigationForRole, PRODUCT_NAVIGATION } from "@payswap/ux";

/**
 * P3-W2-002 — the shell's server-renderable surfaces: the grouped navigation
 * from the certified model, the honest auth gate (Wave-1's pattern, no
 * pretend login), and the honest not-yet sections.
 */

function text(html: string): string {
  return html.replace(/<!--.*?-->/g, "");
}

describe("command center navigation content", () => {
  it("renders every grouped section for the merchant derivation (role-derived: Liquidity/Opportunities/Developers are EXCLUDED — the certified law)", () => {
    const nav = deriveNavigationForRole(PRODUCT_NAVIGATION, "merchant");
    const html = renderToStaticMarkup(<CcNavContent nav={nav} activeRoute="/app" />);
    for (const label of ["Overview", "Money movement", "Capabilities", "Trust", "Account"]) {
      expect(html).toContain(label);
    }
    for (const label of ["Overview", "Activity", "Payments", "Collections", "Payouts", "Billing", "Credit", "Capabilities", "Agents", "Programs and incentives", "Disputes", "Evidence", "Settings"]) {
      expect(html).toContain(label);
    }
    // The merchant capability table has no liquidity.provide / opportunities.view
    // / developer surfaces — the derivation must hide them, never grey them out.
    expect(html).not.toContain("Liquidity");
    expect(html).not.toContain("Opportunities");
    expect(html).not.toContain('href="/app/developers"');
  });

  it("marks the active route with aria-current=page (never color alone)", () => {
    const nav = deriveNavigationForRole(PRODUCT_NAVIGATION, "merchant");
    const raw = renderToStaticMarkup(<CcNavContent nav={nav} activeRoute="/app/payments" />);
    const current = raw.match(/<a[^>]*aria-current="page"[^>]*>/)?.[0] ?? "";
    expect(current).toContain('href="/app/payments"');
  });

  it("renders every merchant item as a real anchor (deep-linkable); the developer role adds Developers", () => {
    const nav = deriveNavigationForRole(PRODUCT_NAVIGATION, "merchant");
    const raw = renderToStaticMarkup(<CcNavContent nav={nav} activeRoute="/app" />);
    for (const href of [
      "/app",
      "/app/activity",
      "/app/payments",
      "/app/collections",
      "/app/payouts",
      "/app/capabilities",
      "/app/agents",
      "/app/programs",
      "/app/disputes",
      "/app/evidence",
      "/app/settings",
      "/app/billing",
      "/app/credit",
    ]) {
      expect(raw).toContain(`href="${href}"`);
    }
    const devNav = deriveNavigationForRole(PRODUCT_NAVIGATION, "developer");
    const devRaw = renderToStaticMarkup(<CcNavContent nav={devNav} activeRoute="/app/developers" />);
    expect(devRaw).toContain('href="/app/developers"');
  });

  it("role-derives: the supplier view hides Credit/Liquidity/Agents", () => {
    const nav = deriveNavigationForRole(PRODUCT_NAVIGATION, "supplier");
    const html = text(renderToStaticMarkup(<CcNavContent nav={nav} activeRoute="/app" />));
    expect(html).not.toContain("Credit");
    expect(html).not.toContain("Liquidity");
    expect(html).not.toContain("Agents");
    expect(html).toContain("Payments");
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

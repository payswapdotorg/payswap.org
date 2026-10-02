import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CommandCenter } from "../src/components/command-center";

/**
 * The authenticated entry boundary. The law: an HONEST gate — no fake
 * login, no demo data, no optimistic content — while the shell keeps real
 * navigation: all nine sections, deep links that resolve, and the same
 * gate for every /app/* path (hard-refresh safe by construction).
 */

function render(section?: string[]): string {
  return renderToStaticMarkup(<CommandCenter section={section} />);
}

function text(html: string): string {
  return html.replace(/<!--.*?-->/g, "");
}

const SECTION_LABELS = [
  "Overview",
  "Activity",
  "Payments",
  "Collections",
  "Payouts",
  "Capabilities",
  "Evidence",
  "Developers",
  "Settings",
] as const;

describe("command center gate", () => {
  it("renders the honest authentication-required state", () => {
    const html = text(render());
    expect(html).toContain("Authentication required");
    expect(html).toContain("not yet available in this deployment phase");
    expect(html).toContain("no demo mode, no sample data and no pretend login");
  });

  it("contains NO fake login and NO credential capture", () => {
    const html = render();
    expect(html).not.toContain("<form");
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain('type="email"');
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<button");
    expect(html).not.toMatch(/\$\s?\d/);
    expect(html).not.toContain("balance");
  });

  it("carries all nine sections in the sidebar navigation", () => {
    const html = text(render());
    for (const label of SECTION_LABELS) {
      expect(html).toContain(label);
    }
    const raw = render();
    for (const href of [
      "/app",
      "/app/activity",
      "/app/payments",
      "/app/collections",
      "/app/payouts",
      "/app/capabilities",
      "/app/evidence",
      "/app/developers",
      "/app/settings",
    ]) {
      expect(raw).toContain(`href="${href}"`);
    }
  });

  it("marks Overview as the current section at /app", () => {
    const raw = render();
    const current = raw.match(/<a[^>]*aria-current="page"[^>]*>/)?.[0] ?? "";
    expect(current).toContain('href="/app"');
    expect(raw).toContain("Command Center — Overview");
    expect(raw).toContain("will serve the authenticated overview");
  });

  it("resolves deep links with the section-specific view", () => {
    const raw = render(["payments"]);
    const current = raw.match(/<a[^>]*aria-current="page"[^>]*>/)?.[0] ?? "";
    expect(current).toContain('href="/app/payments"');
    expect(text(raw)).toContain("Command Center — Payments");
    expect(text(raw)).toContain("Payments will show:");
    expect(text(raw)).toContain("valid deep link");
    expect(text(raw)).toContain("survives a hard refresh");
  });

  it("resolves every section deep link", () => {
    for (const [slug, label] of [
      ["activity", "Activity"],
      ["collections", "Collections"],
      ["payouts", "Payouts"],
      ["capabilities", "Capabilities"],
      ["evidence", "Evidence"],
      ["developers", "Developers"],
      ["settings", "Settings"],
    ] as const) {
      const html = text(render([slug]));
      expect(html).toContain(`Command Center — ${label}`);
      expect(html).toContain("Authentication required");
    }
  });

  it("renders the honest unrecognized-section notice for unknown paths", () => {
    const html = text(render(["nonsense"]));
    expect(html).toContain("Authentication required");
    expect(html).toContain("Unrecognized section:");
    expect(html).toContain("/app/nonsense");
    expect(html).toContain("not one of the Command Center sections");
    expect(html).toContain("never 404");
  });

  it("states that no financial data is rendered", () => {
    const html = text(render());
    expect(html).toContain("None rendered");
    expect(html).toContain("holds no financial state of its own");
    expect(html).toContain("the authoritative PaySwap API owns all financial truth");
  });
});

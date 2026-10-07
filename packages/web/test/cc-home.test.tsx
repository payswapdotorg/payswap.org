import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  HomeDevelopCard,
  HomeOverviewMetrics,
  HomeRecommendations,
  HomeTodayCard,
} from "../src/components/shell/home-blocks";

/**
 * UX-003 — the Home page blocks (contract 09 §2 Home): Today →
 * Recommendations → Develop → Your overview, in that order, with the Today
 * card FIRST even at zero. Honesty law under test: no fabricated balances,
 * no fabricated key material, no fabricated metrics — every value is real
 * data or an explicit honest-empty marker ("—" / "No data" inside the chart
 * scaffold).
 */

/** The Home composition, in the page's contract order (contract 09 §2). */
function homeMarkup(options?: {
  readonly rails?: Parameters<typeof HomeTodayCard>[0]["data"]["rails"];
  readonly keys?: Parameters<typeof HomeDevelopCard>[0]["keys"];
}): string {
  return renderToStaticMarkup(
    <>
      <HomeTodayCard data={{ rails: options?.rails ?? [], nextSettlement: null }} />
      <HomeRecommendations
        recommendations={[
          {
            id: "connect-first-rail",
            proposition: "Connect your first rail — no code needed.",
            ctaLabel: "Connect a rail",
            ctaHref: "/connect",
          },
        ]}
      />
      <HomeDevelopCard keys={options?.keys ?? null} />
      <HomeOverviewMetrics />
    </>,
  );
}

describe("home: the block order is Today → Recommendations → Develop → Overview", () => {
  it("renders the Today card FIRST even at zero (the zero-state teaches the fill path)", () => {
    const html = homeMarkup();
    const today = html.indexOf('data-testid="home-today"');
    const recommendations = html.indexOf('data-testid="home-recommendations"');
    const develop = html.indexOf('data-testid="home-develop"');
    const overview = html.indexOf('data-testid="home-overview"');
    expect(today).toBeGreaterThanOrEqual(0);
    expect(recommendations).toBeGreaterThan(today);
    expect(develop).toBeGreaterThan(recommendations);
    expect(overview).toBeGreaterThan(develop);
  });
});

describe("home: the Today card is honest at zero and with observations", () => {
  it("zero-state: no balances yet, with the fill path (connect a rail) — never a fabricated amount", () => {
    const html = renderToStaticMarkup(
      <HomeTodayCard data={{ rails: [], nextSettlement: null }} />,
    );
    expect(html).toContain('data-testid="home-today-empty"');
    expect(html).toContain("No balances yet");
    expect(html).toContain("Connect your first rail");
    expect(html).not.toMatch(/\d+\.\d{2}\s*(USDC|EUR|USD)/); // no invented amounts
  });

  it("zero-state: no settlement schedule yet, with the Balances link to manage one", () => {
    const html = renderToStaticMarkup(
      <HomeTodayCard data={{ rails: [], nextSettlement: null }} />,
    );
    expect(html).toContain('data-testid="home-today-schedule"');
    expect(html).toContain("No settlement schedule yet");
    expect(html).toContain('href="/app/balances"');
  });

  it("always carries the Withdraw action, routing to the real payout journey", () => {
    const html = renderToStaticMarkup(
      <HomeTodayCard data={{ rails: [], nextSettlement: null }} />,
    );
    expect(html).toContain("Withdraw");
    expect(html).toContain('href="/app/payouts"');
  });

  it("renders the per-rail Incoming vs Available table; unobserved values are —, never zero", () => {
    const html = renderToStaticMarkup(
      <HomeTodayCard
        data={{
          rails: [
            {
              rail: "Stripe",
              incoming: null,
              available: null,
              settlement: null,
            },
            {
              rail: "Base (USDC)",
              incoming: "12.50 USDC",
              available: "140.00 USDC",
              settlement: "Settle daily",
            },
          ],
          nextSettlement: "Next settlement tomorrow, 09:00 UTC",
        }}
      />,
    );
    for (const column of ["Rail", "Incoming", "Available", "Settlement"]) {
      expect(html).toContain(column);
    }
    expect(html).toContain("Stripe");
    expect(html).toContain("Base (USDC)");
    // Unobserved renders the explicit marker, never a zero that claims one.
    expect(html).toContain("—");
    expect(html).toContain("Not scheduled");
    // Observed values render as given (they arrived as data).
    expect(html).toContain("12.50 USDC");
    expect(html).toContain("Settle daily");
    expect(html).toContain("Next settlement tomorrow, 09:00 UTC");
  });
});

describe("home: Recommendations are one sentence + one verb CTA", () => {
  it("renders capability-activation cards with a single verb CTA each", () => {
    const html = renderToStaticMarkup(
      <HomeRecommendations
        recommendations={[
          {
            id: "connect-first-rail",
            proposition: "Connect your first rail to accept payments — no code needed.",
            ctaLabel: "Connect a rail",
            ctaHref: "/connect",
          },
          {
            id: "setup-checkout",
            proposition: "Set up Checkout — embed a payment component and start accepting.",
            ctaLabel: "Get started",
            ctaHref: "/app/checkout",
          },
        ]}
      />,
    );
    expect(html).toContain("Connect your first rail to accept payments");
    expect(html).toContain("Set up Checkout");
    expect(html.match(/class="ps-reco__cta"/g)?.length).toBe(2);
    expect(html).toContain('href="/connect"');
    expect(html).toContain('href="/app/checkout"');
  });
});

describe("home: the Develop card never fabricates or leaks key material", () => {
  it("unconfigured state: states the truth, renders no key material at all", () => {
    const html = renderToStaticMarkup(<HomeDevelopCard keys={null} />);
    expect(html).toContain('data-testid="home-develop-empty"');
    expect(html).toContain("No API keys yet");
    expect(html).not.toContain('data-testid="home-develop-secret"');
    expect(html).not.toMatch(/pk_|sk_live|sk_test/); // never a fake key
    // The [Go to API keys] link still routes to the real surface.
    expect(html).toContain("Go to API keys");
    expect(html).toContain('href="/app/developers"');
  });

  it("configured state: publishable key + MASKED secret only (prefix + … + last-4)", () => {
    const html = renderToStaticMarkup(
      <HomeDevelopCard
        keys={{ publishable: "pk_test_51J2x", maskedSecret: "sk_test_…9f2c" }}
      />,
    );
    expect(html).toContain("pk_test_51J2x");
    expect(html).toContain("sk_test_…9f2c");
    // The masked form is the ONLY secret shape in the DOM.
    expect(html).not.toMatch(/sk_test_[A-Za-z0-9]{8,}(?!…)/);
  });
});

describe("home: Your overview renders the six metric cards with scaffold empties", () => {
  it("renders exactly the contract's six metrics", () => {
    const html = renderToStaticMarkup(<HomeOverviewMetrics />);
    for (const title of [
      "Payments",
      "Gross volume",
      "Net volume",
      "Failed payments",
      "New customers",
      "Top customers",
    ]) {
      expect(html).toContain(title);
    }
    expect(html.match(/class="ps-metric[" ]/g)?.length).toBe(6);
  });

  it("every metric renders its scaffold empty: axes visible + No data + how-to-fill link (contract 02 §8)", () => {
    const html = renderToStaticMarkup(<HomeOverviewMetrics />);
    // The chart scaffold renders on every card (axes = two scaffold lines).
    expect(html.match(/class="ps-metric__axis"/g)?.length).toBe(12);
    expect(html.match(/Chart scaffold — no data/g)?.length).toBe(6);
    expect(html.match(/>No data</g)?.length).toBe(6);
    // With no data there is NOTHING to stamp fresh and no delta to claim.
    expect(html).not.toContain("Updated");
    expect(html).not.toContain("ps-metric__delta");
    expect(html).not.toContain("ps-metric__value");
  });

  it("every metric carries a [More details] affordance to a real surface", () => {
    const html = renderToStaticMarkup(<HomeOverviewMetrics />);
    expect(html.match(/More details/g)?.length).toBe(6);
    expect(html).toContain('href="/app/payments"');
    expect(html).toContain('href="/app/reports"');
    expect(html).toContain('href="/app/customers"');
  });
});

describe("home: the honest composition claims no number anywhere", () => {
  it("the zero home renders no money amounts, no metrics, no keys (all honest empties)", () => {
    const html = homeMarkup();
    // Metric values are absent (only "No data" inside scaffolds).
    expect(html).not.toContain("ps-metric__value");
    // No balances table (the honest empty renders instead).
    expect(html).not.toContain('data-testid="balances-rails-table"');
    // No key material.
    expect(html).not.toMatch(/pk_|sk_/);
  });
});

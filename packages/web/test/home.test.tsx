import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { HomePage } from "../src/components/home-page";

/**
 * The public root is a PRODUCT page with claims that are true to the
 * repository's facts: the non-custodial economic-OS positioning, the five
 * journeys, the honest coverage summary derived from the recorded evidence,
 * and CTAs into the authenticated entry boundary and the coverage explorer.
 */

function renderHome(): string {
  return renderToStaticMarkup(<HomePage />);
}

describe("home page", () => {
  it("states the true product positioning", () => {
    const html = renderHome();
    expect(html).toContain("non-custodial economic operating system");
    expect(html).toContain("payment");
    expect(html).toContain("providers and rails you already use");
  });

  it("presents the five primary journeys", () => {
    const html = renderHome();
    for (const journey of [
      "Connect a provider",
      "Pay",
      "Collect",
      "Pay out",
      "Reconcile",
    ]) {
      expect(html).toContain(journey);
    }
    expect(html).toContain("UNKNOWN");
  });

  it("renders the honest coverage summary from the recorded evidence", () => {
    const html = renderHome();
    expect(html).toContain("Verified connections (test-mode)");
    expect(html).toContain("Stripe");
    expect(html).toContain("Paystack");
    expect(html).toContain("Flutterwave");
    expect(html).toContain("MTN MoMo — subscription key rejected (HTTP 401)");
    expect(html).toContain("Built, awaiting credentials");
    // The probe date is visible on the page.
    expect(html).toContain("2026-10-02 06:37 UTC");
  });

  it("links to the Command Center with the honest gate expectation set", () => {
    const html = renderHome();
    expect(html).toContain('href="/app"');
    expect(html).toContain("Open the Command Center");
    expect(html).toContain("requires authentication");
    expect(html).toContain("not yet available in this deployment phase");
    expect(html).toContain("honest gate");
  });

  it("links to the public surfaces", () => {
    const html = renderHome();
    expect(html).toContain('href="/capabilities"');
    expect(html).toContain('href="/security"');
    expect(html).toContain('href="/developers"');
  });

  it("carries the non-custody commitments", () => {
    const html = renderHome();
    expect(html).toContain("We never hold your credentials");
    expect(html).toContain("We never hold your money");
    expect(html).toContain("Every action carries evidence");
    expect(html).toContain("external observations");
  });
});

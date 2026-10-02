import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CapabilitiesPage } from "../src/components/capabilities-page";

/**
 * The honest coverage explorer: VERIFIED / BLOCKED / not-connected are
 * visually and semantically distinct, dates are visible, and MTN MoMo
 * renders as BLOCKED-unavailable. A provider must never appear connected
 * when the recorded evidence says otherwise.
 */

function renderCapabilities(): string {
  return renderToStaticMarkup(<CapabilitiesPage />);
}

/** React inserts comment markers between adjacent text nodes — strip them. */
function text(html: string): string {
  return html.replace(/<!--.*?-->/g, "");
}

describe("capabilities page", () => {
  it("distinguishes the three verified connections with verdicts and dates", () => {
    const html = text(renderCapabilities());
    expect(html).toContain("Verified connections");
    expect(html).toContain("Stripe");
    expect(html).toContain("VERIFIED · test-mode");
    expect(html).toContain("Paystack");
    expect(html).toContain("ELIGIBLE · test-mode");
    expect(html).toContain("Flutterwave");
    // The probe date is rendered as a <time> element with dateTime.
    const raw = renderCapabilities();
    expect(raw).toContain('dateTime="2026-10-02T06:37:38Z"');
    expect(html).toContain("2026-10-02 06:37 UTC");
  });

  it("renders certification numbers and recorded limitations", () => {
    const html = text(renderCapabilities());
    expect(html).toContain("13/13 scenarios passed");
    expect(html).toContain("9/9 scenarios passed");
    expect(html).toContain("P2-W2-003-cross-provider-conformance");
    expect(html).toContain("GHS not routable on this account");
    expect(html).toContain("no payout-execution family");
  });

  it("renders MTN MoMo as BLOCKED and unavailable — never connected", () => {
    const html = text(renderCapabilities());
    expect(html).toContain("Blocked at the provider gate");
    expect(html).toContain("MTN MoMo");
    expect(html).toContain("BLOCKED · unavailable");
    expect(html).toContain("subscription key rejected HTTP 401");
    expect(html).toContain("Access denied due to invalid subscription key");
    expect(html).toContain("re-probe pending a valid subscription key");
    // The blocked provider is not listed among the verified connections.
    const verifiedSection = html.slice(
      html.indexOf("Verified connections"),
      html.indexOf("Blocked at the provider gate"),
    );
    expect(verifiedSection).not.toContain("MTN MoMo");
  });

  it("renders the seven not-connected connectors honestly", () => {
    const html = text(renderCapabilities());
    expect(html).toContain("Built and certified — not connected");
    for (const label of [
      "PayPal Direct",
      "Rapyd",
      "dLocal",
      "Thunes",
      "Adyen",
      "Airwallex",
      "EBANX",
    ]) {
      expect(html).toContain(label);
    }
    const badges = html.match(/not connected · awaiting credentials/g);
    expect(badges?.length).toBe(7);
    expect(html).toContain("no credential exists in the vault");
  });

  it("renders the Stellar local rail as not-a-provider-connection", () => {
    const html = text(renderCapabilities());
    expect(html).toContain("The local rail");
    expect(html).toContain("Stellar (local rail)");
    expect(html).toContain("local rail · not a provider connection");
    expect(html).toContain("user-authorized session path");
  });

  it("renders the supporting services as non-rails with their verdicts", () => {
    const html = text(renderCapabilities());
    expect(html).toContain("Supporting platform services");
    expect(html).toContain("WhatsApp Cloud API");
    expect(html).toContain("SANDBOX-GRADE VERIFIED");
    expect(html).toContain("Resend");
    expect(html).toContain("UNVERIFIED-SEND");
    expect(html).toContain("OpenSanctions");
    expect(html).toContain("VERIFIED for screening integration");
  });

  it("shows the provenance records with their paths", () => {
    const html = text(renderCapabilities());
    expect(html).toContain(
      "spec/development-state/provider-probes-20261002.json",
    );
    expect(html).toContain(
      "spec/development-state/provider-rollout-20261002.json",
    );
    expect(html).toContain("provider-rollout-20261002@2026-10-02T14:30:00Z");
  });

  it("states the catalogue-is-not-authority law", () => {
    const html = text(renderCapabilities());
    expect(html).toContain("catalogue capability");
    expect(html).toContain("never executable authority");
  });
});

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SecurityPage } from "../src/components/security-page";

/**
 * The non-custody and session-isolation explanation. Every commitment on
 * the page must match the repository's structural facts — the tests pin
 * the claims so they cannot drift into marketing.
 */

function renderSecurity(): string {
  return renderToStaticMarkup(<SecurityPage />);
}

function text(html: string): string {
  return html.replace(/<!--.*?-->/g, "");
}

describe("security page", () => {
  it("states the non-custody model up front", () => {
    const html = text(renderSecurity());
    expect(html).toContain("not another");
    expect(html).toContain("place your money lives");
    expect(html).toContain("holds no funds");
  });

  it("carries the six structural commitments", () => {
    const html = text(renderSecurity());
    expect(html).toContain("PaySwap never holds your money");
    expect(html).toContain("PaySwap never holds your credentials");
    expect(html).toContain("Connections are user-authorized sessions");
    expect(html).toContain("Every financial action carries evidence");
    expect(html).toContain("UNKNOWN is never quietly resolved");
    expect(html).toContain("Fail-closed, everywhere");
  });

  it("explains custody of balances as external observation", () => {
    const html = text(renderSecurity());
    expect(html).toContain("external observations");
    expect(html).toContain("never PaySwap custody");
  });

  it("explains the credential model: vault references by name only", () => {
    const html = text(renderSecurity());
    expect(html).toContain("operator vault");
    expect(html).toContain("PROVIDER_&lt;NAME&gt;_CREDENTIAL_REF");
    expect(html).toContain("never enter Git");
  });

  it("explains session isolation and verified re-authentication", () => {
    const html = text(renderSecurity());
    expect(html).toContain("re-authenticate");
    expect(html).toContain("expired-session re-authentication");
    expect(html).toContain("never quietly continue with stale authority");
  });

  it("explains evidence lineage and UNKNOWN handling", () => {
    const html = text(renderSecurity());
    expect(html).toContain("authorization lineage");
    expect(html).toContain("evidence lineage");
    expect(html).toContain("renders UNKNOWN");
  });

  it("states the honest deployment-phase posture with links onward", () => {
    const html = text(renderSecurity());
    expect(html).toContain("not yet available in this deployment phase");
    expect(html).toContain("honest authentication gate");
    expect(html).toContain("not a demo with fake balances or a pretend login");
    expect(html).toContain('href="/capabilities"');
    expect(html).toContain('href="/developers"');
  });
});

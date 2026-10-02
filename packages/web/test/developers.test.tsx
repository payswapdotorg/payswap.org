import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DevelopersPage } from "../src/components/developers-page";
import { API_BASE_URL_ENV_VAR, type ApiRuntimeState } from "../src/lib/api";

/**
 * The developer entry point: the API is the authority, and the API runtime
 * configuration renders the honest state — "not configured" (with the env
 * var named, never a fabricated URL) when NEXT_PUBLIC_PAYSWAP_API_URL is
 * absent, the live base URL when it is present.
 */

function text(html: string): string {
  return html.replace(/<!--.*?-->/g, "");
}

const unconfigured: ApiRuntimeState = {
  configured: false,
  baseUrl: null,
  envVar: API_BASE_URL_ENV_VAR,
};

const configured: ApiRuntimeState = {
  configured: true,
  baseUrl: "https://api.payswap.example",
  envVar: API_BASE_URL_ENV_VAR,
};

describe("developers page", () => {
  it("states that the API is the authority and the site is one client", () => {
    const html = text(renderToStaticMarkup(<DevelopersPage api={unconfigured} />));
    expect(html).toContain("The API is the authority");
    expect(html).toContain("just one client of it");
    expect(html).toContain("financial truth is protocol-owned");
  });

  it("renders the honest unconfigured state — no fabricated URL", () => {
    const html = text(renderToStaticMarkup(<DevelopersPage api={unconfigured} />));
    expect(html).toContain("Not configured — and shown as such");
    expect(html).toContain(API_BASE_URL_ENV_VAR);
    expect(html).toContain("no API base URL to point you at");
    // No URL is invented when the environment is absent.
    expect(html).not.toMatch(/https:\/\/(?!payswap-web)/);
  });

  it("names the API/runtime project separation", () => {
    const html = text(renderToStaticMarkup(<DevelopersPage api={unconfigured} />));
    expect(html).toContain("payswap");
    expect(html).toContain("payswap-web");
    expect(html).toContain("packages/web");
    expect(html).toContain("never replaces or shadows the API runtime host");
  });

  it("renders the live base URL when configured", () => {
    const html = text(renderToStaticMarkup(<DevelopersPage api={configured} />));
    expect(html).toContain("Configured");
    expect(html).toContain("https://api.payswap.example");
    expect(html).not.toContain("Not configured");
  });

  it("documents the protocol guarantees", () => {
    const html = text(renderToStaticMarkup(<DevelopersPage api={configured} />));
    expect(html).toContain("One protocol path");
    expect(html).toContain("EXTERNAL_AMBIGUITY");
    expect(html).toContain("X-PaySwap-Outcome: unknown");
    expect(html).toContain("Idempotency by contract");
    expect(html).toContain("UNKNOWN stays UNKNOWN");
    expect(html).toContain("Signed webhooks");
    expect(html).toContain("Evidence on every effect");
  });

  it("points to where the contracts live", () => {
    const html = text(renderToStaticMarkup(<DevelopersPage api={configured} />));
    expect(html).toContain("packages/interfaces");
    expect(html).toContain("packages/api");
    expect(html).toContain("spec/architecture");
  });
});

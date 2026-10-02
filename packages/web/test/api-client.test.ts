import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import {
  API_BASE_URL_ENV_VAR,
  apiRuntimeState,
  buildApiUrl,
  fetchJson,
} from "../src/lib/api";

/**
 * The thin API client laws: the base URL comes only from
 * NEXT_PUBLIC_PAYSWAP_API_URL; absence yields the honest `unconfigured`
 * state everywhere; outcomes are discriminated (network-error / http-error
 * / ok) so no transport outcome can be mistaken for financial truth; and
 * nothing is ever fabricated or retried.
 */

describe("apiRuntimeState", () => {
  it("returns the honest unconfigured state without the env var", () => {
    const state = apiRuntimeState(undefined);
    expect(state).toEqual({
      configured: false,
      baseUrl: null,
      envVar: "NEXT_PUBLIC_PAYSWAP_API_URL",
    });
    expect(state.configured).toBe(false);
  });

  it("treats blank/whitespace values as unconfigured", () => {
    expect(apiRuntimeState("").configured).toBe(false);
    expect(apiRuntimeState("   ").configured).toBe(false);
  });

  it("trims and normalizes a configured base URL", () => {
    expect(apiRuntimeState("  https://api.payswap.example  ").baseUrl).toBe(
      "https://api.payswap.example",
    );
    expect(apiRuntimeState("https://api.payswap.example/").baseUrl).toBe(
      "https://api.payswap.example",
    );
    expect(
      apiRuntimeState("https://api.payswap.example///").baseUrl,
    ).toBe("https://api.payswap.example");
  });

  it("names the env var it reads", () => {
    expect(API_BASE_URL_ENV_VAR).toBe("NEXT_PUBLIC_PAYSWAP_API_URL");
    expect(apiRuntimeState(undefined).envVar).toBe(API_BASE_URL_ENV_VAR);
  });
});

describe("buildApiUrl", () => {
  it("refuses to build a URL when unconfigured", () => {
    expect(buildApiUrl(apiRuntimeState(undefined), "/v1/health")).toBeNull();
  });

  it("joins the base URL and path when configured", () => {
    const state = apiRuntimeState("https://api.payswap.example/");
    expect(buildApiUrl(state, "/v1/health")).toBe(
      "https://api.payswap.example/v1/health",
    );
  });

  it("rejects malformed paths loudly", () => {
    const state = apiRuntimeState("https://api.payswap.example");
    expect(() => buildApiUrl(state, "v1/health")).toThrow();
    expect(() => buildApiUrl(state, "//evil.example")).toThrow();
  });
});

describe("fetchJson", () => {
  let server: Server;
  let baseUrl: string;
  /** A port that is guaranteed closed (bound, noted, then released). */
  let deadPort: number;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/v1/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok", service: "test-harness" }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const sacrificial = createServer();
    await new Promise<void>((resolve) =>
      sacrificial.listen(0, "127.0.0.1", resolve),
    );
    deadPort = (sacrificial.address() as AddressInfo).port;
    await new Promise<void>((resolve) => sacrificial.close(() => resolve()));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterEach(() => {
    delete process.env[API_BASE_URL_ENV_VAR];
  });

  it("returns unconfigured (never a guess) when the env var is absent", async () => {
    delete process.env[API_BASE_URL_ENV_VAR];
    const result = await fetchJson("/v1/health");
    expect(result).toEqual({ status: "unconfigured" });
  });

  it("returns ok with the parsed payload against a live endpoint", async () => {
    process.env[API_BASE_URL_ENV_VAR] = baseUrl;
    const result = await fetchJson<{ status: string; service: string }>(
      "/v1/health",
    );
    expect(result).toEqual({
      status: "ok",
      data: { status: "ok", service: "test-harness" },
    });
  });

  it("surfaces non-2xx as http-error with the status code", async () => {
    process.env[API_BASE_URL_ENV_VAR] = baseUrl;
    const result = await fetchJson("/nope");
    expect(result).toEqual({ status: "http-error", statusCode: 404 });
  });

  it("surfaces transport failure as network-error — never as data", async () => {
    process.env[API_BASE_URL_ENV_VAR] = `http://127.0.0.1:${deadPort}`;
    const result = await fetchJson("/v1/health");
    expect(result.status).toBe("network-error");
    if (result.status === "network-error") {
      expect(typeof result.message).toBe("string");
      expect(result.message.length).toBeGreaterThan(0);
    }
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  describeCcApiOutcome,
  fetchApiCapabilities,
  fetchApiHealth,
  fetchCcApiEndpoint,
} from "../src/lib/cc/api-server";

/**
 * P3-W2-002 — the server-side API wiring: unconfigured is honest (never a
 * guessed URL), the API's OWN error envelope is parsed verbatim on http
 * errors, and success unwraps the response envelope. No fabricated states.
 */

const realFetch = globalThis.fetch;

function mockFetch(response: Response): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => response);
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("cc api server", () => {
  it("returns unconfigured when the env var is absent (never guessed)", async () => {
    const result = await fetchApiHealth(undefined);
    expect(result).toEqual({ status: "unconfigured" });
    expect(describeCcApiOutcome(result).headline).toMatch(/not configured/i);
  });

  it("returns unconfigured for a whitespace-only env value", async () => {
    const result = await fetchApiHealth("   ");
    expect(result.status).toBe("unconfigured");
  });

  it("carries the pinned API version header and revalidation", async () => {
    const fn = mockFetch(Response.json({ data: { status: "ok" }, meta: { schemaVersion: "x", requestId: "req_1" } }));
    const result = await fetchCcApiEndpoint<{ status: string }>("/v1/health", "https://api.example");
    expect(result.status).toBe("ok");
    const init = fn.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["x-payswap-api-version"]).toBe("2026-09-30");
    expect(headers.accept).toBe("application/json");
    expect((init as { next?: { revalidate?: number } }).next?.revalidate).toBe(30);
  });

  it("parses the API's error envelope verbatim on an http error", async () => {
    mockFetch(
      new Response(
        JSON.stringify({
          error: {
            code: "auth.session_token_required",
            category: "AUTHORIZATION",
            message: "SESSION authentication requires the session token",
          },
          meta: { schemaVersion: "2026-09-30", requestId: "req_2" },
        }),
        { status: 403 },
      ),
    );
    const result = await fetchApiHealth("https://api.example");
    expect(result.status).toBe("http-error");
    if (result.status === "http-error") {
      expect(result.statusCode).toBe(403);
      expect(result.error?.category).toBe("AUTHORIZATION");
      expect(result.error?.code).toBe("auth.session_token_required");
      expect(result.error?.message).toMatch(/session token/);
    }
    const narrative = describeCcApiOutcome(result);
    expect(narrative.headline).toBe("The API answered: HTTP 403");
    expect(narrative.detail).toMatch(/AUTHORIZATION/);
  });

  it("surfaces network errors as transport outcomes, never financial states", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const result = await fetchApiCapabilities("https://api.example");
    expect(result.status).toBe("network-error");
    expect(describeCcApiOutcome(result).detail).toMatch(/ECONNREFUSED/);
    expect(describeCcApiOutcome(result).detail).toMatch(/network outcome, not a financial state/);
  });

  it("unwraps the response envelope for capabilities", async () => {
    mockFetch(
      Response.json({
        data: {
          capabilities: [
            {
              capabilityId: "api.developer_surface",
              description: "The developer REST surface itself.",
              state: "AVAILABLE",
              source: "REACHABLE",
              effectiveAvailability: "AVAILABLE",
            },
          ],
        },
        meta: { schemaVersion: "2026-09-30", requestId: "req_3" },
      }),
    );
    const result = await fetchApiCapabilities("https://api.example");
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.capabilities).toHaveLength(1);
      expect(result.data.capabilities[0]?.capabilityId).toBe("api.developer_surface");
      expect(result.requestId).toBe("req_3");
    }
  });

  it("tolerates a non-enveloped success body without inventing fields", async () => {
    mockFetch(Response.json({ status: "ok" }));
    const result = await fetchApiHealth("https://api.example");
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data).toEqual({ status: "ok" });
    }
  });
});

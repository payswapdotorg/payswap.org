import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dynamic as healthRouteDynamic, GET } from "@/app/api/health/route";

/**
 * Health/readiness hardening laws (Work Order P3-W1-003):
 *
 * - LIVENESS is the route answering — it is reported honestly and separately
 *   from readiness; there is no deeper process to fake.
 * - READINESS = "can this deployment reach the authoritative PaySwap API
 *   runtime (GET /v1/health)?" — probed live per request, bounded by a
 *   timeout.
 * - UNCONFIGURED (NEXT_PUBLIC_PAYSWAP_API_URL absent) ⇒ readiness UNKNOWN —
 *   never faked success, never counted as failure (UNKNOWN ≠ FAILED).
 * - Probe failures (non-2xx / network error / timeout) render an honest
 *   DEGRADED state: body says degraded, HTTP says 503 — never "ok".
 * - Build identity passes through verbatim (null when unbaked — never
 *   fabricated).
 *
 * All probes are stubbed: no network, no API runtime required.
 */

const API_URL_ENV = "NEXT_PUBLIC_PAYSWAP_API_URL";
const BUILD_ID_ENV = "PAYSWAP_WEB_BUILD_ID";
const BUILD_COMMIT_ENV = "PAYSWAP_WEB_BUILD_COMMIT";
const PROBE_TIMEOUT_ENV = "PAYSWAP_WEB_HEALTH_PROBE_TIMEOUT_MS";

const SAVED: Record<string, string | undefined> = {};

function saveEnv(name: string): void {
  SAVED[name] = process.env[name];
}

function restoreEnv(name: string): void {
  const value = SAVED[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

beforeEach(() => {
  for (const name of [API_URL_ENV, BUILD_ID_ENV, BUILD_COMMIT_ENV, PROBE_TIMEOUT_ENV]) {
    saveEnv(name);
    delete process.env[name];
  }
});

afterEach(() => {
  for (const name of [API_URL_ENV, BUILD_ID_ENV, BUILD_COMMIT_ENV, PROBE_TIMEOUT_ENV]) {
    restoreEnv(name);
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

interface HealthBody {
  status: string;
  service: string;
  build: { id: string | null; commit: string | null };
  liveness: { state: string; note: string };
  readiness: {
    state: "ready" | "degraded" | "unknown";
    apiRuntime: {
      baseUrl: string | null;
      configured: boolean;
      envVar: string;
      note: string;
      probe: {
        path: string;
        timeoutMs: number;
        outcome: string;
        statusCode: number | null;
        message: string | null;
      };
    };
  };
  checkedAt: string;
}

async function callHealth(): Promise<{ status: number; body: HealthBody }> {
  const response = await GET();
  const body = (await response.json()) as HealthBody;
  return { status: response.status, body };
}

function jsonResponse(status: number): Response {
  return new Response(JSON.stringify({ status: "ok" }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("health route — route-segment discipline", () => {
  it("is dynamic (never statically cached — health must answer per request)", () => {
    expect(healthRouteDynamic).toBe("force-dynamic");
  });
});

describe("health route — liveness vs readiness (unconfigured = UNKNOWN, not failure)", () => {
  it("answers 200 with readiness UNKNOWN when the API base URL is unconfigured", async () => {
    const { status, body } = await callHealth();
    expect(status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.service).toBe("@payswap/web");
    expect(body.liveness.state).toBe("alive");
    expect(body.readiness.state).toBe("unknown");
    expect(body.readiness.apiRuntime.configured).toBe(false);
    expect(body.readiness.apiRuntime.baseUrl).toBeNull();
    expect(body.readiness.apiRuntime.envVar).toBe("NEXT_PUBLIC_PAYSWAP_API_URL");
    expect(body.readiness.apiRuntime.probe.outcome).toBe("not-attempted");
    expect(body.readiness.apiRuntime.probe.message).toContain("UNKNOWN is not failure");
  });

  it("treats a blank API base URL as unconfigured (honest, never a guess)", async () => {
    process.env[API_URL_ENV] = "   ";
    const { status, body } = await callHealth();
    expect(status).toBe(200);
    expect(body.readiness.state).toBe("unknown");
    expect(body.readiness.apiRuntime.probe.outcome).toBe("not-attempted");
  });

  it("reports build identity verbatim and null when unbaked (never fabricated)", async () => {
    const bare = await callHealth();
    expect(bare.body.build).toEqual({ id: null, commit: null });

    process.env[BUILD_ID_ENV] = "abcdef0123456789";
    process.env[BUILD_COMMIT_ENV] = "0123456789abcdef0123456789abcdef01234567";
    const baked = await callHealth();
    expect(baked.body.build).toEqual({
      id: "abcdef0123456789",
      commit: "0123456789abcdef0123456789abcdef01234567",
    });
  });

  it("never probes the API runtime when unconfigured (no fetch side effects)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await callHealth();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("emits no-store so no layer caches a stale health verdict", async () => {
    const response = await GET();
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("health route — readiness probe outcomes (configured)", () => {
  const API_BASE = "https://api.payswap.example";

  it("is READY when the API runtime answers GET /v1/health with 2xx", async () => {
    process.env[API_URL_ENV] = API_BASE;
    const fetchSpy = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(200),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const { status, body } = await callHealth();
    expect(status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.readiness.state).toBe("ready");
    expect(body.readiness.apiRuntime.configured).toBe(true);
    expect(body.readiness.apiRuntime.baseUrl).toBe(API_BASE);
    expect(body.readiness.apiRuntime.probe.outcome).toBe("ok");
    // ok carries no code from the transport — null, never an assumed 200.
    expect(body.readiness.apiRuntime.probe.statusCode).toBeNull();
    expect(body.readiness.apiRuntime.probe.message).toBeNull();
    expect(body.readiness.apiRuntime.probe.path).toBe("/v1/health");

    // The probe went through the thin transport (lib/api.ts fetchJson) to
    // the API runtime's own health endpoint, bounded by an abort signal.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(String(url)).toBe(`${API_BASE}/v1/health`);
    expect(init?.signal ?? (init as { signal?: AbortSignal } | undefined)?.signal)
      .toBeInstanceOf(AbortSignal);
  });

  it("is DEGRADED (HTTP 503) when the API runtime answers non-2xx — never faked success", async () => {
    process.env[API_URL_ENV] = API_BASE;
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(503)));

    const { status, body } = await callHealth();
    expect(status).toBe(503);
    expect(body.status).toBe("degraded");
    expect(body.liveness.state).toBe("alive"); // liveness stays honest
    expect(body.readiness.state).toBe("degraded");
    expect(body.readiness.apiRuntime.probe.outcome).toBe("http-error");
    expect(body.readiness.apiRuntime.probe.statusCode).toBe(503);
    expect(body.readiness.apiRuntime.probe.message).toContain("503");
  });

  it("is DEGRADED (HTTP 503) on transport failure, carrying the verbatim message", async () => {
    process.env[API_URL_ENV] = API_BASE;
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:443");
    }));

    const { status, body } = await callHealth();
    expect(status).toBe(503);
    expect(body.readiness.state).toBe("degraded");
    expect(body.readiness.apiRuntime.probe.outcome).toBe("network-error");
    expect(body.readiness.apiRuntime.probe.statusCode).toBeNull();
    expect(body.readiness.apiRuntime.probe.message).toContain("ECONNREFUSED");
  });

  it("is DEGRADED (HTTP 503) when the probe exceeds its bounded timeout", async () => {
    process.env[API_URL_ENV] = API_BASE;
    process.env[PROBE_TIMEOUT_ENV] = "300"; // min bound is 250 ms — fast test
    // A fetch that never settles on its own; only the abort signal ends it.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: unknown, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new Error("fetch aborted (as the real fetch would be)"));
            });
          }),
      ),
    );

    const { status, body } = await callHealth();
    expect(status).toBe(503);
    expect(body.readiness.state).toBe("degraded");
    expect(body.readiness.apiRuntime.probe.outcome).toBe("timeout");
    expect(body.readiness.apiRuntime.probe.statusCode).toBeNull();
    expect(body.readiness.apiRuntime.probe.timeoutMs).toBe(300);
    expect(body.readiness.apiRuntime.probe.message).toContain("300");
  });
});

describe("health route — probe timeout budget discipline", () => {
  it("defaults to 5000 ms when the timeout env var is unset", async () => {
    process.env[API_URL_ENV] = "https://api.payswap.example";
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200)));
    const { body } = await callHealth();
    expect(body.readiness.apiRuntime.probe.timeoutMs).toBe(5000);
  });

  it("rejects out-of-bound timeout values back to the 5000 ms default (honest, bounded)", async () => {
    process.env[API_URL_ENV] = "https://api.payswap.example";
    process.env[PROBE_TIMEOUT_ENV] = "999999";
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200)));
    const { body } = await callHealth();
    expect(body.readiness.apiRuntime.probe.timeoutMs).toBe(5000);
  });

  it("rejects non-numeric timeout values back to the 5000 ms default", async () => {
    process.env[API_URL_ENV] = "https://api.payswap.example";
    process.env[PROBE_TIMEOUT_ENV] = "soon";
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200)));
    const { body } = await callHealth();
    expect(body.readiness.apiRuntime.probe.timeoutMs).toBe(5000);
  });

  it("always answers well inside the function-duration budget: probe + render bounded", async () => {
    // The functional bound: even a full-timeout probe must leave the route
    // answering in < 10 s (hobby default). We assert the configured bound is
    // < 10 s and that a timeout path actually completes near its bound.
    process.env[API_URL_ENV] = "https://api.payswap.example";
    process.env[PROBE_TIMEOUT_ENV] = "300";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: unknown, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new Error("aborted"));
            });
          }),
      ),
    );
    const startedAt = Date.now();
    const { body } = await callHealth();
    const elapsed = Date.now() - startedAt;
    expect(body.readiness.apiRuntime.probe.outcome).toBe("timeout");
    expect(elapsed).toBeLessThan(5000);
    expect(body.readiness.apiRuntime.probe.timeoutMs).toBeLessThan(10000);
  });
});

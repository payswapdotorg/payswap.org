import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildHealthReport,
  deriveStatus,
  probeApiRuntime,
  type DependencyCheck,
} from "../src/lib/health";
import { GET } from "../src/app/api/health/route";

/**
 * P3-W1-003 — the liveness/readiness CONTRACT for the public web surface
 * health endpoint. The doctrine under test: NEVER FAKE-HEALTHY.
 *
 * - liveness: answering proves alive (constant, cannot be otherwise);
 * - every dependency check is gated by env presence: absent binding →
 *   `skipped` (degraded), never a silent pass;
 * - an answered dependency is classified on the honest scale
 *   (2xx healthy / 4xx reachable-but-UNKNOWN / 5xx unhealthy) — an
 *   ambiguous answer is NEVER converted into healthy or failed
 *   (AGENTS.md rule 4: UNKNOWN is not FAILED);
 * - only a FAILED configured dependency yields HTTP 503 (unready);
 * - build identity is reported null when not baked — never fabricated.
 */

const healthyCheck = (overrides?: Partial<DependencyCheck>): DependencyCheck => ({
  dependency: "apiRuntime",
  envVar: "NEXT_PUBLIC_PAYSWAP_API_URL",
  configured: true,
  state: "healthy",
  detail: "answered HTTP 200 on /v1/health",
  answeredStatus: 200,
  ...overrides,
});

describe("deriveStatus", () => {
  it("is ok only when every check is healthy", () => {
    expect(deriveStatus([healthyCheck()])).toBe("ok");
  });

  it("is degraded when a check is skipped (env-gated) or ambiguous", () => {
    expect(deriveStatus([healthyCheck({ state: "skipped", configured: false })])).toBe("degraded");
    expect(deriveStatus([healthyCheck({ state: "reachable", answeredStatus: 400 })])).toBe("degraded");
    expect(
      deriveStatus([
        healthyCheck(),
        healthyCheck({ state: "skipped", configured: false }),
      ]),
    ).toBe("degraded");
  });

  it("is unready when any check is unhealthy or unreachable", () => {
    expect(deriveStatus([healthyCheck(), healthyCheck({ state: "unhealthy", answeredStatus: 503 })])).toBe(
      "unready",
    );
    expect(deriveStatus([healthyCheck({ state: "unreachable" })])).toBe("unready");
  });
});

describe("probeApiRuntime (env-gated, honest scale)", () => {
  it("skips — never guesses — when the binding env var is absent", async () => {
    const check = await probeApiRuntime(
      { configured: false, baseUrl: null, envVar: "NEXT_PUBLIC_PAYSWAP_API_URL" },
      vi.fn(),
    );
    expect(check.state).toBe("skipped");
    expect(check.configured).toBe(false);
    expect(check.detail).toMatch(/gated by env presence/i);
  });

  it("classifies a 2xx answer as healthy", async () => {
    const check = await probeApiRuntime(
      { configured: true, baseUrl: "https://api.example", envVar: "NEXT_PUBLIC_PAYSWAP_API_URL" },
      vi.fn(async () => new Response("{}", { status: 200 })),
    );
    expect(check.state).toBe("healthy");
    expect(check.answeredStatus).toBe(200);
  });

  it("classifies a 4xx answer as reachable — the dependency's internal health stays UNKNOWN, never guessed", async () => {
    const check = await probeApiRuntime(
      { configured: true, baseUrl: "https://api.example", envVar: "NEXT_PUBLIC_PAYSWAP_API_URL" },
      vi.fn(async () => new Response("{}", { status: 400 })),
    );
    expect(check.state).toBe("reachable");
    expect(check.answeredStatus).toBe(400);
    expect(check.detail).toMatch(/UNKNOWN/i);
    expect(check.detail).not.toMatch(/healthy|failed/i);
  });

  it("classifies a 5xx answer as unhealthy", async () => {
    const check = await probeApiRuntime(
      { configured: true, baseUrl: "https://api.example", envVar: "NEXT_PUBLIC_PAYSWAP_API_URL" },
      vi.fn(async () => new Response("{}", { status: 503 })),
    );
    expect(check.state).toBe("unhealthy");
    expect(check.answeredStatus).toBe(503);
  });

  it("surfaces a network error verbatim as unreachable (transport outcome, not a financial state)", async () => {
    const check = await probeApiRuntime(
      { configured: true, baseUrl: "https://api.example", envVar: "NEXT_PUBLIC_PAYSWAP_API_URL" },
      vi.fn(async () => {
        throw new Error("connect ECONNREFUSED api.example:443");
      }),
    );
    expect(check.state).toBe("unreachable");
    expect(check.detail).toContain("connect ECONNREFUSED api.example:443");
    expect(check.detail).toMatch(/not a financial state/);
  });
});

describe("buildHealthReport", () => {
  const fetchOk = vi.fn(async () => new Response("{}", { status: 200 }));

  it("reports degraded + not ready (HTTP 200) when the API runtime is unconfigured — never fake-healthy", async () => {
    const { report, httpStatus } = await buildHealthReport({
      apiBaseUrlEnv: undefined,
      buildIdEnv: undefined,
      buildCommitEnv: undefined,
      fetcher: vi.fn(),
    });
    expect(report.status).toBe("degraded");
    expect(report.readiness.ready).toBe(false);
    expect(report.readiness.checks[0]?.state).toBe("skipped");
    expect(report.build).toEqual({ id: null, commit: null });
    expect(report.liveness).toBe("alive");
    expect(httpStatus).toBe(200);
    expect(fetchOk).not.toHaveBeenCalled();
  });

  it("treats a whitespace-only binding env value as unconfigured (never guessed)", async () => {
    const { report } = await buildHealthReport({
      apiBaseUrlEnv: "   ",
      buildIdEnv: "abc",
      buildCommitEnv: "def",
      fetcher: vi.fn(),
    });
    expect(report.status).toBe("degraded");
    expect(report.readiness.checks[0]?.configured).toBe(false);
  });

  it("reports ok + ready (HTTP 200) when the configured dependency is healthy", async () => {
    const { report, httpStatus } = await buildHealthReport({
      apiBaseUrlEnv: "https://api.example",
      buildIdEnv: "build123",
      buildCommitEnv: "sha123",
      fetcher: fetchOk,
    });
    expect(report.status).toBe("ok");
    expect(report.readiness.ready).toBe(true);
    expect(report.build).toEqual({ id: "build123", commit: "sha123" });
    expect(httpStatus).toBe(200);
  });

  it("reports degraded (HTTP 200) when the dependency answered ambiguously", async () => {
    const { report, httpStatus } = await buildHealthReport({
      apiBaseUrlEnv: "https://api.example",
      buildIdEnv: undefined,
      buildCommitEnv: undefined,
      fetcher: vi.fn(async () => new Response("{}", { status: 401 })),
    });
    expect(report.status).toBe("degraded");
    expect(report.readiness.ready).toBe(false);
    expect(httpStatus).toBe(200);
  });

  it("reports unready + HTTP 503 when the configured dependency is unhealthy", async () => {
    const { report, httpStatus } = await buildHealthReport({
      apiBaseUrlEnv: "https://api.example",
      buildIdEnv: undefined,
      buildCommitEnv: undefined,
      fetcher: vi.fn(async () => new Response("{}", { status: 500 })),
    });
    expect(report.status).toBe("unready");
    expect(report.readiness.ready).toBe(false);
    expect(httpStatus).toBe(503);
  });

  it("reports unready + HTTP 503 on a network failure against the configured dependency", async () => {
    const { report, httpStatus } = await buildHealthReport({
      apiBaseUrlEnv: "https://api.example",
      buildIdEnv: undefined,
      buildCommitEnv: undefined,
      fetcher: vi.fn(async () => {
        throw new Error("fetch failed");
      }),
    });
    expect(report.status).toBe("unready");
    expect(httpStatus).toBe(503);
  });

  it("probes the API runtime's own health path with a bounded timeout", async () => {
    const fetcher = vi.fn(async () => new Response("{}", { status: 200 }));
    await buildHealthReport({
      apiBaseUrlEnv: "https://api.example/",
      buildIdEnv: undefined,
      buildCommitEnv: undefined,
      fetcher,
    });
    expect(fetcher).toHaveBeenCalledWith("https://api.example/v1/health", {
      method: "GET",
      headers: { accept: "application/json" },
      signal: expect.any(AbortSignal),
    });
  });
});

describe("GET /api/health (route: ambient wiring)", () => {
  const realFetch = globalThis.fetch;
  const savedEnv: Record<string, string | undefined> = {};

  function setEnv(name: string, value: string | undefined): void {
    savedEnv[name] = process.env[name];
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }

  beforeEach(() => {
    setEnv("NEXT_PUBLIC_PAYSWAP_API_URL", undefined);
    setEnv("PAYSWAP_WEB_BUILD_ID", undefined);
    setEnv("PAYSWAP_WEB_BUILD_COMMIT", undefined);
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
      delete savedEnv[name];
    }
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("answers 200 with no-store and honest degraded state when nothing is configured", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as {
      status: string;
      liveness: string;
      readiness: { ready: boolean };
      build: { id: string | null; commit: string | null };
      checkedAt: string;
    };
    expect(body.status).toBe("degraded");
    expect(body.liveness).toBe("alive");
    expect(body.readiness.ready).toBe(false);
    expect(body.build).toEqual({ id: null, commit: null });
    expect(typeof body.checkedAt).toBe("string");
    expect(Number.isNaN(Date.parse(body.checkedAt))).toBe(false);
  });

  it("probes the ambient API runtime binding and reports ok on a healthy answer", async () => {
    setEnv("NEXT_PUBLIC_PAYSWAP_API_URL", "https://api.example");
    globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const response = await GET();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; readiness: { ready: boolean } };
    expect(body.status).toBe("ok");
    expect(body.readiness.ready).toBe(true);
  });

  it("answers 503 (unready) when the configured dependency fails — never fake-healthy", async () => {
    setEnv("NEXT_PUBLIC_PAYSWAP_API_URL", "https://api.example");
    globalThis.fetch = vi.fn(async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    const response = await GET();
    expect(response.status).toBe(503);
    const body = (await response.json()) as {
      status: string;
      readiness: { checks: { state: string; detail: string }[] };
    };
    expect(body.status).toBe("unready");
    expect(body.readiness.checks[0]?.state).toBe("unreachable");
    expect(body.readiness.checks[0]?.detail).toContain("connection refused");
  });
});

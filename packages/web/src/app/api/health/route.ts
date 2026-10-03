/**
 * Health/readiness endpoint for the PaySwap public web surface
 * (hardened in Work Order P3-W1-003).
 *
 * Two distinct signals, never conflated:
 *
 * - LIVENESS: the fact that this route answers at all. On serverless there
 *   is no deeper process to restart — a response IS the liveness proof, and
 *   it is rendered as the top-level `status` field ("ok"/"degraded") plus
 *   HTTP 200/503. Liveness is never faked: if the route cannot answer,
 *   nothing is here to fake it.
 *
 * - READINESS: can this deployment actually reach the authoritative PaySwap
 *   API runtime? Resolved honestly per request, THROUGH the thin transport
 *   (`src/lib/api.ts` fetchJson — the single place that knows how to reach
 *   the API; the health route adds no parallel transport):
 *     * NEXT_PUBLIC_PAYSWAP_API_URL unconfigured → readiness "unknown"
 *       (cannot be determined — UNKNOWN is NOT failure, INV-X01 doctrine);
 *     * configured → one bounded probe of GET /v1/health. ok → "ready";
 *       non-2xx, transport failure or timeout → "degraded" with the
 *       verbatim reason — never faked as success.
 *
 * This endpoint carries NO financial state (the authoritative PaySwap API
 * owns all financial truth); the probe reports TRANSPORT health only.
 *
 * The build id and commit are baked at build time by next.config.ts; when
 * unavailable they are reported as null — never fabricated.
 */

import { API_BASE_URL_ENV_VAR, apiRuntimeState, fetchJson } from "@/lib/api";

export const dynamic = "force-dynamic";

/** The authoritative API runtime's own health path (packages/api http.ts). */
const READINESS_PROBE_PATH = "/v1/health";

/**
 * Env var NAME (value supplied per environment, never in git): bounds the
 * readiness probe so /api/health always answers well inside the function
 * duration budget. Optional; default 5000 ms.
 */
const PROBE_TIMEOUT_ENV_VAR = "PAYSWAP_WEB_HEALTH_PROBE_TIMEOUT_MS" as const;
const DEFAULT_PROBE_TIMEOUT_MS = 5000;
const MIN_PROBE_TIMEOUT_MS = 250;
const MAX_PROBE_TIMEOUT_MS = 9000;

function resolveProbeTimeoutMs(raw: string | undefined): number {
  const parsed = typeof raw === "string" ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isNaN(parsed)) {
    return DEFAULT_PROBE_TIMEOUT_MS;
  }
  if (parsed < MIN_PROBE_TIMEOUT_MS || parsed > MAX_PROBE_TIMEOUT_MS) {
    return DEFAULT_PROBE_TIMEOUT_MS;
  }
  return parsed;
}

/** What actually happened on the readiness probe — verbatim, never guessed. */
type ProbeOutcome = "ok" | "http-error" | "network-error" | "timeout" | "not-attempted";

interface ProbeReport {
  readonly outcome: ProbeOutcome;
  readonly statusCode: number | null;
  readonly message: string | null;
}

interface ReadinessReport {
  readonly state: "ready" | "degraded" | "unknown";
  readonly apiRuntime: {
    readonly baseUrl: string | null;
    readonly configured: boolean;
    readonly envVar: string;
    readonly note: string;
    readonly probe: {
      readonly path: string;
      readonly timeoutMs: number;
      readonly outcome: ProbeOutcome;
      readonly statusCode: number | null;
      readonly message: string | null;
    };
  };
}

/**
 * Probe the API runtime's own health endpoint once, bounded by a timeout,
 * through the thin transport (fetchJson). The union's honest outcomes map
 * 1:1 to the probe report; a timeout is detected by the signal having
 * aborted (the bounded-budget outcome), not by string-sniffing errors.
 * The probe reports transport reachability only — it never interprets any
 * financial state.
 */
async function probeApiRuntime(timeoutMs: number): Promise<ProbeReport> {
  const signal = AbortSignal.timeout(timeoutMs);
  const result = await fetchJson<unknown>(READINESS_PROBE_PATH, { signal });
  switch (result.status) {
    case "ok":
      // The transport answered 2xx; the union carries no code — null, not
      // an assumed 200 (nothing is fabricated, not even a status code).
      return { outcome: "ok", statusCode: null, message: null };
    case "http-error":
      return {
        outcome: "http-error",
        statusCode: result.statusCode,
        message: `GET ${READINESS_PROBE_PATH} answered HTTP ${result.statusCode} on the API runtime`,
      };
    case "network-error": {
      if (signal.aborted) {
        return {
          outcome: "timeout",
          statusCode: null,
          message: `probe did not complete within ${timeoutMs} ms`,
        };
      }
      return {
        outcome: "network-error",
        statusCode: null,
        message: result.message,
      };
    }
    default:
      return {
        outcome: "network-error",
        statusCode: null,
        message: `unexpected transport outcome: ${JSON.stringify(result)}`,
      };
  }
}

export async function GET() {
  const apiBaseUrl = process.env[API_BASE_URL_ENV_VAR]?.trim() || null;
  const runtimeState = apiRuntimeState(process.env[API_BASE_URL_ENV_VAR]);
  const timeoutMs = resolveProbeTimeoutMs(process.env[PROBE_TIMEOUT_ENV_VAR]);

  let readiness: ReadinessReport;
  if (runtimeState.configured && runtimeState.baseUrl !== null) {
    const probe = await probeApiRuntime(timeoutMs);
    readiness = {
      state: probe.outcome === "ok" ? "ready" : "degraded",
      apiRuntime: {
        baseUrl: apiBaseUrl,
        configured: true,
        envVar: API_BASE_URL_ENV_VAR,
        note: "referenced by name only — no value is stored in git",
        probe: {
          path: READINESS_PROBE_PATH,
          timeoutMs,
          outcome: probe.outcome,
          statusCode: probe.statusCode,
          message: probe.message,
        },
      },
    };
  } else {
    readiness = {
      state: "unknown",
      apiRuntime: {
        baseUrl: null,
        configured: false,
        envVar: API_BASE_URL_ENV_VAR,
        note: "referenced by name only — no value is stored in git; without the API base URL readiness cannot be determined, and UNKNOWN is not failure",
        probe: {
          path: READINESS_PROBE_PATH,
          timeoutMs,
          outcome: "not-attempted",
          statusCode: null,
          message: "NEXT_PUBLIC_PAYSWAP_API_URL is not configured — readiness is UNKNOWN, and UNKNOWN is not failure",
        },
      },
    };
  }

  const alive = true; // this route answering IS the liveness proof
  const status = alive && readiness.state !== "degraded" ? "ok" : "degraded";
  const httpStatus = status === "ok" ? 200 : 503;

  return Response.json(
    {
      status,
      service: "@payswap/web",
      role: "public product surface — a consumer of the authoritative PaySwap API",
      build: {
        id: process.env.PAYSWAP_WEB_BUILD_ID ?? null,
        commit: process.env.PAYSWAP_WEB_BUILD_COMMIT ?? null,
      },
      liveness: {
        state: "alive",
        note: "this route answering is the liveness proof (serverless: no deeper process to restart)",
      },
      readiness,
      checkedAt: new Date().toISOString(),
    },
    {
      status: httpStatus,
      headers: { "cache-control": "no-store" },
    },
  );
}

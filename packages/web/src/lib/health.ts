/**
 * Health/readiness probe model for the PaySwap public web surface
 * (Work Order P3-W1-003 — infrastructure hardening).
 *
 * Law (honesty doctrine, AGENTS.md rule 4 + the P3-W1-003 acceptance
 * criteria): the health endpoint NEVER reports fake-healthy. Every
 * dependency check is BOUND to a real observation and GATED BY ENV
 * PRESENCE — a dependency whose binding env var is absent is reported
 * `skipped` with the reason, never silently passed; a dependency that
 * answered is classified on a scale that never converts an ambiguous
 * answer into healthy or failed:
 *
 *   - 2xx            → healthy   (the dependency confirmed itself up)
 *   - 4xx            → reachable (it answered; the deployed PaySwap API
 *                       authenticates EVERY endpoint, so a 400/401/403 is
 *                       the honest auth-required answer — the transport
 *                       works, the web app holds no API session, and the
 *                       dependency's internal health stays UNKNOWN,
 *                       never guessed)
 *   - 5xx            → unhealthy (the dependency itself reported failure)
 *   - network error  → unreachable (transport failed — verbatim message)
 *
 * This module is PURE and INJECTABLE (env + fetcher + clock): the route
 * handler wires the ambient environment, tests inject theirs — the same
 * doctrine as `@/lib/api` (apiRuntimeState) and `@/lib/cc/api-server`.
 *
 * The web surface itself holds NO financial state: this probe observes
 * TRANSPORT + dependency posture only. It can never speak for the
 * authoritative API's financial health.
 */

import { apiRuntimeState } from "@/lib/api";
import type { ApiRuntimeState } from "@/lib/api";

/** Probe timeout for the dependency fetch (milliseconds). */
export const HEALTH_PROBE_TIMEOUT_MS = 5_000;

/** The path probed on the API runtime (its own health endpoint). */
const API_HEALTH_PATH = "/v1/health";

/** What a single dependency check concluded. */
export type DependencyCheckState =
  | "healthy"
  | "reachable"
  | "unhealthy"
  | "unreachable"
  | "skipped";

export interface DependencyCheck {
  /** The dependency this check observes. */
  readonly dependency: "apiRuntime";
  /** The env var that gates the check (referenced by name — never a value). */
  readonly envVar: string;
  readonly configured: boolean;
  readonly state: DependencyCheckState;
  /** Honest, human-readable outcome detail — verbatim, never fabricated. */
  readonly detail: string;
  /** The HTTP status the dependency answered with, when it answered. */
  readonly answeredStatus?: number;
}

export type HealthStatus = "ok" | "degraded" | "unready";

export interface HealthReport {
  /** Overall: ok (all checks healthy) | degraded (skipped/ambiguous) | unready (failed check). */
  readonly status: HealthStatus;
  readonly service: "@payswap/web";
  readonly role: "public product surface — a consumer of the authoritative PaySwap API";
  /** Answering this probe at all proves the process is alive. */
  readonly liveness: "alive";
  readonly readiness: {
    /** True ONLY when every dependency check executed and passed. */
    readonly ready: boolean;
    readonly checks: readonly DependencyCheck[];
  };
  readonly build: {
    readonly id: string | null;
    readonly commit: string | null;
  };
  readonly checkedAt: string;
}

/** The fetcher shape (injectable; matches global fetch for GET + timeout). */
export type ProbeFetcher = (
  url: string,
  init: { readonly method: "GET"; readonly headers: Record<string, string>; readonly signal: AbortSignal },
) => Promise<Response>;

export interface HealthProbeInputs {
  /** Raw NEXT_PUBLIC_PAYSWAP_API_URL value (undefined = unconfigured). */
  readonly apiBaseUrlEnv: string | undefined;
  /** Raw PAYSWAP_WEB_BUILD_ID (baked by next.config.ts; null-safe). */
  readonly buildIdEnv: string | undefined;
  /** Raw PAYSWAP_WEB_BUILD_COMMIT (baked by next.config.ts; null-safe). */
  readonly buildCommitEnv: string | undefined;
  readonly fetcher: ProbeFetcher;
  /** Injectable clock — the report is a point-in-time observation. */
  readonly now?: () => Date;
}

function trimmedOrUndefined(value: string | undefined): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Probe the authoritative API runtime (the web surface's one hard
 * dependency). Gated by env presence: no URL → `skipped`, never a guess.
 */
export async function probeApiRuntime(
  runtime: ApiRuntimeState,
  fetcher: ProbeFetcher,
): Promise<DependencyCheck> {
  const base = {
    dependency: "apiRuntime" as const,
    envVar: "NEXT_PUBLIC_PAYSWAP_API_URL",
    configured: runtime.configured,
  };
  if (!runtime.configured || runtime.baseUrl === null) {
    return {
      ...base,
      configured: false,
      state: "skipped",
      detail:
        "NEXT_PUBLIC_PAYSWAP_API_URL is not set for this deployment — the check is gated by env presence and is skipped, never faked. The public surface serves its honest not-configured states.",
    };
  }
  const url = `${runtime.baseUrl}${API_HEALTH_PATH}`;
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      ...base,
      state: "unreachable",
      detail: `network error probing ${API_HEALTH_PATH}: ${
        error instanceof Error ? error.message : String(error)
      } — a transport outcome, not a financial state`,
    };
  }
  if (response.status >= 200 && response.status < 300) {
    return {
      ...base,
      state: "healthy",
      detail: `answered HTTP ${response.status} on ${API_HEALTH_PATH}`,
      answeredStatus: response.status,
    };
  }
  if (response.status >= 400 && response.status < 500) {
    return {
      ...base,
      state: "reachable",
      detail:
        `answered HTTP ${response.status} on ${API_HEALTH_PATH} — the deployed API authenticates every endpoint, ` +
        "so this is its honest auth/validation answer: the transport works, the dependency's internal health is UNKNOWN to this surface (no web-held API session), never guessed",
      answeredStatus: response.status,
    };
  }
  return {
    ...base,
    state: "unhealthy",
    detail: `answered HTTP ${response.status} on ${API_HEALTH_PATH} — the dependency itself reported failure`,
    answeredStatus: response.status,
  };
}

/** Derive the overall status from the per-check outcomes (never fake-healthy). */
export function deriveStatus(checks: readonly DependencyCheck[]): HealthStatus {
  if (checks.some((check) => check.state === "unhealthy" || check.state === "unreachable")) {
    return "unready";
  }
  if (checks.some((check) => check.state !== "healthy")) {
    return "degraded";
  }
  return "ok";
}

/** Assemble the full health/readiness report from injectable inputs. */
export async function buildHealthReport(
  inputs: HealthProbeInputs,
): Promise<{ report: HealthReport; httpStatus: number }> {
  const runtime = apiRuntimeState(inputs.apiBaseUrlEnv);
  const checks: DependencyCheck[] = [await probeApiRuntime(runtime, inputs.fetcher)];
  const status = deriveStatus(checks);
  const ready = status === "ok";
  const report: HealthReport = {
    status,
    service: "@payswap/web",
    role: "public product surface — a consumer of the authoritative PaySwap API",
    liveness: "alive",
    readiness: { ready, checks },
    build: {
      id: trimmedOrUndefined(inputs.buildIdEnv) ?? null,
      commit: trimmedOrUndefined(inputs.buildCommitEnv) ?? null,
    },
    checkedAt: (inputs.now ?? (() => new Date()))().toISOString(),
  };
  // Readiness semantics: 200 = serving (ok or honestly-degraded), 503 only
  // when a configured dependency FAILED (unhealthy/unreachable) — the
  // process answering is liveness; a skipped (env-gated) check is a
  // reported degradation, never a hidden failure and never a fake pass.
  const httpStatus = status === "unready" ? 503 : 200;
  return { report, httpStatus };
}

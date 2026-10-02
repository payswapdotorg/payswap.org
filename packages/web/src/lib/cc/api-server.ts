/**
 * Command Center server-side API wiring (P3-W2-002).
 *
 * Law: this web surface is a CONSUMER of the authoritative PaySwap API and
 * holds no financial state of its own. This module consumes Wave 1's
 * `@/lib/api` runtime configuration (the single place that knows the base
 * URL — imported, never modified) and adds the server-component fetch
 * semantics the Command Center needs:
 *
 * - `GET /v1/health` and `GET /v1/capabilities` are fetched SERVER-SIDE with
 *   revalidation, carrying the pinned API version header
 *   (`X-PaySwap-API-Version`, imported from @payswap/interfaces — one source
 *   of truth, never a duplicated literal);
 * - every outcome is a discriminated union: unconfigured, network-error,
 *   http-error (with the API's OWN error envelope parsed verbatim) or ok —
 *   callers render the truth, including the API's real refusal when it
 *   requires a session (the deployed runtime authenticates EVERY endpoint;
 *   without the session plane that answer is the honest state, never a
 *   fabricated success);
 * - no retries and no caching of financial state beyond Next.js revalidation
 *   of these two read-only endpoints; UNKNOWN stays UNKNOWN.
 */

import { CURRENT_API_VERSION } from "@payswap/interfaces";

import { apiRuntimeState } from "@/lib/api";
import type { ApiRuntimeState } from "@/lib/api";

/** The health payload the API returns for GET /v1/health (rendered verbatim). */
export interface ApiHealthData {
  readonly status: string;
  readonly apiVersion: string;
  readonly schemaVersion: string;
  readonly serverTime: string;
}

/** One capability entry in the GET /v1/capabilities payload. */
export interface ApiCapabilityEntry {
  readonly capabilityId: string;
  readonly description: string;
  readonly state: string;
  readonly source: string;
  readonly effectiveAvailability: string;
}

export interface ApiCapabilitiesData {
  readonly capabilities: readonly ApiCapabilityEntry[];
}

/** The API's structured error envelope (category/code/message, verbatim). */
export interface ApiErrorEnvelope {
  readonly code: string;
  readonly category: string;
  readonly message: string;
  readonly reconciliationRef?: string;
}

/** The honest outcome of a Command Center server fetch. */
export type CcApiResult<T> =
  | { readonly status: "unconfigured" }
  | { readonly status: "network-error"; readonly message: string }
  | { readonly status: "http-error"; readonly statusCode: number; readonly error?: ApiErrorEnvelope }
  | { readonly status: "ok"; readonly data: T; readonly requestId?: string };

/** Revalidation window (seconds) for the two read-only endpoints. */
export const CC_API_REVALIDATE_SECONDS = 30;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseErrorEnvelope(body: unknown): ApiErrorEnvelope | undefined {
  if (isRecord(body) && isRecord(body.error)) {
    const error = body.error;
    if (typeof error.code === "string" && typeof error.message === "string") {
      return {
        code: error.code,
        category: typeof error.category === "string" ? error.category : "UNKNOWN",
        message: error.message,
        ...(typeof error.reconciliationRef === "string"
          ? { reconciliationRef: error.reconciliationRef }
          : {}),
      };
    }
  }
  return undefined;
}

/**
 * Fetch one read-only API endpoint server-side. `rawEnv` is injectable so
 * tests never depend on ambient env mutation (the same doctrine as
 * `apiRuntimeState`).
 */
export async function fetchCcApiEndpoint<T>(
  path: string,
  rawEnv: string | undefined = process.env.NEXT_PUBLIC_PAYSWAP_API_URL,
): Promise<CcApiResult<T>> {
  const runtime: ApiRuntimeState = apiRuntimeState(rawEnv);
  if (!runtime.configured || runtime.baseUrl === null) {
    return { status: "unconfigured" };
  }
  let response: Response;
  try {
    response = await fetch(`${runtime.baseUrl}${path}`, {
      method: "GET",
      headers: {
        accept: "application/json",
        "x-payswap-api-version": CURRENT_API_VERSION,
      },
      // Read-only endpoints; revalidated so the Command Center reflects the
      // real API without ever caching a fabricated state.
      next: { revalidate: CC_API_REVALIDATE_SECONDS },
    });
  } catch (error) {
    return {
      status: "network-error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  let body: unknown = undefined;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    return {
      status: "http-error",
      statusCode: response.status,
      ...(parseErrorEnvelope(body) === undefined ? {} : { error: parseErrorEnvelope(body) }),
    };
  }
  const data = isRecord(body) && "data" in body ? body.data : body;
  const requestId = isRecord(body) && isRecord(body.meta)
    && typeof body.meta.requestId === "string"
    ? body.meta.requestId
    : undefined;
  return { status: "ok", data: data as T, ...(requestId === undefined ? {} : { requestId }) };
}

/** Fetch GET /v1/health. */
export function fetchApiHealth(rawEnv?: string): Promise<CcApiResult<ApiHealthData>> {
  return fetchCcApiEndpoint<ApiHealthData>("/v1/health", rawEnv);
}

/** Fetch GET /v1/capabilities. */
export function fetchApiCapabilities(rawEnv?: string): Promise<CcApiResult<ApiCapabilitiesData>> {
  return fetchCcApiEndpoint<ApiCapabilitiesData>("/v1/capabilities", rawEnv);
}

/**
 * The honest human explanation for a fetch outcome — one place, so every
 * section narrates the SAME truth (unconfigured ≠ network failure ≠ the
 * API's own authorization answer).
 */
export function describeCcApiOutcome<T>(result: CcApiResult<T>): {
  readonly headline: string;
  readonly detail: string;
} {
  switch (result.status) {
    case "unconfigured":
      return {
        headline: "API runtime not configured",
        detail:
          "NEXT_PUBLIC_PAYSWAP_API_URL is not set for this deployment, so the Command Center cannot reach the authoritative API. Nothing is guessed or substituted.",
      };
    case "network-error":
      return {
        headline: "The API runtime could not be reached",
        detail: `Transport error: ${result.message}. This is a network outcome, not a financial state.`,
      };
    case "http-error":
      return {
        headline: `The API answered: HTTP ${result.statusCode}`,
        detail:
          result.error === undefined
            ? "The API returned a non-2xx response without a parseable error envelope. The response is shown as-is."
            : `${result.error.category} — ${result.error.message} (code ${result.error.code})`,
      };
    case "ok":
      return { headline: "Live response", detail: "Rendered verbatim from the authoritative API." };
  }
}

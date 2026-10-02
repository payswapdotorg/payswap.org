/**
 * Session-aware API client extensions (P3-W1-002) — ADDS alongside
 * lib/api.ts (the thin unauthenticated client) without modifying it.
 *
 * Two transports, one honesty doctrine:
 *
 * 1. SAME-ORIGIN session API (/api/auth/*, /api/connect/*): browser fetch
 *    with cookies + the CSRF double-submit header on mutations. Used by
 *    client components; returns discriminated unions (never throws for
 *    expected failure modes).
 *
 * 2. THE AUTHORITATIVE PAYSWAP API: the same doctrine as lib/api.ts
 *    (unconfigured is honest; network failures are network-error; non-2xx
 *    is http-error with the VERBATIM status + body — never reinterpreted,
 *    never faked) PLUS the web session principal attached as request
 *    context (`x-payswap-principal`), the API version header and a fresh
 *    idempotency key on mutations (INV-F05).
 *
 *    The principal header is CONTEXT, not authority: the PaySwap API
 *    authenticates with its OWN session tokens. Until a public issuance
 *    path exists, calls answer 401/403 and callers render the honest
 *    "API session not yet wired in this deployment" state (W3-001
 *    honest-state doctrine) with the verbatim error alongside.
 */

import { CURRENT_API_VERSION } from "@payswap/interfaces";
import type { ApiError } from "@payswap/interfaces";

import { CSRF_HEADER } from "@/lib/session/csrf-shared";
import { apiRuntimeState, type ApiRuntimeState } from "@/lib/api";

/** The web session principal as request context (never authority). */
export interface WebPrincipalContext {
  readonly principalRef: string;
}

/** Result of a same-origin session-API call (union — never throws). */
export type SessionApiResult<T> =
  | { readonly status: "ok"; readonly data: T }
  | {
      readonly status: "http-error";
      readonly statusCode: number;
      /** The parsed JSON body when the route answered JSON (verbatim). */
      readonly body?: T;
      readonly message?: string;
    }
  | { readonly status: "network-error"; readonly message: string };

/** The verbatim error body shape the PaySwap API returns on failures. */
export interface PaySwapApiErrorBody {
  readonly error: ApiError;
  readonly meta?: { readonly schemaVersion?: string; readonly requestId?: string };
}

/** Result of an authoritative-API call (union — never throws, never fakes). */
export type PaySwapApiResult<T> =
  | { readonly status: "unconfigured" }
  | { readonly status: "ok"; readonly data: T }
  | {
      readonly status: "http-error";
      readonly statusCode: number;
      /** The verbatim parsed error body (when JSON) — surfaced, never reinterpreted. */
      readonly body?: PaySwapApiErrorBody;
    }
  | { readonly status: "network-error"; readonly message: string };

/** Same-origin session-API fetch (cookies ride along; CSRF on mutations). */
export async function sessionFetchJson<T>(
  path: string,
  init?: {
    readonly method?: "GET" | "POST";
    readonly body?: unknown;
    readonly csrfToken?: string;
  },
): Promise<SessionApiResult<T>> {
  const method = init?.method ?? "GET";
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
        ...(method === "POST" && init?.csrfToken !== undefined
          ? { [CSRF_HEADER]: init.csrfToken }
          : {}),
      },
      ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch (error) {
    return {
      status: "network-error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (!response.ok) {
    let message: string | undefined;
    let body: T | undefined;
    try {
      const parsed: unknown = await response.json();
      body = parsed as T;
      if (
        typeof parsed === "object" && parsed !== null &&
        typeof (parsed as { message?: unknown }).message === "string"
      ) {
        message = (parsed as { message: string }).message;
      }
    } catch {
      // Non-JSON error body — the status code alone is the honest signal.
    }
    return { status: "http-error", statusCode: response.status, message, body };
  }
  return { status: "ok", data: (await response.json()) as T };
}

/** True when a PaySwap API result is the honest "API session not wired" signal. */
export function isApiSessionNotWired(result: PaySwapApiResult<unknown>): boolean {
  return (
    result.status === "http-error" &&
    (result.statusCode === 401 || result.statusCode === 403)
  );
}

/**
 * Call the authoritative PaySwap API with the web principal as context.
 * The verbatim error body is carried through untouched for honest display.
 */
export async function paySwapApiFetch<T>(
  principal: WebPrincipalContext,
  path: string,
  init?: {
    readonly method?: "GET" | "POST";
    readonly body?: unknown;
    /** Injectable state for tests; defaults to the ambient env resolution. */
    readonly runtimeState?: ApiRuntimeState;
  },
): Promise<PaySwapApiResult<T>> {
  const state = init?.runtimeState ?? apiRuntimeState();
  if (!state.configured || state.baseUrl === null) {
    return { status: "unconfigured" };
  }
  const method = init?.method ?? "GET";
  let response: Response;
  try {
    response = await fetch(`${state.baseUrl}${path}`, {
      method,
      headers: {
        accept: "application/json",
        "x-payswap-principal": principal.principalRef,
        "x-payswap-api-version": CURRENT_API_VERSION,
        ...(method === "POST"
          ? { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }
          : {}),
      },
      ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch (error) {
    return {
      status: "network-error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (!response.ok) {
    let body: PaySwapApiErrorBody | undefined;
    try {
      const parsed: unknown = await response.json();
      if (
        typeof parsed === "object" && parsed !== null &&
        typeof (parsed as { error?: unknown }).error === "object" &&
        (parsed as { error?: unknown }).error !== null
      ) {
        body = parsed as PaySwapApiErrorBody;
      }
    } catch {
      // Non-JSON error body — status code alone.
    }
    return { status: "http-error", statusCode: response.status, body };
  }
  return { status: "ok", data: (await response.json()) as T };
}

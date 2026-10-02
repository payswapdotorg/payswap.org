/**
 * The client half of the journey dispatch transport (P3-W3-002).
 *
 * Every product-journey mutation from a Command Center surface goes through
 * HERE: the certified journey's own `actions[].apiCommand` (INV-F05 body,
 * built by the @payswap/ux contract — never hand-assembled by a component)
 * is POSTed to the session+CSRF-gated /api/journeys/dispatch route, which
 * transports it to the REAL authoritative PaySwap API and returns the answer
 * verbatim. This module maps that answer to the `ApiResponse` shape the
 * W3-001 fold functions consume — the SAME fold path the connection plane
 * uses — so a mutation can never bypass the contracts, and an error is
 * surfaced VERBATIM (never reinterpreted, never faked).
 *
 * There is no other transport: no component calls fetch() for a financial
 * mutation, and no simulated success exists anywhere on this path.
 */

import type { ApiResponse } from "@payswap/api";
import { ERROR_CATEGORIES, type ErrorCategory, type ApiError } from "@payswap/interfaces";
import type { ViewAction } from "@payswap/ux";

import { sessionFetchJson } from "@/lib/api-client";

/** The route's verbatim answer shape. */
interface DispatchRouteBody {
  readonly status?: string;
  readonly statusCode?: number;
  readonly message?: string;
  readonly body?: {
    readonly error?: { readonly code: string; readonly category: string; readonly message: string; readonly reconciliationRef?: string };
    readonly meta?: { readonly schemaVersion?: string; readonly requestId?: string };
    readonly data?: unknown;
  };
}

/** The honest result of one dispatch attempt. */
export type JourneyDispatchResult =
  | { readonly kind: "response"; readonly response: ApiResponse }
  | { readonly kind: "unavailable"; readonly message: string }
  | { readonly kind: "refused"; readonly message: string };

/** Verbatim-category guard: fold only categories the contracts know. */
function asErrorCategory(value: string | undefined): ErrorCategory {
  return value !== undefined &&
    (ERROR_CATEGORIES as readonly string[]).includes(value)
    ? (value as ErrorCategory)
    : "INTERNAL";
}

/** Map the route's verbatim JSON body to the contracts' ApiResponse. */
function toApiResponse(statusCode: number, body: DispatchRouteBody["body"]): ApiResponse {
  const error = body?.error;
  if (error === undefined) {
    return {
      kind: "success",
      status: statusCode,
      envelope: {
        data: body?.data ?? body,
        meta: {
          schemaVersion: body?.meta?.schemaVersion ?? "",
          requestId: body?.meta?.requestId ?? "",
        },
      },
    };
  }
  const apiError: ApiError = {
    code: error.code,
    category: asErrorCategory(error.category),
    message: error.message,
    ...(error.reconciliationRef === undefined ? {} : { reconciliationRef: error.reconciliationRef }),
  };
  return {
    kind: "error",
    status: statusCode,
    body: {
      error: apiError,
      meta: {
        schemaVersion: body?.meta?.schemaVersion ?? "",
        requestId: body?.meta?.requestId ?? "",
      },
    },
  };
}

/**
 * Dispatch one certified journey action's apiCommand through the real
 * authenticated transport. The action must be an available API_COMMAND from
 * a live journey — anything else is refused before any network movement.
 */
export async function dispatchJourneyApiCommand(
  journeyId: string,
  action: ViewAction,
  csrfToken: string | undefined,
): Promise<JourneyDispatchResult> {
  if (action.apiCommand === undefined || !action.available) {
    return {
      kind: "refused",
      message: `The action ${action.actionId} is not an available API command in this journey state.`,
    };
  }
  if (csrfToken === undefined) {
    return {
      kind: "unavailable",
      message:
        "A signed-in session is required to dispatch journey mutations — you are viewing the marked preview, which carries no session and never mutates anything.",
    };
  }
  const result = await sessionFetchJson<DispatchRouteBody>("/api/journeys/dispatch", {
    method: "POST",
    body: {
      journeyId,
      actionId: action.actionId,
      apiCommand: action.apiCommand,
    },
    csrfToken,
  });
  if (result.status === "network-error") {
    return {
      kind: "unavailable",
      message: `Could not reach the journey dispatch service: ${result.message}`,
    };
  }
  if (result.status === "http-error") {
    const message =
      result.body?.message ?? result.message ?? `The dispatch failed (HTTP ${result.statusCode}).`;
    if (result.statusCode === 400 && result.body?.status === "refused") {
      return { kind: "refused", message };
    }
    if (result.statusCode === 401 || result.statusCode === 403) {
      return {
        kind: "unavailable",
        message: `${message} Nothing was mutated.`,
      };
    }
    if (result.statusCode === 503) {
      return { kind: "unavailable", message };
    }
    return { kind: "refused", message };
  }
  const data = result.data;
  if (data.status === "ok" && typeof data.statusCode === "number") {
    return { kind: "response", response: toApiResponse(data.statusCode, data.body) };
  }
  if (data.status === "http-error" && typeof data.statusCode === "number") {
    return { kind: "response", response: toApiResponse(data.statusCode, data.body) };
  }
  if (data.status === "api-unavailable" && typeof data.message === "string") {
    return { kind: "unavailable", message: data.message };
  }
  return {
    kind: "refused",
    message: "The dispatch service answered with an unrecognized shape — nothing was folded.",
  };
}

/**
 * The honest one-line explanation for a fold-level error the API answered
 * verbatim (the deployed runtime's 401/403 session-not-wired answers render
 * as the honest state, never as a failure of the journey).
 */
export function dispatchErrorHeadline(response: ApiResponse): string | null {
  if (response.kind !== "error") {
    return null;
  }
  if (response.status === 401 || response.status === 403) {
    return "The PaySwap API answered that this session cannot dispatch the command yet — its own session tokens are required, and no public issuance path exists in this deployment. Nothing was mutated; the honest error is recorded verbatim below.";
  }
  return null;
}

/**
 * Session gate for the connect API routes (P3-W1-002) — shared helper.
 *
 * Connect operations are session-bound mutations: they require a live web
 * session AND the CSRF double-submit header. The gate returns either the
 * authenticated context (plane + principal) or the honest 401/403 response
 * to return immediately — never a fabricated session.
 */

import { NextResponse, type NextRequest } from "next/server";

import { CSRF_HEADER } from "@/lib/session/csrf";
import { sessionTokenFromRequestCookies } from "@/lib/session/cookies";
import { getWebSessionPlane, sessionLookupExplanation } from "@/lib/session/server";
import type { WebSessionPlane } from "@/lib/session/web-session";
import type { WebPrincipalContext } from "@/lib/api-client";
import { isSameOrigin } from "../auth/_guards";

export interface AuthenticatedRouteContext {
  readonly plane: WebSessionPlane;
  readonly principal: WebPrincipalContext;
}

export type SessionGate =
  | { readonly ok: true; readonly context: AuthenticatedRouteContext }
  | { readonly ok: false; readonly response: NextResponse };

/** Gate a connect route: same-origin + live session + (for mutations) CSRF. */
export async function gateConnectRoute(
  request: NextRequest,
  options: { readonly requireCsrf: boolean },
): Promise<SessionGate> {
  if (!isSameOrigin(request)) {
    return {
      ok: false,
      response: NextResponse.json(
        { status: "error", message: "Cross-site requests are rejected." },
        { status: 403 },
      ),
    };
  }
  const plane = await getWebSessionPlane();
  if (!plane.configured) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          status: "not-configured",
          message: "The identity plane is not configured in this deployment.",
          detail: plane.detail,
          missingEnvVars: plane.missingEnvVars,
        },
        { status: 503 },
      ),
    };
  }
  const token = sessionTokenFromRequestCookies(request.cookies);
  if (token === null) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          status: "unauthenticated",
          reason: "UNKNOWN_TOKEN",
          message: sessionLookupExplanation("UNKNOWN_TOKEN"),
        },
        { status: 401 },
      ),
    };
  }
  const lookup = plane.lookup(token);
  if (!lookup.valid) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          status: "unauthenticated",
          reason: lookup.reason,
          message: sessionLookupExplanation(lookup.reason),
        },
        { status: 401 },
      ),
    };
  }
  if (options.requireCsrf && !plane.verifyCsrf(request.headers.get(CSRF_HEADER) ?? undefined, token)) {
    return {
      ok: false,
      response: NextResponse.json(
        { status: "error", message: "Missing or invalid CSRF token." },
        { status: 403 },
      ),
    };
  }
  return {
    ok: true,
    context: { plane, principal: { principalRef: lookup.view.principalRef } },
  };
}

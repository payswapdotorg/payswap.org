/**
 * GET /api/auth/session — the current session, honestly (P3-W1-002).
 *
 * 200 with the session VIEW (never the token) when a live session exists;
 * 401 with the REAL fail-closed reason (UNKNOWN_TOKEN / REVOKED / EXPIRED /
 * STALE_SECURITY_EPOCH) otherwise; 503 with the honest not-configured
 * state when the identity plane is absent.
 */

import { NextResponse, type NextRequest } from "next/server";

import { sessionTokenFromRequestCookies } from "@/lib/session/cookies";
import { getWebSessionPlane, sessionLookupExplanation } from "@/lib/session/server";

export const runtime = "nodejs";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const plane = await getWebSessionPlane();
  if (!plane.configured) {
    return NextResponse.json(
      {
        status: "not-configured",
        message: "The identity plane is not configured in this deployment.",
        detail: plane.detail,
        missingEnvVars: plane.missingEnvVars,
      },
      { status: 503 },
    );
  }
  const token = sessionTokenFromRequestCookies(request.cookies);
  if (token === null) {
    return NextResponse.json(
      {
        status: "unauthenticated",
        reason: "UNKNOWN_TOKEN",
        message: sessionLookupExplanation("UNKNOWN_TOKEN"),
      },
      { status: 401 },
    );
  }
  const lookup = plane.lookup(token);
  if (!lookup.valid) {
    return NextResponse.json(
      {
        status: "unauthenticated",
        reason: lookup.reason,
        message: sessionLookupExplanation(lookup.reason),
      },
      { status: 401 },
    );
  }
  return NextResponse.json({
    status: "ok",
    principal: {
      email: lookup.view.email,
      displayName: lookup.view.displayName,
      principalRef: lookup.view.principalRef,
    },
    issuedAt: lookup.view.issuedAt,
    expiresAt: lookup.view.expiresAt,
  });
}

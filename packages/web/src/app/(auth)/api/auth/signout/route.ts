/**
 * POST /api/auth/signout — revoke the session and clear the cookies
 * (P3-W1-002).
 *
 * Session-bound mutation: requires the CSRF double-submit header bound to
 * the session token (see lib/session/csrf.ts). Sign-out ALWAYS revokes in
 * the real SessionManager and clears both cookies; a missing session is an
 * idempotent success (nothing to revoke — honest, not an error).
 */

import { NextResponse, type NextRequest } from "next/server";

import { CSRF_HEADER } from "@/lib/session/csrf";
import { clearSessionCookies, sessionTokenFromRequestCookies } from "@/lib/session/cookies";
import { getWebSessionPlane } from "@/lib/session/server";
import { isSameOrigin } from "../_guards";

export const runtime = "nodejs";

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isSameOrigin(request)) {
    return NextResponse.json(
      { status: "error", message: "Cross-site sign-out requests are rejected." },
      { status: 403 },
    );
  }
  const plane = await getWebSessionPlane();
  if (!plane.configured) {
    // An unconfigured plane has no sessions to revoke — clear the cookies
    // (defense in depth) and answer honestly.
    const response = NextResponse.json({
      status: "signed-out",
      note: "The identity plane is not configured in this deployment — no session existed.",
    });
    clearSessionCookies(response);
    return response;
  }

  const token = sessionTokenFromRequestCookies(request.cookies);
  if (token === null) {
    const response = NextResponse.json({
      status: "signed-out",
      note: "No session was active.",
    });
    clearSessionCookies(response);
    return response;
  }

  const submitted = request.headers.get(CSRF_HEADER) ?? undefined;
  if (!plane.verifyCsrf(submitted, token)) {
    return NextResponse.json(
      { status: "error", message: "Missing or invalid CSRF token." },
      { status: 403 },
    );
  }

  const revoked = plane.revoke(token);
  const response = NextResponse.json({
    status: "signed-out",
    revoked: revoked ? "the session was revoked" : "the session was already inactive",
  });
  clearSessionCookies(response);
  return response;
}

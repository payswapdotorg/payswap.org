/**
 * POST /api/auth/signin — the real server-side credential verification
 * route (P3-W1-002).
 *
 * Honest contract:
 * - the plane comes from the ambient env; when the identity plane is not
 *   configured the route answers 503 with the honest state (which env var
 *   NAMES are missing — never values) and sets NO cookies;
 * - verification is scrypt constant-time with a timing equalizer for
 *   unknown emails; the response NEVER echoes the password and never says
 *   WHICH of email/password was wrong;
 * - failures rate-limit with exponential backoff (429 + retryAfterSeconds);
 * - success sets the httpOnly session cookie + the CSRF echo cookie and
 *   returns the session VIEW (principal, expiry) — never the token.
 */

import { NextResponse, type NextRequest } from "next/server";

import { applySessionCookies } from "@/lib/session/cookies";
import { getWebSessionPlane } from "@/lib/session/server";
import { isSameOrigin, readJsonObject } from "../_guards";

export const runtime = "nodejs";

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isSameOrigin(request)) {
    return NextResponse.json(
      { status: "error", message: "Cross-site sign-in requests are rejected." },
      { status: 403 },
    );
  }
  const body = await readJsonObject(request);
  if (body === null) {
    return NextResponse.json(
      { status: "error", message: "Expected a JSON object body." },
      { status: 400 },
    );
  }
  const email = typeof body["email"] === "string" ? body["email"] : "";
  const password = typeof body["password"] === "string" ? body["password"] : "";

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

  const outcome = await plane.signIn(email, password);
  switch (outcome.status) {
    case "invalid-input":
      return NextResponse.json({ status: outcome.status, message: outcome.message }, { status: 400 });
    case "not-configured":
      // Unreachable while `plane.configured` is true (fail-closed guard
      // above) — handled honestly anyway: never a fabricated session.
      return NextResponse.json(
        { status: "not-configured", message: "The identity plane is not configured in this deployment." },
        { status: 503 },
      );
    case "rate-limited":
      return NextResponse.json(
        {
          status: outcome.status,
          message: `Too many attempts — try again in ${outcome.retryAfterSeconds}s.`,
          retryAfterSeconds: outcome.retryAfterSeconds,
          failures: outcome.failures,
        },
        {
          status: 429,
          headers: { "retry-after": String(outcome.retryAfterSeconds) },
        },
      );
    case "invalid-credentials":
      return NextResponse.json({ status: outcome.status, message: outcome.message }, { status: 401 });
    case "ok": {
      const response = NextResponse.json({
        status: "ok",
        principal: {
          email: outcome.view.email,
          displayName: outcome.view.displayName,
          principalRef: outcome.view.principalRef,
        },
        issuedAt: outcome.view.issuedAt,
        expiresAt: outcome.view.expiresAt,
      });
      applySessionCookies(response, outcome.sessionToken, outcome.csrfToken);
      return response;
    }
  }
}

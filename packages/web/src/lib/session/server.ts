/**
 * Per-request session context for server components and route handlers
 * (P3-W1-002).
 *
 * The plane itself is built ONCE per process from the ambient env (lazy —
 * so a deployment without `WEB_APP_SEED_USERS` / `WEB_APP_SESSION_SIGNING_KEY`
 * pays nothing and renders the honest state). Tests build their own planes
 * via `buildWebSessionPlane` and never touch this module's ambient state.
 *
 * `currentWebSessionContext()` is for server components (next/headers);
 * route handlers read the cookie from their NextRequest and call the plane
 * directly so they stay unit-testable without a request-scope mock.
 */

import { cookies } from "next/headers";

import { SESSION_COOKIE } from "./cookies.js";
import {
  SEED_USERS_ENV_VAR,
} from "./identity-store.js";
import {
  SESSION_SIGNING_KEY_ENV_VAR,
  buildWebSessionPlane,
  type AnyWebSessionPlane,
  type WebSessionLookup,
} from "./web-session.js";

let planePromise: Promise<AnyWebSessionPlane> | undefined;

/** The process-wide plane (built lazily from the ambient env). */
export function getWebSessionPlane(): Promise<AnyWebSessionPlane> {
  planePromise ??= buildWebSessionPlane({
    seedUsersRaw: process.env[SEED_USERS_ENV_VAR],
    signingKeyRaw: process.env[SESSION_SIGNING_KEY_ENV_VAR],
  });
  return planePromise;
}

/** Test/worker hook: forget the ambient plane (never used by request paths). */
export function resetWebSessionPlaneForTests(): void {
  planePromise = undefined;
}

/** What a server component needs to know about the current request's session. */
export type WebSessionContext =
  | {
      readonly configured: false;
      readonly missingEnvVars: readonly string[];
      readonly detail: string;
      readonly session: null;
    }
  | {
      readonly configured: true;
      readonly session: WebSessionLookup;
      readonly plane: import("./web-session.js").WebSessionPlane;
      /**
       * The CSRF echo token for the live session (undefined otherwise). This
       * is the one session-derived value that is INTENTIONALLY client-visible
       * (the CSRF cookie is not httpOnly): client mutations echo it in the
       * `x-payswap-csrf` header. It is an HMAC of the session token — the
       * session token itself never crosses to the client.
       */
      readonly csrfToken?: string;
    };

/**
 * Read the current session for a server component. Honest by construction:
 * an unconfigured plane reports itself; an absent/invalid cookie reports
 * the REAL fail-closed reason from the SessionManager (UNKNOWN_TOKEN,
 * REVOKED, EXPIRED, STALE_SECURITY_EPOCH) — never a fabricated session.
 */
export async function currentWebSessionContext(): Promise<WebSessionContext> {
  const plane = await getWebSessionPlane();
  if (!plane.configured) {
    return {
      configured: false,
      missingEnvVars: plane.missingEnvVars,
      detail: plane.detail,
      session: null,
    };
  }
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (typeof token !== "string" || token.length === 0) {
    return { configured: true, session: { valid: false, reason: "UNKNOWN_TOKEN" }, plane };
  }
  const session = plane.lookup(token);
  return {
    configured: true,
    session,
    plane,
    ...(session.valid ? { csrfToken: plane.csrfTokenFor(token) } : {}),
  };
}

/** Human explanation of a fail-closed lookup reason (UI copy, verbatim reasons). */
export function sessionLookupExplanation(
  reason: "UNKNOWN_TOKEN" | "REVOKED" | "EXPIRED" | "STALE_SECURITY_EPOCH",
): string {
  switch (reason) {
    case "UNKNOWN_TOKEN":
      return "No session is active — sign in to continue.";
    case "REVOKED":
      return "This session was revoked (for example, you signed out) — sign in again.";
    case "EXPIRED":
      return "This session expired honestly — sessions never continue quietly. Sign in again.";
    case "STALE_SECURITY_EPOCH":
      return "This session was minted before a security change on your identity — sign in again.";
  }
}

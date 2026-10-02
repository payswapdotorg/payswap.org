/**
 * Session cookies for the web plane (P3-W1-002).
 *
 * Cookie contract (work order law): the session cookie is httpOnly +
 * Secure + SameSite=Lax — JavaScript can never read it; it travels only
 * over HTTPS in production and only with top-level same-site navigations
 * by default. The CSRF cookie is intentionally NOT httpOnly: the client
 * echoes its value in the `x-payswap-csrf` header (double-submit bound to
 * the session — see csrf.ts); it carries no secret material.
 *
 * `secure` is true whenever the deployment is production (HTTPS). On a
 * plain-HTTP local dev server the flag is relaxed so the flow is manually
 * verifiable — production never is.
 */

import type { NextResponse } from "next/server";

export const SESSION_COOKIE = "payswap_web_session" as const;
export const CSRF_COOKIE = "payswap_web_csrf" as const;

/** Honest session lifetime: 8 hours, then the session expires for real. */
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

const SECURE_COOKIES = process.env.NODE_ENV === "production";

export interface SessionCookieAttributes {
  readonly httpOnly: true;
  readonly secure: boolean;
  readonly sameSite: "lax";
  readonly path: "/";
  readonly maxAge: number;
}

/** Attributes for the httpOnly session cookie (whole-second max-age). */
export function sessionCookieAttributes(maxAgeSeconds: number): SessionCookieAttributes {
  return {
    httpOnly: true,
    secure: SECURE_COOKIES,
    sameSite: "lax",
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

/** Attributes for the JS-readable CSRF echo cookie (no secret material). */
export function csrfCookieAttributes(maxAgeSeconds: number): SessionCookieAttributes {
  return sessionCookieAttributes(maxAgeSeconds);
}

/** Apply the sign-in cookie pair onto a response (httpOnly session + CSRF echo). */
export function applySessionCookies(
  response: NextResponse,
  sessionToken: string,
  csrfToken: string,
): void {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  response.cookies.set(SESSION_COOKIE, sessionToken, sessionCookieAttributes(maxAge));
  response.cookies.set(CSRF_COOKIE, csrfToken, csrfCookieAttributes(maxAge));
}

/** Clear the cookie pair (sign-out / already-absent hygiene). */
export function clearSessionCookies(response: NextResponse): void {
  response.cookies.set(SESSION_COOKIE, "", {
    ...sessionCookieAttributes(0),
    maxAge: 0,
  });
  response.cookies.set(CSRF_COOKIE, "", {
    ...csrfCookieAttributes(0),
    maxAge: 0,
  });
}

/** Read the session token from an incoming request's cookies (null when absent). */
export function sessionTokenFromRequestCookies(
  cookies: { get(name: string): { value: string } | undefined } | undefined,
): string | null {
  const raw = cookies?.get(SESSION_COOKIE)?.value;
  if (typeof raw !== "string" || raw.length === 0) {
    return null;
  }
  return raw;
}

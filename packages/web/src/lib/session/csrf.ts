/**
 * CSRF protection for the web session plane (P3-W1-002).
 *
 * Pattern: double-submit cookie BOUND to the session — the token is
 * HMAC-SHA256(signingKey, "payswap.csrf.v1" | sessionToken), so:
 *
 * - it is unpredictable without the server-side signing key (an attacker
 *   cannot mint a valid token for someone else's session);
 * - it is STATELESS (no server-side CSRF table — the session token is the
 *   state), which keeps the plane honest under the documented in-memory
 *   deployment model;
 * - it never CONTAINS the session token (HMAC is one-way) — the CSRF
 *   cookie is intentionally readable by the app's own client code so it
 *   can echo the value in the `x-payswap-csrf` header, while the session
 *   cookie stays httpOnly.
 *
 * Comparison is constant-time (node:crypto timingSafeEqual).
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** The header same-origin mutations must carry. */
export const CSRF_HEADER = "x-payswap-csrf" as const;

/** The CSRF token prefix (versioned so the format can evolve). */
const CSRF_PREFIX = "csrf_v1_" as const;

/** Derive the CSRF token bound to one session token. */
export function mintCsrfToken(
  sessionToken: string,
  signingKey: string,
): string {
  const mac = createHmac("sha256", signingKey)
    .update(`${CSRF_PREFIX}|${sessionToken}`, "utf8")
    .digest("hex");
  return `${CSRF_PREFIX}${mac}`;
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) {
    return false;
  }
  try {
    return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  } catch {
    return false;
  }
}

/**
 * Verify a submitted CSRF token against the token bound to the session.
 * Fails closed on any shape mismatch (never throws — verification only).
 */
export function verifyCsrfToken(
  submitted: string | undefined,
  sessionToken: string,
  signingKey: string,
): boolean {
  if (typeof submitted !== "string" || submitted.length === 0) {
    return false;
  }
  return safeEqualHex(submitted, mintCsrfToken(sessionToken, signingKey));
}

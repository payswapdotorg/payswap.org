/**
 * Shared guards for the (auth) API route handlers (P3-W1-002).
 *
 * Route handlers are Web-standard functions (NextRequest → NextResponse) so
 * they are unit-testable without a request-scope mock: tests construct the
 * NextRequest directly and assert on the NextResponse (cookies included).
 */

import type { NextRequest } from "next/server";

/** Largest JSON body the auth routes will read (guards hostile payloads). */
export const MAX_AUTH_BODY_BYTES = 8 * 1024;

/**
 * Same-origin guard: when an Origin header is present it must match the
 * request's own host (cross-site POSTs are rejected before any session
 * logic). Combined with SameSite=Lax cookies and the CSRF double-submit,
 * this closes the classic cross-site request lanes.
 */
export function isSameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (origin === null || origin.length === 0) {
    // Non-browser clients (no Origin) are not cross-site requests; the
    // CSRF token still gates session-bound mutations.
    return true;
  }
  const host = request.headers.get("host");
  if (host === null || host.length === 0) {
    return false;
  }
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** Read a JSON object body with a hard size cap; null on any violation. */
export async function readJsonObject(
  request: NextRequest,
): Promise<Readonly<Record<string, unknown>> | null> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return null;
  }
  const raw = await request.text();
  if (raw.length > MAX_AUTH_BODY_BYTES) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Readonly<Record<string, unknown>>;
  } catch {
    return null;
  }
}

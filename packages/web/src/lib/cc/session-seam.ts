/**
 * Command Center session seam (P3-W2-002).
 *
 * THE SEAM — read this before merging the authentication plane (P3-W1-002):
 *
 * The Command Center consumes sessions exclusively through this module. The
 * parallel worker owns `src/lib/session/**` (and the auth route group); when
 * that plane lands, the merge wires it HERE and only here:
 *
 *   1. Replace the body of `resolveCcSession()` with a call to the real
 *      session plane (e.g. read the session cookie through `@/lib/session`
 *      and map its result to `CcSessionResolution`).
 *   2. Map an authenticated session to
 *      `{ status: "authenticated", principal, role, expiresAt }` — `role`
 *      comes from the session when the plane carries one, otherwise from the
 *      role-preference cookie below (the documented dev affordance).
 *   3. Map "no session"/"expired" to `{ status: "unauthenticated" }` — the
 *      honest gate then renders exactly as it does today.
 *   4. Keep `SESSION_SEAM_CONTRACT` in sync.
 *
 * Until then every visitor is honestly `not-wired`: the Command Center
 * renders the authentication-required gate, and the clearly-marked
 * role-preference preview (below) is the only way to see the section
 * surfaces — it carries NO authority, NO financial state and NO pretend
 * login (law 1).
 */

import type { ProductRole } from "@payswap/ux";
import { PRODUCT_ROLES } from "@payswap/ux";

/** Cookie carrying the Command Center role preference (dev/demo affordance). */
export const CC_ROLE_COOKIE = "ps-cc-role" as const;

/** The single place the Command Center learns about the session. */
export interface CcSessionPrincipal {
  /** The authenticated principal reference (opaque, as the session plane names it). */
  readonly principal: string;
  /** The product role the session establishes, when it does. */
  readonly role?: ProductRole;
  /** RFC 3339 session expiry, when the plane exposes one (displayed in Settings). */
  readonly expiresAt?: string;
}

export type CcSessionResolution =
  | { readonly status: "authenticated"; readonly principal: CcSessionPrincipal }
  | { readonly status: "unauthenticated" }
  | {
      readonly status: "not-wired";
      readonly reason: string;
    };

/** The seam contract rendered in Settings and asserted by tests. */
export const SESSION_SEAM_CONTRACT = Object.freeze({
  consumer: "packages/web/src/lib/cc/session-seam.ts (this module)",
  provider: "packages/web/src/lib/session/** (P3-W1-002, the parallel auth plane)",
  mergePoint: "resolveCcSession()",
  currentState:
    "not-wired — the authentication/session plane has not landed in this deployment; every visitor renders the honest gate",
} as const);

/**
 * Resolve the Command Center session. TODAY: honestly not-wired (see the
 * seam contract above). This function is the merge point for the parallel
 * worker's session plane — nothing else in the Command Center reads the
 * session directly. It is async from day one so the merge (which will await
 * the real session plane's cookie lookup) changes no call sites.
 */
export async function resolveCcSession(): Promise<CcSessionResolution> {
  return {
    status: "not-wired",
    reason:
      "the authentication/session plane is not yet wired in this deployment — no session can exist, so none is claimed",
  };
}

/** Parse a role-preference cookie value; null unless it names a real role. */
export function parseRolePreference(value: string | undefined | null): ProductRole | null {
  if (value === undefined || value === null) {
    return null;
  }
  return (PRODUCT_ROLES as readonly string[]).includes(value) ? (value as ProductRole) : null;
}

/**
 * The effective navigation role for THIS render: the session's role when the
 * plane provides one; otherwise the clearly-marked role preference when a
 * visitor chose one; otherwise null (no derivation — the honest gate).
 */
export function effectiveNavigationRole(
  session: CcSessionResolution,
  rolePreference: ProductRole | null,
): ProductRole | null {
  if (session.status === "authenticated" && session.principal.role !== undefined) {
    return session.principal.role;
  }
  return rolePreference;
}

/** True when the section surfaces render in the marked preview mode. */
export function isPreviewMode(
  session: CcSessionResolution,
  rolePreference: ProductRole | null,
): boolean {
  return (
    session.status !== "authenticated" &&
    rolePreference !== null &&
    effectiveNavigationRole(session, rolePreference) !== null
  );
}

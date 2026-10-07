/**
 * Command Center session seam (P3-W2-002, WIRED by P3-W3-002).
 *
 * THE SEAM — the merge the W2-002 header described happened here, and only
 * here: `resolveCcSession()` now reads the REAL session plane
 * (`@/lib/session`, P3-W1-002 — scrypt identities, revocable tokens, CSRF)
 * through `currentWebSessionContext()`:
 *
 * - an unconfigured identity plane still resolves honestly `not-wired`
 *   (env-var names only — a deployment without WEB_APP_SEED_USERS /
 *   WEB_APP_SESSION_SIGNING_KEY claims no session);
 * - a configured plane with a VALID session cookie resolves
 *   `authenticated` with the opaque principal reference and expiry;
 * - a configured plane without a valid cookie (absent, expired, revoked,
 *   stale security epoch) resolves `unauthenticated` with the plane's own
 *   fail-closed reason — the honest gate then offers the real sign-in with
 *   the deep link intact (expired-session reauthentication continuity).
 *
 * The clearly-marked role-preference cookie remains a navigation derivation
 * only — never an authentication, never financial state (law 1).
 */

import type { ProductRole } from "@payswap/ux";
import { PRODUCT_ROLES } from "@payswap/ux";
import type { SidebarProjectionKind } from "@payswap/ux";
import { sidebarProjectionForRole } from "@payswap/ux";

import type { WebSessionContext } from "@/lib/session/server";
import { currentWebSessionContext } from "@/lib/session/server";

/** Cookie carrying the Command Center role preference (dev/demo affordance). */
export const CC_ROLE_COOKIE = "ps-cc-role" as const;

/**
 * Cookie carrying the Command Center PROJECTION preference (UX-006, contract
 * 10 §6 "merchant CAN switch projections — same account, two projections").
 * Like the role cookie: a navigation/view derivation ONLY — never an
 * authentication, never authority, never financial state (law 1). Merchant
 * stays the default; `consumer` re-projects the SAME object model around
 * "my money, my payments, my contacts, my requests" (never a re-axing).
 */
export const CC_PROJECTION_COOKIE = "ps-cc-projection" as const;

/** The single place the Command Center learns about the session. */
export interface CcSessionPrincipal {
  /** The authenticated principal reference (opaque, as the session plane names it). */
  readonly principal: string;
  /** The product role the session establishes, when it does. */
  readonly role?: ProductRole;
  /** RFC 3339 session expiry, when the plane exposes one (displayed in Settings). */
  readonly expiresAt?: string;
}

/** The seam contract rendered in Settings and asserted by tests. */
export const SESSION_SEAM_CONTRACT = Object.freeze({
  consumer: "packages/web/src/lib/cc/session-seam.ts (this module)",
  provider: "packages/web/src/lib/session/** (P3-W1-002, the real auth plane)",
  mergePoint: "resolveCcSession()",
  currentState:
    "wired — resolveCcSession() reads the real session plane; a configured deployment resolves authenticated/unauthenticated, an unconfigured one stays honestly not-wired",
} as const);

/**
 * The Command Center session resolution. `unauthenticated` carries the
 * session plane's own fail-closed reason (UNKNOWN_TOKEN, REVOKED, EXPIRED,
 * STALE_SECURITY_EPOCH) — never a fabricated session (law 1).
 */
export type CcSessionResolution =
  | { readonly status: "authenticated"; readonly principal: CcSessionPrincipal }
  | { readonly status: "unauthenticated"; readonly reason: string }
  | {
      readonly status: "not-wired";
      readonly reason: string;
    };

/**
 * Pure mapping from a real session-plane context to the Command Center
 * resolution (no ambient state — the unit-testable half of the seam).
 */
export function resolveCcSessionFromContext(
  context: WebSessionContext,
): CcSessionResolution {
  if (!context.configured) {
    return {
      status: "not-wired",
      reason:
        "the authentication/session plane is not configured in this deployment — no session can exist, so none is claimed",
    };
  }
  if (context.session.valid) {
    return {
      status: "authenticated",
      principal: {
        principal: context.session.view.principalRef,
        // The session plane carries no product role: navigation derives from
        // the role preference until the API session path provides one.
        role: undefined,
        expiresAt: new Date(context.session.view.expiresAt).toISOString(),
      },
    };
  }
  return {
    status: "unauthenticated",
    reason: context.session.reason,
  };
}

/**
 * Resolve the Command Center session through the REAL session plane
 * (`currentWebSessionContext()` — the P3-W1-002 identity plane). This is the
 * single merge point; nothing else in the Command Center reads the session
 * directly. Server-only (reads cookies via next/headers inside the plane).
 */
export async function resolveCcSession(): Promise<CcSessionResolution> {
  return resolveCcSessionFromContext(await currentWebSessionContext());
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

/** The honest one-liner the shell footer renders for the session state. */
export function ccSessionLine(session: CcSessionResolution): string {
  switch (session.status) {
    case "authenticated":
      return `Signed in${session.principal.role ? ` — ${session.principal.role}` : ""}`;
    case "unauthenticated":
      return "Not signed in";
    case "not-wired":
      return "Session plane: not configured (honest)";
  }
}

// ---------------------------------------------------------------------------
// The projection seam (UX-006, contract 10 §6 — additive; same law as the
// role preference: a view derivation, never an authentication)
// ---------------------------------------------------------------------------

/**
 * Parse a projection-preference cookie value; null unless it names a real
 * projection kind ("merchant" | "consumer" — fail-closed, exactly like
 * `parseRolePreference`). Anything else (absent, malformed) means "no
 * preference" and the role's default projection applies.
 */
export function parseProjectionPreference(
  value: string | undefined | null,
): SidebarProjectionKind | null {
  if (value !== "merchant" && value !== "consumer") {
    return null;
  }
  return value;
}

/**
 * The effective sidebar projection for THIS render (contract 10 §6): the
 * explicit projection preference when the visitor chose one (a merchant CAN
 * switch projections on the same account); otherwise the role's own default
 * (borrower projects consumer; everyone else merchant). The projection NEVER
 * changes the session, never grants authority and never re-axes the
 * navigation — it re-labels the SAME object model around the viewer's mental
 * model through the UX-002 `projectSidebar` API.
 */
export function effectiveSidebarProjection(
  role: ProductRole | null,
  projectionPreference: SidebarProjectionKind | null,
): SidebarProjectionKind {
  if (projectionPreference !== null) {
    return projectionPreference;
  }
  if (role === null) {
    return "merchant";
  }
  return sidebarProjectionForRole(role).projection;
}

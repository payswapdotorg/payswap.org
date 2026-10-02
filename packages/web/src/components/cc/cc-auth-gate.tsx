/**
 * The Command Center honest authentication gate (P3-W2-002; reauth
 * continuity by P3-W3-002).
 *
 * Wave 1's gate pattern, extended with the section-aware copy from the
 * certified navigation model. An unauthenticated visitor on ANY /app route
 * sees the truth. Two honest flavors:
 *
 * - `not-wired` — the identity plane is unconfigured in this deployment;
 *   no demo data, no pretend login, no teaser content.
 * - `unauthenticated` — the plane IS configured (P3-W1-002 session plane,
 *   wired through the seam): the visitor's session is absent/expired/
 *   revoked, the plane's own fail-closed reason is shown verbatim, and the
 *   REAL sign-in is offered with the deep link intact (expired-session
 *   reauthentication continuity — signing in returns to this section).
 */

import Link from "next/link";
import type { ProductNavItemId } from "@payswap/ux";
import { navItemById } from "@payswap/ux";
import { PRODUCT_NAVIGATION } from "@payswap/ux";
import { AuthRequiredState, KeyValue } from "@payswap/design";

import { RoleSwitcher } from "./role-switcher";
import type { CcRenderState } from "@/lib/cc/render-state";
import { SESSION_SEAM_CONTRACT } from "@/lib/cc/session-seam";
import { appRouteForNavItemId } from "@/lib/cc/routes";
import { sessionLookupExplanation } from "@/lib/session/server";

const SIGN_IN_STYLE =
  "ps-button ps-button--sm ps-button--primary" as const;

/** The plane's own explanation of why this session is not valid (verbatim). */
function unauthenticatedDetail(reason: string): string {
  if (
    reason === "UNKNOWN_TOKEN" ||
    reason === "REVOKED" ||
    reason === "EXPIRED" ||
    reason === "STALE_SECURITY_EPOCH"
  ) {
    return sessionLookupExplanation(reason);
  }
  return reason;
}

export function CcAuthGate({
  navItemId,
  state,
}: {
  readonly navItemId: ProductNavItemId;
  readonly state: CcRenderState;
}) {
  const item = navItemById(navItemId, PRODUCT_NAVIGATION);
  const reason =
    state.session.status === "not-wired"
      ? "The Command Center requires an authenticated session, and the authentication/session plane is not yet wired in this deployment. This gate is the honest state — there is no demo mode, no sample data and no pretend login behind it."
      : "The Command Center requires an authenticated session. Sign in to continue — the deep link stays valid.";
  const detail =
    state.session.status === "unauthenticated"
      ? unauthenticatedDetail(state.session.reason)
      : null;
  const signInHref = `/signin?next=${encodeURIComponent(appRouteForNavItemId(navItemId))}`;
  return (
    <section aria-labelledby="cc-gate-heading">
      <h1 id="cc-gate-heading" className="cc-section-heading">
        {item.label} — authentication required
      </h1>
      <p className="cc-section-intro">{item.summary}</p>
      <AuthRequiredState
        title="Authentication required"
        reason={reason}
        doctrine="Only real, verified state is rendered here — nothing is simulated, and no financial state is ever fabricated."
      />
      {detail !== null ? (
        <p className="cc-section-intro" role="status">
          {detail}{" "}
          <Link className={SIGN_IN_STYLE} href={signInHref}>
            Sign in — this section is preserved
          </Link>
        </p>
      ) : null}
      <KeyValue
        entries={[
          { key: "Session plane", value: SESSION_SEAM_CONTRACT.currentState },
          { key: "Session seam", value: SESSION_SEAM_CONTRACT.mergePoint, mono: true },
          {
            key: "This URL",
            value: `A valid deep link — it renders now, survives a hard refresh, and serves the authenticated ${item.label.toLowerCase()} surface once you sign in.`,
          },
          {
            key: "Financial data",
            value: "None rendered. The authoritative PaySwap API owns all financial truth; this surface only ever projects it for authenticated sessions.",
          },
        ]}
      />
      <div className="cc-stack">
        <p className="cc-section-intro">
          To preview how the Command Center sections render for each of the
          eight product roles — a navigation derivation with honest
          unavailable states, never an authentication — use the marked
          preview switcher:
        </p>
        <RoleSwitcher rolePreference={state.rolePreference} idPrefix="cc-gate-role" />
      </div>
      <div className="cc-gate-links">
        <Link href="/">Back to the public site</Link>
        <Link href="/capabilities">Provider coverage (public)</Link>
        <Link href="/security">Security and non-custody (public)</Link>
      </div>
    </section>
  );
}

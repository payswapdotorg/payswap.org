/**
 * The Command Center honest authentication gate (P3-W2-002).
 *
 * Wave 1's gate pattern, extended with the section-aware copy from the
 * certified navigation model: an unauthenticated visitor on ANY /app route
 * sees the truth — authentication is required and the session plane is not
 * yet wired in this deployment. No demo data, no pretend login, no teaser
 * content. The only entry beyond the gate is the clearly-marked role
 * preview (a navigation derivation, not an authentication).
 */

import Link from "next/link";
import type { ProductNavItemId } from "@payswap/ux";
import { navItemById } from "@payswap/ux";
import { PRODUCT_NAVIGATION } from "@payswap/ux";
import { AuthRequiredState, KeyValue } from "@payswap/design";

import { RoleSwitcher } from "./role-switcher";
import type { CcRenderState } from "@/lib/cc/render-state";
import { SESSION_SEAM_CONTRACT } from "@/lib/cc/session-seam";

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
      <KeyValue
        entries={[
          { key: "Session plane", value: SESSION_SEAM_CONTRACT.currentState },
          { key: "Session seam", value: SESSION_SEAM_CONTRACT.mergePoint, mono: true },
          {
            key: "This URL",
            value: `A valid deep link — it renders now, survives a hard refresh, and serves the authenticated ${item.label.toLowerCase()} surface once the session plane ships.`,
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

/**
 * The shell section frame for the object-model surfaces (UX-003).
 *
 * The legacy `CcSection` gates by legacy navigation item id; the contract-01
 * sidebar surfaces (balances, transactions, customers, catalog) are NEW
 * money objects with no legacy id — this frame gives them the SAME honest
 * gate with their own deep link and title:
 *
 * - gated (no session, no role preference): the honest authentication gate
 *   REPLACES the section content — and because server-component children
 *   only execute when rendered, a gated page never runs its data fetches;
 * - under preview or authentication the section content renders as authored.
 *
 * The gate mirrors `CcAuthGate`'s doctrine verbatim: no demo data, no
 * pretend login, the real sign-in with the deep link intact, and the
 * clearly-marked role preview switcher.
 */

import Link from "next/link";
import type { ReactNode } from "react";
import { AuthRequiredState, KeyValue } from "@payswap/design";

import { RoleSwitcher } from "@/components/cc/role-switcher";
import { getServerCcState } from "@/lib/cc/server-state";
import type { CcRenderState } from "@/lib/cc/render-state";
import { SESSION_SEAM_CONTRACT } from "@/lib/cc/session-seam";
import { sessionLookupExplanation } from "@/lib/session/server";

export interface ShellSectionProps {
  /** This surface's real /app route (the preserved deep link). */
  readonly route: string;
  /** The surface's name ("Balances") — shown by the gate. */
  readonly title: string;
  /** One honest sentence about what this surface serves. */
  readonly intro: string;
  readonly children: ReactNode;
}

export function ShellAuthGate({
  route,
  title,
  intro,
  state,
}: {
  readonly route: string;
  readonly title: string;
  readonly intro: string;
  readonly state: CcRenderState;
}) {
  const reason =
    state.session.status === "not-wired"
      ? "The Command Center requires an authenticated session, and the authentication/session plane is not yet wired in this deployment. This gate is the honest state — there is no demo mode, no sample data and no pretend login behind it."
      : "The Command Center requires an authenticated session. Sign in to continue — the deep link stays valid.";
  const detail =
    state.session.status === "unauthenticated"
      ? state.session.reason === "UNKNOWN_TOKEN" ||
          state.session.reason === "REVOKED" ||
          state.session.reason === "EXPIRED" ||
          state.session.reason === "STALE_SECURITY_EPOCH"
        ? sessionLookupExplanation(state.session.reason)
        : state.session.reason
      : null;
  const signInHref = `/signin?next=${encodeURIComponent(route)}`;
  return (
    <section aria-labelledby="cc-shell-gate-heading">
      <h1 id="cc-shell-gate-heading" className="cc-section-heading">
        {title} — authentication required
      </h1>
      <p className="cc-section-intro">{intro}</p>
      <AuthRequiredState
        title="Authentication required"
        reason={reason}
        doctrine="Only real, verified state is rendered here — nothing is simulated, and no financial state is ever fabricated."
      />
      {detail !== null ? (
        <p className="cc-section-intro" role="status">
          {detail}{" "}
          <Link className="ps-button ps-button--sm ps-button--primary" href={signInHref}>
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
            value: `A valid deep link — it renders now, survives a hard refresh, and serves the authenticated ${title.toLowerCase()} surface once you sign in.`,
          },
          {
            key: "Financial data",
            value:
              "None rendered. The authoritative PaySwap API owns all financial truth; this surface only ever projects it for authenticated sessions.",
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
        <RoleSwitcher rolePreference={state.rolePreference} idPrefix="cc-shell-gate-role" />
      </div>
      <div className="cc-gate-links">
        <Link href="/">Back to the public site</Link>
        <Link href="/capabilities">Provider coverage (public)</Link>
        <Link href="/security">Security and non-custody (public)</Link>
      </div>
    </section>
  );
}

export async function ShellSection({ route, title, intro, children }: ShellSectionProps) {
  const state = await getServerCcState();
  if (state.gated) {
    return <ShellAuthGate route={route} title={title} intro={intro} state={state} />;
  }
  return <>{children}</>;
}

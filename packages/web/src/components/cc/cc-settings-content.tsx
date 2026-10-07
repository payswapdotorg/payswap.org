/**
 * The Settings section content (P3-W2-002): session display (the seam state,
 * verbatim), role preference (the marked preview switcher), the honest
 * deployment-scope note, and the real auth/connect route links (cert-fix:
 * /login was a dead route — the session plane's real routes are /signin and
 * /signout, offered per the live session state).
 */

import Link from "next/link";
import { KeyValue, Panel } from "@payswap/design";
import { apiRuntimeState, API_BASE_URL_ENV_VAR } from "@/lib/api";

import { RoleSwitcher } from "./role-switcher";
import type { CcRenderState } from "@/lib/cc/render-state";
import { SESSION_SEAM_CONTRACT } from "@/lib/cc/session-seam";

export function CcSettingsContent({ state }: { readonly state: CcRenderState }) {
  const runtime = apiRuntimeState();
  const session = state.session;
  return (
    <div className="cc-stack">
      <Panel
        title="Session"
        description="The honest session state for this viewer — displayed verbatim from the session seam."
      >
        <KeyValue
          entries={[
            {
              key: "Status",
              value:
                session.status === "authenticated"
                  ? `authenticated — ${session.principal.principal}`
                  : session.status === "unauthenticated"
                    ? "not signed in"
                    : "not wired in this deployment",
            },
            {
              key: "Expiry",
              value:
                session.status === "authenticated" && session.principal.expiresAt !== undefined
                  ? session.principal.expiresAt
                  : "— (no session exists; sessions expire honestly once the plane ships — expired sessions re-authenticate, never quietly continue)",
            },
            { key: "Seam merge point", value: SESSION_SEAM_CONTRACT.mergePoint, mono: true },
            { key: "Seam provider", value: SESSION_SEAM_CONTRACT.provider },
          ]}
        />
      </Panel>

      <Panel
        title="Role preference"
        description="A clearly-marked preview affordance: it derives the navigation for a role WITHOUT authenticating. Session-scoped surfaces keep their honest unavailable states under preview."
      >
        <RoleSwitcher rolePreference={state.rolePreference} idPrefix="cc-settings-role" />
        <p className="cc-actions__reason">
          Current derivation: {state.navRole ?? "none — the honest gate"}. The
          eight product roles are merchant, supplier, LP, lender, borrower,
          developer, expert and network-operator — one navigation, derived
          views per role; never separate products.
        </p>
      </Panel>

      <Panel
        title="Deployment scope"
        description="What this deployment is — and is not."
      >
        <div className="cc-stack">
          <p className="cc-section-intro">
            This is the PaySwap public product surface deployment. The
            authoritative API is a separate runtime
            {runtime.configured ? " (configured for this deployment)" : " (NOT configured — NEXT_PUBLIC_PAYSWAP_API_URL is absent)"}
            , reached read-only for health and capabilities. Authenticated
            API calls (intents, approvals, payouts) require the session
            plane, which is not yet wired in this deployment — those
            surfaces render their honest unavailable states instead of
            pretending.
          </p>
          <KeyValue
            entries={[
              { key: "API runtime env var", value: API_BASE_URL_ENV_VAR, mono: true },
              {
                key: "API base URL",
                value: runtime.configured ? runtime.baseUrl : "— unconfigured (never guessed)",
                mono: runtime.configured,
              },
            ]}
          />
        </div>
      </Panel>

      <Panel
        title="Authentication and connections"
        description="The real session plane (P3-W1-002) and the provider-connection flow — both live routes in this deployment."
      >
        <div className="cc-gate-links">
          {session.status === "authenticated" ? (
            <Link href="/signout">Sign out</Link>
          ) : (
            <Link href="/signin">Sign in</Link>
          )}
          <Link href="/connect">Connect a provider</Link>
        </div>
        <p className="cc-actions__reason">
          {session.status === "authenticated"
            ? "Sign out revokes this session server-side (the real revocation, never a client-side-only logout). Sessions expire honestly and re-authenticate through the real sign-in."
            : "Sign in reaches the real session plane — scrypt-verified identities, server-issued tokens, honest expiry. Connect a provider opens the connection flow (authorization happens on the provider's own surface)."}
        </p>
      </Panel>
    </div>
  );
}

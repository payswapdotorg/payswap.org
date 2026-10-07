import type { Metadata } from "next";
import { cookies } from "next/headers";

import { CcSection } from "@/components/cc/cc-section";
import { ConsumerTabBar } from "@/components/consumer/consumer-tabbar";
import { DisputeTracker } from "@/components/consumer/dispute-tracker";
import { SecurityWarnings } from "@/components/consumer/security-warnings";
import { SpendingPermissions } from "@/components/consumer/spending-permissions";
import { getServerCcState } from "@/lib/cc/server-state";
import {
  CC_PROJECTION_COOKIE,
  effectiveSidebarProjection,
  parseProjectionPreference,
} from "@/lib/cc/session-seam";

export const metadata: Metadata = {
  title: "Safety center",
};

/**
 * UX-006 — the consumer safety center (contract 10 §5): spending
 * permissions (human scopes + revoke WITH simulation of effect), warnings
 * (attack explanations in human language), and disputes ("Report a problem"
 * per payment → structured reason → status tracking), plus the
 * recovery/backup doctrine line (human-language consequences, never raw
 * recovery words in a page).
 *
 * Every list renders its HONEST state: no permissions/warnings/disputes
 * plane records anything in this deployment, so each section states that
 * plainly and teaches the fill path — no fabricated permission, warning or
 * dispute ever renders. The revoke/report flows are wired end-to-end up to
 * the honest not-submitted gate (the same doctrine as the W4 refund: no
 * certified command, nothing simulated).
 *
 * The consumer mobile tab bar (contract 10 §6) renders on this surface when
 * the effective projection is consumer; the sidebar stays the desktop
 * navigation either way.
 */
export default async function SafetyPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const paymentId =
    typeof params.payment === "string" && params.payment !== "" ? params.payment : null;
  return (
    <CcSection navItemId="disputes">
      <SafetySection paymentId={paymentId} />
    </CcSection>
  );
}

async function SafetySection({ paymentId }: { readonly paymentId: string | null }) {
  const state = await getServerCcState();
  const store = await cookies();
  const projectionPreference = parseProjectionPreference(store.get(CC_PROJECTION_COOKIE)?.value);
  const projection = effectiveSidebarProjection(state.navRole, projectionPreference);

  return (
    <section aria-labelledby="cc-safety-heading" className="cc-stack" data-testid="safety-center">
      {projection === "consumer" ? <ConsumerTabBar active="safety" /> : null}
      <div>
        <h1 id="cc-safety-heading" className="cc-section-heading">
          Safety center
        </h1>
        <p className="cc-section-intro">
          Who can spend your money, what needs your attention, and problems
          you have reported — all in plain words, all honest.
        </p>
      </div>

      {/* Spending permissions (contract 10 §5): human scopes + revoke with
          simulation. No permission plane records anything in this
          deployment — the honest empty renders, never a fabricated grant. */}
      <section className="cc-card" aria-labelledby="cc-safety-permissions-heading">
        <div className="cc-card__head">
          <h2 id="cc-safety-permissions-heading" className="cc-card__title">
            Spending permissions
          </h2>
        </div>
        <SpendingPermissions permissions={[]} />
      </section>

      {/* Warnings (contract 10 §5 → security contract §4.4): attack
          explanations in human language; honest empty when none. */}
      <section className="cc-card" aria-labelledby="cc-safety-warnings-heading">
        <div className="cc-card__head">
          <h2 id="cc-safety-warnings-heading" className="cc-card__title">
            Warnings
          </h2>
        </div>
        <SecurityWarnings warnings={[]} />
      </section>

      {/* Disputes (contract 10 §5): report a problem per payment →
          structured reason → status tracking. */}
      <section className="cc-card" aria-labelledby="cc-safety-disputes-heading">
        <div className="cc-card__head">
          <h2 id="cc-safety-disputes-heading" className="cc-card__title">
            Report a problem
          </h2>
        </div>
        <DisputeTracker paymentId={paymentId} disputes={[]} />
      </section>

      {/* Recovery/backup (contract 10 §5): human-language consequences only;
          raw recovery words never render in page DOM (security §3). */}
      <section className="cc-card" aria-labelledby="cc-safety-recovery-heading">
        <div className="cc-card__head">
          <h2 id="cc-safety-recovery-heading" className="cc-card__title">
            Recovery and backup
          </h2>
        </div>
        <p className="cc-actions__reason" data-testid="safety-recovery-doctrine">
          If you ever lose access, recovery walks you through it in the secure
          recovery component, with plain-language consequences at every step.
          Your recovery words never appear on a page like this one — not now,
          not masked, not partially. No recovery flow is wired in this
          deployment, so nothing here can be started accidentally.
        </p>
      </section>
    </section>
  );
}

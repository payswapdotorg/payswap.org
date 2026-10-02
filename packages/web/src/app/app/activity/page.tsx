import type { Metadata } from "next";
import { KeyValue } from "@payswap/design";
import type { ProductRole } from "@payswap/ux";
import { emptySnapshot } from "@payswap/ux";

import { CcSection } from "@/components/cc/cc-section";
import { CcInboxFeed, INBOX_URGENCY_LEGEND } from "@/components/cc/cc-inbox-feed";
import { getServerCcState } from "@/lib/cc/server-state";

export const metadata: Metadata = {
  title: "Activity",
};

/**
 * The Activity section (P3-W2-002): the universal-inbox feed over the
 * certified command-center view-model. The snapshot comes from authority
 * records via the session seam — honestly empty today (the seam state is
 * rendered verbatim), filled by the authoritative API once the session
 * plane ships. The search affordance is the ⌘K palette (real actions and
 * section navigation).
 */
export default async function ActivityPage() {
  const state = await getServerCcState();
  const viewerRole: ProductRole = state.navRole ?? "merchant";
  const snapshot = emptySnapshot({
    principal: state.session.status === "authenticated" ? state.session.principal.principal : "unauthenticated-viewer",
    roleLabels: [viewerRole],
    agentRefs: [],
  });
  return (
    <CcSection navItemId="activity">
      <section aria-labelledby="cc-activity-heading" className="cc-stack">
        <div>
          <h1 id="cc-activity-heading" className="cc-section-heading">
            Activity
          </h1>
          <p className="cc-section-intro">
            All authority activity for this viewer — searchable across domains
            through the ⌘K palette, aggregated here with deterministic
            urgency.
          </p>
        </div>
        <CcInboxFeed snapshot={snapshot} nowMs={Date.now()} />
        <PanellessLegend />
        <KeyValue
          entries={[
            {
              key: "Snapshot source",
              value:
                state.session.status === "authenticated"
                  ? "authority records for the authenticated session"
                  : "honest empty snapshot — no session plane in this deployment, so no authority records exist to derive",
            },
            {
              key: "Search",
              value: "⌘K / Ctrl-K opens the command palette with real actions and section navigation.",
            },
          ]}
        />
      </section>
    </CcSection>
  );
}

function PanellessLegend() {
  return (
    <div className="cc-stack">
      <h2 className="ps-label">Urgency levels — the contract</h2>
      <ul className="cc-actions">
        {INBOX_URGENCY_LEGEND.map(([urgency, meaning]) => (
          <li key={urgency} className="cc-actions__item">
            <span className="ps-mono">{urgency}</span>
            <span className="cc-actions__reason">{meaning}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState, KeyValue } from "@payswap/design";

import { CcSection } from "@/components/cc/cc-section";
import { CcApiRuntimeCard } from "@/components/cc/cc-api-runtime-card";
import { CcConnectionSummary } from "@/components/cc/cc-connection-summary";
import { CcQuickActions } from "@/components/cc/cc-quick-actions";
import { getServerCcState } from "@/lib/cc/server-state";
import { fetchApiCapabilities, fetchApiHealth } from "@/lib/cc/api-server";
import { SESSION_SEAM_CONTRACT } from "@/lib/cc/session-seam";

export const metadata: Metadata = {
  title: "Overview",
};

/**
 * The Command Center Overview (P3-W2-002): the honest dashboard. The
 * API-runtime and capability summaries fetch the DEPLOYED API's real
 * endpoints server-side (with revalidation); the connection summary renders
 * the recorded coverage evidence with dates; recent activity renders the
 * honest empty state until the session plane provides authority records.
 * No number on this page is invented.
 */
export default async function OverviewPage() {
  const [state, health, capabilities] = await Promise.all([
    getServerCcState(),
    fetchApiHealth(),
    fetchApiCapabilities(),
  ]);
  return (
    <CcSection navItemId="overview">
      <section aria-labelledby="cc-overview-heading" className="cc-stack">
        <div>
          <h1 id="cc-overview-heading" className="cc-section-heading">
            Overview
          </h1>
          <p className="cc-section-intro">
            Your economic position across every connected provider — observed
            externally, never custodial. Every state below is real: the API
            answers are live, the coverage is recorded evidence, and the
            session plane is honestly reported.
          </p>
        </div>

        <CcApiRuntimeCard
          title="Authoritative API runtime"
          description="GET /v1/health against the deployed PaySwap API (NEXT_PUBLIC_PAYSWAP_API_URL), fetched server-side with revalidation."
          result={health}
          renderData={(data) => (
            <KeyValue
              entries={[
                { key: "Status", value: data.status },
                { key: "API version", value: data.apiVersion, mono: true },
                { key: "Schema version", value: data.schemaVersion, mono: true },
                { key: "Server time", value: data.serverTime, mono: true },
              ]}
            />
          )}
        />

        <CcConnectionSummary />

        <CcApiRuntimeCard
          title="Capability summary — live API response"
          description="GET /v1/capabilities rendered verbatim: the authoritative API's own capability list, never a local catalogue."
          result={capabilities}
          okTone="ok"
          renderData={(data) => (
            <ul className="cc-actions">
              {data.capabilities.map((entry) => (
                <li key={entry.capabilityId} className="cc-actions__item">
                  <span className="ps-mono">{entry.capabilityId}</span>
                  <span className="cc-actions__reason">
                    {entry.description} (state {entry.state}, source {entry.source}, effective{" "}
                    {entry.effectiveAvailability})
                  </span>
                </li>
              ))}
            </ul>
          )}
        />

        <EmptyState
          title="No recent activity"
          description={
            <>
              The activity feed derives from authority records — approvals,
              executions, mandates — and none exist for this viewer yet. An
              empty snapshot is still an honest snapshot: nothing is
              back-filled or simulated. The feed fills from the authoritative
              API once the session plane ships.{" "}
              <Link href="/app/activity">Open the full Activity feed</Link>.
            </>
          }
        />

        <KeyValue
          entries={[
            { key: "Session plane", value: SESSION_SEAM_CONTRACT.currentState },
            { key: "Render mode", value: state.preview ? `Preview — ${state.navRole} navigation derivation` : state.session.status },
          ]}
        />

        <CcQuickActions role={state.navRole} />
      </section>
    </CcSection>
  );
}

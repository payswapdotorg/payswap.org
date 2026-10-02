import type { Metadata } from "next";

import { CcSection } from "@/components/cc/cc-section";
import { CcApiRuntimeCard } from "@/components/cc/cc-api-runtime-card";
import { CcCapabilitiesContent } from "@/components/cc/cc-capabilities-content";
import { CcYourInstances } from "@/components/cc/cc-your-instances";
import { fetchApiCapabilities } from "@/lib/cc/api-server";
import { getConnectionPlane } from "@/app/(auth)/_server/connection-plane";
import { currentWebSessionContext } from "@/lib/session/server";
import { Panel } from "@payswap/design";

export const metadata: Metadata = {
  title: "Capabilities",
};

/**
 * The Capabilities section (P3-W2-002): truthful provider/capability health —
 * the REAL /v1/capabilities response from the deployed API, the recorded
 * coverage evidence with dates, the four-state distinction, and the
 * external-funds-observation framing for balances.
 */
export default async function CapabilitiesPage() {
  const capabilities = await fetchApiCapabilities();
  return (
    <CcSection navItemId="capabilities">
      <CapabilitiesSection capabilities={capabilities} />
    </CcSection>
  );
}

async function CapabilitiesSection({
  capabilities,
}: {
  readonly capabilities: Awaited<ReturnType<typeof fetchApiCapabilities>>;
}) {
  const context = await currentWebSessionContext();
  const authenticated = context.configured && context.session.valid;
  const records = authenticated
    ? getConnectionPlane().authorityRecordsFor(context.session.view.principalRef)
    : [];
  return (
    <section aria-labelledby="cc-capabilities-heading" className="cc-stack">
      <div>
        <h1 id="cc-capabilities-heading" className="cc-section-heading">
          Capabilities
        </h1>
        <p className="cc-section-intro">
          Your connected capabilities as live instances — never a provider
          catalogue mistaken for authority. Provider health and coverage
          are truthful from recorded evidence and the live API; verdicts
          are never upgraded and UNKNOWN is never failure.
        </p>
      </div>
      <CcApiRuntimeCard
        title="Live capability list — the authoritative API"
        description="GET /v1/capabilities rendered verbatim from the deployed runtime (NEXT_PUBLIC_PAYSWAP_API_URL)."
        result={capabilities}
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
      <Panel
        title="Your connected capability instances"
        description="Authority activation records only — scope, authorization mode, expiry and reauth state are all visible. An EXPIRED record carries its reauthorization entry; the catalogue is never treated as connected capability."
      >
        <CcYourInstances records={records} authenticated={authenticated} />
      </Panel>
      <CcCapabilitiesContent />
    </section>
  );
}

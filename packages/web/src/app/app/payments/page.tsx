import type { Metadata } from "next";

import { CcSection } from "@/components/cc/cc-section";
import { PayJourneySurface } from "@/components/cc/pay-journey-surface";

export const metadata: Metadata = {
  title: "Payments",
};

/**
 * The Payments section (P3-W2-002): the Pay journey surface. Connected
 * instances and routability checks arrive as authority records — none exist
 * until the connection plane ships, so the surface begins in its honest
 * empty state (never a fabricated capability list).
 */
export default async function PaymentsPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const start = params.start === "1";
  return (
    <CcSection navItemId="payments">
      <section aria-labelledby="cc-payments-heading" className="cc-stack">
        <div>
          <h1 id="cc-payments-heading" className="cc-section-heading">
            Payments
          </h1>
          <p className="cc-section-intro">
            Pay recipients through your connected providers — capability
            selection from connected instances only, route review before any
            submission, tracking with UNKNOWN rendered as reconciliation
            (never failure), and evidence for every effect.
          </p>
        </div>
        <PayJourneySurface
          connectedInstances={[]}
          routabilityChecks={[]}
          routeCandidates={[]}
          autoStart={start}
        />
      </section>
    </CcSection>
  );
}

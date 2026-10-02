import type { Metadata } from "next";

import { CcSection } from "@/components/cc/cc-section";
import { PayoutJourneySurface } from "@/components/cc/payout-journey-surface";

export const metadata: Metadata = {
  title: "Payouts",
};

/**
 * The Payouts section (P3-W2-002): the Payout journey — an EXPLICIT external
 * destination is required before any submission (fail-closed), the
 * withdrawal scope is distinct from connection (single-use, destination-
 * bound), tracking renders UNKNOWN as reconciliation, and balances are
 * external observations — never custody.
 */
export default async function PayoutsPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const start = params.start === "1";
  return (
    <CcSection navItemId="payouts">
      <section aria-labelledby="cc-payouts-heading" className="cc-stack">
        <div>
          <h1 id="cc-payouts-heading" className="cc-section-heading">
            Payouts
          </h1>
          <p className="cc-section-intro">
            Disbursements under explicit control-plane gates — money moves
            only with recorded authorization. The withdrawal scope is
            separate from your connections: connecting a provider never
            grants blanket withdrawal authority.
          </p>
        </div>
        <PayoutJourneySurface autoStart={start} />
      </section>
    </CcSection>
  );
}

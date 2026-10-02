import type { Metadata } from "next";

import { CcSection } from "@/components/cc/cc-section";
import { CollectJourneySurface } from "@/components/cc/collect-journey-surface";

export const metadata: Metadata = {
  title: "Collections",
};

/**
 * The Collections section (P3-W2-002): the Collect journey — request
 * creation where a connected capability permits, the shareable request
 * (opaque reference), fulfillment tracking with outcomes folded verbatim.
 */
export default async function CollectionsPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const start = params.start === "1";
  return (
    <CcSection navItemId="collections">
      <section aria-labelledby="cc-collections-heading" className="cc-stack">
        <div>
          <h1 id="cc-collections-heading" className="cc-section-heading">
            Collections
          </h1>
          <p className="cc-section-intro">
            Request money in the currencies your connections actually support
            — scoped to real eligibility. Requests share an opaque reference;
            fulfillment folds verbatim from authority.
          </p>
        </div>
        <CollectJourneySurface collectCapableInstances={[]} autoStart={start} />
      </section>
    </CcSection>
  );
}

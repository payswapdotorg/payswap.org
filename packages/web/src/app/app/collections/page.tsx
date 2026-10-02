import type { Metadata } from "next";

import { CcSection } from "@/components/cc/cc-section";
import { CollectJourneySurface } from "@/components/cc/collect-journey-surface";
import { getConnectionPlane } from "@/app/(auth)/_server/connection-plane";
import { currentWebSessionContext } from "@/lib/session/server";

export const metadata: Metadata = {
  title: "Collections",
};

/**
 * The Collections section (P3-W2-002; capability continuity by P3-W3-002):
 * the Collect journey — request creation where a connected capability
 * permits (authority records from the connection plane, never catalogue
 * data), the shareable request (opaque reference), fulfillment tracking
 * with outcomes folded verbatim.
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
      <CollectionsSection start={start} />
    </CcSection>
  );
}

async function CollectionsSection({ start }: { readonly start: boolean }) {
  const context = await currentWebSessionContext();
  const authenticated = context.configured && context.session.valid;
  const collectCapableInstances = authenticated
    ? getConnectionPlane().connectedInstancesFor(context.session.view.principalRef)
    : [];
  return (
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
      <CollectJourneySurface
        collectCapableInstances={collectCapableInstances}
        autoStart={start}
        csrfToken={authenticated ? context.csrfToken : undefined}
      />
    </section>
  );
}

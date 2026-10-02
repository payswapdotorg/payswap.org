import type { Metadata } from "next";

import { CcSection } from "@/components/cc/cc-section";
import { PayJourneySurface } from "@/components/cc/pay-journey-surface";
import { getConnectionPlane } from "@/app/(auth)/_server/connection-plane";
import { currentWebSessionContext } from "@/lib/session/server";

export const metadata: Metadata = {
  title: "Payments",
};

/**
 * The Payments section (P3-W2-002; capability continuity by P3-W3-002): the
 * Pay journey surface. Connected instances arrive as AUTHORITY records from
 * the connection plane (`connectedInstancesFor` — records folded by the
 * authoritative API path, never catalogue data); with none, the surface
 * renders its honest empty state (never a fabricated capability list). The
 * marked role preview carries no session, so it honestly shows no
 * instances and no mutation dispatch.
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
      <PaymentsSection start={start} />
    </CcSection>
  );
}

async function PaymentsSection({ start }: { readonly start: boolean }) {
  // CcSection has already gated: this renders only for authenticated (or
  // marked-preview) visitors. The session context decides which.
  const context = await currentWebSessionContext();
  const connectedInstances =
    context.configured && context.session.valid
      ? getConnectionPlane().connectedInstancesFor(context.session.view.principalRef)
      : [];
  return (
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
        connectedInstances={connectedInstances}
        routabilityChecks={[]}
        routeCandidates={[]}
        autoStart={start}
        csrfToken={context.configured && context.session.valid ? context.csrfToken : undefined}
      />
    </section>
  );
}

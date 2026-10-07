import type { Metadata } from "next";
import Link from "next/link";

import { CcSection } from "@/components/cc/cc-section";
import { CreatePaymentWorkflow } from "@/components/workflows/create-payment-workflow";
import { getConnectionPlane } from "@/app/(auth)/_server/connection-plane";
import { currentWebSessionContext } from "@/lib/session/server";

import { listPaymentsFor, paymentsPlaneInput } from "./_server/payments-plane";
import { PaymentsCollection } from "./_view/payments-collection";

export const metadata: Metadata = {
  title: "Payments",
};

/**
 * The Payments section (UX-004 convergence): the payments COLLECTION (the
 * ListPage anatomy with the Failure reason column) — and, on ?start=1, the
 * W1 create-payment workflow the CreateMenu "Pay" chord (c p) and the
 * collection's Create action land on.
 *
 * Connected instances arrive as AUTHORITY records from the connection plane
 * (`connectedInstancesFor`); with none, the workflow renders its honest
 * empty state (never a fabricated capability list). The marked role preview
 * carries no session, so it honestly shows no instances and no mutation
 * dispatch.
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
  const sessioned = context.configured && context.session.valid;
  const principalRef = sessioned ? context.session.view.principalRef : null;
  const connectedInstances =
    principalRef !== null
      ? getConnectionPlane().connectedInstancesFor(principalRef)
      : [];

  if (start) {
    return (
      <section aria-labelledby="cc-payments-heading" className="cc-stack">
        <div>
          <h1 id="cc-payments-heading" className="cc-section-heading">
            Payments
          </h1>
          <p className="cc-section-intro">
            Create a payment — compose it, choose how it is funded, confirm
            with the amount restated on the button. Submission dispatches
            through the authenticated PaySwap API; capability selection draws
            only from your connected instances, and an outcome that is not
            yet known renders as reconciliation, never as failure.
          </p>
        </div>
        <CreatePaymentWorkflow
          connectedInstances={connectedInstances}
          routabilityChecks={[]}
          contactDirectory={[]}
          methodsOnFile={[]}
          autoStart
          csrfToken={sessioned ? context.csrfToken : undefined}
        />
        <p className="cc-actions__reason">
          <Link href="/app/payments" className="font-semibold text-emerald-800 underline">
            View all payments
          </Link>{" "}
          — the collection with its detail drill-downs.
        </p>
      </section>
    );
  }

  const read = await listPaymentsFor(paymentsPlaneInput(principalRef));
  return <PaymentsCollection read={read} />;
}

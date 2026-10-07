import type { Metadata } from "next";
import Link from "next/link";

import { CcSection } from "@/components/cc/cc-section";
import { CreatePaymentWorkflow } from "@/components/workflows/create-payment-workflow";
import type { CreatePaymentWorkflowInitial } from "@/components/workflows/create-payment-workflow";
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
      <PaymentsSection start={start} params={params} />
    </CcSection>
  );
}

/**
 * The W1 PRE-FILL seam (contract 06 §4, UX-005): the search/command surface
 * (and any deep link) carries what the grammar parsed — `to` (counterparty
 * as typed), `amount` (EXACT minor units) with `asset` (the code those
 * minor units were computed with — both ship together or not at all, so the
 * text re-derives exactly), and `description` (the no-result intent-turn's
 * seed). Pre-fills only: the form validates everything as always, and a
 * missing parameter is simply a field the form asks for — never an error.
 */
function prefillFromParams(
  params: Record<string, string | string[] | undefined>,
): CreatePaymentWorkflowInitial {
  const to =
    typeof params.to === "string" && params.to.trim().length > 0
      ? params.to.trim().slice(0, 80)
      : undefined;
  const asset =
    typeof params.asset === "string" && /^[A-Za-z]{3}$/.test(params.asset.trim())
      ? params.asset.trim().toUpperCase()
      : undefined;
  const amount =
    typeof params.amount === "string" && /^\d+$/.test(params.amount.trim())
      ? params.amount.trim()
      : undefined;
  const description =
    typeof params.description === "string" && params.description.trim().length > 0
      ? params.description.trim().slice(0, 200)
      : undefined;
  return {
    ...(to !== undefined ? { counterpartyText: to } : {}),
    ...(asset !== undefined ? { currency: asset } : {}),
    ...(amount !== undefined && asset !== undefined ? { amountMinorUnits: amount } : {}),
    ...(description !== undefined ? { description } : {}),
  };
}

async function PaymentsSection({
  start,
  params,
}: {
  readonly start: boolean;
  readonly params: Record<string, string | string[] | undefined>;
}) {
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
          initial={prefillFromParams(params)}
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

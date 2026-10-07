import type { Metadata } from "next";

import { EnvironmentBanner } from "@payswap/design";
import { CcSection } from "@/components/cc/cc-section";
import { PaymentDetailView } from "@/components/detail/payment-detail-view";
import { PaymentNotFound } from "@/components/detail/payment-not-found";
import { currentWebSessionContext } from "@/lib/session/server";

import { paymentById, paymentsPlaneInput, paymentsWorldLabel } from "../_server/payments-plane";
import { PaymentsReadState } from "../_view/read-states";

export const metadata: Metadata = {
  title: "Payment detail",
};

/**
 * The payment detail route (UX-004; contract 05 §4: deep-linkable
 * /app/payments/<id>). The honest payments plane resolves the id:
 * - a record renders through the ONE detail anatomy (header → timeline →
 *   context cards → raw detail → related → receipts → events);
 * - an id that does not exist in the world that was consulted renders the
 *   DEDICATED not-found page (resource + world + next hop — contract 07
 *   §3.4), never a bare 404 and never a fabricated record;
 * - an unconfigured/unreachable plane renders its honest state.
 */
export default async function PaymentDetailPage({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}) {
  const { id } = await params;
  return (
    <CcSection navItemId="payments">
      <PaymentDetailSection id={id} />
    </CcSection>
  );
}

async function PaymentDetailSection({ id }: { readonly id: string }) {
  const context = await currentWebSessionContext();
  const sessioned = context.configured && context.session.valid;
  const input = paymentsPlaneInput(
    sessioned ? context.session.view.principalRef : null,
  );
  const result = await paymentById(input, id);

  if (result.status === "ok") {
    return (
      <div className="cc-stack">
        {result.data.environment === "test" ? (
          <p className="cc-actions__reason" data-testid="payment-test-marking">
            <EnvironmentBanner environment="test" variant="badge" badgeLabel="Test mode" />{" "}
            Test record — nothing here touches real money.
          </p>
        ) : null}
        <PaymentDetailView
          payment={result.data}
          worldLabel={paymentsWorldLabel(input)}
        />
      </div>
    );
  }
  if (result.status === "not-found") {
    return <PaymentNotFound paymentId={id} worldLabel={paymentsWorldLabel(input)} />;
  }
  return (
    <PaymentsReadState
      result={result}
      nextHop={{ href: "/app/payments", label: "View all payments" }}
    />
  );
}

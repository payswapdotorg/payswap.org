import type { Metadata } from "next";

import { EnvironmentBanner } from "@payswap/design";
import { CcSection } from "@/components/cc/cc-section";
import { LinkNotFound } from "@/components/detail/link-not-found";
import { LinkResultView } from "@/components/detail/link-result-view";
import { currentWebSessionContext } from "@/lib/session/server";

import { paymentLinkById, paymentsPlaneInput, paymentsWorldLabel } from "../../_server/payments-plane";
import { PaymentsReadState } from "../../_view/read-states";

export const metadata: Metadata = {
  title: "Payment link",
};

/**
 * The W2 payment-link RESULT route (contract 04 §2 W2.6): copyable link ·
 * Add URL parameters · Embed · Download QR code (honest placeholder) · the
 * payment-methods list. Rendered ONLY for real link records (the
 * authoritative API when it ships; the clearly-marked TEST fixtures) — an
 * unknown id renders the dedicated not-found page, an unavailable plane its
 * honest state. No fabricated links, ever.
 */
export default async function PaymentLinkResultPage({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}) {
  const { id } = await params;
  return (
    <CcSection navItemId="payments">
      <LinkResultSection id={id} />
    </CcSection>
  );
}

async function LinkResultSection({ id }: { readonly id: string }) {
  const context = await currentWebSessionContext();
  const sessioned = context.configured && context.session.valid;
  const input = paymentsPlaneInput(
    sessioned ? context.session.view.principalRef : null,
  );
  const result = await paymentLinkById(input, id);

  if (result.status === "ok") {
    return (
      <div className="cc-stack">
        {result.data.environment === "test" ? (
          <p className="cc-actions__reason" data-testid="link-test-marking">
            <EnvironmentBanner environment="test" variant="badge" badgeLabel="Test mode" />{" "}
            Test link — fixture record, never a live payment page.
          </p>
        ) : null}
        <LinkResultView link={result.data} />
      </div>
    );
  }
  if (result.status === "not-found") {
    return <LinkNotFound linkId={id} worldLabel={paymentsWorldLabel(input)} />;
  }
  return (
    <PaymentsReadState
      result={result}
      nextHop={{ href: "/app/payments/link", label: "Create a payment link" }}
    />
  );
}

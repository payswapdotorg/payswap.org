import type { Metadata } from "next";

import { CcSection } from "@/components/cc/cc-section";
import { PaymentLinkBuilder } from "@/components/workflows/payment-link-builder";
import { currentWebSessionContext } from "@/lib/session/server";
import { apiRuntimeState } from "@/lib/api";

export const metadata: Metadata = {
  title: "Payment link",
};

/**
 * The W2 payment-link builder route (UX-004).
 *
 * ROUTE CHOICE (documented per the work order): the builder lives at
 * /app/payments/link — the payments-family route this lane owns (W2's
 * object is a payments-family collection surface; the catalog hub's Links
 * tab and the CreateMenu "Payment link" chord link into it).
 *
 * The search params are the W1 hosted-link HAND-OFF (amount as exact minor
 * units, currency, name, description) — pre-fills, never an obligation.
 * The honest gate renders inside the builder: creation is a financial
 * mutation, and no certified link-creation command exists yet, so no link
 * is ever fabricated (the preview says PREVIEW, the result page renders
 * only real records).
 */
export default async function PaymentLinkPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  return (
    <CcSection navItemId="payments">
      <LinkBuilderSection params={params} />
    </CcSection>
  );
}

async function LinkBuilderSection({
  params,
}: {
  readonly params: Record<string, string | string[] | undefined>;
}) {
  const context = await currentWebSessionContext();
  const sessioned = context.configured && context.session.valid;
  const amount = typeof params.amount === "string" ? params.amount : undefined;
  const currency = typeof params.currency === "string" ? params.currency : undefined;
  const name = typeof params.name === "string" ? params.name : undefined;
  const description =
    typeof params.description === "string" ? params.description : undefined;

  return (
    <section aria-labelledby="cc-link-heading" className="cc-stack">
      <div>
        <h1 id="cc-link-heading" className="cc-section-heading">
          Payment link
        </h1>
        <p className="cc-section-intro">
          A no-code collection link: pick a product, choose what the payment
          page asks for, pick the button verb — then share one URL. The live
          preview shows what the link will look like; creating it dispatches
          through the authoritative PaySwap API and nothing is simulated.
        </p>
      </div>
      <PaymentLinkBuilder
        initial={{
          // The W1 hand-off carries exact minor units — adopted verbatim.
          ...(amount !== undefined && /^\d+$/.test(amount)
            ? { amountMinorUnits: amount }
            : {}),
          ...(currency !== undefined && /^[A-Z0-9]{2,10}$/.test(currency) ? { currency } : {}),
          ...(name !== undefined && name.trim().length > 0
            ? { name: name.slice(0, 80) }
            : {}),
          ...(description !== undefined && description.trim().length > 0
            ? { description: description.slice(0, 200) }
            : {}),
        }}
        productDirectory={[]}
        apiConfigured={apiRuntimeState().configured}
        csrfToken={sessioned ? context.csrfToken : undefined}
      />
    </section>
  );
}

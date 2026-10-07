/**
 * UX-004 — W2, the payment-link RESULT page (contract 04 §2 W2.6).
 *
 * Rendered only for REAL link records (the authoritative API when it ships;
 * the clearly-marked TEST fixtures in test mode): copyable link · Add URL
 * parameters · Embed · Download QR code (honest not-yet placeholder — the
 * generation path is not wired, and the surface says so instead of faking a
 * download) · the payment-methods list with a Manage affordance. A public
 * link URL is not a secret; it is copyable in full.
 */

import Link from "next/link";
import { Panel } from "@payswap/design";

import type { PaymentLinkRecordView } from "@/app/app/payments/_view/payment-view";
import { formatMoney } from "@/app/app/payments/_view/payment-view";

import { CopyableField } from "./copyable-field";
import { HonestNotYetAction } from "./honest-action";

export interface LinkResultViewProps {
  readonly link: PaymentLinkRecordView;
}

export function LinkResultView({ link }: LinkResultViewProps) {
  const embedSnippet = `<iframe src="${link.url}" width="420" height="640" title="Pay with PaySwap"></iframe>`;
  return (
    <section aria-labelledby="link-result-heading" className="cc-stack">
      <p id="link-result-heading" className="ps-sr-only">
        Payment link {link.id}
      </p>
      <Panel
        title="Your payment link is ready"
        description={`“${link.productName}” — ${formatMoney(link.pricing.amount)}, ${link.pricing.kind === "one-off" ? "one-off" : "recurring"}.`}
        headingLevel={2}
      >
        <div className="cc-stack" data-testid="link-result">
          <p className="cc-actions__reason">
            <CopyableField label="Payment link" value={link.url} testId="copy-link-url" />
          </p>
          <details className="cc-stack">
            <summary className="cc-actions__reason">Add URL parameters</summary>
            <p className="cc-actions__reason">
              Append query parameters to pre-fill the payment page —{" "}
              <span className="ps-mono">?prefilled_email=</span> and{" "}
              <span className="ps-mono">?promo=</span> are honored by the hosted page.
              Compose them against the copied URL above.
            </p>
          </details>
          <details className="cc-stack" data-testid="link-embed">
            <summary className="cc-actions__reason">Embed</summary>
            <pre className="ps-mono cc-actions__reason">{embedSnippet}</pre>
            <CopyableField label="Embed snippet" value={embedSnippet} />
          </details>
          <div className="cc-stack">
            <p className="cc-actions__reason" data-testid="qr-honesty">
              <strong>Download QR code — not yet live.</strong> QR generation is not
              wired in this deployment; the button would be a fake download, so the
              honest state renders instead. The link above is complete and ready to
              copy or embed today.
            </p>
          </div>
          <div className="cc-stack">
            <p className="cc-actions__reason">
              Payment methods on this link: {link.methods.join(" · ")}.
            </p>
            <HonestNotYetAction
              label="Manage payment methods"
              message="Method management lands with the capabilities surface — the methods listed are the ones recorded on this link; nothing is editable here yet (honest not-yet, not a failure)."
            />
          </div>
        </div>
      </Panel>
      <p className="cc-actions__reason">
        <Link href="/app/payments" className="font-semibold text-emerald-800 underline">
          Back to payments
        </Link>
      </p>
    </section>
  );
}

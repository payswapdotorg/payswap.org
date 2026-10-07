/**
 * UX-004 — the dedicated not-found page for payment deep links (contract 07
 * §3.4): name the resource looked up, name the world (test/live — here:
 * which source was consulted), offer the single best next hop. Never a bare
 * 404, never a dead end.
 */

import Link from "next/link";

import { EmptyState } from "@payswap/design";

export interface PaymentNotFoundProps {
  /** The id that was looked up (rendered verbatim). */
  readonly paymentId: string;
  /** The world the lookup happened in (from the payments plane). */
  readonly worldLabel: string;
}

export function PaymentNotFound({ paymentId, worldLabel }: PaymentNotFoundProps) {
  return (
    <EmptyState
      title="Payment not found"
      description={
        <>
          The requested payment does not exist:{" "}
          <span className="ps-mono">{paymentId}</span> — looked up in {worldLabel}.
          Nothing is fabricated in its place. Deep links stay honest: this is
          the dedicated not-found state, not an error.
        </>
      }
      action={
        <Link href="/app/payments" className="ps-button ps-button--md ps-button--primary">
          View all payments
        </Link>
      }
      teachingLine="Tip: every payment id is copyable from its detail page and from the payments list."
    />
  );
}

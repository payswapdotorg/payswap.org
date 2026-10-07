/**
 * UX-004 — the dedicated not-found page for payment-LINK deep links
 * (contract 07 §3.4): name the resource looked up, name the world that was
 * consulted, offer the single best next hop. Never a bare 404, never a dead
 * end, never a fabricated link in place of the missing one.
 */

import Link from "next/link";

import { EmptyState } from "@payswap/design";

export interface LinkNotFoundProps {
  /** The link id that was looked up (rendered verbatim). */
  readonly linkId: string;
  /** The world the lookup happened in (from the payments plane). */
  readonly worldLabel: string;
}

export function LinkNotFound({ linkId, worldLabel }: LinkNotFoundProps) {
  return (
    <EmptyState
      title="Payment link not found"
      description={
        <>
          The requested payment link does not exist:{" "}
          <span className="ps-mono">{linkId}</span> — looked up in {worldLabel}.
          Nothing is fabricated in its place; the honest answer is that no
          such link exists in the world that was consulted.
        </>
      }
      action={
        <Link href="/app/payments/link" className="ps-button ps-button--md ps-button--primary">
          Create a payment link
        </Link>
      }
      teachingLine="Every created link renders a result page with its copyable URL — links never exist only in a URL bar."
      data-testid="link-not-found"
    />
  );
}

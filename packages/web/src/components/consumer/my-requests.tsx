/**
 * UX-006 — My requests (contract 10 §2: the catalog object projected into
 * the requests addressed to the consumer). Payment requests and links that
 * were sent TO this account, tracking their incoming state — the SAME
 * collection anatomy (ListPage) with the consumer's columns, statuses
 * through StatusChip (outcome states are the right vocabulary here), and an
 * honest empty that teaches how requests arrive.
 *
 * No data plane records incoming requests in this deployment, so the
 * collection renders its honest empty — never a fabricated request.
 */

import Link from "next/link";
import { EmptyState, ListPage, StatusChip } from "@payswap/design";
import type { ListPageRow } from "@payswap/design";

import type { MoneyView } from "@/app/app/payments/_view/payment-view";
import { formatMoney } from "@/app/app/payments/_view/payment-view";

/** One request addressed to the consumer (the catalog object, projected). */
export interface RequestRecordView {
  readonly id: string;
  /** Who sent the request. */
  readonly from: string;
  /** What it is for (the product/link name). */
  readonly title: string;
  /** The requested amount (exact minor units, never rounded). */
  readonly amount: MoneyView;
  /** The incoming state — the outcome vocabulary, tracked honestly. */
  readonly state: "processing" | "succeeded" | "failed";
  /** When the request arrived (ISO). */
  readonly createdAt: string;
}

export function requestRows(requests: readonly RequestRecordView[]): ListPageRow[] {
  return requests.map((request) => ({
    id: request.id,
    cells: [
      formatMoney(request.amount),
      <StatusChip key="status" state={request.state} />,
      request.from,
      request.title,
      request.createdAt.slice(0, 10),
    ],
  }));
}

export function MyRequests({ requests }: { readonly requests: readonly RequestRecordView[] }) {
  return (
    <section className="cc-stack" aria-labelledby="cc-my-requests-heading" data-testid="my-requests">
      <div>
        <h1 id="cc-my-requests-heading" className="cc-section-heading">
          My requests
        </h1>
        <p className="cc-section-intro">
          Payment requests and links addressed to you — each tracks its own
          incoming state, and nothing here is a request you created.
        </p>
      </div>
      <ListPage
        title="My requests"
        data-testid="my-requests-list"
        columns={["Amount", "Status", "From", "For", "Received"]}
        rows={requestRows(requests)}
        empty={
          <EmptyState
            title="No requests addressed to you yet"
            description={
              <>
                When someone shares a payment request or payment link with
                you, it appears here with its amount and its incoming state —
                you pay it with the same confirm flow you always use. No
                request is ever fabricated.
              </>
            }
            action={
              <Link href="/app/payments?start=1" className="ps-button ps-button--sm ps-button--primary">
                Make a payment
              </Link>
            }
            teachingLine="Test-mode requests are marked as test data — they never mix with live requests."
          />
        }
        pagination={
          requests.length > 0 ? { from: 1, to: requests.length, total: requests.length } : undefined
        }
      />
    </section>
  );
}

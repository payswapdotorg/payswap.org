/**
 * UX-004 — the payments COLLECTION surface (contract 03 §2.1 ListPage): the
 * payments family's list with its spec'd columns (Amount · Status ·
 * Rail/Method · Description · Counterparty · Date · Failure reason — the
 * failure column exists even when all rows are healthy, contract 07 §3.1)
 * plus the collection EmptyState and the honest read states.
 *
 * A SERVER component: records arrive from the honest payments plane (either
 * the authoritative API fold or the clearly-marked TEST fixtures); rows are
 * links to the payment detail route (deep-linkable, contract 05 §4).
 */

import Link from "next/link";
import { EmptyState, ListPage, StatusChip } from "@payswap/design";
import type { ListPageRow } from "@payswap/design";

import type { PaymentsReadResult } from "../_server/payments-plane.js";
import type { PaymentRecordView } from "./payment-view.js";
import {
  failureReasonFor,
  formatEventTimestamp,
  formatMoney,
  fundingRailLabel,
} from "./payment-view.js";
import { PaymentsReadState, TestFixturesNotice } from "./read-states.js";

export interface PaymentsCollectionProps {
  readonly read: PaymentsReadResult<readonly PaymentRecordView[]>;
}

export function PaymentsCollection({ read }: PaymentsCollectionProps) {
  if (read.status !== "ok") {
    return (
      <PaymentsReadState
        result={read}
        nextHop={{ href: "/app/payments?start=1", label: "Create a payment" }}
      />
    );
  }

  const rows: ListPageRow[] = read.data.map((payment) => ({
    id: payment.id,
    href: `/app/payments/${encodeURIComponent(payment.id)}`,
    cells: [
      formatMoney(payment.amount),
      <StatusChip key="status" state={payment.state} detail={payment.stateDetail} />,
      payment.method?.rail ?? fundingRailLabel(payment.fundingRail),
      payment.description ?? "—",
      payment.counterparty.name,
      formatEventTimestamp(payment.createdAt),
      // The failure-reason column: registry label for failed rows, "—" for
      // healthy ones (present-but-empty — contract 07 §3.1).
      failureReasonFor(payment.failureReasonId)?.label ?? "—",
    ],
  }));

  return (
    <div className="cc-stack">
      {read.source === "test-fixtures" ? <TestFixturesNotice /> : null}
      <ListPage
        title="Payments"
        data-testid="payments-list"
        create={
          <Link href="/app/payments?start=1" className="ps-button ps-button--md ps-button--primary">
            Create a payment
          </Link>
        }
        secondaryActions={
          <Link href="/app/payments/link" className="ps-button ps-button--md ps-button--secondary">
            Payment link
          </Link>
        }
        columns={[
          "Amount",
          "Status",
          "Rail/Method",
          "Description",
          "Counterparty",
          "Date",
          "Failure reason",
        ]}
        rows={rows}
        empty={
          <EmptyState
            title="No payments yet — money movement starts here"
            description={
              <>
                Create your first payment (the W1 flow works end-to-end in
                test mode — every state renders honestly), or share a payment
                link and let the money come to you.
              </>
            }
            action={
              <Link href="/app/payments?start=1" className="ps-button ps-button--md ps-button--primary">
                Create a payment
              </Link>
            }
            teachingLine="Test mode: composing, validation and the honest submission states are all exercisable without touching real money."
          />
        }
        pagination={
          rows.length > 0
            ? { from: 1, to: rows.length, total: rows.length }
            : undefined
        }
      />
    </div>
  );
}

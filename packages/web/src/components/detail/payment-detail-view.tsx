/**
 * UX-004 — the payment object-detail anatomy (contract 05 §2, the exemplar).
 *
 * ONE anatomy, top to bottom, in the contract's order:
 *   1. header (ObjectDetailHeader: display amount · StatusChip · strapline ·
 *      failure-reason line for failed payments · primary action (Refund) ·
 *      overflow);
 *   2. ActivityTimeline with [Add note] (reverse-chronological human events);
 *   3. context cards — execution summary · money breakdown (the MANDATORY
 *      cross-rail sentence whenever source ≠ settlement) · method details
 *      (masked) · risk (the honest test-mode line — never a fabricated
 *      score) · payout linkage (expected date → Balances);
 *   4. raw detail card (copyable identifiers, metadata typography);
 *   5. RelatedObjects (cross-object links);
 *   6. receipt/communication history ("No receipts sent" + Send receipt);
 *   7. events log (a human sentence per state change + expandable raw rows).
 *
 * A SERVER component: all data arrives as view records (authority-derived);
 * the interactive affordances (refund modal, copy, notes, send-receipt) are
 * the small client islands imported below. No financial state lives here.
 */

import Link from "next/link";
import {
  KeyValue,
  ObjectDetailHeader,
  Panel,
  RelatedObjects,
} from "@payswap/design";
import type { RelatedObjectsGroup } from "@payswap/design";

import type { PaymentRecordView } from "@/app/app/payments/_view/payment-view";
import {
  composeRegistrySentence,
  crossRailSentence,
  formatEventTimestamp,
  formatMoney,
  isCrossRail,
  netAmountFor,
  paymentPrimaryAction,
  paymentStrapline,
  refundRemainingLine,
  refundTotalsFor,
} from "@/app/app/payments/_view/payment-view";

import { ActivityWithNotes } from "./activity-with-notes";
import { CopyableField } from "./copyable-field";
import { HonestNotYetAction } from "./honest-action";
import { RefundWorkflow } from "@/components/workflows/refund-workflow";

export interface PaymentDetailViewProps {
  readonly payment: PaymentRecordView;
  /** Which world the record came from (stated on the surface). */
  readonly worldLabel: string;
}

const SEND_RECEIPT_HONEST_MESSAGE =
  "Receipts are sent by the authoritative PaySwap API against the payment record — no receipt-dispatch path is wired in this deployment, so nothing was sent and no recipient was contacted. This is the honest not-yet state, not a failure.";

export function PaymentDetailView({ payment, worldLabel }: PaymentDetailViewProps) {
  // The failure-reason line comes from the CERTIFIED registry (composeErrorSentence
  // under the view helper) — never inline free text (contract 07 §2/§4).
  const reasonLine =
    payment.failureReasonId === undefined
      ? null
      : composeRegistrySentence(payment.failureReasonId);
  const totals = refundTotalsFor(payment);
  const remainingLine = refundRemainingLine(payment);
  const net = netAmountFor(payment);
  const primary = paymentPrimaryAction(payment);

  return (
    <section aria-labelledby="payment-detail-heading" className="cc-stack" data-payment-id={payment.id}>
      <p id="payment-detail-heading" className="ps-sr-only">
        Payment {payment.id}
      </p>

      {/* 1 — Header */}
      <ObjectDetailHeader
        amount={formatMoney(payment.amount)}
        state={payment.state}
        stateDetail={payment.stateDetail}
        strapline={paymentStrapline(payment)}
        reason={reasonLine ?? payment.failureTechnical}
        primaryAction={<PrimaryAction payment={payment} kind={primary.kind} />}
        overflowMenu={
          <details className="ps-panel ps-detail-overflow">
            <summary className="ps-panel__heading">More</summary>
            <div className="ps-panel__body cc-stack">
              <p className="cc-actions__reason">
                Record source: {worldLabel}. Environment:{" "}
                {payment.environment === "test" ? "test" : "live"}.
              </p>
              <CopyableField label="Payment ID" value={payment.id} />
            </div>
          </details>
        }
      />

      {/* The partially-refunded remaining-amount line (W4 §2). */}
      {remainingLine !== null ? (
        <p className="cc-actions__reason" data-testid="refund-remaining-line">
          <strong>{remainingLine}</strong> · {formatMoney(totals.refunded)} already
          returned.
        </p>
      ) : null}

      {/* 2 — ActivityTimeline with [Add note] */}
      <ActivityWithNotes
        paymentId={payment.id}
        entries={[...payment.events]
          .sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1))
          .map((event) => ({
            id: event.id,
            description: event.sentence,
            timestamp: formatEventTimestamp(event.occurredAt),
            ...(event.actor === undefined ? {} : { actor: event.actor }),
          }))}
      />

      {/* 3 — Context cards */}
      <div className="cc-grid">
        <Panel title="Execution summary" description="Who paid, for what, and the total." headingLevel={2}>
          <KeyValue
            entries={[
              { key: "Counterparty", value: payment.counterparty.name },
              ...(payment.counterparty.email === undefined
                ? []
                : [{ key: "Email", value: payment.counterparty.email }]),
              ...(payment.items === undefined || payment.items.length === 0
                ? []
                : payment.items.map((item) => ({
                    key: `${item.quantity} × ${item.name}`,
                    value: formatMoney(item.amount),
                  }))),
              { key: "Total", value: formatMoney(payment.amount) },
              ...(payment.description === undefined
                ? []
                : [{ key: "Description", value: payment.description }]),
              ...(payment.descriptor === undefined
                ? []
                : [{ key: "Statement descriptor", value: payment.descriptor, mono: true }]),
            ]}
          />
        </Panel>

        <Panel
          title="Money breakdown"
          description="What the customer paid, what the route cost, what nets to you."
          headingLevel={2}
        >
          <div className="cc-stack">
            {isCrossRail(payment) ? (
              <p className="cc-actions__reason" data-testid="cross-rail-sentence">
                <strong>{crossRailSentence(payment)}</strong>
              </p>
            ) : null}
            <KeyValue
              entries={[
                { key: "Payment amount", value: formatMoney(payment.amount) },
                ...(payment.fees === undefined
                  ? [{ key: "Route/network fees", value: "— (no fee record on this payment)" }]
                  : [{ key: "Route/network fees", value: formatMoney(payment.fees) }]),
                ...(net === undefined
                  ? []
                  : [{ key: "Net amount", value: formatMoney(net) }]),
              ]}
            />
            {payment.refunds.length > 0 ? (
              <KeyValue
                entries={payment.refunds.map((refund) => ({
                  key: `Refund ${formatMoney(refund.amount)}`,
                  value: (
                    <span id={`refund-${refund.id}`}>
                      <span className="ps-mono">{refund.id}</span>
                      {refund.reasonId === undefined ? "" : ` · reason: ${refund.reasonId}`}
                    </span>
                  ),
                }))}
              />
            ) : null}
          </div>
        </Panel>

        <Panel title="Method details" description="The paying method, masked; checks as recorded." headingLevel={2}>
          <KeyValue
            entries={
              payment.method === undefined
                ? [
                    {
                      key: "Method",
                      value: "No method recorded on this payment yet (honest absence — never invented)",
                    },
                  ]
                : [
                    { key: "Method", value: payment.method.maskedLine },
                    { key: "Rail", value: payment.method.rail },
                    ...(payment.method.expiry === undefined
                      ? []
                      : [{ key: "Expiry", value: payment.method.expiry }]),
                    ...payment.method.checks.map((check) => ({
                      key: check.label,
                      value: check.passed
                        ? `Passed${check.detail === undefined ? "" : ` — ${check.detail}`}`
                        : `Not passed${check.detail === undefined ? "" : ` — ${check.detail}`}`,
                    })),
                    ...(payment.method.origin === undefined
                      ? []
                      : [{ key: "Origin", value: payment.method.origin }]),
                    ...(payment.method.issuer === undefined
                      ? []
                      : [{ key: "Issuer", value: payment.method.issuer }]),
                  ]
            }
          />
        </Panel>

        <Panel title="Risk" description="Risk factors when they exist; honesty when they do not." headingLevel={2}>
          <KeyValue
            entries={[
              {
                key: "Risk insights",
                value:
                  payment.environment === "test"
                    ? "Risk insights are only available for live data — this is a test record, so no score is shown (never fabricated)."
                    : "No risk factors are recorded on this payment yet — scores appear only from live risk data, never inferred.",
              },
            ]}
          />
        </Panel>

        <Panel
          title="Payout"
          description="Where this payment's money flows next — navigable end-to-end."
          headingLevel={2}
        >
          {payment.settlement === undefined ? (
            <KeyValue
              entries={[
                {
                  key: "Settlement",
                  value: "Not settled yet — the payout linkage appears once this payment settles.",
                },
              ]}
            />
          ) : (
            <KeyValue
              entries={[
                { key: "Settles in", value: `${payment.settlement.asset} via ${payment.settlement.rail}` },
                ...(payment.settlement.expectedDate === undefined
                  ? []
                  : [
                      {
                        key: "Expected",
                        value: (
                          <Link href="/app/balances" className="font-semibold text-emerald-800 underline">
                            {payment.settlement.expectedDate} — view in Balances
                          </Link>
                        ),
                      },
                    ]),
                ...(payment.settlement.settlementId === undefined
                  ? []
                  : [{ key: "Settlement record", value: payment.settlement.settlementId, mono: true }]),
              ]}
            />
          )}
        </Panel>
      </div>

      {/* 4 — Raw detail card (copyable identifiers) */}
      <Panel
        title="Raw detail"
        description="Identifiers exactly as recorded — click Copy to take one. Secrets never appear here; public identifiers do."
        headingLevel={2}
      >
        <KeyValue
          entries={[
            {
              key: "Payment ID",
              value: <CopyableField label="Payment ID" value={payment.id} testId="copy-payment-id" />,
            },
            ...(payment.method === undefined
              ? []
              : [
                  {
                    key: "Method identifier",
                    value: (
                      <CopyableField
                        label="Method identifier"
                        value={payment.method.fullIdentifier}
                        display={payment.method.maskedLine}
                        testId="copy-method-id"
                      />
                    ),
                  },
                ]),
            ...(payment.settlement?.settlementId === undefined
              ? []
              : [
                  {
                    key: "Settlement ID",
                    value: (
                      <CopyableField
                        label="Settlement ID"
                        value={payment.settlement.settlementId}
                        testId="copy-settlement-id"
                      />
                    ),
                  },
                ]),
            ...(payment.relatedIds?.linkId === undefined
              ? []
              : [
                  {
                    key: "Payment link ID",
                    value: <CopyableField label="Payment link ID" value={payment.relatedIds.linkId} />,
                  },
                ]),
            ...(payment.counterparty.customerId === undefined
              ? []
              : [
                  {
                    key: "Customer ID",
                    value: (
                      <CopyableField label="Customer ID" value={payment.counterparty.customerId} />
                    ),
                  },
                ]),
            ...(payment.failureTechnical === undefined
              ? []
              : [{ key: "Failure detail (verbatim)", value: payment.failureTechnical }]),
          ]}
        />
      </Panel>

      {/* 5 — RelatedObjects */}
      <Panel title="Related" description="Cross-object links — the same drill path everywhere." headingLevel={2}>
        <RelatedObjects groups={relatedGroups(payment)} />
      </Panel>

      {/* 6 — Receipt / communication history */}
      <Panel title="Receipts" description="Every receipt sent for this payment, and the send affordance." headingLevel={2}>
        <div className="cc-stack">
          {payment.receiptsSent === 0 ? (
            <p className="cc-actions__reason">No receipts sent.</p>
          ) : (
            <KeyValue
              entries={[{ key: "Receipts sent", value: String(payment.receiptsSent) }]}
            />
          )}
          <HonestNotYetAction label="Send receipt" message={SEND_RECEIPT_HONEST_MESSAGE} />
        </div>
      </Panel>

      {/* 7 — Events log (human sentences + expandable raw rows) */}
      <Panel
        title="Events"
        description="Every state change as a human sentence — the audit trail and the reconciliation UI. Raw rows expand below each sentence."
        headingLevel={2}
      >
        <ol className="cc-stack" data-testid="payment-events-log">
          {[...payment.events]
            .sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1))
            .map((event) => (
              <li key={event.id} className="cc-stack">
                <p className="cc-actions__reason">
                  <span className="ps-num">{formatEventTimestamp(event.occurredAt)}</span> —{" "}
                  {event.sentence}
                  {event.actor === undefined ? "" : ` · ${event.actor}`}
                </p>
                {event.raw === undefined ? null : (
                  <details>
                    <summary className="cc-actions__reason">Raw event</summary>
                    <pre className="ps-mono cc-actions__reason">
                      {JSON.stringify({ id: event.id, ...event.raw }, null, 2)}
                    </pre>
                  </details>
                )}
              </li>
            ))}
        </ol>
      </Panel>
    </section>
  );
}

function PrimaryAction({
  payment,
  kind,
}: {
  readonly payment: PaymentRecordView;
  readonly kind: ReturnType<typeof paymentPrimaryAction>["kind"];
}) {
  switch (kind) {
    case "refund":
      return <RefundWorkflow payment={payment} />;
    case "retry":
      return (
        <Link
          href="/app/payments?start=1"
          className="ps-button ps-button--md ps-button--primary"
        >
          Retry as a new payment
        </Link>
      );
    case "send-receipt":
      return <HonestNotYetAction label="Send receipt" message={SEND_RECEIPT_HONEST_MESSAGE} variant="primary" size="md" />;
    default:
      return null;
  }
}

function relatedGroups(payment: PaymentRecordView): RelatedObjectsGroup[] {
  const groups: RelatedObjectsGroup[] = [];
  if (payment.refunds.length > 0) {
    groups.push({
      id: "refunds",
      title: "Refunds",
      links: payment.refunds.map((refund) => ({
        href: `#refund-${refund.id}`,
        label: refund.id,
        meta: formatMoney(refund.amount),
      })),
    });
  }
  if (payment.settlement?.settlementId !== undefined) {
    groups.push({
      id: "settlement",
      title: "Settlement",
      links: [
        {
          href: "/app/balances",
          label: payment.settlement.settlementId,
          meta: `${payment.settlement.asset} · ${payment.settlement.rail}`,
        },
      ],
    });
  }
  if (payment.relatedIds?.linkId !== undefined) {
    groups.push({
      id: "link",
      title: "Payment link",
      links: [
        {
          href: `/app/payments/link/${payment.relatedIds.linkId}`,
          label: payment.relatedIds.linkId,
        },
      ],
    });
  }
  if (payment.counterparty.customerId !== undefined) {
    groups.push({
      id: "customer",
      title: "Customer",
      links: [
        {
          href: "/app/customers",
          label: payment.counterparty.name,
          meta: payment.counterparty.customerId,
        },
      ],
    });
  }
  return groups;
}

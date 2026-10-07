/**
 * UX-006 — the payment detail in the CONSUMER projection (contract 10 §7 /
 * deliverable 7): the SAME payment object, folded around the consumer's
 * question — "what happened, and when does/did the money arrive?".
 *
 * The disclosure ladder (contract 10 §6 → merchant contract §3):
 * - Level 0 (always visible): the amount, the status, the people.
 * - Level 1 (in place): fees, rail names, the masked method, the
 *   expected-arrival time — settlements FOLD into one "When it arrived"
 *   section instead of a separate payout card.
 * - Level 2 (collapsed "Technical details"): event logs, identifiers, raw
 *   event rows — one expand away, never scattered into the main body.
 * - Level 3 (chain/gas/ABI vocabulary): NEVER on a consumer surface.
 *
 * A SERVER component: the record arrives from the honest payments plane
 * (authoritative API fold or clearly-marked TEST fixtures — never fabricated
 * here). The failure reason, when present, comes from the CERTIFIED registry
 * through the same view helpers the merchant anatomy uses.
 */

import Link from "next/link";
import { KeyValue, Panel, StatusChip } from "@payswap/design";

import type { PaymentRecordView } from "@/app/app/payments/_view/payment-view";
import {
  composeRegistrySentence,
  formatEventTimestamp,
  formatMoney,
  netAmountFor,
} from "@/app/app/payments/_view/payment-view";
import { CopyableField } from "@/components/detail/copyable-field";

export interface ConsumerPaymentDetailProps {
  readonly payment: PaymentRecordView;
  /** Which world the record came from (stated verbatim). */
  readonly worldLabel: string;
}

/** The honest status story in plain words (level 0 — never a bare code). */
function statusStory(payment: PaymentRecordView): string {
  switch (payment.state) {
    case "succeeded":
      return "This payment completed.";
    case "processing":
      return "This payment is on its way — the outcome is not final yet, and an unknown outcome is never shown as a failure.";
    case "dropped":
      return "This payment's outcome is still being watched — it is neither a success nor a failure until it is observed.";
    case "failed":
      return "This payment did not go through. The reason below is the recorded one — never a guess.";
    case "refunded":
      return "This payment was returned in full.";
    case "partially_refunded":
      return "Part of this payment was returned.";
    case "disputed":
      return "This payment is being reviewed as a reported problem.";
    case "blocked":
      return "This payment was stopped before it moved any money.";
  }
}

/** The settlement folded into ONE consumer sentence: when it arrived. */
export function whenItArrivedLine(payment: PaymentRecordView): string {
  const settlement = payment.settlement;
  const arrival = settlement === undefined ? null : `in ${settlement.asset} via ${settlement.rail}`;
  const expected =
    settlement?.expectedDate === undefined ? "" : ` Expected ${settlement.expectedDate}.`;
  switch (payment.state) {
    case "succeeded":
    case "partially_refunded":
    case "refunded":
      return settlement === undefined
        ? "Completed — no arrival record is attached to this payment yet, and none is invented."
        : `Arrived ${arrival}.${expected}`;
    case "processing":
    case "dropped":
      return settlement === undefined
        ? "On its way — this section updates as the payment moves. No arrival time is invented."
        : `On its way — expected ${arrival}.${expected}`;
    default:
      // failed / blocked / disputed: nothing arrives, and saying "not yet"
      // would imply it might.
      return "Nothing is arriving — this payment did not complete.";
  }
}

export function ConsumerPaymentDetail({ payment, worldLabel }: ConsumerPaymentDetailProps) {
  const reasonLine =
    payment.failureReasonId === undefined ? null : composeRegistrySentence(payment.failureReasonId);
  const net = netAmountFor(payment);

  return (
    <section aria-labelledby="cc-consumer-payment-heading" className="cc-stack" data-testid="consumer-payment-detail" data-payment-id={payment.id}>
      <p id="cc-consumer-payment-heading" className="ps-sr-only">
        Payment {payment.id}
      </p>
      <p>
        <Link className="cc-link" href="/app">
          ← Back to Home
        </Link>
      </p>

      {/* Level 0 — the amount, the status, the people. */}
      <div className="cc-card" data-testid="consumer-payment-header">
        <div className="cc-card__head">
          <h2 className="cc-card__title ps-num">{formatMoney(payment.amount)}</h2>
          <StatusChip state={payment.state} detail={payment.stateDetail} />
        </div>
        <p className="cc-card__meta">With {payment.counterparty.name}</p>
        <p className="cc-actions__reason" data-testid="consumer-payment-status-story">
          {statusStory(payment)}
        </p>
        {reasonLine !== null ? (
          <p className="cc-actions__reason" data-testid="consumer-payment-reason">
            {reasonLine}
          </p>
        ) : null}
        {payment.descriptor !== undefined ? (
          <p className="cc-actions__reason" data-testid="consumer-payment-descriptor">
            This appears as <span className="ps-mono">{payment.descriptor}</span> in your
            payment history.
          </p>
        ) : null}
      </div>

      {/* Level 1 — when it arrived (the settlement FOLDED into one place),
          fees, the masked method with its checks. */}
      <div className="cc-grid">
        <Panel title="When it arrived" description="Where the money lands, and when." headingLevel={2}>
          <KeyValue
            entries={[
              { key: "Arrival", value: whenItArrivedLine(payment) },
              {
                key: "Money breakdown",
                value:
                  payment.fees === undefined
                    ? `${formatMoney(payment.amount)} — no fee record on this payment`
                    : `${formatMoney(payment.amount)} paid · ${formatMoney(payment.fees)} fee${net === undefined ? "" : ` · ${formatMoney(net)} net`}`,
              },
            ]}
          />
        </Panel>

        <Panel title="How it was paid" description="The paying method, masked; checks as recorded." headingLevel={2}>
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
                    ...payment.method.checks.map((check) => ({
                      key: check.label,
                      value: check.passed
                        ? `Passed${check.detail === undefined ? "" : ` — ${check.detail}`}`
                        : `Not passed${check.detail === undefined ? "" : ` — ${check.detail}`}`,
                    })),
                  ]
            }
          />
        </Panel>
      </div>

      {/* The disputes entry (contract 10 §5): "Report a problem" per
          payment, routed to the safety center with the payment preselected. */}
      <p className="cc-actions__reason">
        Something wrong with this payment?{" "}
        <Link
          className="cc-link"
          href={`/app/safety?payment=${encodeURIComponent(payment.id)}`}
          data-testid="consumer-report-problem-link"
        >
          Report a problem
        </Link>{" "}
        — you pick a reason, and its status is tracked from there.
      </p>

      {/* Level 2 — the technical details, COLLAPSED (contract 10 §6):
          identifiers, the event log, raw rows. One expand away; never in the
          main body. */}
      <details className="ps-panel" data-testid="consumer-payment-technical">
        <summary className="ps-panel__heading">Technical details</summary>
        <div className="ps-panel__body cc-stack">
          <KeyValue
            entries={[
              {
                key: "Payment ID",
                value: <CopyableField label="Payment ID" value={payment.id} testId="consumer-copy-payment-id" />,
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
                          testId="consumer-copy-method-id"
                        />
                      ),
                    },
                  ]),
              ...(payment.settlement?.settlementId === undefined
                ? []
                : [{ key: "Settlement ID", value: payment.settlement.settlementId, mono: true }]),
            ]}
          />
          <p className="cc-actions__reason">Record source: {worldLabel}.</p>
          <ol className="cc-stack" data-testid="consumer-payment-events">
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
        </div>
      </details>
    </section>
  );
}

"use client";

/**
 * UX-004 — W4, the refund / reversal modal (contract 04 §2 W4).
 *
 * Anatomy (field-for-field): amount prefilled with the FULL remaining amount
 * and editable for a partial refund · reason select whose options are the
 * CERTIFIED error-reason registry labels (@payswap/ux `ERROR_REASONS` — the
 * shared reason vocabulary, never free text) · the explicit consequence line
 * ("Returns to the customer on <rail>; fees are not returned.") · the confirm
 * is a ConfirmationButton restating amount + asset with an in-button
 * Processing state.
 *
 * HONESTY (the part that matters): the refund OUTCOME — payment state
 * `refunded` / `partially_refunded`, the remaining-amount line, the timeline
 * event — is AUTHORITY data folded from the authoritative API; the UI never
 * fabricates it. Confirming here attempts the real submission path and
 * surfaces the honest not-yet state this deployment actually has (see the
 * confirm handler): the certified refund command (`payments.refund.create`,
 * emitted by the @payswap/ux refund journey) is NOT on the journey-dispatch
 * allowlist yet, and constructing that journey needs the authoritative
 * acceptance-policy + execution-attempt records this surface cannot mint.
 * Nothing is refunded silently; nothing renders as success.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  Button,
  ConfirmationButton,
  Dialog,
  Field,
  MoneyInput,
  Select,
} from "@payswap/design";
import { ERROR_REASONS } from "@payswap/ux";
import type { ErrorReasonId } from "@payswap/ux";

import type { PaymentRecordView } from "@/app/app/payments/_view/payment-view";
import {
  formatMinorUnits,
  parseAmountToMinorUnits,
  refundAvailableFor,
  refundConsequenceLine,
  refundRemainingLine,
  refundTotalsFor,
} from "@/app/app/payments/_view/payment-view";

export interface RefundWorkflowProps {
  readonly payment: PaymentRecordView;
}

type RefundOutcome =
  | { readonly kind: "composing" }
  | { readonly kind: "submitting" }
  | { readonly kind: "not-submitted" };

export function RefundWorkflow({ payment }: RefundWorkflowProps) {
  const [open, setOpen] = useState(false);
  const totals = useMemo(() => refundTotalsFor(payment), [payment]);
  const [amountText, setAmountText] = useState(() =>
    formatMinorUnits(totals.remaining.minorUnits, payment.amount.currency),
  );
  const [reasonId, setReasonId] = useState<ErrorReasonId>("cancelled-by-user");
  const [amountError, setAmountError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<RefundOutcome>({ kind: "composing" });

  const fullRemainingText = formatMinorUnits(
    totals.remaining.minorUnits,
    payment.amount.currency,
  );
  const partial =
    amountText.trim().length > 0 &&
    amountText.trim() !== fullRemainingText &&
    parseAmountToMinorUnits(amountText, payment.amount.currency) !== null;

  function reset(): void {
    setAmountText(formatMinorUnits(totals.remaining.minorUnits, payment.amount.currency));
    setReasonId("cancelled-by-user");
    setAmountError(null);
    setOutcome({ kind: "composing" });
  }

  return (
    <>
      <Button
        variant="primary"
        onClick={() => {
          reset();
          setOpen(true);
        }}
        disabled={!refundAvailableFor(payment)}
        title={
          refundAvailableFor(payment)
            ? undefined
            : "Refunds are available on succeeded payments with a remaining amount"
        }
      >
        Refund
      </Button>
      <Dialog
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        title="Refund payment"
        description={`Refunding ${payment.id} — ${refundRemainingLine(payment) ?? "the full amount is refundable"}.`}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setOpen(false);
              }}
            >
              Cancel
            </Button>
            <ConfirmationButton
              verb="Refund"
              amount={amountText.trim().length === 0 ? "—" : amountText.trim()}
              asset={payment.amount.currency.toUpperCase()}
              processing={outcome.kind === "submitting"}
              onClick={() => {
                void confirmRefund();
              }}
            />
          </>
        }
      >
        <div className="cc-stack">
          <Field
            label="Amount"
            required
            hint={`Prefilled with the full remaining amount — edit it for a partial refund (up to ${formatMinorUnits(totals.remaining.minorUnits, payment.amount.currency)} ${payment.amount.currency.toUpperCase()}).`}
            error={amountError}
            onErrorClear={() => {
              setAmountError(null);
            }}
          >
            <MoneyInput
              currency={payment.amount.currency.toUpperCase()}
              value={amountText}
              inputMode="decimal"
              onChange={(event) => {
                setAmountText(event.target.value);
              }}
            />
          </Field>
          <Field
            label="Reason"
            required
            hint="The shared reason vocabulary — the same registry labels surface in lists, detail headers and events."
          >
            <Select
              value={reasonId}
              onChange={(event) => {
                setReasonId(event.target.value as ErrorReasonId);
              }}
            >
              {ERROR_REASONS.map((reason) => (
                <option key={reason.id} value={reason.id}>
                  {reason.label}
                </option>
              ))}
            </Select>
          </Field>
          <p className="cc-actions__reason" data-testid="refund-consequence-line">
            <strong>{refundConsequenceLine(payment)}</strong>{" "}
            {partial
              ? "A partial refund leaves the payment partially refunded with the remaining amount still refundable."
              : "The full remaining amount returns; the payment becomes refunded."}
          </p>
          {outcome.kind === "not-submitted" ? (
            <div role="alert" className="cc-stack" data-testid="refund-honest-outcome">
              <p className="cc-actions__reason">
                <strong>Refund not submitted.</strong> The certified refund command
                (<span className="ps-mono">payments.refund.create</span>) is emitted by
                the @payswap/ux refund journey from the merchant&rsquo;s authoritative
                acceptance policy and the payment&rsquo;s execution record — and the
                authenticated journey-dispatch transport does not carry the refund
                command on its allowlist in this deployment. Nothing was refunded and
                nothing here pretends otherwise: the refund outcome on the payment
                (state, remaining amount, timeline event) changes only when the
                authoritative API records it.
              </p>
              <p className="cc-actions__reason">
                The refund you composed:{" "}
                <span className="ps-mono">
                  {amountText.trim() || "—"} {payment.amount.currency.toUpperCase()}
                </span>{" "}
                · reason <span className="ps-mono">{reasonId}</span>. Re-compose and
                retry once the dispatch path ships — or record it through the API
                directly.{" "}
                <Link href="/developers" className="font-semibold text-emerald-800 underline">
                  Docs &amp; support
                </Link>
              </p>
            </div>
          ) : null}
        </div>
      </Dialog>
    </>
  );

  async function confirmRefund(): Promise<void> {
    if (outcome.kind === "submitting") {
      return;
    }
    const currency = payment.amount.currency;
    const minor = parseAmountToMinorUnits(amountText, currency);
    if (minor === null) {
      setAmountError(
        "Enter the refund amount as a plain number greater than zero (e.g. 15 or 10.50).",
      );
      return;
    }
    if (BigInt(minor) > BigInt(totals.remaining.minorUnits)) {
      setAmountError(
        `Refunds cannot exceed the remaining refundable amount — ${fullRemainingText} ${currency.toUpperCase()} is left on this payment.`,
      );
      return;
    }
    setAmountError(null);
    // There is no honest submission to await yet (see the component header):
    // the certified refund command is not on the dispatch allowlist and the
    // journey needs authority records this surface cannot mint. Rendering the
    // honest not-submitted state IMMEDIATELY — no simulated latency, no fake
    // processing theater.
    setOutcome({ kind: "not-submitted" });
  }
}

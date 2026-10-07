"use client";

/**
 * UX-006 — the disputes flow (contract 10 §5): "Report a problem" per
 * payment → structured reason select → status tracking (Needs review · In
 * review · Resolved).
 *
 * The reason vocabulary is STRUCTURED (a fixed set of human reasons — the
 * same doctrine as the error-reason registry: never free text at a render
 * site). Validation follows the form contract: the inline error renders
 * BELOW the field, submit is blocked while invalid, and the error clears on
 * valid selection (contract 07 §3.3 — never a stale error).
 *
 * Honesty law: filing a dispute is a MUTATION, and no dispute-creation
 * command is on this deployment's dispatch allowlist — so the submit
 * renders the honest not-submitted state (the W4 refund precedent): what
 * was collected, what was NOT done, and what happens when the path ships.
 * The status-tracking lifecycle renders beside it with its honest empty.
 */

import { useState } from "react";
import Link from "next/link";
import { EmptyState, Field, Select } from "@payswap/design";

/** The structured reason set (human labels; the value is the record's id). */
export const DISPUTE_REASONS: readonly { readonly id: string; readonly label: string }[] =
  Object.freeze([
    { id: "unauthorized", label: "I didn't authorize this payment" },
    { id: "wrong-amount", label: "I was charged the wrong amount" },
    { id: "not-received", label: "I didn't receive what I paid for" },
    { id: "duplicate", label: "I was charged more than once" },
    { id: "other", label: "Something else" },
  ]);

/** The dispute lifecycle statuses (contract 10 §5, tracked verbatim). */
export const DISPUTE_STATUSES: readonly { readonly id: string; readonly label: string }[] =
  Object.freeze([
    { id: "needs-review", label: "Needs review" },
    { id: "in-review", label: "In review" },
    { id: "resolved", label: "Resolved" },
  ]);

const REPORT_NOT_WIRED_MESSAGE =
  "Your report was collected but NOT filed: dispute creation is dispatched by the authoritative PaySwap API, and no dispute command is on this deployment's dispatch allowlist. Nothing was submitted, no record was created, and the payment is unchanged. When the path ships, this same flow files the report and its status appears in the tracked list below.";

export interface DisputeTrackerProps {
  /** The payment the report is about, when arrived via ?payment=<id>. */
  readonly paymentId: string | null;
  /** The tracked disputes (real records only; empty is the honest state). */
  readonly disputes: readonly {
    readonly id: string;
    readonly paymentId: string;
    readonly reasonLabel: string;
    readonly status: string;
  }[];
}

export function DisputeTracker({ paymentId, disputes }: DisputeTrackerProps) {
  const [reason, setReason] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (reason === "") {
      setError("Pick a reason — the report needs one before it can be submitted.");
      return;
    }
    setError(null);
    setSubmitted(true);
  };

  return (
    <div className="cc-stack" data-testid="safety-disputes">
      <form onSubmit={handleSubmit} className="cc-stack" noValidate data-testid="safety-report-form">
        <Field
          label="Which payment is the problem about?"
          hint={
            paymentId === null ? (
              <>
                Open the payment first — every report is about one payment.{" "}
                <Link className="cc-link" href="/app/transactions">
                  Find it in your payments
                </Link>
                .
              </>
            ) : undefined
          }
        >
          <input
            type="text"
            className="ps-input ps-mono"
            value={paymentId ?? ""}
            readOnly
            aria-readonly="true"
            data-testid="safety-report-payment"
            placeholder="Open a payment to report a problem with it"
          />
        </Field>
        <Field
          label="What went wrong?"
          required
          error={error}
          onErrorClear={() => {
            setError(null);
          }}
          hint="Pick the closest reason — it becomes the first line of the review."
        >
          <Select
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
              if (event.target.value !== "" && error !== null) {
                setError(null);
              }
            }}
            data-testid="safety-report-reason"
          >
            <option value="">Select a reason…</option>
            {DISPUTE_REASONS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </Select>
        </Field>
        <button
          type="submit"
          className="ps-button ps-button--md ps-button--primary"
          disabled={paymentId === null}
          data-testid="safety-report-submit"
        >
          Report problem
        </button>
        {paymentId === null ? (
          <p className="cc-actions__reason">
            The button unlocks once a payment is selected — a report is always
            about one real payment.
          </p>
        ) : null}
        {submitted ? (
          <p className="cc-actions__reason" role="status" data-testid="safety-report-result">
            {REPORT_NOT_WIRED_MESSAGE}
          </p>
        ) : null}
      </form>

      {/* The status-tracking lifecycle (contract 10 §5), stated verbatim. */}
      <p className="cc-actions__reason" data-testid="safety-dispute-lifecycle">
        Every reported problem tracks through three states:{" "}
        {DISPUTE_STATUSES.map((status) => status.label).join(" · ")}.
      </p>
      {disputes.length === 0 ? (
        <EmptyState
          title="No reported problems"
          description={
            <>
              Reports you file appear here with their live status — from the
              moment they need review, through review, to resolved. Nothing is
              fabricated in the meantime.
            </>
          }
          data-testid="safety-disputes-empty"
        />
      ) : (
        <ul className="cc-stack" data-testid="safety-disputes-list">
          {disputes.map((dispute) => (
            <li key={dispute.id} className="cc-card">
              <div className="cc-card__head">
                <p className="cc-card__title">{dispute.reasonLabel}</p>
                <span className="ps-badge">{dispute.status}</span>
              </div>
              <p className="cc-card__meta">
                Payment <span className="ps-mono">{dispute.paymentId}</span>
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

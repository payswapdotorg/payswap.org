"use client";

/**
 * The Pay journey LIVE view (P3-W2-002; end-to-end continuity by P3-W3-002;
 * converged by UX-004).
 *
 * The W1 COMPOSING surface that used to live here (the minor-units form) is
 * CONVERGED — contract 04 §2 W1 now renders through
 * `components/workflows/create-payment-workflow.tsx` (segmented schedule,
 * currency-prefixed MoneyInput, counterparty combobox, statement descriptor,
 * funding-rail dependent-disable, ConfirmationButton restating amount+asset,
 * dual-submit). This module keeps what W1 still consumes once the payment is
 * in flight: the certified PayJourney contract rendered live.
 *
 * Laws honored structurally:
 * - capability selection ONLY from connected instances (the options derive
 *   from authority records passed in by the server; the catalogue is never
 *   an execution surface — comparison-only route candidates say so);
 * - submission dispatches through the REAL authenticated transport
 *   (/api/journeys/dispatch → the authoritative PaySwap API) and the answer
 *   folds VERBATIM through the contract — the deployed runtime's honest
 *   401/403 session answer renders as the honest state, never a fake
 *   success (no simulated financial effect is reachable from here);
 * - UNKNOWN is reconciliation, NEVER failure: OUTCOME_UNKNOWN folds to
 *   RECONCILING, renders the UnknownState language (INV-X01) and the
 *   DEDICATED ReconcileJourney surface (ambiguity-recorded → observation →
 *   resolution — resolution only from authority);
 * - the provider customer-action state renders verbatim when tracked
 *   (AWAITING_CUSTOMER_ACTION), with the reauth/customer-action journey
 *   reachable from this surface;
 * - amounts are exact minor units (INV-F01).
 */

import Link from "next/link";
import type { PayJourney, ViewAction } from "@payswap/ux";
import {
  EmptyState,
  KeyValue,
  Panel,
  StatusPill,
  UnknownState,
} from "@payswap/design";

import { JourneyActionList } from "./journey-actions";

const STATE_PILLS: Readonly<Record<string, { tone: "ok" | "attention" | "unknown" | "failed" | "disabled"; label: string }>> = {
  SELECTING_CAPABILITY: { tone: "attention", label: "Selecting capability" },
  REVIEWING_ROUTE: { tone: "attention", label: "Reviewing route" },
  AWAITING_APPROVAL: { tone: "attention", label: "Awaiting approval" },
  SUBMITTED: { tone: "unknown", label: "Submitted — tracking" },
  TRACKING: { tone: "unknown", label: "In progress" },
  RECONCILING: { tone: "unknown", label: "Reconciling — outcome unknown" },
  COMPLETED: { tone: "ok", label: "Completed" },
  FAILED: { tone: "failed", label: "Failed" },
  ABANDONED: { tone: "disabled", label: "Cancelled" },
};

/** The provider customer-action panel — the tracked state verbatim. */
function CustomerActionPanel() {
  return (
    <Panel
      title="Provider customer action required"
      description="The provider is waiting for YOUR action — the tracked state, verbatim (AWAITING_CUSTOMER_ACTION), never reinterpreted."
      headingLevel={3}
      actions={<StatusPill tone="attention">Awaiting customer action</StatusPill>}
    >
      <p className="text-sm leading-6 text-stone-700">
        The external action is parked until you complete the provider&rsquo;s
        required step on the provider&rsquo;s own surface — PaySwap never
        completes it for you, and credentials never cross. If the step-up
        expires or requires reauthorization, the{" "}
        <Link href="/reauth" className="font-semibold text-emerald-800 underline">
          reauthorization journey
        </Link>{" "}
        preserves the lineage and resumes execution under the fresh
        authorization.
      </p>
    </Panel>
  );
}

/**
 * The live-journey view (every state after composition) — consumed by the W1
 * create-payment workflow and exported for tests.
 */
export function PayJourneyView({
  journey,
  onAction,
}: {
  readonly journey: PayJourney;
  readonly onAction: (action: ViewAction) => void;
}) {
  const statePill = STATE_PILLS[journey.stateName] ?? { tone: "unknown" as const, label: journey.stateName };
  const paymentRef = journey.submittedIntentId ?? journey.request.correlationId ?? `pay:${journey.request.amount.currency}`;
  const lastEvidenceRef =
    journey.evidenceRefs.length > 0
      ? String(journey.evidenceRefs[journey.evidenceRefs.length - 1] ?? "")
      : null;
  const evidenceHref =
    lastEvidenceRef !== null && lastEvidenceRef.length > 0
      ? `/app/evidence?action=${encodeURIComponent(paymentRef)}&artifact=${encodeURIComponent(lastEvidenceRef)}`
      : `/app/evidence?action=${encodeURIComponent(paymentRef)}`;
  return (
    <>
      <div>
        <StatusPill tone={statePill.tone}>{statePill.label}</StatusPill>
      </div>
      <KeyValue
        entries={[
          {
            key: "Amount",
            value: `${journey.request.amount.minorUnits} ${journey.request.amount.currency} (minor units)`,
            mono: true,
          },
          { key: "Recipient", value: journey.request.recipient, mono: true },
          { key: "Journey state", value: journey.stateName, mono: true },
        ]}
      />
      {journey.stateName === "SELECTING_CAPABILITY" ? (
        journey.options.length === 0 ? (
          <EmptyState
            title="No connected capability"
            description={
              <>
                Capability selection draws ONLY from connected instances
                (authority records) — and none exist for this viewer yet.
                This is the honest empty state, not an error: the provider
                catalogue is never treated as executable authority.{" "}
                <Link href="/app/capabilities">See provider coverage and connect a capability</Link>{" "}
                once the connection plane ships (parallel work stream).
              </>
            }
          />
        ) : null
      ) : null}
      {journey.stateName === "REVIEWING_ROUTE" && (journey.routeCandidates?.length ?? 0) > 0 ? (
        <Panel
          title="Route comparison"
          description="Catalogue-derived entries are clearly marked COMPARISON-ONLY — the catalogue is never an execution surface. Only routes executing on your connected instance can be submitted."
        >
          <ul className="cc-actions">
            {(journey.routeCandidates ?? []).map((candidate) => (
              <li key={candidate.methodId} className="cc-actions__item">
                <span className="ps-mono">{candidate.methodId}</span>
                <span className="cc-actions__reason">
                  fees {candidate.fees.minorUnits} {candidate.fees.currency} · rail{" "}
                  {candidate.railPath.join(" → ")} · ~{candidate.completionMs}ms
                </span>
                <StatusPill tone={candidate.basedOnInstanceId !== undefined ? "ok" : "disabled"}>
                  {candidate.basedOnInstanceId !== undefined ? "Executable" : "Comparison-only"}
                </StatusPill>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
      {journey.stateName === "TRACKING" && journey.attemptOutcome === "AWAITING_CUSTOMER_ACTION" ? (
        <CustomerActionPanel />
      ) : null}
      {journey.stateName === "RECONCILING" ? (
        <UnknownState
          title="Outcome unknown — reconciling"
          description="Absence of knowledge is not failure. Reconciliation is authoritative for ambiguous external effects (INV-X03); the external write is never blindly retried (INV-X02)."
          action={
            <Link className="ps-button ps-button--sm ps-button--secondary" href={evidenceHref}>
              View the evidence recorded so far
            </Link>
          }
        />
      ) : null}
      {journey.stateName === "FAILED" ? (
        <Panel title="Failed" description="The failure reason comes from protocol evidence, not inference. Retry only as a NEW intent with a fresh idempotency key.">
          <p className="cc-actions__reason">
            The failure evidence is preserved on the journey —{" "}
            <Link
              href={evidenceHref}
              className="font-semibold text-emerald-800 underline"
            >
              inspect the failure evidence
            </Link>
            .
          </p>
        </Panel>
      ) : null}
      {journey.stateName === "COMPLETED" ? (
        <Panel title="Completed" description="Completion is an externally observed effect with its evidence preserved on the journey.">
          <p className="cc-actions__reason">
            <Link
              href={evidenceHref}
              className="font-semibold text-emerald-800 underline"
            >
              Inspect the completion evidence
            </Link>
            .
          </p>
        </Panel>
      ) : null}
      <JourneyActionList heading="Actions" actions={journey.actions} onAction={onAction} />
    </>
  );
}

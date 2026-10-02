"use client";

/**
 * The Pay journey surface (P3-W2-002; end-to-end continuity by P3-W3-002) —
 * the certified PayJourney contract as a live UI.
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
 * - amounts are exact minor units (INV-F01) — the input is a minor-unit
 *   integer, never parsed from a formatted currency string.
 */

import { useState } from "react";
import Link from "next/link";
import type {
  ConnectedCapabilityInstanceRecord,
  CurrencyRoutabilityCheck,
  PayJourney,
  RouteCandidate,
  ViewAction,
} from "@payswap/ux";
import {
  abandonPayJourney,
  applyPaymentSubmissionResponse,
  beginPayJourney,
  selectPayCapability,
} from "@payswap/ux";
import {
  Button,
  EmptyState,
  Field,
  Input,
  KeyValue,
  Panel,
  StatusPill,
  UnknownState,
} from "@payswap/design";

import { JourneyActionList } from "./journey-actions";
import { ReconcileJourneySurface } from "./reconcile-journey-surface";
import { dispatchJourneyApiCommand } from "@/lib/cc/journey-dispatch";

type PayPhase =
  | { readonly kind: "COMPOSING" }
  | { readonly kind: "JOURNEY"; readonly journey: PayJourney };

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

function minorUnitsInput(value: string): string | null {
  const trimmed = value.trim();
  if (!/^\d{1,12}$/.test(trimmed)) {
    return null;
  }
  return trimmed.replace(/^0+(?=\d)/, "");
}

/** The provider customer-action panel — the tracked state verbatim. */
function CustomerActionPanel({ journey }: { readonly journey: PayJourney }) {
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

/** The live-journey view (every state except composing) — exported for tests. */
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
        <CustomerActionPanel journey={journey} />
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

export function PayJourneySurface({
  connectedInstances,
  routabilityChecks,
  routeCandidates,
  autoStart,
  csrfToken,
}: {
  /** Authority records of connected instances (empty until the connect plane ships). */
  readonly connectedInstances: readonly ConnectedCapabilityInstanceRecord[];
  /** Authority routability checks per instance (absent check = honestly not routable). */
  readonly routabilityChecks: readonly CurrencyRoutabilityCheck[];
  /** Route candidates for review (catalogue entries render comparison-only). */
  readonly routeCandidates: readonly RouteCandidate[];
  readonly autoStart: boolean;
  /** The live session's CSRF echo (undefined in the marked preview — no mutations). */
  readonly csrfToken?: string;
}) {
  const [phase, setPhase] = useState<PayPhase>({ kind: "COMPOSING" });
  const [amountMinor, setAmountMinor] = useState("");
  const [currency, setCurrency] = useState("GHS");
  const [recipient, setRecipient] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [dispatchNote, setDispatchNote] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const canCompose =
    minorUnitsInput(amountMinor) !== null && recipient.trim().length > 0 && /^[A-Z]{3}$/.test(currency);

  function begin(): void {
    const minorUnits = minorUnitsInput(amountMinor);
    if (minorUnits === null || recipient.trim().length === 0 || !/^[A-Z]{3}$/.test(currency)) {
      setError("Amount (exact minor units), a 3-letter currency and a recipient are required.");
      return;
    }
    setError(null);
    setPhase({
      kind: "JOURNEY",
      journey: beginPayJourney({
        request: { amount: { currency, minorUnits }, recipient: recipient.trim() },
        connectedInstances,
        routabilityChecks,
      }),
    });
  }

  async function submitPayment(action: ViewAction): Promise<void> {
    if (pending) {
      return;
    }
    setPending(true);
    setError(null);
    setDispatchNote(null);
    try {
      const result = await dispatchJourneyApiCommand("pay", action, csrfToken);
      if (result.kind === "response") {
        try {
          setPhase((current) =>
            current.kind === "JOURNEY"
              ? {
                  kind: "JOURNEY",
                  journey: applyPaymentSubmissionResponse(
                    current.journey,
                    result.response,
                  ),
                }
              : current,
          );
          if (result.response.kind === "error") {
            const errorBody = result.response.body.error;
            setDispatchNote(
              `The PaySwap API answered verbatim — ${errorBody.code} (${errorBody.category}), HTTP ${result.response.status}: ${errorBody.message}. The journey records the error exactly; nothing was submitted.`,
            );
          }
          return;
        } catch {
          setError(
            "The contract refused to fold the API's answer — the journey state is unchanged.",
          );
          return;
        }
      }
      setError(result.message);
    } finally {
      setPending(false);
    }
  }

  function onAction(action: ViewAction): void {
    if (phase.kind !== "JOURNEY") {
      return;
    }
    const journey = phase.journey;
    if (action.actionId.startsWith("select-capability:")) {
      const instanceId = action.actionId.slice("select-capability:".length);
      const option = journey.options.find(
        (candidate) => candidate.instance.instanceId === instanceId,
      );
      if (option === undefined) {
        setError("That capability is not among this journey's connected instance options.");
        return;
      }
      try {
        setPhase({
          kind: "JOURNEY",
          journey: selectPayCapability(journey, option.instance.instanceId, routeCandidates),
        });
      } catch {
        // Fail-closed honesty: the contract refused the fold (e.g. a
        // non-routable selection); surface the reason, never a workaround.
        setError("The contract refused this selection — see the routability reasons listed.");
      }
      return;
    }
    switch (action.actionId) {
      case "choose-different-capability":
        setPhase({
          kind: "JOURNEY",
          journey: beginPayJourney({
            request: journey.request,
            connectedInstances,
            routabilityChecks,
          }),
        });
        return;
      case "abandon-payment":
        setPhase({ kind: "JOURNEY", journey: abandonPayJourney(journey) });
        return;
      case "retry-as-new-intent":
        setPhase({ kind: "COMPOSING" });
        return;
      case "submit-payment": {
        void submitPayment(action);
        return;
      }
      default:
        // Tracking refreshes and evidence views are real navigations; the
        // honest outcome folds below.
        return;
    }
  }

  return (
    <div className="cc-stack">
      {phase.kind === "COMPOSING" ? (
        <Panel
          title="Compose a payment"
          description="Exact minor units (INV-F01) — e.g. 1050 for ₵10.50. Nothing is submitted from this form; the journey reviews before any submission."
        >
          <div className="cc-stack">
            {autoStart ? (
              <p className="cc-actions__reason" role="status">
                Started from the Pay action — compose the payment below.
              </p>
            ) : null}
            <div className="cc-grid">
              <Field
                label="Amount (minor units)"
                required
                hint="Exact integer in the currency's minor unit — never a formatted amount."
              >
                <Input
                  inputMode="numeric"
                  autoComplete="off"
                  value={amountMinor}
                  placeholder="1050"
                  onChange={(event) => {
                    setAmountMinor(event.target.value);
                  }}
                />
              </Field>
              <Field label="Currency" required hint="Three-letter ISO-style code.">
                <Input
                  value={currency}
                  maxLength={3}
                  placeholder="GHS"
                  onChange={(event) => {
                    setCurrency(event.target.value.toUpperCase());
                  }}
                />
              </Field>
            </div>
            <Field label="Recipient" required>
              <Input
                value={recipient}
                placeholder="The recipient reference"
                onChange={(event) => {
                  setRecipient(event.target.value);
                }}
              />
            </Field>
            <p className="cc-actions__reason">
              Routability is derived ONLY from authority checks on connected
              instances — for example, GHS is honestly non-routable on a
              Stripe instance (a provider-capability datum, never a failure).
              An instance without a check is treated as not routable
              (fail-closed honesty).
            </p>
            {error !== null ? (
              <p role="alert" className="cc-actions__reason">
                {error}
              </p>
            ) : null}
            <div>
              <Button variant="primary" disabled={!canCompose} onClick={begin}>
                Review capability options
              </Button>
            </div>
          </div>
        </Panel>
      ) : (
        <>
          <PayJourneyView journey={phase.journey} onAction={onAction} />
          {pending ? (
            <p className="cc-actions__reason" role="status">
              Dispatching the payment submission to the authoritative PaySwap
              API…
            </p>
          ) : null}
          {dispatchNote !== null ? (
            <p
              className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm leading-6 text-amber-900"
              role="status"
            >
              {dispatchNote}
            </p>
          ) : null}
          {phase.journey.stateName === "RECONCILING" ? (
            <ReconcileJourneySurface
              paymentRef={
                phase.journey.submittedIntentId ??
                phase.journey.request.correlationId ??
                `pay:${phase.journey.request.amount.currency}`
              }
              evidenceRefs={phase.journey.evidenceRefs.map((ref) => String(ref))}
              ambiguityEvidenceRef={
                phase.journey.evidenceRefs.length > 0
                  ? String(phase.journey.evidenceRefs[phase.journey.evidenceRefs.length - 1])
                  : undefined
              }
              csrfToken={csrfToken}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

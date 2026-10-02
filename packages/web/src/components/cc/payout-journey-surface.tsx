"use client";

/**
 * The Payout journey surface (P3-W2-002; end-to-end continuity by
 * P3-W3-002) — the certified PayoutJourney contract as a live UI.
 *
 * Fail-closed by contract (law: explicit destination required before ANY
 * submission): the journey begins WITHOUT a destination and WITHOUT a
 * withdrawal scope; the submit action stays unavailable until both are
 * explicitly present. The withdrawal scope is single-use and bound to the
 * destination — a connection is never blanket withdrawal authority. The
 * destination is an external-funds OBSERVATION (never custody). Submission
 * dispatches through the REAL authenticated transport
 * (/api/journeys/dispatch → the authoritative PaySwap API) with the answer
 * folded VERBATIM; UNKNOWN renders the DEDICATED reconciliation journey
 * (never failure) and the provider customer-action state renders verbatim
 * with the reauth journey reachable.
 */

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { PayoutDestinationRef, PayoutJourney, ViewAction } from "@payswap/ux";
import {
  abandonPayoutJourney,
  applyPayoutSubmissionResponse,
  asPayoutDestinationRef,
  beginPayoutJourney,
  confirmWithdrawalScope,
  reenterPayoutDestinationSelection,
  specifyPayoutDestination,
} from "@payswap/ux";
import {
  Button,
  EmptyState,
  Field,
  Input,
  KeyValue,
  Panel,
  Select,
  StatusPill,
  UnknownState,
} from "@payswap/design";

import { JourneyActionList } from "./journey-actions";
import { ReconcileJourneySurface } from "./reconcile-journey-surface";
import { dispatchJourneyApiCommand } from "@/lib/cc/journey-dispatch";

type PayoutPhase =
  | { readonly kind: "COMPOSING" }
  | { readonly kind: "JOURNEY"; readonly journey: PayoutJourney };

const STATE_PILLS: Readonly<Record<string, { tone: "ok" | "attention" | "unknown" | "failed" | "disabled"; label: string }>> = {
  SPECIFYING_DESTINATION: { tone: "attention", label: "Specifying destination" },
  CONFIRMING_SCOPE: { tone: "attention", label: "Confirming withdrawal scope" },
  AWAITING_APPROVAL: { tone: "attention", label: "Awaiting approval" },
  SUBMITTED: { tone: "unknown", label: "Submitted — tracking" },
  TRACKING: { tone: "unknown", label: "In progress" },
  RECONCILING: { tone: "unknown", label: "Reconciling — outcome unknown" },
  COMPLETED: { tone: "ok", label: "Completed" },
  FAILED: { tone: "failed", label: "Failed" },
  ABANDONED: { tone: "disabled", label: "Cancelled" },
};

const DESTINATION_KINDS = ["BANK_ACCOUNT", "MOBILE_WALLET", "CRYPTO_ADDRESS"] as const;

function minorUnitsInput(value: string): string | null {
  const trimmed = value.trim();
  if (!/^\d{1,12}$/.test(trimmed)) {
    return null;
  }
  return trimmed.replace(/^0+(?=\d)/, "");
}

/** The payout journey facts (pill + destination/scope state) — exported for tests. */
export function PayoutJourneyFacts({ journey }: { readonly journey: PayoutJourney }) {
  const pill = STATE_PILLS[journey.stateName] ?? null;
  return (
    <>
      {pill !== null ? (
        <p>
          <StatusPill tone={pill.tone}>{pill.label}</StatusPill>
        </p>
      ) : null}
      <KeyValue
        entries={[
          {
            key: "Amount",
            value: `${journey.amount.minorUnits} ${journey.amount.currency} (minor units)`,
            mono: true,
          },
          { key: "Journey state", value: journey.stateName, mono: true },
          {
            key: "Destination",
            value:
              journey.destination === undefined
                ? "— none specified (fail-closed: required before any submission)"
                : `${journey.destination.kind} ${journey.destination.destinationRef} (${journey.destination.currency}, external observation)`,
            mono: journey.destination !== undefined,
          },
          {
            key: "Withdrawal scope",
            value:
              journey.withdrawalScope === undefined
                ? "— not confirmed (required before any submission)"
                : `single-use, max ${journey.withdrawalScope.maxAmount.minorUnits} ${journey.withdrawalScope.maxAmount.currency}, bound to the destination`,
          },
        ]}
      />
    </>
  );
}

export function PayoutJourneySurface({
  autoStart,
  csrfToken,
}: {
  readonly autoStart: boolean;
  /** The live session's CSRF echo (undefined in the marked preview — no mutations). */
  readonly csrfToken?: string;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<PayoutPhase>({ kind: "COMPOSING" });
  const [amountMinor, setAmountMinor] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [error, setError] = useState<string | null>(null);
  const [dispatchNote, setDispatchNote] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Destination form (SPECIFYING_DESTINATION).
  const [destinationKind, setDestinationKind] = useState<(typeof DESTINATION_KINDS)[number]>("BANK_ACCOUNT");
  const [destinationCurrency, setDestinationCurrency] = useState("USD");
  const [destinationRefInput, setDestinationRefInput] = useState("");

  const canCompose = minorUnitsInput(amountMinor) !== null && /^[A-Z]{3}$/.test(currency);

  function begin(): void {
    const minorUnits = minorUnitsInput(amountMinor);
    if (minorUnits === null || !/^[A-Z]{3}$/.test(currency)) {
      setError("Amount (exact minor units) and a 3-letter currency are required.");
      return;
    }
    setError(null);
    setPhase({
      kind: "JOURNEY",
      journey: beginPayoutJourney({ amount: { currency, minorUnits } }),
    });
  }

  function specifyDestination(): void {
    if (phase.kind !== "JOURNEY") {
      return;
    }
    let destinationRef: PayoutDestinationRef;
    try {
      destinationRef = asPayoutDestinationRef(destinationRefInput.trim());
    } catch {
      setError("The destination reference must be a non-empty external reference (an opaque id — never account credentials).");
      return;
    }
    if (!/^[A-Z]{3}$/.test(destinationCurrency)) {
      setError("The destination currency must be a 3-letter code.");
      return;
    }
    try {
      setPhase({
        kind: "JOURNEY",
        journey: specifyPayoutDestination(phase.journey, {
          destinationRef,
          kind: destinationKind,
          currency: destinationCurrency,
          externalObservation: true,
        }),
      });
      setError(null);
    } catch {
      setError("The contract refused this destination — it must be an external-funds observation.");
    }
  }

  function confirmScope(): void {
    if (phase.kind !== "JOURNEY" || phase.journey.destination === undefined) {
      return;
    }
    try {
      setPhase({
        kind: "JOURNEY",
        journey: confirmWithdrawalScope(phase.journey, {
          singleUse: true,
          maxAmount: phase.journey.amount,
          destinationRef: phase.journey.destination.destinationRef,
        }),
      });
      setError(null);
    } catch {
      setError(
        "The contract refused this scope — a withdrawal scope must be single-use, destination-bound and denominated in the payout currency.",
      );
    }
  }

  async function submitPayout(action: ViewAction): Promise<void> {
    if (pending) {
      return;
    }
    setPending(true);
    setError(null);
    setDispatchNote(null);
    try {
      const result = await dispatchJourneyApiCommand("payout", action, csrfToken);
      if (result.kind === "response") {
        try {
          setPhase((current) =>
            current.kind === "JOURNEY"
              ? {
                  kind: "JOURNEY",
                  journey: applyPayoutSubmissionResponse(
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
    switch (action.actionId) {
      case "choose-destination":
      case "change-destination":
        try {
          setPhase({
            kind: "JOURNEY",
            journey: reenterPayoutDestinationSelection(journey),
          });
        } catch {
          setError("Destination selection re-entry is not legal from this state.");
        }
        return;
      case "confirm-withdrawal-scope":
        confirmScope();
        return;
      case "submit-payout": {
        void submitPayout(action);
        return;
      }
      case "abandon-payout":
        setPhase({ kind: "JOURNEY", journey: abandonPayoutJourney(journey) });
        return;
      case "retry-as-new-intent":
        setPhase({ kind: "COMPOSING" });
        return;
      case "view-destination-observation-note":
      case "view-withdrawal-scope":
        router.push("/app/evidence");
        return;
      default:
        setError(
          "This action folds authority records (tracking, reconciliation, evidence) — it applies once the session plane provides them.",
        );
        return;
    }
  }


  return (
    <div className="cc-stack">
      {phase.kind === "COMPOSING" ? (
        <Panel
          title="Compose a payout"
          description="Exact minor units (INV-F01). A payout requires an EXPLICIT external destination and a withdrawal-scoped authorization before anything can be submitted — fail-closed by contract."
        >
          <div className="cc-stack">
            {autoStart ? (
              <p className="cc-actions__reason" role="status">
                Started from the Payout action — compose the payout below.
              </p>
            ) : null}
            <div className="cc-grid">
              <Field label="Amount (minor units)" required hint="Exact integer in the currency's minor unit.">
                <Input
                  inputMode="numeric"
                  autoComplete="off"
                  value={amountMinor}
                  placeholder="100000"
                  onChange={(event) => {
                    setAmountMinor(event.target.value);
                  }}
                />
              </Field>
              <Field label="Currency" required hint="Three-letter ISO-style code.">
                <Input
                  value={currency}
                  maxLength={3}
                  placeholder="USD"
                  onChange={(event) => {
                    setCurrency(event.target.value.toUpperCase());
                  }}
                />
              </Field>
            </div>
            {error !== null ? (
              <p role="alert" className="cc-actions__reason">
                {error}
              </p>
            ) : null}
            <div>
              <Button variant="primary" disabled={!canCompose} onClick={begin}>
                Specify the destination
              </Button>
            </div>
          </div>
        </Panel>
      ) : (
        <>
          <PayoutJourneyFacts journey={phase.journey} />
          {phase.journey.stateName === "SPECIFYING_DESTINATION" ? (
            <Panel
              title="The explicit external destination"
              description="Where external money would land — an external-funds OBSERVATION, never custody. PaySwap does not hold funds; the destination is an opaque external reference."
            >
              <div className="cc-stack">
                <div className="cc-grid">
                  <Field label="Destination kind" required>
                    <Select
                      value={destinationKind}
                      onChange={(event) => {
                        setDestinationKind(event.target.value as (typeof DESTINATION_KINDS)[number]);
                      }}
                    >
                      {DESTINATION_KINDS.map((kind) => (
                        <option key={kind} value={kind}>
                          {kind}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Destination currency" required>
                    <Input
                      value={destinationCurrency}
                      maxLength={3}
                      onChange={(event) => {
                        setDestinationCurrency(event.target.value.toUpperCase());
                      }}
                    />
                  </Field>
                </div>
                <Field
                  label="Destination reference"
                  required
                  hint="An opaque external reference (a destination id). Credentials never appear here — the field is a reference, not account material."
                >
                  <Input
                    value={destinationRefInput}
                    placeholder="dest_…"
                    onChange={(event) => {
                      setDestinationRefInput(event.target.value);
                    }}
                  />
                </Field>
                {error !== null ? (
                  <p role="alert" className="cc-actions__reason">
                    {error}
                  </p>
                ) : null}
                <div>
                  <Button variant="primary" onClick={specifyDestination}>
                    Specify this destination
                  </Button>
                </div>
              </div>
            </Panel>
          ) : null}
          {phase.journey.stateName === "CONFIRMING_SCOPE" ? (
            <Panel
              title="Withdrawal scope"
              description="A withdrawal-scoped authorization is SINGLE-USE and bound to this destination — a connection is never blanket withdrawal authority. Confirming it is required before the submit becomes available."
            >
              <div className="cc-stack">
                <p className="cc-actions__reason">
                  Scope to confirm: single-use, max{" "}
                  <span className="ps-mono">
                    {phase.journey.amount.minorUnits} {phase.journey.amount.currency}
                  </span>{" "}
                  (minor units), bound to destination{" "}
                  <span className="ps-mono">{phase.journey.destination?.destinationRef}</span>.
                </p>
                {error !== null ? (
                  <p role="alert" className="cc-actions__reason">
                    {error}
                  </p>
                ) : null}
                <div>
                  <Button variant="primary" onClick={confirmScope}>
                    Confirm the withdrawal scope
                  </Button>
                </div>
              </div>
            </Panel>
          ) : null}
          {phase.journey.stateName === "TRACKING" &&
          phase.journey.attemptOutcome === "AWAITING_CUSTOMER_ACTION" ? (
            <Panel
              title="Provider customer action required"
              description="The provider is waiting for YOUR action — the tracked state, verbatim (AWAITING_CUSTOMER_ACTION), never reinterpreted."
              headingLevel={3}
              actions={<StatusPill tone="attention">Awaiting customer action</StatusPill>}
            >
              <p className="text-sm leading-6 text-stone-700">
                The payout is parked until you complete the provider&rsquo;s
                required step on the provider&rsquo;s own surface — credentials
                never cross. If the step-up expires or requires
                reauthorization, the{" "}
                <Link href="/reauth" className="font-semibold text-emerald-800 underline">
                  reauthorization journey
                </Link>{" "}
                preserves the lineage and resumes execution under the fresh
                authorization.
              </p>
            </Panel>
          ) : null}
          {phase.journey.stateName === "RECONCILING" ? (
            <UnknownState
              title="Outcome unknown — reconciling"
              description="Absence of knowledge is not failure. Reconciliation is authoritative for ambiguous external effects (INV-X03); the external write is never blindly retried (INV-X02)."
              action={
                <Link className="ps-button ps-button--sm ps-button--secondary" href="/app/evidence">
                  View the evidence recorded so far
                </Link>
              }
            />
          ) : null}
          {phase.journey.stateName === "RECONCILING" ? (
            <ReconcileJourneySurface
              paymentRef={`payout:${phase.journey.amount.currency}:${phase.journey.destination?.destinationRef ?? "unspecified"}`}
              evidenceRefs={phase.journey.evidenceRefs.map((ref) => String(ref))}
              ambiguityEvidenceRef={
                phase.journey.evidenceRefs.length > 0
                  ? String(phase.journey.evidenceRefs[phase.journey.evidenceRefs.length - 1])
                  : undefined
              }
              csrfToken={csrfToken}
            />
          ) : null}
          {pending ? (
            <p className="cc-actions__reason" role="status">
              Dispatching the payout submission to the authoritative PaySwap
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
          {phase.journey.stateName === "COMPLETED" ? (
            <EmptyState
              title="Payout completed"
              description="Completion is an externally observed effect — not a PaySwap balance. The completion evidence is preserved on the journey."
            />
          ) : null}
          <JourneyActionList heading="Actions" actions={phase.journey.actions} onAction={onAction} />
        </>
      )}
    </div>
  );
}

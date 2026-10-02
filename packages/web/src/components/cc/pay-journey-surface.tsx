"use client";

/**
 * The Pay journey surface (P3-W2-002) — the certified PayJourney contract as
 * a live UI.
 *
 * Laws honored structurally:
 * - capability selection ONLY from connected instances (the options derive
 *   from authority records passed in by the server; the catalogue is never
 *   an execution surface — comparison-only route candidates say so);
 * - submission ONLY when the journey contract allows (the submit action's
 *   own `available` flag; today it additionally requires the session plane
 *   the parallel work stream owns — rendered as the honest unavailable
 *   reason, never a fake success);
 * - UNKNOWN is reconciliation, NEVER failure: OUTCOME_UNKNOWN folds to
 *   RECONCILING and renders the UnknownState language (INV-X01);
 * - amounts are exact minor units (INV-F01) — the input is a minor-unit
 *   integer, never parsed from a formatted currency string.
 */

import { useMemo, useState } from "react";
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

import { JourneyActionList, SESSION_NOT_WIRED_REASON } from "./journey-actions";

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

export function PayJourneySurface({
  connectedInstances,
  routabilityChecks,
  routeCandidates,
  autoStart,
}: {
  /** Authority records of connected instances (empty until the connect plane ships). */
  readonly connectedInstances: readonly ConnectedCapabilityInstanceRecord[];
  /** Authority routability checks per instance (absent check = honestly not routable). */
  readonly routabilityChecks: readonly CurrencyRoutabilityCheck[];
  /** Route candidates for review (catalogue entries render comparison-only). */
  readonly routeCandidates: readonly RouteCandidate[];
  readonly autoStart: boolean;
}) {
  const [phase, setPhase] = useState<PayPhase>({ kind: "COMPOSING" });
  const [amountMinor, setAmountMinor] = useState("");
  const [currency, setCurrency] = useState("GHS");
  const [recipient, setRecipient] = useState("");
  const [error, setError] = useState<string | null>(null);

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
      case "submit-payment":
        // The dispatch itself requires a JourneySession (the parallel
        // session plane). The action's availability already reflects the
        // contract's rules; without a session we never reach a live submit.
        setError(SESSION_NOT_WIRED_REASON);
        return;
      default:
        // Tracking refreshes and evidence views are real navigations; the
        // honest outcome folds below.
        return;
    }
  }

  const statePill = useMemo(() => {
    if (phase.kind !== "JOURNEY") {
      return null;
    }
    return STATE_PILLS[phase.journey.stateName] ?? { tone: "unknown" as const, label: phase.journey.stateName };
  }, [phase]);

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
          <div>
            {statePill !== null ? <StatusPill tone={statePill.tone}>{statePill.label}</StatusPill> : null}
          </div>
          <KeyValue
            entries={[
              {
                key: "Amount",
                value: `${phase.journey.request.amount.minorUnits} ${phase.journey.request.amount.currency} (minor units)`,
                mono: true,
              },
              { key: "Recipient", value: phase.journey.request.recipient, mono: true },
              { key: "Journey state", value: phase.journey.stateName, mono: true },
            ]}
          />
          {phase.journey.stateName === "SELECTING_CAPABILITY" ? (
            phase.journey.options.length === 0 ? (
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
          {phase.journey.stateName === "REVIEWING_ROUTE" && (phase.journey.routeCandidates?.length ?? 0) > 0 ? (
            <Panel
              title="Route comparison"
              description="Catalogue-derived entries are clearly marked COMPARISON-ONLY — the catalogue is never an execution surface. Only routes executing on your connected instance can be submitted."
            >
              <ul className="cc-actions">
                {(phase.journey.routeCandidates ?? []).map((candidate) => (
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
          {phase.journey.stateName === "FAILED" ? (
            <Panel title="Failed" description="The failure reason comes from protocol evidence, not inference. Retry only as a NEW intent with a fresh idempotency key.">
              <p className="cc-actions__reason">
                The failure evidence is preserved on the journey — view it
                from the actions below.
              </p>
            </Panel>
          ) : null}
          <JourneyActionList
            heading="Actions"
            actions={phase.journey.actions}
            onAction={onAction}
          />
        </>
      )}
    </div>
  );
}

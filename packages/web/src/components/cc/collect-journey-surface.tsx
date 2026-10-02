"use client";

/**
 * The Collect journey surface (P3-W2-002) — the certified CollectJourney
 * contract as a live UI: request creation where a connected capability
 * permits, the shareable request as an OPAQUE reference, fulfillment
 * tracking with outcomes folded verbatim. With no connected capability the
 * journey begins in its HONEST EMPTY state (the contract's own unavailable
 * reason renders — never an error, never a fabricated request).
 */

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { CollectJourney, ConnectedCapabilityInstanceRecord, ViewAction } from "@payswap/ux";
import { abandonCollectJourney, beginCollectJourney, deriveShareableRequest } from "@payswap/ux";
import { Button, EmptyState, Field, Input, KeyValue, Panel, StatusPill } from "@payswap/design";

import { JourneyActionList, SESSION_NOT_WIRED_REASON } from "./journey-actions";

type CollectPhase =
  | { readonly kind: "COMPOSING" }
  | { readonly kind: "JOURNEY"; readonly journey: CollectJourney };

const NAV_TARGETS: Readonly<Record<string, string>> = {
  "connect-a-capability": "/app/capabilities",
};

const STATE_PILLS: Readonly<Record<string, { tone: "ok" | "attention" | "unknown" | "failed" | "disabled"; label: string }>> = {
  COMPOSING_REQUEST: { tone: "attention", label: "Composing request" },
  REQUEST_CREATED: { tone: "ok", label: "Request created" },
  SHARED: { tone: "ok", label: "Shared" },
  TRACKING: { tone: "unknown", label: "Tracking fulfillment" },
  FULFILLED: { tone: "ok", label: "Fulfilled" },
  EXPIRED: { tone: "disabled", label: "Expired" },
  CANCELLED: { tone: "disabled", label: "Cancelled" },
  ABANDONED: { tone: "disabled", label: "Abandoned" },
};

function minorUnitsInput(value: string): string | null {
  const trimmed = value.trim();
  if (!/^\d{1,12}$/.test(trimmed)) {
    return null;
  }
  return trimmed.replace(/^0+(?=\d)/, "");
}

export function CollectJourneySurface({
  collectCapableInstances,
  autoStart,
}: {
  /** Authority records of instances that permit collecting (empty until the connect plane ships). */
  readonly collectCapableInstances: readonly ConnectedCapabilityInstanceRecord[];
  readonly autoStart: boolean;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<CollectPhase>({ kind: "COMPOSING" });
  const [amountMinor, setAmountMinor] = useState("");
  const [currency, setCurrency] = useState("GHS");
  const [payer, setPayer] = useState("");
  const [error, setError] = useState<string | null>(null);

  const canCompose = minorUnitsInput(amountMinor) !== null && payer.trim().length > 0 && /^[A-Z]{3}$/.test(currency);

  function begin(): void {
    const minorUnits = minorUnitsInput(amountMinor);
    if (minorUnits === null || payer.trim().length === 0 || !/^[A-Z]{3}$/.test(currency)) {
      setError("Amount (exact minor units), a 3-letter currency and a payer are required.");
      return;
    }
    setError(null);
    setPhase({
      kind: "JOURNEY",
      journey: beginCollectJourney({
        amount: { currency, minorUnits },
        payer: payer.trim(),
        collectCapableInstances,
      }),
    });
  }

  function onAction(action: ViewAction): void {
    if (phase.kind !== "JOURNEY") {
      return;
    }
    const journey = phase.journey;
    const navTarget = NAV_TARGETS[action.actionId];
    if (navTarget !== undefined) {
      router.push(navTarget);
      return;
    }
    switch (action.actionId) {
      case "create-collect-request":
        setError(SESSION_NOT_WIRED_REASON);
        return;
      case "abandon-collect":
        setPhase({ kind: "JOURNEY", journey: abandonCollectJourney(journey) });
        return;
      case "reissue-as-new-request":
        setPhase({ kind: "COMPOSING" });
        return;
      default:
        // Fulfillment refreshes and evidence views are authority folds that
        // apply once the session plane provides the records.
        setError(
          "This action folds authority records (fulfillment, evidence) — it applies once the session plane provides them.",
        );
        return;
    }
  }

  const share = phase.kind === "JOURNEY" ? deriveShareableRequest(phase.journey) : null;
  const pill = phase.kind === "JOURNEY" ? (STATE_PILLS[phase.journey.stateName] ?? null) : null;

  return (
    <div className="cc-stack">
      {phase.kind === "COMPOSING" ? (
        <Panel
          title="Compose a payment request"
          description="Exact minor units (INV-F01). The request is created only where a connected capability permits collecting; the share reference is opaque."
        >
          <div className="cc-stack">
            {autoStart ? (
              <p className="cc-actions__reason" role="status">
                Started from the Collect action — compose the request below.
              </p>
            ) : null}
            <div className="cc-grid">
              <Field label="Amount (minor units)" required hint="Exact integer in the currency's minor unit.">
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
            <Field label="Payer" required>
              <Input
                value={payer}
                placeholder="Who this request goes to"
                onChange={(event) => {
                  setPayer(event.target.value);
                }}
              />
            </Field>
            {error !== null ? (
              <p role="alert" className="cc-actions__reason">
                {error}
              </p>
            ) : null}
            <div>
              <Button variant="primary" disabled={!canCompose} onClick={begin}>
                Create the payment request
              </Button>
            </div>
          </div>
        </Panel>
      ) : (
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
                value: `${phase.journey.amount.minorUnits} ${phase.journey.amount.currency} (minor units)`,
                mono: true,
              },
              { key: "Payer", value: phase.journey.payer, mono: true },
              { key: "Journey state", value: phase.journey.stateName, mono: true },
              {
                key: "Connected collect-capable instances",
                value: String(phase.journey.collectCapableInstances.length),
              },
            ]}
          />
          {share !== null && "requestRef" in share ? (
            <Panel
              title="Shareable request"
              description="An OPAQUE reference the payer surface binds to — sharing carries no envelope and no authority."
            >
              <p className="ps-mono">{share.requestRef}</p>
            </Panel>
          ) : null}
          {phase.journey.stateName === "COMPOSING_REQUEST" &&
          phase.journey.collectCapableInstances.length === 0 ? (
            <EmptyState
              title="No connected capability permits collecting"
              description={
                <>
                  Request creation draws ONLY from connected instances whose
                  authority records permit collecting — and none exist for
                  this viewer yet. This is the honest empty state, not an
                  error.{" "}
                  <Link href="/app/capabilities">See provider coverage and connect a capability</Link>{" "}
                  once the connection plane ships (parallel work stream).
                </>
              }
            />
          ) : null}
          <JourneyActionList heading="Actions" actions={phase.journey.actions} onAction={onAction} />
        </>
      )}
    </div>
  );
}

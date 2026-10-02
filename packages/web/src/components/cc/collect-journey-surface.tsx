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

import { JourneyActionList } from "./journey-actions";
import { dispatchJourneyApiCommand } from "@/lib/cc/journey-dispatch";

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

/** The live-journey view (every state except composing) — exported for tests. */
export function CollectJourneyView({
  journey,
  onAction,
}: {
  readonly journey: CollectJourney;
  readonly onAction: (action: ViewAction) => void;
}) {
  const pill = STATE_PILLS[journey.stateName] ?? null;
  const share = deriveShareableRequest(journey);
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
          { key: "Payer", value: journey.payer, mono: true },
          { key: "Journey state", value: journey.stateName, mono: true },
          {
            key: "Connected collect-capable instances",
            value: String(journey.collectCapableInstances.length),
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
      {journey.stateName === "COMPOSING_REQUEST" &&
      journey.collectCapableInstances.length === 0 ? (
        <EmptyState
          title="No connected capability permits collecting"
          description={
            <>
              Request creation draws ONLY from connected instances whose
              authority records permit collecting — and none exist for this
              viewer yet. This is the honest empty state, not an error.{" "}
              <Link href="/app/capabilities">See provider coverage and connect a capability</Link>{" "}
              once the connection plane ships (parallel work stream).
            </>
          }
        />
      ) : null}
      <JourneyActionList heading="Actions" actions={journey.actions} onAction={onAction} />
    </>
  );
}

export function CollectJourneySurface({
  collectCapableInstances,
  autoStart,
  csrfToken,
}: {
  /** Authority records of instances that permit collecting (empty until the connect plane ships). */
  readonly collectCapableInstances: readonly ConnectedCapabilityInstanceRecord[];
  readonly autoStart: boolean;
  /** The live session's CSRF echo (undefined in the marked preview — no mutations). */
  readonly csrfToken?: string;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<CollectPhase>({ kind: "COMPOSING" });
  const [amountMinor, setAmountMinor] = useState("");
  const [currency, setCurrency] = useState("GHS");
  const [payer, setPayer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [dispatchNote, setDispatchNote] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

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

  async function createRequest(action: ViewAction): Promise<void> {
    if (pending) {
      return;
    }
    setPending(true);
    setError(null);
    setDispatchNote(null);
    try {
      const result = await dispatchJourneyApiCommand("collect", action, csrfToken);
      if (result.kind === "response") {
        if (result.response.kind === "error") {
          const errorBody = result.response.body.error;
          setDispatchNote(
            `The PaySwap API answered verbatim — ${errorBody.code} (${errorBody.category}), HTTP ${result.response.status}: ${errorBody.message}. The journey records the error exactly; no request was created.`,
          );
          return;
        }
        setDispatchNote(
          "The PaySwap API accepted the collect-request command — its envelope is preserved verbatim; the request reference arrives from the authority record.",
        );
        return;
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
    const navTarget = NAV_TARGETS[action.actionId];
    if (navTarget !== undefined) {
      router.push(navTarget);
      return;
    }
    switch (action.actionId) {
      case "create-collect-request": {
        void createRequest(action);
        return;
      }
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
          <CollectJourneyView journey={phase.journey} onAction={onAction} />
          {pending ? (
            <p className="cc-actions__reason" role="status">
              Dispatching the collect-request command to the authoritative
              PaySwap API…
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
        </>
      )}
    </div>
  );
}

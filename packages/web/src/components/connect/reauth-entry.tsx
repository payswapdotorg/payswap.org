"use client";

/**
 * The reauth journey entry (P3-W3-002) — the live ReauthJourney contract for
 * an EXPIRED authority record, consuming the REAL W3-001 folds.
 *
 * The journey begins from AUTHORITY state only: the expired
 * ConnectedCapabilityInstanceRecord (folded into the connection plane by the
 * authoritative API path) plus the original connection-initiation lineage.
 * The fresh-authorization REQUEST dispatches through the real authenticated
 * transport (/api/journeys/dispatch → the PaySwap API); the API's answer is
 * folded VERBATIM through `applyReauthorizationRequestResponse` — in this
 * deployment the runtime answers its honest 401/403 session error, which
 * renders as the honest state, never a fabricated reauthorization. The
 * trusted browser surface itself is honestly not-bound until a broker is
 * wired (credentials never cross in either direction).
 */

import { useState } from "react";
import type { ViewAction } from "@payswap/ux";
import {
  applyReauthorizationRequestResponse,
  beginReauthorization,
} from "@payswap/ux";
import { Panel } from "@payswap/design";

import { ReauthJourneyView } from "./reauth-journey-view";
import { JourneyActionList } from "@/components/cc/journey-actions";
import { dispatchJourneyApiCommand } from "@/lib/cc/journey-dispatch";

/** One expired authority record with the lineage the reauth preserves. */
export interface ReauthEntryInput {
  readonly providerId: string;
  readonly providerDisplayName: string;
  readonly instanceId: string;
  readonly connectedAt: string;
  /** The initiation intent the expired authorization covered, when recorded. */
  readonly initiationIntentId?: string;
}

export function ReauthEntry({
  entry,
  csrfToken,
}: {
  readonly entry: ReauthEntryInput;
  readonly csrfToken: string | undefined;
}) {
  const [journey, setJourney] = useState(() =>
    beginReauthorization({
      trigger: "EXPIRED",
      lineage: {
        ...(entry.initiationIntentId === undefined
          ? {}
          : { intentId: entry.initiationIntentId }),
        originalCommandType: "capabilities.connection.initiate",
      },
    }),
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onAction(action: ViewAction): Promise<void> {
    switch (action.actionId) {
      case "begin-reauthorization-request": {
        if (pending) {
          return;
        }
        setPending(true);
        setError(null);
        try {
          const result = await dispatchJourneyApiCommand(
            "reauthorize",
            action,
            csrfToken,
          );
          if (result.kind === "response") {
            try {
              setJourney(applyReauthorizationRequestResponse(journey, result.response));
            } catch {
              setError(
                "The contract refused to fold the API's answer — the journey state is unchanged and the answer is preserved verbatim in the dispatch log.",
              );
            }
            return;
          }
          setError(result.message);
          return;
        } finally {
          setPending(false);
        }
      }
      case "open-trusted-browser-surface":
        setError(
          "The trusted browser surface is not yet bound to this deployment — no provider broker is wired, so the customer action cannot be opened yet. This is the honest not-yet state: the reauthorization journey is real, but completing the customer action is not possible here until a broker is bound.",
        );
        return;
      default:
        return;
    }
  }

  return (
    <div className="cc-stack">
      <ReauthJourneyView journey={journey} />
      <Panel
        title={`Expired authorization — ${entry.providerDisplayName}`}
        description="The reauthorization preserves the original connection lineage (intent and command) through every state."
        headingLevel={3}
      >
        <p className="text-sm leading-6 text-stone-700">
          Instance <span className="ps-mono text-xs">{entry.instanceId}</span>{" "}
          connected {entry.connectedAt}; the record&rsquo;s own state is
          EXPIRED, so execution is parked — it never continues quietly on a
          stale authorization.
        </p>
        {pending ? (
          <p className="mt-3 text-sm leading-6 text-stone-600" role="status">
            Dispatching the fresh-authorization request to the authoritative
            PaySwap API…
          </p>
        ) : null}
        {error !== null ? (
          <p
            className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm leading-6 text-amber-900"
            role="alert"
          >
            {error}
          </p>
        ) : null}
      </Panel>
      <JourneyActionList
        heading="Actions"
        actions={journey.actions}
        onAction={(action) => {
          void onAction(action);
        }}
      />
    </div>
  );
}

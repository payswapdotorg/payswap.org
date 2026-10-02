"use client";

/**
 * The Reconcile journey surface (P3-W3-002) — the certified
 * ReconcileJourney contract as the DEDICATED reconciliation view for an
 * ambiguous outcome (INV-X01: UNKNOWN is never FAILED).
 *
 * The lifecycle is AMBIGUITY-FIRST (INV-E02/INV-X03): the ambiguity is
 * recorded with its evidence reference before observation is awaited, and a
 * resolution comes ONLY from the authoritative API — the UI never resolves
 * an ambiguity itself (that would be a simulated financial effect). The
 * fresh-observation request dispatches through the REAL authenticated
 * transport; the API's answer renders verbatim (in this deployment the
 * honest 401/403 session answer — never a fabricated observation).
 */

import { useState } from "react";
import type { ReconcileJourney, ViewAction } from "@payswap/ux";
import {
  asEvidenceArtifactRef,
  awaitFurtherObservation,
  beginReconcileJourney,
  recordOutcomeUnknown,
  reconcileJourneyUiState,
} from "@payswap/ux";
import { KeyValue, Panel, StatusPill } from "@payswap/design";

import { JourneyActionList } from "./journey-actions";
import { dispatchJourneyApiCommand } from "@/lib/cc/journey-dispatch";

const STATE_COPY: Readonly<Record<ReconcileJourney["stateName"], string>> = {
  TRACKING_IN_FLIGHT:
    "The external action is in flight and unambiguous — reconciliation tracks it.",
  OUTCOME_UNKNOWN:
    "The outcome is UNKNOWN. Absence of knowledge is not failure: the ambiguity is recorded (the observation itself is evidence, INV-E02) and reconciliation is authoritative for it (INV-X03).",
  PENDING_OBSERVATION:
    "A fresh external observation was requested and is pending — surfaced with its evidence reference, never as a silent spinner.",
  RESOLVED_FULFILLED:
    "Resolved FULFILLED by the authoritative observation — with its resolution evidence reference.",
  RESOLVED_FAILED:
    "Resolved FAILED by the authoritative observation — with its resolution evidence reference.",
};

const STATE_TONE: Readonly<Record<ReconcileJourney["stateName"], "ok" | "unknown" | "failed">> = {
  TRACKING_IN_FLIGHT: "unknown",
  OUTCOME_UNKNOWN: "unknown",
  PENDING_OBSERVATION: "unknown",
  RESOLVED_FULFILLED: "ok",
  RESOLVED_FAILED: "failed",
};

export function ReconcileJourneySurface({
  paymentRef,
  reconciliationCaseRef,
  evidenceRefs,
  ambiguityEvidenceRef,
  csrfToken,
}: {
  /** The external financial action being reconciled (intent or correlation). */
  readonly paymentRef: string;
  readonly reconciliationCaseRef?: string;
  /** Evidence references recorded on the tracked action so far. */
  readonly evidenceRefs: readonly string[];
  /** The authority's ambiguity evidence ref (what records OUTCOME_UNKNOWN). */
  readonly ambiguityEvidenceRef?: string;
  readonly csrfToken?: string;
}) {
  const [journey, setJourney] = useState<ReconcileJourney>(() =>
    beginReconcileJourney({
      paymentRef,
      ...(reconciliationCaseRef === undefined
        ? {}
        : { reconciliationCaseRef }),
      evidenceRefs: evidenceRefs.map((ref) => asEvidenceArtifactRef(ref)),
    }),
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);

  async function requestObservation(action: ViewAction): Promise<void> {
    if (pending) {
      return;
    }
    setPending(true);
    setError(null);
    setAnswer(null);
    try {
      const result = await dispatchJourneyApiCommand(
        "reconcile-payment-outcome",
        action,
        csrfToken,
      );
      if (result.kind === "response") {
        if (result.response.kind === "error") {
          const errorBody = result.response.body.error;
          setAnswer(
            `The PaySwap API answered verbatim — ${errorBody.code} (${errorBody.category}), HTTP ${result.response.status}: ${errorBody.message}. No observation was fabricated; the journey stays in ${journey.stateName}.`,
          );
          return;
        }
        const requestId = result.response.envelope.meta.requestId;
        if (requestId === undefined || requestId.length === 0) {
          setAnswer(
            "The PaySwap API accepted the observation request, but its answer carried no request id — nothing can be folded as an observation evidence reference yet. The journey stays honest.",
          );
          return;
        }
        setAnswer(
          `Observation request accepted (request id ${requestId}) — the external observation is pending.`,
        );
        try {
          setJourney(
            awaitFurtherObservation(journey, asEvidenceArtifactRef(`obs:${requestId}`)),
          );
        } catch {
          setError(
            "The contract refused to fold the pending observation — the journey state is unchanged.",
          );
        }
        return;
      }
      setError(result.message);
    } finally {
      setPending(false);
    }
  }

  function onAction(action: ViewAction): void {
    switch (action.actionId) {
      case "record-outcome-unknown": {
        if (ambiguityEvidenceRef === undefined) {
          setError(
            "The ambiguity has no authority evidence reference to record (INV-E02) — nothing is folded.",
          );
          return;
        }
        try {
          setJourney(
            recordOutcomeUnknown(journey, asEvidenceArtifactRef(ambiguityEvidenceRef)),
          );
          setError(null);
        } catch {
          setError("The contract refused to record the ambiguity from this state.");
        }
        return;
      }
      case "request-fresh-observation":
        void requestObservation(action);
        return;
      default:
        return;
    }
  }

  const uiState = reconcileJourneyUiState(journey.stateName);

  return (
    <Panel
      title="Reconciliation — the dedicated journey for an ambiguous outcome"
      description={STATE_COPY[journey.stateName]}
      headingLevel={3}
      actions={<StatusPill tone={STATE_TONE[journey.stateName]}>{uiState}</StatusPill>}
    >
      <KeyValue
        entries={[
          { key: "Payment reference", value: journey.paymentRef, mono: true },
          ...(journey.reconciliationCaseRef === undefined
            ? []
            : [{ key: "Reconciliation case", value: journey.reconciliationCaseRef, mono: true }]),
          { key: "Reconcile state", value: journey.stateName, mono: true },
          ...(journey.attemptOutcome === undefined
            ? []
            : [{ key: "Tracked outcome (verbatim)", value: journey.attemptOutcome, mono: true }]),
          {
            key: "Evidence references",
            value:
              journey.evidenceRefs.length === 0
                ? "none recorded yet"
                : journey.evidenceRefs.join(", "),
            mono: journey.evidenceRefs.length > 0,
          },
        ]}
      />
      <p className="mt-4 text-sm leading-6 text-stone-600">
        The external write is never blindly retried (INV-X02); a resolution
        comes only from the authoritative observation path — this surface
        records, requests and displays, it never decides.
      </p>
      {journey.stateName === "TRACKING_IN_FLIGHT" ? (
        <div className="mt-4">
          <button
            type="button"
            className="ps-button ps-button--sm ps-button--secondary"
            onClick={() => onAction({ actionId: "record-outcome-unknown", label: "Record the ambiguity", kind: "NAVIGATION", authorityRef: paymentRef, available: true })}
          >
            Record the ambiguity (INV-E02)
          </button>
          <p className="cc-actions__reason mt-2">
            Folds the authority&rsquo;s ambiguity signal with its evidence
            reference — the ambiguity-first lifecycle.
          </p>
        </div>
      ) : null}
      {pending ? (
        <p className="mt-3 text-sm leading-6 text-stone-600" role="status">
          Requesting a fresh external observation from the authoritative
          PaySwap API…
        </p>
      ) : null}
      {answer !== null ? (
        <p
          className="mt-3 rounded-lg border border-stone-300 bg-stone-100 p-3 text-sm leading-6 text-stone-800"
          role="status"
        >
          {answer}
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
      <div className="mt-4">
        <JourneyActionList actions={journey.actions} onAction={onAction} />
      </div>
    </Panel>
  );
}

"use client";

/**
 * The Evidence journey surface (P3-W2-002) — the certified EvidenceJourney
 * contract as a live UI: the evidence list per external financial action
 * with provenance strength (INV-E04, strongest-first) and the artifact
 * inspection view. Read-only by construction (the contract exposes no
 * API_COMMAND action in any state — viewing evidence never mutates
 * authority). The artifact list arrives from authority records; today it is
 * honestly empty.
 */

import { useState } from "react";
import type { EvidenceArtifactEntry, EvidenceJourney, ViewAction } from "@payswap/ux";
import {
  asEvidenceArtifactRef,
  backToEvidenceList,
  beginEvidenceInspection,
  inspectEvidenceArtifact,
} from "@payswap/ux";
import { EmptyState, KeyValue, Panel, StatusPill } from "@payswap/design";

import { JourneyActionList } from "./journey-actions";

export function EvidenceJourneySurface({
  actionRef,
  artifacts,
  initialArtifactRef,
}: {
  /** The external financial action the evidence belongs to. */
  readonly actionRef: string;
  readonly artifacts: readonly EvidenceArtifactEntry[];
  /** A deep-linked artifact to inspect immediately (evidence continuity). */
  readonly initialArtifactRef?: string;
}) {
  const [journey, setJourney] = useState<EvidenceJourney>(() => {
    const seeded = beginEvidenceInspection({ actionRef, artifacts });
    if (initialArtifactRef === undefined) {
      return seeded;
    }
    try {
      // The deep link inspects an existing artifact: the fold refuses any
      // ref not in the derived list (fail-closed — no invented inspection).
      return inspectEvidenceArtifact(seeded, asEvidenceArtifactRef(initialArtifactRef));
    } catch {
      return seeded;
    }
  });

  function onAction(action: ViewAction): void {
    if (action.actionId.startsWith("inspect-artifact:")) {
      const artifactRef = action.actionId.slice("inspect-artifact:".length);
      const entry = journey.entries.find((candidate) => candidate.artifactRef === artifactRef);
      if (entry === undefined) {
        return;
      }
      setJourney(inspectEvidenceArtifact(journey, entry.artifactRef));
      return;
    }
    switch (action.actionId) {
      case "back-to-evidence-list":
        setJourney(backToEvidenceList(journey));
        return;
      default:
        return;
    }
  }

  const inspected = journey.entries.find(
    (entry) => entry.artifactRef === journey.inspectedArtifactRef,
  );

  return (
    <div className="cc-stack">
      {journey.stateName === "LISTING" ? (
        journey.entries.length === 0 ? (
          <EmptyState
            title="No evidence recorded for this action yet"
            description="Evidence artifacts arrive from authority records — approvals, executions and their provider envelopes — and none exist for this viewer yet. An empty list is an honest list: nothing is back-filled. Evidence accrues on every consequential financial effect once the session plane ships."
          />
        ) : (
          <Panel
            title="Evidence — strongest provenance first"
            description="Every artifact carries its provenance strength (INV-E04); a browser-local artifact never renders stronger than its authenticated provenance."
          >
            <ul className="cc-actions">
              {journey.entries.map((entry) => (
                <li key={entry.artifactRef} className="cc-actions__item">
                  <StatusPill tone="ok">{entry.provenanceLabel.strength}</StatusPill>
                  <span className="ps-mono">{entry.artifactRef}</span>
                  <span className="cc-actions__reason">{entry.summary}</span>
                </li>
              ))}
            </ul>
          </Panel>
        )
      ) : (
        <Panel
          title="Artifact inspection"
          description="Read-only — inspecting evidence never mutates authority (the journey contract exposes no mutation in any state)."
        >
          {inspected !== undefined ? (
            <KeyValue
              entries={[
                { key: "Artifact", value: inspected.artifactRef, mono: true },
                { key: "Summary", value: inspected.summary },
                { key: "Provenance strength", value: inspected.provenanceLabel.strength },
                { key: "Rank", value: `#${inspected.rank} in the INV-E04 order` },
                { key: "Action", value: journey.actionRef, mono: true },
              ]}
            />
          ) : (
            <p className="cc-actions__reason">The inspected artifact is no longer in the list.</p>
          )}
        </Panel>
      )}
      <JourneyActionList heading="Actions" actions={journey.actions} onAction={onAction} />
    </div>
  );
}

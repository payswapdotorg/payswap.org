"use client";

/**
 * UX-004 — the payment's ActivityTimeline with [Add note] (contract 05 §2.2:
 * reverse-chronological human events + the note affordance). Client side
 * because the note affordance is interactive; the timeline data arrives as
 * plain view records from the server (authority data, never mutated here).
 */

import { useState } from "react";
import { ActivityTimeline, Panel } from "@payswap/design";
import type { ActivityTimelineEntry } from "@payswap/design";

import { AddNoteComposer } from "./add-note";

export interface ActivityWithNotesProps {
  readonly paymentId: string;
  /** Reverse-chronological entries (latest state first — terminal first). */
  readonly entries: readonly ActivityTimelineEntry[];
}

export function ActivityWithNotes({ paymentId, entries }: ActivityWithNotesProps) {
  const [noteFor, setNoteFor] = useState<string | null>(null);
  return (
    <Panel
      title="Activity"
      description="The payment's history as human events — latest first. [Add note] annotates any entry; notes are events on the authoritative record."
      headingLevel={2}
    >
      <div className="cc-stack">
        <ActivityTimeline
          entries={[...entries]}
          onAddNote={(entryId) => {
            setNoteFor((current) => (current === entryId ? null : entryId));
          }}
        />
        {noteFor !== null ? (
          <div className="cc-stack">
            <AddNoteComposer paymentId={paymentId} entryId={noteFor} />
            <p className="cc-actions__reason">
              Adding to event <span className="ps-mono">{noteFor}</span> — cancel by pressing
              [Add note] again.
            </p>
          </div>
        ) : null}
      </div>
    </Panel>
  );
}

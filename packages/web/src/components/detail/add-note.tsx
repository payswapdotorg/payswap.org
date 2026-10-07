"use client";

/**
 * UX-004 — [Add note] on the payment timeline (contract 05 §2.2/§4: notes
 * are events; operators can annotate any object).
 *
 * HONESTY: a note is an EVENT on the authoritative payment record — the web
 * app never writes events. The authoritative API does not expose note
 * recording yet, so submitting the composer states exactly that (nothing is
 * fabricated, the note is never silently dropped): the composed event
 * sentence is shown so the operator keeps their words, and the honest
 * next-hop links to the events log. When the API ships note recording, this
 * composer dispatches through the authenticated transport instead.
 */

import { useState } from "react";
import Link from "next/link";
import { Button, Field, Input } from "@payswap/design";

export interface AddNoteComposerProps {
  /** The payment the note annotates (rides on the event's authority ref). */
  readonly paymentId: string;
  /** The timeline entry the note attaches to (undefined = object-level note). */
  readonly entryId?: string;
}

export function AddNoteComposer({ paymentId, entryId }: AddNoteComposerProps) {
  const [note, setNote] = useState("");
  const [outcome, setOutcome] = useState<"composing" | "not-recorded">("composing");

  if (outcome === "composing") {
    return (
      <form
        className="cc-stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (note.trim().length === 0) {
            return; // an empty note is never submitted (never a silent drop either)
          }
          setOutcome("not-recorded");
        }}
      >
        <Field
          label="Note"
          hint="Notes become events on the payment's timeline — visible to your team, part of the audit trail."
        >
          <Input
            value={note}
            placeholder="What should your team know about this payment?"
            onChange={(event) => {
              setNote(event.target.value);
            }}
          />
        </Field>
        <div>
          <Button size="sm" variant="primary" type="submit" disabled={note.trim().length === 0}>
            Add note
          </Button>
        </div>
      </form>
    );
  }

  return (
    <div role="status" className="cc-stack">
      <p className="cc-actions__reason">
        <strong>Not recorded yet.</strong> Notes are events written by the
        authoritative PaySwap API, and the API runtime does not expose note
        recording in this deployment — nothing was fabricated and your note
        was not dropped. It would appear on the timeline as:
      </p>
      <p className="ps-mono">&ldquo;{note.trim()}&rdquo;</p>
      <p className="cc-actions__reason">
        The note stays in this composer for now —{" "}
        <Link href="/app/payments" className="font-semibold text-emerald-800 underline">
          view the payments list
        </Link>{" "}
        or keep it with <strong>{paymentId}</strong>
        {entryId === undefined ? "" : ` (event ${entryId})`}.
      </p>
    </div>
  );
}

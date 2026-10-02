/**
 * The universal-inbox feed (P3-W2-002) — consuming the certified
 * command-center view-model (`aggregateInbox`). Entries render with their
 * urgency (RECONCILING renders the unknown tone — amber, reconciling —
 * NEVER a failure treatment) and their actions; an empty inbox renders the
 * honest empty state. The snapshot arrives from authority records; today it
 * is honestly empty (no session plane), and the feed fills when it ships.
 */

import Link from "next/link";
import type { CommandCenterSnapshot } from "@payswap/ux";
import { aggregateInbox } from "@payswap/ux";
import { EmptyState, Panel, StatusPill } from "@payswap/design";
import type { InboxUrgency, UniversalInbox, ViewAction } from "@payswap/ux";

const URGENCY_TONES: Readonly<Record<InboxUrgency, "attention" | "unknown" | "ok" | "disabled">> = {
  ACTION_REQUIRED: "attention",
  RECONCILING: "unknown",
  REVIEW: "attention",
  FYI: "disabled",
};

export const INBOX_URGENCY_LEGEND: ReadonlyArray<readonly [InboxUrgency, string]> = [
  ["ACTION_REQUIRED", "an authority record needs this viewer's action (approval, confirmation)"],
  ["RECONCILING", "an outcome is unknown and reconciliation owns it — never a failure"],
  ["REVIEW", "a record invites review before it becomes actionable"],
  ["FYI", "informational lineage only"],
];

function InboxActionLine({ action }: { readonly action: ViewAction }) {
  if (!action.available) {
    return (
      <li className="cc-actions__item">
        <span className="cc-actions__reason">
          {action.label} — {action.unavailableReason ?? "unavailable"}
        </span>
      </li>
    );
  }
  if (action.kind === "NAVIGATION" || action.kind === "EVIDENCE_VIEW") {
    const href = action.kind === "EVIDENCE_VIEW" ? "/app/evidence" : "/app/activity";
    return (
      <li className="cc-actions__item">
        <Link href={href}>{action.label}</Link>
      </li>
    );
  }
  return (
    <li className="cc-actions__item">
      <span className="cc-actions__reason">
        {action.label} — available once the session plane authorizes it
      </span>
    </li>
  );
}

export function CcInboxFeed({
  snapshot,
  nowMs,
}: {
  readonly snapshot: CommandCenterSnapshot;
  readonly nowMs: number;
}) {
  const inbox: UniversalInbox = aggregateInbox(snapshot, nowMs);
  return (
    <Panel
      title="Universal inbox"
      description="Every authority record for this viewer — approvals, executions, mandates, off-network records — aggregated with deterministic urgency. Reconciling entries are UNKNOWN outcomes (amber), never failures."
      actions={
        <span className="ps-badge" aria-label={`${inbox.entries.length} entries`}>
          {inbox.entries.length} entries
        </span>
      }
    >
      {inbox.entries.length === 0 ? (
        <EmptyState
          title="No activity yet"
          description="The inbox derives from authority records for this viewer, and none exist yet. An empty snapshot is still an honest snapshot — nothing is back-filled, nothing is simulated. The feed fills from the authoritative API once the session plane ships."
        />
      ) : (
        <ul className="cc-actions">
          {inbox.entries.map((entry) => (
            <li key={`${entry.domain}:${entry.authorityRef}`} className="cc-actions__item">
              <StatusPill tone={URGENCY_TONES[entry.urgency]}>{entry.urgency}</StatusPill>
              <span>
                <strong>{entry.title}</strong> — {entry.reason}
              </span>
              <ul className="cc-actions">
                {entry.actions.map((action) => (
                  <InboxActionLine key={action.actionId} action={action} />
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

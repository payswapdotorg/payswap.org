import type { HTMLAttributes, OlHTMLAttributes, ReactNode } from "react";
import { cx } from "../utils/cx.js";

export interface ActivityTimelineEntry {
  /** Entry key (event id). */
  id: string;
  /** The human sentence ("Payment authorized"). */
  description: ReactNode;
  /** App-formatted timestamp — this package holds no clock/locale logic. */
  timestamp?: ReactNode;
  /** Optional actor ("System", "acme@example.com"). */
  actor?: ReactNode;
}

export interface ActivityTimelineProps
  extends OlHTMLAttributes<HTMLOListElement> {
  /**
   * Entries in REVERSE-CHRONOLOGICAL order — latest state first (terminal
   * first). The component renders the order it is given; sorting is the
   * consumer's (this package never parses timestamps).
   */
  entries: ActivityTimelineEntry[];
  /** When provided, each entry renders an [Add note] affordance. */
  onAddNote?: (entryId: string) => void;
  addNoteLabel?: string;
  /** Rendered when there are no entries. */
  empty?: ReactNode;
}

/**
 * ActivityTimeline (contract 03 §2.5): a reverse-chronological event list.
 * Each entry = human sentence + timestamp + optional actor + optional
 * [Add note]. Latest state at the top; every entry is honest history —
 * nothing here rewrites or reorders records, the consumer supplies the log
 * as recorded.
 */
export function ActivityTimeline({
  entries,
  onAddNote,
  addNoteLabel = "Add note",
  empty,
  className,
  ...rest
}: ActivityTimelineProps) {
  if (entries.length === 0 && empty !== undefined) {
    return <>{empty}</>;
  }
  return (
    <ol className={cx("ps-timeline", className)} {...rest}>
      {entries.map((entry) => (
        <li key={entry.id} className="ps-timeline__item">
          <span className="ps-timeline__marker" aria-hidden="true" />
          <div className="ps-timeline__entry">
            <p className="ps-timeline__description">{entry.description}</p>
            {entry.timestamp || entry.actor ? (
              <p className="ps-timeline__meta">
                {entry.timestamp ? (
                  <span className="ps-timeline__timestamp ps-num">
                    {entry.timestamp}
                  </span>
                ) : null}
                {entry.actor ? (
                  <span className="ps-timeline__actor">{entry.actor}</span>
                ) : null}
              </p>
            ) : null}
            {onAddNote ? (
              <button
                type="button"
                className="ps-timeline__note"
                onClick={() => onAddNote(entry.id)}
              >
                {addNoteLabel}
              </button>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../utils/cx.js";

export interface KeyValueEntry {
  /** Row label (e.g. "CONFIDENCE", "Evidence", "Created"). */
  key: string;
  /** Inline value — rendered as given. */
  value?: ReactNode;
  /** Date-typed value: rendered through the pure `formatDate` prop. */
  date?: string | number;
  /** Mono presentation for ids/hashes (default false). */
  mono?: boolean;
}

export interface KeyValueProps extends HTMLAttributes<HTMLDListElement> {
  /** Metadata rows (the reference's item-card pattern). */
  entries: KeyValueEntry[];
  /**
   * PURE date formatter for `date` entries (e.g. relative "about 3 hours
   * ago"). Supplied by the application so this package stays free of
   * locale/clock logic. Required when any entry uses `date`.
   */
  formatDate?: (input: string | number) => ReactNode;
  /** Compact rows (command-center density). */
  dense?: boolean;
}

/**
 * Definition-list metadata rows: small-caps keys, tabular values, mono for
 * ids/hashes. Missing values render an honest "—" — never a placeholder
 * number. Dates are formatted by the application's pure formatter.
 */
export function KeyValue({
  entries,
  formatDate,
  dense = false,
  className,
  ...rest
}: KeyValueProps) {
  return (
    <dl className={cx("ps-kv", dense && "ps-kv--dense", className)} {...rest}>
      {entries.map((entry) => {
        const value: ReactNode =
          entry.value !== undefined
            ? entry.value
            : entry.date !== undefined
              ? (formatDate?.(entry.date) ?? String(entry.date))
              : "—";
        return (
          <div key={entry.key} className="ps-kv__row">
            <dt className="ps-kv__key">{entry.key}</dt>
            <dd className={cx("ps-kv__value", entry.mono && "ps-mono")}>{value}</dd>
          </div>
        );
      })}
    </dl>
  );
}

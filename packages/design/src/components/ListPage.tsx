"use client";

import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../utils/cx.js";
import { Button } from "./Button.js";
import { EmptyState } from "./States.js";

export interface ListPageRow {
  /** Row key (object id). */
  id: string;
  /** Drill-to-detail target — rows are links (contract 03 §3). */
  href?: string;
  /**
   * Cell contents, one per column. Data conventions are the consumer's:
   * masked identifiers ("••• 4242"), amounts always "X CUR", and the
   * failure-reason column renders "—" even when all rows are healthy.
   */
  cells: ReactNode[];
  /** Trailing row-menu slot (row-scoped actions), rendered as the last cell. */
  menu?: ReactNode;
}

export interface ListPagePagination {
  /** 1-based index of the first visible row. */
  from: number;
  /** 1-based index of the last visible row. */
  to: number;
  /** Total result count across pages. */
  total: number;
  /** Previous-page handler; omit to render the control disabled. */
  onPreviousPage?: () => void;
  /** Next-page handler; omit to render the control disabled. */
  onNextPage?: () => void;
}

export interface ListPageProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  /** Page title (h1). */
  title: ReactNode;
  /** Primary Create action — pass a CreateMenu to get chords (contract 03 §2.1). */
  create?: ReactNode;
  /** Secondary header actions. */
  secondaryActions?: ReactNode;
  /** SubTabs slot — facets of the collection (pass the Tabs primitive). */
  subtabs?: ReactNode;
  /** StatusChips slot — the state vocabulary filters. */
  statusChips?: ReactNode;
  /** Filter slot. */
  filter?: ReactNode;
  /** Column headers, in order. */
  columns: ReactNode[];
  /** Rows; absent or empty with loading=false renders the EmptyState. */
  rows?: ListPageRow[];
  /** Loading renders skeleton rows matching the final layout (never page-gating spinners). */
  loading?: boolean;
  /** How many skeleton rows to render while loading (default 5). */
  loadingRowCount?: number;
  /** The collection's EmptyState — every collection MUST define one (contract 03 §2.3). */
  empty?: ReactNode;
  /** ListFooter: "N–M of X results" + pagination. */
  pagination?: ListPagePagination;
}

/**
 * ListPage — the anatomy of every collection route (contract 03 §2.1):
 * header (title + Create + secondary actions) → subtabs + status chips +
 * filter → DataTable → footer ("N–M of X results" + pagination).
 *
 * Table semantics: sticky header row, 44px rows, arrow keys traverse the
 * row links, Enter activates (native anchors), rows drill to detail via a
 * stretched link over the whole row. The trailing row-menu cell (when
 * present) stacks above the stretched link so row-scoped actions stay
 * clickable. Presentation-only: data, masking and pagination math belong
 * to the consumer.
 */
export function ListPage({
  title,
  create,
  secondaryActions,
  subtabs,
  statusChips,
  filter,
  columns,
  rows,
  loading = false,
  loadingRowCount = 5,
  empty,
  pagination,
  className,
  ...rest
}: ListPageProps) {
  const hasMenuColumn = (rows ?? []).some((row) => Boolean(row.menu));
  const columnCount = columns.length + (hasMenuColumn ? 1 : 0);

  const handleBodyKeyDown = (
    event: React.KeyboardEvent<HTMLTableSectionElement>,
  ): void => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      return;
    }
    const links = Array.from(
      event.currentTarget.querySelectorAll<HTMLAnchorElement>(
        "a.ps-table__row-link",
      ),
    );
    if (links.length === 0) {
      return;
    }
    const current = links.findIndex((link) => link === document.activeElement);
    const next =
      event.key === "ArrowDown"
        ? Math.min(current + 1, links.length - 1)
        : Math.max(current - 1, 0);
    const target = links[next];
    if (target && target !== document.activeElement) {
      event.preventDefault();
      target.focus();
    }
  };

  return (
    <div className={cx("ps-listpage", className)} {...rest}>
      <header className="ps-listpage__header">
        <h1 className="ps-listpage__title">{title}</h1>
        <div className="ps-listpage__actions">
          {secondaryActions}
          {create}
        </div>
      </header>
      {subtabs || statusChips || filter ? (
        <div className="ps-listpage__toolbar">
          {subtabs ? <div className="ps-listpage__subtabs">{subtabs}</div> : null}
          {statusChips ? (
            <div className="ps-listpage__chips">{statusChips}</div>
          ) : null}
          {filter ? <div className="ps-listpage__filter">{filter}</div> : null}
        </div>
      ) : null}
      <div className="ps-listpage__tablewrap">
        <table className="ps-table">
          <thead>
            <tr>
              {columns.map((column, index) => (
                <th key={index} scope="col" className="ps-table__th">
                  {column}
                </th>
              ))}
              {hasMenuColumn ? (
                <th scope="col" className="ps-table__th ps-table__th--menu">
                  <span className="ps-sr-only">Row actions</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody
            className={cx(loading && "ps-table__tbody--loading")}
            aria-busy={loading || undefined}
            onKeyDown={handleBodyKeyDown}
          >
            {loading
              ? Array.from({ length: loadingRowCount }, (_, rowIndex) => (
                  <tr key={`skeleton-${rowIndex}`} className="ps-table__row">
                    {columns.map((_, cellIndex) => (
                      <td
                        key={cellIndex}
                        className="ps-table__cell"
                      >
                        {rowIndex === 0 && cellIndex === 0 ? (
                          <span className="ps-sr-only" role="status">
                            Loading…
                          </span>
                        ) : null}
                        <span
                          className="ps-table__skeleton"
                          aria-hidden="true"
                        />
                      </td>
                    ))}
                  </tr>
                ))
              : (rows ?? []).length > 0
                ? rows!.map((row) => (
                    <tr key={row.id} className="ps-table__row">
                      {row.cells.map((cell, cellIndex) => (
                        <td key={cellIndex} className="ps-table__cell">
                          {cellIndex === 0 && row.href ? (
                            <a className="ps-table__row-link" href={row.href}>
                              {cell}
                            </a>
                          ) : (
                            cell
                          )}
                        </td>
                      ))}
                      {row.menu ? (
                        <td className="ps-table__cell ps-table__cell--menu">
                          {row.menu}
                        </td>
                      ) : null}
                    </tr>
                  ))
                : (
                    <tr className="ps-table__row">
                      <td colSpan={columnCount} className="ps-table__empty">
                        {empty ?? <EmptyState title="Nothing here yet" />}
                      </td>
                    </tr>
                  )}
          </tbody>
        </table>
      </div>
      {pagination ? (
        <footer className="ps-listpage__footer">
          <p className="ps-listpage__count ps-num">
            {pagination.from}–{pagination.to} of {pagination.total} results
          </p>
          <div className="ps-listpage__pager">
            <Button
              size="sm"
              disabled={!pagination.onPreviousPage}
              onClick={pagination.onPreviousPage}
            >
              Previous
            </Button>
            <Button
              size="sm"
              disabled={!pagination.onNextPage}
              onClick={pagination.onNextPage}
            >
              Next
            </Button>
          </div>
        </footer>
      ) : null}
    </div>
  );
}

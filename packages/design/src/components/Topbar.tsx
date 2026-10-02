import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../utils/cx.js";

export interface TopbarProps extends HTMLAttributes<HTMLElement> {
  /** Leading slot (mobile: the navigation trigger button). */
  leading?: ReactNode;
  /** Breadcrumb trail (workspace / page). */
  breadcrumbs?: Array<{ label: string; href?: string }>;
  /** Search trigger handler — renders the "Search… ⌘K" button when provided. */
  onSearch?: () => void;
  /** Visible trigger text (default "Search…"). */
  searchText?: string;
  /** Accessible name for the search trigger (default "Open search"). */
  searchLabel?: string;
  /** Visible shortcut hint inside the trigger (default "⌘K"). */
  searchHint?: string;
  /** Primary action slot (e.g. a primary Button). */
  actions?: ReactNode;
  /** Context badge slot (environment, version — never financial state). */
  badges?: ReactNode;
}

/**
 * Top application bar: banner landmark carrying the breadcrumb trail, the
 * search/command trigger (with the advertised shortcut), the primary action
 * and context badges — the reference's verified layout, slot-based so the
 * composition stays in consumer hands.
 */
export function Topbar({
  leading,
  breadcrumbs,
  onSearch,
  searchText = "Search…",
  searchLabel = "Open search",
  searchHint = "⌘K",
  actions,
  badges,
  className,
  ...rest
}: TopbarProps) {
  return (
    <header className={cx("ps-topbar", className)} {...rest}>
      {leading ? <div className="ps-topbar__leading">{leading}</div> : null}
      {breadcrumbs && breadcrumbs.length > 0 ? (
        <nav aria-label="Breadcrumb" className="ps-topbar__breadcrumbs">
          <ol className="ps-topbar__breadcrumb-list">
            {breadcrumbs.map((crumb, index) => {
              const last = index === breadcrumbs.length - 1;
              return (
                <li key={`${crumb.label}-${index}`} className="ps-topbar__breadcrumb-item">
                  {crumb.href && !last ? (
                    <a href={crumb.href} className="ps-topbar__breadcrumb-link">
                      {crumb.label}
                    </a>
                  ) : (
                    <span
                      aria-current={last ? "page" : undefined}
                      className={cx(
                        "ps-topbar__breadcrumb-text",
                        last && "ps-topbar__breadcrumb-text--current",
                      )}
                    >
                      {crumb.label}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        </nav>
      ) : null}
      {typeof onSearch === "function" ? (
        <button
          type="button"
          className="ps-topbar__search"
          onClick={onSearch}
          aria-label={searchLabel}
        >
          <span className="ps-topbar__search-label" aria-hidden="true">
            {searchText}
          </span>
          <kbd className="ps-topbar__kbd" aria-hidden="true">
            {searchHint}
          </kbd>
        </button>
      ) : null}
      <div className="ps-topbar__end">
        {badges ? <div className="ps-topbar__badges">{badges}</div> : null}
        {actions ? <div className="ps-topbar__actions">{actions}</div> : null}
      </div>
    </header>
  );
}

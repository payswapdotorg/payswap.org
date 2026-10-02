import type { ReactNode } from "react";
import { cx } from "../utils/cx.js";
import { useId } from "../hooks/useId.js";

export interface PanelProps {
  /** Panel heading text (required: panels are titled sections). */
  title: ReactNode;
  /** Optional supporting line under the title. */
  description?: ReactNode;
  /** Right-aligned header actions (buttons, menus). */
  actions?: ReactNode;
  children: ReactNode;
  /** Heading level for the title (default 2 — panels sit under page h1). */
  headingLevel?: 2 | 3 | 4;
  /** Removes body padding (for tables/flush lists). */
  flush?: boolean;
  id?: string;
  className?: string;
  ["data-testid"]?: string;
}

/**
 * Titled section panel — the workhorse surface for grouped content, matching
 * the reference's panel density (header with title + actions, bordered body).
 */
export function Panel({
  title,
  description,
  actions,
  children,
  headingLevel = 2,
  flush = false,
  id,
  className,
  ...rest
}: PanelProps) {
  const panelId = useId("ps-panel", id);
  const headingId = `${panelId}-heading`;
  const Heading = (`h${headingLevel}` as const) satisfies "h2" | "h3" | "h4";

  return (
    <section
      className={cx("ps-panel", className)}
      id={panelId}
      aria-labelledby={headingId}
      data-testid={rest["data-testid"]}
    >
      <header className="ps-panel__header">
        <div>
          <Heading id={headingId} className="ps-panel__heading">
            {title}
          </Heading>
          {description ? (
            <p className="ps-panel__description">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="ps-panel__actions">{actions}</div> : null}
      </header>
      <div className={cx("ps-panel__body", flush && "ps-panel__body--flush")}>
        {children}
      </div>
    </section>
  );
}

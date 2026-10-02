import type { HTMLAttributes } from "react";
import { cx } from "../utils/cx.js";

export interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {
  /** Number of shimmer lines (default 1). */
  count?: number;
  /**
   * Screen-reader announcement for the loading region. Skeletons are for
   * LOADING only — never a substitute for absent data (use EmptyState /
   * UnknownState / ErrorState when there is nothing real to show). The
   * shimmer itself is aria-hidden; this label is what assistive tech gets.
   */
  announce?: string | null;
}

/**
 * Loading placeholder. Renders `count` shimmer lines inside a polite
 * status region labelled `announce` (default "Loading…"; pass null to
 * opt out when a parent already announces the loading state).
 *
 * HONEST-USE CONTRACT: a Skeleton asserts "content is loading", nothing
 * else. It must never imply data exists, and must be removed the moment
 * loading ends (success, empty, error, or unknown).
 */
export function Skeleton({
  count = 1,
  announce = "Loading…",
  className,
  ...rest
}: SkeletonProps) {
  const lines = Array.from({ length: count }, (_, index) => index);
  const body = (
    <div className={cx("ps-skeleton__lines", className)} aria-hidden="true" {...rest}>
      {lines.map((index) => (
        <div
          key={index}
          className={cx("ps-skeleton", index === count - 1 && "ps-skeleton--last")}
          style={index === count - 1 ? { width: "60%" } : undefined}
        />
      ))}
    </div>
  );

  if (announce === null) {
    return body;
  }
  return (
    <div role="status" aria-live="polite">
      <span className="ps-sr-only">{announce}</span>
      {body}
    </div>
  );
}

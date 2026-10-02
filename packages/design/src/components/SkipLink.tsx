import type { AnchorHTMLAttributes } from "react";
import { cx } from "../utils/cx.js";

export interface SkipLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  /** Target of the jump — the id of the main content region. */
  href?: string;
}

/**
 * Keyboard-first entry point: the first focusable element on a page, hidden
 * until focused, jumping past the sidebar/topbar chrome to the main content.
 * The reference has no skip link — a gap PaySwap deliberately closes.
 * For the jump to land, the target element should be focusable
 * (e.g. `<main id="main" tabIndex={-1}>`).
 */
export function SkipLink({ href = "#main-content", className, ...rest }: SkipLinkProps) {
  return (
    <a href={href} className={cx("ps-skip-link", className)} {...rest}>
      Skip to main content
    </a>
  );
}

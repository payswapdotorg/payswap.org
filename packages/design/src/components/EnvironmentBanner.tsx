import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../utils/cx.js";
import type { EnvironmentKind } from "../tokens.js";

export interface EnvironmentBannerProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  /** Which world the surface is operating in. */
  environment: EnvironmentKind;
  /**
   * `banner` (default) — the persistent full-width top-pinned strip
   * (contract 01 §2). `badge` — the compact marking reused on hosted
   * payment pages and page titles (contracts 03 §2.11 / 02 §9).
   */
  variant?: "banner" | "badge";
  /**
   * Banner safety-promise sentence. Default is the normative line:
   * "You're using test assets. Nothing here touches real money."
   */
  message?: ReactNode;
  /** Short badge text (badge variant; default "Testnet"). */
  badgeLabel?: string;
  /** Inline exit link label (default "Switch to mainnet"). */
  exitLabel?: string;
  /** Exit link target (rendered as an anchor when provided). */
  exitHref?: string;
  /** Exit handler (rendered as a link-styled button when no href is given). */
  onExit?: () => void;
}

/**
 * EnvironmentBanner (contracts 01 §2 / 02 §9 / 03 §2.11).
 *
 * TEST: the banner states the safety promise in human language and carries
 * the inline exit link. It is NOT dismissible — the marking persists on
 * every page of the test world. The badge variant is the compact marking
 * for hosted payment pages and page titles.
 *
 * LIVE: renders NOTHING in both variants — the default world needs no
 * special marking (contract 02 §2). Both variants draw ONLY from the
 * `env.test` tokens (inverted stone), which are visually distinct from
 * every outcome-state color, so "test" can never read as "error" or
 * "success".
 */
export function EnvironmentBanner({
  environment,
  variant = "banner",
  message,
  badgeLabel,
  exitLabel = "Switch to mainnet",
  exitHref,
  onExit,
  className,
  ...rest
}: EnvironmentBannerProps) {
  if (environment === "live") {
    return null;
  }

  if (variant === "badge") {
    return (
      <span
        className={cx("ps-env-badge", className)}
        data-environment="test"
        data-testid="ps-env-badge"
        {...rest}
      >
        {badgeLabel ?? "Testnet"}
      </span>
    );
  }

  const exitNode = exitHref ? (
    <a className="ps-env-banner__exit" href={exitHref} onClick={onExit}>
      {exitLabel}
    </a>
  ) : onExit ? (
    <button type="button" className="ps-env-banner__exit" onClick={onExit}>
      {exitLabel}
    </button>
  ) : null;

  return (
    <div
      className={cx("ps-env-banner", className)}
      data-environment="test"
      data-testid="ps-env-banner"
      {...rest}
    >
      <p className="ps-env-banner__message">
        <strong>Testnet</strong> —{" "}
        {message ?? "You're using test assets. Nothing here touches real money."}{" "}
        {exitNode}
      </p>
    </div>
  );
}

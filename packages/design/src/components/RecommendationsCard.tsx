import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../utils/cx.js";

export interface RecommendationsCardProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  /** The one-sentence value proposition (what activating this unlocks). */
  proposition: ReactNode;
  /** The single verb CTA label ("Accept payments", "Connect a rail"). */
  ctaLabel: string;
  /** CTA handler (rendered as a button). */
  onCta?: () => void;
  /** CTA target (rendered as an anchor when provided instead of onCta). */
  ctaHref?: string;
  /** Card heading (default "Recommendation"). */
  title?: string;
}

/**
 * RecommendationsCard (contract 03 §2.13): one-sentence value prop + a
 * single verb CTA. Used on Home and empty surfaces for capability
 * activation — one recommendation, one action, no link farms.
 */
export function RecommendationsCard({
  proposition,
  ctaLabel,
  onCta,
  ctaHref,
  title = "Recommendation",
  className,
  ...rest
}: RecommendationsCardProps) {
  return (
    <div className={cx("ps-reco", className)} {...rest}>
      <p className="ps-label">{title}</p>
      <p className="ps-reco__proposition">{proposition}</p>
      {ctaHref ? (
        <a className="ps-reco__cta" href={ctaHref}>
          {ctaLabel}
        </a>
      ) : (
        <button type="button" className="ps-reco__cta" onClick={onCta}>
          {ctaLabel}
        </button>
      )}
    </div>
  );
}

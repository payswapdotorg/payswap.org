import type { HTMLAttributes } from "react";
import { cx } from "../utils/cx.js";
import {
  STATUS_TONES,
  statusToneClass,
  type StatusTone,
} from "../tokens.js";

export type { StatusTone };

/**
 * Neutral metadata badge (version chips, counts, environment markers).
 * Carries no state semantics — use StatusPill for outcomes.
 */
export function Badge({
  className,
  ...rest
}: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cx("ps-badge", className)} {...rest} />;
}

export interface StatusPillProps extends HTMLAttributes<HTMLSpanElement> {
  /**
   * Semantic state. `unknown` (outcome not yet known — reconciling) is
   * visually distinct from `failed`/`blocked` (danger) by construction:
   * amber ramp + dashed border + hollow dot vs red ramp + solid dot.
   */
  tone: StatusTone;
  /** Optional extra description for assistive tech (state must never be color-only). */
  visuallyHiddenLabel?: string;
}

const DEFAULT_TONE_LABELS: Record<StatusTone, string> = {
  ok: "confirmed",
  attention: "action required",
  unknown: "outcome not yet known",
  blocked: "blocked",
  disabled: "inactive",
  failed: "failed",
};

/**
 * State pill. The text label is always visible — color and shape are
 * secondary carriers, never the only one. Default suffix labels can be
 * overridden per instance via `visuallyHiddenLabel`.
 */
export function StatusPill({
  tone,
  visuallyHiddenLabel,
  className,
  children,
  ...rest
}: StatusPillProps) {
  return (
    <span
      className={cx("ps-pill", statusToneClass[tone], className)}
      data-tone={tone}
      {...rest}
    >
      <span className="ps-pill__dot" aria-hidden="true" />
      {children}
      <span className="ps-sr-only">
        {visuallyHiddenLabel ?? DEFAULT_TONE_LABELS[tone]}
      </span>
    </span>
  );
}

/** All tones, for consumers building state-driven pickers. */
export const STATUS_PILL_TONES = STATUS_TONES;

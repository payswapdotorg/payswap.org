import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../utils/cx.js";
import { useId } from "../hooks/useId.js";
import {
  OUTCOME_STATES,
  stateChipClass,
  stateLabel,
  type OutcomeState,
} from "../tokens.js";

export type { OutcomeState };
/** All eight states, for consumers building state-driven pickers. */
export const STATUS_CHIP_STATES = OUTCOME_STATES;

/**
 * Per-state icons: generic geometric glyphs authored for this system (no
 * third-party assets). The icon is a SECONDARY carrier — the visible word
 * label always carries the state, so color/shape are never the only signal.
 */
const STATE_ICONS: Record<OutcomeState, ReactNode> = {
  /* succeeded — circled check */
  succeeded: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" focusable="false">
      <circle cx="8" cy="8" r="6.25" />
      <path d="M5.25 8.25l1.9 1.9 3.6-4.1" />
    </svg>
  ),
  /* processing — clock face (in-flight; paired with the pulse affordance) */
  processing: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" focusable="false">
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 4.75V8l2.25 1.6" />
    </svg>
  ),
  /* failed — circled cross (terminal failure) */
  failed: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" focusable="false">
      <circle cx="8" cy="8" r="6.25" />
      <path d="M6 6l4 4M10 6l-4 4" />
    </svg>
  ),
  /* refunded — return arrow, solid arc (reversed after success) */
  refunded: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" focusable="false">
      <path d="M13 8a5 5 0 1 1-2.1-4.07" />
      <path d="M11.1 1.6v2.4h2.4" />
    </svg>
  ),
  /* partially_refunded — return arrow, dashed arc (partially reversed) */
  partially_refunded: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" focusable="false">
      <path d="M13 8a5 5 0 1 1-2.1-4.07" strokeDasharray="2.6 2" />
      <path d="M11.1 1.6v2.4h2.4" />
    </svg>
  ),
  /* disputed — two opposing arrows (contested; evidence due) */
  disputed: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" focusable="false">
      <path d="M2.75 5.25h9.5" />
      <path d="M9.75 3l2.5 2.25-2.5 2.25" />
      <path d="M13.25 10.75h-9.5" />
      <path d="M6.25 8.5L3.75 10.75l2.5 2.25" />
    </svg>
  ),
  /* blocked — prohibition mark (stopped by policy before execution) */
  blocked: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" focusable="false">
      <circle cx="8" cy="8" r="6.25" />
      <path d="M3.75 3.75l8.5 8.5" />
    </svg>
  ),
  /* dropped — broken-tracking circle (unknown/timeout after broadcast) */
  dropped: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" focusable="false">
      <circle cx="8" cy="8" r="6.25" strokeDasharray="2.3 2.1" />
      <circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  ),
};

export interface StatusChipProps extends HTMLAttributes<HTMLSpanElement> {
  /**
   * Outcome state — the eight-state vocabulary (contract 03 §2.2, TL-review
   * R1). This component is THE outcome renderer: lists, detail headers,
   * events and toasts all render outcome through it, identically.
   */
  state: OutcomeState;
  /**
   * Word label override. Defaults to the state's word ("Succeeded") —
   * chips render words, never codes (contract 02 §7).
   */
  label?: string | undefined;
  /**
   * Optional technical detail ("Settled in block 192…"). Rendered as the
   * native tooltip AND as a screen-reader description wired through
   * aria-describedby, so the detail is reachable without hover.
   */
  detail?: string | undefined;
  /**
   * Stable test hook. Defaults to `ps-chip-<state>` (e.g. `ps-chip-succeeded`)
   * so regression suites can target chips without consumer wiring.
   */
  "data-testid"?: string;
}

/**
 * StatusChip — THE outcome-state renderer (contracts 02 §7 / 03 §2.2).
 *
 * Anatomy: state icon + visible word label + optional technical-detail
 * tooltip. The label is always visible; the icon is aria-hidden; the state
 * is exposed as `data-state` and the token mapping is fixed per state
 * (see `stateTokenFamily` in tokens.ts). `processing` is never red and
 * carries a subtle pulse affordance (collapsed under reduced motion);
 * `dropped` (unknown/timeout) never wears failure styling.
 *
 * Presentation-only: no outcome derivation, no network, no tooltips that
 * fetch anything — the consumer states the truth, the chip renders it.
 */
export function StatusChip({
  state,
  label,
  detail,
  className,
  "data-testid": testId,
  ...rest
}: StatusChipProps) {
  const detailId = useId("ps-chip-detail");
  return (
    <span
      className={cx("ps-chip", stateChipClass[state], className)}
      data-state={state}
      data-testid={testId ?? `ps-chip-${state}`}
      title={detail}
      aria-describedby={detail ? detailId : undefined}
      {...rest}
    >
      <span className="ps-chip__icon" aria-hidden="true">
        {STATE_ICONS[state]}
      </span>
      <span className="ps-chip__label">{label ?? stateLabel[state]}</span>
      {detail ? (
        <span id={detailId} className="ps-sr-only">
          {detail}
        </span>
      ) : null}
    </span>
  );
}

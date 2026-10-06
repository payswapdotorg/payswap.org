import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../utils/cx.js";
import { StatusChip } from "./StatusChip.js";
import type { OutcomeState } from "../tokens.js";

export interface ObjectDetailHeaderProps
  extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  /**
   * Display amount ("€25.00") — rendered in display typography with tabular
   * figures, in its own node, never mixed with other text (contract 02 §3).
   * The consumer formats it; this package has no money semantics.
   */
  amount: ReactNode;
  /** Outcome state — rendered through StatusChip (the only outcome renderer). */
  state: OutcomeState;
  /** Technical detail for the StatusChip tooltip ("Settled in block 192…"). */
  stateDetail?: string;
  /** Word-label override for the StatusChip. */
  stateLabelOverride?: string;
  /** Human strapline ("Charged to acme@example.com"). */
  strapline?: ReactNode;
  /** Human reason line under the strapline (contract 07 §3.2 — failed objects). */
  reason?: ReactNode;
  /** The object's most likely next move (Refund / Retry / Cancel). */
  primaryAction?: ReactNode;
  /** Overflow menu for the remaining actions. */
  overflowMenu?: ReactNode;
}

/**
 * ObjectDetailHeader (contract 03 §2.4): display amount + StatusChip +
 * human strapline + primary action + overflow menu. This is the canonical
 * header of every object detail page; the amount is the page's display
 * number and the primary action is the object's most likely next move.
 */
export function ObjectDetailHeader({
  amount,
  state,
  stateDetail,
  stateLabelOverride,
  strapline,
  reason,
  primaryAction,
  overflowMenu,
  className,
  ...rest
}: ObjectDetailHeaderProps) {
  return (
    <header className={cx("ps-detail-header", className)} {...rest}>
      <div className="ps-detail-header__main">
        <p className="ps-detail-header__amount ps-num">{amount}</p>
        <StatusChip state={state} detail={stateDetail} label={stateLabelOverride} />
        {strapline ? (
          <p className="ps-detail-header__strapline">{strapline}</p>
        ) : null}
        {reason ? <p className="ps-detail-header__reason">{reason}</p> : null}
      </div>
      <div className="ps-detail-header__actions">
        {primaryAction}
        {overflowMenu}
      </div>
    </header>
  );
}

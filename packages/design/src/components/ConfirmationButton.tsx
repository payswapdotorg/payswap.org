import type { ButtonHTMLAttributes } from "react";
import { cx } from "../utils/cx.js";
import { Button, type ButtonSize, type ButtonVariant } from "./Button.js";

export interface ConfirmationButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  /** The verb ("Pay", "Refund", "Retry", "Convert"). */
  verb: string;
  /**
   * The amount digits ("25"). Rendered in its own tabular-figures node —
   * money numbers never mix with text in one node (contract 02 §3).
   */
  amount: string;
  /** The asset / currency unit ("USDC"). */
  asset: string;
  /**
   * In-button Processing state: the button disables, shows a spinner AND
   * keeps restating what is being processed ("Processing 25 USDC…").
   * Spinner-only money buttons are forbidden (contract 03 §2.15).
   */
  processing?: boolean;
  variant?: ButtonVariant;
  size?: ButtonSize;
}

/**
 * ConfirmationButton (contract 03 §2.15): the money-moving button. It
 * RESTATES the amount + asset in its own label ("Pay 25 USDC") so the
 * confirmation travels with the action, and exposes an in-button
 * Processing state that stays legible (spinner + restated amount, never
 * spinner-only). Presentation-only: it moves nothing itself — the consumer
 * wires the actual action; the button guarantees the shape of the promise.
 */
export function ConfirmationButton({
  verb,
  amount,
  asset,
  processing = false,
  variant = "primary",
  size = "md",
  disabled,
  className,
  ...rest
}: ConfirmationButtonProps) {
  return (
    <Button
      variant={variant}
      size={size}
      disabled={disabled === true || processing}
      aria-busy={processing || undefined}
      className={cx("ps-confirm", className)}
      data-processing={processing || undefined}
      {...rest}
    >
      {processing ? (
        <>
          <span className="ps-spinner" aria-hidden="true" />
          <span className="ps-confirm__verb">Processing</span>
          <span className="ps-confirm__amount ps-num">{amount}</span>
          <span className="ps-confirm__asset">{asset}…</span>
        </>
      ) : (
        <>
          <span className="ps-confirm__verb">{verb}</span>
          <span className="ps-confirm__amount ps-num">{amount}</span>
          <span className="ps-confirm__asset">{asset}</span>
        </>
      )}
    </Button>
  );
}

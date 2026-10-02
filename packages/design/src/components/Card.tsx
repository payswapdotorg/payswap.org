import type { HTMLAttributes, KeyboardEvent } from "react";
import { cx } from "../utils/cx.js";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** Elevates with shadow level 1 (raised card). */
  raised?: boolean;
  /**
   * Full-width selectable card (the reference's item cards). Adds role=button
   * + tabindex=0 and activates on Enter/Space like a native button.
   */
  interactive?: boolean;
}

export function Card({
  raised = false,
  interactive = false,
  className,
  onClick,
  onKeyDown,
  ...rest
}: CardProps) {
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (
      interactive &&
      (event.key === "Enter" || event.key === " ") &&
      typeof onClick === "function"
    ) {
      event.preventDefault();
      onClick(event as unknown as React.MouseEvent<HTMLDivElement>);
    }
    onKeyDown?.(event);
  };

  return (
    <div
      className={cx(
        "ps-card",
        raised && "ps-card--raised",
        interactive && "ps-card--interactive",
        className,
      )}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={onClick}
      onKeyDown={interactive ? handleKeyDown : onKeyDown}
      {...rest}
    />
  );
}

export function CardTitle({ className, ...rest }: HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cx("ps-card__title", className)} {...rest} />;
}

export function CardSubtitle({ className, ...rest }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cx("ps-card__subtitle", className)} {...rest} />;
}

/** Metadata footer row (the reference's border-t metadata strip). */
export function CardMeta({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("ps-card__meta", className)} {...rest} />;
}

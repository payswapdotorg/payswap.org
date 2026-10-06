"use client";

import { useRef, type InputHTMLAttributes, type ReactNode } from "react";
import { cx } from "../utils/cx.js";
import { Input } from "./Input.js";

/**
 * Group the integer part of a decimal string with thousands separators.
 * Pure, deterministic, locale-free: "1234.5" → "1,234.5", "1000000" →
 * "1,000,000", already-grouped input is idempotent, and anything that is
 * not a plain optional-sign + digits + optional-decimal string is returned
 * UNCHANGED (this helper formats; it never validates or coerces).
 */
export function groupDigits(value: string): string {
  const normalized = value.trim().replace(/,/g, "");
  const match = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(normalized);
  if (!match) {
    return value;
  }
  const sign = match[1] ?? "";
  const int = match[2] ?? "";
  const dec = match[3];
  if (int === "" && dec === undefined) {
    return value.trim();
  }
  const grouped =
    int === "" ? "" : int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const decimalPart = dec !== undefined ? `.${dec}` : "";
  return `${sign}${grouped}${decimalPart}`;
}

export interface MoneyInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "size" | "children"> {
  /**
   * Currency prefix — a glyph ("€", "$") or asset code ("USDC"). Rendered
   * inside the input's border, before the digits (contract 03 §2.12).
   */
  currency?: ReactNode;
  /**
   * Auto-format (group digits) on blur — the visible auto-format the
   * contract requires. Default true.
   */
  formatOnBlur?: boolean;
}

/**
 * MoneyInput (contract 03 §2.12): a Field-compatible amount input with a
 * currency prefix and blur auto-formatting (thousands grouping via the
 * pure {@link groupDigits}). Presentation-only formatting — it never
 * rounds, converts, or attaches financial meaning; the consumer owns the
 * value's precision rules. Controlled usage: blur formatting calls
 * `onChange` with the formatted value so the consumer can adopt it;
 * uncontrolled usage: the formatted value is applied directly.
 */
export function MoneyInput({
  currency,
  formatOnBlur = true,
  className,
  value,
  defaultValue,
  onChange,
  onBlur,
  inputMode = "decimal",
  ...rest
}: MoneyInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const isControlled = value !== undefined;

  const handleBlur = (event: React.FocusEvent<HTMLInputElement>): void => {
    if (formatOnBlur) {
      const current = inputRef.current?.value ?? event.target.value;
      const formatted = groupDigits(current);
      if (formatted !== current) {
        // Apply the grouping to the DOM directly. Uncontrolled: it simply
        // stays. Controlled: also notify via onChange so the consumer can
        // adopt the formatted value; a consumer that keeps its own model
        // sees no re-render, so the grouping still displays.
        if (inputRef.current) {
          inputRef.current.value = formatted;
        }
        if (isControlled) {
          onChange?.({
            ...event,
            target: { ...event.target, value: formatted },
          } as React.ChangeEvent<HTMLInputElement>);
        }
      }
    }
    onBlur?.(event);
  };

  return (
    <div className={cx("ps-money-input", className)}>
      {currency !== undefined && currency !== "" ? (
        <span className="ps-money-input__prefix">{currency}</span>
      ) : null}
      <Input
        ref={inputRef}
        className="ps-money-input__input"
        value={value}
        defaultValue={defaultValue}
        onChange={onChange}
        onBlur={handleBlur}
        inputMode={inputMode}
        {...rest}
      />
    </div>
  );
}

import {
  useRef,
  useState,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { cx } from "../utils/cx.js";
import { useId } from "../hooks/useId.js";

export interface TabItem {
  /** Stable id (used for value/onChange and element ids). */
  id: string;
  label: ReactNode;
  content: ReactNode;
  disabled?: boolean;
}

export interface TabsProps extends Omit<HTMLAttributes<HTMLDivElement>, "onChange"> {
  /** Accessible name for the tablist (the question the tabs answer). */
  label: string;
  items: TabItem[];
  /** Controlled active tab id. */
  value?: string;
  /** Uncontrolled initial tab id (defaults to the first enabled tab). */
  defaultValue?: string;
  onValueChange?: (id: string) => void;
  /** Base id for the tab/tabpanel element ids. */
  id?: string;
}

/**
 * Tabs (WAI-ARIA pattern): roving tabindex, ArrowLeft/ArrowRight with wrap,
 * Home/End, automatic activation (focus selects). Panels are focusable and
 * labelled by their tabs; only the selected panel renders.
 */
export function Tabs({
  label,
  items,
  value,
  defaultValue,
  onValueChange,
  id,
  className,
  ...rest
}: TabsProps) {
  const baseId = useId("ps-tabs", id);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [internal, setInternal] = useState<string | undefined>(defaultValue);

  const enabledIds = items.filter((item) => !item.disabled).map((item) => item.id);
  const firstEnabled = enabledIds[0] ?? items[0]!.id;
  const active = value ?? internal ?? firstEnabled;

  const select = (nextId: string): void => {
    if (nextId !== active) {
      setInternal(nextId);
      onValueChange?.(nextId);
    }
  };

  const focusTab = (index: number): void => {
    const el = tabRefs.current[index];
    if (el) {
      el.focus();
    }
  };

  const move = (from: number, delta: number): void => {
    if (items.length === 0) {
      return;
    }
    let index = from;
    for (let step = 0; step < items.length; step += 1) {
      index = (index + delta + items.length) % items.length;
      if (!items[index]!.disabled) {
        select(items[index]!.id);
        focusTab(index);
        return;
      }
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const currentIndex = items.findIndex((item) => item.id === active);
    switch (event.key) {
      case "ArrowRight":
        event.preventDefault();
        move(currentIndex, 1);
        break;
      case "ArrowLeft":
        event.preventDefault();
        move(currentIndex, -1);
        break;
      case "Home":
        event.preventDefault();
        move(-1, 1);
        break;
      case "End":
        event.preventDefault();
        move(items.length, -1);
        break;
      default:
        break;
    }
  };

  return (
    <div className={cx("ps-tabs", className)} {...rest}>
      <div
        role="tablist"
        aria-label={label}
        className="ps-tabs__list"
        onKeyDown={onKeyDown}
      >
        {items.map((item, index) => {
          const selected = item.id === active;
          return (
            <button
              key={item.id}
              ref={(el) => {
                tabRefs.current[index] = el;
              }}
              type="button"
              role="tab"
              id={`${baseId}-tab-${item.id}`}
              aria-selected={selected}
              aria-controls={`${baseId}-panel-${item.id}`}
              tabIndex={selected ? 0 : -1}
              disabled={item.disabled}
              className={cx(
                "ps-tab",
                selected && "ps-tab--selected",
                item.disabled && "ps-tab--disabled",
              )}
              onClick={() => select(item.id)}
            >
              {item.label}
            </button>
          );
        })}
      </div>
      {items.map((item) => {
        const selected = item.id === active;
        return (
          <div
            key={item.id}
            role="tabpanel"
            id={`${baseId}-panel-${item.id}`}
            aria-labelledby={`${baseId}-tab-${item.id}`}
            tabIndex={0}
            hidden={!selected}
            className="ps-tabpanel"
          >
            {item.content}
          </div>
        );
      })}
    </div>
  );
}

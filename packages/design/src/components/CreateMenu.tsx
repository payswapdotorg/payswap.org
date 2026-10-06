"use client";

import {
  useEffect,
  useRef,
  useState,
  type HTMLAttributes,
} from "react";
import { cx } from "../utils/cx.js";
import { useId } from "../hooks/useId.js";
import { useGlobalChord } from "../hooks/useGlobalChord.js";
import { Button, type ButtonSize, type ButtonVariant } from "./Button.js";

/**
 * The normative create chords (contract 01 §6 / 03 §2.9). Visible in the
 * menu, active globally while the CreateMenu is mounted.
 */
export const CREATE_CHORDS = {
  pay: "c p",
  request: "c r",
  invoice: "c i",
  link: "c l",
  convert: "c v",
} as const;

export interface CreateMenuItem {
  id: string;
  /** Item label ("Pay", "Request", "Invoice", "Payment link", "Convert"). */
  label: string;
  /** Visible + globally-active chord, e.g. "c p". */
  chord?: string;
  onSelect?: () => void;
}

export interface CreateMenuProps extends HTMLAttributes<HTMLDivElement> {
  /** Menu items — the five canonical creations plus any app additions. */
  items: CreateMenuItem[];
  /**
   * Primary split action (runs on the big button). Defaults to the first
   * item, e.g. "Pay" with its chord shown beside it.
   */
  primary?: { label: string; onSelect?: () => void };
  /** Accessible name of the control (default "Create"). */
  createLabel?: string;
  /** Button variant for the split (default "primary"). */
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Toggle the global chord hook (chords are active globally by default). */
  chordsEnabled?: boolean;
}

/**
 * CreateMenu — the split-button creation affordance (contract 03 §2.9).
 * A primary action plus a toggle opening a menu whose items carry VISIBLE
 * keyboard chords; the chords are active GLOBALLY (not only while open) via
 * `useGlobalChord`. Menu keyboard semantics: Enter/Space/ArrowDown open,
 * ArrowUp/Down traverse, Home/End jump, Escape closes and restores focus to
 * the toggle, pointer-down outside closes. Presentation-only: item behavior
 * is consumer wiring; this component never routes or creates anything.
 */
export function CreateMenu({
  items,
  primary,
  createLabel = "Create",
  variant = "primary",
  size = "md",
  chordsEnabled = true,
  className,
  onKeyDown,
  ...rest
}: CreateMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const menuId = useId("ps-create-menu", undefined);

  const primaryAction =
    primary ?? (items[0] ? { label: items[0].label, onSelect: items[0].onSelect } : undefined);
  const primaryChord = primary ? undefined : items[0]?.chord;

  // Chords are active globally while the CreateMenu is mounted.
  const chordMap = useRef<Record<string, () => void>>({});
  chordMap.current = Object.fromEntries(
    items
      .filter((item) => Boolean(item.chord))
      .map((item) => [
        item.chord as string,
        () => {
          setOpen(false);
          item.onSelect?.();
        },
      ]),
  );
  useGlobalChord(chordMap.current, chordsEnabled && items.length > 0);

  // Focus the first item when the menu opens.
  useEffect(() => {
    if (!open) {
      return;
    }
    const first = rootRef.current?.querySelector<HTMLButtonElement>(
      "[role='menuitem']",
    );
    first?.focus();
  }, [open]);

  // Pointer-down outside closes (click-outside without stealing focus).
  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  const closeMenu = (restoreFocus = true): void => {
    setOpen(false);
    if (restoreFocus) {
      toggleRef.current?.focus();
    }
  };

  const handleToggleKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
  ): void => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
    }
  };

  const handleMenuKeyDown = (
    event: React.KeyboardEvent<HTMLDivElement>,
  ): void => {
    const menuItems = Array.from(
      rootRef.current?.querySelectorAll<HTMLButtonElement>(
        "[role='menuitem']",
      ) ?? [],
    );
    if (menuItems.length === 0) {
      return;
    }
    const currentIndex = menuItems.findIndex(
      (item) => item === document.activeElement,
    );
    let nextIndex: number;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        nextIndex = (currentIndex + 1) % menuItems.length;
        menuItems[nextIndex]?.focus();
        break;
      case "ArrowUp":
        event.preventDefault();
        nextIndex =
          currentIndex <= 0 ? menuItems.length - 1 : currentIndex - 1;
        menuItems[nextIndex]?.focus();
        break;
      case "Home":
        event.preventDefault();
        menuItems[0]?.focus();
        break;
      case "End":
        event.preventDefault();
        menuItems[menuItems.length - 1]?.focus();
        break;
      case "Escape":
        event.preventDefault();
        closeMenu();
        break;
      case "Tab":
        closeMenu(false);
        break;
      default:
        break;
    }
  };

  return (
    <div
      ref={rootRef}
      className={cx("ps-split", className)}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          closeMenu();
        }
      }}
      {...rest}
    >
      {primaryAction ? (
        <Button
          variant={variant}
          size={size}
          className="ps-split__primary"
          onClick={primaryAction.onSelect}
        >
          {primaryAction.label}
          {primaryChord ? (
            <span className="ps-split__chord" aria-hidden="true">
              {primaryChord.split(/[\s+]+/).map((key) => (
                <kbd key={key} className="ps-kbd">
                  {key}
                </kbd>
              ))}
            </span>
          ) : null}
        </Button>
      ) : null}
      <button
        ref={toggleRef}
        type="button"
        className={cx("ps-split__toggle", `ps-split__toggle--${variant}`)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`More ${createLabel.toLowerCase()} actions`}
        onClick={() => {
          if (open) {
            closeMenu();
          } else {
            setOpen(true);
          }
        }}
        onKeyDown={handleToggleKeyDown}
      >
        <span aria-hidden="true">{"\u25BE"}</span>
      </button>
      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-label={createLabel}
          className="ps-menu"
          onKeyDown={handleMenuKeyDown}
        >
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className="ps-menu__item"
              aria-label={item.label}
              onClick={() => {
                setOpen(false);
                item.onSelect?.();
              }}
            >
              <span className="ps-menu__item-label">{item.label}</span>
              {item.chord ? (
                <span className="ps-menu__chord" aria-hidden="true">
                  {item.chord.split(/[\s+]+/).map((key) => (
                    <kbd key={key} className="ps-kbd">
                      {key}
                    </kbd>
                  ))}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Tab-cycle focus trap for modal surfaces (Dialog, CommandPalette, mobile
 * Sidebar drawer). While `active`, Tab/Shift+Tab wrap focus inside the
 * container; on activation the first focusable element (or the container
 * itself, which must carry tabindex="-1") receives focus; on deactivation
 * focus is restored to the previously focused element.
 *
 * Keyboard-path accessibility is acceptance: no keyboard traps outside the
 * requested container, always escapable via the surface's own Escape handler.
 */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.hasAttribute("disabled") && el.getAttribute("aria-hidden") !== "true",
  );
}

export function useFocusTrap(
  ref: React.RefObject<HTMLElement | null>,
  active: boolean,
): void {
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) {
      return;
    }
    const container = ref.current;
    if (!container) {
      return;
    }
    restoreRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const focusables = getFocusable(container);
    if (focusables.length > 0) {
      focusables[0]!.focus();
    } else {
      container.focus();
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Tab") {
        return;
      }
      const scope = ref.current;
      if (!scope) {
        return;
      }
      const items = getFocusable(scope);
      if (items.length === 0) {
        event.preventDefault();
        scope.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const current = document.activeElement;
      const inside = current instanceof Node && scope.contains(current);
      if (event.shiftKey) {
        if (!inside || current === first) {
          event.preventDefault();
          last.focus();
        }
      } else if (!inside || current === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      restoreRef.current?.focus();
      restoreRef.current = null;
    };
  }, [active, ref]);
}

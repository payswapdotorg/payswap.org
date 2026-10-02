import { useEffect, useRef } from "react";

/**
 * Global ⌘K (macOS) / Ctrl-K (Windows/Linux) listener — the command palette
 * trigger pattern observed in the reference top bar ("Search… ⌘K"). The
 * handler identity may change between renders; only the latest is invoked.
 */
export function useCommandKey(handler: () => void, enabled = true): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && (event.key === "k" || event.key === "K")) {
        event.preventDefault();
        handlerRef.current();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [enabled]);
}

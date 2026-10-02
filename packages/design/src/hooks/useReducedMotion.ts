"use client";

import { useEffect, useState } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

/**
 * Reactive prefers-reduced-motion. Mirrors the CSS token collapse in
 * tokens.css; components with JS-driven animation consult this hook so the
 * reduced-motion law holds on both paths.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return false;
    }
    return window.matchMedia(QUERY).matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const mq = window.matchMedia(QUERY);
    const onChange = (): void => setReduced(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => {
      mq.removeEventListener("change", onChange);
    };
  }, []);

  return reduced;
}

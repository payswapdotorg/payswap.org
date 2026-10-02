// NOTE: deliberately NOT "use client" — this hook wraps React's useId,
// which is SSR-safe and works in BOTH server and client components.
// Panel (a server-compatible presentational component) consumes it.
import { useId as useReactId } from "react";

/**
 * Deterministic id helper: consumer-provided id wins, else React's useId
 * (SSR-safe, no collisions across instances). Used to wire aria-labelledby /
 * aria-describedby / aria-controls without forcing consumers to pass ids.
 */
export function useId(prefix: string, id?: string): string {
  const generated = useReactId();
  return id ?? `${prefix}-${generated}`;
}

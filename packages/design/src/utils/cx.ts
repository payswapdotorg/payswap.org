/**
 * Tiny className combiner (no dependencies). Falsy parts are dropped.
 * Presentation-only: never inspects values, never throws.
 */
export function cx(
  ...parts: Array<string | false | null | undefined>
): string {
  let out = "";
  for (const part of parts) {
    if (part) {
      out = out ? `${out} ${part}` : part;
    }
  }
  return out;
}

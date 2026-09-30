/**
 * Capability state vs source availability (FROZEN-ARCHITECTURE §11,
 * INV-C01, INV-C02).
 *
 * Two SEPARATE axes:
 * - CapabilityState — what the capability itself reports (its own health);
 * - SourceAvailability — whether the source that must confirm it is reachable.
 *
 * An unreachable or unknown source means the effective availability is
 * UNKNOWN: never success, never failure. UNKNOWN is not FAILED and always
 * requires reconciliation (AGENTS.md rule 4, INV-X01).
 */

export const CAPABILITY_STATES = ["AVAILABLE", "DEGRADED", "UNAVAILABLE"] as const;
export type CapabilityState = (typeof CAPABILITY_STATES)[number];

export const SOURCE_AVAILABILITIES = ["REACHABLE", "UNREACHABLE", "UNKNOWN"] as const;
export type SourceAvailability = (typeof SOURCE_AVAILABILITIES)[number];

/**
 * The effective availability of a capability. Note: there is deliberately NO
 * 'FAILED' member — external ambiguity can never be converted into failure
 * (INV-X01) or success.
 */
export type EffectiveAvailability =
  | "AVAILABLE"
  | "DEGRADED"
  | "UNAVAILABLE"
  | "UNKNOWN";

/**
 * Resolve the two axes into one effective availability (INV-C01/C02).
 *
 * - source REACHABLE   → the capability state governs;
 * - source UNREACHABLE → UNKNOWN (the state cannot be confirmed);
 * - source UNKNOWN     → UNKNOWN (never success, never failure).
 *
 * Deterministic and total: every (state, source) pair has exactly one result.
 */
export function resolveEffectiveAvailability(
  state: CapabilityState,
  source: SourceAvailability,
): EffectiveAvailability {
  switch (source) {
    case "REACHABLE":
      return state;
    case "UNREACHABLE":
      return "UNKNOWN";
    case "UNKNOWN":
      return "UNKNOWN";
  }
}

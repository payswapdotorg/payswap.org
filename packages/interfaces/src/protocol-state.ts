/**
 * Terminal protocol states and their canonical user-interface projection.
 *
 * Source of truth: spec/architecture/FROZEN-ARCHITECTURE.md §22 (terminal
 * states) and spec/experience/FRONTEND-STATE-MAPPING.md (presentation rules).
 *
 * INV-X01: UNKNOWN is never mapped to FAILED. "UNKNOWN always requires
 * reconciliation" (§22): the UI renders UNKNOWN as `reconciling`, never as a
 * failure state, because absence of knowledge about an external outcome is not
 * failure. Reconciliation is authoritative for ambiguous external effects
 * (INV-X03).
 *
 * USER_ACTION_REQUIRED maps to an explicit `action-required` UI state: it is
 * an actionable condition surfaced from preserved provider state (INV-C06),
 * never a generic error.
 */

export const TERMINAL_STATES = [
  'FULFILLED',
  'WAITING',
  'USER_ACTION_REQUIRED',
  'NO_VIABLE_ROUTE',
  'COMPLIANCE_BLOCKED',
  'EXPIRED',
  'CANCELLED',
  'FAILED',
  'UNKNOWN',
] as const;

export type TerminalState = (typeof TERMINAL_STATES)[number];

/** Canonical UI states (see spec/experience/FRONTEND-STATE-MAPPING.md). */
export const UI_STATES = [
  'fulfilled',
  'reconciling',
  'action-required',
  'no-viable-route',
  'compliance-blocked',
  'expired',
  'cancelled',
  'failed',
] as const;

export type UiState = (typeof UI_STATES)[number];

/** Narrows an unknown value to a TerminalState. */
export function isTerminalState(value: unknown): value is TerminalState {
  return typeof value === 'string' && (TERMINAL_STATES as readonly string[]).includes(value);
}

/**
 * Maps a terminal protocol state (§22) to its canonical UI state.
 *
 * The switch is exhaustive at compile time: adding a member to TerminalState
 * without adding a case makes the `never` default a type error.
 *
 * Invariants encoded:
 * - INV-X01: UNKNOWN → `reconciling` (never `failed`).
 * - USER_ACTION_REQUIRED → explicit `action-required`.
 * - WAITING (external settlement pending) → `reconciling`.
 */
export function mapTerminalStateToUi(state: TerminalState): UiState {
  switch (state) {
    case 'FULFILLED':
      return 'fulfilled';
    case 'WAITING':
      return 'reconciling';
    case 'USER_ACTION_REQUIRED':
      return 'action-required';
    case 'NO_VIABLE_ROUTE':
      return 'no-viable-route';
    case 'COMPLIANCE_BLOCKED':
      return 'compliance-blocked';
    case 'EXPIRED':
      return 'expired';
    case 'CANCELLED':
      return 'cancelled';
    case 'FAILED':
      return 'failed';
    case 'UNKNOWN':
      // INV-X01: UNKNOWN is never FAILED. It always requires reconciliation.
      return 'reconciling';
    default: {
      const exhaustive: never = state;
      throw new Error(`unhandled terminal state: ${String(exhaustive)}`);
    }
  }
}

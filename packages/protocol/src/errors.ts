/**
 * @payswap/protocol — domain error taxonomy (Work Order W1-001).
 *
 * Every error raised by the protocol kernel is a `PaySwapError` carrying a
 * stable machine `code`, a semantic `category` and free-form `details`.
 *
 * INV-X01 (UNKNOWN is never mapped to FAILED) is enforced here:
 * `ExternalAmbiguityError` is an *ambiguity*, not a failure outcome —
 * `isFailureOutcome` returns `false` for it and every instance carries a
 * distinct `requiresReconciliation` flag. Callers must reconcile (INV-X03),
 * never blindly retry (INV-X02) and never coerce it into FAILED or success.
 */

export type ErrorCategory =
  | 'VALIDATION'
  | 'CONFLICT'
  | 'NOT_FOUND'
  | 'AUTHORIZATION_REQUIRED'
  | 'POLICY_BLOCKED'
  | 'EXTERNAL_AMBIGUITY'
  | 'TERMINAL_STATE'
  | 'MIGRATION_INCOMPATIBLE'
  | 'INTERNAL';

/** Readonly bag of structured error context. Values must stay JSON-ish. */
export interface PaySwapErrorDetails {
  readonly [key: string]: unknown;
}

/**
 * Initialization bag for `PaySwapError`. `details` accepts `undefined`
 * explicitly so subclass constructors may forward optional details without
 * violating `exactOptionalPropertyTypes`; the constructed error still omits
 * the property entirely when no details were supplied.
 */
export interface PaySwapErrorInit {
  /** Stable machine-readable error code, e.g. `FLOAT_MONEY_REJECTED`. */
  readonly code: string;
  readonly category: ErrorCategory;
  readonly message: string;
  readonly details?: PaySwapErrorDetails | undefined;
}

/** Base class of every protocol error. */
export class PaySwapError extends Error {
  readonly code: string;
  readonly category: ErrorCategory;
  /**
   * Absent entirely when no details were supplied (never a defined
   * `undefined`) — `declare` keeps this a type-only declaration so class
   * field semantics cannot pre-define the property.
   */
  declare readonly details?: PaySwapErrorDetails;

  constructor(init: PaySwapErrorInit) {
    super(init.message);
    this.name = new.target.name;
    this.code = init.code;
    this.category = init.category;
    if (init.details !== undefined) {
      this.details = init.details;
    }
    // Keeps `instanceof` correct when downleveled; a no-op on native classes.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Generic input/argument validation failure (bad shape, bad range, bad format). */
export class ValidationError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({ code: 'VALIDATION_FAILED', category: 'VALIDATION', message, details });
  }
}

/**
 * External ambiguity — the protocol could not determine the authoritative
 * outcome of an external effect (INV-X01 / INV-X02 / INV-X03).
 *
 * This is NOT a failure outcome: `isFailureOutcome` returns `false` for it.
 * Every instance requires reconciliation before the affected flow may be
 * treated as resolved. Converting UNKNOWN into FAILED (or success) is
 * forbidden by the frozen architecture.
 */
export class ExternalAmbiguityError extends PaySwapError {
  /** INV-X01: ambiguity is resolved by reconciliation, never by coercion. */
  readonly requiresReconciliation: true = true;

  constructor(message: string, details?: PaySwapErrorDetails) {
    super({
      code: 'EXTERNAL_AMBIGUITY',
      category: 'EXTERNAL_AMBIGUITY',
      message,
      details,
    });
  }
}

/**
 * Outcome classifier for the FAILED/UNKNOWN dichotomy (INV-X01).
 *
 * - `ExternalAmbiguityError` (UNKNOWN) → `false`: not a definitive failure.
 * - Any other `PaySwapError` → `true`: a definitive failure outcome.
 * - Anything else (foreign errors, raw throwables, null/undefined) → `true`:
 *   conservative default. Only an explicit `ExternalAmbiguityError` is
 *   treated as "outcome not yet determined".
 */
export function isFailureOutcome(error: unknown): boolean {
  if (error instanceof PaySwapError) {
    return !(error instanceof ExternalAmbiguityError);
  }
  return true;
}

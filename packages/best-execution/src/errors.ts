/**
 * @payswap/best-execution — error taxonomy (P4-W2-002).
 *
 * Validation failures reuse the canonical @payswap/protocol ValidationError
 * (fail closed, same discipline as the onchain domain kernel). The errors
 * below are the best-execution-specific operational failures: registry law
 * violations, illegal venue-pack behavior and — most importantly — illegal
 * quote→executed transitions (the no-fake-quote-to-success seam).
 */

/** Raised on venue-registry law violations (duplicate ids, etc.). */
export class VenueRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VenueRegistryError";
  }
}

/**
 * Raised on any illegal quote→executed transition attempt: an executed
 * CANDIDATE status is reachable ONLY through a validated execution
 * observation carrying a finality CANDIDATE (or an OUTCOME_UNKNOWN
 * observation requiring reconciliation) — never through a quote, a
 * broadcast report, or an assumed confirmation.
 */
export class ExecutionTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionTransitionError";
  }
}

/**
 * Raised when a stale route is pushed toward execution: a route whose quote
 * or health inputs have aged past their mandatory freshness bounds is
 * invalidated deterministically and must be re-selected from fresh
 * observations — it is never repaired or executed as-is.
 */
export class RouteInvalidatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouteInvalidatedError";
  }
}

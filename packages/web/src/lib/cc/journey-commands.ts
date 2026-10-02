/**
 * The allowlisted journey-mutation commands (P3-W3-002).
 *
 * Each entry equals the apiCommand the certified @payswap/ux contract emits
 * for that (journeyId, actionId) — the /api/journeys/dispatch route refuses
 * anything not on this list, and the test suite asserts the equality by
 * constructing the journeys and comparing, so contract drift fails the
 * suite instead of the route.
 */

/** One allowlisted journey mutation (mirrors the contract's action commands). */
export interface AllowedJourneyCommand {
  readonly journeyId: string;
  readonly actionId: string;
  readonly method: "POST";
  readonly path: string;
  /** The commandType the contract's body carries (absent for /v1/approvals). */
  readonly commandType?: string;
}

export const ALLOWED_JOURNEY_COMMANDS: readonly AllowedJourneyCommand[] = Object.freeze([
  { journeyId: "pay", actionId: "submit-payment", method: "POST", path: "/v1/intents", commandType: "payments.intent.create" },
  { journeyId: "collect", actionId: "create-collect-request", method: "POST", path: "/v1/intents", commandType: "payments.collect.request" },
  { journeyId: "payout", actionId: "submit-payout", method: "POST", path: "/v1/intents", commandType: "payouts.payout.create" },
  { journeyId: "reconcile-payment-outcome", actionId: "request-fresh-observation", method: "POST", path: "/v1/intents", commandType: "payments.reconciliation.observe" },
  { journeyId: "reauthorize", actionId: "begin-reauthorization-request", method: "POST", path: "/v1/approvals" },
  { journeyId: "reauthorize", actionId: "resume-execution", method: "POST", path: "/v1/intents" },
] as const);

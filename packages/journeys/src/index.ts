/**
 * @payswap/journeys — End-to-end economic journey certification (W1-007).
 *
 * The terminal certification suite: composes every merged subsystem into
 * complete, evidenced, reconciled economic journeys. Each journey runs
 * against the REAL subsystems (protocol authority, append-only ledger, real
 * attempts — never stubs of financial truth), asserts every W1-007
 * acceptance axis, and feeds the overall JourneyCertificationReport.
 *
 * Deterministic only; NO network — rail adapters are exercised through their
 * fail-closed / deterministic injected-transport surfaces.
 */

export const PACKAGE_NAME = "@payswap/journeys" as const;

export * from "./harness.js";
export * from "./certification.js";
export * from "./journeys/p2p.js";
export * from "./journeys/merchant-checkout.js";
export * from "./journeys/cross-border.js";
export * from "./journeys/payroll-batch.js";
export * from "./journeys/credit.js";
export * from "./journeys/incentive-liquidity.js";
export * from "./journeys/psp-incumbent.js";
export * from "./journeys/customer-action.js";
export * from "./journeys/recurring-mandate.js";
export * from "./journeys/refund-dispute.js";
export * from "./journeys/multi-provider-fallback.js";
export * from "./journeys/external-funds.js";

/**
 * @payswap/best-execution — the venue-agnostic best-execution core
 * (Work Order P4-W2-002).
 *
 * What this package owns:
 * - the neutral ExecutionVenue port: execution venues register as opaque
 *   capability packs behind it (the core has ZERO venue-specific
 *   vocabulary — adversarially scanned in test/adversarial.test.ts);
 * - the quote observation law (mandatory freshness, provenance, observer —
 *   the onchain-domain observation law applied to quotes);
 * - the typed net-executable-outcome dimensions (output, fees, gas,
 *   bridge/FX cost, slippage, liquidity impact, failure/retry risk,
 *   time/finality, health, policy, security — every dimension an explicit
 *   typed input; no hidden constants);
 * - the exact-rational comparator with full arithmetic traces;
 * - route provenance chains (which venues quoted, at what freshness,
 *   through which observation — recorded for every decision);
 * - the deterministic engine driving every candidate through the
 *   onchain-security prepare/simulate/diff/gate stages (a security BLOCK
 *   kills a route; no venue path bypasses the gate);
 * - stale-route invalidation (mandatory freshness; deterministic
 *   invalidation; re-validation by re-running on fresh observations);
 * - the quote→executed transition record (executed ONLY via a real
 *   execution observation with a finality CANDIDATE or UNKNOWN — never
 *   assumed final, never from a quote alone).
 *
 * Provider-native optimization parity (INV-C08 / rule 20): the comparator
 * is structurally indifferent to optimizationOrigin — a venue's own
 * router-native routing is always representable and never structurally
 * disadvantaged against composed routing.
 *
 * Boundary law: this package's src/** imports ONLY @payswap workspace
 * packages (onchain-domain, onchain-security, protocol, trust) — never a
 * venue pack, never a vendor SDK, never a live endpoint. All evaluation is
 * deterministic: callers pass every instant; there is no ambient clock and
 * no randomness anywhere.
 */

export const PACKAGE_NAME = "@payswap/best-execution" as const;

// Exact rational arithmetic (no floating point ever).
export * from "./exact-math.js";
// The quote observation law (freshness, provenance, observer).
export * from "./quote-observation.js";
// The typed net-executable-outcome dimension disclosures.
export * from "./outcome-dimensions.js";
// The neutral venue port (venue-agnostic by construction).
export * from "./venue-port.js";
// The versioned best-execution policy (every constant an explicit input).
export * from "./policy.js";
// The net executable outcome comparator + deterministic ranking.
export * from "./comparator.js";
// Route provenance chains.
export * from "./provenance.js";
// The engine + stale-route invalidation law.
export * from "./engine.js";
// The quote→executed transition record.
export * from "./execution-record.js";
// The error taxonomy.
export * from "./errors.js";

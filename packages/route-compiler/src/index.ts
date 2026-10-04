/**
 * @payswap/route-compiler — the Mixed Fiat/Onchain Route Compiler (Work
 * Order P4-W4-001).
 *
 * Compiles ONE canonical Money Movement Intent into multi-leg route plans
 * spanning fiat and onchain rails (crypto→DEX→stablecoin→off-ramp→bank,
 * fiat→PSP→stablecoin→chain→recipient, chainA→DEX→bridge→chainB, and
 * eligible-crypto→native-Stripe-crypto-settlement), proving the four
 * representative journeys through the REAL merged kernels:
 *
 * - mixed-rail lane discovery / execution walk / evidence (which itself
 *   drives the best-execution venue port and the canonical onchain-domain
 *   settlement mapping);
 * - the onchain-security write pipeline (prepare → deterministic gate →
 *   expected-state diff) for transfer and bridge legs;
 * - the connectors capability-observation law + the real payout gate for
 *   fiat and off-ramp legs;
 * - the payment settlement-destination vocabulary for bank arrival legs;
 * - the onchain-opportunities discovery-tier eligibility (resolved +
 *   policy-evaluated as routing context, STRUCTURALLY never authorization);
 * - Stripe Mode A contracts per the provider-verified-effects law, honestly
 *   awaiting the P4-W1-003 research authority for the actual integration.
 *
 * Laws (enforced structurally, adversarially tested):
 * - every leg carries authorization lineage, fresh state grounding,
 *   finality CANDIDATES (never assumed) and non-empty evidence;
 * - custody is explicit and CONTIGUOUS at every hop — no hidden custody;
 * - legs REFERENCE the intent (single source of truth) — no duplicate
 *   ledger; settlement mapping refs flow at the boundaries;
 * - failure at ANY leg preserves UNKNOWN/reconciliation semantics (INV-X01/
 *   X02/X03); blind retry is structurally forbidden;
 * - provider-native paths remain candidate baselines (INV-C08) — the
 *   compiler never ranks them away;
 * - compilation and walks are deterministic pure functions of their inputs
 *   (caller-supplied instants, canonical input ordering, no ambient clock,
 *   no randomness);
 * - the Lab runtime is driven from the TEST layer only (INV-L01): no
 *   production file of this package imports the Lab runtime package.
 */

export const PACKAGE_NAME = "@payswap/route-compiler" as const;

// the canonical Money Movement Intent (the single source of truth)
export * from "./intent.js";
// the shared route-leg contracts (authority/state/finality/evidence/custody/failure)
export * from "./leg-contracts.js";
// the fiat legs (capability-observation law, payout gate, settlement destinations)
export * from "./fiat-legs.js";
// the onchain legs (lane discovery + kernel write pipeline)
export * from "./onchain-legs.js";
// the Stripe crypto-settlement leg contracts (provider-verified-effects law)
export * from "./stripe-legs.js";
// the compiled route plan + plan construction laws
export * from "./route-plan.js";
// the deterministic compiler
export * from "./compiler.js";
// the fault-injectable execution walk (UNKNOWN/reconciliation semantics)
export * from "./walk.js";
// journey evidence records + digests
export * from "./evidence.js";

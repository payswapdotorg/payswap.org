/**
 * @payswap/lab — Reality Engineering Lab (Work Order W2-004, Stage 3).
 *
 * Domain Packs, scenarios, deterministic simulation namespace, replay and
 * counterfactual, evaluator (hard constraints before optimization), search
 * plug-ins (ConnectedCapabilityInstance + CapabilityObservation grounded),
 * candidate registry, shadow/canary promotion and Director control
 * interfaces.
 *
 * Package-level invariants (see module headers for details):
 * - INV-L01: simulation is namespaced and isolated; no production package
 *   imports this package and simulation.ts imports nothing (boundary test);
 * - INV-L02: promotion requires replay + counterfactual + robustness
 *   evidence (PromotionEvidenceError otherwise);
 * - INV-L03: promotion is versioned and reversible (append-only ledger);
 * - INV-C01/C02/C05/C08: executable search is instance+observation grounded,
 *   two-axis UNKNOWN is preserved, provider-native incumbents compete
 *   without a composition prior;
 * - INV-G03: Lab composition is a proposal; it grants no authority.
 *
 * Architecture: 1.5-frozen-2026-09-30; FROZEN-ARCHITECTURE §19; LAB.md.
 */

export const PACKAGE_NAME = "@payswap/lab" as const;

export * from "./simulation.js";
export * from "./evaluator.js";
export * from "./domain-packs.js";
export * from "./scenarios.js";
export * from "./replay.js";
export * from "./search.js";
export * from "./candidates.js";
export * from "./promotion.js";
export * from "./director.js";

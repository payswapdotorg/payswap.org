/**
 * @payswap/capabilities — Capability, AcceptanceCapability, capability state
 * vs source availability, and extension manifest contracts.
 * Work Orders: W2-001 (Stage 0 contract freeze) + W2-003 (Stage 2:
 * CapabilityGraphStore with acceptance/service-access queries,
 * ServiceAccessCapability with funding/service credential separation,
 * smart-contract extension representation and the append-only certification
 * ledger) + P2-W1-003 (Coverage Gap Case workflow: gap representation and
 * cause classification, narrowest-integration selection, direct local
 * connector onboarding paths with the browser-session boundary and the
 * debit-scope-not-inferable law, the no-global-coverage-bypass law and
 * explicit sanctioned-market policy).
 */

export const PACKAGE_NAME = "@payswap/capabilities" as const;

export * from "./capability.js";
export * from "./availability.js";
export * from "./extension.js";
export * from "./resolution.js";
export * from "./graph.js";
export * from "./smart-contract.js";
export * from "./certification.js";
export * from "./coverage-gap.js";


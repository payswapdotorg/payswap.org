/**
 * @payswap/agents — Agent Body, Agent Instance, Agent Package, Organization,
 * proposals, runtime contract and smart-account/session-key contracts.
 * Work Order: W2-001 (Stage 0 contract freeze)
 */

export const PACKAGE_NAME = "@payswap/agents" as const;

export * from "./amount.js";
export * from "./canonical.js";
export * from "./body.js";
export * from "./instance.js";
export * from "./package.js";
export * from "./package/lifecycle.js";
export * from "./organization.js";
export * from "./organization/execution.js";
export * from "./proposal.js";
export * from "./runtime.js";
export * from "./runtime/reference-runtime.js";
export * from "./smart-account.js";

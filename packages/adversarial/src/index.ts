/**
 * @payswap/adversarial — the adversarial, replay, fault and abuse suite
 * (Work Order W2-007).
 *
 * Deterministic fault injection against the REAL merged subsystems: every
 * fault family in spec/work-items/W2-007.md is injected, proven to have
 * genuinely occurred, probed for invariant breaches (none) and walked
 * through its exact recovery/reconciliation path. No network by design.
 */

export const PACKAGE_NAME = "@payswap/adversarial" as const;

export * from "./harness.js";
export * from "./reports.js";
export * from "./faults/duplicated-commands.js";
export * from "./faults/lost-webhooks.js";
export * from "./faults/ambiguous-provider.js";
export * from "./faults/account-takeover.js";
export * from "./faults/malicious-agents.js";
export * from "./faults/package-compromise.js";
export * from "./faults/incentive-abuse.js";
export * from "./faults/provider-outage.js";
export * from "./faults/clock-skew.js";
export * from "./faults/partial-payment.js";

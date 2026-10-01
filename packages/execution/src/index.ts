/**
 * @payswap/execution — the canonical execution graph (W3-003).
 *
 * ExecutionPlan with explicit execution modes (INV-C07); protocol-issued
 * scoped execution grants with adapter attenuation (INV-C04/INV-F06/INV-A03);
 * retry-safe idempotent ExecutionAttempts over the protocol kernel
 * (INV-F05/INV-O01/INV-X04) with provider evidence linked to every external
 * effect (INV-E02/INV-E05); reconciliation as the authority for ambiguous
 * external effects (INV-X01/INV-X02/INV-X03); and payment-method offers
 * derived from authoritative acceptance/capability state.
 *
 * This package consumes the canonical connector capability vocabulary owned
 * by @payswap/connectors (W2-003). It must not redefine capability
 * vocabulary or create parallel provider-state models.
 */

export const PACKAGE_NAME = "@payswap/execution" as const;

export * from "./plans.js";
export * from "./authorization.js";
export * from "./attempts.js";
export * from "./reconciliation.js";
export * from "./offers.js";

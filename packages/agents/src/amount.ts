/**
 * Exact monetary amount for agent-domain contracts (budgets, session keys).
 * Floating-point money is forbidden (INV-F01).
 *
 * W2-002 CONSOLIDATION: the local duplicate was removed; the canonical
 * AmountSpec wire format is owned by @payswap/trust (whose exact-amount
 * arithmetic is in turn backed by the @payswap/protocol money primitive).
 * The re-export preserves the Stage-0 @payswap/agents export surface.
 */
export type { AmountSpec } from "@payswap/trust";

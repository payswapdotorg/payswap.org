/**
 * Exact monetary amount for agent-domain contracts (budgets, session keys).
 * Floating-point money is forbidden (INV-F01).
 *
 * CONSOLIDATION CANDIDATE (W2-002): align with @payswap/protocol
 */
export interface AmountSpec {
  readonly currency: string;
  readonly minorUnits: string;
}

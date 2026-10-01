/**
 * @payswap/payment — Payment Operating Plane contracts (W1-003).
 *
 * Types + deterministic logic only: PaymentMethod (user/merchant-facing
 * instrument, DISTINCT from rail capabilities) and
 * PaymentCredentialCapability; PaymentAcceptancePolicy and
 * MerchantSettlementDestination (external — never PaySwap custody);
 * PaymentMethodTranslation with structural material-term reauthorization;
 * recurring mandate semantics and PaymentFallbackPolicy;
 * OffNetworkPaymentRecord (external movements that can NEVER be counted as
 * PaySwap-executed settlements); and remittance/document allocation
 * preserving payment → invoice/order/project links exactly.
 *
 * Depends only on @payswap/protocol (exact money, clock, state-machine
 * kernel). No rail execution, no fake balances, no floating-point money.
 */

export const PACKAGE_NAME = '@payswap/payment' as const;

export * from './method.js';
export * from './acceptance.js';
export * from './translation.js';
export * from './recurring.js';
export * from './off-network.js';
export * from './remittance.js';

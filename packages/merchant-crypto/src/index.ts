/**
 * @payswap/merchant-crypto — merchant crypto payment contracts (P4-W1-003).
 *
 * Contracts ON TOP of the canonical PaySwap payment primitives: crypto
 * acceptance policy and exact quotes extend packages/payment's acceptance and
 * translation model; intent/attempt/checkout map onto MoneyMovementIntent
 * semantics, PaymentMethodTranslation and the settlement plane's
 * SettlementInstruction/SettlementAttempt/ExternalOutcome vocabulary; the two
 * settlement route families (native Stripe crypto settlement vs PaySwap
 * external conversion/off-ramp) are structurally DISCRIMINATED and expressed
 * through the existing capability model (packages/capabilities,
 * packages/connectors). Stripe balance effects are provider-verified or
 * UNKNOWN — never synthesized.
 */

export const PACKAGE_NAME = '@payswap/merchant-crypto' as const;

export * from './assets.js';
export * from './quotes.js';
export * from './settlement.js';
export * from './capabilities.js';
export * from './acceptance.js';
export * from './intent.js';
export * from './attempt.js';
export * from './checkout.js';

/**
 * @payswap/merchant-checkout — the merchant crypto checkout flow
 * (Work Order P4-W2-003).
 *
 * The Stripe-class merchant flow on TOP of the landed primitives
 * (map-and-extend; zero duplication):
 *
 * - onboarding.ts:  typed merchant profile + the deterministic onboarding
 *                   machine (DRAFT → SUBMITTED → VERIFIED → ACTIVE),
 *                   fiat-denominated by default, structurally incapable of
 *                   implying rail connectivity;
 * - acceptance.ts:  crypto acceptance activation — a typed view over the
 *                   @payswap/merchant-crypto acceptance contract (composed,
 *                   never copied), with immutable history on deactivation;
 * - checkout.ts:    checkout-session construction over the merchant-crypto
 *                   CheckoutSession mapping, producing customer-facing
 *                   options with quotes as observations and amounts derived
 *                   by exact cross-multiplication;
 * - payment.ts:     customer wallet payment THROUGH the W1-002 kernel
 *                   (prepare → simulate → gates → diff → authorize →
 *                   recheck → broadcast handoff) — the customer sees the
 *                   payment summary and the typed diff; explicit signing
 *                   at the injected trusted surface (rule 10);
 * - lifecycle.ts:   PaymentAttempt lineage over the canonical machines —
 *                   authorization lineage structurally mandatory, UNKNOWN
 *                   preserved, reconciliation the only ambiguity exit,
 *                   blind-retry unrepresentable;
 * - webhooks.ts:    typed webhook contracts + idempotent-by-event-id
 *                   processing (a webhook is evidence, never authority);
 * - refunds.ts:     refunds only where the typed rail capability
 *                   observation supports them (honest NOT_SUPPORTED
 *                   otherwise), mirroring the payment lifecycle laws with
 *                   immutable originals;
 * - settlement.ts:  settlement configuration as typed data, the Stripe
 *                   connection as a ProviderStateEnvelope-style lifecycle,
 *                   and the two explicit Stripe paths with the §3.9 naming
 *                   reconciliation onto the LANDED route-family literals;
 * - api.ts:         the typed API-surface contracts for the merchant +
 *                   customer journeys (dispatch walking the REAL functions);
 * - evidence.ts:    journey evidence records (deterministic, regenerable).
 */

export const PACKAGE_NAME = "@payswap/merchant-checkout" as const;

export * from "./onboarding.js";
export * from "./acceptance.js";
export * from "./checkout.js";
export * from "./payment.js";
export * from "./lifecycle.js";
export * from "./webhooks.js";
export * from "./refunds.js";
export * from "./settlement.js";
export * from "./api.js";
export * from "./evidence.js";

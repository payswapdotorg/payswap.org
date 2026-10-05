/**
 * The Checkout outcome journey surface (P4-W4-002 §3.1 "Checkout"; the
 * merchant-checkout README's Stripe-path presentation).
 *
 * The merchant model is FIAT-FIRST: the merchant prices in fiat currency,
 * crypto acceptance is the EXPLICIT layer on top, and the customer sees a
 * human-readable payment summary with explicit signing. This surface
 * renders the journey's typed contract steps (from the REAL
 * @payswap/merchant-checkout api vocabulary) and the deployment's honest
 * capability state: with no merchant checkout context bound (no merchant
 * profile, no acceptance policy, no trusted deps), the surface states
 * exactly that — it never fabricates a checkout session, a quote or a
 * payment option, and the customer-signing summary never renders as if a
 * wallet were connected.
 */

import { outcomeActionById, type OutcomeDeploymentContext } from "@payswap/surface";

import { ModeIndicator } from "./mode-indicator";

/** The typed journey steps, named from the merchant-checkout api kinds. */
const CHECKOUT_STEPS: ReadonlyArray<{
  readonly kind: string;
  readonly title: string;
  readonly who: "merchant" | "customer";
  readonly what: string;
}> = Object.freeze([
  {
    kind: "merchant/onboarding.draft → submit → verify → activate",
    title: "Merchant onboarding",
    who: "merchant",
    what: "A typed merchant profile, fiat-denominated by default, walks DRAFT → SUBMITTED → VERIFIED → ACTIVE with a registered settlement destination.",
  },
  {
    kind: "merchant/acceptance.activate",
    title: "Crypto acceptance activation",
    who: "merchant",
    what: "The explicit crypto acceptance layer on top of fiat pricing — assets, quote validity, base policy (a typed view over the @payswap/merchant-crypto contract).",
  },
  {
    kind: "checkout/session.open",
    title: "Checkout session",
    who: "merchant",
    what: "The session with quote OBSERVATIONS (expiry-at-boundary semantics) and amounts derived by exact bigint cross-multiplication — a quote is an observation, never custody.",
  },
  {
    kind: "checkout/option.prepare → checkout/option.authorize",
    title: "Customer wallet payment",
    who: "customer",
    what: "The customer SEES the human-readable payment summary and the typed authorization diff, then signs EXPLICITLY at the trusted approval surface — authorization without signing is structurally unrepresentable.",
  },
  {
    kind: "payment/attempt.submit → observe → resolve",
    title: "Payment lifecycle",
    who: "customer",
    what: "UNKNOWN preserved through the canonical machines; reconciliation is the only ambiguity exit; every definitive outcome carries evidence.",
  },
  {
    kind: "settlement/route.select",
    title: "Settlement route",
    who: "merchant",
    what: "The two explicit paths: native Stripe crypto settlement (provider-verified only) vs external PaySwap conversion — never conflated, honestly distinct.",
  },
] as const);

export function CheckoutJourneySurface({
  deployment,
}: {
  readonly deployment: OutcomeDeploymentContext;
}) {
  const action = outcomeActionById("checkout");
  const capability = action.capability(deployment);
  return (
    <section aria-labelledby="cc-checkout-heading" className="cc-stack">
      <div>
        <h2 id="cc-checkout-heading" className="cc-section-heading">
          Checkout
        </h2>
        <p className="cc-section-intro">{action.outcomeLine}</p>
      </div>
      <ModeIndicator testOrLive="TEST" onchain testnet modeLocked />
      {capability.dispatchable ? (
        <p className="cc-checkout-ready" role="status">
          A merchant checkout context is bound — the session, quotes and customer
          signing flow render from the bound context.
        </p>
      ) : (
        <div className="cc-checkout-unavailable" role="status">
          <h3>No merchant checkout context is bound</h3>
          <p>{capability.missingPrerequisite}</p>
        </div>
      )}
      <div className="cc-checkout-steps">
        <h3>The journey, step by step (the typed contract)</h3>
        <ol className="cc-checkout-steplist">
          {CHECKOUT_STEPS.map((step) => (
            <li key={step.kind} data-who={step.who}>
              <p className="cc-checkout-step__title">
                {step.title} <span className="ps-badge" data-tone={step.who === "merchant" ? "neutral" : "test"}>{step.who}</span>
              </p>
              <p className="cc-checkout-step__what">{step.what}</p>
              <p className="cc-checkout-step__kind">
                <code>{step.kind}</code>
              </p>
            </li>
          ))}
        </ol>
        <p className="cc-checkout-note">
          Steps render from the certified @payswap/merchant-checkout api kinds —
          the same contracts programmatic clients walk. Fiat-first, crypto
          acceptance explicit, customer signing explicit.
        </p>
      </div>
    </section>
  );
}

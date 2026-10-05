import { openCheckoutFlow } from "../src/index.js";
import type { CheckoutFlow } from "../src/index.js";
import { fromMinorUnits, currencyCode } from "@payswap/protocol";
import type { Money } from "@payswap/protocol";
import {
  activeAcceptance,
  baseAcceptancePolicy,
  CART_AMOUNT,
  EXPIRY,
  fixtureQuote,
  LATER,
  USC_RAIL_BINDING,
} from "./fixtures.js";

/**
 * Small composition helpers shared across the per-stage test files (kept
 * separate from fixtures.ts so fixtures stay pure builders).
 */

export function openFlowFixture(overrides?: {
  readonly quotes?: ReturnType<typeof fixtureQuote>[];
  readonly amount?: Money;
}): CheckoutFlow {
  return openCheckoutFlow({
    id: "flow-1",
    merchantId: "merchant-1",
    activation: activeAcceptance(),
    basePolicy: baseAcceptancePolicy(),
    cart: { amount: overrides?.amount ?? CART_AMOUNT },
    quotes: overrides?.quotes ?? [fixtureQuote()],
    railBindings: [USC_RAIL_BINDING],
    now: LATER,
    expiresAt: EXPIRY,
  });
}

/** A smaller cart amount for partial-refund fixtures. */
export function partialRefundAmount(): Money {
  return fromMinorUnits(currencyCode("USD"), 4_950n);
}

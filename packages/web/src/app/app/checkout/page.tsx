import type { Metadata } from "next";

import { apiRuntimeState } from "@/lib/api";

import { UniversalSection } from "@/components/universal/universal-section";
import { CheckoutJourneySurface } from "@/components/universal/checkout-surface";

export const metadata: Metadata = { title: "Checkout" };

/**
 * The Checkout outcome route (P4-W4-002 §3.1): the merchant checkout
 * journey surface — fiat-first, the explicit crypto acceptance layer, the
 * customer explicit-signing summary. Deployment facts derived from the
 * ACTUAL runtime state: no merchant checkout context is bound in this
 * deployment, and the surface says exactly that.
 */
export default async function CheckoutPage() {
  return (
    <UniversalSection navItemId="payments">
      <CheckoutJourneySurface
        deployment={{
          apiRuntimeConfigured: apiRuntimeState().configured,
          merchantCheckoutContextBound: false,
          routeCompilationInputsAvailable: false,
        }}
      />
    </UniversalSection>
  );
}

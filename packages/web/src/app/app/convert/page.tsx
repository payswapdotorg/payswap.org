import type { Metadata } from "next";

import { apiRuntimeState } from "@/lib/api";

import { UniversalSection } from "@/components/universal/universal-section";
import { ConvertJourneySurface } from "@/components/universal/convert-surface";

export const metadata: Metadata = { title: "Convert" };

/**
 * The Convert outcome route (P4-W4-002 §3.1): the conversion journey
 * surface. The deployment facts are derived from the ACTUAL runtime state
 * (API runtime configured; no onchain lane/venue observations exist in
 * this deployment — stated, never papered over). No compilation result is
 * injected because none exists here; the surface renders the honest
 * not-dispatchable state with its typed prerequisite.
 */
export default async function ConvertPage() {
  return (
    <UniversalSection navItemId="payments">
      <ConvertJourneySurface
        deployment={{
          apiRuntimeConfigured: apiRuntimeState().configured,
          merchantCheckoutContextBound: false,
          routeCompilationInputsAvailable: false,
        }}
      />
    </UniversalSection>
  );
}

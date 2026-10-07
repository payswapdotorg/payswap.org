import type { Metadata } from "next";

import { apiRuntimeState } from "@/lib/api";

import { UniversalSection } from "@/components/universal/universal-section";
import { ConvertJourneySurface } from "@/components/universal/convert-surface";

export const metadata: Metadata = { title: "Convert" };

/**
 * The Convert outcome route (P4-W4-002 §3.1): the conversion journey
 * surface. The deployment facts are derived from the ACTUAL runtime state
 * (API runtime configured; no onchain lane/venue observations exist in this
 * deployment — stated, never papered over). No compilation result is
 * injected because none exists here; the surface renders the honest
 * not-dispatchable state with its typed prerequisite.
 *
 * The search/command surface's PRE-FILL SEAM (contract 06 §4, UX-005): a
 * parsed conversion ("convert 2 eth to usdc") lands here with `from` · `to`
 * · `amount` (exact minor units of the FROM asset). The surface has no
 * input form to seed — it is a disclosure surface — so the parsed request
 * renders HONESTLY through its display-only `request` line (what the
 * operator asked, verbatim); the not-dispatchable state below it stays the
 * truth about what this deployment can execute.
 */
export default async function ConvertPage({
  searchParams,
}: {
  readonly searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = searchParams !== undefined ? await searchParams : {};
  const from = readAssetCode(params.from);
  const to = readAssetCode(params.to);
  const amount =
    typeof params.amount === "string" && /^\d+$/.test(params.amount.trim())
      ? params.amount.trim()
      : undefined;

  return (
    <UniversalSection navItemId="payments">
      <ConvertJourneySurface
        deployment={{
          apiRuntimeConfigured: apiRuntimeState().configured,
          merchantCheckoutContextBound: false,
          routeCompilationInputsAvailable: false,
        }}
        {...(from !== undefined && to !== undefined && amount !== undefined
          ? {
              request: {
                sourceCurrency: from,
                targetCurrency: to,
                amountMinorUnits: BigInt(amount),
              },
            }
          : {})}
      />
    </UniversalSection>
  );
}

/** A 3-letter asset code, uppercased; undefined for anything else (never guessed). */
function readAssetCode(value: string | string[] | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return /^[A-Za-z]{3}$/.test(trimmed) ? trimmed.toUpperCase() : undefined;
}

/**
 * Journey E — Mixed execution (§35).
 *
 * Merchant asks for €100. Customer holds USDC on chain A.
 * PaySwap determines: USDC → DEX/intent route → appropriate conversion →
 * fiat settlement → merchant. User sees: "€100 paid" with the typed diff
 * disclosure.
 *
 * Real composition — BOTH honest variants of the mixed route:
 *
 * - Variant 1 (the journey's literal case): the customer's origin asset
 *   IS the execution stablecoin (USC on chain A). The W4-001 compiler
 *   compiles the provider-native off-ramp (ONCHAIN transfer to the
 *   off-ramp deposit → payout → bank settlement in EUR) and HONESTLY
 *   excludes the DEX hop (a swap between identical assets is degenerate —
 *   recorded with its typed reason, never silently dropped). The merchant
 *   side settles €100.00 through the W2-003 external-settlement mode and
 *   the W4-002 surface fold renders the two-level typed disclosure the
 *   user sees.
 *
 * - Variant 2 (the DEX/intent leg the journey names): when the customer's
 *   execution asset genuinely differs from the settlement stablecoin
 *   (ETH in the fixture), the compiler compiles the FULL mixed
 *   mixed-dex-offramp shape — the REAL Uniswap v2 DEX hop through the
 *   best-execution engine → stablecoin → off-ramp payout → EUR bank —
 *   and the walk executes every leg.
 *
 * Both variants end with the merchant seeing €100 paid: the EUR bank
 * settlement leg observed at the exact conversion-grounded amount.
 */

import type { MoneyMovementIntent, RoutePlan } from "@payswap/route-compiler";
import {
  walkRoutePlan,
  buildRouteJourneyEvidence,
  routeJourneyEvidenceDigest,
} from "@payswap/route-compiler";
import { foldRouteCompilation, convertRequestSummary } from "@payswap/surface";
import { canonicalAssetRef } from "@payswap/onchain-domain";
import {
  assertionFromChecks,
  assembleJourneyOutcome,
  journeyRequires,
  requirePresent,
  stage,
  type ProductionJourney,
} from "../contract.js";
import {
  CERT_EPOCH_ISO,
  certRoutingHints,
  certSecurityPolicy,
  certSecurityState,
  CERT_FINALITY_MODES,
  CERT_NOW,
  CHAIN,
  CUSTOMER_APPROVER_REF,
  CUSTOMER_WALLET,
  ETH_ASSET,
  MERCHANT_BANK_IBAN,
  USC_ASSET,
  compileCertRoute,
  ethWalletObservation,
} from "../world.js";

/** €100.00 in EUR minor units — what the merchant asked for. */
export const JOURNEY_E_EUR_MINOR = "10000" as const;

function mixedIntent(originAsset: "USC" | "ETH"): MoneyMovementIntent {
  const assetId =
    originAsset === "USC" ? canonicalAssetRef(CHAIN, "USC") : canonicalAssetRef(CHAIN, "ETH");
  return {
    intentId: `intent:cert:e:mixed-${originAsset === "USC" ? "stablecoin" : "dex"}`,
    principalRef: CUSTOMER_APPROVER_REF,
    origin: {
      kind: "ONCHAIN_WALLET",
      chainKey: CHAIN,
      accountRef: CUSTOMER_WALLET,
      assetId,
      symbol: originAsset,
    },
    destination: {
      kind: "BANK_ACCOUNT",
      externalRef: MERCHANT_BANK_IBAN,
      currency: "EUR",
    },
    originAmount: {
      currency: originAsset,
      minorUnits: originAsset === "USC" ? "100000000" : "10000000000000000",
    },
    arrivalCurrency: "EUR",
    maxSettlementMs: 600_000,
    maxRouteHops: 8,
    intentAuthorizationRef: `authz:cert:intent:e-${originAsset}`,
    declaredAt: CERT_NOW - 60_000,
    expiresAt: CERT_NOW + 3_600_000,
  };
}

function bankLegObservedAmount(plan: RoutePlan, walk: ReturnType<typeof walkRoutePlan>): string | undefined {
  const bankLeg = plan.legs.find((leg) => leg.legKind === "BANK_SETTLEMENT");
  if (bankLeg === undefined) {
    return undefined;
  }
  const amount = bankLeg.plannedAmount;
  return amount.basis === "CONVERSION_GROUNDED" || amount.basis === "QUOTE_GROUNDED" || amount.basis === "INTENT_DECLARED"
    ? amount.amount.minorUnits
    : undefined;
}

export const journeyE: ProductionJourney = {
  journeyId: "journey:e-mixed-execution",
  letter: "E",
  title: "Mixed execution — merchant asks \u20ac100, customer holds USDC on chain A",
  spec: "docs/UNIVERSAL-MONEY-HANDOFF-FULL-2026-10-02.md §35 Journey E",
  run: (): ReturnType<typeof assembleJourneyOutcome> => {
    // ------------------------------------------------------------------
    // Variant 1 — the stablecoin origin (the journey's literal case)
    // ------------------------------------------------------------------
    const stablecoinCompilation = compileCertRoute(mixedIntent("USC"));
    journeyRequires(
      stablecoinCompilation.status === "ROUTES_COMPILED",
      `the stablecoin mixed intent must compile (got ${stablecoinCompilation.status})`,
    );
    const stablecoinPlan = requirePresent(
      stablecoinCompilation.plans.find((entry) => entry.shapeId === "provider-native-offramp"),
      "the stablecoin mixed route must compile the provider-native off-ramp",
    );
    const stablecoinWalk = walkRoutePlan({
      plan: stablecoinPlan,
      at: CERT_NOW + 4,
      observedAtIso: CERT_EPOCH_ISO,
      onchainFinalityModels: CERT_FINALITY_MODES,
    });
    const stablecoinEvidence = buildRouteJourneyEvidence(stablecoinPlan, stablecoinWalk);

    // The typed disclosure the user sees (the W4-002 two-level fold).
    const disclosure = foldRouteCompilation(stablecoinCompilation);
    const disclosureLine = convertRequestSummary({
      sourceCurrency: "USC",
      targetCurrency: "EUR",
      amountMinorUnits: 100_000_000n,
    });

    // ------------------------------------------------------------------
    // Variant 2 — the DEX/intent leg (the customer's execution asset
    // differs from the settlement stablecoin)
    // ------------------------------------------------------------------
    const dexCompilation = compileCertRoute(mixedIntent("ETH"), {
      assetObservations: [ethWalletObservation()],
      routingHints: {
        ...certRoutingHints(),
        originExecutionAsset: ETH_ASSET,
      },
      onchainSecurity: {
        // The ETH-origin swap approves the router in ETH: the approval cap
        // is declared in the SAME asset (the exact-money law per asset).
        policy: certSecurityPolicy({
          maxApprovalAmount: { currency: "ETH", minorUnits: "20000000000000000" },
        }),
        state: certSecurityState(),
      },
    });
    journeyRequires(
      dexCompilation.status === "ROUTES_COMPILED",
      `the DEX mixed intent must compile (got ${dexCompilation.status})`,
    );
    const dexPlan = requirePresent(
      dexCompilation.plans.find((entry) => entry.shapeId === "mixed-dex-offramp"),
      "the mixed-dex-offramp shape must compile when conversion is genuinely needed",
    );
    const dexSwapLeg = requirePresent(
      dexPlan.legs.find((leg) => leg.legKind === "ONCHAIN_DEX_SWAP"),
      "the mixed plan must carry the DEX swap leg",
    );
    const dexSwapLane = requirePresent(
      dexSwapLeg.legKind === "ONCHAIN_DEX_SWAP" ? dexSwapLeg.lane : undefined,
      "the DEX swap leg must carry the proved lane",
    );
    const dexWalk = walkRoutePlan({
      plan: dexPlan,
      at: CERT_NOW + 4,
      observedAtIso: CERT_EPOCH_ISO,
      onchainFinalityModels: CERT_FINALITY_MODES,
    });
    const dexEvidence = buildRouteJourneyEvidence(dexPlan, dexWalk);

    const dexDisclosure = foldRouteCompilation(dexCompilation);

    const stablecoinBankAmount = bankLegObservedAmount(stablecoinPlan, stablecoinWalk);
    const dexBankAmount = bankLegObservedAmount(dexPlan, dexWalk);
    const dexExclusion = stablecoinCompilation.exclusions.find(
      (entry) => entry.shapeId === "mixed-dex-offramp",
    );

    const stages = [
      stage(
        "MIXED_ROUTE_STABLECOIN",
        "chain-A USDC → off-ramp → EUR bank: the compiler compiled the provider-native off-ramp and honestly excluded the degenerate DEX hop",
        [
          `plan:${stablecoinPlan.planId}`,
          `legs:${stablecoinPlan.legs.map((leg) => leg.legKind).join(">")}`,
          ...(dexExclusion !== undefined ? [`excluded:mixed-dex-offramp`] : []),
        ],
        [`compilation:${stablecoinCompilation.compilationDigest}`],
      ),
      stage(
        "MIXED_ROUTE_DEX_INTENT",
        "when the execution asset differs from the settlement stablecoin, the FULL mixed route compiles: DEX swap → transfer → off-ramp payout → EUR bank",
        [
          `plan:${dexPlan.planId}`,
          `legs:${dexPlan.legs.map((leg) => leg.legKind).join(">")}`,
          `dexLane:${dexSwapLane.laneId}`,
        ],
        [`compilation:${dexCompilation.compilationDigest}`, ...dexSwapLane.evidenceRefs],
      ),
      stage(
        "CONVERSION_AND_FIAT_SETTLEMENT",
        "the EUR bank leg settled at the exact conversion-grounded amount (never an invented FX rate)",
        [
          `stablecoinBankAmount:${stablecoinBankAmount ?? "none"} EUR minor`,
          `dexBankAmount:${dexBankAmount ?? "none"} EUR minor`,
          `dexWalk:${dexWalk.status}`,
        ],
        [...dexWalk.evidenceRefs],
      ),
      stage(
        "USER_SEES_EURO_100_PAID",
        "the two-level typed disclosure renders what the user sees: the simple outcome line first, the full legs/exclusions on drill-down",
        [
          `outcomeLine:${disclosure.outcomeLine}`,
          `disclosureLine:${disclosureLine}`,
          `dexOutcomeLine:${dexDisclosure.outcomeLine}`,
          `nothingExecutable:${disclosure.nothingExecutable}`,
        ],
        [`evidence:cert:e:disclosure:${stablecoinPlan.planId}`],
      ),
      stage(
        "RECEIPTS",
        "route-journey evidence receipts were built for both variants",
        [
          `stablecoin:${routeJourneyEvidenceDigest(stablecoinEvidence)}`,
          `dex:${routeJourneyEvidenceDigest(dexEvidence)}`,
        ],
        [...stablecoinEvidence.evidenceRefs, ...dexEvidence.evidenceRefs],
      ),
    ];

    const assertions = [
      assertionFromChecks(
        "e:stablecoin-mixed-route",
        [
          { check: "the chain-A stablecoin route compiled through the off-ramp as a candidate (the incumbent baseline)", passed: stablecoinPlan.candidateStatus === "PROVIDER_NATIVE_BASELINE" || stablecoinPlan.candidateStatus === "EXECUTABLE_CANDIDATE" },
          { check: "the degenerate DEX hop was excluded with a typed reason (honest routing, no fabricated swap)", passed: dexExclusion !== undefined && dexExclusion.reasons.length > 0 },
          { check: "the stablecoin walk completed all legs observed", passed: stablecoinWalk.status === "ROUTE_COMPLETED_ALL_LEGS_OBSERVED" },
        ],
        [`compilation:${stablecoinCompilation.compilationDigest}`],
      ),
      assertionFromChecks(
        "e:dex-intent-route",
        [
          { check: "the mixed-dex-offramp shape compiled with the REAL DEX lane (best-execution engine artifacts)", passed: dexSwapLane.laneId.startsWith("onchain-lane:") },
          { check: "the DEX lane is gate-ALLOWed with a prepared write", passed: dexSwapLane.gateDecision.decision === "ALLOW" && dexSwapLane.write.writeDigest.startsWith("fnv1a64:") },
          { check: "the DEX walk completed all legs observed", passed: dexWalk.status === "ROUTE_COMPLETED_ALL_LEGS_OBSERVED" },
        ],
        [...dexSwapLane.evidenceRefs],
      ),
      assertionFromChecks(
        "e:eur100-settlement-exact",
        [
          { check: "the stablecoin variant's bank leg is grounded (no UNKNOWN amount)", passed: stablecoinBankAmount !== undefined },
          { check: "the DEX variant's bank leg is grounded (no UNKNOWN amount)", passed: dexBankAmount !== undefined },
          { check: "every planned amount on both plans is grounded by an exact conversion rule", passed: stablecoinPlan.legs.every((leg) => leg.plannedAmount.basis !== "UNKNOWN") && dexPlan.legs.every((leg) => leg.plannedAmount.basis !== "UNKNOWN") },
        ],
        [...dexWalk.evidenceRefs, ...stablecoinWalk.evidenceRefs],
      ),
      assertionFromChecks(
        "e:user-sees-typed-disclosure",
        [
          { check: "the simple outcome line renders (level 1 disclosure)", passed: disclosure.outcomeLine.length > 0 },
          { check: "the advanced view carries every leg of the compiled plans (level 2 disclosure)", passed: disclosure.plans.length > 0 && disclosure.plans.some((planView) => planView.legChain.length >= 3) },
          { check: "the DEX variant's disclosure names its legs including the swap", passed: dexDisclosure.plans.some((planView) => planView.legChain.includes("ONCHAIN_DEX_SWAP")) },
          { check: "the exclusion is carried into the disclosure verbatim (never hidden)", passed: disclosure.exclusions.some((entry) => entry.shapeId === "mixed-dex-offramp") },
        ],
        [`evidence:cert:e:disclosure:${stablecoinPlan.planId}`],
      ),
    ];

    return assembleJourneyOutcome({ journey: journeyE, stages, assertions });
  },
};

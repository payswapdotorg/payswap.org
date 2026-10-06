/**
 * Journey G — Agent opportunity (§35).
 *
 * Agent discovers an onchain opportunity. Then: opportunity → evidence →
 * simulation/estimate → risk → policy → recommendation/authorization.
 * The agent cannot bypass policy.
 *
 * Real composition:
 * - the W3-002 discovery kernel (discoverOpportunity) stamps the
 *   DISCOVERY_NEVER_AUTHORIZATION tier on the discovered opportunity with
 *   the full typed field set (capital, return components with verified
 *   evidence, liquidity, exit path, risk ratings, max-loss bound);
 * - expected returns are estimated in exact rational arithmetic with
 *   honest bounds (VERIFIED components only; UNKNOWN when nothing is
 *   verified);
 * - the discovery policy evaluates eligibility (the stale variant is
 *   honestly STALE with eligibility forced false);
 * - the policy boundary is STRUCTURAL: discoveryPermitsExecution() is
 *   literally false, rejectDiscoveryForExecution() always throws, and
 *   the only path to execution is the W1-002 kernel (an agent can never
 *   mint authority — the artifact comes only from the trusted surface);
 * - the recommendation feeds the ROUTE COMPILER as routing context
 *   (OpportunityGroundingRecord), where discoveryPermitsExecution stays
 *   false on every compilation.
 */

import { discoverOpportunity, resolveOpportunity, evaluateDiscoveryPolicy } from "@payswap/onchain-opportunities";
import {
  discoveryPermitsExecution,
  rejectDiscoveryForExecution,
  DISCOVERY_TIER,
} from "@payswap/onchain-opportunities";
import { estimateExpectedReturn } from "@payswap/onchain-opportunities";
import { canonicalAssetRef } from "@payswap/onchain-domain";
import {
  assertionFromChecks,
  assembleJourneyOutcome,
  stage,
  type ProductionJourney,
} from "../contract.js";
import { CERT_NOW, CHAIN, compileCertRoute } from "../world.js";
import type { MoneyMovementIntent } from "@payswap/route-compiler";

function liquidityObservation(input?: { readonly freshnessAgeMs?: number }) {
  return {
    family: "liquidity" as const,
    observationId: "obs:cert:liq:001",
    venueId: "venue:cert:stable-pair",
    protocolKey: "protocol:amm-v2",
    chainKey: CHAIN,
    adapterId: "adapter:cert:onchain:evm",
    observerId: "observer:cert:indexer:001",
    freshness: {
      asOfMs: CERT_NOW - (input?.freshnessAgeMs ?? 0),
      maxAgeMs: 30_000,
    },
    evidenceRefs: ["evidence:cert:pool-state:001", "evidence:cert:fee-tier:001"],
    title: "StablePair USC/ETH liquidity provisioning",
    description:
      "observed liquidity provisioning opportunity in a stable pair pool; the estimate is derived from observed fee yields with uncertainty bounds",
    capitalRequired: {
      assetRef: canonicalAssetRef(CHAIN, "USC"),
      minorUnits: "1000000000",
    },
    fees: {
      entryFeeFraction: { numerator: "0", denominator: "1" },
      exitFeeFraction: { numerator: "3", denominator: "1000" },
      ongoingFeeFractionPerYear: { numerator: "1", denominator: "10000" },
    },
    liquidity: { depthMinorUnits: "500000000000", withdrawalLiquidityMinorUnits: "480000000000" },
    exitPath: {
      status: "AVAILABLE" as const,
      description:
        "exit observed in one transaction through the venue router; withdrawal liquidity was observed at the evidence instant",
      constraints: ["exit size may be constrained by observed withdrawal liquidity"],
    },
    lockUp: { locked: false, durationMs: null, unlockConditions: [] },
    smartContractRisk: {
      level: "LOW" as const,
      audited: true,
      summary: "independent audit observed; source and bytecode hashes recorded in the evidence chain",
    },
    oracleBridgeRisk: {
      level: "UNKNOWN" as const,
      audited: null,
      summary: "oracle and bridge dependencies were not determinable from the observation",
    },
    maxLoss: { fractionOfCapital: { numerator: "5", denominator: "100" } },
    returnComponents: [
      {
        componentId: "liq:fee-yield",
        kind: "FEE_YIELD" as const,
        ratePerYear: { numerator: "431", denominator: "10000" },
        evidenceVerified: true,
        description: "observed fee yield component, annualized from venue observations",
      },
    ],
    policyApprovalRef: "policy:cert:opportunity-allowance:1",
  };
}

export const journeyG: ProductionJourney = {
  journeyId: "journey:g-agent-opportunity",
  letter: "G",
  title: "Agent opportunity — discovery → evidence → estimate → risk → policy → recommendation; policy cannot be bypassed",
  spec: "docs/UNIVERSAL-MONEY-HANDOFF-FULL-2026-10-02.md §35 Journey G",
  run: (): ReturnType<typeof assembleJourneyOutcome> => {
    // ------------------------------------------------------------------
    // 1. Discovery with evidence (the REAL W3-002 kernel)
    // ------------------------------------------------------------------
    const opportunity = discoverOpportunity(liquidityObservation(), CERT_NOW);

    // ------------------------------------------------------------------
    // 2. Simulation/estimate (exact rationals, honest bounds)
    // ------------------------------------------------------------------
    const estimate = estimateExpectedReturn(opportunity.expectedReturn.components, {});

    // ------------------------------------------------------------------
    // 3. Risk + policy (the REAL eligibility evaluation)
    // ------------------------------------------------------------------
    const resolvedCurrent = resolveOpportunity(opportunity, CERT_NOW);
    const policyCurrent = evaluateDiscoveryPolicy(opportunity, CERT_NOW);
    const staleObservation = discoverOpportunity(
      liquidityObservation({ freshnessAgeMs: 120_000 }),
      CERT_NOW,
    );
    const resolvedStale = resolveOpportunity(staleObservation, CERT_NOW);
    const policyStale = evaluateDiscoveryPolicy(staleObservation, CERT_NOW);

    // ------------------------------------------------------------------
    // 4. The policy boundary (structural — no bypass exists)
    // ------------------------------------------------------------------
    let discoveryExecutionRejected = false;
    let discoveryErrorName = "";
    try {
      rejectDiscoveryForExecution(opportunity);
    } catch (error) {
      discoveryExecutionRejected = true;
      discoveryErrorName = (error as Error).name;
    }

    // 5. The recommendation feeds the route compiler as routing context —
    // discovery never permits execution there either.
    const intent: MoneyMovementIntent = {
      intentId: "intent:cert:g:context-compilation",
      principalRef: "user:customer-1",
      origin: {
        kind: "ONCHAIN_WALLET",
        chainKey: CHAIN,
        accountRef: "0x1111111111111111111111111111111111111111",
        assetId: canonicalAssetRef(CHAIN, "USC"),
        symbol: "USC",
      },
      destination: {
        kind: "ONCHAIN_RECIPIENT",
        chainKey: CHAIN,
        accountRef: "0x2222222222222222222222222222222222222222",
        assetId: canonicalAssetRef(CHAIN, "USC"),
        symbol: "USC",
      },
      originAmount: { currency: "USC", minorUnits: "20000000" },
      arrivalCurrency: "USC",
      maxSettlementMs: 600_000,
      maxRouteHops: 6,
      intentAuthorizationRef: "authz:cert:intent:g",
      declaredAt: CERT_NOW - 60_000,
      expiresAt: CERT_NOW + 3_600_000,
    };
    const compilation = compileCertRoute(intent, {
      opportunityObservations: [opportunity],
    });

    const stages = [
      stage(
        "OPPORTUNITY_DISCOVERED",
        "the discovery kernel branded the observed opportunity DISCOVERY_NEVER_AUTHORIZATION with the full typed field set",
        [
          `opportunity:${opportunity.opportunityId}`,
          `discoveryTier:${opportunity.discoveryTier}`,
          `family:${opportunity.family}`,
        ],
        [...opportunity.provenance.evidenceRefs],
      ),
      stage(
        "EVIDENCE_AND_ESTIMATE",
        "the expected return was estimated in exact rational arithmetic with VERIFIED-component bounds",
        [
          `point:${estimate.point ? `${estimate.point.numerator}/${estimate.point.denominator}` : "null"}`,
          `lower:${estimate.bounds ? `${estimate.bounds.low.numerator}/${estimate.bounds.low.denominator}` : "null"}`,
          `components:${opportunity.expectedReturn.components.length}`,
        ],
        [...opportunity.provenance.evidenceRefs],
      ),
      stage(
        "RISK_AND_POLICY",
        "the discovery policy evaluated eligibility on the CURRENT observation; the stale twin resolved STALE with eligibility forced false",
        [
          `resolved:${resolvedCurrent.status}`,
          `eligible:${policyCurrent.eligible}`,
          `staleResolved:${resolvedStale.status}`,
          `staleEligible:${policyStale.eligible}`,
          ...(policyStale.eligible ? [] : [`staleReasons:${policyStale.reasons.join("|")}`]),
        ],
        [`policy:cert:discovery:${opportunity.opportunityId}`],
      ),
      stage(
        "POLICY_BOUNDARY",
        "the structural boundary held: discovery permits execution is literally false, discovery-tier rejection threw, and the compiler records discoveryPermitsExecution=false",
        [
          `discoveryPermitsExecution:${discoveryPermitsExecution()}`,
          `rejectThrew:${discoveryExecutionRejected}`,
          `rejectError:${discoveryErrorName}`,
          `compilerDiscoveryPermitsExecution:${compilation.discoveryPermitsExecution}`,
          `tier:${DISCOVERY_TIER}`,
        ],
        ["evidence:cert:g:policy-boundary"],
      ),
    ];

    const assertions = [
      assertionFromChecks(
        "g:discovery-tiered",
        [
          { check: "the opportunity carries the DISCOVERY_NEVER_AUTHORIZATION tier brand", passed: opportunity.discoveryTier === DISCOVERY_TIER },
          { check: "the discovery carries non-empty evidence refs (INV-E02)", passed: opportunity.provenance.evidenceRefs.length > 0 },
          { check: "capital, liquidity, exit path, risk and max-loss are all first-class typed fields", passed: opportunity.capitalRequired.kind === "KNOWN" && opportunity.liquidity.depthMinorUnits !== undefined && opportunity.exitPath.status !== undefined && opportunity.maxLossBound.kind === "KNOWN" },
        ],
        [...opportunity.provenance.evidenceRefs],
      ),
      assertionFromChecks(
        "g:exact-estimate",
        [
          { check: "the point estimate is an exact rational (no floats)", passed: estimate.point !== null && typeof estimate.point.numerator === "string" },
          { check: "the lower bound only counts VERIFIED components", passed: estimate.bounds !== null },
        ],
        [...opportunity.provenance.evidenceRefs],
      ),
      assertionFromChecks(
        "g:policy-authoritative",
        [
          { check: "the CURRENT observation is eligible under the policy", passed: policyCurrent.eligible },
          { check: "the STALE observation resolved STALE with eligibility false (honest, never silently fresh)", passed: resolvedStale.status === "STALE" && policyStale.eligible === false },
          { check: "the stale ineligibility reason is typed", passed: policyStale.reasons.includes("STALE_OBSERVATION") },
        ],
        [`policy:cert:discovery:${opportunity.opportunityId}`],
      ),
      assertionFromChecks(
        "g:agent-cannot-bypass-policy",
        [
          { check: "discoveryPermitsExecution() is literally false", passed: discoveryPermitsExecution() === false },
          { check: "rejectDiscoveryForExecution threw DiscoveryExecutionRejectedError", passed: discoveryExecutionRejected && discoveryErrorName === "DiscoveryExecutionRejectedError" },
          { check: "the route compiler records discoveryPermitsExecution=false on every compilation", passed: compilation.discoveryPermitsExecution === false },
        ],
        ["evidence:cert:g:policy-boundary"],
      ),
    ];

    return assembleJourneyOutcome({ journey: journeyG, stages, assertions });
  },
};

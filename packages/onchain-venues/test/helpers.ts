import type { SmartContractExtension } from "@payswap/capabilities";
import { registerCurrency } from "@payswap/protocol";
import type { OnchainSecurityPolicy, OnchainSecurityState } from "@payswap/onchain-security";
import type { BestExecutionPolicy, HealthObservation } from "@payswap/best-execution";
import type { QuoteFreshness, QuoteObserver, QuoteProvenance } from "@payswap/best-execution";
import type { UniswapPoolState } from "../src/uniswap/index.js";
import { AGGREGATOR_SETTLEMENT_ADDRESS } from "../src/aggregator/index.js";
import { INTENTS_SETTLEMENT_ADDRESS } from "../src/intents/index.js";
import { UNISWAP_V2_ROUTER_02_ADDRESS } from "../src/uniswap/index.js";

/**
 * Shared deterministic fixtures for the venue-pack tests. All venue state
 * is SYNTHETIC (fixture observations — no credentials, no live endpoints,
 * no real chain claims beyond the published v2 contract addresses the
 * reference pack declares). Currency registrations follow the protocol
 * money law (the security kernel's approval-cap comparison bridges onto
 * the protocol money primitive).
 */

registerCurrency("USC", 6);
// ETH is registered under the protocol money law's digit bound (0-8);
// the 18-digit wei scale of the fixture pool math stays in fixture strings
// (AmountSpec minor units are opaque exact integers to the venue packs).
registerCurrency("ETH", 8);
registerCurrency("DAI", 6);

export const CHAIN = "ethereum:mainnet";
export const USC_ASSET = {
  chain: CHAIN,
  assetId: "0xaaaa111111111111111111111111111111111111",
  symbol: "USC",
} as const;
export const ETH_ASSET = {
  chain: CHAIN,
  assetId: "0xbbbb222222222222222222222222222222222222",
  symbol: "ETH",
} as const;
export const DAI_ASSET = {
  chain: CHAIN,
  assetId: "0xcccc333333333333333333333333333333333333",
  symbol: "DAI",
} as const;
export const OWNER = "0x1111111111111111111111111111111111111111";
export const BENEFICIARY = "0x2222222222222222222222222222222222222222";
export const NOW = 2_000_000;

export function poolFreshness(asOfMs: number = NOW): QuoteFreshness {
  return { asOfMs, maxAgeMs: 10_000 };
}

export function poolProvenance(pairId: string): QuoteProvenance {
  return {
    providerName: "venue-pack-fixture-indexer",
    source: "INDEXED_POOL_STATE",
    capturedAtMs: NOW,
    evidenceRefs: [`evidence:fixture-pool:${pairId}`],
  };
}

export function poolObserver(): QuoteObserver {
  return { observerId: "observer:fixture-indexer", observerKind: "INDEXER" };
}

export function rfqProvenance(orderId: string): QuoteProvenance {
  return {
    providerName: "venue-pack-fixture-maker",
    source: "RFQ",
    capturedAtMs: NOW,
    evidenceRefs: [`evidence:fixture-rfq:${orderId}`],
  };
}

export function healthyVenueHealth(at: number = NOW): HealthObservation {
  return {
    status: "HEALTHY",
    observedAtMs: at,
    maxAgeMs: 30_000,
    provenance: {
      providerName: "payswap-venue-operators",
      source: "OPERATOR",
      capturedAtMs: at,
      evidenceRefs: ["evidence:health:fixture"],
    },
  };
}

/** A deep USC/ETH pool (1 ETH ≈ 3000 USC in the fixture). */
export function deepUscEthPool(): UniswapPoolState {
  return {
    pairId: "pair:usc-eth",
    assetA: USC_ASSET,
    assetB: ETH_ASSET,
    reserveAMinorUnits: "1000000000000", // 1,000,000 USC
    reserveBMinorUnits: "333333333333333333", // ≈0.3333 ETH at 18 digits
    freshness: poolFreshness(),
    provenance: poolProvenance("usc-eth"),
    observer: poolObserver(),
  };
}

/** A deep ETH/DAI pool. */
export function deepEthDaiPool(): UniswapPoolState {
  return {
    pairId: "pair:eth-dai",
    assetA: ETH_ASSET,
    assetB: DAI_ASSET,
    reserveAMinorUnits: "333333333333333333",
    reserveBMinorUnits: "1000000000000",
    freshness: poolFreshness(),
    provenance: poolProvenance("eth-dai"),
    observer: poolObserver(),
  };
}

/** A THIN direct USC/DAI pool (the multi-hop route must beat it). */
export function thinUscDaiPool(): UniswapPoolState {
  return {
    pairId: "pair:usc-dai-thin",
    assetA: USC_ASSET,
    assetB: DAI_ASSET,
    reserveAMinorUnits: "5000000", // 5 USC
    reserveBMinorUnits: "5000000", // 5 DAI
    freshness: poolFreshness(),
    provenance: poolProvenance("usc-dai-thin"),
    observer: poolObserver(),
  };
}

/** The baseline security policy allowing all three venue contracts. */
export function baseSecurityPolicy(
  overrides?: Partial<OnchainSecurityPolicy>,
): OnchainSecurityPolicy {
  return {
    policyId: "security-policy-venues",
    version: 1,
    allowedChains: [CHAIN],
    allowedAssets: [USC_ASSET, ETH_ASSET, DAI_ASSET],
    allowedSpenders: [
      UNISWAP_V2_ROUTER_02_ADDRESS,
      AGGREGATOR_SETTLEMENT_ADDRESS,
      INTENTS_SETTLEMENT_ADDRESS,
    ],
    maxApprovalAmount: { currency: "USC", minorUnits: "5000000000" },
    forbidUnlimitedApprovals: true,
    unknownContractPolicy: "block",
    unknownRoutePolicy: "block",
    maxSecurityStateAgeMs: 60_000,
    ...overrides,
  };
}

export function baseSecurityState(
  overrides?: Partial<OnchainSecurityState>,
): OnchainSecurityState {
  return {
    observedAt: NOW,
    networkEpoch: 0n,
    quarantinedComponents: [],
    restrictedComponents: [],
    activeAdvisoryRefs: [],
    ...overrides,
  };
}

/**
 * The baseline best-execution policy for the venue-pack tests: numeraire
 * USC; USC 1:1; ETH at 3000 USC per ETH expressed per minor unit with
 * ETH's 18 minor digits (3/10^9); DAI at parity with USC (same 6-digit
 * scale in the fixture).
 */
export function baseBestExecutionPolicy(
  overrides?: Partial<BestExecutionPolicy>,
): BestExecutionPolicy {
  return {
    policyId: "best-exec-policy-venues",
    version: 1,
    numeraire: "USC",
    conversions: [
      { asset: USC_ASSET, rate: { numerator: "1", denominator: "1" } },
      { asset: ETH_ASSET, rate: { numerator: "3", denominator: "1000000000" } },
      { asset: DAI_ASSET, rate: { numerator: "1", denominator: "1" } },
    ],
    maxSettlementMs: 600_000,
    maxFailureRiskClass: "MODERATE",
    degradedVenuePolicy: "ADMIT",
    failureRiskDeductions: {
      LOW: "0",
      MODERATE: "100000",
      ELEVATED: "1000000",
      HIGH: "10000000",
    },
    timeCostPerMs: { numerator: "1", denominator: "1000" },
    tieBreakers: ["LOWER_RISK_CLASS", "FASTER_SETTLEMENT", "FEWER_HOPS", "VENUE_ID"],
    ...overrides,
  };
}

/** The canonical USC→USC exact-input swap request (1 USC). */
export function uscSwapRequest(outputAsset: import("@payswap/onchain-security").AssetIdentity = USC_ASSET) {
  return {
    requestId: "swap-request-venues-001",
    chain: CHAIN,
    inputAsset: USC_ASSET,
    outputAsset,
    swapKind: "EXACT_INPUT" as const,
    amount: { currency: "USC", minorUnits: "1000000" },
  };
}

/** The canonical USC→DAI exact-input swap request (1 USC). */
export function uscToDaiSwapRequest() {
  return {
    requestId: "swap-request-venues-002",
    chain: CHAIN,
    inputAsset: USC_ASSET,
    outputAsset: DAI_ASSET,
    swapKind: "EXACT_INPUT" as const,
    amount: { currency: "USC", minorUnits: "1000000" },
  };
}

/** A synthetic contract declaration for cross-pack assertions. */
export function syntheticDeclaration(
  address: string,
): SmartContractExtension {
  return {
    kind: "smart_contract_extension",
    chainRef: CHAIN,
    contractAddress: address,
    sourceHash: "sha256:synthetic",
    bytecodeHash: "sha256:synthetic",
    upgradeAuthority: { kind: "IMMUTABLE", description: "synthetic immutable" },
    adminAuthority: { kind: "IMMUTABLE", description: "synthetic immutable" },
    pausePowers: [],
    oracleDependencies: [],
    custody: {
      custodial: false,
      withdrawalAuthority: "synthetic",
      keyManagement: "synthetic",
    },
    searchableByLabAfterCertification: true,
  };
}

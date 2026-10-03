import { registerCurrency } from "@payswap/protocol";
import type { SmartContractExtension } from "@payswap/capabilities";
import type { ConnectedProtocolInstance } from "@payswap/onchain-domain";
import { protocolCapabilityId } from "@payswap/onchain-domain";
import type {
  OnchainSecurityPolicy,
  OnchainSecurityState,
  OnchainWriteRequest,
  PreparedWrite,
  SimulationObservation,
} from "@payswap/onchain-security";
import type { VenueQuote, VenueWritePlanningInput } from "../src/venue-port.js";
import type { ExecutionVenue } from "../src/venue-port.js";
import type {
  BestExecutionPolicy,
} from "../src/policy.js";
import type { HealthObservation } from "../src/outcome-dimensions.js";
import type { VenueQuoteOutcome } from "../src/venue-port.js";

/**
 * Shared deterministic fixtures for the best-execution core tests.
 * Everything here is SYNTHETIC (no real venue, no real chain claims, no
 * secrets). The synthetic venue builder implements the neutral
 * ExecutionVenue port with fully configurable quotes — proving the core is
 * venue-agnostic by exercising it with venues that carry NO real-world
 * identity.
 */

registerCurrency("USC", 6);
registerCurrency("ETH", 8);

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
export const OWNER = "0x1111111111111111111111111111111111111111";
export const BENEFICIARY = "0x2222222222222222222222222222222222222222";
export const SYNTHETIC_ROUTER = "0x3333333333333333333333333333333333333333";
export const NOW = 1_000_000;

export function syntheticContractExtension(
  overrides?: Partial<SmartContractExtension>,
): SmartContractExtension {
  return {
    kind: "smart_contract_extension",
    chainRef: CHAIN,
    contractAddress: SYNTHETIC_ROUTER,
    sourceHash: "sha256:synthetic-source",
    bytecodeHash: "sha256:synthetic-bytecode",
    upgradeAuthority: { kind: "MULTISIG", description: "synthetic governance multisig" },
    adminAuthority: { kind: "MULTISIG", description: "synthetic admin multisig" },
    pausePowers: [],
    oracleDependencies: [],
    custody: {
      custodial: false,
      withdrawalAuthority: "owner-only",
      keyManagement: "non-custodial",
    },
    searchableByLabAfterCertification: true,
    ...overrides,
  };
}

/** A connected protocol instance bound to a synthetic venue's protocol. */
export function connectedProtocolInstance(input: {
  protocolKey: string;
  instanceSuffix?: string;
  authorizationStatus?: "ACTIVE" | "PENDING" | "REVOKED" | "EXPIRED" | "UNKNOWN";
  eligible?: boolean;
}): ConnectedProtocolInstance {
  return {
    instanceId: `instance:${input.protocolKey}:${input.instanceSuffix ?? "001"}`,
    capabilityId: protocolCapabilityId(input.protocolKey, CHAIN),
    implementationId: `impl:${input.protocolKey}:synthetic`,
    providerName: "synthetic-venue-provider",
    providerVersion: "1.0.0",
    accountRef: "acct:merchant-001",
    tenantRef: "tenant:merchant-001",
    authorization: {
      status: input.authorizationStatus ?? "ACTIVE",
      grantedAt: "2026-10-01T00:00:00Z",
      authorizationRef: "authz:001",
    },
    credentialScope: {
      credentialRef: "cred:001",
      credentialKind: "API_KEY",
    },
    geography: { countries: ["US"] },
    currencies: ["USC"],
    permissionState: {
      granted: ["onchain:write"],
      requested: ["onchain:write"],
      missing: [],
    },
    eligibility: {
      eligible: input.eligible ?? true,
      reasons: [],
    },
    configuration: { venueKind: "synthetic" },
    protocolKey: input.protocolKey,
    chainKey: CHAIN,
  };
}

/** The baseline security policy (permissive; tests add restrictions). */
export function baseSecurityPolicy(
  overrides?: Partial<OnchainSecurityPolicy>,
): OnchainSecurityPolicy {
  return {
    policyId: "security-policy-1",
    version: 1,
    allowedChains: [CHAIN],
    allowedAssets: [USC_ASSET, ETH_ASSET],
    allowedSpenders: [SYNTHETIC_ROUTER],
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
 * The baseline best-execution policy: numeraire USC; explicit conversions
 * (USC 1:1, ETH at a synthetic 3000 USC per ETH expressed per minor unit:
 * 3000*10^6 / 10^8 = 300/10 = 30 USC minor per ETH minor); explicit risk
 * deductions; explicit time cost. EVERY number is a declared field — the
 * tests mutate them to prove the comparator has no constants of its own.
 */
export function baseBestExecutionPolicy(
  overrides?: Partial<BestExecutionPolicy>,
): BestExecutionPolicy {
  return {
    policyId: "best-exec-policy-1",
    version: 1,
    numeraire: "USC",
    conversions: [
      { asset: USC_ASSET, rate: { numerator: "1", denominator: "1" } },
      { asset: ETH_ASSET, rate: { numerator: "30", denominator: "1" } },
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

export function healthyObservation(
  overrides?: Partial<HealthObservation>,
): HealthObservation {
  return {
    status: "HEALTHY",
    observedAtMs: NOW,
    maxAgeMs: 30_000,
    provenance: {
      providerName: "synthetic-venue-provider",
      source: "OPERATOR",
      capturedAtMs: NOW,
      evidenceRefs: ["evidence:health:001"],
    },
    ...overrides,
  };
}

/** Quote construction overrides for the synthetic venue. */
export interface SyntheticQuoteConfig {
  readonly quoteId?: string;
  /** Worst-case output in USC minor units (the executable number). */
  readonly worstCaseOutputMinorUnits: string;
  readonly expectedOutputMinorUnits?: string;
  readonly limitBasisPoints?: number;
  readonly fees?: readonly {
    feeKind: "VENUE_FEE" | "PROTOCOL_FEE" | "INTEGRATOR_FEE" | "SOLVER_FEE" | "NETWORK_FEE" | "PROVIDER_DEFINED";
    minorUnits: string;
    description: string;
  }[];
  readonly gasUnits?: string;
  readonly gasPricePerUnit?: { numerator: string; denominator: string };
  readonly riskClass?: "LOW" | "MODERATE" | "ELEVATED" | "HIGH";
  readonly estimatedSettlementMs?: number;
  readonly hops?: number;
  readonly asOfMs?: number;
  readonly maxAgeMs?: number;
  readonly quoteSemantics?: "INDICATIVE" | "EXECUTABLE";
  readonly optimizationOrigin?: "PROVIDER_NATIVE" | "COMPOSED";
  readonly liquidityImpactMinorUnits?: string;
}

export interface SyntheticVenueConfig {
  readonly venueId: string;
  readonly protocolKey: string;
  readonly quoteConfig?: SyntheticQuoteConfig;
  readonly quoteOutcome?: "QUOTE" | "UNAVAILABLE" | "OUTCOME_UNKNOWN";
  readonly outcomeReason?: string;
  readonly health?: HealthObservation;
  readonly supportsSimulation?: boolean;
  readonly simulateStatus?: "SUCCEEDED" | "REVERTED" | "OUTCOME_UNKNOWN";
  readonly simulateOutputMinorUnits?: string;
  readonly contractAddress?: string;
}

/** Builds a fully deterministic synthetic venue behind the neutral port. */
export function syntheticVenue(config: SyntheticVenueConfig): ExecutionVenue {
  const quoteConfig = config.quoteConfig;
  const quote: VenueQuote | undefined =
    config.quoteOutcome === undefined || config.quoteOutcome === "QUOTE"
      ? buildSyntheticQuote(config.venueId, config.protocolKey, quoteConfig)
      : undefined;

  return {
    descriptor: {
      venueId: config.venueId,
      displayName: `Synthetic venue ${config.venueId}`,
      chains: [CHAIN],
      swapKinds: ["EXACT_INPUT"],
      quoteSemantics: quoteConfig?.quoteSemantics ?? "EXECUTABLE",
      slippageProtection: "DECLARED_LIMIT",
      supportsSimulation: config.supportsSimulation ?? true,
    },
    protocol: { protocolKey: config.protocolKey, chainKey: CHAIN },
    quote(request: never, at: number): VenueQuoteOutcome {
      void request;
      void at;
      if (quote !== undefined) {
        return { kind: "QUOTE", quote };
      }
      if (config.quoteOutcome === "UNAVAILABLE") {
        return { kind: "UNAVAILABLE", reason: config.outcomeReason ?? "synthetic venue unavailable" };
      }
      return { kind: "OUTCOME_UNKNOWN", reason: config.outcomeReason ?? "synthetic venue could not determine a quote" };
    },
    observeHealth(at: number): HealthObservation {
      void at;
      return config.health ?? healthyObservation();
    },
    planWrite(input: VenueWritePlanningInput): OnchainWriteRequest {
      const q = input.quote;
      const router = config.contractAddress ?? SYNTHETIC_ROUTER;
      return {
        writeId: `write:${q.quoteId}`,
        action: "onchain.swap",
        chain: q.chain,
        approvals: [
          {
            asset: q.inputAsset,
            owner: input.owner,
            spender: router,
            amount: { currency: q.inputAsset.symbol, minorUnits: q.inputAmount.minorUnits },
            unlimited: false,
          },
        ],
        contractCall: {
          target: router,
          calldata: `0xsynthetic-swap-${q.quoteId}`,
          calldataDigest: `sha256:calldata-${q.quoteId}`,
        },
        route: {
          routeId: input.routeRef,
          routeHash: input.routeHash,
          hops: q.routeShape.map((hop) => ({
            venue: hop.venue,
            chain: hop.chain,
            ...(hop.protocolId !== undefined ? { protocolId: hop.protocolId } : {}),
          })),
        },
        protocol: {
          protocolId: config.protocolKey,
          version: "1.0.0",
          contract: syntheticContractExtension({
            contractAddress: router,
          }),
        },
        expiry: input.expiryMs,
        requestedBy: input.requestedBy,
      };
    },
    simulate(write: PreparedWrite, at: number): SimulationObservation {
      const q = quote;
      return {
        simulationId: `sim:${write.writeId}`,
        writeId: write.writeId,
        status: config.simulateStatus ?? "SUCCEEDED",
        observedAt: at,
        blockRef: "block:synthetic-1",
        balanceDeltas:
          q !== undefined
            ? [
                {
                  holder: OWNER,
                  asset: q.inputAsset,
                  amount: { currency: q.inputAsset.symbol, minorUnits: "1000000" },
                  direction: "debit",
                },
                {
                  holder: BENEFICIARY,
                  asset: q.outputAsset,
                  amount: {
                    currency: q.outputAsset.symbol,
                    minorUnits: config.simulateOutputMinorUnits ?? q.slippage.worstCaseOutput.minorUnits,
                  },
                  direction: "credit",
                },
              ]
            : [],
        approvals: write.approvals.map((approval) => ({
          owner: approval.owner,
          spender: approval.spender,
          asset: approval.asset,
          allowance: approval.amount,
          unlimited: approval.unlimited,
        })),
        gasEstimate: "150000",
        simulator: "synthetic-venue-simulator",
      };
    },
  };
}

function buildSyntheticQuote(
  venueId: string,
  protocolKey: string,
  config?: SyntheticQuoteConfig,
): VenueQuote {
  const worstCase = config?.worstCaseOutputMinorUnits ?? "990000";
  return {
    quoteId: config?.quoteId ?? `quote-${venueId}-001`,
    venueId,
    requestId: "swap-request-001",
    chain: CHAIN,
    swapKind: "EXACT_INPUT",
    inputAsset: USC_ASSET,
    outputAsset: USC_ASSET,
    inputAmount: { currency: "USC", minorUnits: "1000000" },
    quoteSemantics: config?.quoteSemantics ?? "EXECUTABLE",
    fees:
      config?.fees === undefined
        ? []
        : config.fees.map((fee) => ({
            feeKind: fee.feeKind,
            amount: { asset: USC_ASSET, minorUnits: fee.minorUnits },
            description: fee.description,
          })),
    gasCost: {
      gasUnits: config?.gasUnits ?? "150000",
      pricePerUnitNativeMinor: config?.gasPricePerUnit ?? { numerator: "1", denominator: "1000" },
      feeAsset: USC_ASSET,
    },
    slippage: {
      protection: "DECLARED_LIMIT",
      worstCaseOutput: { currency: "USC", minorUnits: worstCase },
      ...(config?.limitBasisPoints !== undefined
        ? { limitBasisPoints: config.limitBasisPoints }
        : {}),
      ...(config?.expectedOutputMinorUnits !== undefined
        ? { expectedOutput: { currency: "USC", minorUnits: config.expectedOutputMinorUnits } }
        : {}),
    },
    ...(config?.liquidityImpactMinorUnits !== undefined
      ? {
          liquidityImpact: {
            declaredImpactCost: { asset: USC_ASSET, minorUnits: config.liquidityImpactMinorUnits },
            description: "synthetic declared liquidity impact",
          },
        }
      : {}),
    failureRisk: {
      riskClass: config?.riskClass ?? "LOW",
      retryPolicy: "SAFE_TO_RETRY",
      description: "synthetic failure-risk disclosure",
    },
    timeToSettlement: {
      estimatedMs: config?.estimatedSettlementMs ?? 60_000,
      finalityModel: "PROBABILISTIC",
      description: "synthetic settlement estimate",
    },
    routeShape: Array.from({ length: config?.hops ?? 1 }, (_, index) => ({
      venue: venueId,
      chain: CHAIN,
      protocolId: protocolKey,
      description: `synthetic hop ${index + 1}`,
    })),
    optimizationOrigin: config?.optimizationOrigin ?? "PROVIDER_NATIVE",
    freshness: {
      asOfMs: config?.asOfMs ?? NOW,
      maxAgeMs: config?.maxAgeMs ?? 10_000,
    },
    provenance: {
      providerName: `synthetic-venue-${venueId}`,
      source: "VENUE_API",
      capturedAtMs: NOW,
      evidenceRefs: [`evidence:quote:${venueId}:001`],
    },
    observer: {
      observerId: `observer:${venueId}`,
      observerKind: "VENUE_API",
    },
  };
}

/** The canonical USC→USC swap request used across the engine tests. */
export function baseSwapRequest() {
  return {
    requestId: "swap-request-001",
    chain: CHAIN,
    inputAsset: USC_ASSET,
    outputAsset: USC_ASSET,
    swapKind: "EXACT_INPUT" as const,
    amount: { currency: "USC", minorUnits: "1000000" },
  };
}

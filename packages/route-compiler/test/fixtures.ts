/**
 * Shared deterministic fixtures for the @payswap/route-compiler test suite
 * (Work Order P4-W4-001). Every identifier, timestamp, amount and rate is a
 * fixed constant — no clock, no randomness. Addresses are obviously
 * synthetic except the published Uniswap v2 contract constants the REAL
 * reference venue pack declares.
 *
 * The fixtures deliberately compose the REAL merged kernels, not lookalikes:
 * - the onchain swap legs run through the REAL Uniswap v2 reference venue
 *   extension pack (createUniswapV2VenuePack with injected deterministic
 *   pool-state observations — the venue port, the v2 constant-product math
 *   and the INV-SC01 contract declarations are the pack's own);
 * - the protocol instance is built through mixed-rail's
 *   protocolInstanceForPack (the canonical pack contract helper);
 * - the fiat legs ground in canonical CapabilityObservations built through
 *   the connectors' own observeCapability;
 * - the off-ramp payout gate runs the REAL evaluatePayoutGate over an
 *   activation record carrying a separate TransferOutAuthorization;
 * - the bank arrival destinations are canonical MerchantSettlementDestinations;
 * - the Stripe eligibility evidence satisfies the provider-verified-effects
 *   contract (honestly awaiting the P4-W1-003 authority);
 * - the opportunity context is derived through the REAL discoverOpportunity
 *   (the W3-002 kernel's own discovery function).
 */

import { registerCurrency, currencyCode } from "@payswap/protocol";
import type { AmountSpec } from "@payswap/trust";
import type { VersionedRef, AgentBody, AgentPrincipalRef } from "@payswap/agents";
import type { SmartContractExtension } from "@payswap/capabilities";
import {
  observeCapability,
  type CapabilityDefinition,
  type CapabilityObservation,
  type ConnectedCapabilityInstance,
  type ConnectedInstanceActivation,
} from "@payswap/connectors";
import { defineSettlementDestination } from "@payswap/payment";
import type { MerchantSettlementDestination } from "@payswap/payment";
import { canonicalAssetRef } from "@payswap/onchain-domain";
import type { AssetObservation } from "@payswap/onchain-domain";
import type {
  BestExecutionPolicy,
  HealthObservation,
  QuoteFreshness,
  QuoteObserver,
  QuoteProvenance,
} from "@payswap/best-execution";
import type {
  AssetIdentity,
  OnchainSecurityPolicy,
  OnchainSecurityState,
} from "@payswap/onchain-security";
import { createUniswapV2VenuePack, UNISWAP_V2_ROUTER_02_ADDRESS } from "@payswap/onchain-venues/uniswap";
import type { UniswapPoolState } from "@payswap/onchain-venues/uniswap";
import { protocolInstanceForPack } from "@payswap/mixed-rail";
import { discoverOpportunity } from "@payswap/onchain-opportunities";
import type { FinancialOpportunity, OpportunityObservationInput } from "@payswap/onchain-opportunities";
import type { SimulatedWorld, SimulationScenarioPlan } from "@payswap/lab";
import type { RouteCompilerInput, FiatConversionRule, RoutingHints } from "../src/index.js";
import { compileMoneyMovementRoute } from "../src/index.js";
import type { MoneyMovementIntent, RouteCompilationResult } from "../src/index.js";
import type { StripeCryptoSettlementEligibilityEvidence } from "../src/index.js";
import type { PlannedLegAmount } from "../src/index.js";

// Currency registration (the protocol money law; AmountSpec → Money needs it).
registerCurrency("USC", 6);
registerCurrency("ETH", 8);
registerCurrency("EUR", 2);
registerCurrency("USD", 2);

// ---------------------------------------------------------------------------
// Deterministic constants
// ---------------------------------------------------------------------------

export const CHAIN = "ethereum:mainnet" as const;
export const CHAIN_B = "solana:mainnet-beta" as const;
export const NOW_ISO = "2026-10-03T00:00:00Z" as const;
export const NOW = Date.parse(NOW_ISO);

export const USC_ASSET: AssetIdentity = {
  chain: CHAIN,
  assetId: "0xaaaa111111111111111111111111111111111111",
  symbol: "USC",
};
export const ETH_ASSET: AssetIdentity = {
  chain: CHAIN,
  assetId: "0xbbbb222222222222222222222222222222222222",
  symbol: "ETH",
};
/** The stablecoin as it exists on the destination chain (route 3, chain B). */
export const USC_SOLANA_ASSET: AssetIdentity = {
  chain: CHAIN_B,
  assetId: canonicalAssetRef(CHAIN_B, "USC"),
  symbol: "USC",
};

export const OWNER = "0x1111111111111111111111111111111111111111";
export const RECIPIENT = "0x2222222222222222222222222222222222222222";
export const SOLANA_RECIPIENT = "solrecipient1111111111111111111111111111111";
export const TENANT_REF = "tenant:route-compiler";

/** The off-ramp provider's onchain receiving address (synthetic). */
export const OFFRAMP_DEPOSIT_ADDRESS = "0x5555555555555555555555555555555555555555";
/** The bridge contract on the origin chain (synthetic). */
export const BRIDGE_CONTRACT_ADDRESS = "0x6666666666666666666666666666666666666666";
/** The onramp issuer's delivery treasury on the destination chain (synthetic). */
export const ONRAMP_DELIVERY_ADDRESS = "0x7777777777777777777777777777777777777777";

export const OFFRAMP_PROVIDER = "psp-mock" as const;
export const MERCHANT_BANK_IBAN = "iban:DE89370400440532013000" as const;
export const MERCHANT_BANK_ACH = "us-ach:021000021/9876543" as const;
export const STRIPE_ACCOUNT_REF = "acct-stripe-merchant-001" as const;

/** 0.01 ETH at the pool's 18-digit fixture scale (the deep pool holds ≈0.3333 ETH). */
export const ORIGIN_ETH_MINOR = "10000000000000000" as const;

// ---------------------------------------------------------------------------
// The REAL Uniswap v2 reference venue pack (deterministic injected pool state)
// ---------------------------------------------------------------------------

function poolFreshness(): QuoteFreshness {
  return { asOfMs: NOW, maxAgeMs: 10_000 };
}

/** A deep ETH/USC pool (1 ETH ≈ 3000 USC in the fixture; 18-digit ETH scale). */
export function deepEthUscPool(): UniswapPoolState {
  return {
    pairId: "pair:eth-usc",
    assetA: USC_ASSET,
    assetB: ETH_ASSET,
    reserveAMinorUnits: "1000000000000", // 1,000,000 USC
    reserveBMinorUnits: "333333333333333333", // ≈0.3333 ETH at 18 digits
    freshness: poolFreshness(),
    provenance: {
      providerName: "route-compiler-fixture-indexer",
      source: "INDEXED_POOL_STATE",
      capturedAtMs: NOW,
      evidenceRefs: ["evidence:pool-state:pair-eth-usc"],
    },
    observer: {
      observerId: "observer:route-compiler-indexer",
      observerKind: "INDEXER",
    },
  };
}

/** A stale-pool variant (quote staleness → the engine's stale-routes law). */
export function staleEthUscPool(): UniswapPoolState {
  return {
    ...deepEthUscPool(),
    pairId: "pair:eth-usc-stale",
    freshness: { asOfMs: NOW - 60_000, maxAgeMs: 10_000 },
  };
}

export function uniswapPack(): ReturnType<typeof createUniswapV2VenuePack> {
  return createUniswapV2VenuePack({
    pools: [deepEthUscPool()],
    gasCost: {
      gasUnits: "160000",
      pricePerUnitNativeMinor: { numerator: "3", denominator: "1000000000" },
      feeAsset: ETH_ASSET,
    },
  });
}

// ---------------------------------------------------------------------------
// Kernel-side policy fixtures (the mixed-rail / onchain-venues fixture shapes)
// ---------------------------------------------------------------------------

export function baseSecurityPolicy(
  overrides?: Partial<OnchainSecurityPolicy>,
): OnchainSecurityPolicy {
  return {
    policyId: "security-policy-route-compiler",
    version: 1,
    allowedChains: [CHAIN],
    allowedAssets: [USC_ASSET, ETH_ASSET],
    allowedSpenders: [UNISWAP_V2_ROUTER_02_ADDRESS],
    maxApprovalAmount: { currency: "ETH", minorUnits: "20000000000000000" },
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

export function baseBestExecutionPolicy(
  overrides?: Partial<BestExecutionPolicy>,
): BestExecutionPolicy {
  return {
    policyId: "best-exec-policy-route-compiler",
    version: 1,
    numeraire: "USC",
    conversions: [
      { asset: USC_ASSET, rate: { numerator: "1", denominator: "1" } },
      { asset: ETH_ASSET, rate: { numerator: "3", denominator: "1000000000" } },
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

// ---------------------------------------------------------------------------
// Protocol instance + asset observations (canonical shapes)
// ---------------------------------------------------------------------------

/** The connected protocol instance for the REAL Uniswap pack (mixed-rail helper). */
export function uniswapProtocolInstance(accountRef: string = OWNER): ReturnType<typeof protocolInstanceForPack> {
  return protocolInstanceForPack(uniswapPack(), {
    instanceId: "instance:uniswap-v2:001",
    accountRef,
    tenantRef: TENANT_REF,
  });
}

export function ethAssetObservation(input?: {
  readonly accountRef?: string;
  readonly asOf?: string;
}): AssetObservation {
  return {
    observationKind: "AssetObservation",
    observationId: "route-obs:eth:owner:1",
    observedAt: NOW_ISO,
    assetId: canonicalAssetRef(CHAIN, "ETH"),
    chainKey: CHAIN,
    location: {
      chainKey: CHAIN,
      accountRef: input?.accountRef ?? OWNER,
    },
    observedAmount: {
      currency: canonicalAssetRef(CHAIN, "ETH"),
      minorUnits: "10000000000000000000", // 20 ETH at the fixture scale
    },
    freshness: {
      asOf: input?.asOf ?? NOW_ISO,
      maxAgeSeconds: 60,
    },
    provenance: {
      providerName: "route-compiler-observer",
      source: "INTERNAL",
      capturedAt: NOW_ISO,
    },
    observer: {
      observerId: "observer:route-compiler-node-001",
      observerKind: "CHAIN_NODE",
    },
  };
}

export function uscAssetObservation(input?: {
  readonly accountRef?: string;
  readonly asOf?: string;
  readonly observationId?: string;
}): AssetObservation {
  return {
    observationKind: "AssetObservation",
    observationId: input?.observationId ?? "route-obs:usc:treasury:1",
    observedAt: NOW_ISO,
    assetId: canonicalAssetRef(CHAIN, "USC"),
    chainKey: CHAIN,
    location: {
      chainKey: CHAIN,
      accountRef: input?.accountRef ?? ONRAMP_DELIVERY_ADDRESS,
    },
    observedAmount: {
      currency: canonicalAssetRef(CHAIN, "USC"),
      minorUnits: "1000000000000",
    },
    freshness: {
      asOf: input?.asOf ?? NOW_ISO,
      maxAgeSeconds: 60,
    },
    provenance: {
      providerName: "route-compiler-observer",
      source: "INTERNAL",
      capturedAt: NOW_ISO,
    },
    observer: {
      observerId: "observer:route-compiler-node-001",
      observerKind: "CHAIN_NODE",
    },
  };
}

// ---------------------------------------------------------------------------
// Fiat-side fixtures (the canonical connector shapes)
// ---------------------------------------------------------------------------

function fiatBaseDefinition(input: {
  capabilityId: string;
  summary: string;
  nativeOptimization?: CapabilityDefinition["nativeOptimization"];
}): CapabilityDefinition {
  return {
    capabilityId: input.capabilityId,
    capabilityVersion: "1.0.0",
    summary: input.summary,
    kind: "WRITE",
    requiredPermissions: ["payments:write"],
    executionModes: ["PASS_THROUGH_NATIVE", "COMPOSED_PAYSWAP", "OPTIMIZED_MULTI_PROVIDER"],
    semantics: {
      operation: "payments.create_authorization",
      stateMachine: { documentRef: "sm:payments", version: "1.0.0" },
      description: "create a payment authorization on the provider",
    },
    preconditions: ["connected account ACTIVE", "protocol authorization present"],
    authorization: {
      protocolAuthorization: true,
      requiredScopes: ["payments:write"],
      customerConsent: "IMPLICIT",
    },
    sideEffects: [
      {
        effect: "external payment authorization created",
        financialEffect: "RESERVES_VALUE",
        reversible: true,
      },
    ],
    idempotency: {
      idempotent: true,
      keyScope: "REQUEST",
      duplicateBehavior: "RETURNED_SAME_RESULT",
      retryPolicy: "SAFE_TO_RETRY",
    },
    compensation: {
      compensable: true,
      compensationCapabilityId: "psp.refunds",
      cancellation: "BEFORE_EXECUTION",
      partialExecution: {
        possible: true,
        granularity: "LINE_ITEM",
        onPartial: "DISCLOSED",
      },
    },
    requiredCustomerActions: [],
    providerVocabulary: {
      actions: [{ action: "capture", description: "capture an authorization" }],
      states: [
        {
          providerState: "requires_action",
          canonicalState: "USER_ACTION_REQUIRED",
          requiresCustomerAction: true,
          isTerminal: false,
        },
      ],
    },
    externalObjects: [
      { objectType: "payment_intent", idFormat: "pi_[a-z0-9]+", revisioned: false },
    ],
    evidence: {
      produced: ["EXECUTION", "RECEIPT"],
      required: ["AUTHORIZATION"],
    },
    economics: {
      feeModel: "HYBRID",
      limits: [
        { dimension: "AMOUNT", description: "max 1M minor units per payment" },
      ],
      settlementImplications: "T+0 on provider settlement rails",
    },
    constraints: [
      { kind: "JURISDICTION", description: "SEPA only", countryCodes: ["DE", "FR"] },
    ],
    ...(input.nativeOptimization !== undefined
      ? { nativeOptimization: input.nativeOptimization }
      : {}),
  };
}

/** The incumbent provider-native fiat routing capability (INV-C08). */
export function makeNativeRoutingDefinition(): CapabilityDefinition {
  return fiatBaseDefinition({
    capabilityId: "psp.native-routing",
    summary: "provider-native payment routing optimization",
    nativeOptimization: {
      optimizationKind: "ROUTING",
      benchmarkBaseline: true,
    },
  });
}

/** A plain composed payout capability. */
export function makeComposedPayoutDefinition(): CapabilityDefinition {
  return fiatBaseDefinition({
    capabilityId: "psp.payouts",
    summary: "provider payout execution capability",
  });
}

export function makeFiatInstance(input: {
  instanceId: string;
  capabilityId: string;
  providerName?: string;
  currencies?: readonly string[];
  authorizationStatus?: ConnectedCapabilityInstance["authorization"]["status"];
  eligible?: boolean;
}): ConnectedCapabilityInstance {
  return {
    instanceId: input.instanceId,
    capabilityId: input.capabilityId,
    implementationId: `${input.capabilityId}:impl:1`,
    providerName: input.providerName ?? OFFRAMP_PROVIDER,
    providerVersion: "2024-01",
    accountRef: "acct-123",
    tenantRef: "tenant-1",
    authorization: {
      status: input.authorizationStatus ?? "ACTIVE",
      grantedAt: NOW_ISO,
    },
    credentialScope: {
      credentialRef: "cred-1",
      credentialKind: "API_KEY",
    },
    geography: { countries: ["DE", "FR", "US"] },
    currencies: [...(input.currencies ?? ["EUR", "USD"])],
    permissionState: { granted: ["payments:write"], requested: ["payments:write"], missing: [] },
    eligibility: {
      eligible: input.eligible ?? true,
      reasons: [],
    },
    configuration: { endpointKind: "psp-mock" },
  };
}

export function makeFiatObservation(input: {
  instanceId: string;
  observedAt?: string;
}): CapabilityObservation {
  return observeCapability({
    instanceId: input.instanceId,
    observedAt: input.observedAt ?? NOW_ISO,
    observationVersion: 1,
    capabilityState: "AVAILABLE",
    sourceAvailability: "REACHABLE",
    eligibility: "ELIGIBLE",
    health: { status: "HEALTHY", lastCheckedAt: input.observedAt ?? NOW_ISO },
    provenance: {
      providerName: OFFRAMP_PROVIDER,
      source: "PROVIDER_API",
      capturedAt: input.observedAt ?? NOW_ISO,
    },
  });
}

/** The activation record carrying the SEPARATE transfer-out authorization (the payout gate input). */
export function makePayoutActivation(input?: {
  readonly instanceId?: string;
  readonly transferOut?: ConnectedInstanceActivation["transferOut"];
}): ConnectedInstanceActivation {
  return {
    instanceId: input?.instanceId ?? "instance:psp-payouts:1",
    providerName: OFFRAMP_PROVIDER,
    capabilityId: "psp.payouts",
    authorizationMode: "SCOPED_API_CREDENTIAL",
    state: "ACTIVE",
    connectionScope: {
      accountRef: "acct-123",
      tenantRef: "tenant-1",
      countries: ["DE", "FR", "US"],
      currencies: ["EUR", "USD"],
      grantedPermissions: ["payments:read"],
      missingPermissions: [],
      credentialRef: "cred-1",
      credentialKind: "API_KEY",
      eligibilityReasons: [],
    },
    authorizationRef: "authz:conn-001",
    transferOut:
      input?.transferOut ??
      {
        grantedAt: NOW_ISO,
        expiresAt: "2026-12-31T00:00:00Z",
        authorizationRef: "authz:transfer-out-001",
        currencyScope: ["EUR", "USD"],
        maxSingleAmountMinor: 100_000_000,
        requiresProviderStepUp: false,
      },
    history: [],
  };
}

// ---------------------------------------------------------------------------
// Settlement destinations + conversion rules + Stripe evidence
// ---------------------------------------------------------------------------

export function merchantBankEuroDestination(): MerchantSettlementDestination {
  return defineSettlementDestination({
    id: "dest:merchant-bank-eur",
    kind: "BANK_ACCOUNT",
    currency: currencyCode("EUR"),
    externalRef: MERCHANT_BANK_IBAN,
    provenance: {
      source: "merchant-onboarding",
      reference: "onb-42",
      recordedAt: 1793000000000n,
    },
  });
}

export function merchantBankUsdDestination(): MerchantSettlementDestination {
  return defineSettlementDestination({
    id: "dest:merchant-bank-usd",
    kind: "BANK_ACCOUNT",
    currency: currencyCode("USD"),
    externalRef: MERCHANT_BANK_ACH,
    provenance: {
      source: "merchant-onboarding",
      reference: "onb-43",
      recordedAt: 1793000000000n,
    },
  });
}

/** Exact minor-unit→minor-unit conversion groundings (peg declarations; never compiler-invented FX). */
export function baseConversionRules(): readonly FiatConversionRule[] {
  return [
    {
      ruleId: "peg:usc-eur",
      fromCurrency: "USC",
      toCurrency: "EUR",
      rate: { numerator: "92", denominator: "1000000" },
      declaredBy: "peg:issuer-eur-peg",
    },
    {
      ruleId: "peg:usc-usd",
      fromCurrency: "USC",
      toCurrency: "USD",
      rate: { numerator: "1", denominator: "10000" },
      declaredBy: "peg:issuer-usd-peg",
    },
    {
      ruleId: "peg:eur-usc",
      fromCurrency: "EUR",
      toCurrency: "USC",
      rate: { numerator: "10800", denominator: "1" },
      declaredBy: "peg:issuer-eur-peg",
    },
    {
      ruleId: "peg:eth-eur",
      fromCurrency: "ETH",
      toCurrency: "EUR",
      rate: { numerator: "276", denominator: "1000000000000000" },
      declaredBy: "peg:eth-eur-reference",
    },
    {
      ruleId: "peg:eth-usd",
      fromCurrency: "ETH",
      toCurrency: "USD",
      rate: { numerator: "3", denominator: "10000000000000" },
      declaredBy: "peg:eth-usd-reference",
    },
  ];
}

/** Provider-verified Stripe crypto settlement eligibility evidence (Mode A, awaiting P4-W1-003). */
export function stripeEligibilityEvidence(input?: {
  readonly asOf?: string;
  readonly currency?: string;
}): StripeCryptoSettlementEligibilityEvidence {
  return {
    evidenceId: "stripe-eligibility:001",
    stripeAccountRef: STRIPE_ACCOUNT_REF,
    currency: input?.currency ?? "USD",
    eligible: true,
    providerVerified: true,
    verificationRef: "stripe-verify:eligibility-001",
    observedAt: NOW_ISO,
    freshness: {
      asOf: input?.asOf ?? NOW_ISO,
      maxAgeSeconds: 3600,
    },
    awaitingAuthority: "P4-W1-003",
  };
}

// ---------------------------------------------------------------------------
// The opportunity context (derived through the REAL W3-002 discovery kernel)
// ---------------------------------------------------------------------------

function liquidityObservation(input?: {
  readonly freshnessAgeMs?: number;
}): OpportunityObservationInput {
  return {
    family: "liquidity",
    observationId: "obs:liq:route-compiler:001",
    venueId: "venue:stable-pair",
    protocolKey: "protocol:amm-v2",
    chainKey: CHAIN,
    adapterId: "adapter:onchain:evm",
    observerId: "observer:indexer:001",
    freshness: {
      asOfMs: NOW - (input?.freshnessAgeMs ?? 0),
      maxAgeMs: 30_000,
    },
    evidenceRefs: ["evidence:pool-state:001", "evidence:fee-tier:001"],
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
      status: "AVAILABLE",
      description:
        "exit observed in one transaction through the venue router; withdrawal liquidity was observed at the evidence instant",
      constraints: ["exit size may be constrained by observed withdrawal liquidity"],
    },
    lockUp: { locked: false, durationMs: null, unlockConditions: [] },
    smartContractRisk: {
      level: "LOW",
      audited: true,
      summary: "independent audit observed; source and bytecode hashes recorded in the evidence chain",
    },
    oracleBridgeRisk: {
      level: "UNKNOWN",
      audited: null,
      summary: "oracle and bridge dependencies were not determinable from the observation",
    },
    maxLoss: { fractionOfCapital: { numerator: "5", denominator: "100" } },
    returnComponents: [
      {
        componentId: "liq:fee-yield",
        kind: "FEE_YIELD",
        ratePerYear: { numerator: "431", denominator: "10000" },
        evidenceVerified: true,
        description: "observed fee yield component, annualized from venue observations",
      },
    ],
  };
}

export function liquidityOpportunity(input?: {
  readonly freshnessAgeMs?: number;
}): FinancialOpportunity {
  return discoverOpportunity(liquidityObservation(input), NOW);
}

// ---------------------------------------------------------------------------
// The four representative Money Movement Intents
// ---------------------------------------------------------------------------

export function route1Intent(): MoneyMovementIntent {
  return {
    intentId: "intent:route-1:crypto-dex-offramp-bank",
    principalRef: "user:merchant-ops-001",
    origin: {
      kind: "ONCHAIN_WALLET",
      chainKey: CHAIN,
      accountRef: OWNER,
      assetId: canonicalAssetRef(CHAIN, "ETH"),
      symbol: "ETH",
    },
    destination: {
      kind: "BANK_ACCOUNT",
      externalRef: MERCHANT_BANK_IBAN,
      currency: "EUR",
    },
    originAmount: { currency: "ETH", minorUnits: ORIGIN_ETH_MINOR },
    arrivalCurrency: "EUR",
    maxSettlementMs: 600_000,
    maxRouteHops: 6,
    intentAuthorizationRef: "authz:intent:route-1",
    declaredAt: NOW - 3_600_000,
    expiresAt: NOW + 3_600_000,
  };
}

export function route2Intent(): MoneyMovementIntent {
  return {
    intentId: "intent:route-2:fiat-psp-stablecoin-chain",
    principalRef: "user:payer-001",
    origin: {
      kind: "EXTERNAL_PROVIDER_ACCOUNT",
      providerName: OFFRAMP_PROVIDER,
      accountRef: "acct-fiat-001",
      currency: "EUR",
    },
    destination: {
      kind: "ONCHAIN_RECIPIENT",
      chainKey: CHAIN,
      accountRef: RECIPIENT,
      assetId: canonicalAssetRef(CHAIN, "USC"),
      symbol: "USC",
    },
    originAmount: { currency: "EUR", minorUnits: "10000" },
    arrivalCurrency: "USC",
    maxSettlementMs: 600_000,
    maxRouteHops: 6,
    intentAuthorizationRef: "authz:intent:route-2",
    declaredAt: NOW - 3_600_000,
    expiresAt: NOW + 3_600_000,
  };
}

export function route3Intent(): MoneyMovementIntent {
  return {
    intentId: "intent:route-3:chaina-dex-bridge-chainb",
    principalRef: "user:treasury-001",
    origin: {
      kind: "ONCHAIN_WALLET",
      chainKey: CHAIN,
      accountRef: OWNER,
      assetId: canonicalAssetRef(CHAIN, "ETH"),
      symbol: "ETH",
    },
    destination: {
      kind: "ONCHAIN_RECIPIENT",
      chainKey: CHAIN_B,
      accountRef: SOLANA_RECIPIENT,
      assetId: canonicalAssetRef(CHAIN_B, "USC"),
      symbol: "USC",
    },
    originAmount: { currency: "ETH", minorUnits: ORIGIN_ETH_MINOR },
    arrivalCurrency: "USC",
    maxSettlementMs: 600_000,
    maxRouteHops: 6,
    intentAuthorizationRef: "authz:intent:route-3",
    declaredAt: NOW - 3_600_000,
    expiresAt: NOW + 3_600_000,
  };
}

export function route4Intent(): MoneyMovementIntent {
  return {
    intentId: "intent:route-4:eligible-crypto-stripe-settlement",
    principalRef: "user:merchant-001",
    origin: {
      kind: "ONCHAIN_WALLET",
      chainKey: CHAIN,
      accountRef: OWNER,
      assetId: canonicalAssetRef(CHAIN, "ETH"),
      symbol: "ETH",
    },
    destination: {
      kind: "STRIPE_MERCHANT_BALANCE",
      stripeAccountRef: STRIPE_ACCOUNT_REF,
      currency: "USD",
    },
    originAmount: { currency: "ETH", minorUnits: ORIGIN_ETH_MINOR },
    arrivalCurrency: "USD",
    maxSettlementMs: 600_000,
    maxRouteHops: 6,
    intentAuthorizationRef: "authz:intent:route-4",
    declaredAt: NOW - 3_600_000,
    expiresAt: NOW + 3_600_000,
  };
}

// ---------------------------------------------------------------------------
// The full compiler input + compile helper (the composed-kernel entry point)
// ---------------------------------------------------------------------------

export function baseRoutingHints(): RoutingHints {
  return {
    originExecutionAsset: ETH_ASSET,
    destinationExecutionAsset: USC_ASSET,
    intermediateStablecoin: USC_ASSET,
    bridgeDepositAsset: USC_ASSET,
    bridgeContractAddress: BRIDGE_CONTRACT_ADDRESS,
    offRampDeposit: {
      providerName: OFFRAMP_PROVIDER,
      chainKey: CHAIN,
      accountRef: OFFRAMP_DEPOSIT_ADDRESS,
    },
    onrampDeliveryAddress: ONRAMP_DELIVERY_ADDRESS,
    offRampPayoutCapabilityId: "psp.payouts",
  };
}

export function baseCompilerInput(
  intent: MoneyMovementIntent,
  overrides?: Partial<RouteCompilerInput>,
): RouteCompilerInput {
  const nativeRouting = makeNativeRoutingDefinition();
  const payoutDefinition = makeComposedPayoutDefinition();
  const nativeInstance = makeFiatInstance({
    instanceId: "instance:native-routing:1",
    capabilityId: nativeRouting.capabilityId,
  });
  const payoutInstance = makeFiatInstance({
    instanceId: "instance:psp-payouts:1",
    capabilityId: payoutDefinition.capabilityId,
  });
  return {
    intent,
    at: NOW,
    venuePacks: [uniswapPack()],
    bestExecutionPolicy: baseBestExecutionPolicy(),
    onchainSecurity: {
      policy: baseSecurityPolicy(),
      state: baseSecurityState(),
    },
    onchainInstances: [uniswapProtocolInstance()],
    assetObservations: [ethAssetObservation(), uscAssetObservation()],
    fiatDefinitions: [nativeRouting, payoutDefinition],
    fiatInstances: [nativeInstance, payoutInstance],
    fiatObservations: [
      makeFiatObservation({ instanceId: nativeInstance.instanceId }),
      makeFiatObservation({ instanceId: payoutInstance.instanceId }),
    ],
    fiatObservationMaxAgeSeconds: 3600,
    fiatActivations: [makePayoutActivation({ instanceId: payoutInstance.instanceId })],
    settlementDestinations: [
      merchantBankEuroDestination(),
      merchantBankUsdDestination(),
    ],
    conversionRules: baseConversionRules(),
    stripeEligibilityEvidence: [stripeEligibilityEvidence()],
    opportunityObservations: [liquidityOpportunity()],
    routingHints: baseRoutingHints(),
    ...overrides,
  };
}

/** Compiles with the base fixtures; throws if nothing compiled at all (fixtures never fabricate). */
export function compileBase(
  intent: MoneyMovementIntent,
  overrides?: Partial<RouteCompilerInput>,
): RouteCompilationResult {
  return compileMoneyMovementRoute(baseCompilerInput(intent, overrides));
}

// ---------------------------------------------------------------------------
// Lab fixtures (TEST-layer only — INV-L01)
// ---------------------------------------------------------------------------

export const CANDIDATE_BODY_REF: VersionedRef<AgentBody> = {
  id: "body.route-compiler-agent",
  version: 1,
};

export const CANDIDATE_PRINCIPAL: AgentPrincipalRef = {
  agentKeyFingerprint: "sha256:routecompilerfixturefingerprint",
  ownerRef: "owner-1",
};

export const ONCHAIN_FINALITY_MODES: Readonly<Record<string, "PROBABILISTIC" | "DETERMINISTIC" | "INSTANT" | "HYBRID">> = {
  [CHAIN]: "PROBABILISTIC",
  [CHAIN_B]: "DETERMINISTIC",
};

// ---------------------------------------------------------------------------
// Test-only narrowing helpers for PlannedLegAmount (the discriminated union).
// They THROW on an unexpected basis — honest narrowing, never silent coercion:
// an expect(...) on `.basis` immediately above each use documents the intent.
// ---------------------------------------------------------------------------

/** The AmountSpec of a planned leg amount whose basis is grounded (assert the basis first). */
export function groundedPlannedAmount(planned: PlannedLegAmount): AmountSpec {
  switch (planned.basis) {
    case "INTENT_DECLARED":
    case "QUOTE_GROUNDED":
    case "CONVERSION_GROUNDED":
      return planned.amount;
    default:
      throw new Error(
        `test narrowing: planned amount basis '${planned.basis}' carries no amount (reason: ${"reason" in planned ? planned.reason : "?"})`,
      );
  }
}

/** The honest reason of an UNKNOWN planned amount (assert basis === "UNKNOWN" first). */
export function unknownPlannedReason(planned: PlannedLegAmount): string {
  if (planned.basis === "UNKNOWN") {
    return planned.reason;
  }
  throw new Error(
    `test narrowing: planned amount basis '${planned.basis}' is grounded — no UNKNOWN reason exists`,
  );
}

// ---------------------------------------------------------------------------
// The fiat simulated world + scenario (the Lab fixture shapes, unchanged laws)
// ---------------------------------------------------------------------------

export function fiatWorld(): SimulatedWorld {
  return {
    worldId: "route-compiler:world-1",
    baseCurrency: "EUR",
    stepLatencyMs: 1000,
    rails: [
      {
        railId: "rail-a",
        currency: "EUR",
        latencyMs: 500,
        fixedFeeMinor: 30n,
        variableFeeBps: 10n,
      },
      {
        railId: "rail-b",
        currency: "USD",
        latencyMs: 900,
        fixedFeeMinor: 50n,
        variableFeeBps: 25n,
        fxSpreadBps: 40n,
      },
    ],
    pools: [
      { poolId: "pool-a", railId: "rail-a", availableMinor: 1_000_000n },
      { poolId: "pool-b", railId: "rail-b", availableMinor: 1_000_000n },
    ],
  };
}

export function fiatScenario(): SimulationScenarioPlan {
  return {
    scenarioId: "route-compiler:scenario-1",
    description: "one outbound demand through the compiled fiat legs",
    demands: [
      {
        demandId: "d-1",
        atStep: 0,
        amountMinor: 100_000n,
        currency: "EUR",
        direction: "OUTBOUND",
        deadlineMs: 5_000,
      },
    ],
    incidents: [],
  };
}

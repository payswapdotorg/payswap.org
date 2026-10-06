/**
 * @payswap/certification — the deterministic P4-W4-003 production-
 * certification world (Work Order P4-W4-003).
 *
 * Every identifier, instant, amount, pool state and rate below is a fixed
 * constant — no clock, no randomness, no network. The journeys compose the
 * REAL merged kernels exactly as the product does; the ONLY synthetic
 * elements are the DECLARED, NARROW DOUBLES at the external seams, each
 * declared here with its scope:
 *
 *   1. TEST_SURFACE_SIGNER / certApprovalSurface() — a double of the
 *      kernel's own TrustedSurfaceSigner PORT (the same pattern as the
 *      kernel's and merchant-checkout's test helpers). The signature is an
 *      opaque function of the payload — it is NOT cryptography; real
 *      signing belongs to the production trusted surface. Scope: mints
 *      approval signatures at the injected surface only.
 *   2. CERT_SIGNER_ADAPTER — a double of the kernel's SignerAdapter PORT.
 *      Scope: builds the signing payload string handed back by
 *      handoffForBroadcast. Never broadcasts.
 *   3. submitAtTrustedSurface() — the injected trusted-surface submission
 *      boundary: records the deterministic BroadcastHandoffReceipt for a
 *      handed-off signing request. Scope: the submission seam between the
 *      kernel's BROADCAST_HANDOFF and the chain-observation fixtures.
 *   4. Venue pool / RFQ / intent fixtures and fiat provider observations —
 *      deterministic OBSERVATION fixtures injected into the REAL venue
 *      packs and connector observation builders (the same pattern as the
 *      route-compiler and onchain-venues fixtures).
 *
 * Money is exact integer minor units (INV-F01). UNKNOWN is not FAILED
 * (INV-X01). Secrets never appear in any fixture (the kernel's own
 * secret-scanner runs over every constructor these fixtures feed).
 */

import { registerCurrency, currencyCode, fromMinorUnits } from "@payswap/protocol";
import type { Money, TimestampMs } from "@payswap/protocol";
import type { Principal } from "@payswap/trust";
import type { SmartContractExtension } from "@payswap/capabilities";
import {
  observeCapability,
} from "@payswap/connectors";
import type {
  CapabilityDefinition,
  CapabilityObservation,
  ConnectedCapabilityInstance,
  ConnectedInstanceActivation,
} from "@payswap/connectors";
import { defineSettlementDestination } from "@payswap/payment";
import type { MerchantSettlementDestination } from "@payswap/payment";
import { canonicalAssetRef } from "@payswap/onchain-domain";
import type { AssetObservation } from "@payswap/onchain-domain";
import {
  TrustedApprovalSurface,
} from "@payswap/onchain-security";
import type {
  AssetIdentity,
  BroadcastHandoffReceipt,
  OnchainSecurityPolicy,
  OnchainSecurityState,
  OnchainWriteRequest,
  PreparedWrite,
  RecheckObservation,
  SignerAdapter,
  SimulationObservation,
  SigningRequest,
  TrustedSurfaceSigner,
} from "@payswap/onchain-security";
import type {
  BestExecutionPolicy,
  QuoteFreshness,
} from "@payswap/best-execution";
import { createUniswapV2VenuePack } from "@payswap/onchain-venues/uniswap";
import { createAggregatorVenuePack } from "@payswap/onchain-venues/aggregator";
import { createIntentsVenuePack } from "@payswap/onchain-venues/intents";
import type { UniswapPoolState } from "@payswap/onchain-venues/uniswap";
import type { RfqMakerOrder } from "@payswap/onchain-venues/aggregator";
import { protocolInstanceForPack } from "@payswap/mixed-rail";
import type { VenueExtensionPack } from "@payswap/onchain-venues";
import {
  asChainId,
  defineCryptoAmount,
  defineCryptoAsset,
  defineCryptoAssetAcceptance,
  defineCryptoQuote,
} from "@payswap/merchant-crypto";
import type { CryptoAmount, CryptoAsset, CryptoQuote } from "@payswap/merchant-crypto";
import { compileMoneyMovementRoute } from "@payswap/route-compiler";
import type {
  FiatConversionRule,
  MoneyMovementIntent,
  RouteCompilationResult,
  RouteCompilerInput,
  RoutingHints,
} from "@payswap/route-compiler";
import { UNISWAP_V2_ROUTER_02_ADDRESS } from "@payswap/onchain-venues/uniswap";
import { AGGREGATOR_SETTLEMENT_ADDRESS } from "@payswap/onchain-venues/aggregator";
import { INTENTS_SETTLEMENT_ADDRESS } from "@payswap/onchain-venues/intents";

// ---------------------------------------------------------------------------
// Currency registration (the protocol money law — idempotent per digits)
// ---------------------------------------------------------------------------

registerCurrency("USC", 6);
registerCurrency("ETH", 8);
registerCurrency("EUR", 2);

// ---------------------------------------------------------------------------
// Pinned instants (fake clock — no time-of-day dependence anywhere)
// ---------------------------------------------------------------------------

export const CERT_EPOCH_ISO = "2026-10-06T00:00:00Z" as const;
export const CERT_NOW = Date.parse(CERT_EPOCH_ISO);
/** Kernel-side instants are plain numbers (the W2-003 asKernelInstant law). */
export const CERT_LATER = CERT_NOW + 1_000;
export const CERT_EXPIRY = CERT_NOW + 3_600_000;
export const CERT_QUOTE_VALID_UNTIL = CERT_NOW + 30_000;

// ---------------------------------------------------------------------------
// Chain / asset / address identities (synthetic, obviously-fake)
// ---------------------------------------------------------------------------

export const CHAIN = "ethereum:mainnet" as const;
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
export const CUSTOMER_WALLET = "0x1111111111111111111111111111111111111111";
export const PAYEE = "0x2222222222222222222222222222222222222222";
export const OFFRAMP_DEPOSIT_ADDRESS = "0x5555555555555555555555555555555555555555";
/** The merchant's crypto settlement destination (Journey D/E). */
export const MERCHANT_DESTINATION_X = "0x9999999999999999999999999999999999999999";
export const MALICIOUS_SPENDER = "0x4444444444444444444444444444444444444444";
export const UNKNOWN_TARGET = "0x6666666666666666666666666666666666666666";
export const TENANT_REF = "tenant:production-certification";

export const OFFRAMP_PROVIDER = "psp-mock" as const;
export const MERCHANT_BANK_IBAN = "iban:DE89370400440532013000" as const;
export const STRIPE_ACCOUNT_REF = "acct-stripe-merchant-001" as const;

/** The merchant-crypto asset vocabulary (Journey D/E). */
export const USC_CRYPTO_ASSET: CryptoAsset = defineCryptoAsset({
  id: "asset.usc.ethereum",
  displayName: "USD Coin (certification fixture)",
  symbol: "USC",
  decimals: 6,
  kind: "STABLECOIN",
});
export const CHAIN_ID = asChainId(CHAIN);

export const EUR = currencyCode("EUR");
export const USD = currencyCode("USD");

// ---------------------------------------------------------------------------
// Declared double 1: the trusted-surface signer (kernel PORT double)
// ---------------------------------------------------------------------------

/**
 * DECLARED NARROW DOUBLE (external seam: the trusted signing surface). The
 * signature is an opaque function of the payload — NOT cryptography. Real
 * signing belongs to the production trusted surface; this double proves
 * the ONLY minting path goes through a signer at the injected surface.
 */
export const TEST_SURFACE_SIGNER: TrustedSurfaceSigner = {
  surfaceId: "surface:production-certification",
  signApprovalPayload(payload: string): string {
    let hash = 0;
    for (let i = 0; i < payload.length; i += 1) {
      hash = (hash * 31 + payload.charCodeAt(i)) | 0;
    }
    return `sig:${(hash >>> 0).toString(16).padStart(8, "0")}`;
  },
};

export function certApprovalSurface(): TrustedApprovalSurface {
  return new TrustedApprovalSurface(TEST_SURFACE_SIGNER);
}

// ---------------------------------------------------------------------------
// Declared double 2: the signer adapter (kernel PORT double)
// ---------------------------------------------------------------------------

/** DECLARED NARROW DOUBLE (external seam: the wallet signer adapter). */
export const CERT_SIGNER_ADAPTER: SignerAdapter = {
  adapterId: "signer:production-certification",
  supportedChains: [CHAIN],
  buildSigningPayload(input: {
    readonly artifact: unknown;
    readonly request: { readonly write: { readonly writeId: string } };
  }): string {
    return `payload:${input.request.write.writeId}:${
      input.artifact instanceof Object ? "artifact" : "none"
    }`;
  },
};

// ---------------------------------------------------------------------------
// Declared double 3: the trusted-surface submission boundary
// ---------------------------------------------------------------------------

/**
 * DECLARED NARROW DOUBLE (external seam: submission at the trusted
 * surface). Records the deterministic BroadcastHandoffReceipt for a
 * handed-off signing request — the boundary between the kernel's terminal
 * BROADCAST_HANDOFF state and the chain-observation fixtures. It never
 * signs, never broadcasts and never fabricates a chain outcome: the
 * observation of the submitted operation is produced by the REAL
 * observation/validators in each journey.
 */
export function submitAtTrustedSurface(
  request: SigningRequest,
  externalRef: string,
  submittedAt: number,
): BroadcastHandoffReceipt {
  return Object.freeze({
    requestRef: request.requestId,
    submittedAt,
    externalRef,
    evidenceRefs: Object.freeze([
      `evidence:submission:${request.requestId}`,
      `authorization:${request.authorizationRef}`,
    ]),
  });
}

// ---------------------------------------------------------------------------
// Kernel-side security fixtures
// ---------------------------------------------------------------------------

export function certSecurityPolicy(
  overrides?: Partial<OnchainSecurityPolicy>,
): OnchainSecurityPolicy {
  return {
    policyId: "security-policy:production-certification",
    version: 1,
    allowedChains: [CHAIN],
    allowedAssets: [USC_ASSET, ETH_ASSET],
    allowedDestinations: [PAYEE, OFFRAMP_DEPOSIT_ADDRESS],
    allowedSpenders: [
      UNISWAP_V2_ROUTER_02_ADDRESS,
      AGGREGATOR_SETTLEMENT_ADDRESS,
      INTENTS_SETTLEMENT_ADDRESS,
    ],
    maxApprovalAmount: { currency: "USC", minorUnits: "5000000000" },
    forbidUnlimitedApprovals: true,
    unknownContractPolicy: "block",
    unknownRoutePolicy: "escalate",
    maxSecurityStateAgeMs: 60_000,
    ...overrides,
  };
}

export function certSecurityState(
  overrides?: Partial<OnchainSecurityState>,
): OnchainSecurityState {
  return {
    observedAt: CERT_NOW,
    networkEpoch: 0n,
    quarantinedComponents: [],
    restrictedComponents: [],
    activeAdvisoryRefs: [],
    ...overrides,
  };
}

export const CERT_SERVICE_PRINCIPAL: Principal = {
  kind: "agent",
  agentKeyFingerprint: "production-certification-key-1",
  ownerRef: "user:certification-operator",
  bodyRef: "body-certification-1",
  packageVersionRef: "pkg-certification@1.0.0",
  authorityEnvelope: [],
  securityEpoch: 0n,
};

export const CUSTOMER_APPROVER_REF = "user:customer-1";

/** The certified protocol identity (INV-SC01 declarations, synthetic). */
export function contractExtension(
  overrides?: Partial<SmartContractExtension>,
): SmartContractExtension {
  return {
    kind: "smart_contract_extension",
    chainRef: CHAIN,
    contractAddress: UNISWAP_V2_ROUTER_02_ADDRESS,
    sourceHash: "src-hash-cert-1",
    bytecodeHash: "byte-hash-cert-1",
    upgradeAuthority: {
      kind: "MULTISIG",
      description: "dao multisig",
      delayOrTimelock: "48h timelock",
    },
    adminAuthority: { kind: "MULTISIG", description: "dao multisig" },
    pausePowers: [{ actor: "guardian", scope: "transfers" }],
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

export function protocolIdentity() {
  return {
    protocolId: "uniswap:v2",
    version: "1.0.0",
    contract: contractExtension(),
  };
}

// ---------------------------------------------------------------------------
// Kernel observation builders (simulation / recheck)
// ---------------------------------------------------------------------------

export function transferSimulation(
  writeId: string,
  input: {
    readonly asset: AssetIdentity;
    readonly minorUnits: string;
    readonly from: string;
    readonly to: string;
    readonly at?: number;
    readonly status?: "SUCCEEDED" | "REVERTED" | "FAILED" | "OUTCOME_UNKNOWN";
  },
): SimulationObservation {
  return {
    simulationId: `sim:cert:${writeId}`,
    writeId,
    status: input.status ?? "SUCCEEDED",
    observedAt: input.at ?? CERT_NOW,
    blockRef: "block:cert-1",
    balanceDeltas: [
      {
        holder: input.from,
        asset: { ...input.asset },
        amount: { currency: input.asset.symbol, minorUnits: input.minorUnits },
        direction: "debit",
      },
      {
        holder: input.to,
        asset: { ...input.asset },
        amount: { currency: input.asset.symbol, minorUnits: input.minorUnits },
        direction: "credit",
      },
    ],
    approvals: [],
    gasEstimate: "160000",
    simulator: "simulator:certification-fixture",
  };
}

export function recheckObservationFor(
  write: PreparedWrite,
  securityState: OnchainSecurityState,
  at: number,
): RecheckObservation {
  return {
    writeId: write.writeId,
    observedAt: at,
    chain: write.chain,
    writeDigest: write.writeDigest,
    ...(write.transfer !== undefined
      ? {
          transfer: {
            asset: write.transfer.asset,
            amount: write.transfer.amount,
            to: write.transfer.to,
          },
        }
      : {}),
    approvals: write.approvals,
    routeHash: write.route.routeHash,
    ...(write.nonce !== undefined ? { nonce: write.nonce } : {}),
    ...(write.protocol !== undefined ? { protocol: write.protocol } : {}),
    ...(write.settlementInstruction !== undefined
      ? { settlementInstruction: write.settlementInstruction }
      : {}),
    securityState,
  };
}

/** Rebuild the kernel write request from a prepared write (field-identical). */
export function requestFromPrepared(write: PreparedWrite): OnchainWriteRequest {
  return {
    writeId: write.writeId,
    action: write.action,
    chain: write.chain,
    ...(write.transfer !== undefined ? { transfer: write.transfer } : {}),
    approvals: write.approvals,
    ...(write.contractCall !== undefined ? { contractCall: write.contractCall } : {}),
    route: write.route,
    ...(write.protocol !== undefined ? { protocol: write.protocol } : {}),
    expiry: write.expiry,
    ...(write.nonce !== undefined ? { nonce: write.nonce } : {}),
    ...(write.settlementInstruction !== undefined
      ? { settlementInstruction: write.settlementInstruction }
      : {}),
    requestedBy: write.requestedBy,
  };
}

// ---------------------------------------------------------------------------
// The REAL venue packs (deterministic injected observation fixtures)
// ---------------------------------------------------------------------------

function poolFreshness(): QuoteFreshness {
  return { asOfMs: CERT_NOW, maxAgeMs: 10_000 };
}

/** A deep USC/ETH pool: 1,000,000 USC vs ≈333.33 ETH (1 ETH ≈ 3000 USC). */
export function deepUscEthPool(): UniswapPoolState {
  return {
    pairId: "pair:usc-eth",
    assetA: USC_ASSET,
    assetB: ETH_ASSET,
    reserveAMinorUnits: "1000000000000",
    reserveBMinorUnits: "333333333333333333333",
    freshness: poolFreshness(),
    provenance: {
      providerName: "certification-fixture-indexer",
      source: "INDEXED_POOL_STATE",
      capturedAtMs: CERT_NOW,
      evidenceRefs: ["evidence:cert:pool-state:pair-usc-eth"],
    },
    observer: {
      observerId: "observer:certification-indexer",
      observerKind: "INDEXER",
    },
  };
}

export function uniswapVenuePack(): ReturnType<typeof createUniswapV2VenuePack> {
  return createUniswapV2VenuePack({
    pools: [deepUscEthPool()],
    gasCost: {
      gasUnits: "160000",
      pricePerUnitNativeMinor: { numerator: "3", denominator: "1000000000" },
      feeAsset: ETH_ASSET,
    },
  });
}

/** An RFQ maker order for the aggregator venue (better output, higher risk). */
export function aggregatorRfqOrder(): RfqMakerOrder {
  return {
    orderId: "rfq:cert:maker-1",
    makerRef: "maker:certification-1",
    assetIn: USC_ASSET,
    assetOut: ETH_ASSET,
    // 1 USC (10^6 minor) → 0.000336 ETH (3.36e14 minor at 18 digits).
    outputPerInput: { numerator: "336000000000", denominator: "1000000" },
    maxInputMinorUnits: "5000000000",
    validUntilMs: CERT_NOW + 10_000,
    freshness: poolFreshness(),
    provenance: {
      providerName: "certification-rfq-maker",
      source: "RFQ",
      capturedAtMs: CERT_NOW,
      evidenceRefs: ["evidence:cert:rfq:maker-1"],
    },
    observer: {
      observerId: "observer:certification-rfq",
      observerKind: "VENUE_API",
    },
  };
}

export function aggregatorVenuePack(): ReturnType<typeof createAggregatorVenuePack> {
  return createAggregatorVenuePack({
    rfqOrders: [aggregatorRfqOrder()],
    gasCost: {
      gasUnits: "120000",
      pricePerUnitNativeMinor: { numerator: "3", denominator: "1000000000" },
      feeAsset: ETH_ASSET,
    },
    riskClass: "MODERATE",
  });
}

export function intentsVenuePack(): ReturnType<typeof createIntentsVenuePack> {
  return createIntentsVenuePack({
    referenceOutputPerInput: { numerator: "336", denominator: "1000000000000000" },
    surplusBasisPoints: 4,
    gasCost: {
      gasUnits: "90000",
      pricePerUnitNativeMinor: { numerator: "3", denominator: "1000000000" },
      feeAsset: ETH_ASSET,
    },
    riskClass: "MODERATE",
  });
}

/** The certification venue set: three REAL packs, one engine. */
export function certVenuePacks(): readonly VenueExtensionPack[] {
  return [uniswapVenuePack(), aggregatorVenuePack(), intentsVenuePack()];
}

/** The connected protocol instances for the packs (mixed-rail helper). */
export function certProtocolInstances(): readonly ReturnType<
  typeof protocolInstanceForPack
>[] {
  const packs = certVenuePacks();
  return [
    protocolInstanceForPack(packs[0] as VenueExtensionPack, {
      instanceId: "instance:cert:uniswap-v2:001",
      accountRef: CUSTOMER_WALLET,
      tenantRef: TENANT_REF,
    }),
    protocolInstanceForPack(packs[1] as VenueExtensionPack, {
      instanceId: "instance:cert:aggregator:001",
      accountRef: CUSTOMER_WALLET,
      tenantRef: TENANT_REF,
    }),
    protocolInstanceForPack(packs[2] as VenueExtensionPack, {
      instanceId: "instance:cert:intents:001",
      accountRef: CUSTOMER_WALLET,
      tenantRef: TENANT_REF,
    }),
  ];
}

export function certBestExecutionPolicy(
  overrides?: Partial<BestExecutionPolicy>,
): BestExecutionPolicy {
  return {
    policyId: "best-exec-policy:production-certification",
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
// Canonical asset observations (onchain-domain observation law)
// ---------------------------------------------------------------------------

export function uscWalletObservation(input?: {
  readonly accountRef?: string;
  readonly asOf?: string;
  readonly minorUnits?: string;
}): AssetObservation {
  return {
    observationKind: "AssetObservation",
    observationId: "cert-obs:usc:wallet:1",
    observedAt: CERT_EPOCH_ISO,
    assetId: canonicalAssetRef(CHAIN, "USC"),
    chainKey: CHAIN,
    location: {
      chainKey: CHAIN,
      accountRef: input?.accountRef ?? CUSTOMER_WALLET,
    },
    observedAmount: {
      currency: canonicalAssetRef(CHAIN, "USC"),
      minorUnits: input?.minorUnits ?? "5000000000000",
    },
    freshness: {
      asOf: input?.asOf ?? CERT_EPOCH_ISO,
      maxAgeSeconds: 60,
    },
    provenance: {
      providerName: "certification-observer",
      source: "INTERNAL",
      capturedAt: CERT_EPOCH_ISO,
    },
    observer: {
      observerId: "observer:certification-node-001",
      observerKind: "CHAIN_NODE",
    },
  };
}

export function ethWalletObservation(): AssetObservation {
  return {
    observationKind: "AssetObservation",
    observationId: "cert-obs:eth:wallet:1",
    observedAt: CERT_EPOCH_ISO,
    assetId: canonicalAssetRef(CHAIN, "ETH"),
    chainKey: CHAIN,
    location: {
      chainKey: CHAIN,
      accountRef: CUSTOMER_WALLET,
    },
    observedAmount: {
      currency: canonicalAssetRef(CHAIN, "ETH"),
      minorUnits: "10000000000000000000000",
    },
    freshness: {
      asOf: CERT_EPOCH_ISO,
      maxAgeSeconds: 60,
    },
    provenance: {
      providerName: "certification-observer",
      source: "INTERNAL",
      capturedAt: CERT_EPOCH_ISO,
    },
    observer: {
      observerId: "observer:certification-node-001",
      observerKind: "CHAIN_NODE",
    },
  };
}

// ---------------------------------------------------------------------------
// Fiat-side fixtures (the canonical connector shapes — the off-ramp seam)
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

export function makeComposedPayoutDefinition(): CapabilityDefinition {
  return fiatBaseDefinition({
    capabilityId: "psp.payouts",
    summary: "provider payout execution capability",
  });
}

export function makeFiatInstance(input: {
  instanceId: string;
  capabilityId: string;
}): ConnectedCapabilityInstance {
  return {
    instanceId: input.instanceId,
    capabilityId: input.capabilityId,
    implementationId: `${input.capabilityId}:impl:1`,
    providerName: OFFRAMP_PROVIDER,
    providerVersion: "2024-01",
    accountRef: "acct-cert-1",
    tenantRef: TENANT_REF,
    authorization: {
      status: "ACTIVE",
      grantedAt: CERT_EPOCH_ISO,
    },
    credentialScope: {
      credentialRef: "cred-cert-1",
      credentialKind: "API_KEY",
    },
    geography: { countries: ["DE", "FR", "US"] },
    currencies: ["EUR", "USD"],
    permissionState: { granted: ["payments:write"], requested: ["payments:write"], missing: [] },
    eligibility: {
      eligible: true,
      reasons: [],
    },
    configuration: { endpointKind: "psp-mock" },
  };
}

export function makeFiatObservation(input: {
  instanceId: string;
}): CapabilityObservation {
  return observeCapability({
    instanceId: input.instanceId,
    observedAt: CERT_EPOCH_ISO,
    observationVersion: 1,
    capabilityState: "AVAILABLE",
    sourceAvailability: "REACHABLE",
    eligibility: "ELIGIBLE",
    health: { status: "HEALTHY", lastCheckedAt: CERT_EPOCH_ISO },
    provenance: {
      providerName: OFFRAMP_PROVIDER,
      source: "PROVIDER_API",
      capturedAt: CERT_EPOCH_ISO,
    },
  });
}

export function makePayoutActivation(
  input?: {
    readonly instanceId?: string;
  },
): ConnectedInstanceActivation {
  return {
    instanceId: input?.instanceId ?? "instance:cert:psp-payouts:1",
    providerName: OFFRAMP_PROVIDER,
    capabilityId: "psp.payouts",
    authorizationMode: "SCOPED_API_CREDENTIAL",
    state: "ACTIVE",
    connectionScope: {
      accountRef: "acct-cert-1",
      tenantRef: TENANT_REF,
      countries: ["DE", "FR", "US"],
      currencies: ["EUR", "USD"],
      grantedPermissions: ["payments:read"],
      missingPermissions: [],
      credentialRef: "cred-cert-1",
      credentialKind: "API_KEY",
      eligibilityReasons: [],
    },
    authorizationRef: "authz:cert-conn-001",
    transferOut: {
      grantedAt: CERT_EPOCH_ISO,
      expiresAt: "2026-12-31T00:00:00Z",
      authorizationRef: "authz:cert-transfer-out-001",
      currencyScope: ["EUR", "USD"],
      maxSingleAmountMinor: 100_000_000,
      requiresProviderStepUp: false,
    },
    history: [],
  };
}

export function merchantBankEuroDestination(): MerchantSettlementDestination {
  return defineSettlementDestination({
    id: "dest:cert:merchant-bank-eur",
    kind: "BANK_ACCOUNT",
    currency: EUR,
    externalRef: MERCHANT_BANK_IBAN,
    provenance: {
      source: "merchant-onboarding",
      reference: "cert-onb-1",
      recordedAt: BigInt(CERT_NOW),
    },
  });
}

/** Exact minor-unit→minor-unit conversion groundings (peg declarations). */
export function certConversionRules(): readonly FiatConversionRule[] {
  return [
    {
      ruleId: "peg:cert:usc-eur",
      fromCurrency: "USC",
      toCurrency: "EUR",
      rate: { numerator: "92", denominator: "1000000" },
      declaredBy: "peg:issuer-eur-peg",
    },
    {
      ruleId: "peg:cert:usc-usd",
      fromCurrency: "USC",
      toCurrency: "USD",
      rate: { numerator: "1", denominator: "10000" },
      declaredBy: "peg:issuer-usd-peg",
    },
    {
      ruleId: "peg:cert:eth-eur",
      fromCurrency: "ETH",
      toCurrency: "EUR",
      rate: { numerator: "276", denominator: "1000000000000000" },
      declaredBy: "peg:eth-eur-reference",
    },
    {
      ruleId: "peg:cert:eth-usd",
      fromCurrency: "ETH",
      toCurrency: "USD",
      rate: { numerator: "3", denominator: "10000000000000" },
      declaredBy: "peg:eth-usd-reference",
    },
  ];
}

export function certRoutingHints(): RoutingHints {
  return {
    originExecutionAsset: USC_ASSET,
    destinationExecutionAsset: USC_ASSET,
    intermediateStablecoin: USC_ASSET,
    bridgeDepositAsset: USC_ASSET,
    bridgeContractAddress: "0x7777777777777777777777777777777777777777",
    offRampDeposit: {
      providerName: OFFRAMP_PROVIDER,
      chainKey: CHAIN,
      accountRef: OFFRAMP_DEPOSIT_ADDRESS,
    },
    onrampDeliveryAddress: "0x8888888888888888888888888888888888888888",
    offRampPayoutCapabilityId: "psp.payouts",
  };
}

// ---------------------------------------------------------------------------
// Merchant-side fixtures (Journey D/E — €100)
// ---------------------------------------------------------------------------

/** The merchant cart: €100.00 (10_000 EUR minor units). */
export const MERCHANT_CART_EUR: Money = fromMinorUnits(EUR, 10_000n);

/** €100.00 in USC at the 1:10_000 peg (exact bigint cross-multiplication). */
export const QUOTED_USC_FOR_EUR100: CryptoAmount = defineCryptoAmount(
  USC_CRYPTO_ASSET,
  100_000_000n,
);

export function euroFixtureQuote(): CryptoQuote {
  return defineCryptoQuote({
    id: "quote:cert:eur100",
    assetId: USC_CRYPTO_ASSET.id,
    chainId: CHAIN,
    fiatAmount: MERCHANT_CART_EUR,
    cryptoAmount: QUOTED_USC_FOR_EUR100,
    ratio: { numerator: 1n, denominator: 10_000n },
    fees: fromMinorUnits(EUR, 148n),
    quotedAt: BigInt(CERT_NOW),
    validUntil: BigInt(CERT_QUOTE_VALID_UNTIL),
    sourceRef: "fixture:cert:quote-source",
  });
}

export function merchantCryptoPolicyInput() {
  return {
    id: "mcap:cert:1",
    merchantRef: "merchant:cert:1",
    basePolicyId: "pap:cert:1",
    assets: [
      defineCryptoAssetAcceptance({
        assetId: USC_CRYPTO_ASSET.id,
        chains: [CHAIN],
        minAmount: defineCryptoAmount(USC_CRYPTO_ASSET, 100n),
        maxAmount: defineCryptoAmount(USC_CRYPTO_ASSET, 1_000_000_000n),
        requiredConfirmations: 2n,
      }),
    ],
    quoteValidityMs: 30_000n,
  };
}

/** The Stripe connected instance for the merchant journeys (rule-18 seam). */
export function stripeConnectedInstance(
  overrides?: {
    readonly status?: "ACTIVE" | "PENDING" | "REVOKED" | "EXPIRED" | "UNKNOWN";
    readonly eligible?: boolean;
    readonly currencies?: readonly string[];
  },
): ConnectedCapabilityInstance {
  return {
    instanceId: "inst:cert:stripe:1",
    capabilityId: "cap.merchant-crypto.stripe.native-crypto-settlement",
    implementationId: "impl:cert:stripe:1",
    providerName: "stripe",
    providerVersion: "1.0.0",
    accountRef: STRIPE_ACCOUNT_REF,
    tenantRef: TENANT_REF,
    authorization: { status: overrides?.status ?? "ACTIVE" },
    credentialScope: { credentialRef: "cred-ref-cert-1", credentialKind: "API_KEY" },
    geography: { countries: ["DE", "US"] },
    currencies: overrides?.currencies ?? ["EUR"],
    permissionState: { granted: ["connectors:stripe:crypto-payments"], requested: [], missing: [] },
    eligibility: {
      eligible: overrides?.eligible ?? true,
      reasons: overrides?.eligible === false ? ["certification-fixture-ineligible"] : [],
    },
    configuration: {},
  };
}

/** Timestamp convenience (bigint TimestampMs — the merchant-plane clock). */
export function certTimestamp(ms: number): TimestampMs {
  return BigInt(ms);
}

// ---------------------------------------------------------------------------
// The composed route-compiler input (the A/C/E journey entry point)
// ---------------------------------------------------------------------------

/**
 * The full compiler input over the certification fixtures — the SAME
 * composition shape the route-compiler's own journey tests use (venues,
 * security, instances, asset observations, fiat definitions/instances/
 * observations/activations, destinations, conversion rules, hints).
 */
export function certCompilerInput(
  intent: MoneyMovementIntent,
  overrides?: Partial<RouteCompilerInput>,
): RouteCompilerInput {
  const nativeRouting = makeNativeRoutingDefinition();
  const payoutDefinition = makeComposedPayoutDefinition();
  const nativeInstance = makeFiatInstance({
    instanceId: "instance:cert:native-routing:1",
    capabilityId: nativeRouting.capabilityId,
  });
  const payoutInstance = makeFiatInstance({
    instanceId: "instance:cert:psp-payouts:1",
    capabilityId: payoutDefinition.capabilityId,
  });
  return {
    intent,
    at: CERT_NOW,
    venuePacks: [...certVenuePacks()],
    bestExecutionPolicy: certBestExecutionPolicy(),
    onchainSecurity: {
      policy: certSecurityPolicy(),
      state: certSecurityState(),
    },
    onchainInstances: [...certProtocolInstances()],
    assetObservations: [uscWalletObservation(), ethWalletObservation()],
    fiatDefinitions: [nativeRouting, payoutDefinition],
    fiatInstances: [nativeInstance, payoutInstance],
    fiatObservations: [
      makeFiatObservation({ instanceId: nativeInstance.instanceId }),
      makeFiatObservation({ instanceId: payoutInstance.instanceId }),
    ],
    fiatObservationMaxAgeSeconds: 3600,
    fiatActivations: [makePayoutActivation({ instanceId: payoutInstance.instanceId })],
    settlementDestinations: [merchantBankEuroDestination()],
    conversionRules: certConversionRules(),
    stripeEligibilityEvidence: [],
    opportunityObservations: [],
    routingHints: certRoutingHints(),
    ...overrides,
  };
}

/** Compile with the certification fixtures (the real compiler, verbatim). */
export function compileCertRoute(
  intent: MoneyMovementIntent,
  overrides?: Partial<RouteCompilerInput>,
): RouteCompilationResult {
  return compileMoneyMovementRoute(certCompilerInput(intent, overrides));
}

/** The onchain finality models for the certification chains (walk input). */
export const CERT_FINALITY_MODES: Readonly<Record<string, "PROBABILISTIC" | "DETERMINISTIC" | "INSTANT" | "HYBRID">> = {
  [CHAIN]: "PROBABILISTIC",
};

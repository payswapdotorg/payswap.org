/**
 * Shared deterministic fixtures for the @payswap/mixed-rail test suite
 * (Work Order P4-W3-001). Every identifier, timestamp and amount is a fixed
 * constant — no clock, no randomness. Addresses are obviously synthetic.
 *
 * The fixtures deliberately reuse the SAME shapes as the kernel test
 * suites (best-execution venue port fixtures, onchain-domain instance and
 * asset-observation fixtures, onchain-venues policy fixtures) so the
 * mixed-rail tests compose the REAL kernel machinery, not lookalikes.
 */

import { registerCurrency } from "@payswap/protocol";
import type { VersionedRef, AgentBody, AgentPrincipalRef } from "@payswap/agents";
import type {
  CertificationRecord,
  CapabilityState,
  ServiceAccessCapability,
  SmartContractExtension,
  SourceAvailability,
} from "@payswap/capabilities";
import type {
  CapabilityDefinition,
  CapabilityObservation,
  ConnectedCapabilityInstance,
  ObserveCapabilityInput,
  ProviderCatalogueEntry,
} from "@payswap/connectors";
import { observeCapability } from "@payswap/connectors";
import { canonicalAssetRef, protocolCapabilityId } from "@payswap/onchain-domain";
import type { AssetObservation, ConnectedProtocolInstance } from "@payswap/onchain-domain";
import type {
  BestExecutionPolicy,
  ExecutionVenue,
  HealthObservation,
  QuoteFreshness,
  QuoteObserver,
  QuoteProvenance,
  SwapRequest,
  VenueDescriptor,
  VenueQuote,
  VenueQuoteOutcome,
  VenueWritePlanningInput,
} from "@payswap/best-execution";
import type {
  AssetIdentity,
  OnchainSecurityPolicy,
  OnchainSecurityState,
  OnchainWriteRequest,
} from "@payswap/onchain-security";
import type { SimulatedWorld, SimulationScenarioPlan, ExecutableBlock } from "@payswap/lab";
import { buildLabSearchIndex, selectExecutableBlocks } from "@payswap/lab";
import { BestExecutionEngine } from "@payswap/best-execution";
import { discoverOnchainLane } from "../src/index.js";
import type { OnchainLaneProof } from "../src/index.js";

// Currency registration (the protocol money law; AmountSpec → Money needs it).
registerCurrency("USC", 6);
registerCurrency("ETH", 8);

// ---------------------------------------------------------------------------
// Deterministic constants
// ---------------------------------------------------------------------------

export const CHAIN = "ethereum:mainnet" as const;
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
export const OWNER = "0x1111111111111111111111111111111111111111";
export const BENEFICIARY = "0x2222222222222222222222222222222222222222";
export const TENANT_REF = "tenant:mixed-rail";

/** The simulated DEX venue identity (obviously synthetic). */
export const SIM_VENUE_ID = "lab-sim-dex" as const;
export const SIM_PROTOCOL_KEY = "lab-sim-dex" as const;
export const SIM_ROUTER_ADDRESS = "0x3333333333333333333333333333333333333333";
export const SIM_QUOTE_MAX_AGE_MS = 10_000;

// ---------------------------------------------------------------------------
// Kernel-side policy fixtures (the onchain-venues fixture shapes)
// ---------------------------------------------------------------------------

export function baseSecurityPolicy(
  overrides?: Partial<OnchainSecurityPolicy>,
): OnchainSecurityPolicy {
  return {
    policyId: "security-policy-mixed-rail",
    version: 1,
    allowedChains: [CHAIN],
    allowedAssets: [USC_ASSET, ETH_ASSET],
    allowedSpenders: [SIM_ROUTER_ADDRESS],
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

export function baseBestExecutionPolicy(
  overrides?: Partial<BestExecutionPolicy>,
): BestExecutionPolicy {
  return {
    policyId: "best-exec-policy-mixed-rail",
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

/** The canonical USC→ETH exact-input swap request (1 USC). */
export function uscToEthSwapRequest(): SwapRequest {
  return {
    requestId: "swap-request-mixed-rail-001",
    chain: CHAIN,
    inputAsset: USC_ASSET,
    outputAsset: ETH_ASSET,
    swapKind: "EXACT_INPUT",
    amount: { currency: "USC", minorUnits: "1000000" },
  };
}

// ---------------------------------------------------------------------------
// Smart-contract extension + protocol instance + asset observation fixtures
// ---------------------------------------------------------------------------

export function simRouterSmartContractExtension(): SmartContractExtension {
  return {
    kind: "smart_contract_extension",
    chainRef: CHAIN,
    contractAddress: SIM_ROUTER_ADDRESS,
    sourceHash: "sha256:lab-sim-source",
    bytecodeHash: "sha256:lab-sim-bytecode",
    upgradeAuthority: { kind: "IMMUTABLE", description: "no upgrade path (lab fixture)" },
    adminAuthority: { kind: "MULTISIG", description: "lab fixture operations multisig" },
    pausePowers: [{ actor: "lab-fixture-operations", scope: "all lanes" }],
    oracleDependencies: [],
    custody: {
      custodial: false,
      withdrawalAuthority: "none — non-custodial lab fixture",
      keyManagement: "lab fixture: none",
    },
    searchableByLabAfterCertification: true,
  };
}

/** The connected protocol instance for the simulated DEX venue (layer 3). */
export function simProtocolInstance(input?: {
  readonly authorizationStatus?: ConnectedCapabilityInstance["authorization"]["status"];
  readonly eligible?: boolean;
}): ConnectedProtocolInstance {
  const base: ConnectedCapabilityInstance = {
    instanceId: `instance:${SIM_PROTOCOL_KEY}:001`,
    capabilityId: protocolCapabilityId(SIM_PROTOCOL_KEY, CHAIN),
    implementationId: `impl:${SIM_PROTOCOL_KEY}:lab-sim`,
    providerName: "mixed-rail-fixture",
    providerVersion: "1.0.0",
    accountRef: OWNER,
    tenantRef: TENANT_REF,
    authorization: {
      status: input?.authorizationStatus ?? "ACTIVE",
      grantedAt: NOW_ISO,
      authorizationRef: "authz:lab-sim-001",
    },
    credentialScope: {
      credentialRef: "cred:lab-sim-001",
      credentialKind: "API_KEY",
    },
    geography: { countries: ["US"] },
    currencies: ["USD"],
    permissionState: {
      granted: ["onchain:write"],
      requested: ["onchain:write"],
      missing: [],
    },
    eligibility: {
      eligible: input?.eligible ?? true,
      reasons: [],
    },
    configuration: { endpointKind: "lab-simulated" },
  };
  return {
    ...base,
    protocolKey: SIM_PROTOCOL_KEY,
    chainKey: CHAIN,
  };
}

/** A canonical, fresh USC asset observation of the OWNER position. */
export function uscAssetObservation(input?: {
  readonly asOf?: string;
  readonly observationId?: string;
}): AssetObservation {
  return {
    observationKind: "AssetObservation",
    observationId: input?.observationId ?? "lab-obs:usc:owner:1",
    observedAt: NOW_ISO,
    assetId: canonicalAssetRef(CHAIN, "USC"),
    chainKey: CHAIN,
    location: {
      chainKey: CHAIN,
      accountRef: OWNER,
    },
    observedAmount: {
      currency: canonicalAssetRef(CHAIN, "USC"),
      minorUnits: "1000000000",
    },
    freshness: {
      asOf: input?.asOf ?? NOW_ISO,
      maxAgeSeconds: 60,
    },
    provenance: {
      providerName: "mixed-rail-observer",
      source: "INTERNAL",
      capturedAt: NOW_ISO,
    },
    observer: {
      observerId: "observer:lab-sim-node-001",
      observerKind: "CHAIN_NODE",
    },
  };
}

// ---------------------------------------------------------------------------
// The simulated DEX venue — a REAL ExecutionVenue-port implementation
// ---------------------------------------------------------------------------

export interface LabSimVenueOptions {
  /** Script the quote stage: honest unreachable (OUTCOME_UNKNOWN). */
  readonly quoteOutcome?: "QUOTE" | "OUTCOME_UNKNOWN";
  /** Declare a provider-native benchmark baseline (INV-C08 incumbent). */
  readonly nativeBaseline?: boolean;
}

function simQuoteFreshness(at: number): QuoteFreshness {
  return { asOfMs: at, maxAgeMs: SIM_QUOTE_MAX_AGE_MS };
}

function simQuoteProvenance(quoteId: string, at: number): QuoteProvenance {
  return {
    providerName: "mixed-rail-fixture-venue",
    source: "INTERNAL",
    capturedAtMs: at,
    evidenceRefs: [`evidence:lab-sim-quote:${quoteId}`],
  };
}

function simQuoteObserver(): QuoteObserver {
  return { observerId: "observer:lab-sim-venue", observerKind: "OTHER" };
}

function simVenueHealth(at: number): HealthObservation {
  return {
    status: "HEALTHY",
    observedAtMs: at,
    maxAgeMs: 30_000,
    provenance: {
      providerName: "mixed-rail-fixture-venue",
      source: "OPERATOR",
      capturedAtMs: at,
      evidenceRefs: ["evidence:lab-sim-health"],
    },
  };
}

/**
 * Builds the simulated DEX venue: a genuine implementation of the neutral
 * ExecutionVenue port (deterministic quote/health/planWrite; no simulate —
 * the venue declares no simulation support, so the engine's gate stage runs
 * without a venue simulation for this venue).
 */
export function createLabSimVenue(options?: LabSimVenueOptions): ExecutionVenue {
  const descriptor: VenueDescriptor = {
    venueId: SIM_VENUE_ID,
    displayName: "Lab Simulated DEX (fixture)",
    chains: [CHAIN],
    swapKinds: ["EXACT_INPUT"],
    quoteSemantics: "EXECUTABLE",
    slippageProtection: "DECLARED_LIMIT",
    supportsSimulation: false,
    ...(options?.nativeBaseline === true
      ? {
          nativeOptimization: {
            optimizationKind: "LAB_SIM_NATIVE_ROUTING",
            benchmarkBaseline: true,
            description:
              "the simulated venue's own router-native routing (incumbent baseline, INV-C08)",
          },
        }
      : {}),
  };

  const venue: ExecutionVenue = {
    descriptor,
    protocol: { protocolKey: SIM_PROTOCOL_KEY, chainKey: CHAIN },
    quote(request: SwapRequest, at: number): VenueQuoteOutcome {
      if (options?.quoteOutcome === "OUTCOME_UNKNOWN") {
        return {
          kind: "OUTCOME_UNKNOWN",
          reason:
            "simulated chain unreachable: the venue could not determine a quote — never a fabricated one (INV-X01)",
        };
      }
      if (request.chain !== CHAIN) {
        return {
          kind: "UNAVAILABLE",
          reason: "the simulated venue serves one chain only",
        };
      }
      if (request.inputAsset.assetId !== USC_ASSET.assetId) {
        return {
          kind: "UNAVAILABLE",
          reason: "no simulated pool for this input asset",
        };
      }
      const quoteId = `lab-sim-quote:${request.requestId}:1`;
      const quote: VenueQuote = {
        quoteId,
        venueId: SIM_VENUE_ID,
        requestId: request.requestId,
        chain: CHAIN,
        swapKind: "EXACT_INPUT",
        inputAsset: request.inputAsset,
        outputAsset: request.outputAsset,
        inputAmount: request.amount,
        quoteSemantics: "EXECUTABLE",
        fees: [
          {
            feeKind: "VENUE_FEE",
            amount: { asset: request.inputAsset, minorUnits: "3000" },
            description: "fixed simulated venue fee in the input asset",
          },
        ],
        gasCost: {
          gasUnits: "160000",
          pricePerUnitNativeMinor: { numerator: "3", denominator: "1000000000" },
          feeAsset: ETH_ASSET,
        },
        slippage: {
          protection: "DECLARED_LIMIT",
          worstCaseOutput: {
            currency: request.outputAsset.symbol,
            minorUnits: "3296703",
          },
          limitBasisPoints: 50,
          expectedOutput: {
            currency: request.outputAsset.symbol,
            minorUnits: "3300000",
          },
        },
        failureRisk: {
          riskClass: "LOW",
          retryPolicy: "SAFE_TO_RETRY",
          description: "simulated venue with deterministic failure behavior",
        },
        timeToSettlement: {
          estimatedMs: 120_000,
          finalityModel: "PROBABILISTIC",
          description: "simulated probabilistic settlement",
        },
        routeShape: [
          {
            venue: SIM_VENUE_ID,
            chain: CHAIN,
            protocolId: SIM_PROTOCOL_KEY,
            description: "direct simulated pool swap",
          },
        ],
        optimizationOrigin: "PROVIDER_NATIVE",
        freshness: simQuoteFreshness(at),
        provenance: simQuoteProvenance(quoteId, at),
        observer: simQuoteObserver(),
      };
      return { kind: "QUOTE", quote };
    },
    observeHealth(at: number): HealthObservation {
      return simVenueHealth(at);
    },
    planWrite(input: VenueWritePlanningInput): OnchainWriteRequest {
      return {
        writeId: `write:lab-sim:${input.quote.quoteId}`,
        action: "onchain.swap",
        chain: CHAIN,
        approvals: [
          {
            asset: input.quote.inputAsset,
            owner: input.owner,
            spender: SIM_ROUTER_ADDRESS,
            amount: input.quote.inputAmount,
            unlimited: false,
          },
        ],
        contractCall: {
          target: SIM_ROUTER_ADDRESS,
          calldata: `0x-lab-sim-swap:${input.quote.quoteId}`,
          calldataDigest: `sha256:lab-sim-calldata:${input.quote.quoteId}`,
        },
        route: {
          routeId: input.routeRef,
          routeHash: input.routeHash,
          hops: [
            {
              venue: SIM_VENUE_ID,
              chain: CHAIN,
              protocolId: SIM_PROTOCOL_KEY,
            },
          ],
        },
        protocol: {
          protocolId: SIM_PROTOCOL_KEY,
          version: "1.0.0",
          contract: simRouterSmartContractExtension(),
        },
        expiry: input.expiryMs,
        requestedBy: input.requestedBy,
      };
    },
  };
  return Object.freeze(venue);
}

// ---------------------------------------------------------------------------
// Fiat-side fixtures (the Reality Engineering Lab fixture shapes)
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
  simulatedRailId: string;
  currencies?: readonly string[];
  authorizationStatus?: ConnectedCapabilityInstance["authorization"]["status"];
  eligible?: boolean;
}): ConnectedCapabilityInstance {
  return {
    instanceId: input.instanceId,
    capabilityId: input.capabilityId,
    implementationId: `${input.capabilityId}:impl:1`,
    providerName: "psp-mock",
    providerVersion: "2024-01",
    accountRef: "acct-123",
    tenantRef: "tenant-1",
    authorization: {
      status: input.authorizationStatus ?? "ACTIVE",
      grantedAt: "2026-01-01T00:00:00Z",
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
    configuration: { simulatedRailId: input.simulatedRailId },
  };
}

export function makeFiatObservation(input: {
  instanceId: string;
  observationVersion?: number;
  capabilityState?: CapabilityState;
  sourceAvailability?: SourceAvailability;
}): CapabilityObservation {
  return observeCapability({
    instanceId: input.instanceId,
    observedAt: "2026-10-01T00:00:00Z",
    observationVersion: input.observationVersion ?? 1,
    capabilityState: input.capabilityState ?? "AVAILABLE",
    sourceAvailability: input.sourceAvailability ?? "REACHABLE",
    eligibility: "ELIGIBLE",
    health: { status: "HEALTHY", lastCheckedAt: "2026-10-01T00:00:00Z" },
    provenance: {
      providerName: "psp-mock",
      source: "PROVIDER_API",
      capturedAt: "2026-10-01T00:00:00Z",
    },
  } satisfies ObserveCapabilityInput);
}

export function makeCatalogueEntry(input: {
  capabilityId: string;
}): ProviderCatalogueEntry {
  return {
    catalogueEntryId: `cat-${input.capabilityId}`,
    providerName: "psp-mock",
    providerVersion: "2024-01",
    capabilityId: input.capabilityId,
    summary: "advertised platform-wide capability",
    advertisedScope: {
      platformWide: true,
      advertisedGeographies: ["DE", "FR", "US"],
      advertisedCurrencies: ["EUR", "USD"],
    },
  };
}

export function makeCertification(input: {
  subjectId: string;
  version?: string;
  status?: CertificationRecord["status"];
}): CertificationRecord {
  return {
    recordId: `cert-${input.subjectId}`,
    subject: {
      kind: "capability",
      subjectId: input.subjectId,
      version: input.version ?? "1.0.0",
    },
    status: input.status ?? "CERTIFIED",
    evidence: [
      {
        evidenceId: `ev-${input.subjectId}-1`,
        kind: "TEST_RUN",
        artifactRef: "artifacts/test-run-1",
        contentHash: "hash-1",
      },
    ],
    certifiedAt: "2026-09-01T00:00:00Z",
  };
}

/** A searchable smart-contract extension for onchain block registration. */
export function makeOnchainSmartContractExtension(): SmartContractExtension {
  return simRouterSmartContractExtension();
}

export function makeServiceAccessCapability(input?: {
  id?: string;
}): ServiceAccessCapability {
  const id = input?.id ?? "svc.fraud-scoring";
  return {
    id,
    capabilityClass: "developer_service",
    conditions: [
      {
        kind: "eligibility",
        description: "tenant onboarded",
        hardConstraint: true,
      },
    ],
    cost: [{ componentId: "usage-fee", kind: "per_use_fee", bps: 0n }],
    risk: {
      riskClass: "operational",
      severity: "low",
      mitigations: [],
    },
    provenance: {
      declaredBy: "mixed-rail-fixture",
      artifactRef: "artifacts/mixed-rail-fixture",
      contentHash: "hash-fixture",
    },
    economicAccountability: {
      accountablePartyRef: "party:ops",
      ledgerAccountRef: "ledger:ops",
      recoursePolicyRef: "policy:ops-recourse",
    },
    proofRequirements: [],
    serviceId: "fraud-scoring-v1",
    fundingCredential: {
      kind: "funding_credential",
      credentialRef: "cred-funding-1",
      credentialType: "budget",
    },
    serviceCredential: {
      kind: "service_credential",
      credentialRef: "cred-service-1",
      credentialType: "subscription",
    },
    subscriptionModel: "SUBSCRIPTION",
  };
}

// ---------------------------------------------------------------------------
// The fiat simulated world + scenario (the Lab fixture shapes, unchanged laws)
// ---------------------------------------------------------------------------

export function fiatWorld(): SimulatedWorld {
  return {
    worldId: "mixed-rail:world-1",
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
    scenarioId: "mixed-rail:scenario-1",
    description: "two outbound demands, one provider outage on rail-b",
    demands: [
      {
        demandId: "d-1",
        atStep: 0,
        amountMinor: 100_000n,
        currency: "EUR",
        direction: "OUTBOUND",
        deadlineMs: 5_000,
      },
      {
        demandId: "d-2",
        atStep: 1,
        amountMinor: 50_000n,
        currency: "EUR",
        direction: "OUTBOUND",
        deadlineMs: 6_000,
      },
    ],
    incidents: [
      { incidentType: "PROVIDER_OUTAGE", atStep: 2, railId: "rail-b" },
    ],
  };
}

// ---------------------------------------------------------------------------
// Agent fixtures (candidate composition inputs)
// ---------------------------------------------------------------------------

export const CANDIDATE_BODY_REF: VersionedRef<AgentBody> = {
  id: "body.mixed-rail-agent",
  version: 1,
};

export const CANDIDATE_PRINCIPAL: AgentPrincipalRef = {
  agentKeyFingerprint: "sha256:labmixedrailfingerprint",
  ownerRef: "owner-1",
};

// ---------------------------------------------------------------------------
// Shared composition inputs: executable fiat blocks + a proved onchain lane
// ---------------------------------------------------------------------------

/**
 * The executable fiat blocks for the incumbent native routing capability
 * (rail-a) and the composed payout capability (rail-b), grounded through
 * the Lab's REAL search (instance + current observation, INV-C05).
 */
export function fiatExecutableBlocks(): ExecutableBlock[] {
  const nativeDefinition = makeNativeRoutingDefinition();
  const payoutDefinition = makeComposedPayoutDefinition();
  const nativeInstance = makeFiatInstance({
    instanceId: "instance:native-routing:1",
    capabilityId: nativeDefinition.capabilityId,
    simulatedRailId: "rail-a",
  });
  const payoutInstance = makeFiatInstance({
    instanceId: "instance:payouts:1",
    capabilityId: payoutDefinition.capabilityId,
    simulatedRailId: "rail-b",
  });
  const index = buildLabSearchIndex({
    definitions: [nativeDefinition, payoutDefinition],
    instances: [nativeInstance, payoutInstance],
    observations: [
      makeFiatObservation({ instanceId: nativeInstance.instanceId }),
      makeFiatObservation({ instanceId: payoutInstance.instanceId }),
    ],
  });
  const { executable } = selectExecutableBlocks(index, {
    domain: "payment-routing",
    currency: "EUR",
  });
  return [...executable];
}

/**
 * Proves one onchain lane through the REAL engine + the simulated venue
 * (the canonical happy-path fixture lane). Throws if the lane is not
 * proved — fixtures never fabricate.
 */
export function provedSimLane(input?: {
  readonly nativeBaseline?: boolean;
  readonly quoteOutcome?: "QUOTE" | "OUTCOME_UNKNOWN";
  readonly instance?: ConnectedProtocolInstance;
  readonly assetObservation?: AssetObservation;
  readonly at?: number;
}): OnchainLaneProof {
  const at = input?.at ?? NOW;
  const engine = new BestExecutionEngine();
  engine.register(
    createLabSimVenue({
      ...(input?.nativeBaseline !== undefined ? { nativeBaseline: input.nativeBaseline } : {}),
      ...(input?.quoteOutcome !== undefined ? { quoteOutcome: input.quoteOutcome } : {}),
    }),
  );
  const result = discoverOnchainLane({
    engine,
    executionId: "mixed-rail-test-001",
    swap: uscToEthSwapRequest(),
    policy: baseBestExecutionPolicy(),
    security: { policy: baseSecurityPolicy(), state: baseSecurityState() },
    instances: [input?.instance ?? simProtocolInstance()],
    assetObservations: [input?.assetObservation ?? uscAssetObservation()],
    owner: OWNER,
    beneficiary: BENEFICIARY,
    requestedBy: "agent:mixed-rail-test",
    routeExpiryMs: at + 300_000,
    at,
  });
  if (result.status !== "LANE_PROVED") {
    throw new Error(
      `fixture lane was not proved: status '${result.status}' (${"detail" in result ? result.detail : "no detail"})`,
    );
  }
  return result.lane;
}

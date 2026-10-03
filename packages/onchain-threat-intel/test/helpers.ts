import type { SmartContractExtension } from "@payswap/capabilities";
import { registerCurrency } from "@payswap/protocol";
import {
  evaluateOnchainWriteGates,
  prepareWrite,
  recordSimulation,
} from "@payswap/onchain-security";
import type {
  OnchainSecurityPolicy,
  OnchainSecurityState,
  OnchainWriteRequest,
  SimulationObservation,
} from "@payswap/onchain-security";
import type { OnchainThreatPolicy } from "../src/index.js";
import type { OnchainThreatObservationBundle } from "../src/index.js";
import { recordObservationBundle } from "../src/index.js";

/**
 * Shared deterministic fixtures (synthetic — no real secrets, no real
 * chain claims, obviously-fake addresses). Currency registrations follow
 * the protocol money law (3-letter codes).
 */

registerCurrency("USC", 6);
registerCurrency("ETH", 8);

export const CHAIN = "ethereum:mainnet";
export const OTHER_CHAIN = "polygon:mainnet";
export const USC_ASSET = {
  chain: CHAIN,
  assetId: "0xaaaa111111111111111111111111111111111111",
  symbol: "USC",
} as const;
/** A DIFFERENT asset that shares the USC symbol (impersonation fixture). */
export const FAKE_USC_ASSET = {
  chain: CHAIN,
  assetId: "0xbbbb999999999999999999999999999999999999",
  symbol: "USC",
} as const;
export const PAYER = "0x1111111111111111111111111111111111111111";
export const MERCHANT = "0x2222222222222222222222222222222222222222";
export const ROUTER = "0x3333333333333333333333333333333333333333";
export const MALICIOUS_SPENDER = "0x4444444444444444444444444444444444444444";
export const UNKNOWN_TARGET = "0x5555555555555555555555555555555555555555";
export const NOW = 1_766_300_000_000;
export const ROUTE_HASH = "fnv1a64:0000000000000001";

export const AGENT_REF = "agent:threat-intel-1";

export function contractExtension(
  overrides?: Partial<SmartContractExtension>,
): SmartContractExtension {
  return {
    kind: "smart_contract_extension",
    chainRef: CHAIN,
    contractAddress: ROUTER,
    sourceHash: "src-hash-1",
    bytecodeHash: "byte-hash-1",
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
    protocolId: "uniswap:v3",
    version: "1.0.0",
    contract: contractExtension(),
  };
}

export function baseWriteRequest(
  overrides?: Partial<OnchainWriteRequest>,
): OnchainWriteRequest {
  return {
    writeId: "write-1",
    action: "onchain.transfer",
    chain: CHAIN,
    transfer: {
      asset: USC_ASSET,
      amount: { currency: "USC", minorUnits: "1000000" },
      from: PAYER,
      to: MERCHANT,
    },
    approvals: [],
    route: { routeId: "route-1", routeHash: ROUTE_HASH },
    expiry: NOW + 60_000,
    requestedBy: AGENT_REF,
    ...overrides,
  };
}

export function preparedWrite(overrides?: Partial<OnchainWriteRequest>) {
  return prepareWrite(baseWriteRequest(overrides), NOW);
}

/** A canonical (allowlisted) approval request shape. */
export function canonicalApproval(overrides?: {
  spender?: string;
  minorUnits?: string;
  unlimited?: boolean;
  asset?: typeof USC_ASSET;
}) {
  return {
    asset: overrides?.asset ?? USC_ASSET,
    owner: PAYER,
    spender: overrides?.spender ?? ROUTER,
    amount: { currency: "USC", minorUnits: overrides?.minorUnits ?? "1000000" },
    unlimited: overrides?.unlimited ?? false,
  };
}

export function baseKernelPolicy(
  overrides?: Partial<OnchainSecurityPolicy>,
): OnchainSecurityPolicy {
  return {
    policyId: "kernel-policy-1",
    version: 1,
    allowedChains: [CHAIN],
    allowedAssets: [USC_ASSET],
    allowedDestinations: [MERCHANT],
    allowedSpenders: [ROUTER],
    maxApprovalAmount: { currency: "USC", minorUnits: "5000000" },
    forbidUnlimitedApprovals: true,
    knownRoutes: [ROUTE_HASH],
    certifiedProtocols: [protocolIdentity()],
    unknownContractPolicy: "block",
    unknownRoutePolicy: "block",
    maxSecurityStateAgeMs: 5_000,
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

export function baseThreatPolicy(
  overrides?: Partial<OnchainThreatPolicy>,
): OnchainThreatPolicy {
  return {
    policyId: "threat-policy-1",
    version: 1,
    forbidUnlimitedApprovals: true,
    maxApprovalAmount: { currency: "USC", minorUnits: "5000000" },
    allowedSpenders: [ROUTER],
    spenderMinimumAgeMs: 3_600_000,
    spenderIncidentThreshold: 3,
    requireTokenRegistryCoverage: true,
    certifiedProtocols: [protocolIdentity()],
    maxOracleDeviationBasisPoints: 50,
    maxOracleFeedAgeMs: 90_000,
    requireBridgeHealthForBridgeHops: true,
    bridgeValidatorChangeWindowMs: 86_400_000,
    minBridgeAttestationQuorum: "2/3",
    maxSlippageBasisPoints: 300,
    sandwichSensitiveSlippageBasisPoints: 200,
    maxPriceImpactBasisPoints: 500,
    expectedChain: CHAIN,
    maxSimulationAgeMs: 30_000,
    maxSimulationLagBlocks: 6,
    maxReorgDepthBlocks: 2,
    maxFinalityLagBlocks: 12,
    maxObservationAgeMs: 10_000,
    ...overrides,
  };
}

/**
 * A benign observation bundle: everything healthy, everything observed.
 * Individual tests override single sections to build the malicious
 * fixtures (the corpus pattern).
 */
export function benignBundleInput() {
  return {
    bundleId: "bundle-1",
    observer: "observer:chain-intel-1",
    observedAt: NOW,
    spenders: [
      {
        observationId: "spender-intel:router",
        spender: ROUTER,
        knownDrainPattern: false,
        firstObservedAt: NOW - 90 * 86_400_000,
        observedIncidents: 0,
        sources: ["intel:internal"],
      },
    ],
    tokens: [
      {
        observationId: "token-registry:usc",
        asset: USC_ASSET,
        canonical: true,
      },
    ],
    oracles: [
      {
        observationId: "oracle:usd-1",
        oracleId: "oracle:primary-usc",
        pair: "USC/USD",
        observedPrice: "1000000/1000000",
        priceUpdatedAt: NOW - 1_000,
        feedAgeMs: 1_000,
      },
      {
        observationId: "oracle:usd-2",
        oracleId: "oracle:secondary-usc",
        pair: "USC/USD",
        observedPrice: "1000100/1000000",
        priceUpdatedAt: NOW - 1_000,
        feedAgeMs: 1_000,
      },
    ],
    bridges: [
      {
        observationId: "bridge:main-1",
        bridgeId: "bridge:canonical-bridge",
        status: "healthy" as const,
        attestationQuorum: "9/10",
        observedAt: NOW - 2_000,
      },
    ],
    finality: {
      observationId: "finality:main",
      chain: CHAIN,
      headBlock: 1_000,
      safeBlock: 995,
      lastReorgDepthBlocks: 0,
      observedAt: NOW - 1_000,
    },
    mempool: {
      observationId: "mempool:main",
      chain: CHAIN,
      writeVisible: false,
      observedAt: NOW - 500,
    },
    domain: {
      observationId: "domain:write-1",
      payloadDigest: "fnv1a64:abcdef0123456789",
      domainRef: "domain:swap-router-v1",
      domainChain: CHAIN,
      digestPreviouslyObserved: false,
      observedAt: NOW - 500,
    },
    addresses: [
      {
        observationId: "address:merchant",
        address: MERCHANT,
        chainsActiveOn: [CHAIN],
        observedAt: NOW - 60_000,
      },
    ],
  };
}

export function benignBundle(): OnchainThreatObservationBundle {
  return recordObservationBundle(benignBundleInput());
}

/** A consistent, fresh, passing simulation for the base write. */
export function consistentSimulation(
  writeId: string,
  overrides?: Partial<SimulationObservation>,
): SimulationObservation {
  return recordSimulation({
    simulationId: "sim-1",
    writeId,
    status: "SUCCEEDED",
    observedAt: NOW,
    blockRef: "block:998",
    balanceDeltas: [
      {
        holder: PAYER,
        asset: USC_ASSET,
        amount: { currency: "USC", minorUnits: "1000000" },
        direction: "debit",
      },
      {
        holder: MERCHANT,
        asset: USC_ASSET,
        amount: { currency: "USC", minorUnits: "1000000" },
        direction: "credit",
      },
    ],
    approvals: [],
    simulator: "simulator:local-deterministic",
    ...overrides,
  });
}

/** Evaluate the KERNEL gates for a write (the composition baseline). */
export function kernelGateDecision(
  write: ReturnType<typeof prepareWrite>,
  options?: {
    simulation?: SimulationObservation;
    policy?: OnchainSecurityPolicy;
    securityState?: OnchainSecurityState;
    at?: number;
  },
) {
  return evaluateOnchainWriteGates({
    write,
    ...(options?.simulation === undefined
      ? {}
      : { simulation: options.simulation }),
    policy: options?.policy ?? baseKernelPolicy(),
    securityState: options?.securityState ?? baseSecurityState(),
    at: options?.at ?? NOW,
  });
}

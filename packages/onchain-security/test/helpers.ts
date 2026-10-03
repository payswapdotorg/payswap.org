import { registerCurrency } from "@payswap/protocol";
import type { SmartContractExtension } from "@payswap/capabilities";
import type { Principal } from "@payswap/trust";
import {
  TrustedApprovalSurface,
} from "../src/index.js";
import type {
  OnchainSecurityPolicy,
  OnchainSecurityState,
  OnchainWriteRequest,
  TrustedSurfaceSigner,
} from "../src/index.js";

/**
 * Shared deterministic fixtures (synthetic — no real secrets, no real
 * chain claims). Currency registrations follow the protocol money law
 * (3-letter codes, digits 0-8).
 */

registerCurrency("USC", 6);
registerCurrency("ETH", 8);

export const CHAIN = "ethereum:mainnet";
export const USC_ASSET = { chain: CHAIN, assetId: "0xaaaa111111111111111111111111111111111111", symbol: "USC" } as const;
export const PAYER = "0x1111111111111111111111111111111111111111";
export const MERCHANT = "0x2222222222222222222222222222222222222222";
export const ROUTER = "0x3333333333333333333333333333333333333333";
export const MALICIOUS_SPENDER = "0x4444444444444444444444444444444444444444";
export const UNKNOWN_TARGET = "0x5555555555555555555555555555555555555555";
export const NOW = 1_000_000;
export const ROUTE_HASH = "fnv1a64:0000000000000001";

export function contractExtension(overrides?: Partial<SmartContractExtension>): SmartContractExtension {
  return {
    kind: "smart_contract_extension",
    chainRef: CHAIN,
    contractAddress: ROUTER,
    sourceHash: "src-hash-1",
    bytecodeHash: "byte-hash-1",
    upgradeAuthority: { kind: "MULTISIG", description: "dao multisig", delayOrTimelock: "48h timelock" },
    adminAuthority: { kind: "MULTISIG", description: "dao multisig" },
    pausePowers: [{ actor: "guardian", scope: "transfers" }],
    oracleDependencies: [],
    custody: { custodial: false, withdrawalAuthority: "owner-only", keyManagement: "non-custodial" },
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

export function baseWriteRequest(overrides?: Partial<OnchainWriteRequest>): OnchainWriteRequest {
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
    requestedBy: "agent:agent-key-1",
    ...overrides,
  };
}

export function basePolicy(overrides?: Partial<OnchainSecurityPolicy>): OnchainSecurityPolicy {
  return {
    policyId: "policy-1",
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

export function baseSecurityState(overrides?: Partial<OnchainSecurityState>): OnchainSecurityState {
  return {
    observedAt: NOW,
    networkEpoch: 0n,
    quarantinedComponents: [],
    restrictedComponents: [],
    activeAdvisoryRefs: [],
    ...overrides,
  };
}

export const AGENT_PRINCIPAL: Principal = {
  kind: "agent",
  agentKeyFingerprint: "agent-key-1",
  ownerRef: "user:alice",
  bodyRef: "body-1",
  packageVersionRef: "pkg-1@1.0.0",
  authorityEnvelope: [],
  securityEpoch: 0n,
};

/**
 * A deterministic trusted-surface signer double for the trusted surface
 * boundary. The signature is an opaque function of the payload — it is NOT
 * cryptography (real signing belongs to the trusted surface / W2-001); it
 * proves the ONLY minting path goes through a signer at the surface.
 */
export const TEST_SURFACE_SIGNER: TrustedSurfaceSigner = {
  surfaceId: "surface:checkout-1",
  signApprovalPayload(payload: string): string {
    let hash = 0;
    for (let i = 0; i < payload.length; i += 1) {
      hash = (hash * 31 + payload.charCodeAt(i)) | 0;
    }
    return `sig:${(hash >>> 0).toString(16).padStart(8, "0")}`;
  },
};

export function testSurface(): TrustedApprovalSurface {
  return new TrustedApprovalSurface(TEST_SURFACE_SIGNER);
}

import type { CapabilityDefinition } from "@payswap/connectors";
import type { ChainDefinition, ConnectedChainInstance } from "../src/chain.js";
import { chainCapabilityId } from "../src/chain.js";
import type { AssetDefinition, AssetObservation } from "../src/asset.js";
import { canonicalAssetRef } from "../src/asset.js";
import type { SignerHandle } from "../src/wallet.js";
import type { OnchainExecutionDirective } from "../src/execution.js";
import type { OnchainExecutionObservation } from "../src/execution.js";
import type { ProtocolDefinition } from "../src/onchain-protocol.js";
import { protocolCapabilityId } from "../src/onchain-protocol.js";
import { chainKey as ethKey } from "./chain-keys.js";

/**
 * Shared deterministic fixtures for the onchain-domain contract tests.
 * Everything here is VALID by construction; the tests mutate copies for
 * negative cases.
 */

export const ETHEREUM_CHAIN_KEY = ethKey;

/** A canonical, fully-declared §2A capability-definition base (READ kind). */
export function baseReadCapabilityDefinition(
  capabilityId: string,
): CapabilityDefinition {
  return {
    capabilityId,
    capabilityVersion: "1.0.0",
    summary: "Descriptive onchain catalogue capability (test fixture).",
    kind: "READ",
    requiredPermissions: [],
    executionModes: ["PASS_THROUGH_NATIVE", "COMPOSED_PAYSWAP", "OPTIMIZED_MULTI_PROVIDER"],
    semantics: {
      operation: "onchain.catalogue.observe",
      stateMachine: {
        documentRef: "spec/architecture/FROZEN-ARCHITECTURE.md",
        version: "1.6-frozen-2026-10-02",
      },
      description: "Observation surface of an onchain catalogue entity.",
    },
    preconditions: ["The entity is registered in the onchain catalogue."],
    authorization: {
      protocolAuthorization: true,
      requiredScopes: [],
      customerConsent: "NOT_REQUIRED",
    },
    sideEffects: [
      {
        effect: "Reads descriptive catalogue state (no external effect).",
        financialEffect: "NO_FINANCIAL_EFFECT",
        reversible: false,
      },
    ],
    idempotency: {
      idempotent: true,
      keyScope: "REQUEST",
      duplicateBehavior: "RETURNED_SAME_RESULT",
      retryPolicy: "SAFE_TO_RETRY",
    },
    compensation: {
      compensable: false,
      cancellation: "NOT_SUPPORTED",
      partialExecution: {
        possible: false,
        granularity: "ATOMIC",
        onPartial: "DISCLOSED",
      },
    },
    requiredCustomerActions: [],
    providerVocabulary: {
      actions: [],
      states: [],
    },
    externalObjects: [],
    evidence: {
      produced: ["STATE_OBSERVATION"],
      required: [],
    },
    economics: {
      feeModel: "NONE",
      limits: [],
      settlementImplications: "None: descriptive catalogue capability.",
    },
    constraints: [],
  };
}

/** An ACTION-flavored base for execution-flavored capabilities. */
export function baseActionCapabilityDefinition(
  capabilityId: string,
): CapabilityDefinition {
  return {
    ...baseReadCapabilityDefinition(capabilityId),
    kind: "ACTION",
    summary: "Executable onchain capability (test fixture).",
    semantics: {
      operation: "onchain.execute",
      stateMachine: {
        documentRef: "spec/architecture/PAYMENT-OPERATING-PLANE.md",
        version: "1",
      },
      description: "Executes a consequential onchain write through a connected instance.",
    },
    authorization: {
      protocolAuthorization: true,
      requiredScopes: ["onchain:write"],
      customerConsent: "EXPLICIT",
    },
    sideEffects: [
      {
        effect: "Moves value on an external chain.",
        financialEffect: "MOVES_VALUE",
        reversible: false,
      },
    ],
    idempotency: {
      idempotent: false,
      keyScope: "REQUEST",
      duplicateBehavior: "REJECTED",
      retryPolicy: "REQUIRES_RECONCILIATION",
    },
    evidence: {
      produced: ["EXECUTION", "STATE_OBSERVATION", "RECONCILIATION"],
      required: ["AUTHORIZATION"],
    },
    economics: {
      feeModel: "PROVIDER_SCHEDULE",
      limits: [],
      settlementImplications:
        "External onchain effect mapped into canonical settlement machinery as observations.",
    },
  };
}

/** A canonical Ethereum mainnet chain definition (with family extension). */
export function ethereumChainDefinition(): ChainDefinition {
  return {
    ...baseReadCapabilityDefinition(chainCapabilityId(ETHEREUM_CHAIN_KEY)),
    kind: "READ",
    chain: {
      chainKey: ETHEREUM_CHAIN_KEY,
      family: "EVM",
      displayName: "Ethereum Mainnet",
      nativeAssetRef: canonicalAssetRef(ETHEREUM_CHAIN_KEY, "ETH"),
      finality: {
        finalityModel: "PROBABILISTIC",
        reorgRisk: "PRESENT",
        confirmationGuidance: "Observer-defined confirmation depth; finality stays protocol-owned.",
      },
      familyExtension: {
        family: "EVM",
        evmChainId: "1",
        contractAddressFormat: "HEX_20_BYTE",
        feeModel: "GAS_AUCTION",
      },
    },
  };
}

/** A canonical non-EVM chain definition without any family extension. */
export function solanaChainDefinition(): ChainDefinition {
  return {
    ...baseReadCapabilityDefinition(chainCapabilityId("solana:mainnet-beta")),
    kind: "READ",
    chain: {
      chainKey: "solana:mainnet-beta",
      family: "SOLANA",
      displayName: "Solana Mainnet Beta",
      nativeAssetRef: canonicalAssetRef("solana:mainnet-beta", "SOL"),
      finality: {
        finalityModel: "PROBABILISTIC",
        reorgRisk: "PRESENT",
        confirmationGuidance: "Commitment-level guidance; finality stays protocol-owned.",
      },
    },
  };
}

/** The shared observation provenance used by observation fixtures. */
export function observationProvenance(): {
  readonly providerName: string;
  readonly source: "PROVIDER_API";
  readonly capturedAt: string;
} {
  return {
    providerName: "observer-connector",
    source: "PROVIDER_API",
    capturedAt: "2026-10-03T00:00:00Z",
  };
}

/** A canonical connected chain instance (the authorization scope). */
export function connectedChainInstance(
  chainKey: string = ETHEREUM_CHAIN_KEY,
): ConnectedChainInstance {
  return {
    instanceId: `instance:${chainKey}:001`,
    capabilityId: chainCapabilityId(chainKey),
    implementationId: `impl:${chainKey}:json-rpc`,
    providerName: "chain-observer",
    providerVersion: "1.0.0",
    accountRef: "acct:merchant-001",
    tenantRef: "tenant:merchant-001",
    authorization: {
      status: "ACTIVE",
      grantedAt: "2026-10-01T00:00:00Z",
      authorizationRef: "authz:001",
    },
    credentialScope: {
      credentialRef: "cred:001",
      credentialKind: "API_KEY",
    },
    geography: {
      countries: ["US"],
    },
    currencies: ["USD"],
    permissionState: {
      granted: ["onchain:read"],
      requested: ["onchain:read"],
      missing: [],
    },
    eligibility: {
      eligible: true,
      reasons: [],
    },
    configuration: {
      endpointKind: "public-rpc",
    },
    chainKey,
    family: "EVM",
    familyExtension: {
      family: "EVM",
      evmChainId: "1",
    },
  };
}

/** A canonical asset definition (Ethereum native asset, no family extension). */
export function etherAssetDefinition(): AssetDefinition {
  return {
    assetId: canonicalAssetRef(ETHEREUM_CHAIN_KEY, "ETH"),
    symbol: "ETH",
    displayName: "Ether",
    assetClass: "NATIVE",
    minorUnitDigits: 18,
    chainKey: ETHEREUM_CHAIN_KEY,
    provenance: {
      declaredBy: "catalogue-operator",
      artifactRef: "catalogue/assets/eth.json",
      contentHash: "sha256:0000",
    },
  };
}

/** A canonical asset observation (external state — never custody). */
export function etherAssetObservation(): AssetObservation {
  return {
    observationKind: "AssetObservation",
    observationId: "obs:001",
    observedAt: "2026-10-03T00:00:01Z",
    assetId: canonicalAssetRef(ETHEREUM_CHAIN_KEY, "ETH"),
    chainKey: ETHEREUM_CHAIN_KEY,
    location: {
      chainKey: ETHEREUM_CHAIN_KEY,
      accountRef: "acct:merchant-001",
    },
    observedAmount: {
      currency: canonicalAssetRef(ETHEREUM_CHAIN_KEY, "ETH"),
      minorUnits: "1000000000000000000",
    },
    freshness: {
      asOf: "2026-10-03T00:00:00Z",
      maxAgeSeconds: 180,
    },
    provenance: observationProvenance(),
    observer: {
      observerId: "observer:chain-node-001",
      observerKind: "CHAIN_NODE",
    },
  };
}

/** A canonical opaque signer handle (never key material). */
export function signerHandle(): SignerHandle {
  return {
    handleId: "signer.handle.001",
    capabilityInstanceId: "instance:signer:001",
    custodyModel: "NON_CUSTODIAL_EXTERNAL",
    permissionEnvelopeRef: "envelope:signer:001",
    expiresAt: "2026-10-04T00:00:00Z",
  };
}

/** A canonical transfer execution directive. */
export function transferDirective(): OnchainExecutionDirective {
  return {
    operation: "onchain.transfer",
    chainKey: ETHEREUM_CHAIN_KEY,
    family: "EVM",
    destination: "acct:beneficiary-001",
    assetId: canonicalAssetRef(ETHEREUM_CHAIN_KEY, "ETH"),
    amount: {
      assetId: canonicalAssetRef(ETHEREUM_CHAIN_KEY, "ETH"),
      minorUnits: "1000000000000000",
    },
    expiresAt: "2026-10-03T12:00:00Z",
    signerHandle: signerHandle(),
  };
}

/** A canonical BROADCAST execution observation. */
export function broadcastObservation(): OnchainExecutionObservation {
  return {
    observationId: "exec-obs:001",
    executionRef: "idem:execution:001",
    observedAt: "2026-10-03T00:00:02Z",
    chainKey: ETHEREUM_CHAIN_KEY,
    outcome: "BROADCAST",
    externalOperationRef: "txref:001",
    evidenceRefs: ["evidence:broadcast:001"],
    provenance: observationProvenance(),
  };
}

/** A canonical CONFIRMED execution observation (finality CANDIDATE only). */
export function confirmedObservation(): OnchainExecutionObservation {
  return {
    ...broadcastObservation(),
    observationId: "exec-obs:002",
    outcome: "CONFIRMED",
    finalityCandidate: {
      candidateOnly: true,
      requiresProtocolFinality: true,
      confirmationDepth: 12,
      finalityModel: "PROBABILISTIC",
      reorgDetected: false,
    },
    evidenceRefs: ["evidence:confirmed:001"],
  };
}

/** A canonical OUTCOME_UNKNOWN execution observation. */
export function unknownObservation(): OnchainExecutionObservation {
  return {
    ...broadcastObservation(),
    observationId: "exec-obs:003",
    outcome: "OUTCOME_UNKNOWN",
    unknownReason: "Transport error after submission: it is unknown whether the operation reached the chain.",
    evidenceRefs: ["evidence:unknown:001"],
  };
}

/** A canonical FAILED execution observation. */
export function failedObservation(): OnchainExecutionObservation {
  return {
    ...broadcastObservation(),
    observationId: "exec-obs:004",
    outcome: "FAILED",
    failure: {
      failureClass: "REVERTED",
      description: "The operation reverted on-chain (definitive).",
      retryGuidance: "REQUIRES_RECONCILIATION",
    },
    evidenceRefs: ["evidence:failed:001"],
  };
}

/** A canonical protocol definition (reusing the INV-SC01 smart-contract declaration). */
export function protocolDefinition(): ProtocolDefinition {
  return {
    ...baseActionCapabilityDefinition(
      protocolCapabilityId("bridge-example", ETHEREUM_CHAIN_KEY),
    ),
    kind: "ACTION",
    protocol: {
      protocolKey: "bridge-example",
      displayName: "Example Bridge Protocol",
      protocolClass: "BRIDGE",
      chainKey: ETHEREUM_CHAIN_KEY,
      smartContracts: [
        {
          kind: "smart_contract_extension",
          chainRef: ETHEREUM_CHAIN_KEY,
          contractAddress: "contract-address-opaque-001",
          sourceHash: "sha256:source",
          bytecodeHash: "sha256:bytecode",
          upgradeAuthority: { kind: "MULTISIG", description: "Bridge council multisig" },
          adminAuthority: { kind: "IMMUTABLE", description: "No admin functions" },
          pausePowers: [{ actor: "bridge-council", scope: "all lanes" }],
          oracleDependencies: [],
          custody: {
            custodial: true,
            custodianRef: "custodian:bridge-council",
            withdrawalAuthority: "multisig quorum (declared, bounded)",
            keyManagement: "declared: mpc",
          },
          searchableByLabAfterCertification: true,
        },
      ],
    },
  };
}

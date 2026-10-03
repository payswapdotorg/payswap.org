import { registerCurrency } from "@payswap/protocol";
import type { EndpointProfile, RestTransport, RpcTransport } from "../src/transport.js";
import type {
  RestCallResult,
  RpcCallResult,
  ServedBy,
  TransportProtocol,
} from "../src/transport.js";
import type { ChainHeadObservation } from "../src/contract.js";
import { chainCapabilityId } from "@payswap/onchain-domain";
import type { ConnectedChainInstance, OnchainExecutionDirective } from "@payswap/onchain-domain";
import type {
  OnchainSecurityPolicy,
  OnchainSecurityState,
  OnchainWriteRequest,
  TrustedApprovalSurface,
  TrustedSurfaceSigner,
} from "@payswap/onchain-security";
import { TrustedApprovalSurface as Surface } from "@payswap/onchain-security";
import type { Principal } from "@payswap/trust";

/**
 * Shared deterministic fixtures for the onchain-adapters contract tests.
 * Transports are SCRIPTED (no network, no mocks of domain logic — the full
 * adapter code path runs against injected responses). Currencies follow the
 * protocol money law (3-letter codes).
 */

// Protocol money law: currencies register with 0-8 minor-unit digits. The
// PROTOCOL representation of the native assets is registered here (ETH@8,
// SOL@8, BTC@8); the native on-chain encodings (wei/lamports/satoshi) are
// adapter-side exact integers and stay independent of this protocol scale.
registerCurrency("ETH", 8);
registerCurrency("SOL", 8);
registerCurrency("BTC", 8);

export const NOW = 1_776_000_000_000; // deterministic ms epoch
export const NOW_ISO = new Date(NOW).toISOString();
export const CHAIN = "ethereum:mainnet";
export const SOLANA_CHAIN = "solana:mainnet-beta";
export const BITCOIN_CHAIN = "bitcoin:mainnet";
export const ETHEREUM_ASSET_ID = `${CHAIN}/asset:ETH`;
export const SOLANA_ASSET_ID = `${SOLANA_CHAIN}/asset:SOL`;
export const BITCOIN_ASSET_ID = `${BITCOIN_CHAIN}/asset:BTC`;

export const PAYER = "0x1111111111111111111111111111111111111111";
export const MERCHANT = "0x2222222222222222222222222222222222222222";
export const ROUTER = "0x3333333333333333333333333333333333333333";

export const BTC_PAYER = "bc1qxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
export const BTC_MERCHANT = "bc1qyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy";

export const AGENT_PRINCIPAL: Principal = {
  kind: "agent",
  agentKeyFingerprint: "agent-key-1",
  ownerRef: "user:alice",
  bodyRef: "body-1",
  packageVersionRef: "pkg-1@1.0.0",
  authorityEnvelope: [],
  securityEpoch: 0n,
};

// ---------------------------------------------------------------------------
// Scripted transports (deterministic fixtures — no network)
// ---------------------------------------------------------------------------

/** A deterministic RPC transport double: answers from a scripted map. */
export class ScriptedRpcTransport implements RpcTransport {
  readonly transportId: string;
  readonly #endpoints: readonly EndpointProfile[];
  readonly #responses: Map<string, (params: readonly unknown[]) => unknown>;
  #unreachable = false;

  constructor(input: {
    readonly transportId: string;
    readonly endpoints: readonly EndpointProfile[];
    readonly responses?: Record<string, (params: readonly unknown[]) => unknown>;
  }) {
    this.transportId = input.transportId;
    this.#endpoints = Object.freeze([...input.endpoints]);
    this.#responses = new Map(Object.entries(input.responses ?? {}));
  }

  endpoints(): readonly EndpointProfile[] {
    return this.#endpoints;
  }

  script(method: string, responder: (params: readonly unknown[]) => unknown): void {
    this.#responses.set(method, responder);
  }

  /** Makes every endpoint unreachable (transport ambiguity fixtures). */
  goUnreachable(): void {
    this.#unreachable = true;
  }

  async call(method: string, params: readonly unknown[]): Promise<RpcCallResult> {
    if (this.#unreachable) {
      return {
        kind: "TRANSPORT_UNREACHABLE",
        message: "scripted unreachability",
        attempted: this.#endpoints,
      };
    }
    const servedBy: ServedBy = Object.freeze({
      transportId: this.transportId,
      endpointId: this.#endpoints[0]?.endpointId ?? "scripted",
      providerName: this.#endpoints[0]?.providerName ?? "scripted",
    });
    const responder = this.#responses.get(method);
    if (responder === undefined) {
      return {
        kind: "RPC_ERROR",
        message: `no scripted response for '${method}'`,
        servedBy,
      };
    }
    const result = responder(params);
    if (
      result !== null &&
      typeof result === "object" &&
      "scriptedError" in result &&
      (result as { scriptedError: string }).scriptedError !== undefined
    ) {
      return {
        kind: "RPC_ERROR",
        message: (result as { scriptedError: string }).scriptedError,
        servedBy,
      };
    }
    return {
      kind: "RPC_OK",
      result,
      raw: JSON.stringify({ jsonrpc: "2.0", id: 1, result }),
      servedBy,
    };
  }
}

/** A deterministic REST transport double (UTXO explorer fixtures). */
export class ScriptedRestTransport implements RestTransport {
  readonly transportId: string;
  readonly #endpoints: readonly EndpointProfile[];
  readonly #responses: Map<string, () => { status: number; body: unknown; raw?: string }>;
  #unreachable = false;

  constructor(input: {
    readonly transportId: string;
    readonly endpoints: readonly EndpointProfile[];
    readonly responses?: Record<string, () => { status: number; body: unknown; raw?: string }>;
  }) {
    this.transportId = input.transportId;
    this.#endpoints = Object.freeze([...input.endpoints]);
    this.#responses = new Map(Object.entries(input.responses ?? {}));
  }

  endpoints(): readonly EndpointProfile[] {
    return this.#endpoints;
  }

  script(path: string, response: () => { status: number; body: unknown; raw?: string }): void {
    this.#responses.set(path, response);
  }

  goUnreachable(): void {
    this.#unreachable = true;
  }

  async #request(path: string): Promise<RestCallResult> {
    if (this.#unreachable) {
      return {
        kind: "TRANSPORT_UNREACHABLE",
        message: "scripted unreachability",
        attempted: this.#endpoints,
      };
    }
    const servedBy: ServedBy = Object.freeze({
      transportId: this.transportId,
      endpointId: this.#endpoints[0]?.endpointId ?? "scripted",
      providerName: this.#endpoints[0]?.providerName ?? "scripted",
    });
    const responder = this.#responses.get(path);
    if (responder === undefined) {
      return {
        kind: "REST_ERROR",
        status: 404,
        message: `no scripted response for '${path}'`,
        servedBy,
      };
    }
    const response = responder();
    if (response.status >= 400) {
      return {
        kind: "REST_ERROR",
        status: response.status,
        ...(response.body !== undefined ? { body: response.body } : {}),
        message: `scripted HTTP ${response.status}`,
        servedBy,
      };
    }
    const raw = response.raw ?? (typeof response.body === "string" ? response.body : JSON.stringify(response.body));
    return { kind: "REST_OK", status: response.status, body: response.body, raw, servedBy };
  }

  async get(path: string): Promise<RestCallResult> {
    return this.#request(path);
  }

  async post(path: string, _body: string, _contentType: string): Promise<RestCallResult> {
    return this.#request(path);
  }
}

/** A fake endpoint profile (scripted; environment class must be declared). */
export function fakeEndpoint(input: {
  readonly endpointId: string;
  readonly providerName: string;
  readonly chainKey: string;
  readonly protocol?: TransportProtocol;
}): EndpointProfile {
  return {
    endpointId: input.endpointId,
    providerName: input.providerName,
    url: `https://scripted.test/${input.endpointId}`,
    protocol: input.protocol ?? "JSON_RPC",
    chainKey: input.chainKey,
  };
}

// ---------------------------------------------------------------------------
// Chain heads + instances + directives
// ---------------------------------------------------------------------------

export function evmHead(overrides?: Partial<ChainHeadObservation>): ChainHeadObservation {
  return {
    observationKind: "ChainHeadObservation",
    chainKey: CHAIN,
    environmentClass: "PRODUCTION",
    height: 18_000_000,
    headHash: "0xabc0000000000000000000000000000000000000000000000000000000000f01",
    observedAt: NOW_ISO,
    provenance: {
      transportId: "transport:scripted:evm",
      endpointId: "evm-scripted-1",
      providerName: "ScriptedProvider",
      capturedAt: NOW_ISO,
      adapterId: "adapter:evm:test",
      environmentClass: "PRODUCTION",
    },
    maxAgeSeconds: 90,
    ...overrides,
  };
}

export function connectedChainInstance(
  chainKey: string,
  family: "EVM" | "SOLANA" | "UTXO",
): ConnectedChainInstance {
  return {
    instanceId: `instance:${chainKey}:001`,
    capabilityId: chainCapabilityId(chainKey),
    implementationId: `impl:${chainKey}:transport`,
    providerName: "chain-observer",
    providerVersion: "1.0.0",
    accountRef: "acct:merchant-001",
    tenantRef: "tenant:merchant-001",
    authorization: {
      status: "ACTIVE",
      grantedAt: "2026-10-01T00:00:00Z",
      authorizationRef: "authz:001",
    },
    credentialScope: { credentialRef: "cred:001", credentialKind: "API_KEY" },
    geography: { countries: ["US"] },
    currencies: ["USD"],
    permissionState: { granted: ["onchain:read"], requested: ["onchain:read"], missing: [] },
    eligibility: { eligible: true, reasons: [] },
    configuration: { endpointKind: "public-rpc" },
    chainKey,
    family,
    ...(family === "EVM" ? { familyExtension: { family: "EVM", evmChainId: "1" } } : {}),
  };
}

export function evmTransferDirective(
  overrides?: Partial<OnchainExecutionDirective>,
): OnchainExecutionDirective {
  return {
    operation: "onchain.transfer",
    chainKey: CHAIN,
    family: "EVM",
    destination: MERCHANT,
    assetId: ETHEREUM_ASSET_ID,
    amount: { assetId: ETHEREUM_ASSET_ID, minorUnits: "1000000" },
    expiresAt: new Date(NOW + 60_000).toISOString(),
    signerHandle: {
      handleId: "signer.handle.001",
      capabilityInstanceId: "instance:signer:001",
      custodyModel: "NON_CUSTODIAL_EXTERNAL",
    },
    ...overrides,
  };
}

export function solanaTransferDirective(
  overrides?: Partial<OnchainExecutionDirective>,
): OnchainExecutionDirective {
  return {
    operation: "onchain.transfer",
    chainKey: SOLANA_CHAIN,
    family: "SOLANA",
    destination: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    assetId: SOLANA_ASSET_ID,
    amount: { assetId: SOLANA_ASSET_ID, minorUnits: "5000000" },
    expiresAt: new Date(NOW + 60_000).toISOString(),
    signerHandle: {
      handleId: "signer.handle.002",
      capabilityInstanceId: "instance:signer:002",
      custodyModel: "NON_CUSTODIAL_EXTERNAL",
    },
    familyPayload: { serializedTransaction: "BASE64SERIALIZEDTX" },
    ...overrides,
  };
}

export function utxoTransferDirective(
  overrides?: Partial<OnchainExecutionDirective>,
): OnchainExecutionDirective {
  return {
    operation: "onchain.transfer",
    chainKey: BITCOIN_CHAIN,
    family: "UTXO",
    destination: BTC_MERCHANT,
    assetId: BITCOIN_ASSET_ID,
    amount: { assetId: BITCOIN_ASSET_ID, minorUnits: "100000" },
    expiresAt: new Date(NOW + 60_000).toISOString(),
    signerHandle: {
      handleId: "signer.handle.003",
      capabilityInstanceId: "instance:signer:003",
      custodyModel: "NON_CUSTODIAL_EXTERNAL",
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Security-policy fixtures (the adapters feed the REAL kernel)
// ---------------------------------------------------------------------------

export function evmPolicy(overrides?: Partial<OnchainSecurityPolicy>): OnchainSecurityPolicy {
  return {
    policyId: "policy-1",
    version: 1,
    forbidUnlimitedApprovals: true,
    unknownContractPolicy: "block",
    unknownRoutePolicy: "block",
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

/** A deterministic trusted-surface signer double (opaque, not cryptography). */
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
  return new Surface(TEST_SURFACE_SIGNER);
}

/** The write-request shape the policy route hash must include for ALLOW. */
export function writeRouteHashOf(writeRequest: OnchainWriteRequest): string {
  return writeRequest.route.routeHash;
}

/**
 * Crypto rail adapter — Ethereum mainnet over a REAL public JSON-RPC
 * endpoint (W1-005). Read-only surface for Stage 5: chain id, block number,
 * balance and transaction/receipt lookups.
 *
 * Binding rules:
 * - INV-X01: a not-ye-seen/pending transaction is ASYNC (never FAILED); a
 *   detected reorg/double-spend (block hash changed at the observed height,
 *   or a previously-mined transaction disappeared) is OUTCOME_UNKNOWN
 *   pending reconciliation — NEVER mapped to FAILED;
 * - finality is PROTOCOL-OWNED (AGENTS.md rule 5): confirmations produce
 *   finality CANDIDATES only; the settlement plane's proof policies issue
 *   actual finality (INV-E03);
 * - INV-C09: balances are ExternalFundsPositionObservations with mandatory
 *   freshness (chain head timestamp) and provenance (endpoint + capture
 *   time) — observations of external state, never PaySwap custody and never
 *   a customer balance;
 * - INV-F01: wei amounts are exact bigint string minor units; hex JSON-RPC
 *   quantities are parsed with exactBigintFromHex — no floating point;
 * - INV-C06: the raw JSON-RPC objects are carried verbatim in the envelope
 *   state; confirmations/block hashes are ADDITIVE metadata.
 *
 * Real endpoint (exercised by the live suite): https://ethereum-rpc.publicnode.com
 */

import { ValidationError } from "@payswap/protocol";
import type { ProtocolClock, TimestampMs } from "@payswap/protocol";
import type {
  CapabilityDefinition,
  CapabilityObservation,
  ConnectorCapabilityPack,
  ExternalFundsPositionObservation,
  ProviderIdentity,
  ProviderStateEnvelope,
} from "@payswap/connectors";
import {
  EXTERNAL_FUNDS_OBSERVATION_KIND,
  validateCapabilityDefinition,
  observeCapability,
  unknownReachabilityObservation,
} from "@payswap/connectors";
import { BaseRailAdapter, ConnectorSDK, classifyOutcome } from "@payswap/adapters";
import type {
  ConnectorHealthReport,
  CredentialRotationResult,
  SdkCallContext,
  SdkCallResult,
} from "@payswap/adapters";
import type { ProviderExecutionEvidenceDraft } from "@payswap/execution";
import {
  RailProviderError,
  RailTransportError,
  exactBigintFromHex,
  jsonRpcOverHttp,
  railEnvelope,
  railEvidence,
  routableRailImplication,
  isoTimestamp,
} from "./support.js";
import type { JsonRpcTransport, RailImplication } from "./support.js";

// ---------------------------------------------------------------------------
// Identity + capability (consumed W2-003 vocabulary, never redefined)
// ---------------------------------------------------------------------------

export const ETHEREUM_RAIL_CAPABILITY_ID = "cap.rails.ethereum.observe" as const;
export const ETHEREUM_RAIL_ADAPTER_ID = "rail.crypto.ethereum_json_rpc" as const;
export const ETHEREUM_RAIL_IMPLEMENTATION_ID = "impl.rails.ethereum.json_rpc" as const;
export const ETHEREUM_RAIL_PROVIDER_NAME = "ethereum-mainnet" as const;
export const ETHEREUM_RAIL_PROVIDER_VERSION = "1.0.0" as const;

/** The genuinely reachable public JSON-RPC endpoint exercised in Stage 5. */
export const DEFAULT_ETHEREUM_RPC_ENDPOINT = "https://ethereum-rpc.publicnode.com" as const;

/** The expected chain id (Ethereum mainnet) — a probe mismatch is DEGRADED. */
export const EXPECTED_ETHEREUM_CHAIN_ID = "0x1" as const;

/** Default confirmation threshold for a finality CANDIDATE (documented heuristic). */
export const DEFAULT_FINALITY_CANDIDATE_CONFIRMATIONS = 12n;

/** Default freshness window for external funds observations (seconds). */
export const DEFAULT_FUNDS_FRESHNESS_SECONDS = 180;

/** The canonical capability definition consumed by the crypto rail adapter. */
export function ethereumRailCapabilityDefinition(): CapabilityDefinition {
  return validateCapabilityDefinition({
    capabilityId: ETHEREUM_RAIL_CAPABILITY_ID,
    capabilityVersion: "1.0.0",
    summary: "Ethereum mainnet read-only rail: transaction observation and external funds positions",
    kind: "READ",
    requiredPermissions: [],
    executionModes: ["PASS_THROUGH_NATIVE", "COMPOSED_PAYSWAP", "OPTIMIZED_MULTI_PROVIDER"],
    semantics: {
      operation: "rails.ethereum.observe",
      stateMachine: {
        documentRef: "spec/architecture/PAYMENT-OPERATING-PLANE.md",
        version: "1",
      },
      description:
        "Read-only observation of Ethereum mainnet state through a public JSON-RPC endpoint: transaction/receipt lookups (confirmations → finality candidates; reorgs → UNKNOWN) and external funds position observations (never custody)",
    },
    preconditions: [
      "public JSON-RPC endpoint reachable (no credentials required)",
      "observed addresses/transactions belong to the authorized scope",
    ],
    authorization: {
      protocolAuthorization: true,
      requiredScopes: ["rails:read"],
      customerConsent: "NOT_REQUIRED",
    },
    sideEffects: [
      {
        effect: "observes on-chain state (read-only)",
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
      partialExecution: { possible: false, granularity: "ATOMIC", onPartial: "DISCLOSED" },
    },
    requiredCustomerActions: [],
    providerVocabulary: {
      actions: [],
      states: [
        { providerState: "not_seen", canonicalState: "async_processing:not_seen", requiresCustomerAction: false, isTerminal: false },
        { providerState: "pending", canonicalState: "async_processing:pending", requiresCustomerAction: false, isTerminal: false },
        { providerState: "mined", canonicalState: "other:mined", requiresCustomerAction: false, isTerminal: false },
        { providerState: "mined_reverted", canonicalState: "other:mined_reverted", requiresCustomerAction: false, isTerminal: true },
        { providerState: "reorg_unknown", canonicalState: "other:reorg_unknown", requiresCustomerAction: false, isTerminal: false },
      ],
    },
    externalObjects: [
      {
        objectType: "transaction",
        idFormat: "0x[0-9a-fA-F]{64}",
        revisioned: true,
        revisionFormat: "blockHash:status:confirmations",
      },
      {
        objectType: "address_balance",
        idFormat: "0x[0-9a-fA-F]{40}",
        revisioned: true,
        revisionFormat: "blockNumber:wei",
      },
    ],
    evidence: { produced: ["STATE_OBSERVATION", "EXECUTION"], required: [] },
    economics: { feeModel: "NONE", limits: [], settlementImplications: "on-chain settlement is externally final" },
    constraints: [],
  });
}

/** The connector capability pack backing the crypto rail (crypto family). */
export function ethereumRailCapabilityPack(): ConnectorCapabilityPack {
  return Object.freeze({
    packId: "pack.rails.ethereum",
    family: "crypto",
    version: "1.0.0",
    subPacks: [],
    capabilityRefs: [{ capabilityId: ETHEREUM_RAIL_CAPABILITY_ID, capabilityVersion: "1.0.0" }],
    auth: { authKind: "PROVIDER_DEFINED" as const, scopes: [] },
    schemas: [{ schemaId: "schema.rails.ethereum.json_rpc", version: "1.0.0" }],
    objectMappings: [
      {
        externalObjectType: "transaction",
        canonicalObjectRef: "payswap:external_transaction",
        sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const,
      },
      {
        externalObjectType: "address_balance",
        canonicalObjectRef: "payswap:external_funds_observation",
        sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const,
      },
    ],
    sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const,
    rateLimits: [{ limit: 600, windowSeconds: 60, scope: "endpoint" }],
    provenance: {
      publisher: "payswap",
      publishedAt: "2026-10-01T00:00:00.000Z",
      contentHash: "hash:rails-eth-1",
    },
    evidence: [],
  });
}

// ---------------------------------------------------------------------------
// Transaction observation (confirmations → candidates; reorg → UNKNOWN)
// ---------------------------------------------------------------------------

/** The provider-side observation status of one transaction hash. */
export type EthereumTransactionStatus =
  | "NOT_SEEN"
  | "PENDING"
  | "MINED_SUCCESS"
  | "MINED_REVERTED"
  | "REORG_UNKNOWN";

/** A lossless transaction observation (INV-C06: raw RPC objects retained). */
export interface EthereumTransactionObservation {
  readonly txHash: string;
  readonly status: EthereumTransactionStatus;
  readonly blockNumber?: bigint;
  readonly blockHash?: string;
  /** Depth below the observed chain head, including the mining block (>= 1). */
  readonly confirmations: bigint;
  /**
   * True when confirmations reached the threshold — a finality CANDIDATE.
   * Never a finality declaration: finality is protocol-owned (INV-E03).
   */
  readonly finalityCandidate: boolean;
  /** True when this observation detected a reorg/double-spend condition. */
  readonly reorgDetected: boolean;
  /** The raw JSON-RPC transaction object, verbatim (when seen). */
  readonly rawTransaction?: unknown;
  /** The raw JSON-RPC receipt object, verbatim (when mined). */
  readonly rawReceipt?: unknown;
}

/** Envelope revision for a transaction observation (provider-derived). */
export function transactionRevision(observation: EthereumTransactionObservation): string {
  if (observation.status === "NOT_SEEN" || observation.status === "PENDING") {
    return `${observation.status}`;
  }
  return `${observation.blockHash ?? "pending"}:${observation.status}:${observation.confirmations}`;
}

/**
 * INV-C06/INV-X01: builds the lossless envelope for one transaction
 * observation. REORG_UNKNOWN carries failure metadata with ambiguity
 * OUTCOME_UNKNOWN — the canonical classifier therefore yields
 * OUTCOME_UNKNOWN + requiresReconciliation, never FAILED. MINED_REVERTED is
 * a definitive on-chain failure (ambiguity NONE). isTerminal on a mined
 * success reflects the finality-CANDIDATE threshold only (the settlement
 * plane's proof policies own actual finality).
 */
export function ethereumTransactionEnvelope(
  observation: EthereumTransactionObservation,
  observedAt: string,
  minConfirmations: bigint,
): ProviderStateEnvelope {
  const base = {
    providerName: ETHEREUM_RAIL_PROVIDER_NAME,
    providerVersion: ETHEREUM_RAIL_PROVIDER_VERSION,
    objectType: "transaction",
    externalId: observation.txHash,
    revision: transactionRevision(observation),
    state: {
      txHash: observation.txHash,
      status: observation.status,
      reorgDetected: observation.reorgDetected,
      ...(observation.blockNumber !== undefined
        ? { blockNumber: `0x${observation.blockNumber.toString(16)}` }
        : {}),
      ...(observation.blockHash !== undefined ? { blockHash: observation.blockHash } : {}),
      confirmations: observation.confirmations.toString(),
      rawTransaction: observation.rawTransaction ?? null,
      rawReceipt: observation.rawReceipt ?? null,
    },
    observedAt,
    provenanceSource: "PROVIDER_API" as const,
  };
  switch (observation.status) {
    case "NOT_SEEN":
    case "PENDING":
      // INV-X01: not seen / in mempool is NOT a failure — async.
      return railEnvelope({
        ...base,
        family: "async_processing",
        lifecycleStep: observation.status === "PENDING" ? "pending" : "not_seen",
        isTerminal: false,
        requiresCustomerAction: false,
      });
    case "MINED_SUCCESS":
      return railEnvelope({
        ...base,
        family: "other",
        lifecycleStep: "mined",
        isTerminal: observation.finalityCandidate,
        requiresCustomerAction: false,
      });
    case "MINED_REVERTED":
      return railEnvelope({
        ...base,
        family: "other",
        lifecycleStep: "mined_reverted",
        isTerminal: true,
        requiresCustomerAction: false,
        failure: {
          providerErrorCode: "EVM_REVERTED",
          retryable: false,
          ambiguity: "NONE",
        },
      });
    case "REORG_UNKNOWN":
      return railEnvelope({
        ...base,
        family: "other",
        lifecycleStep: "reorg_unknown",
        isTerminal: false,
        requiresCustomerAction: false,
        failure: {
          providerErrorCode: "CHAIN_REORG_DETECTED",
          providerErrorMessage:
            "the observed inclusion is no longer reliable (block hash changed at the observed height or the transaction disappeared) — double-spend possible, outcome pending reconciliation",
          retryable: false,
          ambiguity: "OUTCOME_UNKNOWN",
        },
      });
  }
}

// ---------------------------------------------------------------------------
// The RailAdapter
// ---------------------------------------------------------------------------

/** The crypto rail adapter on the W3-003 framework. */
export class EthereumJsonRpcRail extends BaseRailAdapter {
  readonly adapterId = ETHEREUM_RAIL_ADAPTER_ID;
  readonly implementationId = ETHEREUM_RAIL_IMPLEMENTATION_ID;

  constructor() {
    super(
      ethereumRailCapabilityPack(),
      new Map([[ETHEREUM_RAIL_CAPABILITY_ID, ethereumRailCapabilityDefinition()]]),
    );
  }
}

// ---------------------------------------------------------------------------
// The provider-facing client (ConnectorSDK over the real JSON-RPC endpoint)
// ---------------------------------------------------------------------------

export interface EthereumRailClientConfig {
  readonly clock: ProtocolClock;
  /** Real public JSON-RPC endpoint (default: publicnode Ethereum mainnet). */
  readonly endpoint?: string;
  /** Expected chain id in hex (default: mainnet 0x1). */
  readonly expectedChainId?: string;
  /** Finality-candidate confirmation threshold (default 12). */
  readonly finalityCandidateConfirmations?: bigint;
  /** Freshness window for funds observations, seconds (default 180). */
  readonly fundsFreshnessSeconds?: number;
  /** Injectable JSON-RPC transport (tests) — default: real HTTP JSON-RPC. */
  readonly transport?: JsonRpcTransport;
  readonly timeoutMs?: number;
}

/** Provider-neutral SDK call request shapes (never provider SDK types). */
export type EthereumSdkRequest =
  | { readonly kind: "transaction"; readonly txHash: string }
  | { readonly kind: "external_funds"; readonly address: string };

/**
 * The Ethereum rail client on the ConnectorSDK framework over a REAL public
 * JSON-RPC endpoint. Read-only by construction: no method this client calls
 * can move value. The client remembers observed block hashes per height so
 * re-observations can detect reorgs (INV-X01 → UNKNOWN pending
 * reconciliation) and appends every observation as provider revisions.
 */
export class EthereumRailClient extends ConnectorSDK {
  readonly #clock: ProtocolClock;
  readonly #transport: JsonRpcTransport;
  readonly #expectedChainId: string;
  readonly #minConfirmations: bigint;
  readonly #fundsFreshnessSeconds: number;
  /** blockNumber → last observed block hash (reorg detection evidence). */
  readonly #observedBlockHashes = new Map<bigint, string>();
  /** txHash → last observed inclusion (blockNumber, blockHash). */
  readonly #observedInclusions = new Map<string, { readonly blockNumber: bigint; readonly blockHash: string }>();

  constructor(config: EthereumRailClientConfig) {
    super({ clock: config.clock });
    this.#clock = config.clock;
    this.#transport =
      config.transport ?? jsonRpcOverHttp(config.endpoint ?? DEFAULT_ETHEREUM_RPC_ENDPOINT);
    this.#expectedChainId = config.expectedChainId ?? EXPECTED_ETHEREUM_CHAIN_ID;
    this.#minConfirmations =
      config.finalityCandidateConfirmations ?? DEFAULT_FINALITY_CANDIDATE_CONFIRMATIONS;
    this.#fundsFreshnessSeconds =
      config.fundsFreshnessSeconds ?? DEFAULT_FUNDS_FRESHNESS_SECONDS;
  }

  providerIdentity(): ProviderIdentity {
    return Object.freeze({
      providerName: ETHEREUM_RAIL_PROVIDER_NAME,
      providerVersion: ETHEREUM_RAIL_PROVIDER_VERSION,
      systemKind: "other",
      displayName: "Ethereum mainnet (public JSON-RPC rail)",
    });
  }

  capabilityPack(): ConnectorCapabilityPack {
    return ethereumRailCapabilityPack();
  }

  // -- JSON-RPC reads (exact bigint parsing — INV-F01) -------------------------

  /** eth_chainId — also the health/availability probe. */
  async chainId(): Promise<string> {
    return this.#requireStringResult(await this.#rpc("eth_chainId", []), "eth_chainId");
  }

  /** eth_blockNumber as an exact bigint. */
  async blockNumber(): Promise<bigint> {
    return exactBigintFromHex(
      this.#requireStringResult(await this.#rpc("eth_blockNumber", []), "eth_blockNumber"),
    );
  }

  /** eth_getBalance (wei) as an exact bigint string — never a float. */
  async balanceWei(address: string): Promise<bigint> {
    return exactBigintFromHex(
      this.#requireStringResult(
        await this.#rpc("eth_getBalance", [address, "latest"]),
        "eth_getBalance",
      ),
    );
  }

  /**
   * INV-C09: an ExternalFundsPositionObservation of one address's native
   * balance. Freshness = the chain-head timestamp (asOf) with the declared
   * max-age window; provenance = the provider name + capture time. This is
   * an OBSERVATION of external state — structurally not a balance type and
   * never PaySwap custody.
   */
  async observeExternalFundsPosition(address: string): Promise<ExternalFundsPositionObservation> {
    const [balance, head] = await Promise.all([this.balanceWei(address), this.#headBlock()]);
    const observedAt = isoTimestamp(this.now());
    return Object.freeze({
      observationKind: EXTERNAL_FUNDS_OBSERVATION_KIND,
      observationId: `eth-balance:${address}:${head.number.toString()}`,
      observedAt,
      freshness: {
        asOf: new Date(Number(head.timestamp) * 1000).toISOString(),
        maxAgeSeconds: this.#fundsFreshnessSeconds,
      },
      location: {
        providerName: ETHEREUM_RAIL_PROVIDER_NAME,
        accountRef: address,
        instrumentRef: "native-ether",
      },
      observedAmount: {
        currency: "ETH",
        minorUnits: balance.toString(),
      },
      provenance: {
        providerName: ETHEREUM_RAIL_PROVIDER_NAME,
        source: "PROVIDER_API" as const,
        capturedAt: observedAt,
      },
    });
  }

  /**
   * Observes one transaction: confirmations are counted against the current
   * head; a reorg (changed block hash at the observed height, or a
   * disappeared inclusion) yields REORG_UNKNOWN (INV-X01 — UNKNOWN pending
   * reconciliation, never FAILED). Confirmations reaching the threshold
   * produce a finality CANDIDATE (finality itself is protocol-owned).
   */
  async observeTransaction(txHash: string): Promise<EthereumTransactionObservation> {
    if (typeof txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      throw new ValidationError("txHash must be a 0x-prefixed 32-byte hash");
    }
    const head = await this.blockNumber();
    const tx = (await this.#rpc("eth_getTransactionByHash", [txHash])) as
      | { readonly blockNumber: string | null; readonly blockHash: string | null }
      | null
      | undefined;

    if (tx === null || tx === undefined) {
      const previousInclusion = this.#observedInclusions.get(txHash);
      if (previousInclusion !== undefined) {
        // Previously mined, now not even in the mempool view: the inclusion
        // disappeared — reorg/double-spend condition → UNKNOWN (INV-X01).
        return this.#reorgObservation(txHash, previousInclusion.blockNumber, undefined, undefined, undefined);
      }
      return Object.freeze({
        txHash,
        status: "NOT_SEEN",
        confirmations: 0n,
        finalityCandidate: false,
        reorgDetected: false,
      });
    }

    if (tx.blockNumber === null || tx.blockNumber === undefined || tx.blockHash === null) {
      // In the mempool, not yet mined: async — never a failure (INV-X01).
      return Object.freeze({
        txHash,
        status: "PENDING",
        confirmations: 0n,
        finalityCandidate: false,
        reorgDetected: false,
        rawTransaction: tx,
      });
    }

    const blockNumber = exactBigintFromHex(tx.blockNumber);
    const blockHash = tx.blockHash;

    // Reorg evidence 1: the remembered hash for this height differs.
    const rememberedHash = this.#observedBlockHashes.get(blockNumber);
    // Reorg evidence 2: this tx was previously observed in a DIFFERENT block.
    const previousInclusion = this.#observedInclusions.get(txHash);
    const inclusionChanged =
      previousInclusion !== undefined &&
      (previousInclusion.blockNumber !== blockNumber || previousInclusion.blockHash !== blockHash);
    const heightReorged =
      rememberedHash !== undefined && rememberedHash !== blockHash;

    this.#observedBlockHashes.set(blockNumber, blockHash);
    this.#observedInclusions.set(txHash, { blockNumber, blockHash });

    const receipt = (await this.#rpc("eth_getTransactionReceipt", [txHash])) as
      | { readonly status: string }
      | null
      | undefined;

    if (receipt === null || receipt === undefined) {
      // Transaction object says mined, receipt says not: inconsistent node
      // view (common right at a reorg) → UNKNOWN pending reconciliation.
      return this.#reorgObservation(txHash, blockNumber, blockHash, tx, undefined);
    }

    if (heightReorged || inclusionChanged) {
      return this.#reorgObservation(txHash, blockNumber, blockHash, tx, receipt);
    }

    const confirmations = head - blockNumber + 1n;
    const success = receipt.status === "0x1";
    return Object.freeze({
      txHash,
      status: success ? "MINED_SUCCESS" : "MINED_REVERTED",
      blockNumber,
      blockHash,
      confirmations: confirmations < 0n ? 0n : confirmations,
      finalityCandidate: success && confirmations >= this.#minConfirmations,
      reorgDetected: false,
      rawTransaction: tx,
      rawReceipt: receipt,
    });
  }

  /**
   * The finality CANDIDATE assessment for one transaction (finality itself
   * is protocol-owned — INV-E03; this is rail-side evidence only).
   */
  async finalityCandidate(txHash: string): Promise<{
    readonly txHash: string;
    readonly confirmations: bigint;
    readonly threshold: bigint;
    readonly candidate: boolean;
    readonly status: EthereumTransactionStatus;
  }> {
    const observation = await this.observeTransaction(txHash);
    return Object.freeze({
      txHash,
      confirmations: observation.confirmations,
      threshold: this.#minConfirmations,
      candidate: observation.finalityCandidate,
      status: observation.status,
    });
  }

  // -- availability + health (INV-C01/C02 — live probe, never fabricated) ------

  /**
   * Two-axis availability observation backed by a LIVE probe (eth_chainId —
   * credential-free, read-only). Probe success → source REACHABLE; probe
   * failure → source UNREACHABLE → derived availability UNKNOWN (INV-C02:
   * never success, never failure).
   */
  async availabilityObservation(input: {
    readonly instanceId: string;
    readonly observationVersion: number;
  }): Promise<CapabilityObservation> {
    const observedAt = isoTimestamp(this.now());
    let probe: { readonly reachable: boolean; readonly chainId?: string };
    try {
      const chainId = await this.chainId();
      probe = { reachable: true, chainId };
    } catch {
      probe = { reachable: false };
    }
    if (!probe.reachable) {
      return unknownReachabilityObservation({
        instanceId: input.instanceId,
        observedAt,
        observationVersion: input.observationVersion,
        lastKnownCapabilityState: "AVAILABLE",
        reason:
          "public JSON-RPC endpoint unreachable — source availability UNKNOWN (INV-C01/C02)",
        provenance: {
          providerName: ETHEREUM_RAIL_PROVIDER_NAME,
          source: "INTERNAL",
          capturedAt: observedAt,
        },
      });
    }
    const chainMatches = probe.chainId === this.#expectedChainId;
    return observeCapability({
      instanceId: input.instanceId,
      observedAt,
      observationVersion: input.observationVersion,
      capabilityState: chainMatches ? "AVAILABLE" : "UNAVAILABLE",
      sourceAvailability: "REACHABLE",
      eligibility: "UNKNOWN",
      health: {
        status: chainMatches ? "HEALTHY" : "DEGRADED",
        lastCheckedAt: observedAt,
      },
      provenance: {
        providerName: ETHEREUM_RAIL_PROVIDER_NAME,
        source: "PROVIDER_API",
        capturedAt: observedAt,
      },
    });
  }

  /** INV-NC04 gate: UNKNOWN availability is never routable. */
  railImplication(availability: CapabilityObservation["availability"]): RailImplication {
    return routableRailImplication(ETHEREUM_RAIL_ADAPTER_ID, availability);
  }

  /**
   * Read-only health probe (eth_chainId). A chain-id mismatch (wrong
   * network) is DEGRADED — never a business outcome (INV-C02).
   */
  async health(): Promise<ConnectorHealthReport> {
    const lastCheckedAt = isoTimestamp(this.now());
    const base = {
      connectorId: "connector.rails.ethereum",
      providerName: ETHEREUM_RAIL_PROVIDER_NAME,
      providerVersion: ETHEREUM_RAIL_PROVIDER_VERSION,
      capabilityStatuses: [] as ConnectorHealthReport["capabilityStatuses"],
    };
    try {
      const chainId = await this.chainId();
      if (chainId !== this.#expectedChainId) {
        return {
          ...base,
          status: "DEGRADED",
          lastCheckedAt,
          degradedReasons: [
            `endpoint answers chain id ${chainId}, expected ${this.#expectedChainId} (wrong network — never a business outcome)`,
          ],
        };
      }
      return { ...base, status: "HEALTHY", lastCheckedAt, degradedReasons: [] };
    } catch (error) {
      return {
        ...base,
        status: "UNKNOWN",
        lastCheckedAt,
        degradedReasons: [
          `JSON-RPC probe failed (never a business outcome): ${error instanceof Error ? error.message : String(error)}`,
        ],
      };
    }
  }

  // -- SDK operation surface -----------------------------------------------------

  async search(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new ValidationError(
      "the crypto rail exposes no search surface in Stage 5 (read-only observation by hash/address)",
    );
  }

  async read(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "read");
    const request = this.#readRequest(ctx);
    if (request.kind === "transaction") {
      const observation = await this.observeTransaction(request.txHash);
      return this.#transactionSdkResult(observation, `eth:read:${request.txHash}`);
    }
    const observation = await this.observeExternalFundsPosition(request.address);
    return this.#fundsSdkResult(observation, `eth:read:${request.address}`);
  }

  async create(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new ValidationError(
      "the crypto rail is read-only in Stage 5 — value movement requires the protocol-authorized execution path, never the SDK create surface",
    );
  }

  async update(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new ValidationError("on-chain state is not mutable through this rail");
  }

  async executeAction(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new ValidationError(
      "the crypto rail is read-only in Stage 5 — no provider actions are exposed",
    );
  }

  async subscribe(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new ValidationError(
      "the crypto rail exposes no event subscription in Stage 5 (polling observation only)",
    );
  }

  async reconcile(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "reconcile");
    const request = this.#readRequest(ctx);
    if (request.kind !== "transaction") {
      throw new ValidationError(
        "reconciliation re-fetches transactions by hash (INV-X03): use { kind: 'transaction', txHash }",
      );
    }
    // INV-X03: re-fetch by external object id — the authoritative recovery
    // path for an ambiguous observation.
    const observation = await this.observeTransaction(request.txHash);
    return this.#transactionSdkResult(observation, `eth:reconcile:${request.txHash}`);
  }

  async disconnect(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new ValidationError(
      "the crypto rail holds no session (public read-only endpoint); there is nothing to disconnect",
    );
  }

  async rotateCredentials(_ctx: SdkCallContext): Promise<CredentialRotationResult> {
    throw new ValidationError(
      "the crypto rail uses a credential-free public endpoint — no credential rotation surface exists (CREDENTIAL-ROTATION.md)",
    );
  }

  // -- internals ---------------------------------------------------------------------

  async #rpc(method: string, params: readonly unknown[]): Promise<unknown> {
    let response;
    try {
      response = await this.#transport(method, params);
    } catch (cause) {
      if (cause instanceof RailProviderError || cause instanceof RailTransportError) {
        throw cause;
      }
      throw new RailTransportError(
        `JSON-RPC transport failed for method '${method}'`,
        { method, cause: cause instanceof Error ? cause.message : String(cause) },
      );
    }
    if (response.error !== undefined) {
      throw new RailProviderError(`JSON-RPC method '${method}' failed: ${response.error.message}`, {
        method,
        code: response.error.code,
      });
    }
    return response.result;
  }

  #requireStringResult(value: unknown, method: string): string {
    if (typeof value !== "string" || value.length === 0) {
      throw new RailProviderError(`JSON-RPC method '${method}' returned a non-string result`, {
        method,
      });
    }
    return value;
  }

  async #headBlock(): Promise<{ readonly number: bigint; readonly timestamp: bigint }> {
    const block = (await this.#rpc("eth_getBlockByNumber", ["latest", false])) as
      | { readonly number: string; readonly timestamp: string }
      | null
      | undefined;
    if (
      block === null ||
      block === undefined ||
      typeof block.number !== "string" ||
      typeof block.timestamp !== "string"
    ) {
      throw new RailProviderError("eth_getBlockByNumber(latest) returned no block header");
    }
    return {
      number: exactBigintFromHex(block.number),
      timestamp: exactBigintFromHex(block.timestamp),
    };
  }

  #reorgObservation(
    txHash: string,
    blockNumber: bigint | undefined,
    blockHash: string | undefined,
    rawTransaction: unknown,
    rawReceipt: unknown,
  ): EthereumTransactionObservation {
    return Object.freeze({
      txHash,
      status: "REORG_UNKNOWN",
      ...(blockNumber !== undefined ? { blockNumber } : {}),
      ...(blockHash !== undefined ? { blockHash } : {}),
      confirmations: 0n,
      finalityCandidate: false,
      reorgDetected: true,
      rawTransaction,
      rawReceipt,
    });
  }

  #readRequest(ctx: SdkCallContext): EthereumSdkRequest {
    const candidate = (ctx.request ?? {}) as Partial<EthereumSdkRequest>;
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new ValidationError("crypto rail call request must be an object");
    }
    if (candidate.kind === "transaction") {
      if (typeof candidate.txHash !== "string") {
        throw new ValidationError("transaction read requires txHash");
      }
      return { kind: "transaction", txHash: candidate.txHash };
    }
    if (candidate.kind === "external_funds") {
      if (typeof candidate.address !== "string") {
        throw new ValidationError("external_funds read requires address");
      }
      return { kind: "external_funds", address: candidate.address };
    }
    throw new ValidationError(
      "crypto rail read request must be { kind: 'transaction', txHash } or { kind: 'external_funds', address }",
    );
  }

  #transactionSdkResult(
    observation: EthereumTransactionObservation,
    evidenceId: string,
  ): SdkCallResult {
    const now: TimestampMs = this.#clock.now();
    const envelope = ethereumTransactionEnvelope(
      observation,
      isoTimestamp(now),
      this.#minConfirmations,
    );
    const evidence: ProviderExecutionEvidenceDraft = railEvidence({
      evidenceId,
      evidenceRef: `transaction:${observation.txHash}`,
      kind: "STATE_OBSERVATION",
      providerState: envelope,
      recordedAt: now,
    });
    return { providerState: envelope, outcome: classifyOutcome(envelope), evidence };
  }

  #fundsSdkResult(
    observation: ExternalFundsPositionObservation,
    evidenceId: string,
  ): SdkCallResult {
    const now: TimestampMs = this.#clock.now();
    // INV-C09: the observation is external state — the envelope carries the
    // OBSERVATION verbatim (amount + freshness + provenance), never a
    // balance PaySwap could book.
    const envelope = railEnvelope({
      providerName: ETHEREUM_RAIL_PROVIDER_NAME,
      providerVersion: ETHEREUM_RAIL_PROVIDER_VERSION,
      objectType: "address_balance",
      externalId: observation.location.accountRef,
      revision: `${observation.observationId}`,
      state: observation,
      family: "other",
      lifecycleStep: "observed",
      isTerminal: false,
      requiresCustomerAction: false,
      observedAt: isoTimestamp(now),
      provenanceSource: "PROVIDER_API",
    });
    const evidence: ProviderExecutionEvidenceDraft = railEvidence({
      evidenceId,
      evidenceRef: `external_funds:${observation.location.accountRef}`,
      kind: "STATE_OBSERVATION",
      providerState: envelope,
      recordedAt: now,
    });
    return { providerState: envelope, outcome: classifyOutcome(envelope), evidence };
  }
}

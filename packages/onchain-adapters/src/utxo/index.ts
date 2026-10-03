/**
 * @payswap/onchain-adapters — UTXO family adapter (P4-W2-001).
 *
 * Speaks the Esplora-style REST explorer API through the vendor-neutral
 * transport port (public Bitcoin mainnet explorers: Blockstream +
 * mempool.emzy.de; no vendor SDK). Every lifecycle stage is explicit, and
 * the one stage the family CANNOT express — SIMULATION — is declared
 * unsupported and FAILS CLOSED (UTXO rails expose no state-transition
 * simulation without wallet-side transaction construction; approximating it
 * is forbidden by the work order):
 *
 * - observe:          /blocks/tip/height + /blocks/tip/hash → chain-head
 *                     observation; /address/:addr → UTXO set sums as asset
 *                     position OBSERVATIONS (INV-C09).
 * - prepare:          genesis-block verification (/block-height/0 against
 *                     the well-known genesis hash — structural chain
 *                     identity) + fee-rate derivation (/fee-estimates, exact
 *                     decimal text, no float arithmetic) + declared
 *                     MempoolPolicy (BIP-125 opt-in RBF / CPFP, provenanced).
 * - simulate:         UNSUPPORTED (declared; throws
 *                     UnsupportedLifecycleStageError — the kernel runs
 *                     gate-only from PREPARED).
 * - authorize:        inherited — drives the onchain-security kernel; the
 *                     UTXO SignerAdapter port produces the authorization
 *                     signing envelope (PSBT composition + signing belong to
 *                     the trusted surface).
 * - broadcast:        POST /tx (the surface-signed raw hex) with the
 *                     deterministic explorer-rejection classification table;
 *                     unclassified errors and transport failure after
 *                     submission → OUTCOME_UNKNOWN (INV-X01).
 * - observe (result): /tx/:txid/status with depth-based confirmation and
 *                     reorg detection (the containing block's hash is
 *                     re-observed; a vanished/changed confirmation →
 *                     OUTCOME_UNKNOWN).
 * - finality:         confirmation depth (tip − height + 1) against the
 *                     declared depth guidance (candidates only, INV-F06).
 */

import { ValidationError } from "@payswap/protocol";
import type { OnchainExecutionDirective } from "@payswap/onchain-domain";
import type { SignerAdapter } from "@payswap/onchain-security";
import { BaseChainFamilyAdapter } from "../lifecycle.js";
import type {
  AssetPositionProbe,
  BroadcastStageInput,
  BroadcastStageOutcome,
  ChainHeadProbe,
  ChainHeadObservation,
  ObserveResultInput,
  PrepareStageInput,
  PreparedAdapterOperation,
} from "../contract.js";
import { ChainIdentityMismatchError, UnsupportedLifecycleStageError } from "../errors.js";
import type { UtxoFeeSemantics, UtxoSemanticsProfile } from "../semantics.js";
import type { EndpointProfile, RestTransport } from "../transport.js";

// ---------------------------------------------------------------------------
// Well-known Bitcoin chain identities (public constants — never secrets)
// ---------------------------------------------------------------------------

/**
 * Well-known Bitcoin genesis block hashes per chainKey (provenance: observed
 * from the public explorer APIs on 2026-10-03 during P4-W2-001 development;
 * the mainnet genesis hash is the historically famous constant).
 */
export const BITCOIN_GENESIS_HASHES: Readonly<Record<string, string>> = Object.freeze({
  "bitcoin:mainnet": "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f",
  "bitcoin:testnet": "000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943",
});

/**
 * PUBLIC production endpoint profiles for Bitcoin mainnet (Esplora-style
 * REST; provider diversity: Blockstream + mempool.emzy.de — no single
 * vendor). Read-only observation; broadcast POST is fixture-proven only.
 */
export const BITCOIN_MAINNET_PUBLIC_ENDPOINTS: readonly EndpointProfile[] = Object.freeze([
  {
    endpointId: "bitcoin-mainnet-blockstream",
    providerName: "Blockstream",
    url: "https://blockstream.info/api",
    protocol: "REST",
    chainKey: "bitcoin:mainnet",
  },
  {
    endpointId: "bitcoin-mainnet-emzy",
    providerName: "mempool.emzy.de",
    url: "https://mempool.emzy.de/api",
    protocol: "REST",
    chainKey: "bitcoin:mainnet",
  },
]);

/** PUBLIC testnet endpoint profiles (Blockstream testnet esplora). */
export const BITCOIN_TESTNET_PUBLIC_ENDPOINTS: readonly EndpointProfile[] = Object.freeze([
  {
    endpointId: "bitcoin-testnet-blockstream",
    providerName: "Blockstream",
    url: "https://blockstream.info/testnet/api",
    protocol: "REST",
    chainKey: "bitcoin:testnet",
  },
]);

/**
 * The declared Bitcoin mempool policy (explicit, provenanced — never
 * observed, never assumed): BIP-125 opt-in RBF and CPFP are documented
 * Bitcoin Core relay/mempool policies.
 */
export const BITCOIN_MEMPOOL_POLICY: Readonly<{
  replacement: "BIP125_OPT_IN";
  cpfp: "SUPPORTED";
  declaredBy: string;
}> = Object.freeze({
  replacement: "BIP125_OPT_IN",
  cpfp: "SUPPORTED",
  declaredBy: "BIP-125 (Opt-in Full Replace-by-Fee Signaling) + Bitcoin Core mempool policy documentation",
});

// ---------------------------------------------------------------------------
// The UTXO family execution plan (prepare output)
// ---------------------------------------------------------------------------

/** The UTXO family execution plan (adapter-owned, opaque to the core). */
export interface UtxoExecutionPlan {
  readonly family: "UTXO";
  /** Genesis hash observed at prepare (cross-checked against the registry). */
  readonly observedGenesisHash: string;
  /** Destination address (the directive destination). */
  readonly destination: string;
  /** Exact amount in satoshi (integer decimal string). */
  readonly amountSat: string;
  readonly fee: UtxoFeeSemantics | { readonly expressible: false; readonly reason: string };
  /** The tip the plan was prepared against. */
  readonly tipAtPrepare: { readonly height: number; readonly headHash: string };
}

// ---------------------------------------------------------------------------
// The UTXO signing-envelope SignerAdapter (port implementation)
// ---------------------------------------------------------------------------

/**
 * The UTXO SignerAdapter port implementation: builds the AUTHORIZATION
 * signing envelope (deterministic JSON binding of the kernel artifact). The
 * PSBT composition, input selection and signing belong to the trusted
 * surface (which owns the signer) — this SDK never signs (rule 25).
 */
export class UtxoSigningEnvelopeAdapter implements SignerAdapter {
  readonly adapterId: string;
  readonly supportedChains: readonly string[];

  constructor(input: { readonly adapterId: string; readonly chainKey: string }) {
    this.adapterId = input.adapterId;
    this.supportedChains = Object.freeze([input.chainKey]);
  }

  buildSigningPayload(input: {
    readonly artifact: Parameters<SignerAdapter["buildSigningPayload"]>[0]["artifact"];
    readonly request: Parameters<SignerAdapter["buildSigningPayload"]>[0]["request"];
  }): string {
    const write = input.request.write;
    const envelope = {
      kind: "payswap.utxo.signing-envelope",
      version: 1,
      authorizationRef: input.artifact.requestHash,
      writeDigest: input.artifact.scope.writeDigest,
      chain: write.chain,
      action: write.action,
      expiry: write.expiry,
      ...(write.transfer !== undefined
        ? {
            destination: write.transfer.to,
            assetId: write.transfer.asset.assetId,
            amountMinorUnits: write.transfer.amount.minorUnits,
          }
        : {}),
    };
    return JSON.stringify(envelope);
  }
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

/** UTXO adapter construction declaration. */
export interface UtxoAdapterDeclaration {
  readonly adapterId: string;
  /** E.g. `bitcoin:mainnet` — environment is DERIVED (structural). */
  readonly chainKey: string;
  readonly transport: RestTransport;
  /** Declared BTC asset binding symbol. */
  readonly nativeAssetSymbol?: string;
  /** Declared confirmation-depth guidance (e.g. 6). */
  readonly confirmationDepthTarget: number;
  /** Declared fee-estimate confirmation-target bucket (e.g. 6 blocks). */
  readonly feeEstimateTargetBlocks?: number;
  /** Head freshness window (seconds; default 600 = ~100 minutes). */
  readonly maxHeadAgeSeconds?: number;
}

const EXACT_SATOSHI = /^(0|[1-9][0-9]*)$/;

/**
 * The UTXO family adapter: native BTC transfers (exact integer satoshi).
 * UTXO consolidation/coin-selection and token protocols are NOT declared in
 * this wave — undeclared semantics fail closed rather than approximating.
 * SIMULATION is structurally unsupported and fails closed.
 */
export class UtxoChainAdapter extends BaseChainFamilyAdapter<
  "PRODUCTION" | "TESTNET" | "REGTEST",
  UtxoExecutionPlan
> {
  readonly #transport: RestTransport;
  readonly #symbol: string;
  readonly #assetId: string;
  readonly #maxHeadAgeSeconds: number;
  readonly #feeEstimateTargetBlocks: number;
  #signerEnvelope: UtxoSigningEnvelopeAdapter;

  constructor(declaration: UtxoAdapterDeclaration) {
    super({
      adapterId: declaration.adapterId,
      chainKey: declaration.chainKey,
      family: "UTXO",
      lifecycle: {
        observe: true,
        prepare: true,
        // EXPLICIT unsupported stage: UTXO rails expose no simulation —
        // this fails closed (UnsupportedLifecycleStageError) instead of
        // approximating. The kernel supports gate-only preparation.
        simulate: false,
        authorize: true,
        broadcast: true,
        observeResult: true,
        finality: true,
        reconcile: true,
        evidence: true,
      },
      semantics: {
        family: "UTXO",
        fee: {
          expressible: false,
          reason: "fee parameters not yet observed — derived at prepare from the explorer's fee-estimates feed (exact decimal text)",
        },
        finality: {
          family: "UTXO",
          finalityModel: "PROBABILISTIC",
          confirmationDepthTarget: declaration.confirmationDepthTarget,
          reorgDetection: "BLOCK_HASH_OBSERVATION",
        },
      },
    });
    this.#transport = declaration.transport;
    this.#symbol = declaration.nativeAssetSymbol ?? "BTC";
    this.#assetId = `${this.chainKey}/asset:${this.#symbol}`;
    this.#maxHeadAgeSeconds = declaration.maxHeadAgeSeconds ?? 600;
    this.#feeEstimateTargetBlocks = declaration.feeEstimateTargetBlocks ?? 6;
    this.#signerEnvelope = new UtxoSigningEnvelopeAdapter({
      adapterId: declaration.adapterId,
      chainKey: this.chainKey,
    });
  }

  // ------------------------------------------------------------------
  // identity resolution (family-owned)
  // ------------------------------------------------------------------

  protected resolveAssetIdentity(assetId: string): { symbol: string; nativeAssetRef: string } {
    if (assetId !== this.#assetId) {
      throw new ValidationError(
        `assetId '${assetId}' is not the declared native BTC binding '${this.#assetId}' on '${this.chainKey}' — token/colored-coin semantics are not declared in this wave and fail closed (never approximated)`,
      );
    }
    return { symbol: this.#symbol, nativeAssetRef: "native:satoshi" };
  }

  protected assertOperationSupported(operation: OnchainExecutionDirective["operation"]): void {
    if (operation === "onchain.transfer") {
      return;
    }
    throw new ValidationError(
      `the UTXO family does not declare support for operation '${operation}' (no allowance model on UTXO rails) — unsupported operations fail closed, never approximated`,
    );
  }

  protected transportProviderNames(): readonly string[] {
    return [...new Set(this.#transport.endpoints().map((endpoint) => endpoint.providerName))];
  }

  protected confirmationDepth(
    observation: { readonly executionRef: string; readonly finalityCandidate?: { readonly confirmationDepth?: number } },
    head: ChainHeadObservation,
  ): number {
    const anchor = this.confirmationAnchor(observation.executionRef);
    if (anchor !== undefined) {
      return Math.max(0, head.height - anchor.height + 1);
    }
    return observation.finalityCandidate?.confirmationDepth ?? 0;
  }

  // ------------------------------------------------------------------
  // observe stage
  // ------------------------------------------------------------------

  async observeChainHead(input: {
    readonly at: string;
    readonly maxAgeSeconds?: number;
  }): Promise<ChainHeadProbe> {
    const height = await this.#transport.get("/blocks/tip/height");
    if (height.kind !== "REST_OK") {
      return this.#unreachableHead(height.message);
    }
    const parsedHeight = Number(height.body);
    if (!Number.isSafeInteger(parsedHeight) || parsedHeight < 0) {
      return this.#unreachableHead("the tip height is not a safe integer");
    }
    const hash = await this.#transport.get("/blocks/tip/hash");
    if (hash.kind !== "REST_OK" || typeof hash.body !== "string" || hash.body.length === 0) {
      return this.#unreachableHead(hash.kind === "REST_OK" ? "the tip hash is not a string" : hash.message);
    }
    const atMs = Date.parse(input.at);
    const head: ChainHeadObservation = Object.freeze({
      observationKind: "ChainHeadObservation",
      chainKey: this.chainKey,
      environmentClass: this.environment.environmentClass,
      height: parsedHeight,
      headHash: hash.body,
      observedAt: input.at,
      provenance: this.buildProvenance(hash.servedBy, atMs),
      maxAgeSeconds: input.maxAgeSeconds ?? this.#maxHeadAgeSeconds,
    });
    this.logEvidence("chain-head", "observe", atMs, [head.headHash, String(head.height)]);
    return { kind: "HEAD_OBSERVED", head };
  }

  #unreachableHead(message: string): ChainHeadProbe {
    return {
      kind: "RAIL_UNREACHABLE",
      availability: "UNKNOWN",
      chainKey: this.chainKey,
      transportId: this.#transport.transportId,
      attemptedEndpointIds: this.#transport.endpoints().map((endpoint) => endpoint.endpointId),
      message: `UTXO tip unobservable: ${message} — reachability UNKNOWN, never success/failure (INV-C02)`,
      at: new Date().toISOString(),
    };
  }

  async observeAssetPosition(input: {
    readonly accountRef: string;
    readonly assetId: string;
    readonly at: string;
    readonly maxAgeSeconds?: number;
  }): Promise<AssetPositionProbe> {
    if (input.assetId !== this.#assetId) {
      return {
        kind: "POSITION_UNOBSERVABLE",
        reason: "ASSET_BINDING_UNKNOWN",
        message: `assetId '${input.assetId}' is not the declared native BTC binding '${this.#assetId}' — colored-coin/asset semantics are not declared in this wave (fail closed)`,
        chainKey: this.chainKey,
        at: input.at,
      };
    }
    const address = await this.#transport.get(`/address/${input.accountRef}`);
    if (address.kind === "TRANSPORT_UNREACHABLE") {
      return {
        kind: "POSITION_UNOBSERVABLE",
        reason: "RAIL_UNREACHABLE",
        message: `address observation failed for '${input.accountRef}': ${address.message}`,
        chainKey: this.chainKey,
        at: input.at,
      };
    }
    if (address.kind === "REST_ERROR") {
      return {
        kind: "POSITION_UNOBSERVABLE",
        reason: address.status === 400 || address.status === 404 ? "PROVIDER_REJECTED_ACCOUNT" : "RAIL_UNREACHABLE",
        message: `address observation failed for '${input.accountRef}': ${address.message}`,
        chainKey: this.chainKey,
        at: input.at,
      };
    }
    const stats = (address.body as { chain_stats?: { funded_txo_sum?: unknown; spent_txo_sum?: unknown } })
      ?.chain_stats;
    const funded = stats?.funded_txo_sum;
    const spent = stats?.spent_txo_sum;
    if (typeof funded !== "number" || typeof spent !== "number" || !Number.isSafeInteger(funded) || !Number.isSafeInteger(spent)) {
      return {
        kind: "POSITION_UNOBSERVABLE",
        reason: "PROVIDER_REJECTED_ACCOUNT",
        message: `the explorer returned non-exact UTXO-set sums for '${input.accountRef}' — a lossy observation is never fabricated (INV-F01 discipline)`,
        chainKey: this.chainKey,
        at: input.at,
      };
    }
    // Total bitcoin supply (2.1e15 sat) is within safe-integer range, so the
    // funded−spent difference is exact for any real address.
    const minorUnits = String(funded - spent);
    if (!EXACT_SATOSHI.test(minorUnits)) {
      return {
        kind: "POSITION_UNOBSERVABLE",
        reason: "PROVIDER_REJECTED_ACCOUNT",
        message: `the observed UTXO-set sums are inconsistent (spent exceeds funded) for '${input.accountRef}' — never observed as a negative balance`,
        chainKey: this.chainKey,
        at: input.at,
      };
    }
    const atMs = Date.parse(input.at);
    const observation = {
      observationKind: "AssetObservation" as const,
      observationId: `asset-obs:${this.adapterId}:${this.#assetId}:${minorUnits}`,
      observedAt: input.at,
      assetId: this.#assetId,
      chainKey: this.chainKey,
      location: { chainKey: this.chainKey, accountRef: input.accountRef },
      observedAmount: { currency: this.#assetId, minorUnits },
      freshness: { asOf: input.at, maxAgeSeconds: input.maxAgeSeconds ?? 120 },
      provenance: {
        providerName: address.servedBy.providerName,
        source: "PROVIDER_API" as const,
        capturedAt: input.at,
      },
      observer: { observerId: this.adapterId, observerKind: "INDEXER" as const },
    };
    this.logEvidence(`position:${this.#assetId}:${input.accountRef}`, "observe", atMs, [
      observation.observationId,
    ]);
    return { kind: "POSITION_OBSERVED", observation };
  }

  // ------------------------------------------------------------------
  // prepare stage
  // ------------------------------------------------------------------

  async prepare(input: PrepareStageInput): Promise<PreparedAdapterOperation<UtxoExecutionPlan>> {
    const prologue = this.preparePrologue(input);
    const atMs = input.at;

    // Structural chain identity: the explorer's genesis block must match the
    // well-known genesis hash for this chainKey.
    const genesis = await this.#transport.get("/block-height/0");
    if (genesis.kind !== "REST_OK" || typeof genesis.body !== "string") {
      throw new ChainIdentityMismatchError(
        `the genesis block is unobservable on '${this.chainKey}' — prepare fails closed when chain identity cannot be verified`,
      );
    }
    const observedGenesisHash = genesis.body;
    const declared = BITCOIN_GENESIS_HASHES[this.chainKey];
    if (declared !== undefined && declared !== observedGenesisHash) {
      throw new ChainIdentityMismatchError(
        `the explorer serving '${this.chainKey}' reports genesis hash '${observedGenesisHash}', but the well-known genesis is '${declared}' — chain confusion fails closed`,
      );
    }

    // Fee derivation: the exact decimal text of the declared estimate bucket
    // (no float arithmetic; the rate is a quote, not money).
    const fee = await this.#deriveFeeRate();
    this.refreshSemantics({
      family: "UTXO",
      fee,
      finality: this.semantics.finality as UtxoSemanticsProfile["finality"],
    });

    const amountSat = prologue.directive.amount?.minorUnits as string;
    if (typeof amountSat !== "string" || !EXACT_SATOSHI.test(amountSat)) {
      throw new ValidationError("a UTXO transfer requires an exact integer satoshi amount (INV-F01)");
    }

    const plan: UtxoExecutionPlan = {
      family: "UTXO",
      observedGenesisHash,
      destination: prologue.directive.destination as string,
      amountSat,
      fee: this.semantics.fee as UtxoExecutionPlan["fee"],
      tipAtPrepare: { height: input.head.height, headHash: input.head.headHash },
    };
    return this.freezePrepared({
      operationKind: "PreparedAdapterOperation",
      directive: prologue.directive,
      writeRequest: prologue.writeRequest,
      writeDigest: prologue.writeDigest,
      familyPlan: plan,
      preparedAt: atMs,
      evidenceRefs: prologue.evidenceRefs,
    });
  }

  /**
   * Derives the fee rate from the explorer's /fee-estimates feed: the EXACT
   * DECIMAL TEXT of the declared confirmation-target bucket is extracted
   * from the raw response (no float arithmetic, verbatim provider text with
   * provenance). A missing bucket is an explicit inexpressible semantic.
   */
  async #deriveFeeRate(): Promise<UtxoExecutionPlan["fee"]> {
    const estimates = await this.#transport.get("/fee-estimates");
    if (estimates.kind !== "REST_OK") {
      return {
        expressible: false,
        reason: `the fee-estimates feed is unreachable ('${estimates.message}') — SATOSHI_PER_VBYTE semantics are not expressible and fail closed (never approximated)`,
      };
    }
    const raw = estimates.raw;
    const bucket = String(this.#feeEstimateTargetBlocks);
    // Extract the bucket's numeric text verbatim (no JSON float round-trip).
    const pattern = new RegExp(`"${bucket}"\\s*:\\s*([0-9]+(?:\\.[0-9]+)?)`);
    const match = pattern.exec(raw);
    if (match === null) {
      return {
        expressible: false,
        reason: `the fee-estimates feed has no '${bucket}'-block bucket — the declared fee-estimate target is not expressible and fails closed (never substituted with another bucket)`,
      };
    }
    return {
      family: "UTXO",
      expressible: true,
      feeModel: "SATOSHI_PER_VBYTE",
      feeRateSatPerVByte: match[1] as string,
      estimateTargetBlocks: this.#feeEstimateTargetBlocks,
      mempoolPolicy: { ...BITCOIN_MEMPOOL_POLICY },
    };
  }

  // ------------------------------------------------------------------
  // simulate stage — STRUCTURALLY UNSUPPORTED (fail closed)
  // ------------------------------------------------------------------

  simulate(): never {
    throw new UnsupportedLifecycleStageError(
      this.adapterId,
      "simulate",
      "UTXO rails expose no state-transition simulation without wallet-side transaction construction — simulation is structurally unsupported for this family and fails closed (never approximated); the security kernel supports gate-only preparation",
    );
  }

  // ------------------------------------------------------------------
  // broadcast stage
  // ------------------------------------------------------------------

  protected signerAdapter(): UtxoSigningEnvelopeAdapter {
    return this.#signerEnvelope;
  }

  async broadcast(input: BroadcastStageInput): Promise<BroadcastStageOutcome> {
    this.assertBroadcastable(input);
    const submission = await this.#transport.post("/tx", input.signedPayload, "text/plain");
    if (submission.kind === "REST_OK") {
      const txid = typeof submission.body === "string" ? submission.body.trim() : "";
      if (txid.length === 0 || !/^[0-9a-f]{64}$/.test(txid)) {
        return this.buildExecutionObservation({
          executionRef: input.executionRef,
          observedAt: input.at,
          outcome: "OUTCOME_UNKNOWN",
          unknownReason:
            "the explorer accepted the submission but returned a non-txid body — it is unknown whether the operation reached the chain (INV-X01)",
          evidenceRefs: [this.logEvidence(input.executionRef, "broadcast", input.at, ["submission:malformed-result"])],
          servedBy: submission.servedBy,
        });
      }
      return this.buildExecutionObservation({
        executionRef: input.executionRef,
        observedAt: input.at,
        outcome: "BROADCAST",
        externalOperationRef: txid,
        evidenceRefs: [this.logEvidence(input.executionRef, "broadcast", input.at, [`txid:${txid}`])],
        servedBy: submission.servedBy,
      });
    }
    if (submission.kind === "TRANSPORT_UNREACHABLE") {
      return this.buildExecutionObservation({
        executionRef: input.executionRef,
        observedAt: input.at,
        outcome: "OUTCOME_UNKNOWN",
        unknownReason:
          "transport unreachable after the submission attempt: it is unknown whether the operation reached the chain (INV-X01 — never classified as failure)",
        evidenceRefs: [this.logEvidence(input.executionRef, "broadcast", input.at, ["submission:transport-unreachable"])],
        servedBy: { transportId: this.#transport.transportId, endpointId: "none", providerName: "unreachable" },
      });
    }
    const message = submission.message.toLowerCase();
    const bodyText = typeof submission.body === "string" ? submission.body.toLowerCase() : "";
    if (
      message.includes("already") ||
      bodyText.includes("txn-already-in-mempool") ||
      bodyText.includes("already in utxo pool") ||
      bodyText.includes("txn-already-known")
    ) {
      return this.buildExecutionObservation({
        executionRef: input.executionRef,
        observedAt: input.at,
        outcome: "BROADCAST",
        evidenceRefs: [this.logEvidence(input.executionRef, "broadcast", input.at, ["submission:already-known"])],
        servedBy: submission.servedBy,
      });
    }
    if (
      message.includes("insufficient") ||
      bodyText.includes("insufficient fee") ||
      bodyText.includes("bad-txns-fee") ||
      bodyText.includes("min relay fee")
    ) {
      return this.buildExecutionObservation({
        executionRef: input.executionRef,
        observedAt: input.at,
        outcome: "FAILED",
        failure: {
          failureClass: "REJECTED",
          description: `the explorer definitively rejected the submission (mempool fee policy): ${submission.message}`,
          retryGuidance: "SAFE_TO_RETRY",
        },
        evidenceRefs: [this.logEvidence(input.executionRef, "broadcast", input.at, ["rejection:fee-policy"])],
        servedBy: submission.servedBy,
      });
    }
    if (bodyText.includes("dust") || message.includes("dust")) {
      return this.buildExecutionObservation({
        executionRef: input.executionRef,
        observedAt: input.at,
        outcome: "FAILED",
        failure: {
          failureClass: "REJECTED",
          description: `the explorer definitively rejected the submission (dust limit): ${submission.message}`,
          retryGuidance: "NOT_RETRYABLE",
        },
        evidenceRefs: [this.logEvidence(input.executionRef, "broadcast", input.at, ["rejection:dust"])],
        servedBy: submission.servedBy,
      });
    }
    return this.buildExecutionObservation({
      executionRef: input.executionRef,
      observedAt: input.at,
      outcome: "OUTCOME_UNKNOWN",
      unknownReason: `unclassified explorer response after the submission attempt ('${submission.message}'): it is unknown whether the operation reached the chain (INV-X01)`,
      evidenceRefs: [this.logEvidence(input.executionRef, "broadcast", input.at, ["submission:unclassified"])],
      servedBy: submission.servedBy,
    });
  }

  // ------------------------------------------------------------------
  // observe (result) stage
  // ------------------------------------------------------------------

  async observeOperation(input: ObserveResultInput): Promise<BroadcastStageOutcome> {
    const status = await this.#transport.get(`/tx/${input.externalOperationRef}/status`);
    if (status.kind === "REST_ERROR" && (status.status === 400 || status.status === 404)) {
      // The reference is not visible to this explorer: evicted from mempool,
      // reorged out, or never propagated — ambiguous, never fabricated.
      if (input.prior?.outcome === "CONFIRMED") {
        return this.buildExecutionObservation({
          executionRef: input.executionRef,
          observedAt: input.at,
          externalOperationRef: input.externalOperationRef,
          outcome: "OUTCOME_UNKNOWN",
          unknownReason:
            "broadcast-then-reorg: the transaction VANISHED from the explorer after a prior CONFIRMED observation (the containing block was reorganized away) — the outcome is ambiguous and requires reconciliation (INV-X01)",
          evidenceRefs: [this.logEvidence(input.executionRef, "observeResult", input.at, ["reorg:tx-vanished"])],
          servedBy: status.servedBy,
        });
      }
      return this.buildExecutionObservation({
        executionRef: input.executionRef,
        observedAt: input.at,
        externalOperationRef: input.externalOperationRef,
        outcome: "OUTCOME_UNKNOWN",
        unknownReason:
          "the transaction reference is not visible to the explorer (evicted from mempool, reorged out, or not yet propagated) — an unobserved reference is UNKNOWN, never a fabricated failure or success (INV-X01/INV-C02)",
        evidenceRefs: [this.logEvidence(input.executionRef, "observeResult", input.at, ["status:reference-unobserved"])],
        servedBy: status.servedBy,
      });
    }
    if (status.kind === "TRANSPORT_UNREACHABLE" || status.kind === "REST_ERROR") {
      return this.buildExecutionObservation({
        executionRef: input.executionRef,
        observedAt: input.at,
        externalOperationRef: input.externalOperationRef,
        outcome: "OUTCOME_UNKNOWN",
        unknownReason:
          status.kind === "TRANSPORT_UNREACHABLE"
            ? "the transaction status is unobservable (rail unreachable) — the outcome is UNKNOWN, not failed (INV-C02/INV-X01)"
            : `unclassified explorer error observing the status ('${status.message}') — the outcome is UNKNOWN (INV-X01)`,
        evidenceRefs: [this.logEvidence(input.executionRef, "observeResult", input.at, ["status:unobservable"])],
        servedBy: status.kind === "TRANSPORT_UNREACHABLE"
          ? { transportId: this.#transport.transportId, endpointId: "none", providerName: "unreachable" }
          : status.servedBy,
      });
    }
    const record = status.body as { confirmed?: unknown; block_height?: unknown; block_hash?: unknown } | null;
    if (record === null || typeof record !== "object" || typeof record.confirmed !== "boolean") {
      return this.buildExecutionObservation({
        executionRef: input.executionRef,
        observedAt: input.at,
        externalOperationRef: input.externalOperationRef,
        outcome: "OUTCOME_UNKNOWN",
        unknownReason:
          "the status body is malformed (no confirmed flag) — a malformed status is UNKNOWN, never converted (INV-X01)",
        evidenceRefs: [this.logEvidence(input.executionRef, "observeResult", input.at, ["status:malformed"])],
        servedBy: status.servedBy,
      });
    }
    if (!record.confirmed) {
      return this.buildExecutionObservation({
        executionRef: input.executionRef,
        observedAt: input.at,
        externalOperationRef: input.externalOperationRef,
        outcome: "BROADCAST",
        evidenceRefs: [this.logEvidence(input.executionRef, "observeResult", input.at, ["status:in-mempool"])],
        servedBy: status.servedBy,
      });
    }
    const blockHeight = record.block_height;
    const blockHash = record.block_hash;
    if (typeof blockHeight !== "number" || !Number.isSafeInteger(blockHeight) || typeof blockHash !== "string") {
      return this.buildExecutionObservation({
        executionRef: input.executionRef,
        observedAt: input.at,
        externalOperationRef: input.externalOperationRef,
        outcome: "OUTCOME_UNKNOWN",
        unknownReason:
          "the confirmed status carries no locatable block (missing/invalid block_height or block_hash) — an unlocatable confirmation is UNKNOWN, never finalized (INV-X01)",
        evidenceRefs: [this.logEvidence(input.executionRef, "observeResult", input.at, ["status:unlocatable"])],
        servedBy: status.servedBy,
      });
    }

    // Reorg detection: the remembered containing block must still match.
    const anchor = this.confirmationAnchor(input.executionRef) ??
      (input.prior?.outcome === "CONFIRMED" ? { height: blockHeight, headHash: blockHash } : undefined);
    if (anchor !== undefined && (anchor.height !== blockHeight || anchor.headHash !== blockHash)) {
      return this.buildExecutionObservation({
        executionRef: input.executionRef,
        observedAt: input.at,
        externalOperationRef: input.externalOperationRef,
        outcome: "OUTCOME_UNKNOWN",
        unknownReason: `broadcast-then-reorg: the transaction's containing block changed (was height ${anchor.height}/${anchor.headHash}, now ${blockHeight}/${blockHash}) — the outcome is ambiguous and requires reconciliation (INV-X01)`,
        evidenceRefs: [this.logEvidence(input.executionRef, "observeResult", input.at, ["reorg:containing-block-changed"])],
        servedBy: status.servedBy,
      });
    }

    const tip = await this.#transport.get("/blocks/tip/height");
    if (tip.kind !== "REST_OK") {
      return this.buildExecutionObservation({
        executionRef: input.executionRef,
        observedAt: input.at,
        externalOperationRef: input.externalOperationRef,
        outcome: "OUTCOME_UNKNOWN",
        unknownReason: "the tip is unobservable while locating the confirmation — depth cannot be computed, so the outcome is UNKNOWN (INV-X01)",
        evidenceRefs: [this.logEvidence(input.executionRef, "observeResult", input.at, ["tip:unobservable"])],
        servedBy: status.servedBy,
      });
    }
    const tipHeight = Number(tip.body);
    if (!Number.isSafeInteger(tipHeight)) {
      return this.buildExecutionObservation({
        executionRef: input.executionRef,
        observedAt: input.at,
        externalOperationRef: input.externalOperationRef,
        outcome: "OUTCOME_UNKNOWN",
        unknownReason: "the observed tip height is not a safe integer — inconsistent provider data is UNKNOWN (INV-X01)",
        evidenceRefs: [this.logEvidence(input.executionRef, "observeResult", input.at, ["tip:malformed"])],
        servedBy: status.servedBy,
      });
    }
    if (blockHeight > tipHeight) {
      // Finalize-ambiguous: a confirmation above the tip is inconsistent.
      return this.buildExecutionObservation({
        executionRef: input.executionRef,
        observedAt: input.at,
        externalOperationRef: input.externalOperationRef,
        outcome: "OUTCOME_UNKNOWN",
        unknownReason: `the confirmation claims block ${blockHeight} above the observed tip ${tipHeight} — inconsistent provider data is UNKNOWN, never finalized (INV-X01)`,
        evidenceRefs: [this.logEvidence(input.executionRef, "observeResult", input.at, ["status:above-tip"])],
        servedBy: status.servedBy,
      });
    }
    const depth = tipHeight - blockHeight + 1;
    this.rememberConfirmationAnchor(input.executionRef, { height: blockHeight, headHash: blockHash });
    return this.buildExecutionObservation({
      executionRef: input.executionRef,
      observedAt: input.at,
      externalOperationRef: input.externalOperationRef,
      outcome: "CONFIRMED",
      finalityCandidate: {
        candidateOnly: true,
        requiresProtocolFinality: true,
        confirmationDepth: depth,
        finalityModel: "PROBABILISTIC",
        reorgDetected: false,
      },
      evidenceRefs: [this.logEvidence(input.executionRef, "observeResult", input.at, [`status:confirmed:depth-${depth}`])],
      servedBy: status.servedBy,
    });
  }
}

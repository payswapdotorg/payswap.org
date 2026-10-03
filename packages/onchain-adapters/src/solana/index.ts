/**
 * @payswap/onchain-adapters — Solana family adapter (P4-W2-001).
 *
 * Speaks plain JSON-RPC 2.0 (Solana RPC methods) through the vendor-neutral
 * transport port. Public mainnet-beta endpoints work; no vendor SDK. Every
 * lifecycle stage is explicit:
 *
 * - observe:          getSlot + getLatestBlockhash → chain-head observation
 *                     (height = slot, headHash = latest blockhash);
 *                     getBalance → SOL positions AS OBSERVATIONS (INV-C09).
 * - prepare:          getGenesisHash cross-check (cluster-identity defense) +
 *                     getLatestBlockhash validity window + fee derivation via
 *                     getFeeForMessage on a minimal 1-signature message built
 *                     from the DECODED blockhash (exact integer lamports).
 * - simulate:         simulateTransaction over the trusted-surface-composed
 *                     serialized transaction (familyPayload carries it);
 *                     absent input FAILS CLOSED — a simulation is never
 *                     fabricated.
 * - authorize:        inherited — drives the onchain-security kernel; the
 *                     Solana SignerAdapter port produces the authorization
 *                     signing envelope (the real transaction is composed and
 *                     signed at the trusted surface — this SDK never signs).
 * - broadcast:        sendTransaction with the deterministic Solana
 *                     node-rejection classification table; unclassified
 *                     errors and transport failure after submission →
 *                     OUTCOME_UNKNOWN (INV-X01).
 * - observe (result): getSignatureStatuses with fork detection — a prior
 *                     CONFIRMED status that disappears or moves to a
 *                     different slot → OUTCOME_UNKNOWN (fork/reorg ambiguity).
 * - finality:         slot-depth confirmation against the declared guidance
 *                     and commitment level (candidates only, INV-F06).
 */

import { ValidationError } from "@payswap/protocol";
import type { OnchainExecutionDirective } from "@payswap/onchain-domain";
import { recordSimulation } from "@payswap/onchain-security";
import type { SimulationObservation, SignerAdapter } from "@payswap/onchain-security";
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
import { ChainIdentityMismatchError, SemanticNotExpressibleError } from "../errors.js";
import type { SolanaFeeSemantics, SolanaSemanticsProfile } from "../semantics.js";
import type { EndpointProfile, RpcTransport } from "../transport.js";

// ---------------------------------------------------------------------------
// Well-known Solana cluster identities (public constants — never secrets)
// ---------------------------------------------------------------------------

/**
 * Well-known Solana genesis hashes per chainKey (provenance: observed from
 * the public cluster RPCs on 2026-10-03 during P4-W2-001 development).
 */
export const SOLANA_GENESIS_HASHES: Readonly<Record<string, string>> = Object.freeze({
  "solana:mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  "solana:devnet": "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
});

/**
 * PUBLIC production endpoint profiles for Solana mainnet-beta (provider
 * diversity: Solana Labs + PublicNode — no single vendor). Read-only.
 */
export const SOLANA_MAINNET_PUBLIC_ENDPOINTS: readonly EndpointProfile[] = Object.freeze([
  {
    endpointId: "solana-mainnet-labs",
    providerName: "Solana Labs",
    url: "https://api.mainnet-beta.solana.com",
    protocol: "JSON_RPC",
    chainKey: "solana:mainnet-beta",
  },
  {
    endpointId: "solana-mainnet-publicnode",
    providerName: "PublicNode",
    url: "https://solana-rpc.publicnode.com",
    protocol: "JSON_RPC",
    chainKey: "solana:mainnet-beta",
  },
]);

/** PUBLIC devnet endpoint profiles (testnet-class; diversity exempt). */
export const SOLANA_DEVNET_PUBLIC_ENDPOINTS: readonly EndpointProfile[] = Object.freeze([
  {
    endpointId: "solana-devnet-labs",
    providerName: "Solana Labs",
    url: "https://api.devnet.solana.com",
    protocol: "JSON_RPC",
    chainKey: "solana:devnet",
  },
]);

// ---------------------------------------------------------------------------
// base58 (pure, dependency-free — blockhash decoding for message building)
// ---------------------------------------------------------------------------

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Decodes a base58 string into bytes (pure BigInt arithmetic). */
export function base58Decode(value: string): Uint8Array {
  if (value.length === 0) {
    throw new ValidationError("base58 input must be non-empty");
  }
  const index = new Map<string, number>([...BASE58_ALPHABET].map((char, i) => [char, i]));
  let numeric = 0n;
  for (const char of value) {
    const digit = index.get(char);
    if (digit === undefined) {
      throw new ValidationError(`'${char}' is not a base58 character`);
    }
    numeric = numeric * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (numeric > 0n) {
    bytes.unshift(Number(numeric % 256n));
    numeric /= 256n;
  }
  let leading = 0;
  while (leading < value.length && value[leading] === "1") {
    bytes.unshift(0);
    leading += 1;
  }
  return new Uint8Array(bytes);
}

/** Encodes bytes as base58 (pure BigInt arithmetic). */
export function base58Encode(bytes: Uint8Array): string {
  let numeric = 0n;
  for (const byte of bytes) {
    numeric = numeric * 256n + BigInt(byte);
  }
  let encoded = "";
  while (numeric > 0n) {
    encoded = BASE58_ALPHABET[Number(numeric % 58n)] + encoded;
    numeric /= 58n;
  }
  let leading = 0;
  while (leading < bytes.length && bytes[leading] === 0) {
    encoded = "1" + encoded;
    leading += 1;
  }
  return encoded;
}

// ---------------------------------------------------------------------------
// The Solana family execution plan (prepare output)
// ---------------------------------------------------------------------------

/** The Solana family execution plan (adapter-owned, opaque to the core). */
export interface SolanaExecutionPlan {
  readonly family: "SOLANA";
  /** Genesis hash observed at prepare (cross-checked against the registry). */
  readonly observedGenesisHash: string;
  /** Recent blockhash for transaction composition (from getLatestBlockhash). */
  readonly recentBlockhash: string;
  /** The height after which a transaction using the blockhash expires. */
  readonly lastValidBlockHeight: number;
  readonly fee: SolanaFeeSemantics | { readonly expressible: false; readonly reason: string };
  /** The commitment level observations target. */
  readonly commitment: "confirmed" | "finalized";
}

// ---------------------------------------------------------------------------
// The Solana signing-envelope SignerAdapter (port implementation)
// ---------------------------------------------------------------------------

/**
 * The Solana SignerAdapter port implementation: builds the AUTHORIZATION
 * signing envelope (a deterministic JSON binding of the kernel artifact).
 * The actual Solana transaction is composed and signed at the trusted
 * surface (which owns the signer) — this SDK never signs and never sees key
 * material (AGENTS.md rule 25).
 */
export class SolanaSigningEnvelopeAdapter implements SignerAdapter {
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
      kind: "payswap.solana.signing-envelope",
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

/** Solana adapter construction declaration. */
export interface SolanaAdapterDeclaration {
  readonly adapterId: string;
  /** E.g. `solana:mainnet-beta` — environment is DERIVED (structural). */
  readonly chainKey: string;
  readonly transport: RpcTransport;
  /** Declared SOL asset binding (native lamports). */
  readonly nativeAssetSymbol?: string;
  /** Declared slot-confirmation guidance (e.g. 32). */
  readonly slotConfirmationTarget: number;
  /** Declared finality-candidate commitment gate. */
  readonly finalizedCommitment?: "finalized" | "confirmed";
  /** Head freshness window (seconds; default 30). */
  readonly maxHeadAgeSeconds?: number;
}

/** Canonical native SOL binding. */
function nativeSolBinding(chainKey: string, symbol: string): { assetId: string; symbol: string } {
  return { assetId: `${chainKey}/asset:${symbol}`, symbol };
}

/**
 * The Solana family adapter: native SOL transfers (exact integer lamports).
 * Token (SPL) position observation and token transfers are NOT declared in
 * this wave — an undeclared semantic fails closed rather than approximating
 * token accounts.
 */
export class SolanaChainAdapter extends BaseChainFamilyAdapter<
  "PRODUCTION" | "TESTNET",
  SolanaExecutionPlan
> {
  readonly #transport: RpcTransport;
  readonly #symbol: string;
  readonly #assetId: string;
  readonly #maxHeadAgeSeconds: number;
  readonly #commitment: "confirmed" | "finalized";
  #signerEnvelope: SolanaSigningEnvelopeAdapter;

  constructor(declaration: SolanaAdapterDeclaration) {
    super({
      adapterId: declaration.adapterId,
      chainKey: declaration.chainKey,
      family: "SOLANA",
      lifecycle: {
        observe: true,
        prepare: true,
        simulate: true,
        authorize: true,
        broadcast: true,
        observeResult: true,
        finality: true,
        reconcile: true,
        evidence: true,
      },
      semantics: {
        family: "SOLANA",
        fee: {
          expressible: false,
          reason: "fee parameters not yet observed — derived at prepare via getFeeForMessage on a minimal 1-signature message",
        },
        finality: {
          family: "SOLANA",
          finalityModel: "PROBABILISTIC",
          slotConfirmationTarget: declaration.slotConfirmationTarget,
          finalizedCommitment: declaration.finalizedCommitment ?? "finalized",
          forkDetection: "SIGNATURE_STATUS_OBSERVATION",
        },
      },
    });
    this.#transport = declaration.transport;
    this.#symbol = declaration.nativeAssetSymbol ?? "SOL";
    this.#assetId = `${this.chainKey}/asset:${this.#symbol}`;
    this.#maxHeadAgeSeconds = declaration.maxHeadAgeSeconds ?? 30;
    this.#commitment = declaration.finalizedCommitment ?? "finalized";
    this.#signerEnvelope = new SolanaSigningEnvelopeAdapter({
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
        `assetId '${assetId}' is not the declared native SOL binding '${this.#assetId}' on '${this.chainKey}' — SPL token semantics are not declared in this wave and fail closed (never approximated)`,
      );
    }
    return { symbol: this.#symbol, nativeAssetRef: "native:lamports" };
  }

  protected assertOperationSupported(operation: OnchainExecutionDirective["operation"]): void {
    if (operation === "onchain.transfer") {
      return;
    }
    throw new ValidationError(
      `the Solana family does not declare support for operation '${operation}' in this wave — unsupported operations fail closed, never approximated`,
    );
  }

  protected transportProviderNames(): readonly string[] {
    return [...new Set(this.#transport.endpoints().map((endpoint) => endpoint.providerName))];
  }

  protected confirmationDepth(
    observation: { readonly finalityCandidate?: { readonly confirmationDepth?: number } },
  ): number {
    return observation.finalityCandidate?.confirmationDepth ?? 0;
  }

  // ------------------------------------------------------------------
  // observe stage
  // ------------------------------------------------------------------

  async observeChainHead(input: {
    readonly at: string;
    readonly maxAgeSeconds?: number;
  }): Promise<ChainHeadProbe> {
    const slot = await this.#transport.call("getSlot", [{ commitment: "confirmed" }]);
    if (slot.kind !== "RPC_OK" || typeof slot.result !== "number" || !Number.isSafeInteger(slot.result)) {
      return this.#unreachableHead(
        slot.kind === "RPC_OK" ? "getSlot returned a non-integer slot" : slot.message,
      );
    }
    const blockhash = await this.#transport.call("getLatestBlockhash", [{ commitment: "confirmed" }]);
    if (
      blockhash.kind !== "RPC_OK" ||
      blockhash.result === null ||
      typeof blockhash.result !== "object"
    ) {
      return this.#unreachableHead(
        blockhash.kind === "RPC_OK" ? "getLatestBlockhash returned no value" : blockhash.message,
      );
    }
    const value = (blockhash.result as { value?: { blockhash?: unknown } }).value;
    const hash = value?.blockhash;
    if (typeof hash !== "string" || hash.length === 0) {
      return this.#unreachableHead("getLatestBlockhash carries no blockhash");
    }
    const atMs = Date.parse(input.at);
    const head: ChainHeadObservation = Object.freeze({
      observationKind: "ChainHeadObservation",
      chainKey: this.chainKey,
      environmentClass: this.environment.environmentClass,
      height: slot.result,
      headHash: hash,
      observedAt: input.at,
      provenance: this.buildProvenance(slot.servedBy, atMs),
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
      message: `Solana head unobservable: ${message} — reachability UNKNOWN, never success/failure (INV-C02)`,
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
        message: `assetId '${input.assetId}' is not the declared native SOL binding '${this.#assetId}' — SPL token positions are not declared in this wave (fail closed)`,
        chainKey: this.chainKey,
        at: input.at,
      };
    }
    const balance = await this.#transport.call("getBalance", [
      input.accountRef,
      { commitment: "confirmed" },
    ]);
    if (balance.kind !== "RPC_OK") {
      return {
        kind: "POSITION_UNOBSERVABLE",
        reason: balance.kind === "TRANSPORT_UNREACHABLE" ? "RAIL_UNREACHABLE" : "PROVIDER_REJECTED_ACCOUNT",
        message: `balance observation failed for '${input.accountRef}': ${balance.message}`,
        chainKey: this.chainKey,
        at: input.at,
      };
    }
    // EXACTNESS LAW: getBalance returns a JSON NUMBER; balances above
    // Number.MAX_SAFE_INTEGER lose exactness through a JSON double
    // round-trip. The lamports are therefore extracted from the RAW response
    // text (exact integer decimal string); when the raw value is not an
    // exact integer the observation fails closed — a lossy balance is never
    // fabricated (INV-F01 discipline).
    const rawLamports = /"value"\s*:\s*(\d+)/.exec(balance.raw)?.[1];
    if (rawLamports === undefined) {
      return {
        kind: "POSITION_UNOBSERVABLE",
        reason: "PROVIDER_REJECTED_ACCOUNT",
        message: `the provider returned no exact integer lamport amount for '${input.accountRef}' — a lossy observation is never fabricated (INV-F01 discipline)`,
        chainKey: this.chainKey,
        at: input.at,
      };
    }
    const atMs = Date.parse(input.at);
    const observation = {
      observationKind: "AssetObservation" as const,
      observationId: `asset-obs:${this.adapterId}:${this.#assetId}:${rawLamports}`,
      observedAt: input.at,
      assetId: this.#assetId,
      chainKey: this.chainKey,
      location: { chainKey: this.chainKey, accountRef: input.accountRef },
      observedAmount: { currency: this.#assetId, minorUnits: rawLamports },
      freshness: { asOf: input.at, maxAgeSeconds: input.maxAgeSeconds ?? 30 },
      provenance: {
        providerName: balance.servedBy.providerName,
        source: "PROVIDER_API" as const,
        capturedAt: input.at,
      },
      observer: { observerId: this.adapterId, observerKind: "RPC_PROVIDER" as const },
    };
    this.logEvidence(`position:${this.#assetId}:${input.accountRef}`, "observe", atMs, [
      observation.observationId,
    ]);
    return { kind: "POSITION_OBSERVED", observation };
  }

  // ------------------------------------------------------------------
  // fee derivation (getFeeForMessage over a minimal 1-signature message)
  // ------------------------------------------------------------------

  /**
   * Derives the exact SIGNATURE_FEE parameters from getFeeForMessage over a
   * minimal legacy message (1 required signature, 0 instructions) built from
   * the DECODED recent blockhash. The fee is per-signature and independent
   * of the account key (verified live 2026-10-03, recorded in the
   * provenance evidence file).
   */
  async #deriveFee(
    recentBlockhash: string,
  ): Promise<SolanaFeeSemantics | { readonly expressible: false; readonly reason: string }> {
    const decoded = base58Decode(recentBlockhash);
    if (decoded.length !== 32) {
      return {
        expressible: false,
        reason: `the recent blockhash does not decode to 32 bytes (${decoded.length}) — SIGNATURE_FEE semantics are not expressible and fail closed`,
      };
    }
    // Minimal legacy message: header(1,0,0) + 1 zero key + blockhash + 0
    // instructions = 3 + 1 + 32 + 32 + 1 = 69 bytes.
    const message = new Uint8Array(3 + 1 + 32 + 32 + 1);
    message.set([1, 0, 0], 0);
    // account key count (compact-u16) = 1; the key bytes (indices 4..35) stay
    // all zero — the fee is signature-count based (verified independent of
    // the key, live, 2026-10-03).
    message[3] = 1;
    message.set(decoded, 36);
    // instruction count = 0 (the last byte stays 0).
    const encoded = Buffer.from(message).toString("base64");
    const fee = await this.#transport.call("getFeeForMessage", [encoded, { commitment: "confirmed" }]);
    // getFeeForMessage returns { context, value } — value is the exact
    // lamports fee (or null when the message cannot be priced).
    const feeValue =
      fee.kind === "RPC_OK" && fee.result !== null && typeof fee.result === "object"
        ? (fee.result as { value?: unknown }).value
        : undefined;
    if (fee.kind !== "RPC_OK" || typeof feeValue !== "number" || !Number.isSafeInteger(feeValue)) {
      return {
        expressible: false,
        reason: `getFeeForMessage is not observable ('${fee.kind === "RPC_OK" ? "no exact integer fee value" : fee.message}') — SIGNATURE_FEE semantics are not expressible and fail closed (never approximated)`,
      };
    }
    return {
      family: "SOLANA",
      expressible: true,
      feeModel: "SIGNATURE_FEE",
      lamportsPerSignature: String(feeValue),
    };
  }

  // ------------------------------------------------------------------
  // prepare stage
  // ------------------------------------------------------------------

  async prepare(input: PrepareStageInput): Promise<PreparedAdapterOperation<SolanaExecutionPlan>> {
    const prologue = this.preparePrologue(input);
    const atMs = input.at;

    // Cluster-identity cross-check: the endpoint's genesis hash must match
    // the well-known registry entry for this chainKey.
    const genesis = await this.#transport.call("getGenesisHash", []);
    if (genesis.kind !== "RPC_OK") {
      throw new ChainIdentityMismatchError(
        `getGenesisHash unobservable on '${this.chainKey}' — prepare fails closed when cluster identity cannot be verified`,
      );
    }
    const observedGenesisHash = String(genesis.result);
    const declared = SOLANA_GENESIS_HASHES[this.chainKey];
    if (declared !== undefined && declared !== observedGenesisHash) {
      throw new ChainIdentityMismatchError(
        `the endpoint serving '${this.chainKey}' reports genesis hash '${observedGenesisHash}', but the well-known cluster genesis is '${declared}' — cluster confusion fails closed`,
      );
    }

    // Recent blockhash + validity window (the Solana nonce analogue).
    const blockhash = await this.#transport.call("getLatestBlockhash", [{ commitment: "confirmed" }]);
    if (blockhash.kind !== "RPC_OK" || blockhash.result === null || typeof blockhash.result !== "object") {
      throw new SemanticNotExpressibleError(
        "getLatestBlockhash is unobservable — the blockhash validity window (Solana sequence semantics) cannot be expressed and prepare fails closed",
      );
    }
    const value = (blockhash.result as { value?: { blockhash?: unknown; lastValidBlockHeight?: unknown } }).value;
    if (typeof value?.blockhash !== "string" || typeof value?.lastValidBlockHeight !== "number") {
      throw new SemanticNotExpressibleError(
        "getLatestBlockhash carries no valid blockhash/lastValidBlockHeight — prepare fails closed",
      );
    }
    const fee = await this.#deriveFee(value.blockhash);
    this.refreshSemantics({
      family: "SOLANA",
      fee,
      finality: this.semantics.finality as SolanaSemanticsProfile["finality"],
    });

    const plan: SolanaExecutionPlan = {
      family: "SOLANA",
      observedGenesisHash,
      recentBlockhash: value.blockhash,
      lastValidBlockHeight: value.lastValidBlockHeight,
      fee: this.semantics.fee as SolanaExecutionPlan["fee"],
      commitment: this.#commitment,
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

  // ------------------------------------------------------------------
  // simulate stage
  // ------------------------------------------------------------------

  async simulate(input: {
    readonly prepared: PreparedAdapterOperation<SolanaExecutionPlan>;
    readonly at: number;
  }): Promise<SimulationObservation> {
    const write = input.prepared.writeRequest;
    const payload = input.prepared.directive.familyPayload as
      | { readonly serializedTransaction?: unknown }
      | undefined;
    if (typeof payload?.serializedTransaction !== "string" || payload.serializedTransaction.length === 0) {
      // Fail closed: no fabricated simulation without surface-composed input.
      throw new ValidationError(
        "Solana simulation requires familyPayload.serializedTransaction (trusted-surface-composed, base64) — a simulation is never fabricated from nothing (fail closed)",
      );
    }
    const simulationId = `sim:${this.adapterId}:${write.writeId}`;
    const base = {
      simulationId,
      writeId: write.writeId,
      observedAt: input.at,
      balanceDeltas: write.transfer
        ? [
            {
              holder: write.transfer.from,
              asset: write.transfer.asset,
              amount: write.transfer.amount,
              direction: "debit" as const,
            },
            {
              holder: write.transfer.to,
              asset: write.transfer.asset,
              amount: write.transfer.amount,
              direction: "credit" as const,
            },
          ]
        : [],
      approvals: [],
      simulator: this.adapterId,
      ...(input.prepared.familyPlan.recentBlockhash !== undefined
        ? { blockRef: input.prepared.familyPlan.recentBlockhash }
        : {}),
    };
    const result = await this.#transport.call("simulateTransaction", [
      payload.serializedTransaction,
      { sigVerify: false, commitment: "confirmed" },
    ]);
    if (result.kind === "RPC_OK") {
      if (result.result !== null && typeof result.result === "object") {
        const record = result.result as { err?: unknown };
        if (record.err === null || record.err === undefined) {
          this.logEvidence(write.writeId, "simulate", input.at, [simulationId, "status:succeeded"]);
          return recordSimulation({ ...base, status: "SUCCEEDED" });
        }
        this.logEvidence(write.writeId, "simulate", input.at, [simulationId, "status:reverted"]);
        return recordSimulation({ ...base, status: "REVERTED" });
      }
      // RPC_OK with a null result: the simulator returned nothing usable.
      this.logEvidence(write.writeId, "simulate", input.at, [simulationId, "outcome:unknown"]);
      return recordSimulation({ ...base, status: "OUTCOME_UNKNOWN" });
    }
    if (result.kind === "TRANSPORT_UNREACHABLE") {
      this.logEvidence(write.writeId, "simulate", input.at, [simulationId, "outcome:unknown"]);
      return recordSimulation({ ...base, status: "OUTCOME_UNKNOWN" });
    }
    const message = result.message.toLowerCase();
    if (message.includes("insufficient") || message.includes("lamports")) {
      this.logEvidence(write.writeId, "simulate", input.at, [simulationId, "status:failed"]);
      return recordSimulation({ ...base, status: "FAILED" });
    }
    // Unclassified: UNKNOWN (INV-X01).
    this.logEvidence(write.writeId, "simulate", input.at, [simulationId, "outcome:unknown"]);
    return recordSimulation({ ...base, status: "OUTCOME_UNKNOWN" });
  }

  // ------------------------------------------------------------------
  // broadcast stage
  // ------------------------------------------------------------------

  protected signerAdapter(): SolanaSigningEnvelopeAdapter {
    return this.#signerEnvelope;
  }

  async broadcast(input: BroadcastStageInput): Promise<BroadcastStageOutcome> {
    this.assertBroadcastable(input);
    const submission = await this.#transport.call("sendTransaction", [
      input.signedPayload,
      { encoding: "base64", skipPreflight: false },
    ]);
    if (submission.kind === "RPC_OK") {
      const signature = submission.result;
      if (typeof signature !== "string" || signature.length === 0) {
        return this.buildExecutionObservation({
          executionRef: input.executionRef,
          observedAt: input.at,
          outcome: "OUTCOME_UNKNOWN",
          unknownReason:
            "the node accepted the submission but returned no signature — it is unknown whether the operation reached the chain (INV-X01)",
          evidenceRefs: [this.logEvidence(input.executionRef, "broadcast", input.at, ["submission:malformed-result"])],
          servedBy: submission.servedBy,
        });
      }
      return this.buildExecutionObservation({
        executionRef: input.executionRef,
        observedAt: input.at,
        outcome: "BROADCAST",
        externalOperationRef: signature,
        evidenceRefs: [this.logEvidence(input.executionRef, "broadcast", input.at, [`sig:${signature}`])],
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
    if (message.includes("already processed") || message.includes("already in block")) {
      return this.buildExecutionObservation({
        executionRef: input.executionRef,
        observedAt: input.at,
        outcome: "BROADCAST",
        evidenceRefs: [this.logEvidence(input.executionRef, "broadcast", input.at, ["submission:already-processed"])],
        servedBy: submission.servedBy,
      });
    }
    if (message.includes("blockhash not found") || message.includes("has expired")) {
      return this.buildExecutionObservation({
        executionRef: input.executionRef,
        observedAt: input.at,
        outcome: "FAILED",
        failure: {
          failureClass: "EXPIRED",
          description: `the node definitively rejected the submission (blockhash expired): ${submission.message}`,
          retryGuidance: "SAFE_TO_RETRY",
        },
        evidenceRefs: [this.logEvidence(input.executionRef, "broadcast", input.at, ["rejection:blockhash-expired"])],
        servedBy: submission.servedBy,
      });
    }
    if (message.includes("insufficient lamports") || message.includes("insufficient funds")) {
      return this.buildExecutionObservation({
        executionRef: input.executionRef,
        observedAt: input.at,
        outcome: "FAILED",
        failure: {
          failureClass: "INSUFFICIENT_FUNDS",
          description: `the node definitively rejected the submission: ${submission.message}`,
          retryGuidance: "SAFE_TO_RETRY",
        },
        evidenceRefs: [this.logEvidence(input.executionRef, "broadcast", input.at, ["rejection:insufficient-funds"])],
        servedBy: submission.servedBy,
      });
    }
    return this.buildExecutionObservation({
      executionRef: input.executionRef,
      observedAt: input.at,
      outcome: "OUTCOME_UNKNOWN",
      unknownReason: `unclassified node response after the submission attempt ('${submission.message}'): it is unknown whether the operation reached the chain (INV-X01)`,
      evidenceRefs: [this.logEvidence(input.executionRef, "broadcast", input.at, ["submission:unclassified"])],
      servedBy: submission.servedBy,
    });
  }

  // ------------------------------------------------------------------
  // observe (result) stage
  // ------------------------------------------------------------------

  async observeOperation(input: ObserveResultInput): Promise<BroadcastStageOutcome> {
    const statuses = await this.#transport.call("getSignatureStatuses", [
      [input.externalOperationRef],
      { searchTransactionHistory: false },
    ]);
    if (statuses.kind !== "RPC_OK") {
      return this.buildExecutionObservation({
        executionRef: input.executionRef,
        observedAt: input.at,
        externalOperationRef: input.externalOperationRef,
        outcome: "OUTCOME_UNKNOWN",
        unknownReason:
          statuses.kind === "TRANSPORT_UNREACHABLE"
            ? "the signature status is unobservable (rail unreachable) — the outcome is UNKNOWN, not failed (INV-C02/INV-X01)"
            : `unclassified provider error observing the signature status ('${statuses.message}') — the outcome is UNKNOWN (INV-X01)`,
        evidenceRefs: [this.logEvidence(input.executionRef, "observeResult", input.at, ["status:unobservable"])],
        servedBy:
          statuses.kind === "TRANSPORT_UNREACHABLE"
            ? { transportId: this.#transport.transportId, endpointId: "none", providerName: "unreachable" }
            : statuses.servedBy,
      });
    }
    const value = (statuses.result as { value?: unknown[] } | null)?.value;
    const status = Array.isArray(value) ? (value[0] as Record<string, unknown> | null) : undefined;
    if (status === null || status === undefined) {
      if (input.prior?.outcome === "CONFIRMED") {
        // Fork/reorg: a previously confirmed signature is no longer visible
        // at the queried commitment — ambiguity (INV-X01).
        return this.buildExecutionObservation({
          executionRef: input.executionRef,
          observedAt: input.at,
          externalOperationRef: input.externalOperationRef,
          outcome: "OUTCOME_UNKNOWN",
          unknownReason:
            "broadcast-then-fork: the signature status DISAPPEARED after a prior CONFIRMED observation (the containing fork was dropped or the status aged out of the recent-history window) — the outcome is ambiguous and requires reconciliation (INV-X01)",
          evidenceRefs: [this.logEvidence(input.executionRef, "observeResult", input.at, ["fork:status-disappeared"])],
          servedBy: statuses.servedBy,
        });
      }
      return this.buildExecutionObservation({
        executionRef: input.executionRef,
        observedAt: input.at,
        externalOperationRef: input.externalOperationRef,
        outcome: "BROADCAST",
        evidenceRefs: [this.logEvidence(input.executionRef, "observeResult", input.at, ["status:not-seen"])],
        servedBy: statuses.servedBy,
      });
    }
    const err = status["err"];
    if (err !== null && err !== undefined) {
      return this.buildExecutionObservation({
        executionRef: input.executionRef,
        observedAt: input.at,
        externalOperationRef: input.externalOperationRef,
        outcome: "FAILED",
        failure: {
          failureClass: "PROVIDER_DEFINED",
          description: `the transaction executed and FAILED on-chain (err: ${JSON.stringify(err)}) — definitive execution failure`,
          retryGuidance: "REQUIRES_RECONCILIATION",
        },
        evidenceRefs: [this.logEvidence(input.executionRef, "observeResult", input.at, ["status:err"])],
        servedBy: statuses.servedBy,
      });
    }
    const slot = status["slot"];
    const confirmations = status["confirmations"];
    const confirmationStatus = status["confirmationStatus"];
    // Fork detection: a prior confirmation at a different slot.
    const anchor = this.confirmationAnchor(input.executionRef) ??
      (input.prior?.outcome === "CONFIRMED" ? { height: Number(slot ?? 0), headHash: input.externalOperationRef } : undefined);
    if (anchor !== undefined && typeof slot === "number" && slot !== anchor.height) {
      return this.buildExecutionObservation({
        executionRef: input.executionRef,
        observedAt: input.at,
        externalOperationRef: input.externalOperationRef,
        outcome: "OUTCOME_UNKNOWN",
        unknownReason: `broadcast-then-fork: the signature's slot changed (was ${anchor.height}, now ${slot}) — the transaction confirmed on a different fork version; the outcome is ambiguous and requires reconciliation (INV-X01)`,
        evidenceRefs: [this.logEvidence(input.executionRef, "observeResult", input.at, ["fork:slot-changed"])],
        servedBy: statuses.servedBy,
      });
    }
    const head = await this.#transport.call("getSlot", [{ commitment: "confirmed" }]);
    if (head.kind === "RPC_OK" && typeof head.result === "number" && typeof slot === "number" && slot > head.result) {
      // Inconsistent provider data (status above the head): ambiguous.
      return this.buildExecutionObservation({
        executionRef: input.executionRef,
        observedAt: input.at,
        externalOperationRef: input.externalOperationRef,
        outcome: "OUTCOME_UNKNOWN",
        unknownReason: `the status claims slot ${slot} above the observed head slot ${head.result} — inconsistent provider data is UNKNOWN, never finalized (INV-X01)`,
        evidenceRefs: [this.logEvidence(input.executionRef, "observeResult", input.at, ["status:above-head"])],
        servedBy: statuses.servedBy,
      });
    }
    if (confirmationStatus === "finalized" || confirmationStatus === "confirmed") {
      const depth = (typeof confirmations === "number" ? confirmations : 0) + 1;
      if (typeof slot === "number") {
        this.rememberConfirmationAnchor(input.executionRef, {
          height: slot,
          headHash: input.externalOperationRef,
        });
      }
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
        servedBy: statuses.servedBy,
      });
    }
    // Processed-level or missing commitment: still in flight (not final).
    return this.buildExecutionObservation({
      executionRef: input.executionRef,
      observedAt: input.at,
      externalOperationRef: input.externalOperationRef,
      outcome: "BROADCAST",
      evidenceRefs: [this.logEvidence(input.executionRef, "observeResult", input.at, ["status:processed-only"])],
      servedBy: statuses.servedBy,
    });
  }
}

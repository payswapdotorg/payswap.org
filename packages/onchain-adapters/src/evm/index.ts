/**
 * @payswap/onchain-adapters — EVM family adapter (P4-W2-001).
 *
 * Speaks plain JSON-RPC 2.0 through the vendor-neutral transport port
 * (public Ethereum mainnet/testnet endpoints work; no vendor SDK). Every
 * stage of the frozen lifecycle contract is implemented explicitly:
 *
 * - observe:          eth_blockNumber + eth_getBlockByNumber → chain-head
 *                     observation; eth_getBalance / eth_call balanceOf →
 *                     asset positions AS OBSERVATIONS (INV-C09).
 * - prepare:          eth_chainId cross-check (chain-confusion defense) +
 *                     eth_getTransactionCount (nonce) + EIP-1559 fee
 *                     derivation from the latest block (baseFeePerGas) —
 *                     a block without baseFee CANNOT express 1559 fee
 *                     semantics and fails closed (never approximated with a
 *                     legacy gas price).
 * - simulate:         eth_estimateGas → kernel SimulationObservation;
 *                     transport ambiguity → OUTCOME_UNKNOWN (INV-X01).
 * - authorize:        inherited — drives the onchain-security kernel and
 *                     hands off an EIP-712 signing request (reusing the
 *                     kernel's own Eip712SignerAdapter with this adapter's
 *                     chain-id resolver).
 * - broadcast:        eth_sendRawTransaction with the deterministic EVM
 *                     node-rejection classification table; unclassified
 *                     errors and transport failure after submission →
 *                     OUTCOME_UNKNOWN (it is unknown whether the operation
 *                     reached the chain — INV-X01).
 * - observe (result): eth_getTransactionReceipt + reorg detection via the
 *                     remembered containing-block hash (a changed/vanished
 *                     receipt after confirmation → OUTCOME_UNKNOWN).
 * - finality:         confirmations = head − block + 1 against the declared
 *                     confirmation-depth guidance (candidates only, INV-F06).
 * - reconcile/evidence: shared machinery.
 */

import { ValidationError } from "@payswap/protocol";
import { validateOnchainExecutionDirective } from "@payswap/onchain-domain";
import type { OnchainExecutionDirective } from "@payswap/onchain-domain";
import { Eip712SignerAdapter } from "@payswap/onchain-security/adapters/eip712";
import { recordSimulation } from "@payswap/onchain-security";
import type { SimulationObservation } from "@payswap/onchain-security";
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
import type { EvmFeeSemantics, EvmSemanticsProfile } from "../semantics.js";
import { hexQuantityToDecimal, parseExactDecimal } from "../transport.js";
import type { EndpointProfile, RpcTransport } from "../transport.js";

// ---------------------------------------------------------------------------
// Well-known EVM chain identities (public constants — never secrets)
// ---------------------------------------------------------------------------

/** Well-known EVM chain ids (canonical decimal strings). */
export const EVM_CHAIN_IDS: Readonly<Record<string, string>> = Object.freeze({
  "ethereum:mainnet": "1",
  "ethereum:sepolia": "11155111",
  "ethereum:holesky": "17000",
});

/**
 * PUBLIC production endpoint profiles for the Ethereum mainnet JSON-RPC
 * (provider diversity: PublicNode + Cloudflare — no single vendor).
 * Read-only observation; no credentials.
 */
export const ETHEREUM_MAINNET_PUBLIC_ENDPOINTS: readonly EndpointProfile[] = Object.freeze([
  {
    endpointId: "ethereum-mainnet-publicnode",
    providerName: "PublicNode",
    url: "https://ethereum-rpc.publicnode.com",
    protocol: "JSON_RPC",
    chainKey: "ethereum:mainnet",
  },
  {
    endpointId: "ethereum-mainnet-cloudflare",
    providerName: "Cloudflare",
    url: "https://cloudflare-eth.com",
    protocol: "JSON_RPC",
    chainKey: "ethereum:mainnet",
  },
]);

/** PUBLIC testnet (Sepolia) endpoint profiles. */
export const ETHEREUM_SEPOLIA_PUBLIC_ENDPOINTS: readonly EndpointProfile[] = Object.freeze([
  {
    endpointId: "ethereum-sepolia-publicnode",
    providerName: "PublicNode",
    url: "https://ethereum-sepolia-rpc.publicnode.com",
    protocol: "JSON_RPC",
    chainKey: "ethereum:sepolia",
  },
]);

// ---------------------------------------------------------------------------
// Asset bindings (declared catalogue → family-native identity)
// ---------------------------------------------------------------------------

/** An EVM asset binding: neutral assetId → native identity + symbol. */
export interface EvmAssetBinding {
  /** Canonical neutral asset identity, e.g. `ethereum:mainnet/asset:ETH`. */
  readonly assetId: string;
  /** 3-letter protocol currency symbol (AmountSpec law). */
  readonly symbol: string;
  readonly kind: "NATIVE" | "ERC20";
  /** ERC20 token contract address (lowercase hex; required for ERC20). */
  readonly contractAddress?: string;
}

/** Canonical Ether binding for any EVM chainKey. */
export function nativeEtherBinding(chainKey: string): EvmAssetBinding {
  return { assetId: `${chainKey}/asset:ETH`, symbol: "ETH", kind: "NATIVE" };
}

// ---------------------------------------------------------------------------
// The EVM family execution plan (prepare output)
// ---------------------------------------------------------------------------

/** The EVM family execution plan (adapter-owned, opaque to the core). */
export interface EvmExecutionPlan {
  readonly family: "EVM";
  /** Chain id OBSERVED via eth_chainId at prepare time (cross-checked). */
  readonly observedChainId: string;
  /** Nonce observed via eth_getTransactionCount ("pending"). */
  readonly nonce: string;
  /** Recipient (account or contract). */
  readonly to: string;
  /** Exact value in wei, 0x-prefixed hex. */
  readonly value: string;
  /** Calldata (0x for plain native transfers). */
  readonly data: string;
  readonly fee: EvmFeeSemantics | { readonly expressible: false; readonly reason: string };
  /** The chain head the plan was prepared against. */
  readonly headAtPrepare: { readonly height: number; readonly headHash: string };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

/** EVM adapter construction declaration. */
export interface EvmAdapterDeclaration {
  readonly adapterId: string;
  /** E.g. `ethereum:mainnet` — environment is DERIVED from it (structural). */
  readonly chainKey: string;
  /** Declared EVM chain id (decimal string) — cross-checked at every prepare. */
  readonly evmChainId: string;
  readonly transport: RpcTransport;
  /** Declared asset bindings (the family-native identity resolution). */
  readonly assetBindings: readonly EvmAssetBinding[];
  /** Declared confirmation-depth guidance (e.g. 12 for mainnet). */
  readonly confirmationDepthTarget: number;
  /** Head freshness window (seconds; default 90 = ~7 mainnet blocks). */
  readonly maxHeadAgeSeconds?: number;
}

const TRANSFER_SELECTOR = "0xa9059cbb"; // ERC20 transfer(address,uint256)
const BALANCE_OF_SELECTOR = "0x70a08231"; // ERC20 balanceOf(address)
const APPROVE_SELECTOR = "0x095ea7b3"; // ERC20 approve(address,uint256)
const EVM_HEX_QUANTITY = /^0x[0-9a-fA-F]+$/;

function padAddress(address: string): string {
  const clean = address.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(clean)) {
    throw new ValidationError(`'${address}' is not a 20-byte EVM address (HEX_20_BYTE family convention)`);
  }
  return "0x" + clean.padStart(64, "0");
}

function amountToUint256Hex(minorUnits: string): string {
  const exact = parseExactDecimal(minorUnits, "amount");
  return "0x" + BigInt(exact).toString(16).padStart(64, "0");
}

/**
 * The EVM family adapter. PRODUCTION wiring must pass a transport with
 * endpoint provider diversity (asserted in the constructor for production
 * chains via the transport's endpoint profiles).
 */
export class EvmChainAdapter extends BaseChainFamilyAdapter<"PRODUCTION" | "TESTNET" | "REGTEST", EvmExecutionPlan> {
  readonly #transport: RpcTransport;
  readonly #evmChainId: string;
  readonly #assetBindings: ReadonlyMap<string, EvmAssetBinding>;
  readonly #maxHeadAgeSeconds: number;
  readonly #finalitySemantics: EvmSemanticsProfile["finality"];
  #signerAdapter: Eip712SignerAdapter;

  constructor(declaration: EvmAdapterDeclaration) {
    const declaredChainId = EVM_CHAIN_IDS[declaration.chainKey];
    if (declaredChainId !== undefined && declaredChainId !== declaration.evmChainId) {
      throw new ValidationError(
        `declared evmChainId '${declaration.evmChainId}' disagrees with the well-known chain id '${declaredChainId}' for '${declaration.chainKey}' — chain identity fails closed`,
      );
    }
    super({
      adapterId: declaration.adapterId,
      chainKey: declaration.chainKey,
      family: "EVM",
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
        family: "EVM",
        // Initial inexpressible fee shape: parameters are derived from the
        // observed latest block at prepare time (or observeChainHead).
        fee: { expressible: false, reason: "fee parameters not yet observed — derived at prepare from the latest block (EIP-1559 baseFeePerGas)" },
        finality: {
          family: "EVM",
          finalityModel: "PROBABILISTIC",
          confirmationDepthTarget: declaration.confirmationDepthTarget,
          reorgDetection: "BLOCK_HASH_OBSERVATION",
        },
      },
    });
    this.#transport = declaration.transport;
    this.#evmChainId = declaration.evmChainId;
    this.#assetBindings = new Map(declaration.assetBindings.map((binding) => [binding.assetId, binding]));
    this.#maxHeadAgeSeconds = declaration.maxHeadAgeSeconds ?? 90;
    this.#finalitySemantics = this.semantics.finality as EvmSemanticsProfile["finality"];
    this.#signerAdapter = new Eip712SignerAdapter({
      chainIdResolver: {
        resolve: (chain) => (chain === this.chainKey ? BigInt(this.#evmChainId) : undefined),
      },
    });
  }

  // ------------------------------------------------------------------
  // identity resolution (family-owned)
  // ------------------------------------------------------------------

  protected resolveAssetIdentity(assetId: string): { symbol: string; nativeAssetRef: string } {
    const binding = this.#assetBindings.get(assetId);
    if (binding === undefined) {
      throw new ValidationError(
        `assetId '${assetId}' has no declared EVM asset binding for chain '${this.chainKey}' — the family-native identity is never guessed (fail closed; register the binding)`,
      );
    }
    return {
      symbol: binding.symbol,
      nativeAssetRef: binding.kind === "NATIVE" ? "native" : (binding.contractAddress as string),
    };
  }

  protected assertOperationSupported(operation: OnchainExecutionDirective["operation"]): void {
    switch (operation) {
      case "onchain.transfer":
      case "onchain.approval":
      case "onchain.contract_call":
        return;
      default:
        throw new ValidationError(
          `the EVM family does not declare support for operation '${operation}' — unsupported operations fail closed, never approximated`,
        );
    }
  }

  protected transportProviderNames(): readonly string[] {
    return [...new Set(this.#transport.endpoints().map((endpoint) => endpoint.providerName))];
  }

  protected confirmationDepth(observation: { executionRef: string; finalityCandidate?: { confirmationDepth?: number } }, head: ChainHeadObservation): number {
    const anchor = this.confirmationAnchor(observation.executionRef);
    if (anchor !== undefined) {
      // Live re-computation against the CURRENT head: depth advances with the
      // head; a head below the anchor is a regression (reorg territory).
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
    const blockNumber = await this.#transport.call("eth_blockNumber", []);
    if (blockNumber.kind !== "RPC_OK") {
      return this.#unreachableHead(blockNumber.message);
    }
    const height = Number(hexQuantityToDecimal(blockNumber.result, "eth_blockNumber result"));
    const block = await this.#transport.call("eth_getBlockByNumber", ["latest", false]);
    if (block.kind !== "RPC_OK" || block.result === null || typeof block.result !== "object") {
      return this.#unreachableHead(
        block.kind === "RPC_OK" ? "eth_getBlockByNumber returned no block" : block.message,
      );
    }
    const blockRecord = block.result as { hash?: unknown; baseFeePerGas?: unknown };
    if (typeof blockRecord.hash !== "string" || !EVM_HEX_QUANTITY.test(blockRecord.hash)) {
      return this.#unreachableHead("the latest block carries no valid hash");
    }
    // Refresh observable fee semantics from the latest block (explicit 1559).
    this.#refreshFeeSemantics(blockRecord);
    const atMs = Date.parse(input.at);
    const head: ChainHeadObservation = Object.freeze({
      observationKind: "ChainHeadObservation",
      chainKey: this.chainKey,
      environmentClass: this.environment.environmentClass,
      height,
      headHash: blockRecord.hash,
      observedAt: input.at,
      provenance: this.buildProvenance(block.servedBy, atMs),
      maxAgeSeconds: input.maxAgeSeconds ?? this.#maxHeadAgeSeconds,
    });
    this.logEvidence("chain-head", "observe", atMs, [head.headHash, String(height)]);
    return { kind: "HEAD_OBSERVED", head };
  }

  #unreachableHead(message: string): ChainHeadProbe {
    return {
      kind: "RAIL_UNREACHABLE",
      availability: "UNKNOWN",
      chainKey: this.chainKey,
      transportId: this.#transport.transportId,
      attemptedEndpointIds: this.#transport.endpoints().map((endpoint) => endpoint.endpointId),
      message: `EVM head unobservable: ${message} — reachability UNKNOWN, never success/failure (INV-C02)`,
      at: new Date().toISOString(),
    };
  }

  #refreshFeeSemantics(block: { baseFeePerGas?: unknown }): void {
    if (block.baseFeePerGas === undefined || typeof block.baseFeePerGas !== "string" || !EVM_HEX_QUANTITY.test(block.baseFeePerGas)) {
      this.refreshSemantics({
        family: "EVM",
        fee: {
          expressible: false,
          reason: "the observed block carries no EIP-1559 baseFeePerGas — GAS_AUCTION 1559 fee semantics are not expressible and are never approximated with a legacy gas price (fail closed)",
        },
        finality: this.#finalitySemantics,
      });
      return;
    }
    this.refreshSemantics({
      family: "EVM",
      fee: {
        family: "EVM",
        expressible: true,
        feeModel: "GAS_AUCTION",
        baseFeePerGasMinorUnits: hexQuantityToDecimal(block.baseFeePerGas, "baseFeePerGas"),
        gasLimit: "21000",
        eip1559: true,
      },
      finality: this.#finalitySemantics,
    });
  }

  async observeAssetPosition(input: {
    readonly accountRef: string;
    readonly assetId: string;
    readonly at: string;
    readonly maxAgeSeconds?: number;
  }): Promise<AssetPositionProbe> {
    const binding = this.#assetBindings.get(input.assetId);
    if (binding === undefined) {
      return {
        kind: "POSITION_UNOBSERVABLE",
        reason: "ASSET_BINDING_UNKNOWN",
        message: `assetId '${input.assetId}' has no declared EVM binding on '${this.chainKey}' — an unbound asset is never observed (fail closed)`,
        chainKey: this.chainKey,
        at: input.at,
      };
    }
    const call =
      binding.kind === "NATIVE"
        ? await this.#transport.call("eth_getBalance", [input.accountRef, "latest"])
        : await this.#transport.call("eth_call", [
            { to: binding.contractAddress, data: BALANCE_OF_SELECTOR + padAddress(input.accountRef).slice(2) },
            "latest",
          ]);
    if (call.kind !== "RPC_OK") {
      return {
        kind: "POSITION_UNOBSERVABLE",
        reason: call.kind === "TRANSPORT_UNREACHABLE" ? "RAIL_UNREACHABLE" : "PROVIDER_REJECTED_ACCOUNT",
        message: `balance observation failed for '${input.accountRef}': ${call.message}`,
        chainKey: this.chainKey,
        at: input.at,
      };
    }
    if (typeof call.result !== "string" || !EVM_HEX_QUANTITY.test(call.result)) {
      return {
        kind: "POSITION_UNOBSERVABLE",
        reason: "PROVIDER_REJECTED_ACCOUNT",
        message: `the provider returned a non-quantity balance for '${input.accountRef}' — an observation is never fabricated`,
        chainKey: this.chainKey,
        at: input.at,
      };
    }
    const minorUnits = hexQuantityToDecimal(call.result, "observed balance");
    const atMs = Date.parse(input.at);
    const observation = {
      observationKind: "AssetObservation" as const,
      observationId: `asset-obs:${this.adapterId}:${binding.assetId}:${minorUnits}`,
      observedAt: input.at,
      assetId: binding.assetId,
      chainKey: this.chainKey,
      location: { chainKey: this.chainKey, accountRef: input.accountRef },
      observedAmount: { currency: binding.assetId, minorUnits },
      freshness: { asOf: input.at, maxAgeSeconds: input.maxAgeSeconds ?? 30 },
      provenance: {
        providerName: call.servedBy.providerName,
        source: "PROVIDER_API" as const,
        capturedAt: input.at,
      },
      observer: { observerId: this.adapterId, observerKind: "RPC_PROVIDER" as const },
    };
    this.logEvidence(`position:${binding.assetId}:${input.accountRef}`, "observe", atMs, [
      observation.observationId,
    ]);
    return { kind: "POSITION_OBSERVED", observation };
  }

  // ------------------------------------------------------------------
  // prepare stage
  // ------------------------------------------------------------------

  async prepare(input: PrepareStageInput): Promise<PreparedAdapterOperation<EvmExecutionPlan>> {
    const prologue = this.preparePrologue(input);
    const atMs = input.at;

    // Chain-identity cross-check: the endpoint must serve the declared chain.
    const chainId = await this.#transport.call("eth_chainId", []);
    if (chainId.kind !== "RPC_OK") {
      throw new ChainIdentityMismatchError(
        `eth_chainId unobservable on '${this.chainKey}' — prepare fails closed when chain identity cannot be verified`,
      );
    }
    const observedChainId = hexQuantityToDecimal(chainId.result, "eth_chainId result");
    if (observedChainId !== this.#evmChainId) {
      throw new ChainIdentityMismatchError(
        `the endpoint serving '${this.chainKey}' reports chain id ${observedChainId}, but the adapter is declared for chain id ${this.#evmChainId} — chain confusion fails closed`,
      );
    }
    const instanceExtension = input.instance.familyExtension;
    if (instanceExtension?.family === "EVM" && instanceExtension.evmChainId !== observedChainId) {
      throw new ChainIdentityMismatchError(
        `the connected instance observes EVM chain id ${instanceExtension.evmChainId}, but the endpoint reports ${observedChainId} — instance/endpoint chain identity mismatch fails closed`,
      );
    }

    // Nonce observation (drift-checked at the kernel recheck).
    const nonceCall = await this.#transport.call("eth_getTransactionCount", [input.signerAccountRef, "pending"]);
    if (nonceCall.kind !== "RPC_OK") {
      throw new ValidationError(
        `eth_getTransactionCount unobservable for '${input.signerAccountRef}' — prepare fails closed (nonce semantics are explicit, never guessed)`,
      );
    }
    const nonce = hexQuantityToDecimal(nonceCall.result, "transaction count");

    // Fee derivation: the latest block's baseFeePerGas (EIP-1559) or the
    // explicit inexpressible shape (fail closed — no legacy approximation).
    const block = await this.#transport.call("eth_getBlockByNumber", ["latest", false]);
    if (block.kind !== "RPC_OK" || block.result === null || typeof block.result !== "object") {
      throw new SemanticNotExpressibleError(
        "the latest EVM block is unobservable — GAS_AUCTION fee semantics cannot be expressed and prepare fails closed (never approximated)",
      );
    }
    const blockRecord = block.result as { hash?: unknown; baseFeePerGas?: unknown };
    if (typeof blockRecord.hash !== "string") {
      throw new SemanticNotExpressibleError("the latest EVM block carries no hash — prepare fails closed");
    }
    this.#refreshFeeSemantics(blockRecord);
    const fee = this.semantics.fee as EvmExecutionPlan["fee"];

    // Family plan: encode the exact transfer/approval/call.
    const directive = prologue.directive;
    const binding =
      directive.assetId !== undefined ? this.#assetBindings.get(directive.assetId) : undefined;
    let to: string;
    let value: string;
    let data: string;
    if (directive.operation === "onchain.transfer") {
      if (binding?.kind === "ERC20") {
        to = binding.contractAddress as string;
        value = "0x0";
        data = TRANSFER_SELECTOR + padAddress(directive.destination as string).slice(2) + amountToUint256Hex(directive.amount?.minorUnits as string).slice(2);
      } else if (binding?.kind === "NATIVE") {
        to = directive.destination as string;
        value = "0x" + BigInt(parseExactDecimal(directive.amount?.minorUnits as string, "amount")).toString(16);
        data = "0x";
      } else {
        throw new ValidationError(
          `transfer directive assetId '${directive.assetId}' has no EVM binding — the family plan is never guessed`,
        );
      }
    } else if (directive.operation === "onchain.approval") {
      if (binding?.kind !== "ERC20") {
        throw new ValidationError(
          "EVM approval directives require an ERC20 asset binding — native-asset approvals are not expressible (fail closed)",
        );
      }
      to = binding.contractAddress as string;
      value = "0x0";
      data = APPROVE_SELECTOR + padAddress(directive.spenderRef as string).slice(2) + amountToUint256Hex(directive.amount?.minorUnits as string).slice(2);
    } else {
      // contract_call: the family payload carries target+calldata (validated
      // in the shared builder — unknown contract writes never execute silently).
      const payload = directive.familyPayload as { target?: string; calldata?: string } | undefined;
      to = payload?.target as string;
      value = "0x0";
      data = payload?.calldata as string;
    }

    const plan: EvmExecutionPlan = {
      family: "EVM",
      observedChainId,
      nonce,
      to,
      value,
      data,
      fee,
      headAtPrepare: { height: input.head.height, headHash: input.head.headHash },
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
    readonly prepared: PreparedAdapterOperation<EvmExecutionPlan>;
    readonly at: number;
  }): Promise<SimulationObservation> {
    const plan = input.prepared.familyPlan;
    const write = input.prepared.writeRequest;
    const from =
      write.transfer?.from ?? write.approvals[0]?.owner ?? "0x0000000000000000000000000000000000000000";
    const estimate = await this.#transport.call("eth_estimateGas", [
      { from, to: plan.to, value: plan.value, data: plan.data },
    ]);
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
      approvals: write.approvals.map((approval) => ({
        owner: approval.owner,
        spender: approval.spender,
        asset: approval.asset,
        allowance: approval.amount,
        unlimited: approval.unlimited,
      })),
      simulator: this.adapterId,
      ...(plan.headAtPrepare !== undefined ? { blockRef: plan.headAtPrepare.headHash } : {}),
    };
    if (estimate.kind === "RPC_OK") {
      const gasEstimate = hexQuantityToDecimal(estimate.result, "gas estimate");
      this.logEvidence(write.writeId, "simulate", input.at, [simulationId, `gas:${gasEstimate}`]);
      return recordSimulation({ ...base, status: "SUCCEEDED", gasEstimate });
    }
    if (estimate.kind === "TRANSPORT_UNREACHABLE") {
      // INV-X01: simulation ambiguity is UNKNOWN, never FAILED.
      this.logEvidence(write.writeId, "simulate", input.at, [simulationId, "outcome:unknown"]);
      return recordSimulation({ ...base, status: "OUTCOME_UNKNOWN" });
    }
    const message = estimate.message.toLowerCase();
    if (message.includes("revert")) {
      this.logEvidence(write.writeId, "simulate", input.at, [simulationId, "status:reverted"]);
      return recordSimulation({ ...base, status: "REVERTED" });
    }
    if (message.includes("insufficient funds")) {
      this.logEvidence(write.writeId, "simulate", input.at, [simulationId, "status:failed"]);
      return recordSimulation({ ...base, status: "FAILED" });
    }
    // Unclassified node error: UNKNOWN (never failure — INV-X01).
    this.logEvidence(write.writeId, "simulate", input.at, [simulationId, "outcome:unknown"]);
    return recordSimulation({ ...base, status: "OUTCOME_UNKNOWN" });
  }

  // ------------------------------------------------------------------
  // broadcast stage
  // ------------------------------------------------------------------

  protected signerAdapter(): Eip712SignerAdapter {
    return this.#signerAdapter;
  }

  async broadcast(input: BroadcastStageInput): Promise<BroadcastStageOutcome> {
    this.assertBroadcastable(input);
    const submission = await this.#transport.call("eth_sendRawTransaction", [input.signedPayload]);
    if (submission.kind === "RPC_OK") {
      if (typeof submission.result !== "string" || !EVM_HEX_QUANTITY.test(submission.result)) {
        return this.buildExecutionObservation({
          executionRef: input.executionRef,
          observedAt: input.at,
          outcome: "OUTCOME_UNKNOWN",
          unknownReason:
            "the node accepted the submission but returned a non-transaction-hash result — it is unknown whether the operation reached the chain (INV-X01)",
          evidenceRefs: [this.logEvidence(input.executionRef, "broadcast", input.at, ["submission:malformed-result"])],
          servedBy: submission.servedBy,
        });
      }
      return this.buildExecutionObservation({
        executionRef: input.executionRef,
        observedAt: input.at,
        outcome: "BROADCAST",
        externalOperationRef: submission.result,
        evidenceRefs: [this.logEvidence(input.executionRef, "broadcast", input.at, [`tx:${submission.result}`])],
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
        servedBy: {
          transportId: this.#transport.transportId,
          endpointId: "none",
          providerName: "unreachable",
        },
      });
    }
    const message = submission.message.toLowerCase();
    // Deterministic EVM node-rejection classification table.
    if (message.includes("already known") || message.includes("already imported") || message.includes("known transaction")) {
      return this.buildExecutionObservation({
        executionRef: input.executionRef,
        observedAt: input.at,
        outcome: "BROADCAST",
        evidenceRefs: [this.logEvidence(input.executionRef, "broadcast", input.at, ["submission:already-known"])],
        servedBy: submission.servedBy,
      });
    }
    if (message.includes("insufficient funds")) {
      return this.buildExecutionObservation({
        executionRef: input.executionRef,
        observedAt: input.at,
        outcome: "FAILED",
        failure: {
          failureClass: "INSUFFICIENT_FUNDS",
          description: `the node definitively rejected the submission before inclusion: ${submission.message}`,
          retryGuidance: "SAFE_TO_RETRY",
        },
        evidenceRefs: [this.logEvidence(input.executionRef, "broadcast", input.at, ["rejection:insufficient-funds"])],
        servedBy: submission.servedBy,
      });
    }
    if (message.includes("nonce too low") || message.includes("sequence number too low")) {
      return this.buildExecutionObservation({
        executionRef: input.executionRef,
        observedAt: input.at,
        outcome: "FAILED",
        failure: {
          failureClass: "REJECTED",
          description: `the node definitively rejected the submission (nonce already consumed): ${submission.message}`,
          retryGuidance: "REQUIRES_RECONCILIATION",
        },
        evidenceRefs: [this.logEvidence(input.executionRef, "broadcast", input.at, ["rejection:nonce-too-low"])],
        servedBy: submission.servedBy,
      });
    }
    if (message.includes("underpriced") || message.includes("gas price too low") || message.includes("fee too low")) {
      return this.buildExecutionObservation({
        executionRef: input.executionRef,
        observedAt: input.at,
        outcome: "FAILED",
        failure: {
          failureClass: "REJECTED",
          description: `the node definitively rejected the submission (mempool fee policy): ${submission.message}`,
          retryGuidance: "SAFE_TO_RETRY",
        },
        evidenceRefs: [this.logEvidence(input.executionRef, "broadcast", input.at, ["rejection:underpriced"])],
        servedBy: submission.servedBy,
      });
    }
    // Unclassified node error after a submission attempt: UNKNOWN (INV-X01).
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
    const receiptCall = await this.#transport.call("eth_getTransactionReceipt", [input.externalOperationRef]);
    if (receiptCall.kind !== "RPC_OK") {
      return this.buildExecutionObservation({
        executionRef: input.executionRef,
        observedAt: input.at,
        outcome: "OUTCOME_UNKNOWN",
        ...(input.externalOperationRef !== undefined ? { externalOperationRef: input.externalOperationRef } : {}),
        unknownReason:
          receiptCall.kind === "TRANSPORT_UNREACHABLE"
            ? "the receipt is unobservable (rail unreachable) — the outcome is UNKNOWN, not failed (INV-C02/INV-X01)"
            : `unclassified provider error observing the receipt ('${receiptCall.message}') — the outcome is UNKNOWN (INV-X01)`,
        evidenceRefs: [this.logEvidence(input.executionRef, "observeResult", input.at, ["receipt:unobservable"])],
        servedBy: receiptCall.kind === "TRANSPORT_UNREACHABLE"
          ? { transportId: this.#transport.transportId, endpointId: "none", providerName: "unreachable" }
          : receiptCall.servedBy,
      });
    }
    const receipt = receiptCall.result as
      | {
          status?: unknown;
          blockNumber?: unknown;
          blockHash?: unknown;
        }
      | null;
    if (receipt === null) {
      // No receipt: in flight, OR reorged away after a prior confirmation.
      if (input.prior?.outcome === "CONFIRMED") {
        return this.buildExecutionObservation({
          executionRef: input.executionRef,
          observedAt: input.at,
          externalOperationRef: input.externalOperationRef,
          outcome: "OUTCOME_UNKNOWN",
          unknownReason:
            "broadcast-then-reorg: the transaction receipt VANISHED after a prior CONFIRMED observation (the containing block was reorganized away) — the outcome is ambiguous and requires reconciliation (INV-X01; finality stays protocol-owned)",
          evidenceRefs: [this.logEvidence(input.executionRef, "observeResult", input.at, ["reorg:receipt-vanished"])],
          servedBy: receiptCall.servedBy,
        });
      }
      return this.buildExecutionObservation({
        executionRef: input.executionRef,
        observedAt: input.at,
        externalOperationRef: input.externalOperationRef,
        outcome: "BROADCAST",
        evidenceRefs: [this.logEvidence(input.executionRef, "observeResult", input.at, ["receipt:null-in-flight"])],
        servedBy: receiptCall.servedBy,
      });
    }
    const blockNumber =
      typeof receipt.blockNumber === "string" && EVM_HEX_QUANTITY.test(receipt.blockNumber)
        ? Number(hexQuantityToDecimal(receipt.blockNumber, "receipt.blockNumber"))
        : undefined;
    const blockHash = typeof receipt.blockHash === "string" ? receipt.blockHash : undefined;
    if (blockNumber === undefined || blockHash === undefined) {
      // Finalize-ambiguous: a receipt without a locatable block is ambiguous.
      return this.buildExecutionObservation({
        executionRef: input.executionRef,
        observedAt: input.at,
        externalOperationRef: input.externalOperationRef,
        outcome: "OUTCOME_UNKNOWN",
        unknownReason:
          "the receipt carries no locatable block (missing/invalid blockNumber or blockHash) — an unlocatable confirmation is UNKNOWN, never finalized (INV-X01)",
        evidenceRefs: [this.logEvidence(input.executionRef, "observeResult", input.at, ["receipt:unlocatable"])],
        servedBy: receiptCall.servedBy,
      });
    }

    // Reorg detection: the remembered (or prior) containing block must still
    // be the chain's block at that height.
    const anchor = this.confirmationAnchor(input.executionRef) ??
      (input.prior?.outcome === "CONFIRMED" ? { height: blockNumber, headHash: blockHash } : undefined);
    if (anchor !== undefined && (anchor.height !== blockNumber || anchor.headHash !== blockHash)) {
      return this.buildExecutionObservation({
        executionRef: input.executionRef,
        observedAt: input.at,
        externalOperationRef: input.externalOperationRef,
        outcome: "OUTCOME_UNKNOWN",
        unknownReason: `broadcast-then-reorg: the transaction's containing block changed (was height ${anchor.height}/${anchor.headHash}, now ${blockNumber}/${blockHash}) — the outcome is ambiguous and requires reconciliation (INV-X01)`,
        evidenceRefs: [this.logEvidence(input.executionRef, "observeResult", input.at, ["reorg:containing-block-changed"])],
        servedBy: receiptCall.servedBy,
      });
    }
    const blockAtHeight = await this.#transport.call("eth_getBlockByNumber", ["0x" + blockNumber.toString(16), false]);
    if (blockAtHeight.kind === "RPC_OK" && blockAtHeight.result !== null && typeof blockAtHeight.result === "object") {
      const chainHash = (blockAtHeight.result as { hash?: unknown }).hash;
      if (typeof chainHash !== "string" || chainHash !== blockHash) {
        return this.buildExecutionObservation({
          executionRef: input.executionRef,
          observedAt: input.at,
          externalOperationRef: input.externalOperationRef,
          outcome: "OUTCOME_UNKNOWN",
          unknownReason:
            "reorg detected: the chain's block at the receipt's height no longer matches the receipt's containing block hash — the outcome is ambiguous and requires reconciliation (INV-X01)",
          evidenceRefs: [this.logEvidence(input.executionRef, "observeResult", input.at, ["reorg:block-hash-mismatch"])],
          servedBy: receiptCall.servedBy,
        });
      }
    }

    const head = await this.#transport.call("eth_blockNumber", []);
    if (head.kind !== "RPC_OK") {
      return this.buildExecutionObservation({
        executionRef: input.executionRef,
        observedAt: input.at,
        externalOperationRef: input.externalOperationRef,
        outcome: "OUTCOME_UNKNOWN",
        unknownReason: "the chain head is unobservable while locating the receipt — depth cannot be computed, so the outcome is UNKNOWN (INV-X01)",
        evidenceRefs: [this.logEvidence(input.executionRef, "observeResult", input.at, ["head:unobservable"])],
        servedBy: receiptCall.servedBy,
      });
    }
    const headHeight = Number(hexQuantityToDecimal(head.result, "head"));
    if (blockNumber > headHeight) {
      // Inconsistent provider data (receipt above the head): ambiguous.
      return this.buildExecutionObservation({
        executionRef: input.executionRef,
        observedAt: input.at,
        externalOperationRef: input.externalOperationRef,
        outcome: "OUTCOME_UNKNOWN",
        unknownReason: `the receipt claims block ${blockNumber} above the observed head ${headHeight} — inconsistent provider data is UNKNOWN, never finalized (INV-X01)`,
        evidenceRefs: [this.logEvidence(input.executionRef, "observeResult", input.at, ["receipt:above-head"])],
        servedBy: receiptCall.servedBy,
      });
    }

    const status = receipt.status;
    if (status === "0x1") {
      const depth = headHeight - blockNumber + 1;
      this.rememberConfirmationAnchor(input.executionRef, { height: blockNumber, headHash: blockHash });
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
        evidenceRefs: [this.logEvidence(input.executionRef, "observeResult", input.at, [`receipt:confirmed:depth-${depth}`])],
        servedBy: receiptCall.servedBy,
      });
    }
    if (status === "0x0") {
      return this.buildExecutionObservation({
        executionRef: input.executionRef,
        observedAt: input.at,
        externalOperationRef: input.externalOperationRef,
        outcome: "FAILED",
        failure: {
          failureClass: "REVERTED",
          description: "the transaction was included and reverted on-chain (definitive execution failure)",
          retryGuidance: "NOT_RETRYABLE",
        },
        evidenceRefs: [this.logEvidence(input.executionRef, "observeResult", input.at, ["receipt:reverted"])],
        servedBy: receiptCall.servedBy,
      });
    }
    // Malformed status (neither 0x1 nor 0x0): finalize-ambiguous → UNKNOWN.
    return this.buildExecutionObservation({
      executionRef: input.executionRef,
      observedAt: input.at,
      externalOperationRef: input.externalOperationRef,
      outcome: "OUTCOME_UNKNOWN",
      unknownReason: `the receipt status '${String(status)}' is neither success nor revert — an ambiguous status is UNKNOWN, never converted (INV-X01)`,
      evidenceRefs: [this.logEvidence(input.executionRef, "observeResult", input.at, ["receipt:ambiguous-status"])],
      servedBy: receiptCall.servedBy,
    });
  }
}

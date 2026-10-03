import { contentDigest } from "@payswap/onchain-security";
import { EvmChainAdapter, nativeEtherBinding } from "../src/evm/index.js";
import { SolanaChainAdapter } from "../src/solana/index.js";
import { UtxoChainAdapter } from "../src/utxo/index.js";
import {
  ScriptedRestTransport,
  ScriptedRpcTransport,
  fakeEndpoint,
  evmTransferDirective,
  solanaTransferDirective,
  utxoTransferDirective,
  CHAIN,
  SOLANA_CHAIN,
  BITCOIN_CHAIN,
  ETHEREUM_ASSET_ID,
  SOLANA_ASSET_ID,
  BITCOIN_ASSET_ID,
  MERCHANT,
  BTC_MERCHANT,
} from "./helpers.js";
import type { OnchainExecutionDirective } from "@payswap/onchain-domain";

/**
 * Fully-scripted happy-path adapter fixtures per family: the REAL adapter
 * code runs against deterministic transport responses (no network, no
 * domain-logic mocks). Used by the lifecycle suites and the contract suite.
 */

export const EVM_TX_HASH = "0xdeadbeef0000000000000000000000000000000000000000000000000000c0de";
export const EVM_RECEIPT_BLOCK_NUMBER = 17_999_993;
export const EVM_RECEIPT_BLOCK_HASH = "0xdef0000000000000000000000000000000000000000000000000000000000bead";
export const EVM_HEAD_HEIGHT = 18_000_000;
export const EVM_LATEST_BLOCK_HASH = "0xabc0000000000000000000000000000000000000000000000000000000000f01";
export const EVM_BASE_FEE = "0x5f5e100"; // 100000000 wei

export function scriptedEvmTransport(overrides?: {
  readonly responses?: Record<string, (params: readonly unknown[]) => unknown>;
  readonly chainId?: string;
}) {
  const transport = new ScriptedRpcTransport({
    transportId: "transport:scripted:evm",
    endpoints: [
      fakeEndpoint({ endpointId: "evm-scripted-1", providerName: "ScriptedProvider", chainKey: CHAIN }),
      fakeEndpoint({ endpointId: "evm-scripted-2", providerName: "OtherScriptedProvider", chainKey: CHAIN }),
    ],
    responses: {
      eth_blockNumber: () => "0x" + EVM_HEAD_HEIGHT.toString(16),
      eth_chainId: () => overrides?.chainId ?? "0x1",
      eth_getTransactionCount: () => "0x7",
      eth_getBalance: () => "0x3635c9adc5dea00000", // 1000 ETH in wei (exact)
      eth_estimateGas: () => "0x5208",
      eth_sendRawTransaction: () => EVM_TX_HASH,
      eth_getTransactionReceipt: () => ({
        status: "0x1",
        blockNumber: "0x" + EVM_RECEIPT_BLOCK_NUMBER.toString(16),
        blockHash: EVM_RECEIPT_BLOCK_HASH,
      }),
      eth_getBlockByNumber: (params) => {
        const block = params[0] as string;
        if (block === "latest") {
          return { hash: EVM_LATEST_BLOCK_HASH, baseFeePerGas: EVM_BASE_FEE };
        }
        // The receipt's containing block (reorg detection probe).
        return { hash: EVM_RECEIPT_BLOCK_HASH };
      },
      ...(overrides?.responses ?? {}),
    },
  });
  return transport;
}

export function evmAdapter(overrides?: Parameters<typeof scriptedEvmTransport>[0]) {
  return new EvmChainAdapter({
    adapterId: "adapter:evm:test",
    chainKey: CHAIN,
    evmChainId: "1",
    transport: scriptedEvmTransport(overrides),
    assetBindings: [nativeEtherBinding(CHAIN)],
    confirmationDepthTarget: 12,
  });
}

/** An EVM adapter over an explicitly-provided scripted transport. */
export function evmAdapterWithTransport(transport: ReturnType<typeof scriptedEvmTransport>) {
  return new EvmChainAdapter({
    adapterId: "adapter:evm:test",
    chainKey: CHAIN,
    evmChainId: "1",
    transport,
    assetBindings: [nativeEtherBinding(CHAIN)],
    confirmationDepthTarget: 12,
  });
}

export function evmRouteHash(directive: OnchainExecutionDirective = evmTransferDirective()): string {
  return `route:${contentDigest(directive)}`;
}

// --------------------------------------------------------------------------- SOLANA

export const SOLANA_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
export const SOLANA_BLOCKHASH = "4VbguV3HcbnfMxu1PFjUsNfeeoHLmk6kcAe3hGcMXuHv";
export const SOLANA_SLOT = 453_015_774;
export const SOLANA_SIGNATURE = "2SIGNATUREBASE58SIGNATUREBASE58SIGNATUREBASE58SIG";
export const SOLANA_TX_SLOT = 453_015_770;

export function scriptedSolanaTransport(overrides?: {
  readonly responses?: Record<string, (params: readonly unknown[]) => unknown>;
}) {
  return new ScriptedRpcTransport({
    transportId: "transport:scripted:solana",
    endpoints: [
      fakeEndpoint({ endpointId: "solana-scripted-1", providerName: "ScriptedProvider", chainKey: SOLANA_CHAIN }),
      fakeEndpoint({ endpointId: "solana-scripted-2", providerName: "OtherScriptedProvider", chainKey: SOLANA_CHAIN }),
    ],
    responses: {
      getSlot: () => SOLANA_SLOT,
      getGenesisHash: () => SOLANA_GENESIS,
      getLatestBlockhash: () => ({
        context: { slot: SOLANA_SLOT },
        value: { blockhash: SOLANA_BLOCKHASH, lastValidBlockHeight: 431_054_444 },
      }),
      getFeeForMessage: () => ({ context: { slot: SOLANA_SLOT }, value: 5000 }),
      getBalance: () => ({ context: { slot: SOLANA_SLOT }, value: 750_000_000 }),
      simulateTransaction: () => ({ err: null, logs: ["Program success"] }),
      sendTransaction: () => SOLANA_SIGNATURE,
      getSignatureStatuses: () => ({
        value: [
          {
            slot: SOLANA_TX_SLOT,
            confirmations: 3,
            confirmationStatus: "finalized",
            err: null,
          },
        ],
      }),
      ...(overrides?.responses ?? {}),
    },
  });
}

export function solanaAdapter(overrides?: Parameters<typeof scriptedSolanaTransport>[0]) {
  return new SolanaChainAdapter({
    adapterId: "adapter:solana:test",
    chainKey: SOLANA_CHAIN,
    transport: scriptedSolanaTransport(overrides),
    slotConfirmationTarget: 32,
  });
}

export function solanaRouteHash(directive: OnchainExecutionDirective = solanaTransferDirective()): string {
  return `route:${contentDigest(directive)}`;
}

// --------------------------------------------------------------------------- UTXO

export const BTC_GENESIS = "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f";
export const BTC_TIP_HEIGHT = 969_751;
export const BTC_TIP_HASH = "00000000000000000001a8861740fb02fd413d4199a3207478785fc8b3487885";
export const BTC_TXID = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
export const BTC_TX_BLOCK_HEIGHT = 969_745;
export const BTC_TX_BLOCK_HASH = "0000000000000000000abc5555def9999deadbee00001234feed5678cafebeef";

export function scriptedUtxoTransport(overrides?: {
  readonly responses?: Record<string, () => { status: number; body: unknown; raw?: string }>;
}) {
  return new ScriptedRestTransport({
    transportId: "transport:scripted:utxo",
    endpoints: [
      fakeEndpoint({
        endpointId: "utxo-scripted-1",
        providerName: "ScriptedExplorer",
        chainKey: BITCOIN_CHAIN,
        protocol: "REST",
      }),
      fakeEndpoint({
        endpointId: "utxo-scripted-2",
        providerName: "OtherScriptedExplorer",
        chainKey: BITCOIN_CHAIN,
        protocol: "REST",
      }),
    ],
    responses: {
      "/blocks/tip/height": () => ({ status: 200, body: BTC_TIP_HEIGHT }),
      "/blocks/tip/hash": () => ({ status: 200, body: BTC_TIP_HASH }),
      "/block-height/0": () => ({ status: 200, body: BTC_GENESIS }),
      "/fee-estimates": () => ({
        status: 200,
        body: { "6": 2.5 },
        raw: '{"1":9.876,"2":4.44,"6":2.5,"144":1.008}',
      }),
      [`/address/${BTC_MERCHANT}`]: () => ({
        status: 200,
        body: { chain_stats: { funded_txo_sum: 150_000, spent_txo_sum: 50_000 } },
      }),
      "/tx": () => ({ status: 200, body: BTC_TXID, raw: BTC_TXID }),
      [`/tx/${BTC_TXID}/status`]: () => ({
        status: 200,
        body: { confirmed: true, block_height: BTC_TX_BLOCK_HEIGHT, block_hash: BTC_TX_BLOCK_HASH },
      }),
      ...(overrides?.responses ?? {}),
    },
  });
}

export function utxoAdapter(overrides?: Parameters<typeof scriptedUtxoTransport>[0]) {
  return new UtxoChainAdapter({
    adapterId: "adapter:utxo:test",
    chainKey: BITCOIN_CHAIN,
    transport: scriptedUtxoTransport(overrides),
    confirmationDepthTarget: 6,
    feeEstimateTargetBlocks: 6,
  });
}

/** A UTXO adapter over an explicitly-provided scripted transport. */
export function utxoAdapterWithTransport(transport: ReturnType<typeof scriptedUtxoTransport>) {
  return new UtxoChainAdapter({
    adapterId: "adapter:utxo:test",
    chainKey: BITCOIN_CHAIN,
    transport,
    confirmationDepthTarget: 6,
    feeEstimateTargetBlocks: 6,
  });
}

export function utxoRouteHash(directive: OnchainExecutionDirective = utxoTransferDirective()): string {
  return `route:${contentDigest(directive)}`;
}

export { ETHEREUM_ASSET_ID, SOLANA_ASSET_ID, BITCOIN_ASSET_ID, MERCHANT };

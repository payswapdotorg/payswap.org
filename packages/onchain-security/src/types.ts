/**
 * @payswap/onchain-security — Provider-neutral identity types
 * (Work Order P4-W1-002; UMI-ARCHITECTURE "Onchain capability model").
 *
 * Core contracts must not assume EVM, one wallet, one RPC, one indexer, one
 * DEX or one stablecoin (architecture law). Every identity below is a
 * provider-neutral structural type:
 *
 * - `ChainRef` / `AssetIdentity` / `ProtocolIdentity` are the STRUCTURAL
 *   alignment surface for P4-W1-001's onchain domain/capability kernel
 *   (ChainDefinition / AssetDefinition / ProtocolDefinition). They are
 *   intentionally minimal and structurally assignable from W1-001's richer
 *   contracts; the Tech Lead resolves the package-level integration at
 *   merge. This package must NOT define chain adapters (W2-001 scope) or a
 *   parallel capability vocabulary (W1-001 scope).
 *
 * Money is exact integer minor units via @payswap/trust `AmountSpec`
 * (INV-F01; no floating point ever crosses this boundary).
 */

import type { AmountSpec } from "@payswap/trust";
import type { SmartContractExtension } from "@payswap/capabilities";

/**
 * Canonical chain reference, e.g. `ethereum:mainnet`, `solana:mainnet`.
 * Structurally compatible with W1-001 `ChainDefinition.id`.
 */
export type ChainRef = string;

/** Chain reference shape: `network:segment` with non-empty parts. */
export const CHAIN_REF_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*:[a-z0-9]+(-[a-z0-9]+)*$/;

/** Raised on malformed identity input (fail closed, never guessed). */
export class IdentityValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityValidationError";
  }
}

/** Validate a chain reference (deterministic, provider-neutral shape). */
export function validateChainRef(chain: ChainRef): void {
  if (!CHAIN_REF_PATTERN.test(chain)) {
    throw new IdentityValidationError(
      `chain reference '${chain}' must match '<network>:<segment>' (lowercase, hyphenated)`,
    );
  }
}

/**
 * Onchain asset identity: chain-scoped. `USDC` on `ethereum:mainnet` and
 * `USDC` on `solana:mainnet` are DIFFERENT assets (fake-token defense is
 * exact-match on chain + assetId + symbol).
 *
 * `symbol` is the exact-money currency code used in `AmountSpec` (the
 * currency must be registered with @payswap/protocol before exact amount
 * arithmetic — money semantics are protocol-owned).
 */
export interface AssetIdentity {
  readonly chain: ChainRef;
  /** Canonical on-chain asset id: native symbol or token contract address. */
  readonly assetId: string;
  /** Display/trading symbol; the AmountSpec currency for this asset. */
  readonly symbol: string;
}

export function validateAssetIdentity(asset: AssetIdentity): void {
  validateChainRef(asset.chain);
  if (asset.assetId.trim().length === 0 || asset.assetId.length > 128) {
    throw new IdentityValidationError(
      `assetId must be a non-empty canonical id of at most 128 characters, got '${asset.assetId}'`,
    );
  }
  if (!/^[A-Z0-9]{2,10}$/.test(asset.symbol)) {
    throw new IdentityValidationError(
      `asset symbol '${asset.symbol}' must be 2-10 uppercase alphanumeric characters`,
    );
  }
}

/** Exact asset identity equality (no cross-chain, no symbol-only equality). */
export function sameAsset(a: AssetIdentity, b: AssetIdentity): boolean {
  return a.chain === b.chain && a.assetId === b.assetId && a.symbol === b.symbol;
}

/**
 * Declared protocol / contract identity for a consequential write
 * (INV-SC01 via the canonical @payswap/capabilities declaration model —
 * never a parallel vocabulary).
 */
export interface ProtocolIdentity {
  /** Protocol id as certified in the capability graph (e.g. `uniswap:v3`). */
  readonly protocolId: string;
  /** Protocol version (numeric dotted, e.g. `1.2.0`). */
  readonly version: string;
  /** The concrete contract this write targets (canonical INV-SC01 declaration). */
  readonly contract: SmartContractExtension;
}

export function validateProtocolIdentity(protocol: ProtocolIdentity): void {
  if (protocol.protocolId.trim().length === 0) {
    throw new IdentityValidationError("protocolId must be a non-empty canonical id");
  }
  if (!/^\d+(\.\d+)*$/.test(protocol.version)) {
    throw new IdentityValidationError(
      `protocol version '${protocol.version}' must be numeric dotted (e.g. 1.2.0)`,
    );
  }
  if (protocol.contract.chainRef.trim().length === 0) {
    throw new IdentityValidationError("protocol contract chainRef must be non-empty");
  }
  if (protocol.contract.contractAddress.trim().length === 0) {
    throw new IdentityValidationError("protocol contract address must be non-empty");
  }
}

/**
 * Deterministic protocol identity equality: protocol id, version and the
 * full INV-SC01 contract declaration (chain + address + source/bytecode
 * hashes + authorities) must ALL match. Any drift is a different protocol
 * surface (address-poisoning / proxy-swap defense; fail closed).
 */
export function sameProtocol(a: ProtocolIdentity, b: ProtocolIdentity): boolean {
  if (a.protocolId !== b.protocolId || a.version !== b.version) {
    return false;
  }
  const left = a.contract;
  const right = b.contract;
  return (
    left.chainRef === right.chainRef &&
    left.contractAddress === right.contractAddress &&
    left.sourceHash === right.sourceHash &&
    left.bytecodeHash === right.bytecodeHash &&
    left.upgradeAuthority.kind === right.upgradeAuthority.kind &&
    left.adminAuthority.kind === right.adminAuthority.kind &&
    left.custody.custodial === right.custody.custodial
  );
}

/**
 * Address canonicalizer port. Core contracts must not assume an address
 * encoding, so identity comparison defaults to EXACT string equality
 * (fail closed) and chain families inject their canonicalizer (e.g. the
 * EVM adapter lowercases hex addresses) at the wiring layer.
 */
export interface AddressCanonicalizer {
  readonly chain: ChainRef;
  canonical(address: string): string;
}

/** Default: exact string equality (provider-neutral, fail closed). */
export const EXACT_ADDRESS: AddressCanonicalizer = {
  chain: "*",
  canonical: (address: string) => address,
};

/** Structural address validity: non-empty, no whitespace, bounded length. */
export function validateAddress(address: string, label: string): void {
  if (address.length === 0 || address.trim() !== address || /\s/.test(address)) {
    throw new IdentityValidationError(
      `${label} '${address}' must be a non-empty canonical address without whitespace`,
    );
  }
  if (address.length > 256) {
    throw new IdentityValidationError(`${label} exceeds 256 characters`);
  }
}

/**
 * Approval (allowance) change requested as part of a consequential write.
 * A zero amount means "revoke the allowance"; `unlimited` marks a
 * max-integer allowance, which policy can forbid outright.
 */
export interface ApprovalChangeRequest {
  readonly asset: AssetIdentity;
  /** The contract permitted to spend (e.g. a router). Exact identity. */
  readonly spender: string;
  /** New allowance. Exact integer minor units (INV-F01). */
  readonly amount: AmountSpec;
  readonly unlimited: boolean;
}

/**
 * Generic contract interaction (the controlled escape hatch, rule 28):
 * unknown / uncertified targets never execute silently — the deterministic
 * gate blocks or escalates per policy.
 */
export interface ContractCallRequest {
  readonly target: string;
  /** Opaque encoded call data (adapter-owned encoding). */
  readonly calldata: string;
  /** Digest of the calldata, binding recheck to the exact payload. */
  readonly calldataDigest: string;
  /** Native value attached to the call, when any. */
  readonly value?: AmountSpec;
}

/** Binding of a write to the settlement instruction it executes (INV-E01). */
export interface SettlementInstructionBinding {
  readonly instructionId: string;
  /** Deterministic digest of the full instruction content (see digest.ts). */
  readonly instructionDigest: string;
}

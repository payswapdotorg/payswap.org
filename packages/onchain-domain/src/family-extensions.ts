/**
 * @payswap/onchain-domain — FAMILY-SCOPED EXTENSION CONTRACTS (P4-W1-001).
 *
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║ THIS IS THE ONLY MODULE OF THIS PACKAGE THAT MAY CARRY FAMILY-       ║
 * ║ SPECIFIC SHAPES (evmChainId, EVM address/token standards, gas/fee    ║
 * ║ model wording, …). Every neutral core contract (chain, asset,        ║
 * ║ protocol, wallet, execution, settlement mapping) references these    ║
 * ║ extensions ONLY through the opaque, optional `familyExtension`       ║
 * ║ unions re-exported with neutral names:                               ║
 * ║   - ChainDescriptorFamilyExtension / ChainInstanceFamilyExtension    ║
 * ║   - AssetFamilyExtension                                             ║
 * ║ Core contracts NEVER require an extension: a chain, asset, instance  ║
 * ║ or asset observation is fully valid without one, so non-EVM families ║
 * ║ are expressible without any family-specific field leaking into the   ║
 * ║ neutral vocabulary (adversarially guarded by the structural source   ║
 * ║ scan in test/adversarial.test.ts).                                   ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */

import { ValidationError } from "@payswap/protocol";
import type { ChainFamily } from "./family.js";

// ---------------------------------------------------------------------------
// Chain descriptor extensions (optional, family-scoped)
// ---------------------------------------------------------------------------

/**
 * Chain descriptor extension: EVM family. Carries the EVM-specific identity
 * (numeric chain id) and declared EVM conventions. Descriptive only — never
 * execution authority.
 */
export interface EvmChainDescriptor {
  readonly family: "EVM";
  /** Canonical decimal chain id, e.g. `1`, `137` (no leading zeros, exact). */
  readonly evmChainId: string;
  /** Declared contract address convention on this chain. */
  readonly contractAddressFormat: "HEX_20_BYTE";
  /** Declared fee/execution-cost model on this chain. */
  readonly feeModel: "GAS_AUCTION";
}

/** Chain descriptor extension: Solana family. */
export interface SolanaChainDescriptor {
  readonly family: "SOLANA";
  /** Cluster identity (e.g. `mainnet-beta`) when the descriptor scopes one. */
  readonly cluster?: string;
}

/** Chain descriptor extension: UTXO family (e.g. Bitcoin-like). */
export interface UtxoChainDescriptor {
  readonly family: "UTXO";
  /** Coin identity (e.g. `bitcoin`) when the descriptor scopes one. */
  readonly coin?: string;
}

/** The union of chain-descriptor family extensions (neutral re-export name). */
export type ChainDescriptorFamilyExtension =
  | EvmChainDescriptor
  | SolanaChainDescriptor
  | UtxoChainDescriptor;

// ---------------------------------------------------------------------------
// Chain instance extensions (optional, family-scoped)
// ---------------------------------------------------------------------------

/**
 * Chain instance extension: EVM family. Carries the EVM chain id AS OBSERVED
 * BY THE CONNECTED INSTANCE (e.g. the id its endpoint reports). Optional on
 * ConnectedChainInstance and never required by any core contract.
 */
export interface EvmChainInstance {
  readonly family: "EVM";
  /** EVM chain id observed for this connected instance (canonical decimal string). */
  readonly evmChainId: string;
}

/** The union of chain-instance family extensions (neutral re-export name). */
export type ChainInstanceFamilyExtension = EvmChainInstance;

// ---------------------------------------------------------------------------
// Asset family extensions (optional, family-scoped)
// ---------------------------------------------------------------------------

/**
 * Asset family extension: EVM. Carries the token contract address and the
 * EVM token standard. Descriptive catalogue metadata only.
 */
export interface EvmAssetDescriptor {
  readonly family: "EVM";
  readonly contractAddress: string;
  readonly tokenStandard: "ERC20" | "ERC721" | "ERC1155" | "PROVIDER_DEFINED";
}

/** The union of asset family extensions (neutral re-export name). */
export type AssetFamilyExtension = EvmAssetDescriptor;

// ---------------------------------------------------------------------------
// Guards + validators (family-scoped)
// ---------------------------------------------------------------------------

export function isEvmChainDescriptor(
  value: unknown,
): value is EvmChainDescriptor {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Partial<EvmChainDescriptor>).family === "EVM"
  );
}

export function isSolanaChainDescriptor(
  value: unknown,
): value is SolanaChainDescriptor {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Partial<SolanaChainDescriptor>).family === "SOLANA"
  );
}

export function isUtxoChainDescriptor(
  value: unknown,
): value is UtxoChainDescriptor {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Partial<UtxoChainDescriptor>).family === "UTXO"
  );
}

export function isEvmChainInstance(value: unknown): value is EvmChainInstance {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Partial<EvmChainInstance>).family === "EVM"
  );
}

const DECIMAL_CHAIN_ID_PATTERN = /^(0|[1-9][0-9]*)$/;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Validates a chain-descriptor family extension: the discriminant family
 * must match the expected family of the carrying descriptor, and
 * family-specific fields must be well-formed (e.g. an EVM chain id is a
 * canonical decimal string). Families without a declared extension shape
 * (MOVE, COSMOS, SUBSTRATE, OTHER) reject any extension — an undeclared
 * extension shape is never guessed.
 */
export function validateChainDescriptorFamilyExtension(
  candidate: unknown,
  expectedFamily: ChainFamily,
): ChainDescriptorFamilyExtension {
  if (candidate === null || typeof candidate !== "object") {
    throw new ValidationError(
      "family extension must be an object carrying a family discriminant",
    );
  }
  const record = candidate as Readonly<Record<string, unknown>>;
  if (record.family !== expectedFamily) {
    throw new ValidationError(
      `family extension discriminant '${String(record.family)}' does not match the descriptor family '${expectedFamily}'`,
    );
  }
  if (expectedFamily !== "EVM" && expectedFamily !== "SOLANA" && expectedFamily !== "UTXO") {
    throw new ValidationError(
      `family '${expectedFamily}' has no declared extension shape — extensions are only declared for EVM, SOLANA and UTXO`,
    );
  }
  if (expectedFamily === "EVM") {
    if (!isNonEmptyString(record.evmChainId) || !DECIMAL_CHAIN_ID_PATTERN.test(record.evmChainId)) {
      throw new ValidationError(
        "evmChainId must be a canonical decimal string (no leading zeros)",
      );
    }
    if (record.contractAddressFormat !== "HEX_20_BYTE") {
      throw new ValidationError(
        "contractAddressFormat must be 'HEX_20_BYTE' for the family extension",
      );
    }
    if (record.feeModel !== "GAS_AUCTION") {
      throw new ValidationError("feeModel must be 'GAS_AUCTION' for the family extension");
    }
    return {
      family: "EVM",
      evmChainId: record.evmChainId,
      contractAddressFormat: "HEX_20_BYTE",
      feeModel: "GAS_AUCTION",
    };
  }
  if (expectedFamily === "SOLANA") {
    const cluster = record.cluster;
    if (cluster !== undefined && !isNonEmptyString(cluster)) {
      throw new ValidationError("cluster, when present, must be a non-empty string");
    }
    return {
      family: "SOLANA",
      ...(cluster !== undefined ? { cluster } : {}),
    };
  }
  const coin = record.coin;
  if (coin !== undefined && !isNonEmptyString(coin)) {
    throw new ValidationError("coin, when present, must be a non-empty string");
  }
  return {
    family: "UTXO",
    ...(coin !== undefined ? { coin } : {}),
  };
}

/**
 * Validates a chain-instance family extension (EVM chain id observed by the
 * connected instance).
 */
export function validateChainInstanceFamilyExtension(
  candidate: unknown,
): ChainInstanceFamilyExtension {
  if (candidate === null || typeof candidate !== "object") {
    throw new ValidationError("instance family extension must be an object");
  }
  const record = candidate as Readonly<Record<string, unknown>>;
  if (record.family !== "EVM") {
    throw new ValidationError(
      `instance family extension discriminant '${String(record.family)}' is not supported (supported: EVM)`,
    );
  }
  if (!isNonEmptyString(record.evmChainId) || !DECIMAL_CHAIN_ID_PATTERN.test(record.evmChainId)) {
    throw new ValidationError(
      "evmChainId must be a canonical decimal string (no leading zeros)",
    );
  }
  return { family: "EVM", evmChainId: record.evmChainId };
}

/**
 * Validates an asset family extension (EVM token descriptor). The contract
 * address format is intentionally NOT interpreted here — validation only
 * requires a non-empty opaque string; family adapters own real formats.
 */
export function validateAssetFamilyExtension(
  candidate: unknown,
): AssetFamilyExtension {
  if (candidate === null || typeof candidate !== "object") {
    throw new ValidationError("asset family extension must be an object");
  }
  const record = candidate as Readonly<Record<string, unknown>>;
  if (record.family !== "EVM") {
    throw new ValidationError(
      `asset family extension discriminant '${String(record.family)}' is not supported (supported: EVM)`,
    );
  }
  if (!isNonEmptyString(record.contractAddress)) {
    throw new ValidationError("contractAddress must be a non-empty string");
  }
  const standard = record.tokenStandard;
  if (
    standard !== "ERC20" &&
    standard !== "ERC721" &&
    standard !== "ERC1155" &&
    standard !== "PROVIDER_DEFINED"
  ) {
    throw new ValidationError(
      "tokenStandard must be ERC20, ERC721, ERC1155 or PROVIDER_DEFINED",
    );
  }
  return {
    family: "EVM",
    contractAddress: record.contractAddress,
    tokenStandard: standard,
  };
}

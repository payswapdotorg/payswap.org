/**
 * @payswap/onchain-domain — wallet, signer and smart-account capability
 * vocabulary (P4-W1-001; FROZEN-ARCHITECTURE §12; INV-SC03).
 *
 * Wallets, signers and smart accounts are capabilities in the EXISTING
 * Capability/Connector model (AGENTS.md rule 24): each flavor is a
 * CapabilityDefinition (§2A layer 1) plus an onchain flavor declaration
 * (see ./onchain-capabilities.js). The connected/authorized forms are
 * ConnectedCapabilityInstances (§2A layer 3) — never redefined here.
 *
 * PaySwap does not require custody of private keys. No key material, seed
 * material or other credential material exists anywhere in these contracts: agent-facing
 * code sees only OPAQUE references. `SignerHandle` is the opaque reference
 * to a signing instrument bound to a connected capability instance; the
 * validator rejects key-material-shaped handle ids outright (a handle that
 * IS key material is a security incident, not a handle).
 *
 * INV-SC03: smart-account/session-key authority is bounded by an explicit
 * permission envelope — declared as a literal `true` on the smart-account
 * capability so an unbounded declaration is unconstructible.
 */

import { ValidationError } from "@payswap/protocol";
import type { ChainFamily } from "./family.js";
import { isChainFamily } from "./family.js";
import type { OnchainOperationKind } from "./operations.js";
import { isOnchainOperationKind, ONCHAIN_OPERATION_KINDS } from "./operations.js";

// ---------------------------------------------------------------------------
// Custody models (who controls the keys — declared, never the material)
// ---------------------------------------------------------------------------

export const WALLET_CUSTODY_MODELS = [
  /** An external wallet fully controlled by the user; PaySwap never touches key material. */
  "NON_CUSTODIAL_EXTERNAL",
  /** Keys held directly by the user (user-side keystore). */
  "SELF_CUSTODIAL",
  /** A contract account whose authority is bounded by a permission envelope. */
  "SMART_ACCOUNT",
  /** A third-party custodian holds keys under its own controls. */
  "CUSTODIAL_PROVIDER",
  /** A dedicated hardware device signs with user presence. */
  "HARDWARE",
  /** A declared combination of the above. */
  "HYBRID",
] as const;

export type WalletCustodyModel = (typeof WALLET_CUSTODY_MODELS)[number];

export function isWalletCustodyModel(value: unknown): value is WalletCustodyModel {
  return (
    typeof value === "string" &&
    (WALLET_CUSTODY_MODELS as readonly unknown[]).includes(value)
  );
}

// ---------------------------------------------------------------------------
// The opaque signer handle
// ---------------------------------------------------------------------------

/**
 * An OPAQUE reference to a signing instrument (INV-A04: a scoped
 * instrument, never an unrestricted money-movement tool). Carries:
 * - an opaque handle id (NEVER key material — the validator rejects
 *   key-shaped ids);
 * - the connected capability instance that provides the signer (the
 *   authorization scope — never a catalogue entry);
 * - the declared custody model (who controls the keys);
 * - an optional bounded permission-envelope reference (INV-SC03);
 * - an optional expiry.
 */
export interface SignerHandle {
  readonly handleId: string;
  readonly capabilityInstanceId: string;
  readonly custodyModel: WalletCustodyModel;
  /** INV-SC03: reference to the explicit permission envelope bounding this signer. */
  readonly permissionEnvelopeRef?: string;
  readonly expiresAt?: string;
}

/** Raw 32-byte key material patterns (with or without an 0x prefix). */
const RAW_KEY_MATERIAL_PATTERN = /^(0x)?[0-9a-fA-F]{64}$/;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Runtime validation for a signer handle from untyped sources. Beyond
 * structural rules, the handle id is scanned for key-material shapes: a
 * 64-hex-character id (± 0x prefix) is EXACTLY the size of raw private key
 * material and is rejected outright — a handle that is key material is a
 * security incident, not a handle (AGENTS.md rule 25).
 */
export function validateSignerHandle(candidate: unknown): SignerHandle {
  const errors: string[] = [];
  if (candidate === null || typeof candidate !== "object") {
    throw new ValidationError("signer handle must be an object");
  }
  const record = candidate as Readonly<Record<string, unknown>>;
  if (!isNonEmptyString(record.handleId)) {
    errors.push("handleId must be a non-empty opaque string");
  } else {
    if (record.handleId.length > 256) {
      errors.push("handleId must not exceed 256 characters");
    }
    if (/\s/.test(record.handleId)) {
      errors.push("handleId must not contain whitespace (opaque identifiers never do)");
    }
    if (RAW_KEY_MATERIAL_PATTERN.test(record.handleId)) {
      errors.push(
        "handleId matches raw 32-byte key material and is rejected: a SignerHandle is an opaque reference, NEVER key material (AGENTS.md rule 25)",
      );
    }
  }
  if (!isNonEmptyString(record.capabilityInstanceId)) {
    errors.push(
      "capabilityInstanceId must be a non-empty string referencing the ConnectedCapabilityInstance that provides the signer",
    );
  }
  if (!isWalletCustodyModel(record.custodyModel)) {
    errors.push(`custodyModel must be one of [${WALLET_CUSTODY_MODELS.join(", ")}]`);
  }
  if (record.permissionEnvelopeRef !== undefined && !isNonEmptyString(record.permissionEnvelopeRef)) {
    errors.push("permissionEnvelopeRef, when present, must be a non-empty string (INV-SC03)");
  }
  if (record.expiresAt !== undefined && !isNonEmptyString(record.expiresAt)) {
    errors.push("expiresAt, when present, must be a non-empty timestamp string");
  }
  if (errors.length > 0) {
    throw new ValidationError(`Invalid signer handle: ${errors.join("; ")}`, {
      errors: [...errors],
    });
  }
  return candidate as SignerHandle;
}

// ---------------------------------------------------------------------------
// Wallet / signer / smart-account capability declarations (§2A layer 1 flavor)
// ---------------------------------------------------------------------------

/**
 * Wallet capability declaration: operate a wallet — observe its external
 * positions (as AssetObservations) and originate onchain operations through
 * its signer capabilities. The custody model declares WHO controls keys;
 * the material itself never appears.
 */
export interface WalletCapabilityDeclaration {
  readonly capabilityKind: "wallet";
  readonly custodyModel: WalletCustodyModel;
  readonly supportedFamilies: readonly ChainFamily[];
  /** Operation kinds this wallet can originate end-to-end. */
  readonly supportedOperations: readonly OnchainOperationKind[];
}

/**
 * Signer capability declaration: sign scoped onchain operations. The
 * `signableOperations` allowlist is the declared scope — a signer that may
 * sign everything is expressible, but the allowlist is still explicit (and
 * INV-A04 scoping is enforced at the authorization layer, P4-W1-002).
 */
export interface SignerCapabilityDeclaration {
  readonly capabilityKind: "signer";
  readonly custodyModel: WalletCustodyModel;
  readonly signableOperations: readonly OnchainOperationKind[];
  /** Whether each signature requires user presence (hardware / prompt). */
  readonly requiresUserPresence: boolean;
  /** Whether bounded session keys are supported. */
  readonly supportsSessionKeys: boolean;
}

/**
 * Smart-account capability declaration (FROZEN-ARCHITECTURE §12).
 * `permissionEnvelopeRequired` is a literal `true` type: smart-account /
 * session-key authority is ALWAYS bounded by an explicit permission
 * envelope (INV-SC03) — an unbounded smart-account capability is
 * unconstructible.
 */
export interface SmartAccountCapabilityDeclaration {
  readonly capabilityKind: "smart_account";
  readonly permissionEnvelopeRequired: true;
  readonly supportsSessionKeys: boolean;
  readonly supportsSpendingPolicies: boolean;
  readonly supportsBatchExecution: boolean;
  readonly supportsGasSponsorship: boolean;
  /** Declared, provider-neutral recovery model description. */
  readonly recoveryModel: string;
}

function validateOperationList(
  record: Readonly<Record<string, unknown>>,
  field: "supportedOperations" | "signableOperations",
  errors: string[],
): void {
  const value = record[field];
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(
      `${field} must be a non-empty array of onchain operation kinds (the declared scope is always explicit)`,
    );
    return;
  }
  for (const item of value) {
    if (!isOnchainOperationKind(item)) {
      errors.push(
        `${field} contains '${String(item)}' which is not one of [${ONCHAIN_OPERATION_KINDS.join(", ")}]`,
      );
    }
  }
}

function validateFamilyList(
  record: Readonly<Record<string, unknown>>,
  errors: string[],
): void {
  const value = record.supportedFamilies;
  if (!Array.isArray(value) || value.length === 0) {
    errors.push("supportedFamilies must be a non-empty array of chain families");
    return;
  }
  for (const item of value) {
    if (!isChainFamily(item)) {
      errors.push(`supportedFamilies contains an unknown chain family '${String(item)}'`);
    }
  }
}

/** Validates a wallet capability declaration. */
export function validateWalletCapabilityDeclaration(
  candidate: unknown,
): WalletCapabilityDeclaration {
  if (candidate === null || typeof candidate !== "object") {
    throw new ValidationError("wallet capability declaration must be an object");
  }
  const record = candidate as Readonly<Record<string, unknown>>;
  const errors: string[] = [];
  if (record.capabilityKind !== "wallet") {
    errors.push("capabilityKind must be 'wallet'");
  }
  if (!isWalletCustodyModel(record.custodyModel)) {
    errors.push(`custodyModel must be one of [${WALLET_CUSTODY_MODELS.join(", ")}]`);
  }
  validateFamilyList(record, errors);
  validateOperationList(record, "supportedOperations", errors);
  if (errors.length > 0) {
    throw new ValidationError(`Invalid wallet capability declaration: ${errors.join("; ")}`, {
      errors: [...errors],
    });
  }
  return candidate as WalletCapabilityDeclaration;
}

/** Validates a signer capability declaration. */
export function validateSignerCapabilityDeclaration(
  candidate: unknown,
): SignerCapabilityDeclaration {
  if (candidate === null || typeof candidate !== "object") {
    throw new ValidationError("signer capability declaration must be an object");
  }
  const record = candidate as Readonly<Record<string, unknown>>;
  const errors: string[] = [];
  if (record.capabilityKind !== "signer") {
    errors.push("capabilityKind must be 'signer'");
  }
  if (!isWalletCustodyModel(record.custodyModel)) {
    errors.push(`custodyModel must be one of [${WALLET_CUSTODY_MODELS.join(", ")}]`);
  }
  validateOperationList(record, "signableOperations", errors);
  if (typeof record.requiresUserPresence !== "boolean") {
    errors.push("requiresUserPresence must be a boolean");
  }
  if (typeof record.supportsSessionKeys !== "boolean") {
    errors.push("supportsSessionKeys must be a boolean");
  }
  if (errors.length > 0) {
    throw new ValidationError(`Invalid signer capability declaration: ${errors.join("; ")}`, {
      errors: [...errors],
    });
  }
  return candidate as SignerCapabilityDeclaration;
}

/** Validates a smart-account capability declaration (INV-SC03 literal). */
export function validateSmartAccountCapabilityDeclaration(
  candidate: unknown,
): SmartAccountCapabilityDeclaration {
  if (candidate === null || typeof candidate !== "object") {
    throw new ValidationError("smart-account capability declaration must be an object");
  }
  const record = candidate as Readonly<Record<string, unknown>>;
  const errors: string[] = [];
  if (record.capabilityKind !== "smart_account") {
    errors.push("capabilityKind must be 'smart_account'");
  }
  if (record.permissionEnvelopeRequired !== true) {
    errors.push(
      "permissionEnvelopeRequired must be true: smart-account/session-key authority is always bounded by an explicit permission envelope (INV-SC03)",
    );
  }
  for (const field of [
    "supportsSessionKeys",
    "supportsSpendingPolicies",
    "supportsBatchExecution",
    "supportsGasSponsorship",
  ] as const) {
    if (typeof record[field] !== "boolean") {
      errors.push(`${field} must be a boolean`);
    }
  }
  if (!isNonEmptyString(record.recoveryModel)) {
    errors.push("recoveryModel must be a declared non-empty string (never assumed)");
  }
  if (errors.length > 0) {
    throw new ValidationError(`Invalid smart-account capability declaration: ${errors.join("; ")}`, {
      errors: [...errors],
    });
  }
  return candidate as SmartAccountCapabilityDeclaration;
}

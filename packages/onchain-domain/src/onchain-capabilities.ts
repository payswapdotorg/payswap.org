/**
 * @payswap/onchain-domain — onchain capability flavors (P4-W1-001).
 *
 * Every onchain capability flavor is a CapabilityDefinition (§2A layer 1,
 * the canonical connectors contract — never redefined here) plus an
 * `onchain` flavor declaration discriminated by `capabilityKind`:
 *
 * - WalletCapability / SignerCapability / SmartAccountCapability
 *   (declarations owned by ./wallet.js);
 * - OnchainExecutionCapability — executes consequential onchain writes;
 * - ContractInteractionCapability — GenericContractInteractionCapability,
 *   the CONTROLLED ESCAPE HATCH: `controlledEscapeHatch` and
 *   `certificationRequired` are literal `true` types and
 *   `unknownWritePolicy` has NO allow-silent member — unknown generic
 *   contract writes never execute silently (AGENTS.md rule 28);
 * - DexCapability / BridgeCapability / IntentExecutionCapability.
 *
 * Deterministic flavor discrimination: `validateOnchainCapabilityDefinition`
 * validates the canonical base then dispatches on the declared
 * `capabilityKind`; every flavor has exactly one validator and an unknown
 * discriminant fails closed.
 */

import { ValidationError } from "@payswap/protocol";
import type { CapabilityDefinition } from "@payswap/connectors";
import { validateCapabilityDefinition } from "@payswap/connectors";
import type { ChainFamily } from "./family.js";
import { isChainFamily, isValidChainKey } from "./family.js";
import type { OnchainOperationKind } from "./operations.js";
import { isOnchainOperationKind, ONCHAIN_OPERATION_KINDS } from "./operations.js";
import type {
  WalletCapabilityDeclaration,
  SignerCapabilityDeclaration,
  SmartAccountCapabilityDeclaration,
} from "./wallet.js";
import {
  validateWalletCapabilityDeclaration,
  validateSignerCapabilityDeclaration,
  validateSmartAccountCapabilityDeclaration,
} from "./wallet.js";

// ---------------------------------------------------------------------------
// Execution capability (consequential onchain writes)
// ---------------------------------------------------------------------------

/**
 * Onchain execution capability declaration. `preBroadcastRecheckRequired`
 * is a literal `true` type: supported consequential onchain writes require
 * simulation (where supported) plus a pre-broadcast re-check (AGENTS.md
 * rule 26) — an execution capability without the re-check is
 * unconstructible.
 */
export interface OnchainExecutionCapabilityDeclaration {
  readonly capabilityKind: "onchain_execution";
  readonly supportedOperations: readonly OnchainOperationKind[];
  readonly supportedFamilies: readonly ChainFamily[];
  readonly supportsSimulation: boolean;
  readonly preBroadcastRecheckRequired: true;
}

export interface OnchainExecutionCapability extends CapabilityDefinition {
  readonly onchain: OnchainExecutionCapabilityDeclaration;
}

// ---------------------------------------------------------------------------
// Generic contract interaction (the CONTROLLED escape hatch — rule 28)
// ---------------------------------------------------------------------------

/**
 * GenericContractInteractionCapability declaration — the controlled escape
 * hatch for contract interactions outside certified domain capabilities.
 *
 * Structural safety (rule 28 — unknown generic contract writes never execute
 * silently):
 * - `controlledEscapeHatch: true` (literal type) — the hatch is always
 *   declared as what it is;
 * - `certificationRequired: true` (literal type) — only certified method
 *   declarations may execute;
 * - `certifiedMethodIds` — the explicit allowlist of certified method ids;
 * - `unknownWritePolicy` — ONLY `BLOCK` or `REQUIRE_ESCALATION`. There is
 *   deliberately no `ALLOW` member anywhere in this vocabulary.
 */
export interface ContractInteractionCapabilityDeclaration {
  readonly capabilityKind: "contract_interaction";
  readonly controlledEscapeHatch: true;
  readonly certificationRequired: true;
  readonly certifiedMethodIds: readonly string[];
  readonly unknownWritePolicy: "BLOCK" | "REQUIRE_ESCALATION";
}

export interface ContractInteractionCapability extends CapabilityDefinition {
  readonly onchain: ContractInteractionCapabilityDeclaration;
}

// ---------------------------------------------------------------------------
// DEX / bridge / intent capabilities
// ---------------------------------------------------------------------------

export type SwapKind = "EXACT_INPUT" | "EXACT_OUTPUT";

/**
 * DEX/aggregator capability declaration. Best execution optimizes the
 * eligible executable economic outcome, never the quoted price alone
 * (UNIVERSAL-MONEY-INTERFACE-ARCHITECTURE "Best execution"): the declared
 * quote semantics and slippage protection feed that evaluation.
 */
export interface DexCapabilityDeclaration {
  readonly capabilityKind: "dex";
  readonly supportedSwapKinds: readonly SwapKind[];
  /** Chain keys this DEX capability serves (deterministic identity scope). */
  readonly supportedChains: readonly string[];
  readonly quoteSemantics: "INDICATIVE" | "EXECUTABLE";
  readonly slippageProtection: "DECLARED_LIMIT" | "PROVIDER_DEFINED";
}

export interface DexCapability extends CapabilityDefinition {
  readonly onchain: DexCapabilityDeclaration;
}

/**
 * Bridge capability declaration. `custodialTransit` declares whether value
 * is held in custody during transit — a declared, risk-relevant property
 * (INV-NC02/NC03 discipline: custody claims are declarations, never
 * assumptions).
 */
export interface BridgeCapabilityDeclaration {
  readonly capabilityKind: "bridge";
  readonly sourceChains: readonly string[];
  readonly destinationChains: readonly string[];
  readonly custodialTransit: boolean;
  readonly destinationFinality: "ATTESTED" | "OBSERVED" | "PROVIDER_DEFINED";
}

export interface BridgeCapability extends CapabilityDefinition {
  readonly onchain: BridgeCapabilityDeclaration;
}

/**
 * Intent-network capability declaration: solver-settled execution intents.
 */
export interface IntentExecutionCapabilityDeclaration {
  readonly capabilityKind: "intent";
  readonly supportedDomains: readonly string[];
  readonly settlementModel: "FULFILLER_SETTLED" | "ESCROWED" | "PROVIDER_DEFINED";
  readonly solverCompetition: "OPEN" | "SINGLE_SOLVER" | "PROVIDER_DEFINED";
}

export interface IntentExecutionCapability extends CapabilityDefinition {
  readonly onchain: IntentExecutionCapabilityDeclaration;
}

// ---------------------------------------------------------------------------
// The wallet/signer/smart-account capability wrappers (§2A layer 1 flavor)
// ---------------------------------------------------------------------------

export interface WalletCapability extends CapabilityDefinition {
  readonly onchain: WalletCapabilityDeclaration;
}

export interface SignerCapability extends CapabilityDefinition {
  readonly onchain: SignerCapabilityDeclaration;
}

export interface SmartAccountCapability extends CapabilityDefinition {
  readonly onchain: SmartAccountCapabilityDeclaration;
}

/** The discriminated union of all onchain capability flavors. */
export type OnchainCapability =
  | WalletCapability
  | SignerCapability
  | SmartAccountCapability
  | OnchainExecutionCapability
  | ContractInteractionCapability
  | DexCapability
  | BridgeCapability
  | IntentExecutionCapability;

/** The discriminant of an onchain capability flavor declaration. */
export type OnchainCapabilityKind =
  | "wallet"
  | "signer"
  | "smart_account"
  | "onchain_execution"
  | "contract_interaction"
  | "dex"
  | "bridge"
  | "intent";

export const ONCHAIN_CAPABILITY_KINDS: readonly OnchainCapabilityKind[] = [
  "wallet",
  "signer",
  "smart_account",
  "onchain_execution",
  "contract_interaction",
  "dex",
  "bridge",
  "intent",
];

export function isOnchainCapabilityKind(value: unknown): value is OnchainCapabilityKind {
  return (
    typeof value === "string" &&
    (ONCHAIN_CAPABILITY_KINDS as readonly unknown[]).includes(value)
  );
}

// ---------------------------------------------------------------------------
// Deterministic flavor validation (dispatch)
// ---------------------------------------------------------------------------

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validateChainKeyList(
  value: unknown,
  field: string,
  errors: string[],
): void {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${field} must be a non-empty array of canonical chain keys`);
    return;
  }
  for (const item of value) {
    if (!isValidChainKey(item)) {
      errors.push(`${field} contains '${String(item)}' which is not a canonical chain key`);
    }
  }
}

function validateOperationKindList(
  value: unknown,
  field: string,
  errors: string[],
): void {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${field} must be a non-empty array of onchain operation kinds`);
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

/**
 * Deterministic flavor validation + discrimination: validates the canonical
 * CapabilityDefinition base (§2A layer-1 completeness, INV-C07, INV-X02),
 * then dispatches on the declared `capabilityKind` and validates exactly
 * that flavor's declaration. An unknown discriminant fails closed; a
 * missing declaration fails closed.
 */
export function validateOnchainCapabilityDefinition(
  candidate: unknown,
): OnchainCapability {
  const base = validateCapabilityDefinition(candidate);
  const record = candidate as Readonly<Record<string, unknown>>;
  const declaration = record.onchain;
  if (declaration === null || typeof declaration !== "object") {
    throw new ValidationError(
      "an onchain capability must declare its 'onchain' flavor declaration (discriminated by capabilityKind)",
    );
  }
  const kind = (declaration as Readonly<Record<string, unknown>>).capabilityKind;
  if (!isOnchainCapabilityKind(kind)) {
    throw new ValidationError(
      `onchain.capabilityKind '${String(kind)}' is not one of [${ONCHAIN_CAPABILITY_KINDS.join(", ")}] — flavor discrimination fails closed`,
    );
  }

  const errors: string[] = [];
  switch (kind) {
    case "wallet":
      validateWalletCapabilityDeclaration(declaration);
      break;
    case "signer":
      validateSignerCapabilityDeclaration(declaration);
      break;
    case "smart_account":
      validateSmartAccountCapabilityDeclaration(declaration);
      break;
    case "onchain_execution": {
      const decl = declaration as Readonly<Record<string, unknown>>;
      validateOperationKindList(decl.supportedOperations, "supportedOperations", errors);
      const families = decl.supportedFamilies;
      if (!Array.isArray(families) || families.length === 0) {
        errors.push("supportedFamilies must be a non-empty array of chain families");
      } else {
        for (const family of families) {
          if (!isChainFamily(family)) {
            errors.push(`supportedFamilies contains an unknown chain family '${String(family)}'`);
          }
        }
      }
      if (typeof decl.supportsSimulation !== "boolean") {
        errors.push("supportsSimulation must be a boolean");
      }
      if (decl.preBroadcastRecheckRequired !== true) {
        errors.push(
          "preBroadcastRecheckRequired must be true: consequential onchain writes require simulation (where supported) plus a pre-broadcast re-check (AGENTS.md rule 26)",
        );
      }
      break;
    }
    case "contract_interaction": {
      const decl = declaration as Readonly<Record<string, unknown>>;
      if (decl.controlledEscapeHatch !== true) {
        errors.push(
          "controlledEscapeHatch must be true: the generic contract interaction is always declared as the controlled escape hatch it is (rule 28)",
        );
      }
      if (decl.certificationRequired !== true) {
        errors.push(
          "certificationRequired must be true: only certified method declarations may execute (rule 28)",
        );
      }
      const methods = decl.certifiedMethodIds;
      if (!Array.isArray(methods) || methods.length === 0) {
        errors.push(
          "certifiedMethodIds must be a non-empty allowlist of certified method ids — an empty allowlist executes nothing",
        );
      } else {
        for (const method of methods) {
          if (!isNonEmptyString(method)) {
            errors.push("certifiedMethodIds entries must be non-empty strings");
          }
        }
      }
      if (decl.unknownWritePolicy !== "BLOCK" && decl.unknownWritePolicy !== "REQUIRE_ESCALATION") {
        errors.push(
          "unknownWritePolicy must be BLOCK or REQUIRE_ESCALATION: unknown generic contract writes never execute silently (rule 28 — there is no allow-silent policy)",
        );
      }
      break;
    }
    case "dex": {
      const decl = declaration as Readonly<Record<string, unknown>>;
      const swapKinds = decl.supportedSwapKinds;
      if (!Array.isArray(swapKinds) || swapKinds.length === 0) {
        errors.push("supportedSwapKinds must be a non-empty array (EXACT_INPUT and/or EXACT_OUTPUT)");
      } else {
        for (const swapKind of swapKinds) {
          if (swapKind !== "EXACT_INPUT" && swapKind !== "EXACT_OUTPUT") {
            errors.push("supportedSwapKinds entries must be EXACT_INPUT or EXACT_OUTPUT");
          }
        }
      }
      validateChainKeyList(decl.supportedChains, "supportedChains", errors);
      if (decl.quoteSemantics !== "INDICATIVE" && decl.quoteSemantics !== "EXECUTABLE") {
        errors.push("quoteSemantics must be INDICATIVE or EXECUTABLE");
      }
      if (
        decl.slippageProtection !== "DECLARED_LIMIT" &&
        decl.slippageProtection !== "PROVIDER_DEFINED"
      ) {
        errors.push("slippageProtection must be DECLARED_LIMIT or PROVIDER_DEFINED");
      }
      break;
    }
    case "bridge": {
      const decl = declaration as Readonly<Record<string, unknown>>;
      validateChainKeyList(decl.sourceChains, "sourceChains", errors);
      validateChainKeyList(decl.destinationChains, "destinationChains", errors);
      if (typeof decl.custodialTransit !== "boolean") {
        errors.push("custodialTransit must be a boolean (a declared custody property, never assumed)");
      }
      if (
        decl.destinationFinality !== "ATTESTED" &&
        decl.destinationFinality !== "OBSERVED" &&
        decl.destinationFinality !== "PROVIDER_DEFINED"
      ) {
        errors.push("destinationFinality must be ATTESTED, OBSERVED or PROVIDER_DEFINED");
      }
      break;
    }
    case "intent": {
      const decl = declaration as Readonly<Record<string, unknown>>;
      validateChainKeyList(decl.supportedDomains, "supportedDomains", errors);
      if (
        decl.settlementModel !== "FULFILLER_SETTLED" &&
        decl.settlementModel !== "ESCROWED" &&
        decl.settlementModel !== "PROVIDER_DEFINED"
      ) {
        errors.push("settlementModel must be FULFILLER_SETTLED, ESCROWED or PROVIDER_DEFINED");
      }
      if (
        decl.solverCompetition !== "OPEN" &&
        decl.solverCompetition !== "SINGLE_SOLVER" &&
        decl.solverCompetition !== "PROVIDER_DEFINED"
      ) {
        errors.push("solverCompetition must be OPEN, SINGLE_SOLVER or PROVIDER_DEFINED");
      }
      break;
    }
  }
  if (errors.length > 0) {
    throw new ValidationError(
      `Invalid onchain capability declaration (${kind}): ${errors.join("; ")}`,
      { errors: [...errors] },
    );
  }
  return Object.freeze({ ...base, onchain: declaration }) as OnchainCapability;
}

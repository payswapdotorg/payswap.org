/**
 * @payswap/onchain-domain — chain definitions, implementations and connected
 * instances (P4-W1-001; UNIVERSAL-MONEY-INTERFACE-ARCHITECTURE "Onchain
 * capability model").
 *
 * A blockchain is a settlement-rail family member, NOT the product identity
 * and never a parallel ledger (AGENTS.md rule 23). The three contract layers
 * reuse the canonical Capability/Connector model verbatim:
 *
 * - ChainDefinition EXTENDS CapabilityDefinition (§2A layer 1) — the
 *   DESCRIPTIVE catalogue of a chain: neutral identity, family, finality
 *   semantics, optional family-scoped extension. A catalogue entry CARRIES NO
 *   AUTHORIZATION SCOPE: no instanceId, no account/tenant, no authorization
 *   state, no credential scope, no permission state. The catalogue never
 *   authorizes (INV-C05 discipline; AGENTS.md rule 18).
 * - ChainImplementation EXTENDS ProviderImplementation (§2A layer 2).
 * - ConnectedChainInstance EXTENDS ConnectedCapabilityInstance (§2A layer 3)
 *   — the only chain-shaped authorization scope: a real provider
 *   account/tenant, authorization, credential scope, geography, permission
 *   state, eligibility, plus the chain identity and the optional
 *   family-scoped instance extension.
 *
 * Deterministic identity: a ChainDefinition's capabilityId is
 * `chain.${chainKey}` (chainKey = `${namespace}:${network}`), enforced by the
 * validator — chain identity is canonical, never free-form.
 */

import { ValidationError } from "@payswap/protocol";
import type { CapabilityDefinition } from "@payswap/connectors";
import { validateCapabilityDefinition } from "@payswap/connectors";
import type { ProviderImplementation, ConnectedCapabilityInstance } from "@payswap/connectors";
import {
  validateProviderImplementation,
  validateConnectedCapabilityInstance,
  assertConnectedInstance,
  ConnectorAuthorityError,
} from "@payswap/connectors";
import {
  finalityReorgConsistency,
  isChainFamily,
  isValidChainKey,
} from "./family.js";
import type { ChainFamily, ChainFinalityModel, ChainReorgRisk } from "./family.js";
import type { ChainDescriptorFamilyExtension, ChainInstanceFamilyExtension } from "./family-extensions.js";
import {
  validateChainDescriptorFamilyExtension,
  validateChainInstanceFamilyExtension,
} from "./family-extensions.js";

// ---------------------------------------------------------------------------
// Neutral chain descriptor
// ---------------------------------------------------------------------------

/** Finality semantics a chain declares — always declared, never assumed. */
export interface ChainFinalitySemantics {
  readonly finalityModel: ChainFinalityModel;
  readonly reorgRisk: ChainReorgRisk;
  /** Documented, provider-neutral confirmation guidance (descriptive). */
  readonly confirmationGuidance: string;
}

/**
 * The neutral, descriptive chain descriptor: canonical identity, family,
 * display name, native asset reference and declared finality semantics. The
 * optional familyExtension is the ONLY place family-specific shapes may
 * appear, and it is never required.
 */
export interface ChainDescriptor {
  /** Canonical neutral identity, e.g. `ethereum:mainnet`. */
  readonly chainKey: string;
  readonly family: ChainFamily;
  /** Required when family is `OTHER` (a declared label for the family). */
  readonly familyLabel?: string;
  readonly displayName: string;
  /** Canonical asset reference of the chain's native asset. */
  readonly nativeAssetRef?: string;
  readonly finality: ChainFinalitySemantics;
  /** Optional family-scoped extension — never required by core contracts. */
  readonly familyExtension?: ChainDescriptorFamilyExtension;
}

// ---------------------------------------------------------------------------
// Layer 1 — ChainDefinition (descriptive catalogue; never authority)
// ---------------------------------------------------------------------------

/**
 * A chain as a descriptive catalogue capability (§2A layer 1). `kind` is
 * fixed to `READ`: chains surface as observation capabilities; consequential
 * writes are separate onchain execution capabilities, never chain
 * definitions. Deterministic identity: capabilityId === `chain.${chainKey}`.
 */
export interface ChainDefinition extends CapabilityDefinition {
  readonly kind: "READ";
  readonly chain: ChainDescriptor;
}

/** Deterministic chain capability id: `chain.${chainKey}`. */
export function chainCapabilityId(chainKey: string): string {
  return `chain.${chainKey}`;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Validates the neutral chain descriptor. Deterministic rules:
 * - chainKey matches the canonical `${namespace}:${network}` format;
 * - family is a declared family (a label is REQUIRED for `OTHER`);
 * - finality semantics are declared (never assumed) and satisfy the
 *   finality/reorg consistency coupling (probabilistic or hybrid finality
 *   implies reorg risk PRESENT);
 * - an optional family extension must match the descriptor family and be
 *   well-formed.
 */
export function validateChainDescriptor(candidate: unknown): ChainDescriptor {
  if (candidate === null || typeof candidate !== "object") {
    throw new ValidationError("chain descriptor must be an object");
  }
  const record = candidate as Readonly<Record<string, unknown>>;
  if (!isValidChainKey(record.chainKey)) {
    throw new ValidationError(
      `chainKey must match ${String(/^[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9-]*$/)} (e.g. 'ethereum:mainnet')`,
    );
  }
  if (!isChainFamily(record.family)) {
    throw new ValidationError(
      "family must be a declared chain family (see CHAIN_FAMILIES)",
    );
  }
  if (record.family === "OTHER" && !isNonEmptyString(record.familyLabel)) {
    throw new ValidationError(
      "familyLabel is required when family is 'OTHER' — an undeclared family is never assumed",
    );
  }
  if (record.familyLabel !== undefined && !isNonEmptyString(record.familyLabel)) {
    throw new ValidationError("familyLabel, when present, must be a non-empty string");
  }
  if (!isNonEmptyString(record.displayName)) {
    throw new ValidationError("displayName must be a non-empty string");
  }
  if (record.nativeAssetRef !== undefined && !isNonEmptyString(record.nativeAssetRef)) {
    throw new ValidationError("nativeAssetRef, when present, must be a non-empty string");
  }

  const finality = record.finality;
  if (finality === null || typeof finality !== "object") {
    throw new ValidationError(
      "finality semantics must be declared (finalityModel, reorgRisk, confirmationGuidance) — never assumed",
    );
  }
  const finalityRecord = finality as Readonly<Record<string, unknown>>;
  const finalityModel = finalityRecord.finalityModel;
  const reorgRisk = finalityRecord.reorgRisk;
  const validFinalityModels: readonly ChainFinalityModel[] = [
    "PROBABILISTIC",
    "DETERMINISTIC",
    "INSTANT",
    "HYBRID",
  ];
  const validReorgRisks: readonly ChainReorgRisk[] = ["NONE", "PRESENT"];
  if (!validFinalityModels.includes(finalityModel as ChainFinalityModel)) {
    throw new ValidationError(
      "finality.finalityModel must be PROBABILISTIC, DETERMINISTIC, INSTANT or HYBRID",
    );
  }
  if (!validReorgRisks.includes(reorgRisk as ChainReorgRisk)) {
    throw new ValidationError("finality.reorgRisk must be NONE or PRESENT");
  }
  if (!isNonEmptyString(finalityRecord.confirmationGuidance)) {
    throw new ValidationError(
      "finality.confirmationGuidance must be a non-empty string (declared guidance, never assumed)",
    );
  }
  if (!finalityReorgConsistency(finalityModel as ChainFinalityModel, reorgRisk as ChainReorgRisk)) {
    throw new ValidationError(
      "finality semantics are inconsistent: probabilistic or hybrid finality implies reorgRisk PRESENT; deterministic or instant implies NONE (reorg risk is never assumed away)",
    );
  }

  const familyExtension = record.familyExtension;
  let validatedFamilyExtension: ChainDescriptorFamilyExtension | undefined;
  if (familyExtension !== undefined) {
    validatedFamilyExtension = validateChainDescriptorFamilyExtension(
      familyExtension,
      record.family,
    );
  }

  const descriptor: ChainDescriptor = {
    chainKey: record.chainKey,
    family: record.family,
    displayName: record.displayName,
    finality: Object.freeze({
      finalityModel: finalityModel as ChainFinalityModel,
      reorgRisk: reorgRisk as ChainReorgRisk,
      confirmationGuidance: finalityRecord.confirmationGuidance as string,
    }),
    ...(isNonEmptyString(record.familyLabel) ? { familyLabel: record.familyLabel } : {}),
    ...(isNonEmptyString(record.nativeAssetRef) ? { nativeAssetRef: record.nativeAssetRef } : {}),
    ...(validatedFamilyExtension !== undefined ? { familyExtension: validatedFamilyExtension } : {}),
  };
  return Object.freeze(descriptor);
}

/**
 * Runtime validation for a chain definition: the base CapabilityDefinition
 * surface (§2A layer-1 completeness, INV-C07 authorization declaration,
 * INV-X02 retry coupling) is validated by the canonical connectors
 * validator, then the chain descriptor rules and the deterministic identity
 * rule (`capabilityId === chain.${chainKey}`) are enforced.
 */
export function validateChainDefinition(candidate: unknown): ChainDefinition {
  const base = validateCapabilityDefinition(candidate);
  const record = candidate as Readonly<Record<string, unknown>>;
  if (record.kind !== "READ") {
    throw new ValidationError(
      "a ChainDefinition is a descriptive catalogue capability and must declare kind 'READ' (consequential writes are onchain execution capabilities, never chain definitions)",
    );
  }
  const descriptor = validateChainDescriptor(record.chain);
  if (base.capabilityId !== chainCapabilityId(descriptor.chainKey)) {
    throw new ValidationError(
      `chain definition identity is deterministic: capabilityId must be '${chainCapabilityId(descriptor.chainKey)}' for chainKey '${descriptor.chainKey}'`,
    );
  }
  const definition: ChainDefinition = Object.freeze({
    ...base,
    kind: "READ",
    chain: descriptor,
  });
  return definition;
}

// ---------------------------------------------------------------------------
// Layer 2 — ChainImplementation
// ---------------------------------------------------------------------------

/** A provider's concrete implementation of chain access (§2A layer 2). */
export interface ChainImplementation extends ProviderImplementation {
  /** The chain this implementation accesses (canonical chainKey). */
  readonly chainKey: string;
}

/** Runtime validation for a chain implementation. */
export function validateChainImplementation(candidate: unknown): ChainImplementation {
  const base = validateProviderImplementation(candidate);
  const record = candidate as Readonly<Record<string, unknown>>;
  if (!isValidChainKey(record.chainKey)) {
    throw new ValidationError(
      "chainKey must be a canonical `${namespace}:${network}` chain key",
    );
  }
  return Object.freeze({ ...base, chainKey: record.chainKey }) as ChainImplementation;
}

// ---------------------------------------------------------------------------
// Layer 3 — ConnectedChainInstance (the ONLY chain-shaped authorization scope)
// ---------------------------------------------------------------------------

/**
 * A genuinely connected chain instance (§2A layer 3): the full
 * ConnectedCapabilityInstance scope (real account/tenant, authorization,
 * credential scope, geography, currencies, permission state, eligibility,
 * configuration — INV-C05) plus the chain identity and the optional
 * family-scoped instance extension. Execution against a chain requires THIS
 * shape; a ChainDefinition or provider catalogue entry never substitutes.
 */
export interface ConnectedChainInstance extends ConnectedCapabilityInstance {
  readonly chainKey: string;
  readonly family: ChainFamily;
  /** Optional family-scoped instance extension — never required. */
  readonly familyExtension?: ChainInstanceFamilyExtension;
}

/** Runtime validation for a connected chain instance. */
export function validateConnectedChainInstance(
  candidate: unknown,
): ConnectedChainInstance {
  const base = validateConnectedCapabilityInstance(candidate);
  const record = candidate as Readonly<Record<string, unknown>>;
  if (!isValidChainKey(record.chainKey)) {
    throw new ValidationError(
      "chainKey must be a canonical `${namespace}:${network}` chain key",
    );
  }
  if (!isChainFamily(record.family)) {
    throw new ValidationError(
      "family must be a declared chain family (see CHAIN_FAMILIES)",
    );
  }
  if (base.capabilityId !== chainCapabilityId(record.chainKey as string)) {
    throw new ValidationError(
      `connected chain instance must reference the deterministic chain capability id '${chainCapabilityId(record.chainKey as string)}' for chainKey '${String(record.chainKey)}'`,
    );
  }
  const familyExtension = record.familyExtension;
  if (familyExtension !== undefined) {
    // The extension validator enforces the family discriminant; the instance
    // family must match it.
    const extension = validateChainInstanceFamilyExtension(familyExtension);
    return Object.freeze({
      ...base,
      chainKey: record.chainKey as string,
      family: record.family,
      familyExtension: extension,
    });
  }
  return Object.freeze({
    ...base,
    chainKey: record.chainKey as string,
    family: record.family as ChainFamily,
  });
}

// ---------------------------------------------------------------------------
// Catalogue-never-authorizes guards (INV-C05 discipline)
// ---------------------------------------------------------------------------

/**
 * INV-C05 violation specific to the onchain domain: a chain catalogue shape
 * (ChainDefinition / chain descriptor) was presented where a genuinely
 * connected instance is required. Extends the canonical connector authority
 * error so existing INV-C05 catch sites keep working — this is the SAME
 * catalogue/instance distinction, not a second one.
 */
export class OnchainCatalogueAuthorityError extends ConnectorAuthorityError {
  constructor(message: string) {
    super(message);
    this.name = "OnchainCatalogueAuthorityError";
  }
}

/**
 * Structural discrimination: is this value a chain catalogue shape (a chain
 * definition, or a bare chain descriptor) rather than a connected instance?
 * Deterministic rules: either it carries a chain descriptor, or it IS one
 * (canonical chainKey + family + declared finality semantics); and it
 * carries NO instanceId.
 */
export function isChainCatalogueShape(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as
    & Partial<ChainDefinition>
    & Partial<ConnectedChainInstance>
    & { chain?: unknown; chainKey?: unknown; family?: unknown; finality?: unknown };
  const carriesChainDescriptor =
    typeof candidate.chain === "object" && candidate.chain !== null;
  const isBareChainDescriptor =
    typeof candidate.chainKey === "string" &&
    isValidChainKey(candidate.chainKey) &&
    typeof candidate.family === "string" &&
    isChainFamily(candidate.family) &&
    typeof candidate.finality === "object" &&
    candidate.finality !== null;
  const lacksInstanceId =
    candidate.instanceId === undefined || candidate.instanceId === "";
  return (carriesChainDescriptor || isBareChainDescriptor) && lacksInstanceId;
}

/**
 * Runtime assertion for onchain execution paths: the value MUST be a
 * ConnectedChainInstance. Chain catalogue shapes (ChainDefinition, bare
 * descriptors) are rejected with the explicit catalogue-never-authorizes
 * error; provider catalogue entries fall through to the canonical
 * connector assertion (INV-C05).
 */
export function assertConnectedChainInstance(
  value: unknown,
): asserts value is ConnectedChainInstance {
  if (isChainCatalogueShape(value)) {
    throw new OnchainCatalogueAuthorityError(
      "INV-C05: a ChainDefinition is a descriptive catalogue entry and can never authorize onchain execution — execution requires a ConnectedChainInstance scoped to a real account/tenant, authorization, credential scope, geography/currency and permission state",
    );
  }
  assertConnectedInstance(value);
  validateConnectedChainInstance(value);
}

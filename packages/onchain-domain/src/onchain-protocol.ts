/**
 * @payswap/onchain-domain — smart-contract protocol definitions,
 * implementations and connected instances (P4-W1-001).
 *
 * A protocol is a deployed smart-contract system on a chain (a DEX, a
 * bridge, a lending market, an intent network…). Protocol contracts reuse
 * the existing vocabulary:
 *
 * - the INV-SC01 smart-contract declaration (source/bytecode provenance,
 *   upgrade/admin/pause/oracle/custody properties) is the CANONICAL
 *   @payswap/capabilities SmartContractExtension — reused verbatim, never
 *   duplicated;
 * - the §2A layer structure is the canonical connectors model:
 *   ProtocolDefinition extends CapabilityDefinition (descriptive catalogue —
 *   never authority), ProtocolImplementation extends ProviderImplementation,
 *   ConnectedProtocolInstance extends ConnectedCapabilityInstance (the only
 *   protocol-shaped authorization scope).
 *
 * Deterministic identity: a protocol reference is
 * `${chainKey}/protocol:${protocolKey}` and a protocol definition's
 * capabilityId is `protocol.${chainKey}:${protocolKey}` — enforced by the
 * validator.
 */

import { ValidationError } from "@payswap/protocol";
import type { SmartContractExtension } from "@payswap/capabilities";
import { validateSmartContractExtension } from "@payswap/capabilities";
import type { CapabilityDefinition, ProviderImplementation, ConnectedCapabilityInstance } from "@payswap/connectors";
import {
  validateCapabilityDefinition,
  validateProviderImplementation,
  validateConnectedCapabilityInstance,
} from "@payswap/connectors";
import { isValidChainKey } from "./family.js";

// ---------------------------------------------------------------------------
// Protocol classes
// ---------------------------------------------------------------------------

export const PROTOCOL_CLASSES = [
  "DEX",
  "BRIDGE",
  "INTENT_NETWORK",
  "LENDING",
  "STAKING",
  "STABLECOIN_ISSUER",
  "ESCROW",
  "OTHER",
] as const;

export type ProtocolClass = (typeof PROTOCOL_CLASSES)[number];

export function isProtocolClass(value: unknown): value is ProtocolClass {
  return (
    typeof value === "string" &&
    (PROTOCOL_CLASSES as readonly unknown[]).includes(value)
  );
}

// ---------------------------------------------------------------------------
// The protocol descriptor (composes the canonical INV-SC01 declaration)
// ---------------------------------------------------------------------------

/**
 * A smart-contract protocol descriptor: canonical identity, class, chain
 * scope and the CANONICAL smart-contract declarations (INV-SC01) of every
 * contract the protocol comprises. Every contract must declare its full
 * source/bytecode provenance, upgrade/admin/pause/oracle/custody
 * properties — an undeclared property is rejected by the reused
 * capabilities validator, never assumed (INV-NC03).
 */
export interface ProtocolDescriptor {
  /** Canonical protocol identity, e.g. `uniswap:v3`. */
  readonly protocolKey: string;
  readonly displayName: string;
  readonly protocolClass: ProtocolClass;
  readonly chainKey: string;
  /** At least one canonical smart-contract declaration (INV-SC01). */
  readonly smartContracts: readonly SmartContractExtension[];
}

/** Deterministic protocol reference: `${chainKey}/protocol:${protocolKey}`. */
export function canonicalProtocolRef(protocolKey: string, chainKey: string): string {
  return `${chainKey}/protocol:${protocolKey}`;
}

/** Deterministic protocol capability id: `protocol.${chainKey}:${protocolKey}`. */
export function protocolCapabilityId(protocolKey: string, chainKey: string): string {
  return `protocol.${chainKey}:${protocolKey}`;
}

const PROTOCOL_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Validates a protocol descriptor. Rules:
 * - protocolKey is canonical; chainKey is canonical;
 * - at least one smart contract is declared;
 * - EVERY contract passes the canonical INV-SC01 validator (reused — never
 *   duplicated here);
 * - every declared contract's chainRef equals the descriptor's chainKey
 *   (a protocol's contracts live on its chain).
 */
export function validateProtocolDescriptor(candidate: unknown): ProtocolDescriptor {
  if (candidate === null || typeof candidate !== "object") {
    throw new ValidationError("protocol descriptor must be an object");
  }
  const record = candidate as Readonly<Record<string, unknown>>;
  if (!isNonEmptyString(record.protocolKey) || !PROTOCOL_KEY_PATTERN.test(record.protocolKey)) {
    throw new ValidationError(
      "protocolKey must match /^[a-z0-9][a-z0-9._-]{0,63}$/ (e.g. 'uniswap:v3')",
    );
  }
  if (!isNonEmptyString(record.displayName)) {
    throw new ValidationError("displayName must be a non-empty string");
  }
  if (!isProtocolClass(record.protocolClass)) {
    throw new ValidationError(`protocolClass must be one of [${PROTOCOL_CLASSES.join(", ")}]`);
  }
  if (!isValidChainKey(record.chainKey)) {
    throw new ValidationError("chainKey must be a canonical `${namespace}:${network}` chain key");
  }
  const contracts = record.smartContracts;
  if (!Array.isArray(contracts) || contracts.length === 0) {
    throw new ValidationError(
      "a protocol must declare at least one smart contract (INV-SC01 declarations are never empty)",
    );
  }
  const validated: SmartContractExtension[] = [];
  for (const [index, contract] of contracts.entries()) {
    const declaration = validateSmartContractExtension(contract);
    if (declaration.chainRef !== record.chainKey) {
      throw new ValidationError(
        `smartContracts[${index}] declares chainRef '${declaration.chainRef}' which does not match the protocol chain '${String(record.chainKey)}' — a protocol's contracts live on its chain`,
      );
    }
    validated.push(declaration);
  }
  return Object.freeze({
    protocolKey: record.protocolKey,
    displayName: record.displayName,
    protocolClass: record.protocolClass,
    chainKey: record.chainKey,
    smartContracts: Object.freeze(validated),
  });
}

// ---------------------------------------------------------------------------
// Layer 1 — ProtocolDefinition (descriptive catalogue; never authority)
// ---------------------------------------------------------------------------

/**
 * A protocol as a descriptive catalogue capability (§2A layer 1). A
 * protocol is an ACTION-surfaced catalogue entry (its capabilities execute
 * consequential writes); the definition itself carries NO authorization
 * scope — execution requires a ConnectedProtocolInstance. Deterministic
 * identity: capabilityId === `protocol.${chainKey}:${protocolKey}`.
 */
export interface ProtocolDefinition extends CapabilityDefinition {
  readonly kind: "ACTION";
  readonly protocol: ProtocolDescriptor;
}

/** Runtime validation for a protocol definition. */
export function validateProtocolDefinition(candidate: unknown): ProtocolDefinition {
  const base = validateCapabilityDefinition(candidate);
  const record = candidate as Readonly<Record<string, unknown>>;
  if (record.kind !== "ACTION") {
    throw new ValidationError(
      "a ProtocolDefinition is an action-surfaced catalogue capability and must declare kind 'ACTION'",
    );
  }
  const descriptor = validateProtocolDescriptor(record.protocol);
  const expectedId = protocolCapabilityId(descriptor.protocolKey, descriptor.chainKey);
  if (base.capabilityId !== expectedId) {
    throw new ValidationError(
      `protocol definition identity is deterministic: capabilityId must be '${expectedId}' for protocol '${descriptor.protocolKey}' on chain '${descriptor.chainKey}'`,
    );
  }
  return Object.freeze({ ...base, kind: "ACTION", protocol: descriptor });
}

// ---------------------------------------------------------------------------
// Layer 2 — ProtocolImplementation
// ---------------------------------------------------------------------------

/** A provider's concrete implementation of a protocol capability (§2A layer 2). */
export interface ProtocolImplementation extends ProviderImplementation {
  readonly protocolKey: string;
  readonly chainKey: string;
}

/** Runtime validation for a protocol implementation. */
export function validateProtocolImplementation(candidate: unknown): ProtocolImplementation {
  const base = validateProviderImplementation(candidate);
  const record = candidate as Readonly<Record<string, unknown>>;
  if (!isNonEmptyString(record.protocolKey) || !PROTOCOL_KEY_PATTERN.test(record.protocolKey)) {
    throw new ValidationError("protocolKey must be canonical");
  }
  if (!isValidChainKey(record.chainKey)) {
    throw new ValidationError("chainKey must be a canonical chain key");
  }
  return Object.freeze({
    ...base,
    protocolKey: record.protocolKey,
    chainKey: record.chainKey,
  }) as ProtocolImplementation;
}

// ---------------------------------------------------------------------------
// Layer 3 — ConnectedProtocolInstance (the ONLY protocol-shaped authorization scope)
// ---------------------------------------------------------------------------

/**
 * A genuinely connected protocol instance (§2A layer 3): the full
 * ConnectedCapabilityInstance scope (INV-C05) plus the protocol identity.
 * Execution against a protocol requires THIS shape; a ProtocolDefinition
 * never substitutes (the catalogue never authorizes).
 */
export interface ConnectedProtocolInstance extends ConnectedCapabilityInstance {
  readonly protocolKey: string;
  readonly chainKey: string;
}

/** Runtime validation for a connected protocol instance. */
export function validateConnectedProtocolInstance(
  candidate: unknown,
): ConnectedProtocolInstance {
  const base = validateConnectedCapabilityInstance(candidate);
  const record = candidate as Readonly<Record<string, unknown>>;
  if (!isNonEmptyString(record.protocolKey) || !PROTOCOL_KEY_PATTERN.test(record.protocolKey)) {
    throw new ValidationError("protocolKey must be canonical");
  }
  if (!isValidChainKey(record.chainKey)) {
    throw new ValidationError("chainKey must be a canonical chain key");
  }
  const expectedId = protocolCapabilityId(record.protocolKey as string, record.chainKey as string);
  if (base.capabilityId !== expectedId) {
    throw new ValidationError(
      `connected protocol instance must reference the deterministic protocol capability id '${expectedId}'`,
    );
  }
  return Object.freeze({
    ...base,
    protocolKey: record.protocolKey as string,
    chainKey: record.chainKey as string,
  });
}

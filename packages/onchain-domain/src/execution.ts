/**
 * @payswap/onchain-domain — onchain execution request and observation
 * contracts (P4-W1-001).
 *
 * OnchainExecutionRequest EXTENDS the canonical ConnectorExecutionRequest
 * (INV-C07): an explicit execution mode and the protocol authorization
 * reference are mandatory on every request — no mode (including
 * PASS_THROUGH_NATIVE) bypasses protocol authorization. The
 * provider-neutral onchain directive is carried as the request payload and
 * is validated against the deterministic operation semantics table.
 *
 * OnchainExecutionObservation is an OBSERVATION of an external onchain
 * execution attempt — never financial truth and never finality:
 * - rule 29 / AGENTS.md rule 29: submitted transactions are NOT financial
 *   finality — a BROADCAST outcome may not carry a finality candidate;
 * - finality candidates are all an observer can produce: the
 *   OnchainFinalityCandidate carries `candidateOnly: true` and
 *   `requiresProtocolFinality: true` as LITERAL types — declaring actual
 *   finality is structurally impossible here (INV-F06: finality is
 *   protocol-owned);
 * - INV-X01: UNKNOWN is not FAILED — `OUTCOME_UNKNOWN` is a distinct
 *   outcome requiring an explicit reason, and it can never coexist with a
 *   failure descriptor (ambiguity is not failure);
 * - INV-E02: every observation carries evidence references.
 *
 * The execution scope assertion enforces the catalogue-never-authorizes
 * discipline: chain catalogue shapes and provider catalogue entries are
 * rejected; only genuinely connected instances pass.
 */

import { ValidationError } from "@payswap/protocol";
import type { ConnectorExecutionRequest, ObservationProvenance } from "@payswap/connectors";
import { validateExecutionRequest } from "@payswap/connectors";
import {
  isChainFamily,
  isValidChainKey,
  type ChainFamily,
  type ChainFinalityModel,
} from "./family.js";
import { isOnchainOperationKind, onchainOperationSemantics, ONCHAIN_OPERATION_KINDS } from "./operations.js";
import type { OnchainOperationKind } from "./operations.js";
import { validateSignerHandle } from "./wallet.js";
import type { SignerHandle } from "./wallet.js";
import { validateAssetAmount } from "./asset.js";
import type { AssetAmount } from "./asset.js";
import { assertConnectedChainInstance, isChainCatalogueShape } from "./chain.js";
import type { ConnectedChainInstance } from "./chain.js";

// ---------------------------------------------------------------------------
// The execution directive (provider-neutral; family-specific shapes never appear here)
// ---------------------------------------------------------------------------

/**
 * The provider-neutral onchain execution directive. Field rules:
 * - `destination`/`spenderRef` are OPAQUE external references (neutral);
 * - `familyPayload` is an opaque, family-scoped payload owned by the
 *   family adapters (later waves) — the core never interprets it;
 * - `signerHandle` references the signing instrument OPAQUELY — key
 *   material never enters this contract;
 * - `expiresAt` is mandatory: the authorization kernel (P4-W1-002)
 *   evaluates expiry before authorization.
 * Required-field coupling is enforced against the deterministic operation
 * semantics table (see ./operations.js).
 */
export interface OnchainExecutionDirective {
  readonly operation: OnchainOperationKind;
  readonly chainKey: string;
  readonly family: ChainFamily;
  /** Opaque external destination account/contract reference (neutral). */
  readonly destination?: string;
  /** Canonical asset reference being moved/approved/swapped. */
  readonly assetId?: string;
  /** Exact amount in integer minor units (INV-F01). */
  readonly amount?: AssetAmount;
  /** Opaque approved-spender reference (approval operations). */
  readonly spenderRef?: string;
  /** Canonical protocol reference (protocol-scoped operations). */
  readonly protocolRef?: string;
  /** Optional route reference (best-execution route identity). */
  readonly routeRef?: string;
  readonly expiresAt: string;
  readonly signerHandle: SignerHandle;
  /** Opaque family-scoped payload (adapter-owned; the core never interprets it). */
  readonly familyPayload?: unknown;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Validates an onchain execution directive against the deterministic
 * operation semantics table: operation known, chain/family declared and
 * consistent, expiry declared, signer handle validated (opaque, never key
 * material), amounts exact, and every operation-specific required field
 * present (destination/spender/asset/amount/protocol per the table).
 */
export function validateOnchainExecutionDirective(
  candidate: unknown,
): OnchainExecutionDirective {
  if (candidate === null || typeof candidate !== "object") {
    throw new ValidationError("onchain execution directive must be an object");
  }
  const record = candidate as Readonly<Record<string, unknown>>;
  const errors: string[] = [];

  if (!isOnchainOperationKind(record.operation)) {
    errors.push(
      `operation must be one of [${ONCHAIN_OPERATION_KINDS.join(", ")}] — undeclared operations never validate`,
    );
  }
  if (!isValidChainKey(record.chainKey)) {
    errors.push("chainKey must be a canonical `${namespace}:${network}` chain key");
  }
  if (!isChainFamily(record.family)) {
    errors.push(
      "family must be a declared chain family (see CHAIN_FAMILIES) — declared family semantics are required for family dispatch",
    );
  }
  if (!isNonEmptyString(record.expiresAt)) {
    errors.push(
      "expiresAt is mandatory: the authorization kernel evaluates expiry before authorization",
    );
  }

  try {
    validateSignerHandle(record.signerHandle);
  } catch (error) {
    errors.push(
      `signerHandle is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (isOnchainOperationKind(record.operation)) {
    const semantics = onchainOperationSemantics(record.operation);
    if (semantics.requires.destination && !isNonEmptyString(record.destination)) {
      errors.push(`operation '${record.operation}' requires a destination reference`);
    }
    if (semantics.requires.spender && !isNonEmptyString(record.spenderRef)) {
      errors.push(`operation '${record.operation}' requires a spenderRef (the approved spender)`);
    }
    if (semantics.requires.asset && !isNonEmptyString(record.assetId)) {
      errors.push(`operation '${record.operation}' requires an assetId`);
    }
    if (semantics.requires.amount && (record.amount === null || record.amount === undefined || typeof record.amount !== "object")) {
      errors.push(`operation '${record.operation}' requires an exact amount`);
    }
    if (semantics.requires.protocol && !isNonEmptyString(record.protocolRef)) {
      errors.push(
        `operation '${record.operation}' requires a protocolRef (canonical protocol reference)`,
      );
    }
  }
  for (const field of ["destination", "spenderRef", "assetId", "protocolRef", "routeRef"] as const) {
    if (record[field] !== undefined && !isNonEmptyString(record[field])) {
      errors.push(`${field}, when present, must be a non-empty string`);
    }
  }
  // An amount, whenever present (required or optional), must be exact.
  if (record.amount !== undefined) {
    if (record.amount === null || typeof record.amount !== "object") {
      errors.push("amount, when present, must be an exact AssetAmount object");
    } else {
      try {
        validateAssetAmount(record.amount as AssetAmount);
        const amountAssetId = (record.amount as Readonly<Record<string, unknown>>).assetId;
        if (!isNonEmptyString(amountAssetId)) {
          errors.push("amount.assetId must be a non-empty string");
        } else if (isNonEmptyString(record.assetId) && amountAssetId !== record.assetId) {
          errors.push(
            "amount.assetId must match the directive's assetId (the amount is denominated in the directive's asset)",
          );
        }
      } catch (error) {
        errors.push(
          `amount is invalid: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  if (errors.length > 0) {
    throw new ValidationError(
      `Invalid onchain execution directive: ${errors.join("; ")}`,
      { errors: [...errors] },
    );
  }
  return candidate as OnchainExecutionDirective;
}

// ---------------------------------------------------------------------------
// The execution request (extends the canonical connector execution request)
// ---------------------------------------------------------------------------

/**
 * An onchain execution request: the canonical ConnectorExecutionRequest
 * (explicit execution mode, capability instance reference, idempotency key,
 * PROTOCOL AUTHORIZATION reference — INV-C07/INV-F06) carrying the
 * provider-neutral onchain directive as its request payload.
 */
export interface OnchainExecutionRequest extends ConnectorExecutionRequest {
  readonly providerRequest: OnchainExecutionDirective;
}

/**
 * Validates an onchain execution request: the canonical connectors
 * validation runs first (explicit mode + protocol authorization link +
 * idempotency key), then the onchain directive validation. A request
 * without the protocol authorization link never validates — catalogue
 * data alone can never construct an executable request.
 */
export function validateOnchainExecutionRequest(
  candidate: unknown,
): OnchainExecutionRequest {
  const base = validateExecutionRequest(candidate);
  if (!base.ok) {
    throw new ValidationError(
      `Onchain execution request violates the canonical execution contract: ${base.violations.join("; ")}`,
      { violations: [...base.violations] },
    );
  }
  const record = candidate as Readonly<Record<string, unknown>>;
  validateOnchainExecutionDirective(record.providerRequest);
  return candidate as OnchainExecutionRequest;
}

/**
 * Execution-scope assertion (catalogue never authorizes, INV-C05): the
 * value presented as the executing capability must be a genuinely
 * connected chain instance. Chain catalogue shapes (ChainDefinition, bare
 * chain descriptors) are rejected with the explicit
 * catalogue-never-authorizes error; provider catalogue entries and other
 * non-instance shapes fall through to the canonical connector assertion.
 */
export function assertOnchainExecutionScope(
  value: unknown,
): asserts value is ConnectedChainInstance {
  assertConnectedChainInstance(value);
}

/** Deterministic probe: does this value carry a chain catalogue shape? */
export function isOnchainCatalogueShape(value: unknown): boolean {
  return isChainCatalogueShape(value);
}

// ---------------------------------------------------------------------------
// Observation outcomes (UNKNOWN-capable — INV-X01)
// ---------------------------------------------------------------------------

export const ONCHAIN_EXECUTION_OUTCOMES = [
  "BROADCAST",
  "CONFIRMED",
  "FAILED",
  "OUTCOME_UNKNOWN",
] as const;

export type OnchainExecutionOutcome = (typeof ONCHAIN_EXECUTION_OUTCOMES)[number];

export function isOnchainExecutionOutcome(
  value: unknown,
): value is OnchainExecutionOutcome {
  return (
    typeof value === "string" &&
    (ONCHAIN_EXECUTION_OUTCOMES as readonly unknown[]).includes(value)
  );
}

export const ONCHAIN_FAILURE_CLASSES = [
  "REJECTED",
  "REVERTED",
  "INSUFFICIENT_FUNDS",
  "EXPIRED",
  "POLICY_BLOCKED",
  "SECURITY_BLOCKED",
  "PROVIDER_DEFINED",
] as const;

export type OnchainFailureClass = (typeof ONCHAIN_FAILURE_CLASSES)[number];

/**
 * A definitive failure of an onchain execution. Transport-level ambiguity
 * is NOT a failure: when it is unknown whether an operation reached the
 * chain, the outcome is OUTCOME_UNKNOWN (INV-X01) — there is deliberately
 * no transport member here.
 */
export interface OnchainFailureDescriptor {
  readonly failureClass: OnchainFailureClass;
  readonly description: string;
  /** Deterministic retry guidance (INV-X02 governs unknowns, not failures). */
  readonly retryGuidance: "SAFE_TO_RETRY" | "REQUIRES_RECONCILIATION" | "NOT_RETRYABLE";
}

/**
 * A finality CANDIDATE — all an external observer can ever produce.
 * `candidateOnly: true` and `requiresProtocolFinality: true` are LITERAL
 * types: declaring financial finality from an observation is structurally
 * impossible; finality is protocol-owned (INV-F06, AGENTS.md rule 29).
 */
export interface OnchainFinalityCandidate {
  readonly candidateOnly: true;
  readonly requiresProtocolFinality: true;
  /** Neutral confirmation depth (blocks/slots/attestations observed). */
  readonly confirmationDepth?: number;
  readonly finalityModel: ChainFinalityModel;
  /** Whether a reorg/reorganization was observed for this operation. */
  readonly reorgDetected: boolean;
}

/**
 * An observation of an external onchain execution attempt. Coupling rules
 * (validated, deterministic):
 * - FAILED ⇒ a failure descriptor is REQUIRED;
 * - OUTCOME_UNKNOWN ⇒ an explicit reason is REQUIRED and a failure
 *   descriptor is FORBIDDEN (ambiguity is not failure — INV-X01);
 * - BROADCAST ⇒ a finality candidate is FORBIDDEN (submitted is not
 *   finality — rule 29);
 * - evidence references are MANDATORY on every observation (INV-E02);
 * - a finality candidate, when present, is a CANDIDATE (never finality).
 */
export interface OnchainExecutionObservation {
  readonly observationId: string;
  /** The execution attempt reference (the request idempotency key scope). */
  readonly executionRef: string;
  readonly observedAt: string;
  readonly chainKey: string;
  readonly outcome: OnchainExecutionOutcome;
  /** Opaque external transaction/operation reference. */
  readonly externalOperationRef?: string;
  /** Present when outcome CONFIRMED: a finality CANDIDATE, never finality. */
  readonly finalityCandidate?: OnchainFinalityCandidate;
  /** REQUIRED when outcome FAILED. */
  readonly failure?: OnchainFailureDescriptor;
  /** REQUIRED when outcome OUTCOME_UNKNOWN; forbidden otherwise. */
  readonly unknownReason?: string;
  /** Evidence node references (INV-E02 — mandatory, never empty). */
  readonly evidenceRefs: readonly string[];
  readonly provenance: ObservationProvenance;
}

/**
 * Runtime validation for an onchain execution observation. Enforces the
 * outcome couplings above, fail-closed.
 */
export function validateOnchainExecutionObservation(
  candidate: unknown,
): OnchainExecutionObservation {
  if (candidate === null || typeof candidate !== "object") {
    throw new ValidationError("onchain execution observation must be an object");
  }
  const record = candidate as Readonly<Record<string, unknown>>;
  const errors: string[] = [];
  for (const field of ["observationId", "executionRef", "observedAt"] as const) {
    if (!isNonEmptyString(record[field])) {
      errors.push(`${field} must be a non-empty string`);
    }
  }
  if (!isValidChainKey(record.chainKey)) {
    errors.push("chainKey must be a canonical chain key");
  }
  if (!isOnchainExecutionOutcome(record.outcome)) {
    errors.push(
      `outcome must be one of [${ONCHAIN_EXECUTION_OUTCOMES.join(", ")}] (UNKNOWN is a first-class outcome — INV-X01)`,
    );
  }
  if (record.externalOperationRef !== undefined && !isNonEmptyString(record.externalOperationRef)) {
    errors.push("externalOperationRef, when present, must be a non-empty string");
  }
  const evidence = record.evidenceRefs;
  if (!Array.isArray(evidence) || evidence.length === 0) {
    errors.push(
      "evidenceRefs is MANDATORY and non-empty: recording an external outcome requires linked evidence (INV-E02)",
    );
  } else {
    for (const ref of evidence) {
      if (!isNonEmptyString(ref)) {
        errors.push("evidenceRefs entries must be non-empty strings");
      }
    }
  }
  const provenance = record.provenance;
  if (
    provenance === null ||
    typeof provenance !== "object" ||
    !isNonEmptyString((provenance as Readonly<Record<string, unknown>>).providerName) ||
    !isNonEmptyString((provenance as Readonly<Record<string, unknown>>).capturedAt)
  ) {
    errors.push("provenance is MANDATORY on every execution observation");
  }

  if (isOnchainExecutionOutcome(record.outcome)) {
    switch (record.outcome) {
      case "BROADCAST": {
        if (record.finalityCandidate !== undefined) {
          errors.push(
            "a BROADCAST outcome may not carry a finality candidate: submitted transactions are not financial finality (AGENTS.md rule 29)",
          );
        }
        if (record.failure !== undefined) {
          errors.push("a BROADCAST outcome may not carry a failure descriptor");
        }
        if (record.unknownReason !== undefined) {
          errors.push("a BROADCAST outcome may not carry an unknownReason");
        }
        break;
      }
      case "CONFIRMED": {
        if (record.failure !== undefined) {
          errors.push("a CONFIRMED outcome may not carry a failure descriptor");
        }
        if (record.unknownReason !== undefined) {
          errors.push("a CONFIRMED outcome may not carry an unknownReason");
        }
        const candidateFinality = record.finalityCandidate;
        if (candidateFinality !== undefined) {
          const finalityRecord = candidateFinality as Readonly<Record<string, unknown>>;
          if (finalityRecord.candidateOnly !== true) {
            errors.push(
              "finalityCandidate.candidateOnly must be true: an observer can only ever produce a candidate — finality is protocol-owned (INV-F06)",
            );
          }
          if (finalityRecord.requiresProtocolFinality !== true) {
            errors.push(
              "finalityCandidate.requiresProtocolFinality must be true (INV-F06)",
            );
          }
          if (
            finalityRecord.confirmationDepth !== undefined &&
            (typeof finalityRecord.confirmationDepth !== "number" ||
              !Number.isInteger(finalityRecord.confirmationDepth) ||
              finalityRecord.confirmationDepth < 1)
          ) {
            errors.push("finalityCandidate.confirmationDepth, when present, must be a positive integer");
          }
          if (
            finalityRecord.finalityModel !== "PROBABILISTIC" &&
            finalityRecord.finalityModel !== "DETERMINISTIC" &&
            finalityRecord.finalityModel !== "INSTANT" &&
            finalityRecord.finalityModel !== "HYBRID"
          ) {
            errors.push("finalityCandidate.finalityModel must be a declared finality model");
          }
          if (typeof finalityRecord.reorgDetected !== "boolean") {
            errors.push("finalityCandidate.reorgDetected must be a boolean");
          }
        }
        break;
      }
      case "FAILED": {
        const failure = record.failure;
        if (failure === null || typeof failure !== "object") {
          errors.push(
            "a FAILED outcome REQUIRES a failure descriptor (definitive failures are explained)",
          );
        } else {
          const failureRecord = failure as Readonly<Record<string, unknown>>;
          if (!(ONCHAIN_FAILURE_CLASSES as readonly unknown[]).includes(failureRecord.failureClass)) {
            errors.push(
              `failure.failureClass must be one of [${ONCHAIN_FAILURE_CLASSES.join(", ")}] (transport ambiguity is OUTCOME_UNKNOWN, never a failure — INV-X01)`,
            );
          }
          if (!isNonEmptyString(failureRecord.description)) {
            errors.push("failure.description must be a non-empty string");
          }
          if (
            failureRecord.retryGuidance !== "SAFE_TO_RETRY" &&
            failureRecord.retryGuidance !== "REQUIRES_RECONCILIATION" &&
            failureRecord.retryGuidance !== "NOT_RETRYABLE"
          ) {
            errors.push("failure.retryGuidance must be SAFE_TO_RETRY, REQUIRES_RECONCILIATION or NOT_RETRYABLE");
          }
        }
        if (record.unknownReason !== undefined) {
          errors.push("a FAILED outcome may not carry an unknownReason (it is not unknown)");
        }
        break;
      }
      case "OUTCOME_UNKNOWN": {
        if (!isNonEmptyString(record.unknownReason)) {
          errors.push(
            "an OUTCOME_UNKNOWN observation REQUIRES an explicit unknownReason: external ambiguity is explicit, never silently defaulted (INV-X01)",
          );
        }
        if (record.failure !== undefined) {
          errors.push(
            "an OUTCOME_UNKNOWN observation must NOT carry a failure descriptor: UNKNOWN is not FAILED (INV-X01)",
          );
        }
        break;
      }
    }
  }

  if (errors.length > 0) {
    throw new ValidationError(
      `Invalid onchain execution observation: ${errors.join("; ")}`,
      { errors: [...errors] },
    );
  }
  return candidate as OnchainExecutionObservation;
}

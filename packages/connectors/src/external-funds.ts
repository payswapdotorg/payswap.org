/**
 * External funds state (W2-003; FROZEN-ARCHITECTURE §2A; ADR-006; INV-C09;
 * AGENTS.md rule 21).
 *
 * ExternalFundsLocation identifies an external system/location where a
 * provider reports funds or an economic position (a PSP balance, an
 * external bank account, a wallet). ExternalFundsPositionObservation is a
 * time-stamped observation reported by that provider, with MANDATORY
 * freshness and provenance.
 *
 * These are external-state observations, NOT PaySwap custody and NOT proof
 * of a PaySwap-held customer balance: the observation type is nominally
 * branded (`observationKind`) so it is structurally distinct from any
 * ledger/balance type, and a stale or unverifiable observation can never
 * create a false PaySwap balance.
 *
 * Overlapping Stage-0 boundary shapes (location, observedAmount, freshness,
 * reconciliationState, provenance) are consumed as-is; this package is the
 * canonical owner of the full vocabulary.
 */

import { ValidationError } from "@payswap/protocol";
import type { ObservationProvenance } from "./observations.js";

/** Nominal brand: this value is an external observation, never a balance. */
export const EXTERNAL_FUNDS_OBSERVATION_KIND =
  "ExternalFundsPositionObservation" as const;

/**
 * An authoritative external location where funds/positions may reside
 * (§2A). A location is provider-reported — it is not a PaySwap account.
 */
export interface ExternalFundsLocation {
  readonly providerName: string;
  readonly accountRef: string;
  /** Provider-side instrument identifier (e.g. a balance or wallet id), when applicable. */
  readonly instrumentRef?: string;
  readonly description?: string;
}

/** Exact monetary amount (INV-F01: no floating-point money). */
export interface ObservedMoneyAmount {
  /** ISO 4217 code or asset identifier. */
  readonly currency: string;
  /** Integer minor units, string-encoded for exactness. */
  readonly minorUnits: string;
}

/** Freshness bounds for an external-state observation (mandatory, INV-C09). */
export interface ObservationFreshness {
  /** Provider-reported time the position was true. */
  readonly asOf: string;
  /** Consumer-side maximum tolerated age, in seconds. */
  readonly maxAgeSeconds: number;
}

export type ExternalFundsReconciliationState =
  | "NOT_RECONCILED"
  | "RECONCILED"
  | "DISCREPANCY";

/**
 * A time-stamped observation of an external funds position (§2A; INV-C09).
 *
 * STRUCTURALLY NOT A BALANCE: the nominal `observationKind` brand plus the
 * mandatory freshness and provenance make it non-assignable to and from any
 * ledger/balance type. It MUST NOT be recorded as PaySwap custody or as
 * proof of a PaySwap-held customer balance. Note the deliberate absence of
 * any mutable balance-shaped field.
 */
export interface ExternalFundsPositionObservation {
  readonly observationKind: typeof EXTERNAL_FUNDS_OBSERVATION_KIND;
  readonly observationId: string;
  readonly observedAt: string;
  readonly freshness: ObservationFreshness;
  readonly location: ExternalFundsLocation;
  readonly observedAmount: ObservedMoneyAmount;
  readonly provenance: ObservationProvenance;
  readonly reconciliationState?: ExternalFundsReconciliationState;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * Runtime validation for an external funds observation. Freshness and
 * provenance are MANDATORY (INV-C09): an observation without them is not
 * evidence of anything and cannot inform routing, payouts, netting,
 * treasury or reconciliation.
 */
export function validateExternalFundsPositionObservation(
  candidate: unknown,
): ExternalFundsPositionObservation {
  const errors: string[] = [];
  if (candidate === null || typeof candidate !== "object") {
    throw new ValidationError("external funds observation must be an object");
  }
  const record = candidate as Readonly<Record<string, unknown>>;
  if (record.observationKind !== EXTERNAL_FUNDS_OBSERVATION_KIND) {
    errors.push(
      `observationKind must be '${EXTERNAL_FUNDS_OBSERVATION_KIND}' (nominal separation from ledger/balance types — INV-C09)`,
    );
  }
  for (const field of ["observationId", "observedAt"] as const) {
    if (!isNonEmptyString(record[field])) {
      errors.push(`${field} must be a non-empty string`);
    }
  }
  const freshness = record.freshness as
    | Readonly<Record<string, unknown>>
    | undefined;
  if (freshness === undefined || typeof freshness !== "object") {
    errors.push("freshness is MANDATORY on every external funds observation (INV-C09)");
  } else {
    if (!isNonEmptyString(freshness.asOf)) {
      errors.push("freshness.asOf must be a non-empty timestamp string");
    }
    if (!isPositiveInteger(freshness.maxAgeSeconds)) {
      errors.push("freshness.maxAgeSeconds must be a positive integer");
    }
  }
  const location = record.location as Readonly<Record<string, unknown>> | undefined;
  if (
    location === undefined ||
    typeof location !== "object" ||
    !isNonEmptyString(location.providerName) ||
    !isNonEmptyString(location.accountRef)
  ) {
    errors.push("location must be { providerName, accountRef, instrumentRef?, description? }");
  }
  const amount = record.observedAmount as
    | Readonly<Record<string, unknown>>
    | undefined;
  if (
    amount === undefined ||
    typeof amount !== "object" ||
    !isNonEmptyString(amount.currency) ||
    !isNonEmptyString(amount.minorUnits)
  ) {
    errors.push("observedAmount must be { currency, minorUnits } (INV-F01 exact minor units)");
  }
  const provenance = record.provenance as
    | Readonly<Record<string, unknown>>
    | undefined;
  if (
    provenance === undefined ||
    typeof provenance !== "object" ||
    !isNonEmptyString(provenance.providerName) ||
    !isNonEmptyString(provenance.capturedAt)
  ) {
    errors.push("provenance is MANDATORY on every external funds observation (INV-C09)");
  }
  const reconciliationState = record.reconciliationState;
  if (
    reconciliationState !== undefined &&
    reconciliationState !== "NOT_RECONCILED" &&
    reconciliationState !== "RECONCILED" &&
    reconciliationState !== "DISCREPANCY"
  ) {
    errors.push("reconciliationState, when present, must be NOT_RECONCILED, RECONCILED or DISCREPANCY");
  }
  if (errors.length > 0) {
    throw new ValidationError(
      `Invalid external funds observation: ${errors.join("; ")}`,
      { errors: [...errors] },
    );
  }
  return candidate as ExternalFundsPositionObservation;
}

/**
 * Runtime guard for observations (INV-C09): accepts only objects carrying
 * the nominal brand plus the mandatory freshness and provenance.
 * Balance-shaped objects fail.
 */
export function isExternalFundsPositionObservation(
  value: unknown,
): value is ExternalFundsPositionObservation {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<ExternalFundsPositionObservation>;
  return (
    candidate.observationKind === EXTERNAL_FUNDS_OBSERVATION_KIND &&
    typeof candidate.observationId === "string" &&
    candidate.observationId !== "" &&
    typeof candidate.observedAt === "string" &&
    candidate.observedAt !== "" &&
    candidate.freshness !== undefined &&
    typeof candidate.freshness === "object" &&
    candidate.freshness !== null &&
    candidate.provenance !== undefined &&
    typeof candidate.provenance === "object" &&
    candidate.provenance !== null &&
    candidate.location !== undefined &&
    typeof candidate.location === "object" &&
    candidate.location !== null &&
    candidate.observedAmount !== undefined &&
    typeof candidate.observedAmount === "object" &&
    candidate.observedAmount !== null
  );
}

/**
 * Freshness check against a caller-supplied reference time (deterministic —
 * no ambient clock). An observation whose `asOf` cannot be parsed, or which
 * is older than its own `maxAgeSeconds` window, is NOT fresh: a stale or
 * unverifiable observation can never create a false PaySwap balance
 * (INV-C09, LOSSLESS model §7).
 */
export function isFreshAt(
  observation: ExternalFundsPositionObservation,
  referenceTime: string,
): boolean {
  const asOf = Date.parse(observation.freshness.asOf);
  const reference = Date.parse(referenceTime);
  if (Number.isNaN(asOf) || Number.isNaN(reference)) {
    return false;
  }
  const ageSeconds = (reference - asOf) / 1000;
  if (ageSeconds < 0) {
    // An asOf in the future of the reference clock is unverifiable.
    return false;
  }
  return ageSeconds <= observation.freshness.maxAgeSeconds;
}

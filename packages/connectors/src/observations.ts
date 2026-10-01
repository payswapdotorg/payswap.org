/**
 * CapabilityObservation — time/versioned observations of a connected
 * instance's availability, eligibility, health, quota, terms and external
 * state (W2-003; FROZEN-ARCHITECTURE §2A layer 4; ADR-006).
 *
 * The two-axis availability model is REUSED from @payswap/capabilities
 * (INV-C01: capability state and source availability are separate axes;
 * INV-C02: an unreachable/unknown source means availability UNKNOWN —
 * never success, never failure). Observations are therefore constructed
 * through `observeCapability`, which derives the effective availability via
 * the frozen Stage-0 resolver; callers cannot fabricate it.
 *
 * Overlapping Stage-0 boundary shapes (observedAt, observationVersion,
 * availability, eligibility, health, quota, terms, provenance) are
 * consumed as-is; this package is the canonical owner of the full
 * vocabulary.
 */

import { resolveEffectiveAvailability } from "@payswap/capabilities";
import type {
  CapabilityState,
  EffectiveAvailability,
  SourceAvailability,
} from "@payswap/capabilities";
import { ValidationError } from "@payswap/protocol";
import type { ProviderStateEnvelope } from "./provider-state.js";

/** Observation provenance (§2A; INV-C01: state and source availability are separate axes). */
export interface ObservationProvenance {
  readonly providerName: string;
  readonly source: "PROVIDER_API" | "PROVIDER_WEBHOOK" | "OPERATOR" | "INTERNAL";
  readonly capturedAt: string;
}

export type HealthStatus = "HEALTHY" | "DEGRADED" | "UNHEALTHY" | "UNKNOWN";

export interface HealthSignal {
  readonly status: HealthStatus;
  readonly lastCheckedAt: string;
}

export interface QuotaObservation {
  readonly limit?: number;
  readonly remaining?: number;
  readonly windowSeconds?: number;
}

export interface TermsObservation {
  readonly version: string;
  readonly changePending: boolean;
}

export type EligibilityObservation = "ELIGIBLE" | "NOT_ELIGIBLE" | "UNKNOWN";

/**
 * CapabilityObservation (§2A layer 4): scoped to a ConnectedCapabilityInstance,
 * time/versioned, and UNKNOWN whenever current reachability cannot be
 * established (INV-C02). `availability` is always DERIVED from the two axes.
 */
export interface CapabilityObservation {
  readonly instanceId: string;
  readonly observedAt: string;
  /** Monotonic per-instance observation version. */
  readonly observationVersion: number;
  /** Axis 1: what the capability itself reports. */
  readonly capabilityState: CapabilityState;
  /** Axis 2: whether the confirming source is reachable. */
  readonly sourceAvailability: SourceAvailability;
  /** The derived two-axis effective availability (INV-C01/C02). */
  readonly availability: EffectiveAvailability;
  readonly eligibility: EligibilityObservation;
  readonly health: HealthSignal;
  readonly quota?: QuotaObservation;
  readonly terms?: TermsObservation;
  /** External state needed for execution (lossless, INV-C06). */
  readonly externalState?: ProviderStateEnvelope;
  readonly provenance: ObservationProvenance;
}

/** Input to `observeCapability`: the axes are mandatory, availability is NOT. */
export interface ObserveCapabilityInput {
  readonly instanceId: string;
  readonly observedAt: string;
  readonly observationVersion: number;
  readonly capabilityState: CapabilityState;
  readonly sourceAvailability: SourceAvailability;
  readonly eligibility: EligibilityObservation;
  readonly health: HealthSignal;
  readonly quota?: QuotaObservation;
  readonly terms?: TermsObservation;
  readonly externalState?: ProviderStateEnvelope;
  readonly provenance: ObservationProvenance;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isCapabilityState(value: unknown): value is CapabilityState {
  return (
    value === "AVAILABLE" || value === "DEGRADED" || value === "UNAVAILABLE"
  );
}

function isSourceAvailability(value: unknown): value is SourceAvailability {
  return (
    value === "REACHABLE" || value === "UNREACHABLE" || value === "UNKNOWN"
  );
}

function isEligibility(value: unknown): value is EligibilityObservation {
  return (
    value === "ELIGIBLE" || value === "NOT_ELIGIBLE" || value === "UNKNOWN"
  );
}

function isHealthStatus(value: unknown): value is HealthStatus {
  return (
    value === "HEALTHY" ||
    value === "DEGRADED" ||
    value === "UNHEALTHY" ||
    value === "UNKNOWN"
  );
}

/**
 * Constructs a validated observation. The effective availability is DERIVED
 * from the two axes with the frozen Stage-0 resolver — an unreachable or
 * unknown source yields UNKNOWN, never success or failure (INV-C02,
 * INV-X01). There is deliberately no way to declare a fabricated
 * availability.
 */
export function observeCapability(
  input: ObserveCapabilityInput,
): CapabilityObservation {
  const errors: string[] = [];
  if (input === null || typeof input !== "object") {
    throw new ValidationError("observation input must be an object");
  }
  if (!isNonEmptyString(input.instanceId)) {
    errors.push("instanceId must be a non-empty string");
  }
  if (!isNonEmptyString(input.observedAt)) {
    errors.push("observedAt must be a non-empty timestamp string");
  }
  if (
    typeof input.observationVersion !== "number" ||
    !Number.isInteger(input.observationVersion) ||
    input.observationVersion < 1
  ) {
    errors.push("observationVersion must be a positive integer");
  }
  if (!isCapabilityState(input.capabilityState)) {
    errors.push("capabilityState must be AVAILABLE, DEGRADED or UNAVAILABLE");
  }
  if (!isSourceAvailability(input.sourceAvailability)) {
    errors.push("sourceAvailability must be REACHABLE, UNREACHABLE or UNKNOWN");
  }
  if (!isEligibility(input.eligibility)) {
    errors.push("eligibility must be ELIGIBLE, NOT_ELIGIBLE or UNKNOWN");
  }
  const health = input.health;
  if (
    health === null ||
    typeof health !== "object" ||
    !isHealthStatus(health.status) ||
    !isNonEmptyString(health.lastCheckedAt)
  ) {
    errors.push("health must be { status, lastCheckedAt }");
  }
  const provenance = input.provenance;
  if (
    provenance === null ||
    typeof provenance !== "object" ||
    !isNonEmptyString(provenance.providerName) ||
    !isNonEmptyString(provenance.capturedAt) ||
    (provenance.source !== "PROVIDER_API" &&
      provenance.source !== "PROVIDER_WEBHOOK" &&
      provenance.source !== "OPERATOR" &&
      provenance.source !== "INTERNAL")
  ) {
    errors.push("provenance must be { providerName, source, capturedAt }");
  }
  if (errors.length > 0) {
    throw new ValidationError(
      `Invalid capability observation: ${errors.join("; ")}`,
      { errors: [...errors] },
    );
  }

  const availability = resolveEffectiveAvailability(
    input.capabilityState,
    input.sourceAvailability,
  );

  const observation: CapabilityObservation = {
    instanceId: input.instanceId,
    observedAt: input.observedAt,
    observationVersion: input.observationVersion,
    capabilityState: input.capabilityState,
    sourceAvailability: input.sourceAvailability,
    availability,
    eligibility: input.eligibility,
    health: Object.freeze({ ...input.health }),
    provenance: Object.freeze({ ...input.provenance }),
    ...(input.quota !== undefined ? { quota: Object.freeze({ ...input.quota }) } : {}),
    ...(input.terms !== undefined ? { terms: Object.freeze({ ...input.terms }) } : {}),
    ...(input.externalState !== undefined ? { externalState: input.externalState } : {}),
  };
  return Object.freeze(observation);
}

/**
 * Convenience constructor for the case where CURRENT REACHABILITY CANNOT BE
 * ESTABLISHED (source UNKNOWN): the last-known capability state is carried
 * as-is, the source axis is UNKNOWN, and the derived availability is
 * therefore UNKNOWN (INV-C02) — never FAILED, never success.
 */
export function unknownReachabilityObservation(input: {
  readonly instanceId: string;
  readonly observedAt: string;
  readonly observationVersion: number;
  readonly lastKnownCapabilityState: CapabilityState;
  readonly reason: string;
  readonly provenance: ObservationProvenance;
}): CapabilityObservation {
  return observeCapability({
    instanceId: input.instanceId,
    observedAt: input.observedAt,
    observationVersion: input.observationVersion,
    capabilityState: input.lastKnownCapabilityState,
    sourceAvailability: "UNKNOWN",
    eligibility: "UNKNOWN",
    health: { status: "UNKNOWN", lastCheckedAt: input.observedAt },
    provenance: input.provenance,
  });
}

/**
 * Structural validation for observations from untyped sources: verifies the
 * derived availability actually matches the two axes (a fabricated
 * AVAILABLE on an unreachable source is rejected).
 */
export function validateCapabilityObservation(
  candidate: unknown,
): CapabilityObservation {
  if (typeof candidate !== "object" || candidate === null) {
    throw new ValidationError("capability observation must be an object");
  }
  const record = candidate as Readonly<Record<string, unknown>>;
  const observation = candidate as CapabilityObservation;
  if (
    !isCapabilityState(record.capabilityState) ||
    !isSourceAvailability(record.sourceAvailability)
  ) {
    throw new ValidationError(
      "capability observation must declare both availability axes (INV-C01)",
    );
  }
  const expected = resolveEffectiveAvailability(
    record.capabilityState,
    record.sourceAvailability,
  );
  if (record.availability !== expected) {
    throw new ValidationError(
      `capability observation availability '${String(record.availability)}' does not match its two axes (expected '${expected}' — INV-C02: unknown reachability is never success or failure)`,
    );
  }
  return observation;
}

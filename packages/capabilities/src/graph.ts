/**
 * Capability Graph (W2-003, FROZEN-ARCHITECTURE §11).
 *
 * The registration + query implementation over the frozen Stage-0/1
 * resolution contracts (./resolution.js): capabilities are registered by
 * class together with their TWO-AXIS availability (capability state + source
 * availability) and queried deterministically by class + conditions.
 *
 * - `AcceptanceCapability` is queryable as a capability: merchant acceptance
 *   is a first-class capability, distinct from any funding source (§11).
 * - `ServiceAccessCapability` describes subscription/entitlement acquisition
 *   INDEPENDENT from funding: the credential that funds access and the
 *   credential that grants the service are distinct, non-interchangeable
 *   types (a funding credential can never be presented where a service
 *   credential is required, and vice versa).
 *
 * This module owns no availability semantics of its own: the two-axis model
 * (INV-C01/C02) is reused from ./availability.js and ./resolution.js.
 */

import type {
  AcceptanceCapability,
  Capability,
  CapabilityClass,
  ProvenanceDescriptor,
} from "./capability.js";
import type {
  CapabilityState,
  EffectiveAvailability,
  SourceAvailability,
} from "./availability.js";
import { resolveEffectiveAvailability } from "./availability.js";
import type {
  CapabilityGraph,
  CapabilityGraphEntry,
  CapabilityResolution,
  CapabilityResolveRequest,
} from "./resolution.js";
import { resolveCapability } from "./resolution.js";

// ---------------------------------------------------------------------------
// ServiceAccessCapability — service acquisition independent from funding
// ---------------------------------------------------------------------------

/**
 * The credential that FUNDS access to a service (e.g. a card on file, a bank
 * mandate or a wallet). Structurally distinct from ServiceCredentialScope:
 * the two `kind` literals make them non-interchangeable.
 */
export interface FundingCredentialScope {
  readonly kind: "funding_credential";
  readonly credentialRef: string;
  readonly credentialType: string;
}

/**
 * The credential that GRANTS the service itself (e.g. a subscription
 * entitlement or license seat). Structurally distinct from
 * FundingCredentialScope: presenting a funding credential where a service
 * credential is required is a type error.
 */
export interface ServiceCredentialScope {
  readonly kind: "service_credential";
  readonly credentialRef: string;
  readonly credentialType: string;
}

/** How the described service is acquired economically. */
export type ServiceSubscriptionModel =
  | "SUBSCRIPTION"
  | "USAGE_BASED"
  | "ONE_TIME"
  | "PROVIDER_DEFINED";

/**
 * A capability describing subscription/entitlement acquisition, independent
 * from funding (W2-003 acceptance): acquiring the SERVICE and FUNDING it are
 * separate concerns carried by distinct credential types.
 */
export interface ServiceAccessCapability extends Capability {
  readonly capabilityClass: "developer_service";
  readonly serviceId: string;
  readonly fundingCredential: FundingCredentialScope;
  readonly serviceCredential: ServiceCredentialScope;
  readonly subscriptionModel: ServiceSubscriptionModel;
  readonly entitlementRef?: string;
}

// ---------------------------------------------------------------------------
// Runtime narrowing guards
// ---------------------------------------------------------------------------

/** Narrows a Capability to AcceptanceCapability (structural check). */
export function isAcceptanceCapability(
  value: Capability,
): value is AcceptanceCapability {
  const candidate = value as Partial<AcceptanceCapability>;
  return (
    candidate.capabilityClass === "merchant_acceptance" &&
    Array.isArray(candidate.acceptedPaymentMethods) &&
    Array.isArray(candidate.acceptedCurrencies) &&
    Array.isArray(candidate.acceptedCountries) &&
    candidate.terms !== undefined &&
    candidate.terms !== null
  );
}

/** Narrows a Capability to ServiceAccessCapability (structural check). */
export function isServiceAccessCapability(
  value: Capability,
): value is ServiceAccessCapability {
  const candidate = value as Partial<ServiceAccessCapability>;
  return (
    candidate.capabilityClass === "developer_service" &&
    typeof candidate.serviceId === "string" &&
    candidate.serviceId !== "" &&
    candidate.fundingCredential !== undefined &&
    candidate.fundingCredential !== null &&
    candidate.fundingCredential.kind === "funding_credential" &&
    candidate.serviceCredential !== undefined &&
    candidate.serviceCredential !== null &&
    candidate.serviceCredential.kind === "service_credential"
  );
}

// ---------------------------------------------------------------------------
// The graph store
// ---------------------------------------------------------------------------

/** A graph entry enriched with deterministic registration order. */
export interface RegisteredCapabilityGraphEntry extends CapabilityGraphEntry {
  /** 1-based registration order; assigned by the store, never by callers. */
  readonly registrationSequence: number;
}

/** An acceptance candidate with resolved two-axis availability. */
export interface AcceptanceCandidate {
  readonly capability: AcceptanceCapability;
  readonly sourceId: string;
  readonly capabilityState: CapabilityState;
  readonly sourceAvailability: SourceAvailability;
  readonly effectiveAvailability: EffectiveAvailability;
  readonly provenance: ProvenanceDescriptor;
}

/** A service-access candidate with resolved two-axis availability. */
export interface ServiceAccessCandidate {
  readonly capability: ServiceAccessCapability;
  readonly sourceId: string;
  readonly capabilityState: CapabilityState;
  readonly sourceAvailability: SourceAvailability;
  readonly effectiveAvailability: EffectiveAvailability;
  readonly provenance: ProvenanceDescriptor;
}

/** Query for merchant acceptance (all filters are optional hard constraints). */
export interface AcceptanceQuery {
  readonly paymentMethod?: string;
  readonly currency?: string;
  readonly country?: string;
  readonly requireRecurringSupport?: boolean;
}

/** Query for service access (all filters are optional hard constraints). */
export interface ServiceAccessQuery {
  readonly serviceId?: string;
  readonly entitlementRef?: string;
  readonly subscriptionModel?: ServiceSubscriptionModel;
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * The CapabilityGraph implementation: registers capabilities by class with
 * their two-axis availability and answers deterministic class + condition
 * queries (plus acceptance and service-access queries).
 *
 * It satisfies the frozen Stage-0 `CapabilityGraph` read view from
 * ./resolution.js, so `resolveCapability(store, request)` keeps working
 * unchanged; `resolve` below simply delegates to it.
 */
export class CapabilityGraphStore implements CapabilityGraph {
  private readonly entriesBySequence: RegisteredCapabilityGraphEntry[] = [];
  private readonly entriesById = new Map<string, RegisteredCapabilityGraphEntry>();
  private nextSequence = 1;

  /** Registers a capability entry. Registration order is deterministic. */
  register(entry: CapabilityGraphEntry): RegisteredCapabilityGraphEntry {
    const capability = entry.capability;
    if (capability === null || typeof capability !== "object") {
      throw new Error("capability graph entry requires a capability object");
    }
    if (!isNonEmptyString(capability.id)) {
      throw new Error("capability graph entry requires a non-empty capability.id");
    }
    if (!isNonEmptyString(entry.sourceId)) {
      throw new Error("capability graph entry requires a non-empty sourceId");
    }
    if (!isCapabilityState(entry.capabilityState)) {
      throw new Error(
        `invalid capabilityState '${String(entry.capabilityState)}': must be AVAILABLE, DEGRADED or UNAVAILABLE`,
      );
    }
    if (!isSourceAvailability(entry.sourceAvailability)) {
      throw new Error(
        `invalid sourceAvailability '${String(entry.sourceAvailability)}': must be REACHABLE, UNREACHABLE or UNKNOWN`,
      );
    }
    if (this.entriesById.has(capability.id)) {
      throw new Error(`capability '${capability.id}' is already registered`);
    }
    const registered: RegisteredCapabilityGraphEntry = Object.freeze({
      capability,
      sourceId: entry.sourceId,
      capabilityState: entry.capabilityState,
      sourceAvailability: entry.sourceAvailability,
      registrationSequence: this.nextSequence,
    });
    this.nextSequence += 1;
    this.entriesBySequence.push(registered);
    this.entriesById.set(capability.id, registered);
    return registered;
  }

  /** The frozen Stage-0 `CapabilityGraph` view, in registration order. */
  get entries(): readonly RegisteredCapabilityGraphEntry[] {
    return this.entriesBySequence;
  }

  /** Look up a registered capability by id. */
  byId(capabilityId: string): Capability | undefined {
    return this.entriesById.get(capabilityId)?.capability;
  }

  /**
   * Deterministic class + conditions resolution (delegates to the frozen
   * Stage-0 resolver; hard constraints before availability considerations).
   */
  resolve(request: CapabilityResolveRequest): CapabilityResolution {
    return resolveCapability({ entries: this.entries }, request);
  }

  /**
   * Query merchant acceptance as a capability (§11: acceptance is a
   * first-class capability, distinct from funding). Returns EVERY matching
   * acceptance capability in registration order, each with its two-axis
   * effective availability — an unreachable confirming source yields UNKNOWN,
   * never success or failure (INV-C02).
   */
  queryAcceptance(query: AcceptanceQuery = {}): readonly AcceptanceCandidate[] {
    const candidates: AcceptanceCandidate[] = [];
    for (const entry of this.entriesBySequence) {
      if (entry.capability.capabilityClass !== "merchant_acceptance") {
        continue;
      }
      if (!isAcceptanceCapability(entry.capability)) {
        continue;
      }
      if (
        query.paymentMethod !== undefined &&
        !entry.capability.acceptedPaymentMethods.includes(query.paymentMethod)
      ) {
        continue;
      }
      if (
        query.currency !== undefined &&
        !entry.capability.acceptedCurrencies.includes(query.currency)
      ) {
        continue;
      }
      if (
        query.country !== undefined &&
        !entry.capability.acceptedCountries.includes(query.country)
      ) {
        continue;
      }
      if (
        query.requireRecurringSupport === true &&
        entry.capability.terms.supportsRecurring !== true
      ) {
        continue;
      }
      candidates.push({
        capability: entry.capability,
        sourceId: entry.sourceId,
        capabilityState: entry.capabilityState,
        sourceAvailability: entry.sourceAvailability,
        effectiveAvailability: resolveEffectiveAvailability(
          entry.capabilityState,
          entry.sourceAvailability,
        ),
        provenance: entry.capability.provenance,
      });
    }
    return candidates;
  }

  /**
   * Query service-access capabilities (subscription/entitlement acquisition,
   * independent from funding). Returns EVERY matching capability in
   * registration order with its two-axis effective availability.
   */
  queryServiceAccess(
    query: ServiceAccessQuery = {},
  ): readonly ServiceAccessCandidate[] {
    const candidates: ServiceAccessCandidate[] = [];
    for (const entry of this.entriesBySequence) {
      if (entry.capability.capabilityClass !== "developer_service") {
        continue;
      }
      if (!isServiceAccessCapability(entry.capability)) {
        continue;
      }
      if (
        query.serviceId !== undefined &&
        entry.capability.serviceId !== query.serviceId
      ) {
        continue;
      }
      if (
        query.entitlementRef !== undefined &&
        entry.capability.entitlementRef !== query.entitlementRef
      ) {
        continue;
      }
      if (
        query.subscriptionModel !== undefined &&
        entry.capability.subscriptionModel !== query.subscriptionModel
      ) {
        continue;
      }
      candidates.push({
        capability: entry.capability,
        sourceId: entry.sourceId,
        capabilityState: entry.capabilityState,
        sourceAvailability: entry.sourceAvailability,
        effectiveAvailability: resolveEffectiveAvailability(
          entry.capabilityState,
          entry.sourceAvailability,
        ),
        provenance: entry.capability.provenance,
      });
    }
    return candidates;
  }
}


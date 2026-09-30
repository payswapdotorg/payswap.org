/**
 * Merchant PSP Connector boundary contract (Stage 0 freeze, W3-001;
 * FROZEN-ARCHITECTURE §2A Universal Connector Model, §21A; ADR-006 /
 * LOSSLESS-CONNECTOR-CAPABILITY-MODEL.md).
 *
 * IMPORTANT — VOCABULARY OWNERSHIP:
 * Canonical connector capability vocabulary is OWNED BY W2-003 (consumed
 * here). This Stage 0 contract freezes the merchant-facing connector
 * boundary only; do not extend the vocabulary here. `capabilityId` values
 * are opaque references into the W2-003-owned vocabulary (AGENTS.md rule 22;
 * runbook: "creating a second connector capability vocabulary" is forbidden).
 *
 * Invariants structurally enforced by this module:
 * - INV-C05: a ProviderCatalogueEntry (what a provider CAN do, platform-wide)
 *   is NOT assignable to ConnectedCapabilityInstance (what one connected
 *   account/tenant is actually entitled, authorized and configured to do).
 *   The two shapes are deliberately non-overlapping and guarded at runtime.
 * - INV-C06: ProviderStateEnvelope passes provider state through LOSSLESSLY
 *   (state + history + action required + failure metadata + timestamps +
 *   provenance). It is never flattened into a canonical status.
 * - INV-C07: ExecutionMode (PASS_THROUGH_NATIVE | COMPOSED_PAYSWAP |
 *   OPTIMIZED_MULTI_PROVIDER) is explicit on EVERY execution. No mode
 *   bypasses protocol authorization, policy, compliance, security or
 *   evidence. Provider-native optimization is representable as a capability
 *   and remains an incumbent baseline (INV-C08).
 * - INV-C09: ExternalFundsPositionObservation is an observation of external
 *   state with mandatory freshness and provenance — structurally NOT a
 *   balance, never PaySwap custody and never proof of a PaySwap-held
 *   customer balance.
 */

import type { TerminalState } from './protocol-state.js';

// ---------------------------------------------------------------------------
// Execution modes (INV-C07, INV-C08)
// ---------------------------------------------------------------------------

export const EXECUTION_MODES = ['PASS_THROUGH_NATIVE', 'COMPOSED_PAYSWAP', 'OPTIMIZED_MULTI_PROVIDER'] as const;

export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export function isExecutionMode(value: unknown): value is ExecutionMode {
  return typeof value === 'string' && (EXECUTION_MODES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// §2A capability hierarchy (vocabulary owned by W2-003)
// ---------------------------------------------------------------------------

/** Provider-neutral semantics of an operation (§2A layer 1). */
export interface CapabilityDefinition {
  /** Opaque reference into the W2-003-owned capability vocabulary. */
  readonly capabilityId: string;
  readonly capabilityVersion: string;
  readonly summary: string;
  readonly requiredPermissions: readonly string[];
  /** Modes this capability may execute under (all subject to INV-C07 rules). */
  readonly executionModes: readonly ExecutionMode[];
}

/**
 * A provider's concrete implementation of a CapabilityDefinition (§2A layer 2).
 * SDK types, API names and provider quirks stay here and never leak into
 * canonical domain code (AGENTS.md rule 17).
 */
export interface ProviderImplementation {
  readonly providerName: string;
  readonly providerVersion: string;
  readonly capabilityId: string;
  readonly implementationNotes?: string;
  /**
   * INV-C08: when the provider exposes native optimization/routing/recovery
   * as executable behavior, it is represented as a capability reference here
   * so the Lab can benchmark the incumbent baseline against PaySwap
   * strategies without assuming composition is superior.
   */
  readonly nativeOptimization?: {
    readonly representableAsCapability: true;
    readonly capabilityId: string;
  };
}

/** Authorization state of the connected account/tenant credential. */
export interface ConnectorAuthorizationState {
  readonly status: 'ACTIVE' | 'PENDING' | 'REVOKED' | 'EXPIRED' | 'UNKNOWN';
  readonly grantedAt?: string;
  readonly revokedAt?: string;
  readonly authorizationRef?: string;
}

/** Geography scope of a connected instance. */
export interface GeographyScope {
  readonly countries: readonly string[];
  readonly regions?: readonly string[];
}

/** Permission state relative to a capability's required permissions. */
export interface ConnectorPermissionState {
  readonly granted: readonly string[];
  readonly requested: readonly string[];
  readonly missing: readonly string[];
}

/**
 * The capability actually exposed by ONE connected provider account/tenant
 * (§2A layer 3): scoped to real account, authorization, geography/currency
 * and permission state. This is the primary object for executable discovery
 * (INV-C05).
 */
export interface ConnectedCapabilityInstance {
  readonly instanceId: string;
  readonly capabilityId: string;
  readonly providerName: string;
  readonly providerVersion: string;
  /** The connected merchant account this instance is scoped to. */
  readonly accountRef: string;
  readonly tenantRef: string;
  readonly authorization: ConnectorAuthorizationState;
  readonly geography: GeographyScope;
  readonly currencies: readonly string[];
  readonly permissionState: ConnectorPermissionState;
}

/**
 * A platform-wide catalogue entry describing what a provider CAN do
 * (INV-C05: catalogue claims alone can never authorize execution).
 * Deliberately non-overlapping with ConnectedCapabilityInstance: no
 * instanceId, no accountRef, no authorization, no permission state.
 */
export interface ProviderCatalogueEntry {
  readonly catalogueEntryId: string;
  readonly providerName: string;
  readonly providerVersion: string;
  readonly capabilityId: string;
  readonly summary: string;
  /** Platform-wide advertised scope — what the provider claims to support. */
  readonly advertisedScope: {
    readonly platformWide: true;
    readonly advertisedGeographies: readonly string[];
    readonly advertisedCurrencies: readonly string[];
  };
}

/** Runtime guard: only genuinely connected instances pass (INV-C05). */
export function isConnectedCapabilityInstance(value: unknown): value is ConnectedCapabilityInstance {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<ConnectedCapabilityInstance>;
  return (
    typeof candidate.instanceId === 'string' &&
    candidate.instanceId !== '' &&
    typeof candidate.accountRef === 'string' &&
    candidate.accountRef !== '' &&
    typeof candidate.tenantRef === 'string' &&
    candidate.authorization !== undefined &&
    candidate.authorization !== null &&
    typeof candidate.permissionState === 'object' &&
    candidate.permissionState !== null
  );
}

/** Runtime guard for catalogue entries. */
export function isProviderCatalogueEntry(value: unknown): value is ProviderCatalogueEntry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<ProviderCatalogueEntry>;
  return (
    typeof candidate.catalogueEntryId === 'string' &&
    candidate.catalogueEntryId !== '' &&
    candidate.advertisedScope !== undefined &&
    candidate.advertisedScope !== null &&
    candidate.advertisedScope.platformWide === true
  );
}

/** Provenance of an observation (§2A; INV-C01: state and source availability are separate axes). */
export interface ObservationProvenance {
  readonly providerName: string;
  readonly source: 'PROVIDER_API' | 'PROVIDER_WEBHOOK' | 'OPERATOR' | 'INTERNAL';
  readonly capturedAt: string;
}

/**
 * Time/versioned observation of a connected instance's current
 * availability, eligibility, health, quota and terms (§2A layer 4).
 * An observation can be UNKNOWN — unknown reachability is never treated as
 * failure or success (INV-C02).
 */
export interface CapabilityObservation {
  readonly observedAt: string;
  /** Monotonic per-instance observation version. */
  readonly observationVersion: number;
  readonly availability: 'AVAILABLE' | 'DEGRADED' | 'UNAVAILABLE' | 'UNKNOWN';
  readonly eligibility: 'ELIGIBLE' | 'NOT_ELIGIBLE' | 'UNKNOWN';
  readonly health: {
    readonly status: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'UNKNOWN';
    readonly lastCheckedAt: string;
  };
  readonly quota?: {
    readonly limit?: number;
    readonly remaining?: number;
    readonly windowSeconds?: number;
  };
  readonly terms?: {
    readonly version: string;
    readonly changePending: boolean;
  };
  readonly provenance: ObservationProvenance;
}

// ---------------------------------------------------------------------------
// Provider state preservation (INV-C06)
// ---------------------------------------------------------------------------

export interface ProviderStateTransition {
  readonly fromRevision?: string;
  readonly toRevision: string;
  readonly occurredAt: string;
  readonly actor?: string;
  readonly note?: string;
}

/** A provider-required user action preserved verbatim (e.g. 3DS challenge). */
export interface ProviderActionRequired {
  readonly kind: string;
  readonly message: string;
  readonly deepLink?: string;
}

/** Provider failure metadata, including outcome ambiguity classification. */
export interface ProviderFailureMetadata {
  readonly providerErrorCode?: string;
  readonly providerErrorMessage?: string;
  readonly retryable: boolean;
  /** OUTCOME_UNKNOWN feeds EXTERNAL_AMBIGUITY handling; it is never a plain failure (INV-X01/INV-X02). */
  readonly ambiguity: 'NONE' | 'OUTCOME_UNKNOWN';
}

/**
 * Lossless provider state envelope attached to consequential provider
 * operations (INV-C06). `state` is the raw provider-native state and MUST be
 * preserved verbatim: consumers may read it for customer action,
 * reconciliation, support, audit and reprocessing, but must never flatten,
 * overwrite or erase provider lifecycle semantics (AGENTS.md rule 19).
 * Canonical state — not this envelope — controls protocol truth.
 */
export interface ProviderStateEnvelope {
  readonly provider: {
    readonly name: string;
    readonly version: string;
  };
  readonly object: {
    readonly objectType: string;
    readonly externalId: string;
  };
  readonly revision: string;
  /** Raw provider-native state. Opaque passthrough; never flattened. */
  readonly state: unknown;
  readonly history: readonly ProviderStateTransition[];
  readonly actionRequired?: ProviderActionRequired;
  readonly failure?: ProviderFailureMetadata;
  readonly timestamps: {
    readonly observedAt: string;
    readonly updatedAt?: string;
  };
  readonly provenance: {
    readonly source: 'PROVIDER_API' | 'PROVIDER_WEBHOOK' | 'OPERATOR';
    readonly fetchId?: string;
  };
}

// ---------------------------------------------------------------------------
// Connector execution (INV-C07)
// ---------------------------------------------------------------------------

/**
 * A connector execution request. `executionMode` is REQUIRED on every
 * execution (INV-C07); omitting it is a contract violation
 * (see validateConnectorExecutionRequest).
 */
export interface ConnectorExecutionRequest {
  readonly executionMode: ExecutionMode;
  readonly capabilityInstanceId: string;
  /** Opaque provider-native request payload. */
  readonly providerRequest: unknown;
  readonly idempotencyKey: string;
}

export interface ConnectorExecutionResult {
  /** Echoes the explicit mode chosen for this execution (INV-C07). */
  readonly executionMode: ExecutionMode;
  /** Lossless provider state resulting from the execution (INV-C06). */
  readonly providerState: ProviderStateEnvelope;
  /** Canonical terminal state (§22). */
  readonly terminalState: TerminalState;
  readonly reconciliationRef?: string;
}

export type ConnectorExecutionValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly violations: readonly string[] };

/** Validates that an execution request carries an explicit, valid mode (INV-C07). */
export function validateConnectorExecutionRequest(request: ConnectorExecutionRequest): ConnectorExecutionValidation {
  const violations: string[] = [];
  if (!isExecutionMode(request?.executionMode)) {
    violations.push('executionMode is REQUIRED on every execution (INV-C07): PASS_THROUGH_NATIVE | COMPOSED_PAYSWAP | OPTIMIZED_MULTI_PROVIDER');
  }
  if (typeof request?.capabilityInstanceId !== 'string' || request.capabilityInstanceId === '') {
    violations.push('capabilityInstanceId is required (must reference a ConnectedCapabilityInstance)');
  }
  if (typeof request?.idempotencyKey !== 'string' || request.idempotencyKey === '') {
    violations.push('idempotencyKey is required (INV-F05)');
  }
  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}

// ---------------------------------------------------------------------------
// External funds state (INV-C09)
// ---------------------------------------------------------------------------

/** An authoritative external location where funds/positions may reside (§2A). */
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

/** Freshness bounds for an external-state observation. */
export interface ObservationFreshness {
  /** Provider-reported time the position was true. */
  readonly asOf: string;
  /** Consumer-side maximum tolerated age, in seconds. */
  readonly maxAgeSeconds: number;
}

/**
 * A time-stamped observation of an external funds position (§2A; INV-C09).
 *
 * STRUCTURALLY NOT A BALANCE: it is an observation — it MUST carry observedAt,
 * freshness and provenance, and it MUST NOT be recorded as PaySwap custody or
 * as proof of a PaySwap-held customer balance. A stale or unverifiable
 * observation cannot create a false PaySwap balance (LOSSLESS model §7).
 * Note the deliberate absence of any mutable "balance"-shaped field.
 */
export interface ExternalFundsPositionObservation {
  readonly observationId: string;
  readonly observedAt: string;
  readonly freshness: ObservationFreshness;
  readonly location: ExternalFundsLocation;
  readonly observedAmount: ObservedMoneyAmount;
  readonly provenance: ObservationProvenance;
  readonly reconciliationState?: 'NOT_RECONCILED' | 'RECONCILED' | 'DISCREPANCY';
}

/**
 * Runtime guard for observations (INV-C09): accepts only objects carrying
 * the mandatory observation fields (observedAt, freshness, provenance,
 * location, observedAmount). Bare balance-shaped objects fail.
 */
export function isExternalFundsPositionObservation(value: unknown): value is ExternalFundsPositionObservation {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<ExternalFundsPositionObservation>;
  return (
    typeof candidate.observationId === 'string' &&
    candidate.observationId !== '' &&
    typeof candidate.observedAt === 'string' &&
    candidate.observedAt !== '' &&
    candidate.freshness !== undefined &&
    typeof candidate.freshness === 'object' &&
    candidate.freshness !== null &&
    candidate.provenance !== undefined &&
    typeof candidate.provenance === 'object' &&
    candidate.provenance !== null &&
    candidate.location !== undefined &&
    typeof candidate.location === 'object' &&
    candidate.location !== null &&
    candidate.observedAmount !== undefined &&
    typeof candidate.observedAmount === 'object' &&
    candidate.observedAmount !== null
  );
}

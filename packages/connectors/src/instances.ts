/**
 * ConnectedCapabilityInstance — the capability actually exposed by ONE
 * connected provider account/tenant (W2-003; FROZEN-ARCHITECTURE §2A layer
 * 3; ADR-006; INV-C05).
 *
 * A ProviderCatalogueEntry (what a provider CAN do, platform-wide) is a
 * structurally distinct, NON-ASSIGNABLE type: it deliberately lacks
 * instanceId, implementationId, account/tenant scope, authorization,
 * credential scope and permission state. A provider catalogue claim NEVER
 * authorizes execution — `assertConnectedInstance` rejects catalogue
 * entries at runtime with an INV-C05 error, and the registry refuses to
 * register a catalogue entry as an instance.
 *
 * Overlapping Stage-0 boundary shapes (instanceId, capabilityId,
 * providerName/Version, accountRef, tenantRef, authorization, geography,
 * currencies, permissionState, catalogue entry shape) are consumed as-is;
 * this package is the canonical owner of the full vocabulary.
 */

import { PaySwapError, ValidationError } from "@payswap/protocol";
import type { ErrorCategory, PaySwapErrorDetails } from "@payswap/protocol";

// ---------------------------------------------------------------------------
// Connected-instance scope shapes (consumed from the Stage-0 boundary)
// ---------------------------------------------------------------------------

/** Authorization state of the connected account/tenant credential. */
export interface ConnectorAuthorizationState {
  readonly status: "ACTIVE" | "PENDING" | "REVOKED" | "EXPIRED" | "UNKNOWN";
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

/** The credential scope a connected instance is bound to. */
export interface CredentialScope {
  readonly credentialRef: string;
  readonly credentialKind:
    | "API_KEY"
    | "OAUTH"
    | "DELEGATED_TOKEN"
    | "SESSION"
    | "PROVIDER_DEFINED";
  readonly delegationRef?: string;
}

/** Eligibility of the connected account for this capability. */
export interface InstanceEligibility {
  readonly eligible: boolean;
  /** Empty when eligible; otherwise the disqualifying reasons. */
  readonly reasons: readonly string[];
}

/**
 * ConnectedCapabilityInstance (§2A layer 3): scoped to a REAL provider
 * account/tenant, credential scope, authorization state, geography/currency
 * scope, permission state, eligibility and configuration. This is the
 * primary object for executable discovery (INV-C05).
 */
export interface ConnectedCapabilityInstance {
  readonly instanceId: string;
  readonly capabilityId: string;
  readonly implementationId: string;
  readonly providerName: string;
  readonly providerVersion: string;
  /** The connected merchant account this instance is scoped to. */
  readonly accountRef: string;
  readonly tenantRef: string;
  readonly authorization: ConnectorAuthorizationState;
  readonly credentialScope: CredentialScope;
  readonly geography: GeographyScope;
  readonly currencies: readonly string[];
  readonly permissionState: ConnectorPermissionState;
  readonly eligibility: InstanceEligibility;
  /** Provider-neutral configuration surface (opaque keys to primitives). */
  readonly configuration: Readonly<Record<string, string | number | boolean>>;
}

// ---------------------------------------------------------------------------
// Provider catalogue — structurally distinct, never an authority (INV-C05)
// ---------------------------------------------------------------------------

/**
 * A platform-wide catalogue entry describing what a provider CAN do
 * (INV-C05: catalogue claims alone can never authorize execution).
 * Deliberately non-overlapping with ConnectedCapabilityInstance: no
 * instanceId, no implementationId, no accountRef, no authorization, no
 * credential scope, no permission state, no eligibility.
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

// ---------------------------------------------------------------------------
// Runtime guards
// ---------------------------------------------------------------------------

/** Runtime guard: only genuinely connected instances pass (INV-C05). */
export function isConnectedCapabilityInstance(
  value: unknown,
): value is ConnectedCapabilityInstance {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<ConnectedCapabilityInstance>;
  return (
    typeof candidate.instanceId === "string" &&
    candidate.instanceId !== "" &&
    typeof candidate.accountRef === "string" &&
    candidate.accountRef !== "" &&
    typeof candidate.tenantRef === "string" &&
    candidate.tenantRef !== "" &&
    typeof candidate.implementationId === "string" &&
    candidate.implementationId !== "" &&
    candidate.authorization !== undefined &&
    candidate.authorization !== null &&
    typeof candidate.credentialScope === "object" &&
    candidate.credentialScope !== null &&
    typeof candidate.permissionState === "object" &&
    candidate.permissionState !== null &&
    typeof candidate.eligibility === "object" &&
    candidate.eligibility !== null &&
    typeof candidate.configuration === "object" &&
    candidate.configuration !== null
  );
}

/** Runtime guard for catalogue entries (an advertisement, never authority). */
export function isProviderCatalogueEntry(
  value: unknown,
): value is ProviderCatalogueEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<ProviderCatalogueEntry>;
  return (
    typeof candidate.catalogueEntryId === "string" &&
    candidate.catalogueEntryId !== "" &&
    candidate.advertisedScope !== undefined &&
    candidate.advertisedScope !== null &&
    candidate.advertisedScope.platformWide === true
  );
}

/**
 * Raised when a provider catalogue entry is presented where a genuinely
 * connected capability instance is required (INV-C05): a catalogue claim
 * never authorizes execution.
 */
export class ConnectorAuthorityError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({
      code: "CATALOGUE_ENTRY_IS_NOT_EXECUTION_AUTHORITY",
      category: "AUTHORIZATION_REQUIRED" as ErrorCategory,
      message,
      details,
    });
  }
}

/**
 * Runtime assertion for execution paths: the value MUST be a
 * ConnectedCapabilityInstance. A ProviderCatalogueEntry is rejected with an
 * explicit INV-C05 error (catalogue → instance rejection).
 */
export function assertConnectedInstance(
  value: unknown,
): asserts value is ConnectedCapabilityInstance {
  if (isProviderCatalogueEntry(value)) {
    throw new ConnectorAuthorityError(
      "INV-C05: a provider catalogue entry is an advertisement and can never authorize execution — execution requires a ConnectedCapabilityInstance scoped to a real account/tenant, authorization, geography/currency and permission state",
      { catalogueEntryId: value.catalogueEntryId, providerName: value.providerName },
    );
  }
  if (!isConnectedCapabilityInstance(value)) {
    throw new ValidationError(
      "execution requires a ConnectedCapabilityInstance (INV-C05): account/tenant scope, authorization, credential scope, permission state, eligibility and configuration must all be present",
    );
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => isNonEmptyString(item));
}

/**
 * Runtime validation for a connected capability instance arriving from
 * untyped sources. Enforces the full INV-C05 scope: real account/tenant,
 * credential scope, authorization, geography/currency, permission state,
 * eligibility and configuration.
 */
export function validateConnectedCapabilityInstance(
  candidate: unknown,
): ConnectedCapabilityInstance {
  const errors: string[] = [];
  if (candidate === null || typeof candidate !== "object") {
    throw new ValidationError("connected capability instance must be an object");
  }
  const record = candidate as Readonly<Record<string, unknown>>;
  for (const field of [
    "instanceId",
    "capabilityId",
    "implementationId",
    "providerName",
    "providerVersion",
    "accountRef",
    "tenantRef",
  ] as const) {
    if (!isNonEmptyString(record[field])) {
      errors.push(`${field} must be a non-empty string`);
    }
  }
  const authorization = record.authorization;
  if (
    authorization === null ||
    typeof authorization !== "object" ||
    !["ACTIVE", "PENDING", "REVOKED", "EXPIRED", "UNKNOWN"].includes(
      String((authorization as Readonly<Record<string, unknown>>)["status"]),
    )
  ) {
    errors.push("authorization.status must be ACTIVE, PENDING, REVOKED, EXPIRED or UNKNOWN");
  }
  const credentialScope = record.credentialScope;
  if (
    credentialScope === null ||
    typeof credentialScope !== "object" ||
    !isNonEmptyString((credentialScope as Readonly<Record<string, unknown>>)["credentialRef"])
  ) {
    errors.push("credentialScope.credentialRef must be a non-empty string");
  }
  const geography = record.geography;
  if (
    geography === null ||
    typeof geography !== "object" ||
    !isStringArray((geography as Readonly<Record<string, unknown>>)["countries"])
  ) {
    errors.push("geography.countries must be an array of country codes");
  }
  if (!isStringArray(record.currencies) || (record.currencies as readonly string[]).length === 0) {
    errors.push("currencies must be a non-empty array of currency codes");
  }
  const permissionState = record.permissionState;
  if (permissionState === null || typeof permissionState !== "object") {
    errors.push("permissionState must be a ConnectorPermissionState");
  } else {
    const permissions = permissionState as Readonly<Record<string, unknown>>;
    for (const field of ["granted", "requested", "missing"] as const) {
      if (!isStringArray(permissions[field])) {
        errors.push(`permissionState.${field} must be an array of strings`);
      }
    }
  }
  const eligibility = record.eligibility;
  if (
    eligibility === null ||
    typeof eligibility !== "object" ||
    typeof (eligibility as Readonly<Record<string, unknown>>)["eligible"] !== "boolean" ||
    !Array.isArray((eligibility as Readonly<Record<string, unknown>>)["reasons"])
  ) {
    errors.push("eligibility must be { eligible: boolean, reasons: string[] }");
  }
  const configuration = record.configuration;
  if (configuration === null || typeof configuration !== "object") {
    errors.push("configuration must be a provider-neutral record");
  } else {
    for (const [key, value] of Object.entries(
      configuration as Readonly<Record<string, unknown>>,
    )) {
      if (
        typeof value !== "string" &&
        typeof value !== "number" &&
        typeof value !== "boolean"
      ) {
        errors.push(
          `configuration.${key} must be a string, number or boolean (provider-neutral primitives only)`,
        );
      }
    }
  }
  if (errors.length > 0) {
    throw new ValidationError(
      `Invalid connected capability instance: ${errors.join("; ")}`,
      { errors: [...errors] },
    );
  }
  return candidate as ConnectedCapabilityInstance;
}

/**
 * Runtime validation for a provider catalogue entry. Catalogue entries are
 * legal discovery seeds — they are advertisements, never authority
 * (INV-C05).
 */
export function validateProviderCatalogueEntry(
  candidate: unknown,
): ProviderCatalogueEntry {
  const errors: string[] = [];
  if (candidate === null || typeof candidate !== "object") {
    throw new ValidationError("provider catalogue entry must be an object");
  }
  const record = candidate as Readonly<Record<string, unknown>>;
  for (const field of [
    "catalogueEntryId",
    "providerName",
    "providerVersion",
    "capabilityId",
    "summary",
  ] as const) {
    if (!isNonEmptyString(record[field])) {
      errors.push(`${field} must be a non-empty string`);
    }
  }
  const scope = record.advertisedScope;
  if (scope === null || typeof scope !== "object") {
    errors.push("advertisedScope must be declared");
  } else {
    const advertised = scope as Readonly<Record<string, unknown>>;
    if (advertised.platformWide !== true) {
      errors.push("advertisedScope.platformWide must be true");
    }
    if (!isStringArray(advertised.advertisedGeographies)) {
      errors.push("advertisedScope.advertisedGeographies must be an array");
    }
    if (!isStringArray(advertised.advertisedCurrencies)) {
      errors.push("advertisedScope.advertisedCurrencies must be an array");
    }
  }
  if (errors.length > 0) {
    throw new ValidationError(
      `Invalid provider catalogue entry: ${errors.join("; ")}`,
      { errors: [...errors] },
    );
  }
  return candidate as ProviderCatalogueEntry;
}

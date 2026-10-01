/**
 * ProviderImplementation — a provider's concrete implementation of a
 * CapabilityDefinition (W2-003; FROZEN-ARCHITECTURE §2A layer 2; ADR-006).
 *
 * SDK types, API names, provider states and provider quirks stay on the
 * provider side of the vocabulary (they land in the future W3-003 adapters):
 * this contract carries only provider-neutral references — `adapterRef` is
 * an opaque string, deviations are DOCUMENTED declarations, never provider
 * SDK types.
 *
 * Also hosts the provider/corridor registry: providers register their
 * implementations, and corridor queries answer which implementations serve
 * a geography/currency corridor. The generalized Connector registry
 * (./registry.js) composes this registry with the definition → instance →
 * observation chain.
 */

import { ValidationError } from "@payswap/protocol";

/** Kinds of external systems a connector can face (CONNECTOR-PLATFORM). */
export const PROVIDER_SYSTEM_KINDS = [
  "psp",
  "bank",
  "crm",
  "erp",
  "accounting",
  "healthcare_ehr",
  "fleet_telematics",
  "hospitality_pms",
  "legal_matter",
  "communications",
  "cloud_platform",
  "document_storage",
  "other",
] as const;

export type ProviderSystemKind = (typeof PROVIDER_SYSTEM_KINDS)[number];

export function isProviderSystemKind(
  value: unknown,
): value is ProviderSystemKind {
  return (
    typeof value === "string" &&
    (PROVIDER_SYSTEM_KINDS as readonly unknown[]).includes(value)
  );
}

/** A registered external provider (any system kind). */
export interface ProviderIdentity {
  readonly providerName: string;
  readonly providerVersion: string;
  readonly systemKind: ProviderSystemKind;
  readonly displayName: string;
}

/** A geography/currency corridor an implementation declares it serves. */
export interface CorridorScope {
  readonly fromCountries?: readonly string[];
  readonly toCountries?: readonly string[];
  readonly currencies?: readonly string[];
  readonly description?: string;
}

/** A query against the corridor registry. All filters are optional. */
export interface CorridorQuery {
  readonly fromCountry?: string;
  readonly toCountry?: string;
  readonly currency?: string;
}

/**
 * A documented deviation of a provider implementation from its
 * CapabilityDefinition. Deviations are DECLARED (provider-neutral text), so
 * certification can prove the catalogue-to-implementation mapping.
 */
export interface ImplementationDeviation {
  readonly aspect: string;
  readonly deviation: string;
  readonly documented: true;
}

/**
 * ProviderImplementation (§2A layer 2). Overlapping Stage-0 boundary fields
 * (providerName, providerVersion, capabilityId, implementationNotes,
 * nativeOptimization) keep their shapes; this package is the canonical
 * owner of the full vocabulary.
 */
export interface ProviderImplementation {
  readonly implementationId: string;
  readonly providerName: string;
  readonly providerVersion: string;
  readonly capabilityId: string;
  /** Definition version this implementation targets (any registered version when omitted). */
  readonly capabilityVersion?: string;
  /** Implementation version (independent of the definition version). */
  readonly version: string;
  /**
   * Opaque, provider-neutral reference to the concrete adapter that will
   * realize this implementation (owned by W3-003). Deliberately a string.
   */
  readonly adapterRef: string;
  readonly implementationNotes?: string;
  readonly corridors: readonly CorridorScope[];
  readonly knownDeviations: readonly ImplementationDeviation[];
  /**
   * INV-C08: when the provider exposes native optimization/routing/recovery
   * as executable behavior, it is referenced here as a capability so the
   * Lab can benchmark the incumbent baseline.
   */
  readonly nativeOptimization?: {
    readonly representableAsCapability: true;
    readonly capabilityId: string;
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => isNonEmptyString(item));
}

/** Runtime validation for a provider identity. */
export function validateProviderIdentity(
  candidate: unknown,
): ProviderIdentity {
  if (candidate === null || typeof candidate !== "object") {
    throw new ValidationError("provider identity must be an object");
  }
  const record = candidate as Readonly<Record<string, unknown>>;
  if (
    !isNonEmptyString(record.providerName) ||
    !isNonEmptyString(record.providerVersion) ||
    !isNonEmptyString(record.displayName) ||
    !isProviderSystemKind(record.systemKind)
  ) {
    throw new ValidationError(
      "provider identity requires providerName, providerVersion, displayName and a known systemKind",
    );
  }
  return candidate as ProviderIdentity;
}

/** Runtime validation for a provider implementation. */
export function validateProviderImplementation(
  candidate: unknown,
): ProviderImplementation {
  const errors: string[] = [];
  if (candidate === null || typeof candidate !== "object") {
    throw new ValidationError("provider implementation must be an object");
  }
  const record = candidate as Readonly<Record<string, unknown>>;
  for (const field of [
    "implementationId",
    "providerName",
    "providerVersion",
    "capabilityId",
    "version",
    "adapterRef",
  ] as const) {
    if (!isNonEmptyString(record[field])) {
      errors.push(`${field} must be a non-empty string`);
    }
  }
  if (!Array.isArray(record.corridors)) {
    errors.push("corridors must be an array of CorridorScope (may be empty)");
  } else {
    for (const [index, corridor] of record.corridors.entries()) {
      const entry = corridor as Readonly<Record<string, unknown>> | null;
      if (entry === null || typeof entry !== "object") {
        errors.push(`corridors[${index}] must be an object`);
        continue;
      }
      for (const field of ["fromCountries", "toCountries", "currencies"] as const) {
        const value = entry[field];
        if (value !== undefined && !isStringArray(value)) {
          errors.push(`corridors[${index}].${field}, when present, must be an array of country/currency codes`);
        }
      }
    }
  }
  if (!Array.isArray(record.knownDeviations)) {
    errors.push("knownDeviations must be an array (may be empty)");
  } else {
    for (const [index, deviation] of record.knownDeviations.entries()) {
      const entry = deviation as Readonly<Record<string, unknown>> | null;
      if (
        entry === null ||
        typeof entry !== "object" ||
        !isNonEmptyString(entry.aspect) ||
        !isNonEmptyString(entry.deviation) ||
        entry.documented !== true
      ) {
        errors.push(`knownDeviations[${index}] must be a documented deviation { aspect, deviation, documented: true }`);
      }
    }
  }
  if (record.capabilityVersion !== undefined && !isNonEmptyString(record.capabilityVersion)) {
    errors.push("capabilityVersion, when present, must be a non-empty string");
  }
  const native = record.nativeOptimization;
  if (
    native !== undefined &&
    (native === null ||
      typeof native !== "object" ||
      (native as Readonly<Record<string, unknown>>)["representableAsCapability"] !== true ||
      !isNonEmptyString((native as Readonly<Record<string, unknown>>)["capabilityId"]))
  ) {
    errors.push(
      "nativeOptimization, when present, must be { representableAsCapability: true, capabilityId } (INV-C08)",
    );
  }
  if (errors.length > 0) {
    throw new ValidationError(
      `Invalid provider implementation: ${errors.join("; ")}`,
      { errors: [...errors] },
    );
  }
  return candidate as ProviderImplementation;
}

/** True when an implementation declares service for the queried corridor. */
export function servesCorridor(
  implementation: ProviderImplementation,
  query: CorridorQuery,
): boolean {
  if (implementation.corridors.length === 0) {
    return false;
  }
  return implementation.corridors.some((corridor) => {
    if (
      query.fromCountry !== undefined &&
      (corridor.fromCountries === undefined ||
        !corridor.fromCountries.includes(query.fromCountry))
    ) {
      return false;
    }
    if (
      query.toCountry !== undefined &&
      (corridor.toCountries === undefined ||
        !corridor.toCountries.includes(query.toCountry))
    ) {
      return false;
    }
    if (
      query.currency !== undefined &&
      (corridor.currencies === undefined ||
        !corridor.currencies.includes(query.currency))
    ) {
      return false;
    }
    return true;
  });
}

/**
 * Provider/corridor registry: registers providers and their implementations
 * and answers provider- and corridor-scoped queries. Chain completeness
 * (definition → implementation → instance → observation) is enforced by the
 * generalized Connector registry (./registry.js), which composes this store.
 */
export class ProviderRegistry {
  private readonly providers = new Map<string, ProviderIdentity>();
  private readonly implementations = new Map<string, ProviderImplementation>();

  /** Registers (or re-registers) a provider identity keyed name@version. */
  registerProvider(provider: ProviderIdentity): ProviderIdentity {
    const validated = validateProviderIdentity(provider);
    this.providers.set(providerKey(validated), validated);
    return validated;
  }

  /** Registers a provider implementation (provider must be registered). */
  registerImplementation(
    implementation: ProviderImplementation,
  ): ProviderImplementation {
    const validated = validateProviderImplementation(implementation);
    if (!this.providers.has(providerKey(validated))) {
      throw new ValidationError(
        `implementation '${validated.implementationId}' references provider '${validated.providerName}@${validated.providerVersion}', which is not registered (register the provider first)`,
      );
    }
    if (this.implementations.has(validated.implementationId)) {
      throw new ValidationError(
        `implementation '${validated.implementationId}' is already registered`,
      );
    }
    this.implementations.set(validated.implementationId, validated);
    return validated;
  }

  hasProvider(providerName: string, providerVersion: string): boolean {
    return this.providers.has(`${providerName}@${providerVersion}`);
  }

  provider(providerName: string, providerVersion: string): ProviderIdentity | undefined {
    return this.providers.get(`${providerName}@${providerVersion}`);
  }

  allProviders(): readonly ProviderIdentity[] {
    return [...this.providers.values()];
  }

  implementation(
    implementationId: string,
  ): ProviderImplementation | undefined {
    return this.implementations.get(implementationId);
  }

  allImplementations(): readonly ProviderImplementation[] {
    return [...this.implementations.values()];
  }

  implementationsForDefinition(
    capabilityId: string,
  ): readonly ProviderImplementation[] {
    return this.allImplementations().filter(
      (implementation) => implementation.capabilityId === capabilityId,
    );
  }

  implementationsForProvider(
    providerName: string,
  ): readonly ProviderImplementation[] {
    return this.allImplementations().filter(
      (implementation) => implementation.providerName === providerName,
    );
  }

  /** Implementations declaring service for a corridor (deterministic order). */
  implementationsServingCorridor(
    query: CorridorQuery,
  ): readonly ProviderImplementation[] {
    return this.allImplementations().filter((implementation) =>
      servesCorridor(implementation, query),
    );
  }
}

function providerKey(provider: {
  readonly providerName: string;
  readonly providerVersion: string;
}): string {
  return `${provider.providerName}@${provider.providerVersion}`;
}

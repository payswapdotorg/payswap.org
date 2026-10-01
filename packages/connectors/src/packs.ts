/**
 * Hierarchical Connector Capability Packs (W2-003; FROZEN-ARCHITECTURE §2A;
 * ADR-006; CONNECTOR-PLATFORM).
 *
 * Provider packs are TREES, not monoliths: a PSP may expose payments,
 * billing, risk, connect/marketplace, payouts, tax, issuing, financial
 * accounts, crypto and provider-native optimization as INDEPENDENTLY
 * versioned/certified sub-packs. Each node declares auth, schemas, object
 * mappings, source-of-truth policy, rate limits, provenance and evidence;
 * sub-packs map ONLY to capabilities actually exposed by
 * ConnectedCapabilityInstances (enforced by the registry at registration —
 * ./registry.js).
 */

import { ValidationError } from "@payswap/protocol";

/** Pack families for large (typically PSP) providers (§2A). */
export const CONNECTOR_PACK_FAMILIES = [
  "payments",
  "billing",
  "risk",
  "connect_marketplace",
  "payouts",
  "tax",
  "issuing",
  "financial_accounts",
  "crypto",
  "native_optimization",
] as const;

export type ConnectorPackFamily = (typeof CONNECTOR_PACK_FAMILIES)[number];

export function isConnectorPackFamily(
  value: unknown,
): value is ConnectorPackFamily {
  return (
    typeof value === "string" &&
    (CONNECTOR_PACK_FAMILIES as readonly unknown[]).includes(value)
  );
}

/** Source-of-truth policies for external object mappings (CONNECTOR-PLATFORM). */
export const SOURCE_OF_TRUTH_POLICIES = [
  "EXTERNAL_AUTHORITATIVE",
  "PAYSWAP_AUTHORITATIVE",
  "SHARED_WITH_VERSIONED_CONFLICT_RULE",
  "DERIVED_PROJECTION",
] as const;

export type SourceOfTruthPolicy = (typeof SOURCE_OF_TRUTH_POLICIES)[number];

export function isSourceOfTruthPolicy(
  value: unknown,
): value is SourceOfTruthPolicy {
  return (
    typeof value === "string" &&
    (SOURCE_OF_TRUTH_POLICIES as readonly unknown[]).includes(value)
  );
}

/** Authentication/credential requirements declared by a pack node. */
export interface PackAuthDeclaration {
  readonly authKind:
    | "API_KEY"
    | "OAUTH"
    | "DELEGATED"
    | "SESSION"
    | "PROVIDER_DEFINED";
  readonly scopes: readonly string[];
  readonly rotationPolicyRef?: string;
}

/** Reference to a data schema used by the pack. */
export interface PackSchemaRef {
  readonly schemaId: string;
  readonly version: string;
}

/**
 * One external object mapping. Every mapping declares its source-of-truth
 * policy; conflicting writes never silently overwrite one another.
 */
export interface PackObjectMapping {
  readonly externalObjectType: string;
  readonly canonicalObjectRef: string;
  readonly sourceOfTruth: SourceOfTruthPolicy;
  /** Required for SHARED_WITH_VERSIONED_CONFLICT_RULE mappings. */
  readonly conflictRuleRef?: string;
}

/** One declared rate limit/quota. */
export interface PackRateLimit {
  readonly limit: number;
  readonly windowSeconds: number;
  readonly scope: string;
}

/** Pack provenance: publisher, publication time and content hash. */
export interface PackProvenance {
  readonly publisher: string;
  readonly publishedAt: string;
  readonly contentHash: string;
}

/** Evidence reference backing a pack's certification claims. */
export interface PackEvidenceRef {
  readonly evidenceId: string;
  readonly artifactRef: string;
}

/** A capability a pack node maps to (must be exposed by a connected instance). */
export interface PackCapabilityRef {
  readonly capabilityId: string;
  readonly capabilityVersion: string;
}

/**
 * One node of a hierarchical Connector Capability Pack. Sub-packs are
 * independently versioned and certified: a parent's version never pins a
 * child's, and certification attaches at any node (subject kinds in
 * @payswap/capabilities certification).
 */
export interface ConnectorCapabilityPack {
  readonly packId: string;
  readonly family: ConnectorPackFamily;
  readonly version: string;
  readonly subPacks: readonly ConnectorCapabilityPack[];
  readonly capabilityRefs: readonly PackCapabilityRef[];
  readonly auth: PackAuthDeclaration;
  readonly schemas: readonly PackSchemaRef[];
  readonly objectMappings: readonly PackObjectMapping[];
  /** Pack-level default; object mappings may override per object. */
  readonly sourceOfTruth: SourceOfTruthPolicy;
  readonly rateLimits: readonly PackRateLimit[];
  readonly provenance: PackProvenance;
  readonly evidence: readonly PackEvidenceRef[];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => isNonEmptyString(item));
}

function validatePackNode(
  pack: unknown,
  packIds: Set<string>,
  errors: string[],
): void {
  if (pack === null || typeof pack !== "object") {
    errors.push("pack node must be an object");
    return;
  }
  const record = pack as Readonly<Record<string, unknown>>;
  if (!isNonEmptyString(record.packId)) {
    errors.push("packId must be a non-empty string");
  } else if (packIds.has(record.packId)) {
    errors.push(
      `duplicate packId '${record.packId}' in the pack tree (each node is a distinct, independently versioned unit)`,
    );
  } else {
    packIds.add(record.packId);
  }
  if (!isConnectorPackFamily(record.family)) {
    errors.push(
      `family must be one of [${CONNECTOR_PACK_FAMILIES.join(", ")}]`,
    );
  }
  if (!isNonEmptyString(record.version)) {
    errors.push("version must be a non-empty string (independently versioned node)");
  }
  if (!Array.isArray(record.subPacks)) {
    errors.push("subPacks must be an array (may be empty)");
  }
  if (!Array.isArray(record.capabilityRefs)) {
    errors.push("capabilityRefs must be an array (may be empty)");
  } else {
    for (const [index, ref] of record.capabilityRefs.entries()) {
      const entry = ref as Readonly<Record<string, unknown>> | null;
      if (
        entry === null ||
        typeof entry !== "object" ||
        !isNonEmptyString(entry.capabilityId) ||
        !isNonEmptyString(entry.capabilityVersion)
      ) {
        errors.push(`capabilityRefs[${index}] must be { capabilityId, capabilityVersion }`);
      }
    }
  }
  const auth = record.auth as Readonly<Record<string, unknown>> | undefined;
  if (
    auth === undefined ||
    typeof auth !== "object" ||
    !["API_KEY", "OAUTH", "DELEGATED", "SESSION", "PROVIDER_DEFINED"].includes(
      String(auth.authKind),
    ) ||
    !isStringArray(auth.scopes)
  ) {
    errors.push("auth must be { authKind, scopes, rotationPolicyRef? }");
  }
  if (!Array.isArray(record.schemas)) {
    errors.push("schemas must be an array of PackSchemaRef");
  } else {
    for (const [index, schema] of record.schemas.entries()) {
      const entry = schema as Readonly<Record<string, unknown>> | null;
      if (
        entry === null ||
        typeof entry !== "object" ||
        !isNonEmptyString(entry.schemaId) ||
        !isNonEmptyString(entry.version)
      ) {
        errors.push(`schemas[${index}] must be { schemaId, version }`);
      }
    }
  }
  if (!Array.isArray(record.objectMappings)) {
    errors.push("objectMappings must be an array");
  } else {
    for (const [index, mapping] of record.objectMappings.entries()) {
      const entry = mapping as Readonly<Record<string, unknown>> | null;
      if (
        entry === null ||
        typeof entry !== "object" ||
        !isNonEmptyString(entry.externalObjectType) ||
        !isNonEmptyString(entry.canonicalObjectRef) ||
        !isSourceOfTruthPolicy(entry.sourceOfTruth)
      ) {
        errors.push(
          `objectMappings[${index}] must declare externalObjectType, canonicalObjectRef and a sourceOfTruth policy`,
        );
      } else if (
        entry.sourceOfTruth === "SHARED_WITH_VERSIONED_CONFLICT_RULE" &&
        !isNonEmptyString(entry.conflictRuleRef)
      ) {
        errors.push(
          `objectMappings[${index}].conflictRuleRef is required for SHARED_WITH_VERSIONED_CONFLICT_RULE mappings`,
        );
      }
    }
  }
  if (!isSourceOfTruthPolicy(record.sourceOfTruth)) {
    errors.push(
      `sourceOfTruth must be one of [${SOURCE_OF_TRUTH_POLICIES.join(", ")}]`,
    );
  }
  if (!Array.isArray(record.rateLimits)) {
    errors.push("rateLimits must be an array (may be empty)");
  } else {
    for (const [index, limit] of record.rateLimits.entries()) {
      const entry = limit as Readonly<Record<string, unknown>> | null;
      if (
        entry === null ||
        typeof entry !== "object" ||
        typeof entry.limit !== "number" ||
        !Number.isInteger(entry.limit) ||
        entry.limit < 1 ||
        typeof entry.windowSeconds !== "number" ||
        !Number.isInteger(entry.windowSeconds) ||
        entry.windowSeconds < 1 ||
        !isNonEmptyString(entry.scope)
      ) {
        errors.push(`rateLimits[${index}] must be { limit, windowSeconds, scope }`);
      }
    }
  }
  const provenance = record.provenance as
    | Readonly<Record<string, unknown>>
    | undefined;
  if (
    provenance === undefined ||
    typeof provenance !== "object" ||
    !isNonEmptyString(provenance.publisher) ||
    !isNonEmptyString(provenance.publishedAt) ||
    !isNonEmptyString(provenance.contentHash)
  ) {
    errors.push("provenance must be { publisher, publishedAt, contentHash }");
  }
  if (!Array.isArray(record.evidence)) {
    errors.push("evidence must be an array of PackEvidenceRef");
  } else {
    for (const [index, evidence] of record.evidence.entries()) {
      const entry = evidence as Readonly<Record<string, unknown>> | null;
      if (
        entry === null ||
        typeof entry !== "object" ||
        !isNonEmptyString(entry.evidenceId) ||
        !isNonEmptyString(entry.artifactRef)
      ) {
        errors.push(`evidence[${index}] must be { evidenceId, artifactRef }`);
      }
    }
  }
  // A node must either expose capabilities itself or through sub-packs.
  const subPacks = record.subPacks;
  const capabilityRefs = record.capabilityRefs;
  if (
    Array.isArray(subPacks) &&
    Array.isArray(capabilityRefs) &&
    subPacks.length === 0 &&
    capabilityRefs.length === 0
  ) {
    errors.push(
      "a pack node must declare capabilityRefs and/or subPacks (an empty leaf exposes nothing)",
    );
  }
  if (Array.isArray(subPacks)) {
    for (const sub of subPacks) {
      validatePackNode(sub, packIds, errors);
    }
  }
}

/**
 * Structural validation for a pack tree: validates every node, rejects
 * duplicate packIds across the tree, and requires every mapping to declare
 * a source-of-truth policy.
 */
export function validateConnectorCapabilityPack(
  pack: unknown,
): ConnectorCapabilityPack {
  const errors: string[] = [];
  validatePackNode(pack, new Set<string>(), errors);
  if (errors.length > 0) {
    throw new ValidationError(
      `Invalid connector capability pack: ${errors.join("; ")}`,
      { errors: [...errors] },
    );
  }
  return pack as ConnectorCapabilityPack;
}

/** Flattens a pack tree's capability refs in tree order (parent first). */
export function flattenPackCapabilityRefs(
  pack: ConnectorCapabilityPack,
): readonly PackCapabilityRef[] {
  const refs: PackCapabilityRef[] = [...pack.capabilityRefs];
  for (const sub of pack.subPacks) {
    refs.push(...flattenPackCapabilityRefs(sub));
  }
  return refs;
}

/** Finds a sub-pack node by packId (depth-first; returns undefined if absent). */
export function findSubPack(
  pack: ConnectorCapabilityPack,
  packId: string,
): ConnectorCapabilityPack | undefined {
  for (const sub of pack.subPacks) {
    if (sub.packId === packId) {
      return sub;
    }
    const nested = findSubPack(sub, packId);
    if (nested !== undefined) {
      return nested;
    }
  }
  return undefined;
}

/**
 * ProviderStateEnvelope — lossless provider-state preservation (W2-003;
 * FROZEN-ARCHITECTURE §2A; ADR-006; INV-C06; AGENTS.md rule 19).
 *
 * Canonical state controls protocol truth; this envelope preserves the
 * provider semantics needed for customer action, reconciliation, support,
 * audit and reprocessing WITHOUT lossy canonical mapping. The raw
 * provider-native `state` is carried VERBATIM (opaque passthrough); the
 * `classification` is ADDITIVE metadata (family + lifecycle step), never a
 * replacement for the raw state.
 *
 * Consequential provider state families that MUST round-trip losslessly
 * (LOSSLESS-CONNECTOR-CAPABILITY-MODEL §2 examples): customer
 * authentication/action required, asynchronous processing, capture,
 * mandate lifecycle, refund lifecycle, dispute evidence, payout state and
 * connected-account state.
 *
 * Overlapping Stage-0 boundary shapes (provider, object, revision, history,
 * actionRequired, failure, timestamps, provenance) are consumed as-is; this
 * package is the canonical owner of the full vocabulary.
 */

import { ValidationError } from "@payswap/protocol";

// ---------------------------------------------------------------------------
// Consumed Stage-0 shapes
// ---------------------------------------------------------------------------

export interface ProviderStateTransition {
  readonly fromRevision?: string;
  readonly toRevision: string;
  readonly occurredAt: string;
  readonly actor?: string;
  readonly note?: string;
}

/** A provider-required user action preserved verbatim (e.g. a 3DS challenge). */
export interface ProviderActionRequired {
  readonly kind: string;
  readonly message: string;
  readonly deepLink?: string;
}

/** Provider failure metadata, including outcome-ambiguity classification. */
export interface ProviderFailureMetadata {
  readonly providerErrorCode?: string;
  readonly providerErrorMessage?: string;
  readonly retryable: boolean;
  /** OUTCOME_UNKNOWN feeds EXTERNAL_AMBIGUITY handling; never a plain failure (INV-X01/INV-X02). */
  readonly ambiguity: "NONE" | "OUTCOME_UNKNOWN";
}

// ---------------------------------------------------------------------------
// Canonical classification (additive, never reductive)
// ---------------------------------------------------------------------------

/**
 * Consequential provider-state families (INV-C06). `other` keeps the
 * envelope total: provider states outside the eight named families are
 * still preserved verbatim.
 */
export const PROVIDER_STATE_FAMILIES = [
  "customer_action_required",
  "async_processing",
  "capture",
  "mandate",
  "refund",
  "dispute",
  "payout",
  "connected_account",
  "other",
] as const;

export type ProviderStateFamily = (typeof PROVIDER_STATE_FAMILIES)[number];

export function isProviderStateFamily(
  value: unknown,
): value is ProviderStateFamily {
  return (
    typeof value === "string" &&
    (PROVIDER_STATE_FAMILIES as readonly unknown[]).includes(value)
  );
}

/**
 * Additive classification of the raw provider state. The family and
 * lifecycle step CARRY meaning; they never replace `state`.
 */
export interface ProviderStateClassification {
  readonly family: ProviderStateFamily;
  /** Provider-declared step within the family (e.g. 'evidence_required'). */
  readonly lifecycleStep: string;
  readonly isTerminal: boolean;
  readonly requiresCustomerAction: boolean;
}

// ---------------------------------------------------------------------------
// Privacy-scoped constraints/metadata
// ---------------------------------------------------------------------------

export type PrivacyDataClassification = "PUBLIC" | "PARTNER" | "PRIVATE";

/**
 * Privacy-scoped constraints on the envelope's provider-specific payload
 * (LOSSLESS-CONNECTOR-CAPABILITY-MODEL §2: "provider-specific
 * constraints/metadata subject to privacy policy").
 */
export interface PrivacyScopeDeclaration {
  readonly dataClassification: PrivacyDataClassification;
  /** Hard sharing constraints, e.g. 'no-PII-in-support-tickets'. */
  readonly constraints: readonly string[];
  /** Fields of the raw state that may be shared at the declared classification. */
  readonly shareableFields: readonly string[];
}

// ---------------------------------------------------------------------------
// The envelope
// ---------------------------------------------------------------------------

/**
 * ProviderStateEnvelope (§2A; INV-C06).
 *
 * `state` is the raw provider-native state, preserved VERBATIM; consumers
 * may read it for customer action, reconciliation, support, audit and
 * reprocessing, but must never flatten, overwrite or erase provider
 * lifecycle semantics. `metadata` is privacy-scoped opaque provider
 * metadata.
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
  readonly classification: ProviderStateClassification;
  readonly history: readonly ProviderStateTransition[];
  readonly actionRequired?: ProviderActionRequired;
  readonly failure?: ProviderFailureMetadata;
  readonly privacy: PrivacyScopeDeclaration;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly timestamps: {
    readonly observedAt: string;
    readonly updatedAt?: string;
  };
  readonly provenance: {
    readonly source: "PROVIDER_API" | "PROVIDER_WEBHOOK" | "OPERATOR";
    readonly fetchId?: string;
  };
}

// ---------------------------------------------------------------------------
// Construction + validation
// ---------------------------------------------------------------------------

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Input accepted by `createProviderStateEnvelope`. `classification` and
 * `privacy` are optional HERE only so that their ABSENCE can be rejected
 * by runtime validation (INV-C06) — the constructed envelope always
 * carries both.
 */
export type ProviderStateEnvelopeInput = Omit<
  ProviderStateEnvelope,
  "classification" | "privacy"
> & {
  readonly classification?: ProviderStateClassification;
  readonly privacy?: PrivacyScopeDeclaration;
};

/**
 * Validates and freezes a provider state envelope. INV-C06: the raw
 * provider state passes through untouched; classification and privacy scope
 * are mandatory (absence is a validation error) so the envelope is
 * queryable and privacy-bounded without ever being lossy.
 */
export function createProviderStateEnvelope(
  input: ProviderStateEnvelopeInput,
): ProviderStateEnvelope {
  const errors: string[] = [];
  if (input === null || typeof input !== "object") {
    throw new ValidationError("provider state envelope must be an object");
  }
  const record = input as unknown as Readonly<Record<string, unknown>>;
  const provider = record.provider as Readonly<Record<string, unknown>> | undefined;
  if (
    provider === undefined ||
    !isNonEmptyString(provider.name) ||
    !isNonEmptyString(provider.version)
  ) {
    errors.push("provider.name and provider.version must be non-empty strings");
  }
  const object = record.object as Readonly<Record<string, unknown>> | undefined;
  if (
    object === undefined ||
    !isNonEmptyString(object.objectType) ||
    !isNonEmptyString(object.externalId)
  ) {
    errors.push("object.objectType and object.externalId must be non-empty strings");
  }
  if (!isNonEmptyString(record.revision)) {
    errors.push("revision must be a non-empty string");
  }
  if (!("state" in record)) {
    errors.push("state must be present (raw provider state, preserved verbatim)");
  }
  const classification = record.classification as
    | Readonly<Record<string, unknown>>
    | undefined;
  if (classification === undefined || typeof classification !== "object") {
    errors.push("classification must be a ProviderStateClassification");
  } else {
    if (!isProviderStateFamily(classification.family)) {
      errors.push(
        `classification.family must be one of [${PROVIDER_STATE_FAMILIES.join(", ")}]`,
      );
    }
    if (!isNonEmptyString(classification.lifecycleStep)) {
      errors.push("classification.lifecycleStep must be a non-empty string");
    }
    if (typeof classification.isTerminal !== "boolean") {
      errors.push("classification.isTerminal must be a boolean");
    }
    if (typeof classification.requiresCustomerAction !== "boolean") {
      errors.push("classification.requiresCustomerAction must be a boolean");
    }
  }
  if (!Array.isArray(record.history)) {
    errors.push("history must be an array of ProviderStateTransition (may be empty)");
  }
  const privacy = record.privacy as Readonly<Record<string, unknown>> | undefined;
  if (privacy === undefined || typeof privacy !== "object") {
    errors.push("privacy must be a PrivacyScopeDeclaration");
  } else {
    if (
      privacy.dataClassification !== "PUBLIC" &&
      privacy.dataClassification !== "PARTNER" &&
      privacy.dataClassification !== "PRIVATE"
    ) {
      errors.push("privacy.dataClassification must be PUBLIC, PARTNER or PRIVATE");
    }
    if (!Array.isArray(privacy.constraints)) {
      errors.push("privacy.constraints must be an array");
    }
    if (!Array.isArray(privacy.shareableFields)) {
      errors.push("privacy.shareableFields must be an array");
    }
  }
  const timestamps = record.timestamps as
    | Readonly<Record<string, unknown>>
    | undefined;
  if (
    timestamps === undefined ||
    !isNonEmptyString(timestamps.observedAt)
  ) {
    errors.push("timestamps.observedAt must be a non-empty string");
  }
  const provenance = record.provenance as
    | Readonly<Record<string, unknown>>
    | undefined;
  if (
    provenance === undefined ||
    (provenance.source !== "PROVIDER_API" &&
      provenance.source !== "PROVIDER_WEBHOOK" &&
      provenance.source !== "OPERATOR")
  ) {
    errors.push("provenance.source must be PROVIDER_API, PROVIDER_WEBHOOK or OPERATOR");
  }
  const actionRequired = record.actionRequired as
    | Readonly<Record<string, unknown>>
    | undefined;
  if (
    actionRequired !== undefined &&
    (typeof actionRequired !== "object" ||
      !isNonEmptyString(actionRequired.kind) ||
      !isNonEmptyString(actionRequired.message))
  ) {
    errors.push("actionRequired, when present, must be { kind, message, deepLink? }");
  }
  const failure = record.failure as Readonly<Record<string, unknown>> | undefined;
  if (
    failure !== undefined &&
    (typeof failure !== "object" || typeof failure.retryable !== "boolean")
  ) {
    errors.push("failure, when present, must declare retryable: boolean");
  }

  if (errors.length > 0) {
    throw new ValidationError(
      `Invalid provider state envelope: ${errors.join("; ")}`,
      { errors: [...errors] },
    );
  }

  const envelope = input as ProviderStateEnvelope;
  return Object.freeze({
    ...envelope,
    classification: Object.freeze({ ...envelope.classification }),
    privacy: Object.freeze({ ...envelope.privacy }),
    history: Object.freeze([...envelope.history]),
    timestamps: Object.freeze({ ...envelope.timestamps }),
    provenance: Object.freeze({ ...envelope.provenance }),
  });
}

/** Structural guard for envelopes from untyped sources. */
export function isProviderStateEnvelope(
  value: unknown,
): value is ProviderStateEnvelope {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<ProviderStateEnvelope>;
  return (
    typeof candidate.revision === "string" &&
    candidate.revision !== "" &&
    candidate.classification !== undefined &&
    isProviderStateFamily(candidate.classification.family) &&
    candidate.privacy !== undefined &&
    candidate.privacy !== null &&
    candidate.timestamps !== undefined &&
    candidate.timestamps !== null &&
    candidate.provenance !== undefined &&
    candidate.provenance !== null
  );
}

// ---------------------------------------------------------------------------
// Lossless JSON codec (INV-C06 round-trip)
// ---------------------------------------------------------------------------

/**
 * Serializes an envelope to canonical JSON. The raw provider state must be
 * JSON-representable — anything the provider reports over a wire is.
 */
export function serializeProviderStateEnvelope(
  envelope: ProviderStateEnvelope,
): string {
  return JSON.stringify(envelope);
}

/**
 * Parses and validates a serialized envelope. Round-tripping through
 * serialize → parse is LOSSLESS: family, raw state, history, action
 * required, failure metadata, privacy scope and provenance all survive.
 */
export function parseProviderStateEnvelope(
  json: string,
): ProviderStateEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new ValidationError(
      "provider state envelope JSON is malformed",
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
  if (!isProviderStateEnvelope(parsed)) {
    throw new ValidationError(
      "parsed JSON is not a ProviderStateEnvelope",
    );
  }
  return createProviderStateEnvelope(parsed);
}

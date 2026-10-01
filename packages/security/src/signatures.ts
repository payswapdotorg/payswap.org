/**
 * Threat signatures (W2-005; FROZEN-ARCHITECTURE §17; SECURITY-EVIDENCE-
 * RECOURSE.md "Security immune system").
 *
 * A threat signature is a MATCHABLE pattern scoped to vulnerable component
 * identities (package / agent / extension / capability / connected instance)
 * plus affected-version ranges, with mandatory provenance. Signatures are the
 * detection vocabulary of the immune system: advisories (./advisories.js) and
 * capability cases (./capability-cases.js) consume them as evidence for
 * restriction, quarantine and learning decisions.
 *
 * This module also owns the package-wide component identity model and the
 * deterministic content digest used to content-address every immune-system
 * artifact. The digest follows the same deliberately-local pattern as the
 * agents and lab packages (the protocol kernel exports no content-
 * addressing primitive at this stage): it detects structural change, it is
 * NOT a cryptographic defense.
 *
 * Deterministic only: no ambient clock, no randomness; every function is a
 * pure function of its inputs.
 */

import { ValidationError } from "@payswap/protocol";

// ---------------------------------------------------------------------------
// Component identity model (consumed from capabilities / agents / connectors)
// ---------------------------------------------------------------------------

/**
 * The component kinds that can carry a vulnerability or be restricted by the
 * immune system. The identity strings mirror the canonical identity fields of
 * the owning packages:
 * - agent_package  → AgentPackage.id            (@payswap/agents);
 * - agent_body     → AgentBody.id               (@payswap/agents);
 * - agent_instance → AgentInstance.id           (@payswap/agents);
 * - agent_key      → AgentPrincipalRef.agentKeyFingerprint (@payswap/agents);
 * - extension      → ExtensionManifest.id       (@payswap/capabilities);
 * - capability     → Capability.id              (@payswap/capabilities);
 * - connected_instance → ConnectedCapabilityInstance.instanceId
 *                                                        (@payswap/connectors).
 */
export const COMPONENT_KINDS = [
  "agent_package",
  "agent_body",
  "agent_instance",
  "agent_key",
  "extension",
  "capability",
  "connected_instance",
] as const;

export type ComponentKind = (typeof COMPONENT_KINDS)[number];

export function isComponentKind(value: unknown): value is ComponentKind {
  return (
    typeof value === "string" &&
    (COMPONENT_KINDS as readonly unknown[]).includes(value)
  );
}

/** Identity of one component the immune system can match or restrict. */
export interface ComponentIdentity {
  readonly kind: ComponentKind;
  readonly id: string;
  /** Component version when known (numeric dotted, e.g. "1.2.0"). */
  readonly version?: string;
}

/** Kind + id pair; the minimal unversioned identity used by quarantine. */
export interface ComponentRef {
  readonly kind: ComponentKind;
  readonly id: string;
}

/** Identity without the version axis. */
export function componentRef(identity: ComponentIdentity): ComponentRef {
  return { kind: identity.kind, id: identity.id };
}

/** Deterministic canonical string form of a component identity. */
export function componentKey(ref: ComponentRef): string {
  return `${ref.kind}:${ref.id}`;
}

// ---------------------------------------------------------------------------
// Deterministic version comparison (numeric dotted subset of semver)
// ---------------------------------------------------------------------------

/**
 * Inclusive version range. Both bounds are optional; an absent bound is
 * unbounded on that side. Versions are numeric dotted strings ("1.2.0").
 */
export interface VersionRange {
  /** Inclusive lower bound. */
  readonly minVersion?: string;
  /** Inclusive upper bound. */
  readonly maxVersion?: string;
}

const VERSION_PATTERN = /^\d+(\.\d+)*$/;

/** Parse/validate one numeric dotted version string. */
function parseVersion(version: string): readonly number[] {
  if (!VERSION_PATTERN.test(version)) {
    throw new ValidationError(
      `invalid version '${version}': must be numeric dotted segments (e.g. 1.2.0)`,
    );
  }
  return version.split(".").map((part) => Number.parseInt(part, 10));
}

/**
 * Total deterministic order over numeric dotted versions. Missing segments
 * compare as zero ("1.2" === "1.2.0"). Not locale-aware, no allocation beyond
 * the parsed segments.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const left = parseVersion(a);
  const right = parseVersion(b);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const l = left[index] ?? 0;
    const r = right[index] ?? 0;
    if (l !== r) {
      return l < r ? -1 : 1;
    }
  }
  return 0;
}

/**
 * True iff `version` falls inside the inclusive range. An undefined bound is
 * unbounded; an entirely undefined range matches every version.
 */
export function versionInRange(version: string, range: VersionRange): boolean {
  if (range.minVersion !== undefined) {
    if (compareVersions(version, range.minVersion) < 0) {
      return false;
    }
  }
  if (range.maxVersion !== undefined) {
    if (compareVersions(version, range.maxVersion) > 0) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Deterministic canonical serialization + content digest (package-local)
// ---------------------------------------------------------------------------

/** Deterministic canonical serialization (sorted keys, bigint-safe). */
export function canonicalString(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null) {
    return "null";
  }
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      return `n:${value.toString()}`;
    case "bigint":
      return `b:${value.toString()}`;
    case "boolean":
      return value ? "true" : "false";
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((item) => serialize(item)).join(",")}]`;
      }
      const record = value as Readonly<Record<string, unknown>>;
      const keys = Object.keys(record).sort();
      const parts: string[] = [];
      for (const key of keys) {
        parts.push(`${JSON.stringify(key)}:${serialize(record[key])}`);
      }
      return `{${parts.join(",")}}`;
    }
    default:
      throw new Error(
        `canonicalString: unsupported value of type '${typeof value}'`,
      );
  }
}

/**
 * FNV-1a 64-bit digest of the canonical serialization, as lowercase hex.
 * Content-addressing for immune-system artifacts (signatures, advisories,
 * quarantine records, capability cases, expert resolutions) — same discipline
 * as the Lab's versioned artifacts. NOT cryptographic.
 */
export function contentDigest(value: unknown): string {
  const input = serialize(value);
  const prime = 0x100000001b3n;
  const offset = 0xcbf29ce484222325n;
  let hash = offset;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= BigInt(input.charCodeAt(i) & 0xff);
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}

// ---------------------------------------------------------------------------
// Threat signatures
// ---------------------------------------------------------------------------

/** What the signature detects. */
export type ThreatSignatureKind =
  | "vulnerable_package"
  | "vulnerable_extension"
  | "malicious_behavior"
  | "abuse_pattern"
  | "credential_compromise";

/**
 * One matchable indicator. Kinds:
 * - action_pattern: an exact action id or a `prefix.*` wildcard (prefix
 *   match, same semantics as the trust action patterns);
 * - token_family:   a typed protocol token family (§24) the component
 *   emits or consumes suspiciously;
 * - signal_class:   a security signal class (e.g. "beneficiary_change").
 */
export interface ThreatIndicator {
  readonly indicatorId: string;
  readonly kind: "action_pattern" | "token_family" | "signal_class";
  readonly pattern: string;
}

/** True iff an action pattern (exact or `prefix.*`) matches an action id. */
export function matchesActionPattern(pattern: string, action: string): boolean {
  if (pattern.length === 0) {
    return false;
  }
  if (pattern === "*") {
    return true;
  }
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -2);
    return action.startsWith(`${prefix}.`);
  }
  return pattern === action;
}

/** The component scope a signature matches against. */
export interface AffectedComponentScope {
  readonly kind: ComponentKind;
  readonly id: string;
  readonly versionRange?: VersionRange;
}

/** Mandatory provenance for every registered signature (AGENTS.md). */
export interface SignatureProvenance {
  readonly source: string;
  readonly contentHash: string;
  readonly publishedAt: number;
}

/** A registered threat signature: immutable once registered. */
export interface ThreatSignature {
  readonly signatureId: string;
  readonly kind: ThreatSignatureKind;
  readonly title: string;
  readonly description: string;
  readonly affected: AffectedComponentScope;
  readonly indicators: readonly ThreatIndicator[];
  readonly provenance: SignatureProvenance;
}

/** An observation to match signatures against (deterministic input). */
export interface ComponentObservation {
  readonly component: ComponentIdentity;
  /** Observed action id, when the observation is behavioral. */
  readonly action?: string;
  /** Observed emitted/consumed typed token family (§24). */
  readonly tokenFamily?: string;
  /** Observed security signal class (SECURITY-EVIDENCE-RECOURSE signals). */
  readonly signalClass?: string;
}

/** Raised for invalid signature registration or matching input. */
export class ThreatSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThreatSignatureError";
  }
}

/**
 * True iff the signature's component scope covers the identity (kind + id +
 * version in range). When the identity carries no version, an unscoped
 * (range-less) signature still matches; a signature with an explicit range
 * requires a KNOWN version in range to match (detection is evidence-
 * generating: an unknown version produces no match, never a guess — contrast
 * the fail-closed restriction semantics in ./advisories.js).
 */
export function signatureMatchesIdentity(
  signature: ThreatSignature,
  identity: ComponentIdentity,
): boolean {
  if (signature.affected.kind !== identity.kind) {
    return false;
  }
  if (signature.affected.id !== identity.id) {
    return false;
  }
  const range = signature.affected.versionRange;
  if (range === undefined) {
    return true;
  }
  if (range.minVersion === undefined && range.maxVersion === undefined) {
    return true;
  }
  if (identity.version === undefined) {
    return false;
  }
  return versionInRange(identity.version, range);
}

/**
 * True iff the signature matches the observation: the component scope covers
 * the observed identity AND at least one indicator matches the observed
 * action / token family / signal class. A signature without indicators never
 * matches an observation (it is identity-scoped intelligence, not a live
 * detector).
 */
export function signatureMatchesObservation(
  signature: ThreatSignature,
  observation: ComponentObservation,
): boolean {
  if (!signatureMatchesIdentity(signature, observation.component)) {
    return false;
  }
  if (signature.indicators.length === 0) {
    return false;
  }
  for (const indicator of signature.indicators) {
    switch (indicator.kind) {
      case "action_pattern":
        if (
          observation.action !== undefined &&
          matchesActionPattern(indicator.pattern, observation.action)
        ) {
          return true;
        }
        break;
      case "token_family":
        if (
          observation.tokenFamily !== undefined &&
          indicator.pattern === observation.tokenFamily
        ) {
          return true;
        }
        break;
      case "signal_class":
        if (
          observation.signalClass !== undefined &&
          indicator.pattern === observation.signalClass
        ) {
          return true;
        }
        break;
    }
  }
  return false;
}

/** Input accepted by the registry; provenance contentHash is computed. */
export interface RegisterThreatSignatureInput {
  readonly signatureId: string;
  readonly kind: ThreatSignatureKind;
  readonly title: string;
  readonly description: string;
  readonly affected: AffectedComponentScope;
  readonly indicators?: readonly ThreatIndicator[];
  readonly declaredBy: string;
  readonly publishedAt: number;
}

function validateIndicator(indicator: ThreatIndicator): void {
  if (indicator.indicatorId.length === 0) {
    throw new ThreatSignatureError("indicator id must not be empty");
  }
  if (indicator.pattern.length === 0) {
    throw new ThreatSignatureError(
      `indicator '${indicator.indicatorId}' pattern must not be empty`,
    );
  }
}

/**
 * The threat signature registry: append-only, deterministic (registration
 * order), every entry content-addressed with provenance (AGENTS.md: record
 * provenance for external specifications used).
 */
export class ThreatSignatureRegistry {
  private readonly signaturesById = new Map<string, ThreatSignature>();
  private readonly order: string[] = [];

  /** Registers a signature; the registry computes the provenance contentHash. */
  register(input: RegisterThreatSignatureInput): ThreatSignature {
    if (input.signatureId.length === 0) {
      throw new ThreatSignatureError("signatureId must not be empty");
    }
    if (input.title.length === 0) {
      throw new ThreatSignatureError("title must not be empty");
    }
    if (input.declaredBy.length === 0) {
      throw new ThreatSignatureError("declaredBy must not be empty");
    }
    if (!isComponentKind(input.affected.kind)) {
      throw new ThreatSignatureError(
        `unknown affected component kind '${String(input.affected.kind)}'`,
      );
    }
    if (input.affected.id.length === 0) {
      throw new ThreatSignatureError("affected component id must not be empty");
    }
    const range = input.affected.versionRange;
    if (range !== undefined) {
      if (range.minVersion !== undefined) {
        parseVersion(range.minVersion);
      }
      if (range.maxVersion !== undefined) {
        parseVersion(range.maxVersion);
      }
    }
    const indicators = input.indicators ?? [];
    for (const indicator of indicators) {
      validateIndicator(indicator);
    }
    if (this.signaturesById.has(input.signatureId)) {
      throw new ThreatSignatureError(
        `signature '${input.signatureId}' is already registered`,
      );
    }
    const signature: ThreatSignature = Object.freeze({
      signatureId: input.signatureId,
      kind: input.kind,
      title: input.title,
      description: input.description,
      affected: input.affected,
      indicators: Object.freeze([...indicators]),
      provenance: Object.freeze({
        source: input.declaredBy,
        contentHash: contentDigest({
          signatureId: input.signatureId,
          kind: input.kind,
          title: input.title,
          description: input.description,
          affected: input.affected,
          indicators,
        }),
        publishedAt: input.publishedAt,
      }),
    });
    this.signaturesById.set(input.signatureId, signature);
    this.order.push(input.signatureId);
    return signature;
  }

  byId(signatureId: string): ThreatSignature | undefined {
    return this.signaturesById.get(signatureId);
  }

  /** All signatures in registration order. */
  list(): readonly ThreatSignature[] {
    return this.order.map((id) => this.signaturesById.get(id) as ThreatSignature);
  }

  /** Every signature whose component scope covers the identity. */
  matchIdentity(identity: ComponentIdentity): readonly ThreatSignature[] {
    return this.list().filter((signature) =>
      signatureMatchesIdentity(signature, identity),
    );
  }

  /** Every signature matching the observation (identity + one indicator). */
  matchObservation(
    observation: ComponentObservation,
  ): readonly ThreatSignature[] {
    return this.list().filter((signature) =>
      signatureMatchesObservation(signature, observation),
    );
  }
}

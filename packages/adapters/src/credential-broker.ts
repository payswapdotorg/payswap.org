/**
 * CredentialBroker — vault-backed credential reference resolution with
 * STRUCTURAL OPACITY (P2-W1-001).
 *
 * Authority: spec/phase-2/AUTHORIZATION-AND-CREDENTIAL-ISOLATION.md +
 * spec/development-state/provider-probes-20261002.json (vaultReconciliation
 * contract: "vault objects hold the complete provider credential bundle;
 * repo + manifests carry references only").
 *
 * The law this module enforces:
 *
 * 1. NO raw credential values or browser-session material (cookies, storage,
 *    headers, tokens, passwords) ever cross into agent-visible types, logs or
 *    protocol events. Agents receive only OPAQUE REFERENCES —
 *    `AuthorizationArtifactRef` and `BrowserSessionRef` are branded strings
 *    with NO accessor for the underlying material anywhere in this package;
 * 2. one vault reference (`vault://…`, bound to a
 *    `PROVIDER_<NAME>_CREDENTIAL_REF` configuration key) resolves ONE provider
 *    credential bundle to a SEALED handle. The material lives behind a private
 *    class field on `SealedCredentialBundle` with no getter; it leaves the
 *    seal ONLY inside `withSealedBundle`, and ONLY for a registered connector
 *    runtime holding its `ConnectorRuntimeKey` capability object;
 * 3. the five phase-2 authorization modes are an explicit union (owned by
 *    @payswap/connectors — the canonical vocabulary owner — consumed and
 *    re-exported here, never redefined);
 * 4. `sanitizeForLogs` strips secret-shaped VALUES and secret-named FIELDS
 *    from anything headed for logs or agent context — fail-closed: reference
 *    and identifier fields survive, secret material never does.
 *
 * Deterministic only: no ambient clock, no entropy, no network. Timestamps
 * are explicit caller-supplied ISO-8601 UTC strings (lexicographically
 * comparable when the format is uniform).
 */

import { PaySwapError, ValidationError } from "@payswap/protocol";
import type { ErrorCategory, PaySwapErrorDetails } from "@payswap/protocol";
import { AUTHORIZATION_MODES } from "@payswap/connectors";
import type { AuthorizationMode } from "@payswap/connectors";

// The five phase-2 authorization modes are canonical connector vocabulary
// (packages/connectors/src/activation.ts); consumed and re-exported here so
// the adapter surface speaks the same union throughout (AGENTS.md rule 22).
export { AUTHORIZATION_MODES };
export type { AuthorizationMode };

/** Raised when the credential-broker contract is violated. */
export class CredentialBrokerError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({
      code: "CREDENTIAL_BROKER_VIOLATION",
      category: "AUTHORIZATION_REQUIRED" as ErrorCategory,
      message,
      details,
    });
  }
}

// ---------------------------------------------------------------------------
// Opaque branded reference types (no value accessor exists — by design)
// ---------------------------------------------------------------------------

/**
 * Brand marker for {@link AuthorizationArtifactRef}. Declared (type-only,
 * zero runtime footprint) and module-private: the brand can be named in type
 * positions only through this module's exported types.
 */
declare const authorizationArtifactRefBrand: unique symbol;

/**
 * An opaque reference to a delegated authorization artifact (OAuth grant,
 * provider-native connected-account link, consent record). The ARTIFACT
 * VALUE (tokens, codes, secrets) never appears in any agent-visible type —
 * there is deliberately no accessor from a ref to its material.
 *
 * Shape: `authorization://<namespace>/<artifact-id>`.
 */
export type AuthorizationArtifactRef = string & {
  readonly [authorizationArtifactRefBrand]: true;
};

/** Brand marker for {@link BrowserSessionRef}. */
declare const browserSessionRefBrand: unique symbol;

/**
 * An opaque reference to an interactive browser session established by the
 * account owner inside the ISOLATED SECURE BROWSER RUNTIME. Cookies, session
 * storage, headers and credential fields stay inside that runtime; the
 * control plane sees only this reference.
 *
 * Shape: `browser-session://<runtime-id>/<session-id>`.
 */
export type BrowserSessionRef = string & {
  readonly [browserSessionRefBrand]: true;
};

/** Brand marker for {@link VaultReference}. */
declare const vaultReferenceBrand: unique symbol;

/**
 * A vault reference URI — e.g.
 * `vault://payswap/providers/stripe/test-20261002`. A REFERENCE, never
 * material: the vault object it names holds the complete credential bundle.
 */
export type VaultReference = string & {
  readonly [vaultReferenceBrand]: true;
};

const AUTHORIZATION_ARTIFACT_REF_PATTERN =
  /^authorization:\/\/[a-z0-9][a-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._~-]*$/;
const BROWSER_SESSION_REF_PATTERN =
  /^browser-session:\/\/[a-z0-9][a-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._~-]*$/;
const VAULT_REFERENCE_PATTERN =
  /^vault:\/\/[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)+$/;

/**
 * Validates and brands a delegated authorization artifact reference minted
 * by the trusted surface (the connection flow). This is the ONLY constructor
 * of {@link AuthorizationArtifactRef}.
 */
export function mintAuthorizationArtifactRef(value: string): AuthorizationArtifactRef {
  if (!AUTHORIZATION_ARTIFACT_REF_PATTERN.test(value)) {
    throw new ValidationError(
      `invalid authorization artifact reference '${value}': expected authorization://<namespace>/<artifact-id> (an opaque reference — the artifact material never crosses this boundary)`,
    );
  }
  return value as AuthorizationArtifactRef;
}

/**
 * Validates and brands an interactive browser-session reference minted by
 * the isolated secure browser runtime. This is the ONLY constructor of
 * {@link BrowserSessionRef}.
 */
export function mintBrowserSessionRef(value: string): BrowserSessionRef {
  if (!BROWSER_SESSION_REF_PATTERN.test(value)) {
    throw new ValidationError(
      `invalid browser session reference '${value}': expected browser-session://<runtime-id>/<session-id> (an opaque reference — cookies, storage and credential fields stay inside the isolated browser runtime)`,
    );
  }
  return value as BrowserSessionRef;
}

/**
 * Validates and brands a vault reference URI. This is the ONLY constructor
 * of {@link VaultReference}.
 */
export function vaultReference(value: string): VaultReference {
  if (!VAULT_REFERENCE_PATTERN.test(value)) {
    throw new ValidationError(
      `invalid vault reference '${value}': expected vault://<path> (references only — the bundle material stays in the vault)`,
    );
  }
  return value as VaultReference;
}

/** Structural guard for authorization artifact references from untyped sources. */
export function isAuthorizationArtifactRef(
  value: unknown,
): value is AuthorizationArtifactRef {
  return (
    typeof value === "string" && AUTHORIZATION_ARTIFACT_REF_PATTERN.test(value)
  );
}

/** Structural guard for browser-session references from untyped sources. */
export function isBrowserSessionRef(value: unknown): value is BrowserSessionRef {
  return typeof value === "string" && BROWSER_SESSION_REF_PATTERN.test(value);
}

/** Structural guard for vault references from untyped sources. */
export function isVaultReference(value: unknown): value is VaultReference {
  return typeof value === "string" && VAULT_REFERENCE_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// PROVIDER_<NAME>_CREDENTIAL_REF configuration-key shape
// ---------------------------------------------------------------------------

const PROVIDER_CREDENTIAL_CONFIG_KEY_PATTERN =
  /^PROVIDER_[A-Z0-9]+(?:_[A-Z0-9]+)*_CREDENTIAL_REF$/;

/**
 * The configuration key for a provider's credential reference, e.g.
 * `PROVIDER_STRIPE_CREDENTIAL_REF` (the deployment configuration contract's
 * per-provider template — see @payswap/operations secrets.ts).
 */
export function providerCredentialConfigKey(providerName: string): string {
  const normalized = providerName.trim().toUpperCase().replace(/-/g, "_");
  if (normalized.length === 0 || /[^A-Z0-9_]/.test(normalized)) {
    throw new ValidationError(
      `provider name '${providerName}' cannot form a PROVIDER_<NAME>_CREDENTIAL_REF key (A-Z, 0-9, _ only)`,
    );
  }
  return `PROVIDER_${normalized}_CREDENTIAL_REF`;
}

/** The provider name a credential configuration key refers to, if well-formed. */
export function providerNameFromCredentialConfigKey(
  configKey: string,
): string | undefined {
  if (!PROVIDER_CREDENTIAL_CONFIG_KEY_PATTERN.test(configKey)) {
    return undefined;
  }
  return configKey
    .replace(/^PROVIDER_/, "")
    .replace(/_CREDENTIAL_REF$/, "");
}

/** Structural guard for provider credential configuration keys. */
export function isProviderCredentialConfigKey(configKey: string): boolean {
  return PROVIDER_CREDENTIAL_CONFIG_KEY_PATTERN.test(configKey);
}

// ---------------------------------------------------------------------------
// The sealed credential bundle and its descriptor
// ---------------------------------------------------------------------------

/**
 * Non-secret scope metadata of a provider credential bundle. Everything in
 * a descriptor is safe for agent context: references, scope and expiry only.
 * The bundle MATERIAL is not here — see {@link SealedCredentialBundle}.
 */
export interface CredentialBundleDescriptor {
  readonly providerName: string;
  readonly authorizationMode: AuthorizationMode;
  /** The vault reference this bundle was resolved from (a reference, never material). */
  readonly vaultReference: VaultReference;
  readonly issuedAt: string;
  /** ISO-8601 UTC expiry of the credential/session, when the source declares one. */
  readonly validUntil?: string;
  /** Connected account scope (explicit account/tenant when the mode carries it). */
  readonly accountRef?: string;
  readonly tenantRef?: string;
  readonly countries?: readonly string[];
  readonly currencies?: readonly string[];
  readonly grantedPermissions?: readonly string[];
  /** Delegated authorization artifact reference (DELEGATED_OAUTH / CONNECTED_ACCOUNT). */
  readonly authorizationArtifactRef?: AuthorizationArtifactRef;
  /** Isolated browser-session reference (INTERACTIVE_BROWSER_SESSION). */
  readonly browserSessionRef?: BrowserSessionRef;
}

/**
 * Mode-consistency rules for a bundle descriptor (fail-closed): the declared
 * authorization mode must be backed by the reference shape that mode uses.
 */
export function descriptorModeViolations(
  descriptor: CredentialBundleDescriptor,
): readonly string[] {
  const violations: string[] = [];
  if (!(AUTHORIZATION_MODES as readonly unknown[]).includes(descriptor.authorizationMode)) {
    violations.push(
      `authorizationMode '${String(descriptor.authorizationMode)}' is not one of [${AUTHORIZATION_MODES.join(", ")}]`,
    );
    return violations;
  }
  if (typeof descriptor.providerName !== "string" || descriptor.providerName.length === 0) {
    violations.push("providerName must be a non-empty string");
  }
  if (!isVaultReference(descriptor.vaultReference)) {
    violations.push("vaultReference must be a vault:// reference");
  }
  if (typeof descriptor.issuedAt !== "string" || descriptor.issuedAt.length === 0) {
    violations.push("issuedAt must be a non-empty timestamp string");
  }
  if (
    descriptor.validUntil !== undefined &&
    (typeof descriptor.validUntil !== "string" ||
      descriptor.validUntil.length === 0 ||
      (descriptor.issuedAt.length > 0 && descriptor.validUntil < descriptor.issuedAt))
  ) {
    violations.push("validUntil, when present, must be a timestamp after issuedAt");
  }
  switch (descriptor.authorizationMode) {
    case "DELEGATED_OAUTH":
      if (descriptor.authorizationArtifactRef === undefined) {
        violations.push(
          "DELEGATED_OAUTH violates its authorization mode contract — it requires an authorizationArtifactRef (the delegated grant reference)",
        );
      }
      break;
    case "CONNECTED_ACCOUNT":
      if (descriptor.authorizationArtifactRef === undefined) {
        violations.push(
          "CONNECTED_ACCOUNT violates its authorization mode contract — it requires an authorizationArtifactRef (the provider-native connection reference)",
        );
      }
      if (descriptor.accountRef === undefined || descriptor.accountRef.length === 0) {
        violations.push("CONNECTED_ACCOUNT violates its authorization mode contract — it requires an explicit accountRef");
      }
      break;
    case "SCOPED_API_CREDENTIAL":
      if (descriptor.authorizationArtifactRef !== undefined) {
        violations.push(
          "SCOPED_API_CREDENTIAL resolves vault material only — it carries no delegated artifact reference",
        );
      }
      if (descriptor.browserSessionRef !== undefined) {
        violations.push(
          "SCOPED_API_CREDENTIAL resolves vault material only — it carries no browser session reference",
        );
      }
      break;
    case "INTERACTIVE_BROWSER_SESSION":
      if (descriptor.browserSessionRef === undefined) {
        violations.push(
          "INTERACTIVE_BROWSER_SESSION violates its authorization mode contract — it requires a browserSessionRef minted by the isolated secure browser runtime",
        );
      }
      if (descriptor.accountRef === undefined || descriptor.accountRef.length === 0) {
        violations.push("INTERACTIVE_BROWSER_SESSION violates its authorization mode contract — it requires an explicit accountRef");
      }
      if (descriptor.authorizationArtifactRef !== undefined) {
        violations.push(
          "INTERACTIVE_BROWSER_SESSION authenticates through the isolated browser runtime — it carries no vault artifact reference",
        );
      }
      break;
    case "PROVIDERLESS_RAIL":
      // A local rail holds no provider API credential: no artifact/session
      // reference is expected (the vault reference, when present, names
      // rail-held local material such as a keypair).
      if (descriptor.authorizationArtifactRef !== undefined) {
        violations.push(
          "PROVIDERLESS_RAIL carries no provider authorization artifact (owner authorization is evidenced at the activation gate, not in the bundle)",
        );
      }
      if (descriptor.browserSessionRef !== undefined) {
        violations.push(
          "PROVIDERLESS_RAIL carries no provider browser session (owner-authorized browser/device paths are evidenced at the activation gate)",
        );
      }
      break;
  }
  return Object.freeze(violations);
}

/**
 * Module-private opening channel for sealed bundles. The symbol never leaves
 * this module, so the method cannot be named (let alone called) by outside
 * code — the only caller is {@link CredentialBroker.withSealedBundle}.
 */
const openSealedBundleChannel = Symbol("payswap.open-sealed-bundle");

/**
 * A provider credential bundle with its material STRUCTURALLY SEALED: the
 * material sits in a private class field with no getter, and the only exit
 * is the module-private opening channel above, exercised by the broker's
 * connector-runtime invocation path. Nothing agent-visible can reach it —
 * not by property access, JSON serialization or spread.
 */
export class SealedCredentialBundle {
  readonly #material: unknown;
  readonly #descriptor: CredentialBundleDescriptor;

  constructor(descriptor: CredentialBundleDescriptor, material: unknown) {
    // NOTE: the constructor deliberately does NOT validate the descriptor —
    // vault implementations are trusted infrastructure that seal material
    // at the source, and the BROKER is the enforcement point: every
    // resolution path runs descriptorModeViolations before a handle is
    // minted (fail-closed at the boundary agents actually cross).
    this.#descriptor = deepFreezeDescriptor(descriptor);
    this.#material = material;
  }

  /** Non-secret scope metadata (safe for agent context). */
  get descriptor(): CredentialBundleDescriptor {
    return this.#descriptor;
  }

  /** Deterministic, secret-free summary (used by the broker for handle metadata). */
  describe(): CredentialBundleDescriptor {
    return this.#descriptor;
  }

  /** @internal module-private opening channel — never call from outside this module. */
  [openSealedBundleChannel]<R>(consumer: (material: unknown) => R): R {
    return consumer(this.#material);
  }
}

function deepFreezeDescriptor(
  descriptor: CredentialBundleDescriptor,
): CredentialBundleDescriptor {
  return Object.freeze({
    ...descriptor,
    ...(descriptor.countries !== undefined
      ? { countries: Object.freeze([...descriptor.countries]) }
      : {}),
    ...(descriptor.currencies !== undefined
      ? { currencies: Object.freeze([...descriptor.currencies]) }
      : {}),
    ...(descriptor.grantedPermissions !== undefined
      ? { grantedPermissions: Object.freeze([...descriptor.grantedPermissions]) }
      : {}),
  });
}

// ---------------------------------------------------------------------------
// The connector-runtime capability key
// ---------------------------------------------------------------------------

/** Brand marker for {@link ConnectorRuntimeKey}. */
declare const connectorRuntimeKeyBrand: unique symbol;

/**
 * Runtime stamp for registered connector-runtime keys (module-private; the
 * type-level brand above and this stamp together make a forged key both
 * untypeable and non-functional).
 */
const connectorRuntimeKeyStamp = Symbol("payswap.connector-runtime-key");

/**
 * Capability object proving the holder is a REGISTERED connector runtime.
 * Only {@link CredentialBroker.registerConnectorRuntime} constructs it; the
 * brand is unnameable outside this module and the runtime stamp is never
 * exported, so a forged key cannot satisfy `withSealedBundle` — material
 * opens only for the real runtime path.
 */
export interface ConnectorRuntimeKey {
  readonly runtimeId: string;
  readonly [connectorRuntimeKeyBrand]: true;
}

// ---------------------------------------------------------------------------
// The vault boundary
// ---------------------------------------------------------------------------

/**
 * The vault boundary as this contract sees it. Implementations live inside
 * the secure runtime (they read the real secret store); they hand the broker
 * SEALED bundles — material already inside {@link SealedCredentialBundle},
 * which exposes no accessor. The broker never sees raw material either.
 */
export interface VaultStore {
  readonly storeId: string;
  /** Resolve one vault reference to its sealed credential bundle. */
  resolve(reference: string): SealedCredentialBundle | undefined;
  /** The vault reference bound to a PROVIDER_<NAME>_CREDENTIAL_REF key. */
  referenceBoundTo(configKey: string): string | undefined;
}

// ---------------------------------------------------------------------------
// Sealed handles and runtime invocation
// ---------------------------------------------------------------------------

/**
 * The agent-visible resolution product: an opaque handle naming the sealed
 * bundle, plus its NON-SECRET scope metadata. No material — structurally.
 */
export interface SealedCredentialHandle {
  readonly handleId: string;
  readonly providerName: string;
  readonly authorizationMode: AuthorizationMode;
  readonly descriptor: CredentialBundleDescriptor;
}

/**
 * What a connector runtime receives inside {@link CredentialBroker.withSealedBundle}.
 * `material` exists ONLY in this callback frame — the single deliberate
 * crossing point from vault to connector runtime. It must never be stored,
 * logged, returned or embedded in protocol events.
 */
export interface OpenedCredentialBundle {
  readonly descriptor: CredentialBundleDescriptor;
  readonly material: unknown;
}

/** Whether a handle's bundle is expired at an explicit instant. */
export function isSealedHandleExpired(
  handle: SealedCredentialHandle,
  at: string,
): boolean {
  const validUntil = handle.descriptor.validUntil;
  return validUntil !== undefined && at >= validUntil;
}

// ---------------------------------------------------------------------------
// The broker
// ---------------------------------------------------------------------------

/** Constructor dependencies of {@link CredentialBroker}. */
export interface CredentialBrokerDeps {
  readonly store: VaultStore;
}

/**
 * Resolves `PROVIDER_<NAME>_CREDENTIAL_REF`-shaped vault references to
 * sealed credential bundle handles. The broker keeps resolved bundles in a
 * private registry keyed by opaque handle ids; handles carry references and
 * scope metadata only. Material is opened exclusively through
 * {@link CredentialBroker.withSealedBundle} for a registered connector
 * runtime — the capability-key check is structural, not conventional.
 */
export class CredentialBroker {
  readonly #store: VaultStore;
  readonly #sealed = new Map<string, SealedCredentialBundle>();
  readonly #runtimeKeys = new Map<string, ConnectorRuntimeKey>();
  #nextHandleSequence = 1;

  constructor(deps: CredentialBrokerDeps) {
    if (deps === null || typeof deps !== "object" || deps.store === undefined) {
      throw new ValidationError("CredentialBroker requires a VaultStore");
    }
    this.#store = deps.store;
  }

  /**
   * Registers a connector runtime and returns its capability key. The key is
   * the ONLY way to open sealed material; it must be handed directly to the
   * runtime's invocation code and never leaves the secure boundary.
   */
  registerConnectorRuntime(runtimeId: string): ConnectorRuntimeKey {
    if (typeof runtimeId !== "string" || runtimeId.length === 0) {
      throw new ValidationError("connector runtime id must be a non-empty string");
    }
    if (this.#runtimeKeys.has(runtimeId)) {
      throw new CredentialBrokerError(
        `connector runtime '${runtimeId}' is already registered`,
      );
    }
    const key = {
      runtimeId,
      [connectorRuntimeKeyStamp]: true as const,
    } as unknown as ConnectorRuntimeKey;
    Object.freeze(key);
    this.#runtimeKeys.set(runtimeId, key);
    return key;
  }

  /**
   * Resolves a `PROVIDER_<NAME>_CREDENTIAL_REF` configuration key to a
   * sealed credential bundle handle. Fail-closed: an unbound key, an
   * unresolvable reference or a mode-inconsistent descriptor refuses
   * resolution — there is no default-allow path.
   */
  resolveProviderCredential(configKey: string): SealedCredentialHandle {
    if (!isProviderCredentialConfigKey(configKey)) {
      throw new CredentialBrokerError(
        `'${configKey}' is not a PROVIDER_<NAME>_CREDENTIAL_REF configuration key`,
      );
    }
    const reference = this.#store.referenceBoundTo(configKey);
    if (reference === undefined) {
      throw new CredentialBrokerError(
        `configuration key '${configKey}' is not bound to a vault reference (fail-closed: no reference, no resolution)`,
        { configKey },
      );
    }
    return this.resolveVaultReference(reference);
  }

  /**
   * Resolves one vault reference (`vault://…`) to a sealed credential bundle
   * handle — one reference, one bundle, one sealed handle.
   */
  resolveVaultReference(reference: string): SealedCredentialHandle {
    if (!isVaultReference(reference)) {
      throw new CredentialBrokerError(
        `'${reference}' is not a vault:// reference`,
      );
    }
    const bundle = this.#store.resolve(reference);
    if (bundle === undefined) {
      throw new CredentialBrokerError(
        `vault reference '${reference}' does not resolve to a credential bundle (fail-closed)`,
        { reference },
      );
    }
    if (!(bundle instanceof SealedCredentialBundle)) {
      throw new CredentialBrokerError(
        `vault reference '${reference}' resolved to a value that is not a SealedCredentialBundle — the vault boundary must seal material at the source`,
        { reference },
      );
    }
    const violations = descriptorModeViolations(bundle.descriptor);
    if (violations.length > 0) {
      throw new CredentialBrokerError(
        `vault reference '${reference}' resolves a bundle whose descriptor violates its authorization mode: ${violations.join("; ")}`,
        { reference, violations: [...violations] },
      );
    }
    const handleId = this.#mintHandleId(bundle.descriptor.providerName);
    this.#sealed.set(handleId, bundle);
    return Object.freeze({
      handleId,
      providerName: bundle.descriptor.providerName,
      authorizationMode: bundle.descriptor.authorizationMode,
      descriptor: bundle.descriptor,
    });
  }

  /**
   * The connector-runtime invocation path: opens the sealed bundle named by
   * a handle and hands the material to `consumer` — but ONLY when
   * `runtimeKey` is the exact capability object minted by
   * {@link registerConnectorRuntime} for a registered runtime. A missing,
   * forged or stale key refuses to open: structural opacity, not convention.
   */
  withSealedBundle<R>(
    handle: SealedCredentialHandle,
    runtimeKey: ConnectorRuntimeKey,
    consumer: (opened: OpenedCredentialBundle) => R,
  ): R {
    if (handle === null || typeof handle !== "object") {
      throw new CredentialBrokerError("a SealedCredentialHandle is required");
    }
    const bundle = this.#sealed.get(handle.handleId);
    if (bundle === undefined) {
      throw new CredentialBrokerError(
        `sealed handle '${handle.handleId}' is not held by this broker (revoked, released, or minted elsewhere)`,
        { handleId: handle.handleId },
      );
    }
    this.#requireRegisteredRuntimeKey(runtimeKey);
    return bundle[openSealedBundleChannel]((material) =>
      consumer({ descriptor: bundle.descriptor, material }),
    );
  }

  /**
   * Releases a sealed handle (session/credential revocation cleanup): the
   * bundle becomes unopenable through this broker afterwards.
   */
  releaseSealedHandle(handle: SealedCredentialHandle): void {
    if (handle === null || typeof handle !== "object") {
      throw new CredentialBrokerError("a SealedCredentialHandle is required");
    }
    this.#sealed.delete(handle.handleId);
  }

  #requireRegisteredRuntimeKey(runtimeKey: ConnectorRuntimeKey): void {
    if (
      runtimeKey === null ||
      typeof runtimeKey !== "object" ||
      (runtimeKey as unknown as Record<PropertyKey, unknown>)[
        connectorRuntimeKeyStamp
      ] !== true
    ) {
      throw new CredentialBrokerError(
        "credential material opens only for a ConnectorRuntimeKey minted by registerConnectorRuntime — a forged or absent key cannot open a sealed bundle",
      );
    }
    const registered = this.#runtimeKeys.get(runtimeKey.runtimeId);
    if (registered === undefined || registered !== runtimeKey) {
      throw new CredentialBrokerError(
        `connector runtime '${runtimeKey.runtimeId}' is not registered with this broker`,
        { runtimeId: runtimeKey.runtimeId },
      );
    }
  }

  #mintHandleId(providerName: string): string {
    const handleId = `sealed:${providerName}:${this.#nextHandleSequence}`;
    this.#nextHandleSequence += 1;
    return handleId;
  }
}

// ---------------------------------------------------------------------------
// Redaction — sanitizeForLogs (logs AND agent context)
// ---------------------------------------------------------------------------

/**
 * Secret-shaped VALUE patterns. Aligned with the @payswap/operations secret
 * hygiene vocabulary (packages/operations/src/secrets.ts) plus the
 * browser-session material shapes this package is responsible for.
 */
const SECRET_VALUE_PATTERNS: readonly {
  readonly label: string;
  readonly pattern: RegExp;
}[] = Object.freeze([
  { label: "private-key-block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: "live-secret-key", pattern: /sk_live_[A-Za-z0-9]{16,}/ },
  { label: "test-secret-key", pattern: /sk_test_[A-Za-z0-9]{16,}/ },
  { label: "live-restricted-key", pattern: /rk_live_[A-Za-z0-9]{16,}/ },
  { label: "live-publishable-key", pattern: /pk_live_[A-Za-z0-9]{16,}/ },
  { label: "github-token", pattern: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { label: "bearer-credential", pattern: /(?:Bearer|bearer)\s+[A-Za-z0-9._~+/=-]{16,}/ },
  { label: "basic-credential", pattern: /(?:Basic|basic)\s+[A-Za-z0-9._~+/=-]{16,}/ },
  { label: "aws-access-key", pattern: /AKIA[0-9A-Z]{16}/ },
  { label: "jwt", pattern: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { label: "high-entropy-blob", pattern: /^[A-Za-z0-9+/=_-]{40,}$/ },
]);

/**
 * Secret-NAME vocabulary. A key whose tokens (camelCase/snake/kebab split)
 * contain one of these names names SECRET MATERIAL at that position — with
 * two carve-outs: compound reference/identifier/metadata suffixes (below)
 * mark control-plane fields that are deliberately shared, and only PRIMITIVE
 * leaves are redacted (objects are walked to their leaves).
 */
const SECRET_NAME_TOKENS: ReadonlySet<string> = new Set([
  "authorization",
  "cookie",
  "token",
  "secret",
  "secrets",
  "password",
  "passwd",
  "passphrase",
  "credential",
  "credentials",
  "bearer",
  "session",
]);

/** Adjacent token pairs that name secret material (apiKey, clientSecret…). */
const SECRET_NAME_TOKEN_PAIRS: ReadonlySet<string> = new Set([
  "apikey",
  "accesskey",
  "privatekey",
  "clientsecret",
  "signingkey",
  "secretkey",
  "sessionmaterial",
  "webhooksigning",
  "accesstoken",
  "refreshtoken",
  "idtoken",
]);

/**
 * Trailing tokens that mark a control-plane REFERENCE / identifier /
 * metadata field — safe for agent context by design (the whole control
 * plane runs on references). Their values still pass the secret-SHAPE
 * check, so a raw value smuggled into a reference field is still caught.
 */
const SAFE_KEY_SUFFIX_TOKENS: ReadonlySet<string> = new Set([
  "ref",
  "refs",
  "id",
  "ids",
  "name",
  "mode",
  "state",
  "status",
  "scope",
  "uri",
  "url",
  "version",
  "type",
  "kind",
  "label",
  "at",
  "by",
]);

function keyTokens(key: string): readonly string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9]+/)
    .filter((token) => token.length > 0)
    .map((token) => token.toLowerCase());
}

function secretShapeOf(value: string): string | undefined {
  for (const { label, pattern } of SECRET_VALUE_PATTERNS) {
    if (pattern.test(value)) {
      return label;
    }
  }
  return undefined;
}

function isSecretNamedLeaf(key: string): boolean {
  const tokens = keyTokens(key);
  if (tokens.length === 0) {
    return false;
  }
  const last = tokens[tokens.length - 1];
  if (last !== undefined && SAFE_KEY_SUFFIX_TOKENS.has(last)) {
    return false;
  }
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token !== undefined && SECRET_NAME_TOKENS.has(token)) {
      return true;
    }
    const next = tokens[i + 1];
    if (token !== undefined && next !== undefined) {
      const pair = `${token}${next}`;
      if (SECRET_NAME_TOKEN_PAIRS.has(pair)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Deterministic, cycle-safe redaction of anything headed for LOGS or AGENT
 * CONTEXT:
 *
 * - string values matching a secret VALUE shape are replaced by
 *   `[REDACTED:value:<label>]`;
 * - primitive leaves under secret-NAMED keys (authorization, cookie, token,
 *   secret, password, api key, credential, …) are replaced by
 *   `[REDACTED:key:<key>]` — unless the key is a reference/identifier field
 *   (`*Ref`, `*Id`, `*Name`), which the control plane deliberately shares;
 * - Maps become entry arrays, Sets become arrays, functions/symbols become
 *   `[NON-LOGGABLE]`, cycles are cut with `[CYCLIC]`;
 * - unknown input never throws and never passes secret material through.
 */
export function sanitizeForLogs(value: unknown): unknown {
  return sanitize(value, new WeakSet<object>(), "$");
}

function sanitize(
  value: unknown,
  seen: WeakSet<object>,
  keyContext: string,
): unknown {
  switch (typeof value) {
    case "string": {
      const shape = secretShapeOf(value);
      if (shape !== undefined) {
        return `[REDACTED:value:${shape}]`;
      }
      const leafKey = keyContext.substring(keyContext.lastIndexOf(".") + 1);
      if (isSecretNamedLeaf(leafKey)) {
        return `[REDACTED:key:${leafKey}]`;
      }
      return value;
    }
    case "number":
    case "boolean":
    case "bigint": {
      const leafKey = keyContext.substring(keyContext.lastIndexOf(".") + 1);
      return isSecretNamedLeaf(leafKey)
        ? `[REDACTED:key:${leafKey}]`
        : value;
    }
    case "undefined":
      return null;
    case "function":
    case "symbol":
      return "[NON-LOGGABLE]";
    case "object": {
      if (value === null) {
        return null;
      }
      if (seen.has(value)) {
        return "[CYCLIC]";
      }
      seen.add(value);
      try {
        if (value instanceof Map) {
          return [...value.entries()].map(([k, v]) => [
            sanitize(k, seen, `${keyContext}.mapKey`),
            sanitize(
              v,
              seen,
              typeof k === "string" ? `${keyContext}.${k}` : `${keyContext}.mapValue`,
            ),
          ]);
        }
        if (value instanceof Set) {
          return [...value.values()].map((v) =>
            sanitize(v, seen, `${keyContext}.setValue`),
          );
        }
        if (Array.isArray(value)) {
          return value.map((item, index) =>
            sanitize(item, seen, `${keyContext}[${index}]`),
          );
        }
        const record = value as Readonly<Record<string, unknown>>;
        const result: Record<string, unknown> = {};
        for (const key of Object.keys(record).sort()) {
          result[key] = sanitize(record[key], seen, `${keyContext}.${key}`);
        }
        return result;
      } finally {
        seen.delete(value);
      }
    }
  }
}

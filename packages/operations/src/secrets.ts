/**
 * @payswap/operations — secret management declarations (W3-007).
 *
 * Authority: spec/experience/DEPLOYMENT-TOPOLOGY.md §3 (Configuration
 * contract) and §6 gate 3 (secret exposure). The rule set:
 *
 * 1. Secrets are VAULT/SECRET-STORE BACKED and NEVER COMMITTED to the repo
 *    or to any deployment artifact. Only `*_REF` reference NAMES appear in
 *    configuration (§3.2 rule 1);
 * 2. `SecretResolver` is the runtime boundary contract: a reference
 *    resolves to a KEY IDENTIFIER (and the value crosses into the process
 *    that needs it) — a resolver NEVER returns a secret VALUE into a
 *    configuration artifact. The type makes this structural: the resolution
 *    result carries `keyId`, never `value`;
 * 3. hygiene is CHECKED, not assumed: `checkSecretReferenceHygiene` scans a
 *    manifest for secret-shaped VALUES (private keys, live API keys,
 *    passwords) and rejects any non-`*_REF` secret key;
 * 4. rotation is PROCEDURAL DATA with bounded windows: dual-key overlap so
 *    in-flight authorizations survive, and security-epoch bumps where a key
 *    authorizes sensitive actions (INV-A02: expired/revoked epochs cannot
 *    authorize — revoking a webhook-signing key also requires the epoch
 *    bump operator action before stale authorizations are refused).
 *
 * Deterministic only: pure functions over declared data; no vault I/O —
 * this package declares and checks, it never resolves live secrets.
 */

import type { EnvironmentManifest, ServiceRole } from "./deployment.js";

// ---------------------------------------------------------------------------
// The required-secret inventory
// ---------------------------------------------------------------------------

/** Rotation policy attached to a secret requirement. */
export interface RotationPolicy {
  /** Maximum key age before rotation is required. */
  readonly maxAgeDays: number;
  /**
   * automatic = the platform rotates without an operator;
   * manual = an operator action with evidence is required.
   */
  readonly mode: "automatic" | "manual";
  /**
   * Overlap window where BOTH old and new keys are accepted during
   * rotation, so in-flight signed artifacts stay verifiable.
   */
  readonly overlapWindowDays: number;
}

/** One required secret reference in the inventory. */
export interface SecretRequirement {
  /**
   * The configuration KEY that must hold a vault REFERENCE name (never a
   * value). For the provider template this is the `PROVIDER_<NAME>_CREDENTIAL_REF`
   * family, expressed as the concrete provider families.
   */
  readonly configKey: string;
  /** Human name of the secret family. */
  readonly name: string;
  /** The worker roles that must hold this reference. */
  readonly scope: readonly ServiceRole[];
  readonly rotation: RotationPolicy;
  readonly impact: "critical" | "high";
  readonly description: string;
}

/** The required secret-reference inventory (DEPLOYMENT-TOPOLOGY §3.1). */
export const REQUIRED_SECRET_REFERENCES: readonly SecretRequirement[] =
  Object.freeze([
    {
      configKey: "VAULT_REF",
      name: "Vault mount root",
      scope: [
        "web-api",
        "protocol-worker",
        "rail-adapter-worker",
        "reconciliation-worker",
        "lab-worker",
        "notification-worker",
      ],
      rotation: { maxAgeDays: 365, mode: "manual", overlapWindowDays: 1 },
      impact: "critical",
      description:
        "Reference to the vault/secret-store mount holding all secrets — root of every other resolution.",
    },
    {
      configKey: "DATABASE_URL",
      name: "PostgreSQL credentials",
      scope: [
        "web-api",
        "protocol-worker",
        "rail-adapter-worker",
        "reconciliation-worker",
        "lab-worker",
        "notification-worker",
      ],
      rotation: { maxAgeDays: 90, mode: "manual", overlapWindowDays: 0 },
      impact: "critical",
      description:
        "System-of-record connection credentials (connection string carries the secret).",
    },
    {
      configKey: "OBJECT_STORAGE_ACCESS_KEY_ID",
      name: "Object storage access key id",
      scope: ["web-api", "protocol-worker"],
      rotation: { maxAgeDays: 180, mode: "automatic", overlapWindowDays: 1 },
      impact: "high",
      description: "Storage credential for evidence artifacts (vault-resolved).",
    },
    {
      configKey: "OBJECT_STORAGE_SECRET_ACCESS_KEY",
      name: "Object storage secret access key",
      scope: ["web-api", "protocol-worker"],
      rotation: { maxAgeDays: 180, mode: "automatic", overlapWindowDays: 1 },
      impact: "high",
      description: "Storage credential for evidence artifacts (vault-resolved).",
    },
    {
      configKey: "PROVIDER_CREDENTIAL_REF",
      name: "Per-provider rail credentials",
      scope: ["rail-adapter-worker"],
      rotation: { maxAgeDays: 90, mode: "manual", overlapWindowDays: 1 },
      impact: "critical",
      description:
        "Per-provider credential reference resolved from the vault at runtime (PROVIDER_<NAME>_CREDENTIAL_REF template, e.g. PROVIDER_STRIPE_CREDENTIAL_REF).",
    },
    {
      configKey: "WEBHOOK_SIGNING_SECRET_REF",
      name: "Webhook signing key (v1)",
      scope: ["notification-worker"],
      rotation: { maxAgeDays: 90, mode: "manual", overlapWindowDays: 7 },
      impact: "critical",
      description:
        "Resolves the key for X-PaySwap-Signature computation; rotation must respect the 300-second replay-window semantics — consumers keep accepting the previous key for the overlap interval.",
    },
  ]);

// ---------------------------------------------------------------------------
// Reference-resolution contract (runtime boundary)
// ---------------------------------------------------------------------------

/** What a resolution outcome may carry — a KEY ID, never the value. */
export type SecretResolution =
  | { readonly status: "RESOLVED"; readonly keyId: string }
  | { readonly status: "UNRESOLVED"; readonly reason: string };

/**
 * The runtime secret-resolution contract. An implementation resolves a
 * reference NAME to a key identifier inside the consumer's process; the
 * resolved VALUE never crosses back into configuration space, logs, or
 * this package's artifacts.
 */
export interface SecretResolver {
  resolve(referenceName: string): SecretResolution;
  /** Enumerate the key ids currently valid for a reference (rotation overlap). */
  activeKeyIds(referenceName: string): readonly string[];
}

/** A declarative (test/lint-time) resolver over an in-memory ref→key map. */
export class DeclarativeSecretResolver implements SecretResolver {
  private readonly keys: ReadonlyMap<string, readonly string[]>;

  constructor(entries: Readonly<Record<string, readonly string[]>>) {
    this.keys = new Map(Object.entries(entries));
  }

  resolve(referenceName: string): SecretResolution {
    const keyIds = this.keys.get(referenceName);
    if (keyIds === undefined || keyIds.length === 0) {
      return {
        status: "UNRESOLVED",
        reason: `no active key for reference '${referenceName}'`,
      };
    }
    return { status: "RESOLVED", keyId: `key:${referenceName}:${keyIds[0]}` };
  }

  activeKeyIds(referenceName: string): readonly string[] {
    return this.keys.get(referenceName) ?? [];
  }
}

// ---------------------------------------------------------------------------
// Secret hygiene gate (§6 gate 3) — no secret values in config artifacts
// ---------------------------------------------------------------------------

export class SecretHygieneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretHygieneError";
  }
}

/** Value shapes that are never acceptable inside a config artifact. */
const SECRET_VALUE_PATTERNS: readonly { readonly label: string; readonly pattern: RegExp }[] =
  Object.freeze([
    { label: "private key block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
    { label: "GitHub token", pattern: /gh[pousr]_[A-Za-z0-9]{20,}/ },
    { label: "live provider secret key", pattern: /sk_live_[A-Za-z0-9]{16,}/ },
    { label: "live provider publishable key", pattern: /pk_live_[A-Za-z0-9]{16,}/ },
    { label: "bearer credential", pattern: /Bearer\s+[A-Za-z0-9._-]{24,}/i },
    { label: "inline password", pattern: /(?:password|passwd|secret)\s*[:=]\s*\S+/i },
    { label: "AWS-style access key", pattern: /AKIA[0-9A-Z]{16}/ },
  ]);

/**
 * A config key that is NOT a `*_REF` but names a secret directly — the
 * contract requires such entries be vault-backed references (§3.2 rule 1).
 */
const FORBIDDEN_SECRET_KEY_FRAGMENTS: readonly string[] = Object.freeze([
  "PRIVATE_KEY",
  "PASSWORD",
  "API_KEY",
  "CLIENT_SECRET",
  "SIGNING_SECRET",
]);

export interface ServiceSecretHygiene {
  readonly serviceId: string;
  /** Config keys rejected as direct (non-reference) secret keys. */
  readonly forbiddenKeys: readonly string[];
  /** Config values rejected as embedded secret material. */
  readonly embeddedValues: readonly { readonly key: string; readonly pattern: string }[];
  readonly passed: boolean;
}

export interface SecretHygieneReport {
  readonly passed: boolean;
  readonly services: readonly ServiceSecretHygiene[];
}

/**
 * Check an environment manifest for secret EXPOSURE: no config artifact may
 * contain a secret VALUE or a direct (non-`*_REF`) secret key. Differences
 * from completeness: this gate scans what IS there; completeness checks what
 * is MISSING. Both must pass before release (§6 gates 2 and 3).
 */
export function checkSecretReferenceHygiene(
  manifest: EnvironmentManifest,
): SecretHygieneReport {
  const services: ServiceSecretHygiene[] = manifest.services.map((service) => {
    const forbiddenKeys: string[] = [];
    const embeddedValues: { key: string; pattern: string }[] = [];
    for (const [key, value] of Object.entries(service.config)) {
      if (
        FORBIDDEN_SECRET_KEY_FRAGMENTS.some((fragment) =>
          key.toUpperCase().includes(fragment),
        ) &&
        !key.endsWith("_REF")
      ) {
        forbiddenKeys.push(key);
      }
      for (const { label, pattern } of SECRET_VALUE_PATTERNS) {
        if (pattern.test(value)) {
          embeddedValues.push({ key, pattern: label });
          break;
        }
      }
    }
    return {
      serviceId: service.serviceId,
      forbiddenKeys: forbiddenKeys.sort(),
      embeddedValues: embeddedValues.sort((a, b) => a.key.localeCompare(b.key)),
      passed: forbiddenKeys.length === 0 && embeddedValues.length === 0,
    };
  });
  return { passed: services.every((check) => check.passed), services };
}

// ---------------------------------------------------------------------------
// Rotation procedures — as data
// ---------------------------------------------------------------------------

export interface RotationStep {
  readonly stepId: string;
  readonly description: string;
}

export interface SecretRotationProcedure {
  readonly procedureId: string;
  readonly configKey: string;
  /**
   * Additional config keys rotated by the SAME procedure (credential pairs
   * rotate together — e.g. the object-storage access-key id + secret).
   */
  readonly alsoRotates?: readonly string[];
  readonly name: string;
  readonly steps: readonly RotationStep[];
  /**
   * Operator actions that must be evidenced alongside this rotation (see
   * operator-actions.ts): the epoch bump for authorization-sensitive keys.
   */
  readonly requiredOperatorActions: readonly string[];
  readonly invariants: readonly string[];
}

/**
 * The rotation procedures for the vault-backed secret families. Every
 * procedure is dual-key (overlap window) and evidence-carrying; keys that
 * authorize sensitive actions additionally require the
 * `bump-security-epoch` operator action so stale authorizations are
 * refused (INV-A02 / INV-S02).
 */
export const SECRET_ROTATION_PROCEDURES: readonly SecretRotationProcedure[] =
  Object.freeze([
    {
      procedureId: "rotate-vault-root",
      configKey: "VAULT_REF",
      name: "Rotate the vault mount root reference",
      steps: [
        {
          stepId: "mint-new-root",
          description:
            "Mint the new vault root reference alongside the existing one — both resolve during the overlap interval.",
        },
        {
          stepId: "re-resolve-workers",
          description:
            "Roll each worker role to resolve through the new root reference (WORKER_ROLE at a time; the protocol worker last so financial command intake never loses resolution).",
        },
        {
          stepId: "verify-resolution",
          description:
            "Verify every required reference still resolves (DeclarativeSecretResolver check + live probe from each role).",
        },
        {
          stepId: "revoke-old-root",
          description:
            "Revoke the old root only after every role resolved the new one; record the revocation evidence.",
        },
      ],
      requiredOperatorActions: [],
      invariants: [],
    },
    {
      procedureId: "rotate-database-credentials",
      configKey: "DATABASE_URL",
      name: "Rotate PostgreSQL credentials",
      steps: [
        {
          stepId: "create-dual-role",
          description:
            "Create the new database role with identical grants alongside the current one.",
        },
        {
          stepId: "roll-connection-strings",
          description:
            "Update the vault-held connection secret; workers re-read on reconnect — no restart required for pooled roles.",
        },
        {
          stepId: "verify-system-of-record",
          description:
            "Verify journal writes and outbox drains continue; committed mutations must not lose events (INV-O02).",
        },
        {
          stepId: "drop-old-role",
          description:
            "Drop the old role after the retention window; record evidence.",
        },
      ],
      requiredOperatorActions: [],
      invariants: ["INV-O02"],
    },
    {
      procedureId: "rotate-provider-credentials",
      configKey: "PROVIDER_CREDENTIAL_REF",
      name: "Rotate a per-provider rail credential (PROVIDER_<NAME>_CREDENTIAL_REF)",
      steps: [
        {
          stepId: "pause-provider-intake",
          description:
            "Confirm in-flight attempts for the provider are drained or reconciled; UNKNOWN outcomes must not be blindly retried (INV-X02).",
        },
        {
          stepId: "mint-new-provider-key",
          description:
            "Create the new provider API credential under the provider's own rotation facility.",
        },
        {
          stepId: "swap-reference",
          description:
            "Point PROVIDER_<NAME>_CREDENTIAL_REF at the new vault entry; adapter workers re-resolve per execution.",
        },
        {
          stepId: "verify-connected-instance",
          description:
            "Verify the ConnectedCapabilityInstance still matches actual account authorization/entitlement (INV-C05) — capability scope is data in the system of record, not an environment variable.",
        },
        {
          stepId: "revoke-old-provider-key",
          description:
            "Revoke the old credential at the provider; preserve provider-side evidence of the revocation.",
        },
      ],
      requiredOperatorActions: [],
      invariants: ["INV-C05", "INV-X02"],
    },
    {
      procedureId: "rotate-webhook-signing-key",
      configKey: "WEBHOOK_SIGNING_SECRET_REF",
      name: "Rotate the webhook signing key (X-PaySwap-Signature v1)",
      steps: [
        {
          stepId: "mint-dual-signing-keys",
          description:
            "Mint the new signing key; during the overlap window consumers accept signatures from BOTH keys (the 300-second replay window is fully contained).",
        },
        {
          stepId: "sign-with-new-key",
          description:
            "Switch the notification worker to sign with the new key; consumers were distributed the dual-key set.",
        },
        {
          stepId: "bump-security-epoch",
          description:
            "The signing key authorizes trusted-surface delivery — execute the `bump-security-epoch` operator action with evidence so authorizations under the old key epoch are refused afterwards (INV-A02/INV-S02).",
        },
        {
          stepId: "retire-old-key",
          description:
            "Retire the old key after the overlap window closes; keep the revocation evidence immutable (INV-E05).",
        },
      ],
      requiredOperatorActions: ["bump-security-epoch"],
      invariants: ["INV-A02", "INV-S02", "INV-E05"],
    },
    {
      procedureId: "rotate-object-storage-keys",
      configKey: "OBJECT_STORAGE_SECRET_ACCESS_KEY",
      alsoRotates: ["OBJECT_STORAGE_ACCESS_KEY_ID"],
      name: "Rotate object-storage credentials (access-key pair)",
      steps: [
        {
          stepId: "mint-storage-pair",
          description:
            "Create the new access-key pair (automatic rotation facility).",
        },
        {
          stepId: "verify-evidence-writes",
          description:
            "Verify evidence artifact writes and content-addressed reads succeed on the new pair before retiring the old.",
        },
        {
          stepId: "retire-old-pair",
          description:
            "Retire the old pair after the overlap window; evidence history stays immutable (INV-E05).",
        },
      ],
      requiredOperatorActions: [],
      invariants: ["INV-E05"],
    },
  ]);

/** Every required secret family has a rotation procedure. */
export function rotationProcedureFor(
  configKey: string,
): SecretRotationProcedure | undefined {
  return (
    SECRET_ROTATION_PROCEDURES.find(
      (procedure) =>
        procedure.configKey === configKey ||
        procedure.alsoRotates?.includes(configKey),
    ) ?? undefined
  );
}

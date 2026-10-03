/**
 * @payswap/onchain-security — the secret-boundary kernel
 * (AGENTS.md rule 25; UMI architecture "Wallet/signing"; INV-R02).
 *
 * Raw private keys, seed phrases, wallet passwords, provider secrets,
 * cookies and MFA material NEVER enter agent/model context or ordinary
 * artifacts. This module is the deterministic enforcement of that law for
 * every agent-facing contract of the kernel:
 *
 * - `assertNoSecretMaterial(value, label)` — deep runtime scan rejecting
 *   forbidden KEY NAMES (e.g. privateKey, seedPhrase, walletPassword) and
 *   secret-shaped VALUES (raw 32-byte key shape, BIP-39 12/24-word shape)
 *   smuggled into neutral fields. Every factory of an agent-facing artifact
 *   calls it, so a secret-bearing artifact is UNCONSTRUCTIBLE.
 * - `FindForbiddenSecretKeys<T>` — the compile-time twin: a recursive type
 *   that surfaces any forbidden key name inside a contract's type. The
 *   adversarial test suite asserts it resolves to `never` for every
 *   agent-facing contract (proof by construction at the type level).
 *
 * Shape detectors match STRUCTURE only (length, charset, word count). No
 * realistic secret literal ever appears in this source or its fixtures:
 * tests assemble credential-shaped fixtures at RUNTIME from fragments.
 *
 * Derived public identifiers where a 32-byte hex shape is EXPECTED (hashes,
 * digests, signatures, fingerprints, EIP-712 domain separators/salts,
 * calldata) are value-scan-exempt by key name — they are not secrets.
 *
 * Deterministic only: pure functions, no clock, no randomness.
 */

// ---------------------------------------------------------------------------
// Vocabulary (field names that may NEVER appear on an agent-facing contract)
// ---------------------------------------------------------------------------

/**
 * Normalized forbidden key-name fragments (substring match after stripping
 * `_`/`-` separators and lowercasing). Chosen so that no legitimate field of
 * this kernel's contracts collides; when in doubt the kernel fails closed.
 * Use `vaultRef`/`credentialRef` naming for opaque secret REFERENCES.
 */
export const FORBIDDEN_SECRET_KEY_SUBSTRINGS = [
  "privatekey",
  "privkey",
  "secretkey",
  "plaintextkey",
  "rawkey",
  "keystore",
  "seedphrase",
  "mnemonic",
  "recoveryphrase",
  "backupphrase",
  "brainwallet",
  "password",
  "passphrase",
  "apikey",
  "apisecret",
  "providersecret",
  "clientsecret",
  "secret",
  "accesstoken",
  "refreshtoken",
  "sessiontoken",
  "cookie",
  "mfa",
  "totp",
  "otp",
] as const;

/**
 * Forbidden only as an EXACT normalized key (ambiguous stems that could
 * otherwise appear inside unrelated words).
 */
export const FORBIDDEN_SECRET_KEY_EXACT = ["seed"] as const;

/** One runtime violation found by the scan. */
export interface SecretViolation {
  /** Dotted path to the offending field inside the scanned value. */
  readonly path: string;
  readonly kind: "forbidden_key" | "secret_shaped_value";
  readonly key?: string;
  readonly reason: string;
}

/** Raised when secret-shaped material would cross the agent-facing boundary. */
export class SecretShapeError extends Error {
  readonly violations: readonly SecretViolation[];

  constructor(label: string, violations: readonly SecretViolation[]) {
    super(
      `${label}: secret-shaped material rejected at the agent-facing boundary (${violations.length} violation(s)): ` +
        violations.map((v) => `${v.path} [${v.kind}] ${v.reason}`).join("; "),
    );
    this.name = "SecretShapeError";
    this.violations = violations;
  }
}

// ---------------------------------------------------------------------------
// Value shape detectors (structure only — never realistic literals)
// ---------------------------------------------------------------------------

/** Raw 32-byte key shape: 64 hex chars, with or without a 0x prefix. */
export function isRawKeyShape(value: string): boolean {
  return /^(0x)?[0-9a-fA-F]{64}$/.test(value);
}

/** BIP-39 mnemonic shape: exactly 12 or 24 lowercase words of 3-8 letters. */
export function isMnemonicShape(value: string): boolean {
  const tokens = value.trim().split(/\s+/);
  if (tokens.length !== 12 && tokens.length !== 24) {
    return false;
  }
  return tokens.every((token) => /^[a-z]{3,8}$/.test(token));
}

/**
 * Key-name fragments whose values are DERIVED PUBLIC identifiers where a
 * 32-byte hex shape is the expected form (keccak hashes, digests, EIP-712
 * domain separators, opaque signatures, fingerprints, calldata). These are
 * value-scan-exempt; the forbidden-KEY check still applies to their names.
 */
const DERIVED_IDENTIFIER_KEY_FRAGMENTS = [
  "hash",
  "digest",
  "signature",
  "fingerprint",
  "txid",
  "transactionid",
  "blockhash",
  "blockref", // simulation provenance: the block the simulation ran against
  "txref",
  "calldata",
  "domainseparator",
  "salt",
] as const;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, "");
}

function isForbiddenKeyName(key: string): boolean {
  const normalized = normalizeKey(key);
  if ((FORBIDDEN_SECRET_KEY_EXACT as readonly string[]).includes(normalized)) {
    return true;
  }
  return (FORBIDDEN_SECRET_KEY_SUBSTRINGS as readonly string[]).some((fragment) =>
    normalized.includes(fragment),
  );
}

function isDerivedIdentifierKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return DERIVED_IDENTIFIER_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

// ---------------------------------------------------------------------------
// Deep runtime scan
// ---------------------------------------------------------------------------

const MAX_SCAN_DEPTH = 8;

/**
 * Scan an arbitrary value for secret-shaped material. Deterministic and
 * pure: same value, same violations. Cycles are cut by identity tracking;
 * depth is bounded. Functions are treated as opaque (never carried).
 */
export function scanForSecretMaterial(
  value: unknown,
  path = "$",
  depth = 0,
  seen = new Set<object>(),
): readonly SecretViolation[] {
  const violations: SecretViolation[] = [];
  if (depth > MAX_SCAN_DEPTH) {
    return violations;
  }
  if (value === null || typeof value !== "object") {
    return violations;
  }
  if (seen.has(value)) {
    return violations;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      violations.push(
        ...scanForSecretMaterial(value[index], `${path}[${index}]`, depth + 1, seen),
      );
    }
    return violations;
  }
  const record = value as Readonly<Record<string, unknown>>;
  for (const key of Object.keys(record)) {
    const field = record[key];
    const fieldPath = `${path}.${key}`;
    if (isForbiddenKeyName(key)) {
      violations.push({
        path: fieldPath,
        kind: "forbidden_key",
        key,
        reason: `field name '${key}' may never appear on an agent-facing contract (raw credentials stay at the trusted surface / vault)`,
      });
      continue; // the name alone is the violation; do not also scan the value
    }
    if (typeof field === "string" && !isDerivedIdentifierKey(key)) {
      if (isRawKeyShape(field)) {
        violations.push({
          path: fieldPath,
          kind: "secret_shaped_value",
          key,
          reason: `value has the raw 32-byte private-key shape (64 hex chars) under a non-derived-identifier field '${key}'`,
        });
        continue;
      }
      if (isMnemonicShape(field)) {
        violations.push({
          path: fieldPath,
          kind: "secret_shaped_value",
          key,
          reason: `value has the BIP-39 mnemonic shape (12/24 lowercase words) under field '${key}'`,
        });
        continue;
      }
    }
    violations.push(...scanForSecretMaterial(field, fieldPath, depth + 1, seen));
  }
  return violations;
}

/**
 * Fail-closed gate for every agent-facing artifact constructor: throws
 * `SecretShapeError` listing every violation when secret-shaped material is
 * present. (AGENTS.md rule 25, INV-R02 — proof by construction.)
 */
export function assertNoSecretMaterial(value: unknown, label: string): void {
  const violations = scanForSecretMaterial(value);
  if (violations.length > 0) {
    throw new SecretShapeError(label, violations);
  }
}

// ---------------------------------------------------------------------------
// Compile-time twin (type-level forbidden-key detection)
// ---------------------------------------------------------------------------

type StripSeparators<S extends string> = S extends `${infer A}_${infer B}`
  ? StripSeparators<`${A}${B}`>
  : S extends `${infer A}-${infer B}`
    ? StripSeparators<`${A}${B}`>
    : S;

/** Lowercase + strip `_`/`-` from a key name. */
export type NormalizeKeyName<K extends string> = StripSeparators<Lowercase<K>>;

type ForbiddenSubstringUnion = (typeof FORBIDDEN_SECRET_KEY_SUBSTRINGS)[number];

type KeyNameViolates<K extends string> =
  NormalizeKeyName<K> extends "seed"
    ? true
    : NormalizeKeyName<K> extends `${string}${ForbiddenSubstringUnion}${string}`
      ? true
      : false;

/**
 * Union of every forbidden key name found anywhere inside `T` (recursing
 * through object properties, arrays and tuples). Resolves to `never` when
 * the contract is secret-free. The adversarial test suite asserts
 * `never` for every agent-facing contract of this package.
 */
export type FindForbiddenSecretKeys<T> =
  T extends (...args: never[]) => unknown
    ? never
    : T extends readonly (infer E)[]
      ? FindForbiddenSecretKeys<E>
      : T extends object
        ? {
            [K in keyof T]-?: K extends string
              ? KeyNameViolates<K> extends true
                ? K
                : FindForbiddenSecretKeys<T[K]>
              : never;
          }[keyof T]
        : never;

/**
 * Self-annotating proof: `SecretFree<T>` is `T` when `T` carries no
 * forbidden key name, and a descriptive error union otherwise. Agent-facing
 * factories may require `SecretFree<T>` inputs to push the guarantee to
 * compile time.
 */
export type SecretFree<T> =
  FindForbiddenSecretKeys<T> extends never ? T : ["FORBIDDEN_SECRET_KEY", FindForbiddenSecretKeys<T>];

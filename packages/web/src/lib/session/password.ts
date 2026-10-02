/**
 * Web-plane password hashing (P3-W1-002).
 *
 * Law 1 (work order): raw passwords NEVER reach model context, logs or
 * artifacts. This module handles password VERIFICATION only — the sign-in
 * route receives a password over the wire, verifies it against a stored
 * scrypt hash, and immediately drops it. Passwords are never stored, never
 * logged, never echoed in errors or test fixtures (fixtures use obviously
 * fake values).
 *
 * Storage format (the ONLY format verify accepts):
 *   scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>
 *
 * - scrypt with N=16384, r=8, p=1, keylen=64 (OWASP 2024 guidance);
 * - salt: 16 random bytes per identity (hex);
 * - verification is CONSTANT-TIME over the derived key (node:crypto
 *   timingSafeEqual) — no early-exit byte comparison;
 * - hash strings are length-capped before parsing so a hostile seed entry
 *   cannot force pathological work.
 *
 * Seed identities carry ONLY the hash (WEB_APP_SEED_USERS). Plaintext
 * passwords have no representation anywhere in this app.
 */

import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { promisify } from "node:util";

/** Promisified scrypt with the options overload (promisify drops it otherwise). */
const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

/** Accepted scrypt parameters (fixed — the format pins them per hash). */
const KEY_LENGTH = 64;
const MAX_HASH_LENGTH = 512;

export interface ScryptParameters {
  readonly N: number;
  readonly r: number;
  readonly p: number;
}

/** The default parameters new hashes are minted with. */
export const DEFAULT_SCRYPT_PARAMETERS: ScryptParameters = {
  N: 16384,
  r: 8,
  p: 1,
};

/** Serialized password hash: `scrypt$N$r$p$saltHex$hashHex`. */
export type PasswordHash = string & { readonly __passwordHash: unique symbol };

/**
 * Hash a password with the given parameters (used by the seed-generation
 * helper; the app itself only verifies). The input is used and dropped.
 */
export async function hashPassword(
  password: string,
  parameters: ScryptParameters = DEFAULT_SCRYPT_PARAMETERS,
): Promise<PasswordHash> {
  const salt = randomBytes(16);
  const derived = (await scrypt(password, salt, KEY_LENGTH, {
    N: parameters.N,
    r: parameters.r,
    p: parameters.p,
  })) as Buffer;
  return `scrypt$${parameters.N}$${parameters.r}$${parameters.p}$${salt.toString("hex")}$${derived.toString("hex")}` as PasswordHash;
}

function isHex(value: string, expectedBytes?: number): boolean {
  if (expectedBytes !== undefined && value.length !== expectedBytes * 2) {
    return false;
  }
  return /^[0-9a-f]+$/i.test(value);
}

/**
 * Verify a candidate password against a stored hash. CONSTANT-TIME on the
 * derived key; malformed stored hashes fail CLOSED (false) rather than
 * throwing — a corrupt seed entry must never become a login bypass.
 */
export async function verifyPassword(
  candidate: string,
  stored: string,
): Promise<boolean> {
  if (typeof stored !== "string" || stored.length === 0 || stored.length > MAX_HASH_LENGTH) {
    return false;
  }
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    return false;
  }
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const saltHex = parts[4] ?? "";
  const hashHex = parts[5] ?? "";
  if (
    !Number.isInteger(N) || N <= 0 || N > 2 ** 22 ||
    !Number.isInteger(r) || r <= 0 || r > 1024 ||
    !Number.isInteger(p) || p <= 0 || p > 128 ||
    !isHex(saltHex, 16) ||
    !isHex(hashHex, KEY_LENGTH)
  ) {
    return false;
  }
  let derived: Buffer;
  try {
    derived = (await scrypt(candidate, Buffer.from(saltHex, "hex"), KEY_LENGTH, { N, r, p })) as Buffer;
  } catch {
    return false;
  }
  const expected = Buffer.from(hashHex, "hex");
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/** True when a seed entry's hash string has the shape verify accepts. */
export function isPlausiblePasswordHash(stored: string): boolean {
  if (typeof stored !== "string" || stored.length === 0 || stored.length > MAX_HASH_LENGTH) {
    return false;
  }
  const parts = stored.split("$");
  return parts.length === 6 && parts[0] === "scrypt" && isHex(parts[4] ?? "", 16);
}

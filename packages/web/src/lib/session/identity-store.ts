/**
 * Web-plane identity store (P3-W1-002).
 *
 * The honest session architecture: the deployed PaySwap API exposes NO public
 * identity/session-issuance endpoint — API sessions are minted
 * programmatically through an internal, secret-gated surface. The web app
 * therefore runs its OWN identity boundary for "who the user is to THIS
 * app" (never financial authority — authority stays in the PaySwap API).
 *
 * This module is that boundary's store, with a documented interface so a
 * durable implementation (edge KV, Postgres) can replace the in-memory one
 * without touching any consumer:
 *
 *   interface IdentityStore { lookup(normalizedEmail): WebIdentityRecord | undefined }
 *
 * Seeding is RUNTIME-CONFIGURED via `WEB_APP_SEED_USERS` (a JSON array of
 * `{ email, displayName?, passwordHash }` entries where passwordHash is the
 * scrypt format from password.ts). Seed values are NEVER committed to this
 * repository; parse failures fail CLOSED (the identity plane renders its
 * honest "not configured" state) and error messages carry NO seed values.
 *
 * HONEST LIMITATION (documented in place): the default store is in-memory
 * and process-local. Restarting the process forgets identities — sign-in
 * then honestly fails with the not-configured state until the env is
 * provided again. Sessions issued before the restart remain verifiable only
 * while the process lives; the cookie expires honestly either way.
 */

import { isPlausiblePasswordHash } from "./password.js";

/** The env var that carries the seed identities at runtime (name only — never a value). */
export const SEED_USERS_ENV_VAR = "WEB_APP_SEED_USERS" as const;

/** One web-plane identity. The password HASH is the only credential material. */
export interface WebIdentityRecord {
  /** Normalized email (lowercase, trimmed) — the lookup key. */
  readonly email: string;
  readonly displayName: string;
  /** scrypt$N$r$p$saltHex$hashHex — verified constant-time; never plaintext. */
  readonly passwordHash: string;
}

/** The documented store interface (swap in a durable store without consumers changing). */
export interface IdentityStore {
  lookup(normalizedEmail: string): Promise<WebIdentityRecord | undefined>;
  count(): number;
}

/** In-memory store (the documented default; process-local — see module docs). */
export class InMemoryIdentityStore implements IdentityStore {
  readonly #byEmail = new Map<string, WebIdentityRecord>();

  constructor(records: readonly WebIdentityRecord[]) {
    for (const record of records) {
      this.#byEmail.set(record.email, record);
    }
  }

  lookup(normalizedEmail: string): Promise<WebIdentityRecord | undefined> {
    return Promise.resolve(this.#byEmail.get(normalizedEmail));
  }

  count(): number {
    return this.#byEmail.size;
  }
}

/** Why the identity plane is not configured (env var NAMES only in messages). */
export type IdentityPlaneNotConfiguredReason =
  | "unset"
  | "blank"
  | "invalid-json"
  | "invalid-entries";

export type IdentityPlaneSeedResult =
  | {
      readonly configured: true;
      readonly store: IdentityStore;
      /** The parsed records (server-side registration bookkeeping only). */
      readonly records: readonly WebIdentityRecord[];
    }
  | {
      readonly configured: false;
      readonly reason: IdentityPlaneNotConfiguredReason;
      /** Honest, value-free explanation for logs/UI (never contains seed material). */
      readonly detail: string;
    };

const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{1,24}$/;

/** Normalize an email for lookup/seed keys (lowercase + trim). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Minimal honest email shape check (not an RFC validator — a boundary guard). */
export function isValidEmailShape(email: string): boolean {
  return email.length <= 254 && EMAIL_PATTERN.test(email);
}

interface RawSeedEntry {
  readonly email?: unknown;
  readonly displayName?: unknown;
  readonly passwordHash?: unknown;
}

function isRawEntry(value: unknown): value is RawSeedEntry {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse the `WEB_APP_SEED_USERS` payload into a store. Fail-closed: any
 * malformed entry invalidates the WHOLE seed (a partially-configured
 * identity plane would be silently wrong; better honestly unconfigured).
 * The result's messages never echo seed values.
 */
export function seedIdentityStore(raw: string | undefined): IdentityPlaneSeedResult {
  if (typeof raw !== "string") {
    return {
      configured: false,
      reason: "unset",
      detail: `${SEED_USERS_ENV_VAR} is not set — no web-plane identities exist in this deployment.`,
    };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return {
      configured: false,
      reason: "blank",
      detail: `${SEED_USERS_ENV_VAR} is blank — no web-plane identities exist in this deployment.`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return {
      configured: false,
      reason: "invalid-json",
      detail: `${SEED_USERS_ENV_VAR} is not valid JSON — the identity plane stays unconfigured rather than partially loaded.`,
    };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return {
      configured: false,
      reason: "invalid-entries",
      detail: `${SEED_USERS_ENV_VAR} must be a non-empty JSON array of { email, displayName?, passwordHash } entries.`,
    };
  }
  const records: WebIdentityRecord[] = [];
  const seen = new Set<string>();
  for (const entry of parsed) {
    if (!isRawEntry(entry)) {
      return {
        configured: false,
        reason: "invalid-entries",
        detail: `${SEED_USERS_ENV_VAR} contains a non-object entry — the identity plane stays unconfigured.`,
      };
    }
    if (typeof entry.email !== "string" || !isValidEmailShape(normalizeEmail(entry.email))) {
      return {
        configured: false,
        reason: "invalid-entries",
        detail: `${SEED_USERS_ENV_VAR} contains an entry with an invalid email — the identity plane stays unconfigured.`,
      };
    }
    if (typeof entry.passwordHash !== "string" || !isPlausiblePasswordHash(entry.passwordHash)) {
      return {
        configured: false,
        reason: "invalid-entries",
        detail: `${SEED_USERS_ENV_VAR} contains an entry whose passwordHash is not the required scrypt$… format — the identity plane stays unconfigured.`,
      };
    }
    const email = normalizeEmail(entry.email);
    if (seen.has(email)) {
      return {
        configured: false,
        reason: "invalid-entries",
        detail: `${SEED_USERS_ENV_VAR} contains a duplicate email — the identity plane stays unconfigured.`,
      };
    }
    seen.add(email);
    records.push({
      email,
      displayName:
        typeof entry.displayName === "string" && entry.displayName.trim().length > 0
          ? entry.displayName.trim().slice(0, 80)
          : email,
      passwordHash: entry.passwordHash,
    });
  }
  return { configured: true, store: new InMemoryIdentityStore(records), records };
}

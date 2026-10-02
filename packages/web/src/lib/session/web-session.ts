/**
 * The web session plane (P3-W1-002) — the real server-side session manager
 * for THIS app's identity boundary, built ON the REAL @payswap/api
 * SessionManager.
 *
 * Architecture (the honest session doctrine):
 *
 * - Session issuance/lookup/revocation is delegated ENTIRELY to
 *   `@payswap/api`'s `SessionManager` (branded `SessionToken`, sessions
 *   binding principal + tenant + security epoch AT ISSUE TIME, fail-closed
 *   lookup with UNKNOWN_TOKEN / REVOKED / EXPIRED / STALE_SECURITY_EPOCH
 *   reasons). This module registers a web-app tenant + the env-seeded
 *   identities into that manager and never bypasses it.
 * - The identity plane is REAL but honestly scoped: identities come from
 *   `WEB_APP_SEED_USERS` (scrypt hashes only — never committed); the
 *   session signing key comes from `WEB_APP_SESSION_SIGNING_KEY` (a
 *   deployment secret — name referenced, value never in Git). When either
 *   is absent the plane is NOT CONFIGURED and sign-in renders the honest
 *   state (the Wave-1 /app gate pattern) instead of pretending.
 * - The web identity is NOT financial authority: financial authority stays
 *   in the PaySwap API (mandates + grants). This plane answers exactly one
 *   question — "who is the user to this app".
 * - Password verification is scrypt, constant-time; unknown emails burn a
 *   dummy verification so timing does not enumerate identities.
 *
 * HONEST LIMITATIONS (documented in place, never hidden):
 * - the identity store and session table are the SessionManager's
 *   in-memory maps: process-local. A restart signs everyone out (fail
 *   closed — sessions never survive on the client alone).
 */

import {
  SessionManager,
  asSessionSigningKey,
  type Session,
} from "@payswap/api";
import type { ProtocolClock, TimestampMs } from "@payswap/protocol";
import { EpochLedger } from "@payswap/trust";
import type { UserPrincipal } from "@payswap/trust";
import { principalRef } from "@payswap/trust";

import { mintCsrfToken, verifyCsrfToken } from "./csrf.js";
import {
  SEED_USERS_ENV_VAR,
  seedIdentityStore,
  type IdentityStore,
  type WebIdentityRecord,
} from "./identity-store.js";
import { hashPassword, verifyPassword } from "./password.js";
import { SignInRateLimiter } from "./rate-limit.js";
import { SESSION_TTL_MS } from "./cookies.js";

/** The env var carrying the session signing key (name only — never a value). */
export const SESSION_SIGNING_KEY_ENV_VAR = "WEB_APP_SESSION_SIGNING_KEY" as const;

/** The web app's own tenant in the real SessionManager. */
export const WEB_APP_TENANT_ID = "web-app" as const;

/** Fail-closed lookup reasons, surfaced verbatim to the UI layer. */
export type WebSessionLookupReason =
  | "UNKNOWN_TOKEN"
  | "REVOKED"
  | "EXPIRED"
  | "STALE_SECURITY_EPOCH";

/** The session view the UI may see — NEVER the token itself. */
export interface WebSessionView {
  readonly principalRef: string;
  readonly email: string;
  readonly displayName: string;
  readonly tenantId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export type WebSessionLookup =
  | { readonly valid: true; readonly view: WebSessionView }
  | { readonly valid: false; readonly reason: WebSessionLookupReason };

export type SignInOutcome =
  | { readonly status: "ok"; readonly sessionToken: string; readonly csrfToken: string; readonly view: WebSessionView }
  | { readonly status: "invalid-input"; readonly message: string }
  | { readonly status: "not-configured"; readonly detail: string }
  | { readonly status: "rate-limited"; readonly retryAfterSeconds: number; readonly failures: number }
  | { readonly status: "invalid-credentials"; readonly message: string };

/** Why the plane is unconfigured (env var NAMES only — never values). */
export interface WebSessionPlaneState {
  readonly configured: false;
  readonly missingEnvVars: readonly string[];
  readonly detail: string;
}

/**
 * Wall-clock adapter for the real SessionManager (the composition-root
 * `SystemProtocolClock` role; domain code never reads the host clock
 * directly — this is the edge). `monotonic()` is a strictly increasing
 * counter so deterministically-keyed token mints stay unique per process.
 */
export class SystemWebClock implements ProtocolClock {
  #monotonic: bigint;

  constructor() {
    this.#monotonic = BigInt(Date.now()) * 1000n;
  }

  now(): TimestampMs {
    return BigInt(Date.now());
  }

  monotonic(): bigint {
    this.#monotonic += 1n;
    return this.#monotonic;
  }
}

/** A clock fully injected for tests (deterministic time + sequence). */
export class InjectedWebClock implements ProtocolClock {
  #sequence = 0n;
  constructor(
    private readonly nowMs: () => number,
    private readonly step: bigint = 1n,
  ) {}
  now(): TimestampMs {
    return BigInt(this.nowMs());
  }
  monotonic(): bigint {
    this.#sequence += this.step;
    return this.#sequence;
  }
}

const INVALID_CREDENTIALS_MESSAGE =
  "Email or password is incorrect." as const;

/** Build a web session plane from explicit raw inputs (tests inject; the app passes env). */
export async function buildWebSessionPlane(input: {
  readonly seedUsersRaw: string | undefined;
  readonly signingKeyRaw: string | undefined;
  readonly clock?: ProtocolClock;
  readonly now?: () => number;
}): Promise<WebSessionPlane | UnconfiguredWebSessionPlane> {
  const seed = seedIdentityStore(input.seedUsersRaw);
  const signingKeyRaw = typeof input.signingKeyRaw === "string" ? input.signingKeyRaw.trim() : "";
  const signingKeyMissing = `${SESSION_SIGNING_KEY_ENV_VAR} is not set — session tokens cannot be signed in this deployment.`;

  if (!seed.configured) {
    if (signingKeyRaw.length === 0) {
      return {
        configured: false as const,
        missingEnvVars: [SEED_USERS_ENV_VAR, SESSION_SIGNING_KEY_ENV_VAR],
        detail: `${seed.detail} ${signingKeyMissing}`,
      };
    }
    return {
      configured: false as const,
      missingEnvVars: [SEED_USERS_ENV_VAR],
      detail: seed.detail,
    };
  }
  if (signingKeyRaw.length === 0) {
    return {
      configured: false as const,
      missingEnvVars: [SESSION_SIGNING_KEY_ENV_VAR],
      detail: signingKeyMissing,
    };
  }

  // Both inputs exist — parse the signing key through the real validator
  // (fail closed to the honest state if it is malformed).
  let signingKey;
  try {
    signingKey = asSessionSigningKey(signingKeyRaw);
  } catch {
    return {
      configured: false as const,
      missingEnvVars: [SESSION_SIGNING_KEY_ENV_VAR],
      detail: `${SESSION_SIGNING_KEY_ENV_VAR} is malformed — the session plane stays unconfigured rather than signing with a bad key.`,
    };
  }

  const clock = input.clock ?? new SystemWebClock();
  const manager = new SessionManager({
    clock,
    tokenSigningKey: signingKey,
    epochLedger: new EpochLedger(),
  });
  manager.registerTenant({ id: WEB_APP_TENANT_ID, name: "PaySwap web app" });

  // Seed identities become registered principals in the real manager.
  const store: IdentityStore = seed.store;
  for (const record of seed.records) {
    manager.registerIdentity({
      tenantId: WEB_APP_TENANT_ID,
      principal: {
        kind: "user",
        id: record.email,
        securityEpoch: 0n,
      } satisfies UserPrincipal,
      displayName: record.displayName,
    });
  }

  return new WebSessionPlane({
    manager,
    signingKey: signingKeyRaw,
    store,
    identities: seed.records,
    now: input.now ?? (() => Date.now()),
  });
}

/** The configured plane: every session operation goes through the real manager. */
export class WebSessionPlane {
  readonly #manager: SessionManager;
  readonly #signingKey: string;
  readonly #store: IdentityStore;
  readonly #rateLimiter: SignInRateLimiter;
  readonly #identities: readonly WebIdentityRecord[];
  #dummyHashPromise: Promise<string> | undefined;

  constructor(input: {
    readonly manager: SessionManager;
    readonly signingKey: string;
    readonly store: IdentityStore;
    readonly identities: readonly WebIdentityRecord[];
    readonly now: () => number;
  }) {
    this.#manager = input.manager;
    this.#signingKey = input.signingKey;
    this.#store = input.store;
    this.#identities = input.identities;
    this.#rateLimiter = new SignInRateLimiter(input.now);
  }

  /** Honest configuration marker (discriminated union companion). */
  readonly configured = true as const;

  /** Number of seeded identities (a count — never the identities themselves). */
  identityCount(): number {
    return this.#identities.length;
  }

  /** Emails are enumerable INSIDE the server plane only (registration bookkeeping). */
  *emails(): Iterable<string> {
    for (const record of this.#identities) {
      yield record.email;
    }
  }

  /**
   * Verify credentials and issue a session through the REAL manager.
   * Fail-closed and non-enumerating: identical outcomes for unknown email
   * and wrong password (message and, approximately, timing).
   */
  async signIn(email: string, password: string): Promise<SignInOutcome> {
    if (typeof email !== "string" || typeof password !== "string" || password.length === 0) {
      return { status: "invalid-input", message: "Email and password are required." };
    }
    const normalized = email.trim().toLowerCase();
    if (normalized.length === 0 || normalized.length > 254 || !normalized.includes("@")) {
      return { status: "invalid-input", message: "Enter a valid email address." };
    }

    const decision = this.#rateLimiter.check(normalized);
    if (!decision.allowed) {
      return {
        status: "rate-limited",
        retryAfterSeconds: decision.retryAfterSeconds ?? 1,
        failures: decision.failures,
      };
    }

    const record = await this.#store.lookup(normalized);
    let passwordOk: boolean;
    if (record === undefined) {
      // Timing equalizer: burn a real scrypt verification against a dummy
      // hash so an unknown email costs the same as a wrong password.
      const dummy = await this.#dummyHash();
      passwordOk = await verifyPassword(password, dummy);
    } else {
      passwordOk = await verifyPassword(password, record.passwordHash);
    }

    if (record === undefined || !passwordOk) {
      this.#rateLimiter.recordFailure(normalized);
      return { status: "invalid-credentials", message: INVALID_CREDENTIALS_MESSAGE };
    }

    this.#rateLimiter.recordSuccess(normalized);
    const session = this.#manager.issueSession({
      tenantId: WEB_APP_TENANT_ID,
      principalRef: principalRef({ kind: "user", id: record.email, securityEpoch: 0n }),
      ttlMs: SESSION_TTL_MS,
    });
    return {
      status: "ok",
      sessionToken: session.token,
      csrfToken: mintCsrfToken(session.token, this.#signingKey),
      view: this.#viewForSession(session, record),
    };
  }

  /** Fail-closed session lookup with the real manager's verbatim reasons. */
  lookup(sessionToken: string): WebSessionLookup {
    const result = this.#manager.lookupSession(sessionToken);
    if (!result.valid) {
      return { valid: false, reason: result.reason };
    }
    const email = result.session.principal.kind === "user" ? result.session.principal.id : "";
    const record = this.#identities.find((candidate) => candidate.email === email);
    return { valid: true, view: this.#viewForSession(result.session, record) };
  }

  /** Revoke a session (sign-out). Returns whether a live session was revoked. */
  revoke(sessionToken: string): boolean {
    return this.#manager.revokeSession(sessionToken);
  }

  /** CSRF material for a session token (see csrf.ts — bound, stateless). */
  csrfTokenFor(sessionToken: string): string {
    return mintCsrfToken(sessionToken, this.#signingKey);
  }

  /** Verify a submitted CSRF token against the session it rides on. */
  verifyCsrf(submitted: string | undefined, sessionToken: string): boolean {
    return verifyCsrfToken(submitted, sessionToken, this.#signingKey);
  }

  #viewForSession(session: Session, record?: WebIdentityRecord): WebSessionView {
    const email = session.principal.kind === "user" ? session.principal.id : "unknown";
    return {
      principalRef: principalRef(session.principal),
      email,
      displayName: record?.displayName ?? email,
      tenantId: session.tenantId,
      issuedAt: Number(session.issuedAt),
      expiresAt: Number(session.expiresAt),
    };
  }

  async #dummyHash(): Promise<string> {
    this.#dummyHashPromise ??= hashPassword(
      `timing-equalizer-${Math.random()}`,
    );
    return this.#dummyHashPromise;
  }
}

export type ConfiguredWebSessionPlane = WebSessionPlane;

/** The honest unconfigured plane: every operation fails closed into the honest state. */
export interface UnconfiguredWebSessionPlane extends WebSessionPlaneState {
  readonly configured: false;
}

export type AnyWebSessionPlane = WebSessionPlane | UnconfiguredWebSessionPlane;

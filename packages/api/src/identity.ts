/**
 * @payswap/api — multi-tenant identity and session flows (W3-002).
 *
 * FROZEN-ARCHITECTURE §5/§17, INV-A02, INV-S02, AGENTS.md rules 1/10:
 * - Identity is per-tenant; an IdentityRecord maps a tenant-local user or
 *   service identity onto a @payswap/trust Principal (the authenticated actor
 *   reference presented to authorization evaluation). Identity is not
 *   authority: authority travels exclusively through mandates and grants.
 * - Sessions bind principal + tenant + security epoch AT ISSUE TIME. A
 *   session whose principal's credential epoch has been raised (revocation
 *   event) is stale and fails closed on lookup — a stale credential can
 *   never authorize a sensitive action (INV-A02).
 * - Token issuance is DETERMINISTIC: HMAC-SHA256 over canonical material
 *   using an injected signing key, an injected clock and the clock's strictly
 *   increasing monotonic sequence. Ambient entropy and host randomness are
 *   never used (runbook: deterministic authority).
 *
 * PRODUCTION NOTE: SessionSigningKey must be injected from a secrets vault
 * by the composition root. Tests inject deterministic keys.
 */

import { createHmac } from 'node:crypto';

import { canonicalJson } from '@payswap/interfaces';
import type { ProtocolClock, TimestampMs } from '@payswap/protocol';
import { ValidationError } from '@payswap/protocol';
import type { EpochLedger, Principal } from '@payswap/trust';
import { principalRef } from '@payswap/trust';

/** A tenant of the multi-tenant API surface. */
export interface Tenant {
  readonly id: string;
  readonly name: string;
}

/** Key material for deterministic session-token derivation. */
export type SessionSigningKey = string & { readonly __sessionSigningKey: unique symbol };

/** Branded, validated session token issued by the SessionManager. */
export type SessionToken = string & { readonly __sessionToken: unique symbol };

/**
 * Brand a validated string as a SessionSigningKey.
 * Production keys come from a vault; tests inject deterministic keys.
 */
export function asSessionSigningKey(value: string): SessionSigningKey {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError('SessionSigningKey must be a non-empty string');
  }
  if (value.length > 512) {
    throw new ValidationError('SessionSigningKey must not exceed 512 characters');
  }
  return value as SessionSigningKey;
}

/** A registered identity: a tenant-local principal mapping (user or service). */
export interface IdentityRecord {
  readonly tenantId: string;
  /** The trust principal this identity maps to (user or service kind). */
  readonly principal: Principal;
  readonly displayName: string;
  readonly registeredAt: TimestampMs;
}

/**
 * An issued session. Binds principal + tenant + security epoch at issue time
 * (INV-A02: the epoch is the credential epoch the session was minted under).
 */
export interface Session {
  readonly token: SessionToken;
  readonly tenantId: string;
  readonly principal: Principal;
  /** Security epoch of the principal's credential at issue time. */
  readonly securityEpoch: bigint;
  readonly issuedAt: TimestampMs;
  readonly expiresAt: TimestampMs;
}

/** Result of a session lookup. Invalid sessions fail closed, with a reason. */
export type SessionLookup =
  | { readonly valid: true; readonly session: Session }
  | {
      readonly valid: false;
      readonly reason: 'UNKNOWN_TOKEN' | 'REVOKED' | 'EXPIRED' | 'STALE_SECURITY_EPOCH';
    };

export interface SessionManagerDeps {
  readonly clock: ProtocolClock;
  readonly tokenSigningKey: SessionSigningKey;
  /** Epoch ledger consulted at lookup time so raised epochs invalidate sessions. */
  readonly epochLedger: EpochLedger;
}

export interface RegisterIdentityInput {
  readonly tenantId: string;
  readonly principal: Principal;
  readonly displayName: string;
}

export interface IssueSessionInput {
  readonly tenantId: string;
  /** Canonical principal reference (e.g. `user:alice`) as produced by @payswap/trust principalRef(). */
  readonly principalRef: string;
  readonly ttlMs: number | bigint;
}

function requireNonEmpty(value: string, label: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`${label} must be a non-empty string`);
  }
}

function toBigIntMs(value: number | bigint, label: string): bigint {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value <= 0) {
      throw new ValidationError(`${label} must be a positive integer number of milliseconds`);
    }
    return BigInt(value);
  }
  if (value <= 0n) {
    throw new ValidationError(`${label} must be a positive bigint of milliseconds`);
  }
  return value;
}

/**
 * Session issuance and validation.
 *
 * - registerTenant / registerIdentity build the tenant-local identity table;
 *   only user and service principals are session-issuable (agent principals
 *   authenticate via agent keys, not interactive sessions — §5);
 * - issueSession mints a deterministic token via HMAC-SHA256 over the
 *   canonical session material;
 * - lookupSession validates existence, revocation, expiry (injected clock)
 *   and epoch staleness (injected ledger) — fail closed on every failure;
 * - revokeSession / revokePrincipalSessions implement revocation (used e.g.
 *   when a security epoch is raised).
 */
export class SessionManager {
  readonly #clock: ProtocolClock;
  readonly #signingKey: SessionSigningKey;
  readonly #epochLedger: EpochLedger;
  readonly #tenants = new Map<string, Tenant>();
  readonly #identities = new Map<string, IdentityRecord>();
  readonly #sessionsByToken = new Map<string, Session>();
  readonly #revokedTokens = new Set<string>();
  readonly #tokensByPrincipal = new Map<string, Set<string>>();

  constructor(deps: SessionManagerDeps) {
    this.#clock = deps.clock;
    this.#signingKey = deps.tokenSigningKey;
    this.#epochLedger = deps.epochLedger;
  }

  registerTenant(tenant: Tenant): void {
    requireNonEmpty(tenant.id, 'tenant.id');
    requireNonEmpty(tenant.name, 'tenant.name');
    this.#tenants.set(tenant.id, Object.freeze({ ...tenant }));
  }

  getTenant(tenantId: string): Tenant | undefined {
    return this.#tenants.get(tenantId);
  }

  registerIdentity(input: RegisterIdentityInput): IdentityRecord {
    requireNonEmpty(input.tenantId, 'tenantId');
    requireNonEmpty(input.displayName, 'displayName');
    if (this.#tenants.get(input.tenantId) === undefined) {
      throw new ValidationError(`unknown tenant: ${input.tenantId}`);
    }
    if (input.principal.kind === 'agent') {
      throw new ValidationError(
        'agent principals authenticate via agent keys, not tenant sessions (FROZEN-ARCHITECTURE §5)',
      );
    }
    const record: IdentityRecord = Object.freeze({
      tenantId: input.tenantId,
      principal: input.principal,
      displayName: input.displayName,
      registeredAt: this.#clock.now(),
    });
    this.#identities.set(this.#identityKey(input.tenantId, principalRef(input.principal)), record);
    return record;
  }

  getIdentity(tenantId: string, ref: string): IdentityRecord | undefined {
    return this.#identities.get(this.#identityKey(tenantId, ref));
  }

  issueSession(input: IssueSessionInput): Session {
    requireNonEmpty(input.tenantId, 'tenantId');
    requireNonEmpty(input.principalRef, 'principalRef');
    if (this.#tenants.get(input.tenantId) === undefined) {
      throw new ValidationError(`unknown tenant: ${input.tenantId}`);
    }
    const identity = this.#identities.get(this.#identityKey(input.tenantId, input.principalRef));
    if (identity === undefined) {
      throw new ValidationError(
        `no identity registered in tenant ${input.tenantId} for principal ${input.principalRef}`,
      );
    }
    const ttlMs = toBigIntMs(input.ttlMs, 'ttlMs');
    const issuedAt = this.#clock.now();
    const expiresAt = issuedAt + ttlMs;
    const securityEpoch =
      identity.principal.kind === 'service' ? 0n : identity.principal.securityEpoch;
    const token = this.#mintToken(
      input.tenantId,
      input.principalRef,
      securityEpoch,
      issuedAt,
      this.#clock.monotonic(),
    );
    const session: Session = Object.freeze({
      token,
      tenantId: input.tenantId,
      principal: identity.principal,
      securityEpoch,
      issuedAt,
      expiresAt,
    });
    this.#sessionsByToken.set(token, session);
    let tokens = this.#tokensByPrincipal.get(input.principalRef);
    if (tokens === undefined) {
      tokens = new Set<string>();
      this.#tokensByPrincipal.set(input.principalRef, tokens);
    }
    tokens.add(token);
    return session;
  }

  lookupSession(token: string): SessionLookup {
    const session = this.#sessionsByToken.get(token);
    if (session === undefined) {
      return { valid: false, reason: 'UNKNOWN_TOKEN' };
    }
    if (this.#revokedTokens.has(token)) {
      return { valid: false, reason: 'REVOKED' };
    }
    if (this.#clock.now() >= session.expiresAt) {
      return { valid: false, reason: 'EXPIRED' };
    }
    // INV-A02: a session minted under a superseded credential epoch is stale
    // and can never authorize a sensitive action. Fail closed.
    const ref = principalRef(session.principal);
    const current = this.#epochLedger.currentEpoch(ref);
    if (current !== undefined && session.securityEpoch < current.value) {
      return { valid: false, reason: 'STALE_SECURITY_EPOCH' };
    }
    return { valid: true, session };
  }

  revokeSession(token: string): boolean {
    const session = this.#sessionsByToken.get(token);
    if (session === undefined || this.#revokedTokens.has(token)) {
      return false;
    }
    this.#revokedTokens.add(token);
    return true;
  }

  /** Revoke every live session of a principal (e.g. after an epoch raise). */
  revokePrincipalSessions(ref: string): number {
    const tokens = this.#tokensByPrincipal.get(ref);
    if (tokens === undefined) {
      return 0;
    }
    let revoked = 0;
    for (const token of tokens) {
      if (this.#revokedTokens.has(token)) {
        continue;
      }
      this.#revokedTokens.add(token);
      revoked += 1;
    }
    return revoked;
  }

  #identityKey(tenantId: string, ref: string): string {
    return `${tenantId}|${ref}`;
  }

  /**
   * Deterministic token: `sess_` + hex(HMAC-SHA256(key, canonicalJson(material))).
   * Uniqueness within one clock comes from the strictly increasing monotonic
   * sequence — never entropy. Same inputs + same clock state => same token.
   */
  #mintToken(
    tenantId: string,
    ref: string,
    securityEpoch: bigint,
    issuedAt: TimestampMs,
    monotonic: bigint,
  ): SessionToken {
    const material = canonicalJson([
      'payswap.session.v1',
      tenantId,
      ref,
      securityEpoch.toString(),
      issuedAt.toString(),
      monotonic.toString(),
    ]);
    const mac = createHmac('sha256', this.#signingKey).update(material, 'utf8').digest('hex');
    return `sess_${mac}` as SessionToken;
  }
}

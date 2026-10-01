/**
 * Shared deterministic fixtures for the @payswap/api test suite (W3-002).
 *
 * Every dependency is injected: DeterministicClock, IdFactory, deterministic
 * signing keys, in-memory epoch ledger / idempotency registrar. No ambient
 * time, no entropy (worker-runbook: deterministic authority).
 */

import type { ApiHandler, ApiRequest } from '../src/http.js';
import { createApiHandler } from '../src/http.js';
import { ApprovalService, asApprovalSigningKey } from '../src/approvals.js';
import { GrantAuthority } from '../src/grants.js';
import { SessionManager, asSessionSigningKey } from '../src/identity.js';
import { CURRENT_API_VERSION } from '@payswap/interfaces';
import { DeterministicClock, InMemoryIdempotencyRegistrar, createIdFactory } from '@payswap/protocol';
import type { Mandate, PermissionGrant, Principal } from '@payswap/trust';
import { EpochLedger, issueGrant, principalRef } from '@payswap/trust';

/** 2026-09-30T00:00:00Z in epoch milliseconds — the architecture lock date. */
export const CLOCK_SEED_MS = 1_767_052_800_000n;

/** 2100-01-01T00:00:00Z in epoch milliseconds — "far future" mandate expiry. */
export const FAR_FUTURE_MS = 4_102_444_800_000;

export const SESSION_KEY = asSessionSigningKey('test-session-signing-key');
export const APPROVAL_KEY = asApprovalSigningKey('test-approval-signing-key');

export const ALICE: Principal = { kind: 'user', id: 'alice', securityEpoch: 0n };
export const BOB: Principal = { kind: 'user', id: 'bob', securityEpoch: 0n };
export const OWNER: Principal = { kind: 'user', id: 'owner', securityEpoch: 0n };

export interface TestHarness {
  readonly clock: DeterministicClock;
  readonly epochLedger: EpochLedger;
  readonly sessions: SessionManager;
  readonly approvals: ApprovalService;
  readonly grants: GrantAuthority;
  readonly handler: ApiHandler;
  readonly aliceSessionToken: string;
}

export function mandateFixture(overrides: {
  readonly id: string;
  readonly grantee: string;
  readonly actions?: readonly string[];
  readonly resources?: readonly { readonly type: string; readonly resourceId?: string }[];
  readonly perTransactionAmount?: { readonly currency: string; readonly minorUnits: string };
  readonly escalation?: 'require_approval' | 'deny';
  readonly approverRef?: string;
  readonly expiresAt?: number;
}): Mandate {
  return {
    id: overrides.id,
    version: 1,
    grantor: 'user:owner',
    grantee: overrides.grantee,
    actions: overrides.actions ?? ['payments.intent.create'],
    resources: overrides.resources ?? [{ type: 'intent' }],
    ...(overrides.perTransactionAmount === undefined
      ? {}
      : { limits: { perTransactionAmount: overrides.perTransactionAmount } }),
    ...(overrides.escalation === undefined
      ? {}
      : {
          escalation:
            overrides.escalation === 'require_approval'
              ? {
                  onLimitExceeded: 'require_approval' as const,
                  ...(overrides.approverRef === undefined ? {} : { approverRef: overrides.approverRef }),
                }
              : { onLimitExceeded: 'deny' as const },
        }),
    expiresAt: overrides.expiresAt ?? FAR_FUTURE_MS,
    proofRequirements: [],
  };
}

export function grantFixture(mandate: Mandate, grantId: string, issuedAt: number): PermissionGrant {
  return issueGrant(mandate, { grantId, issuedAt });
}

/**
 * Builds a complete deterministic harness around one grants configuration.
 * Registers tenants + identities for alice, bob and the conformance user, and
 * issues alice a live session.
 */
export function buildHarness(grants: readonly PermissionGrant[]): TestHarness {
  const clock = new DeterministicClock(CLOCK_SEED_MS);
  const ids = createIdFactory(clock);
  const epochLedger = new EpochLedger();
  const sessions = new SessionManager({ clock, tokenSigningKey: SESSION_KEY, epochLedger });
  sessions.registerTenant({ id: 'tenant_demo', name: 'Demo Tenant' });
  sessions.registerTenant({ id: 'tenant_conformance', name: 'Conformance Tenant' });
  sessions.registerIdentity({ tenantId: 'tenant_demo', principal: ALICE, displayName: 'Alice' });
  sessions.registerIdentity({ tenantId: 'tenant_demo', principal: BOB, displayName: 'Bob' });
  sessions.registerIdentity({
    tenantId: 'tenant_conformance',
    principal: { kind: 'user', id: 'user_conformance', securityEpoch: 0n },
    displayName: 'Conformance User',
  });
  const approvals = new ApprovalService({ clock, signingKey: APPROVAL_KEY });
  const grantAuthority = new GrantAuthority({ clock, ids, grants, epochLedger, approvals });
  const idempotency = new InMemoryIdempotencyRegistrar();
  const handler = createApiHandler({ clock, ids, sessions, approvals, grants: grantAuthority, idempotency });
  const session = sessions.issueSession({
    tenantId: 'tenant_demo',
    principalRef: principalRef(ALICE),
    ttlMs: 3_600_000,
  });
  return {
    clock,
    epochLedger,
    sessions,
    approvals,
    grants: grantAuthority,
    handler,
    aliceSessionToken: session.token,
  };
}

/** The mandate set used by the W3-001 HTTP conformance suite wrapper. */
export function conformanceGrants(nowMs: number): readonly PermissionGrant[] {
  const mandate = mandateFixture({
    id: 'mand_conformance_payments',
    grantee: 'user:user_conformance',
    actions: ['conformance.payments.accept'],
    resources: [{ type: 'payment' }],
  });
  return [grantFixture(mandate, 'grant_conformance_1', nowMs)];
}

export interface AuthedRequestOptions {
  readonly body?: unknown;
  readonly idempotencyKey?: string;
  readonly principal?: string;
  readonly sessionToken?: string;
  readonly apiVersion?: string;
}

/** Builds an authenticated ApiRequest (SESSION scheme, alice by default). */
export function authedRequest(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  options?: AuthedRequestOptions,
): ApiRequest {
  const options_: AuthedRequestOptions = options ?? {};
  return {
    method,
    path,
    auth: { principal: options_.principal ?? principalRef(ALICE), scheme: 'SESSION' },
    apiVersion: options_.apiVersion ?? CURRENT_API_VERSION,
    ...(options_.idempotencyKey === undefined ? {} : { idempotencyKey: options_.idempotencyKey }),
    ...(options_.body === undefined ? {} : { body: options_.body }),
    ...(options_.sessionToken === undefined ? {} : { sessionToken: options_.sessionToken }),
  };
}

/** Standard intent amounts (integer minor units — INV-F01). */
export const SMALL_AMOUNT = { currency: 'USD', minorUnits: '5000' };
export const LARGE_AMOUNT = { currency: 'USD', minorUnits: '500000' };

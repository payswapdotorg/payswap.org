import { describe, expect, it } from 'vitest';

import { SessionManager, asSessionSigningKey } from '../src/identity.js';
import { DeterministicClock } from '@payswap/protocol';
import { EpochLedger, principalRef } from '@payswap/trust';

import { ALICE, BOB, CLOCK_SEED_MS, SESSION_KEY } from './fixtures.js';

function buildManager(clock: DeterministicClock, ledger: EpochLedger): SessionManager {
  const manager = new SessionManager({ clock, tokenSigningKey: SESSION_KEY, epochLedger: ledger });
  manager.registerTenant({ id: 'tenant_demo', name: 'Demo Tenant' });
  manager.registerIdentity({ tenantId: 'tenant_demo', principal: ALICE, displayName: 'Alice' });
  manager.registerIdentity({ tenantId: 'tenant_demo', principal: BOB, displayName: 'Bob' });
  return manager;
}

describe('SessionManager (identity.ts)', () => {
  it('issues a session binding principal + tenant + security epoch at issue time', () => {
    const clock = new DeterministicClock(CLOCK_SEED_MS);
    const manager = buildManager(clock, new EpochLedger());
    const session = manager.issueSession({
      tenantId: 'tenant_demo',
      principalRef: principalRef(ALICE),
      ttlMs: 60_000,
    });
    expect(session.tenantId).toBe('tenant_demo');
    expect(principalRef(session.principal)).toBe(principalRef(ALICE));
    expect(session.securityEpoch).toBe(0n);
    expect(session.issuedAt).toBe(CLOCK_SEED_MS);
    expect(session.expiresAt).toBe(CLOCK_SEED_MS + 60_000n);
    expect(session.token.startsWith('sess_')).toBe(true);
  });

  it('looks up a live session by token', () => {
    const clock = new DeterministicClock(CLOCK_SEED_MS);
    const manager = buildManager(clock, new EpochLedger());
    const session = manager.issueSession({
      tenantId: 'tenant_demo',
      principalRef: principalRef(ALICE),
      ttlMs: 60_000,
    });
    const lookup = manager.lookupSession(session.token);
    expect(lookup.valid).toBe(true);
    if (lookup.valid) {
      expect(lookup.session.token).toBe(session.token);
    }
  });

  it('rejects unknown tokens (fail closed)', () => {
    const clock = new DeterministicClock(CLOCK_SEED_MS);
    const manager = buildManager(clock, new EpochLedger());
    const lookup = manager.lookupSession('sess_does_not_exist');
    expect(lookup).toEqual({ valid: false, reason: 'UNKNOWN_TOKEN' });
  });

  it('expires sessions via the injected clock', () => {
    const clock = new DeterministicClock(CLOCK_SEED_MS);
    const manager = buildManager(clock, new EpochLedger());
    const session = manager.issueSession({
      tenantId: 'tenant_demo',
      principalRef: principalRef(ALICE),
      ttlMs: 1_000,
    });
    clock.advanceMs(1_000);
    const lookup = manager.lookupSession(session.token);
    expect(lookup).toEqual({ valid: false, reason: 'EXPIRED' });
  });

  it('revokes individual sessions', () => {
    const clock = new DeterministicClock(CLOCK_SEED_MS);
    const manager = buildManager(clock, new EpochLedger());
    const session = manager.issueSession({
      tenantId: 'tenant_demo',
      principalRef: principalRef(ALICE),
      ttlMs: 60_000,
    });
    expect(manager.revokeSession(session.token)).toBe(true);
    expect(manager.lookupSession(session.token)).toEqual({ valid: false, reason: 'REVOKED' });
    expect(manager.revokeSession(session.token)).toBe(false);
  });

  it('revokes every session of a principal (used after an epoch raise)', () => {
    const clock = new DeterministicClock(CLOCK_SEED_MS);
    const manager = buildManager(clock, new EpochLedger());
    manager.issueSession({ tenantId: 'tenant_demo', principalRef: principalRef(ALICE), ttlMs: 60_000 });
    manager.issueSession({ tenantId: 'tenant_demo', principalRef: principalRef(ALICE), ttlMs: 60_000 });
    const bobSession = manager.issueSession({
      tenantId: 'tenant_demo',
      principalRef: principalRef(BOB),
      ttlMs: 60_000,
    });
    expect(manager.revokePrincipalSessions(principalRef(ALICE))).toBe(2);
    expect(manager.revokePrincipalSessions(principalRef(ALICE))).toBe(0);
    // Bob is untouched.
    expect(manager.lookupSession(bobSession.token).valid).toBe(true);
  });

  it('fails closed on a stale security epoch (INV-A02: raised epochs invalidate sessions)', () => {
    const clock = new DeterministicClock(CLOCK_SEED_MS);
    const ledger = new EpochLedger();
    const manager = buildManager(clock, ledger);
    const session = manager.issueSession({
      tenantId: 'tenant_demo',
      principalRef: principalRef(ALICE),
      ttlMs: 60_000,
    });
    ledger.raiseEpoch(principalRef(ALICE), 'credential rotation', Number(clock.now()));
    const lookup = manager.lookupSession(session.token);
    expect(lookup).toEqual({ valid: false, reason: 'STALE_SECURITY_EPOCH' });
    // A session minted AFTER the raise (epoch 1 credential) stays valid.
    const fresh = { ...ALICE, securityEpoch: 1n };
    manager.registerIdentity({ tenantId: 'tenant_demo', principal: fresh, displayName: 'Alice (epoch 1)' });
    const session2 = manager.issueSession({
      tenantId: 'tenant_demo',
      principalRef: principalRef(fresh),
      ttlMs: 60_000,
    });
    expect(manager.lookupSession(session2.token).valid).toBe(true);
  });

  it('issues deterministic tokens: same inputs + same clock state => same token', () => {
    const managerA = buildManager(new DeterministicClock(CLOCK_SEED_MS), new EpochLedger());
    const managerB = buildManager(new DeterministicClock(CLOCK_SEED_MS), new EpochLedger());
    const tokenA = managerA.issueSession({
      tenantId: 'tenant_demo',
      principalRef: principalRef(ALICE),
      ttlMs: 60_000,
    }).token;
    const tokenB = managerB.issueSession({
      tenantId: 'tenant_demo',
      principalRef: principalRef(ALICE),
      ttlMs: 60_000,
    }).token;
    expect(tokenA).toBe(tokenB);
  });

  it('never repeats a token within one clock (monotonic uniqueness, no entropy)', () => {
    const clock = new DeterministicClock(CLOCK_SEED_MS);
    const manager = buildManager(clock, new EpochLedger());
    const first = manager.issueSession({
      tenantId: 'tenant_demo',
      principalRef: principalRef(ALICE),
      ttlMs: 60_000,
    });
    const second = manager.issueSession({
      tenantId: 'tenant_demo',
      principalRef: principalRef(ALICE),
      ttlMs: 60_000,
    });
    expect(first.token).not.toBe(second.token);
  });

  it('rejects issuance for unknown tenants or unregistered identities (fail closed)', () => {
    const clock = new DeterministicClock(CLOCK_SEED_MS);
    const manager = buildManager(clock, new EpochLedger());
    expect(() =>
      manager.issueSession({ tenantId: 'tenant_missing', principalRef: principalRef(ALICE), ttlMs: 60_000 }),
    ).toThrow(/unknown tenant/);
    expect(() =>
      manager.issueSession({ tenantId: 'tenant_demo', principalRef: 'user:carol', ttlMs: 60_000 }),
    ).toThrow(/no identity registered/);
  });

  it('rejects agent principals for tenant sessions (agents authenticate via keys)', () => {
    const clock = new DeterministicClock(CLOCK_SEED_MS);
    const manager = buildManager(clock, new EpochLedger());
    expect(() =>
      manager.registerIdentity({
        tenantId: 'tenant_demo',
        principal: {
          kind: 'agent',
          agentKeyFingerprint: 'fp',
          ownerRef: 'user:alice',
          bodyRef: 'body:1',
          packageVersionRef: 'pkg:1',
          authorityEnvelope: [],
          securityEpoch: 0n,
        },
        displayName: 'Rogue Agent',
      }),
    ).toThrow(/agent principals/);
  });

  it('rejects non-positive session TTLs', () => {
    const clock = new DeterministicClock(CLOCK_SEED_MS);
    const manager = buildManager(clock, new EpochLedger());
    expect(() =>
      manager.issueSession({ tenantId: 'tenant_demo', principalRef: principalRef(ALICE), ttlMs: 0 }),
    ).toThrow(/ttlMs/);
  });

  it('rejects empty signing keys', () => {
    const clock = new DeterministicClock(CLOCK_SEED_MS);
    expect(() => asSessionSigningKey('')).toThrow(/non-empty/);
    expect(() => new SessionManager({ clock, tokenSigningKey: asSessionSigningKey('x'), epochLedger: new EpochLedger() })).not.toThrow();
  });
});

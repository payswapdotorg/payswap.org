import { describe, expect, it } from 'vitest';

import { DeterministicClock, createIdFactory } from '@payswap/protocol';
import type { AuthorizationRequest, PermissionGrant } from '@payswap/trust';
import { EpochLedger, principalRef } from '@payswap/trust';

import type { ScopedExecutionGrant } from '../src/grants.js';
import { ApprovalArtifactRejectedError, GrantAuthority } from '../src/grants.js';
import { ApprovalService } from '../src/approvals.js';

import {
  ALICE,
  APPROVAL_KEY,
  CLOCK_SEED_MS,
  FAR_FUTURE_MS,
  LARGE_AMOUNT,
  SMALL_AMOUNT,
  grantFixture,
  mandateFixture,
} from './fixtures.js';

const NOW_MS = Number(CLOCK_SEED_MS);

function buildAuthority(grants: readonly PermissionGrant[]) {
  const clock = new DeterministicClock(CLOCK_SEED_MS);
  const ids = createIdFactory(clock);
  const epochLedger = new EpochLedger();
  const approvals = new ApprovalService({ clock, signingKey: APPROVAL_KEY });
  return { clock, ids, epochLedger, approvals, authority: new GrantAuthority({ clock, ids, grants, epochLedger, approvals }) };
}

function authorizationRequest(overrides?: {
  readonly action?: string;
  readonly amount?: { readonly currency: string; readonly minorUnits: string };
  readonly requestHash?: string;
}): AuthorizationRequest {
  return {
    principal: ALICE,
    action: overrides?.action ?? 'payments.intent.create',
    resource: { type: 'intent' },
    context: { ...(overrides?.amount === undefined ? {} : { amount: overrides.amount }) },
    requestHash: overrides?.requestHash ?? 'hash_grants_test',
    requestedAt: NOW_MS,
  };
}

describe('GrantAuthority (grants.ts)', () => {
  it('issues a scoped execution grant from an ALLOW decision, carrying its lineage (INV-E01)', () => {
    const mandate = mandateFixture({ id: 'mand_allow', grantee: principalRef(ALICE) });
    const { authority } = buildAuthority([grantFixture(mandate, 'grant_allow_1', NOW_MS)]);
    const result = authority.adjudicate({
      tenantId: 'tenant_demo',
      principal: ALICE,
      request: authorizationRequest({ amount: SMALL_AMOUNT }),
    });
    expect(result.kind).toBe('GRANT_ISSUED');
    if (result.kind !== 'GRANT_ISSUED') {
      throw new Error('unreachable');
    }
    const grant: ScopedExecutionGrant = result.grant;
    expect(grant.tenantId).toBe('tenant_demo');
    expect(grant.principal).toEqual(ALICE);
    expect(grant.scope.action).toBe('payments.intent.create');
    expect(grant.scope.resource).toEqual({ type: 'intent' });
    expect(grant.scope.amount).toEqual(SMALL_AMOUNT);
    expect(grant.lineage.decisionRef).toBe('decision:hash_grants_test');
    expect(grant.lineage.approvalArtifactRef).toBeUndefined();
    expect(grant.lineage.grantRef).toBe(`grant:${grant.grantId}`);
    expect(grant.issuedAt).toBe(NOW_MS);
    expect(grant.expiresAt).toBe(FAR_FUTURE_MS); // mandate window
    expect(authority.getGrant(grant.grantId)).toBe(grant);
  });

  it('returns NEEDS_APPROVAL (not a grant) when the mandate escalates on limits', () => {
    const mandate = mandateFixture({
      id: 'mand_escalate',
      grantee: principalRef(ALICE),
      perTransactionAmount: { currency: 'USD', minorUnits: '100000' },
      escalation: 'require_approval',
      approverRef: 'user:owner',
    });
    const { authority } = buildAuthority([grantFixture(mandate, 'grant_escalate_1', NOW_MS)]);
    const result = authority.adjudicate({
      tenantId: 'tenant_demo',
      principal: ALICE,
      request: authorizationRequest({ amount: LARGE_AMOUNT }),
    });
    expect(result.kind).toBe('NEEDS_APPROVAL');
    if (result.kind === 'NEEDS_APPROVAL') {
      expect(result.decision.approvalSpec.approverRef).toBe('user:owner');
      expect(result.decision.approvalSpec.scope.actions).toEqual(['payments.intent.create']);
    }
  });

  it('returns DENIED when the mandate denies on limits without escalation', () => {
    const mandate = mandateFixture({
      id: 'mand_deny',
      grantee: principalRef(ALICE),
      perTransactionAmount: { currency: 'USD', minorUnits: '100000' },
      escalation: 'deny',
    });
    const { authority } = buildAuthority([grantFixture(mandate, 'grant_deny_1', NOW_MS)]);
    const result = authority.adjudicate({
      tenantId: 'tenant_demo',
      principal: ALICE,
      request: authorizationRequest({ amount: LARGE_AMOUNT }),
    });
    expect(result.kind).toBe('DENIED');
    if (result.kind === 'DENIED') {
      expect(result.decision.reason).toBe('per_transaction_limit_exceeded');
    }
  });

  it('fails closed when the mandate has expired (W3-002 acceptance: expired authority)', () => {
    const mandate = mandateFixture({
      id: 'mand_expired',
      grantee: principalRef(ALICE),
      expiresAt: NOW_MS - 1,
    });
    const { authority } = buildAuthority([grantFixture(mandate, 'grant_expired_1', NOW_MS)]);
    const result = authority.adjudicate({
      tenantId: 'tenant_demo',
      principal: ALICE,
      request: authorizationRequest({ amount: SMALL_AMOUNT }),
    });
    expect(result.kind).toBe('DENIED');
    if (result.kind === 'DENIED') {
      expect(result.decision.reason).toBe('mandate_expired');
    }
  });

  it('fails closed when the principal credential epoch is stale (W3-002 acceptance: revoked authority, INV-A02)', async () => {
    const mandate = mandateFixture({ id: 'mand_epoch', grantee: principalRef(ALICE) });
    const harness = buildAuthority([grantFixture(mandate, 'grant_epoch_1', NOW_MS)]);
    harness.epochLedger.raiseEpoch(principalRef(ALICE), 'credential rotation', NOW_MS);
    expect(() =>
      harness.authority.adjudicate({
        tenantId: 'tenant_demo',
        principal: ALICE,
        request: authorizationRequest({ amount: SMALL_AMOUNT }),
      }),
    ).toThrow(/Stale security epoch/);
    // The artifact path also fails closed on a stale epoch: mint a VALID
    // artifact first, then raise the epoch, then attempt grant issuance.
    await harness.approvals.createApprovalRequest({
      principal: 'user:owner',
      scope: { actions: ['payments.intent.create'], resources: [{ type: 'intent' }] },
      requestHash: 'hash_epoch_stale',
      expiresAtMs: NOW_MS + 600_000,
      channel: 'IN_APP',
    });
    await harness.approvals.issueSignedApproval(
      harness.approvals.trustedChannelConfirmation({
        principal: 'user:owner',
        requestHash: 'hash_epoch_stale',
        decision: 'APPROVED',
      }),
    );
    expect(() =>
      harness.authority.issueFromApproval({
        tenantId: 'tenant_demo',
        principal: ALICE,
        request: authorizationRequest({ amount: SMALL_AMOUNT, requestHash: 'hash_epoch_stale' }),
        approvalArtifactRef: 'approval:hash_epoch_stale',
      }),
    ).toThrow(/Stale security epoch/);
  });

  it('issues a grant from an approved artifact, carrying the approval lineage (W3-002 acceptance)', async () => {
    const mandate = mandateFixture({
      id: 'mand_escalate_journey',
      grantee: principalRef(ALICE),
      perTransactionAmount: { currency: 'USD', minorUnits: '100000' },
      escalation: 'require_approval',
      approverRef: 'user:owner',
    });
    const harness = buildAuthority([grantFixture(mandate, 'grant_journey_1', NOW_MS)]);
    const request = authorizationRequest({ amount: LARGE_AMOUNT, requestHash: 'hash_journey_1' });

    const needsApproval = harness.authority.adjudicate({
      tenantId: 'tenant_demo',
      principal: ALICE,
      request,
    });
    expect(needsApproval.kind).toBe('NEEDS_APPROVAL');

    // Out-of-band trusted-channel confirmation mints the signed artifact.
    await harness.approvals.createApprovalRequest({
      principal: 'user:owner',
      scope: needsApproval.kind === 'NEEDS_APPROVAL' ? needsApproval.decision.approvalSpec.scope : { actions: [], resources: [] },
      requestHash: 'hash_journey_1',
      expiresAtMs: NOW_MS + 600_000,
      channel: 'IN_APP',
    });
    const confirmation = harness.approvals.trustedChannelConfirmation({
      principal: 'user:owner',
      requestHash: 'hash_journey_1',
      decision: 'APPROVED',
    });
    const signed = await harness.approvals.issueSignedApproval(confirmation);
    const artifactRef = `approval:hash_journey_1`;

    const grant = harness.authority.issueFromApproval({
      tenantId: 'tenant_demo',
      principal: ALICE,
      request,
      approvalArtifactRef: artifactRef,
    });
    // Approved actions CARRY their lineage:
    expect(grant.lineage.decisionRef).toBe('decision:hash_journey_1');
    expect(grant.lineage.approvalArtifactRef).toBe(artifactRef);
    expect(grant.lineage.grantRef).toBe(`grant:${grant.grantId}`);
    expect(grant.expiresAt).toBe(signed.expiry); // grant lives exactly as long as its authority
    expect(grant.scope.amount).toEqual(LARGE_AMOUNT);
  });

  it('rejects unknown artifact references (fail closed)', () => {
    const mandate = mandateFixture({ id: 'mand_unknown_artifact', grantee: principalRef(ALICE) });
    const { authority } = buildAuthority([grantFixture(mandate, 'grant_ua_1', NOW_MS)]);
    expect(() =>
      authority.issueFromApproval({
        tenantId: 'tenant_demo',
        principal: ALICE,
        request: authorizationRequest({ amount: SMALL_AMOUNT }),
        approvalArtifactRef: 'approval:never_minted',
      }),
    ).toThrow(ApprovalArtifactRejectedError);
  });

  it('rejects a tampered artifact (signature verification fails closed)', async () => {
    const mandate = mandateFixture({ id: 'mand_tamper', grantee: principalRef(ALICE) });
    const harness = buildAuthority([grantFixture(mandate, 'grant_tamper_1', NOW_MS)]);
    await harness.approvals.createApprovalRequest({
      principal: 'user:owner',
      scope: { actions: ['payments.intent.create'], resources: [{ type: 'intent' }] },
      requestHash: 'hash_tamper',
      expiresAtMs: NOW_MS + 600_000,
      channel: 'IN_APP',
    });
    const signed = await harness.approvals.issueSignedApproval(
      harness.approvals.trustedChannelConfirmation({
        principal: 'user:owner',
        requestHash: 'hash_tamper',
        decision: 'APPROVED',
      }),
    );
    // Attacker widens the scope after the fact; the HMAC no longer matches.
    const forged = { ...signed, scope: { ...signed.scope, actions: ['payments.*'] } };
    expect(harness.approvals.verifySignedApproval(forged)).toEqual({ valid: false, reason: 'SIGNATURE_INVALID' });
    // And the forged artifact cannot reach the real artifact store:
    expect(harness.approvals.signedArtifactByRef('approval:hash_tamper')?.scope.actions).toEqual([
      'payments.intent.create',
    ]);
  });

  it('rejects an expired artifact (fail closed on expired authority)', async () => {
    const clock = new DeterministicClock(CLOCK_SEED_MS);
    const ids = createIdFactory(clock);
    const epochLedger = new EpochLedger();
    const approvals = new ApprovalService({ clock, signingKey: APPROVAL_KEY });
    const mandate = mandateFixture({ id: 'mand_artifact_expiry', grantee: principalRef(ALICE) });
    const authority = new GrantAuthority({
      clock,
      ids,
      grants: [grantFixture(mandate, 'grant_ae_1', NOW_MS)],
      epochLedger,
      approvals,
    });
    await approvals.createApprovalRequest({
      principal: 'user:owner',
      scope: { actions: ['payments.intent.create'], resources: [{ type: 'intent' }] },
      requestHash: 'hash_artifact_expiry',
      expiresAtMs: NOW_MS + 1_000,
      channel: 'IN_APP',
    });
    await approvals.issueSignedApproval(
      approvals.trustedChannelConfirmation({
        principal: 'user:owner',
        requestHash: 'hash_artifact_expiry',
        decision: 'APPROVED',
      }),
    );
    clock.advanceMs(2_000);
    expect(() =>
      authority.issueFromApproval({
        tenantId: 'tenant_demo',
        principal: ALICE,
        request: authorizationRequest({ requestHash: 'hash_artifact_expiry' }),
        approvalArtifactRef: 'approval:hash_artifact_expiry',
      }),
    ).toThrow(/EXPIRED/);
  });

  it('rejects an artifact bound to a different request (request-hash binding)', async () => {
    const mandate = mandateFixture({ id: 'mand_binding', grantee: principalRef(ALICE) });
    const harness = buildAuthority([grantFixture(mandate, 'grant_binding_1', NOW_MS)]);
    await harness.approvals.createApprovalRequest({
      principal: 'user:owner',
      scope: { actions: ['payments.intent.create'], resources: [{ type: 'intent' }] },
      requestHash: 'hash_binding_original',
      expiresAtMs: NOW_MS + 600_000,
      channel: 'IN_APP',
    });
    await harness.approvals.issueSignedApproval(
      harness.approvals.trustedChannelConfirmation({
        principal: 'user:owner',
        requestHash: 'hash_binding_original',
        decision: 'APPROVED',
      }),
    );
    expect(() =>
      harness.authority.issueFromApproval({
        tenantId: 'tenant_demo',
        principal: ALICE,
        request: authorizationRequest({ requestHash: 'hash_binding_other' }), // different payload
        approvalArtifactRef: 'approval:hash_binding_original',
      }),
    ).toThrow(/request_hash_mismatch/);
  });

  it('artifacts are single-redemption: a consumed artifact cannot issue a second grant', async () => {
    const mandate = mandateFixture({ id: 'mand_single_use', grantee: principalRef(ALICE) });
    const harness = buildAuthority([grantFixture(mandate, 'grant_su_1', NOW_MS)]);
    const request = authorizationRequest({ requestHash: 'hash_single_use' });
    await harness.approvals.createApprovalRequest({
      principal: 'user:owner',
      scope: { actions: ['payments.intent.create'], resources: [{ type: 'intent' }] },
      requestHash: 'hash_single_use',
      expiresAtMs: NOW_MS + 600_000,
      channel: 'IN_APP',
    });
    await harness.approvals.issueSignedApproval(
      harness.approvals.trustedChannelConfirmation({
        principal: 'user:owner',
        requestHash: 'hash_single_use',
        decision: 'APPROVED',
      }),
    );
    const first = harness.authority.issueFromApproval({
      tenantId: 'tenant_demo',
      principal: ALICE,
      request,
      approvalArtifactRef: 'approval:hash_single_use',
    });
    expect(first.lineage.approvalArtifactRef).toBe('approval:hash_single_use');
    expect(() =>
      harness.authority.issueFromApproval({
        tenantId: 'tenant_demo',
        principal: ALICE,
        request,
        approvalArtifactRef: 'approval:hash_single_use',
      }),
    ).toThrow(/already consumed/);
  });
});

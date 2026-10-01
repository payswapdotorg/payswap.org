import { describe, expect, it } from 'vitest';

import type { ApprovalRequest, AuthenticatedApprovalConfirmation } from '@payswap/interfaces';

import {
  approvalArtifactRef,
  completeApprovalOnTrustedSurface,
  expressApprovalIntentFromChat,
  renderApprovalRequest,
  verifyApprovalArtifact,
} from '../src/trusted-approvals.js';
import { allowHarness, NOW_MS } from './fixtures.js';

function approvalRequestFixture(): ApprovalRequest {
  return {
    principal: 'user:alice',
    agentRef: 'agent:helper',
    requestedAuthorityScope: { domain: 'payments', actions: ['payments.intent.create'] },
    requestHash: 'reqhash_ta_1',
    expiresAt: new Date(NOW_MS + 3_600_000).toISOString(),
    channel: 'IN_APP',
  };
}

async function harnessWithPendingApproval() {
  const harness = allowHarness();
  const request = approvalRequestFixture();
  const pending = await harness.approvals.requestApproval(request);
  expect(pending.status).toBe('PENDING');
  return { harness, request };
}

describe('renderApprovalRequest — the trusted surface deep link is always present', () => {
  it('renders through the @payswap/api adapter with the trusted-surface deep link', () => {
    const harness = allowHarness();
    const message = renderApprovalRequest(harness.approvals, approvalRequestFixture());
    expect(message.deepLink).toContain('/approvals/reqhash_ta_1');
    expect(message.text).toContain('APPROVE reqhash_ta_1');
    // The copy itself states that a chat reply is intent only.
    expect(message.text).toContain('trusted approval surface');
  });
});

describe('completeApprovalOnTrustedSurface — the ONLY approval-completion path (INV-A03)', () => {
  it('issues the SIGNED artifact identifying principal, scope, expiry and request hash', async () => {
    const { harness } = await harnessWithPendingApproval();
    const completion = await completeApprovalOnTrustedSurface(harness.approvals, {
      principal: 'user:alice',
      requestHash: 'reqhash_ta_1',
      decision: 'APPROVED',
    });
    expect(completion.outcome).toBe('ARTIFACT_ISSUED');
    if (completion.outcome !== 'ARTIFACT_ISSUED') {
      throw new Error('expected artifact');
    }
    const artifact = completion.artifact;
    expect(artifact.principal).toBe('user:alice');
    expect(artifact.agentRef).toBe('agent:helper');
    expect(artifact.requestHash).toBe('reqhash_ta_1');
    expect(artifact.expiry).toBe(new Date(NOW_MS + 3_600_000).toISOString());
    expect(artifact.scope.actions).toContain('payments.intent.create');
    expect(artifact.signature.length).toBeGreaterThan(0);
    // INV-A03/E04: the signature verifies through the SAME trusted surface.
    expect(await verifyApprovalArtifact(harness.approvals, artifact, 'reqhash_ta_1')).toBe(true);
  });

  it('a REJECTED decision records the rejection and never issues an artifact', async () => {
    const { harness } = await harnessWithPendingApproval();
    const completion = await completeApprovalOnTrustedSurface(harness.approvals, {
      principal: 'user:alice',
      requestHash: 'reqhash_ta_1',
      decision: 'REJECTED',
    });
    expect(completion.outcome).toBe('REJECTION_RECORDED');
  });

  it('rejects malformed decisions (fail closed)', async () => {
    const { harness } = await harnessWithPendingApproval();
    await expect(
      completeApprovalOnTrustedSurface(harness.approvals, {
        principal: '',
        requestHash: 'reqhash_ta_1',
        decision: 'APPROVED',
      }),
    ).rejects.toThrow();
  });
});

describe('expressApprovalIntentFromChat — chat is an INTENT at most, never authority', () => {
  it('parses an APPROVE reply into an intent that still REQUIRES the trusted surface', async () => {
    const harness = allowHarness();
    const outcome = expressApprovalIntentFromChat(harness.approvals, {
      text: 'APPROVE reqhash_ta_1 please',
      senderRef: 'user:alice',
      sentAt: new Date(NOW_MS).toISOString(),
    });
    expect(outcome.kind).toBe('APPROVAL_INTENT');
    if (outcome.kind !== 'APPROVAL_INTENT') {
      throw new Error('expected intent');
    }
    expect(outcome.intent).toBe('APPROVE');
    expect(outcome.requestHash).toBe('reqhash_ta_1');
    expect(outcome.requiresTrustedSurfaceConfirmation).toBe(true);
    expect(outcome.note).toContain('INV-A03');
    // The intent carries NO artifact — there is nothing to consume here.
  });

  it('a non-approval message is NOT_AN_APPROVAL (no intent manufactured)', () => {
    const harness = allowHarness();
    const outcome = expressApprovalIntentFromChat(harness.approvals, {
      text: 'hey, what is the status of my payment?',
      senderRef: 'user:alice',
      sentAt: new Date(NOW_MS).toISOString(),
    });
    expect(outcome.kind).toBe('NOT_AN_APPROVAL');
  });

  it('issuing an artifact from RAW CHAT input is impossible: a forged confirmation is rejected by the trusted surface', async () => {
    const { harness } = await harnessWithPendingApproval();
    // A caller cannot construct an AuthenticatedApprovalConfirmation by hand:
    // anything not produced by the trusted channel seam is rejected
    // (ApprovalPolicyViolationError) — the UX layer adds no bypass.
    const forged: AuthenticatedApprovalConfirmation = {
      principal: 'user:alice',
      requestHash: 'reqhash_ta_1',
      decision: 'APPROVED',
      confirmedAt: new Date(NOW_MS).toISOString(),
      channel: 'IN_APP',
    };
    await expect(harness.approvals.issueArtifact(forged)).rejects.toThrow(
      /never authority|authenticated confirmation/i,
    );
  });
});

describe('approvalArtifactRef', () => {
  it('derives the @payswap/api artifact reference format', () => {
    expect(approvalArtifactRef('reqhash_ta_1')).toBe('approval:reqhash_ta_1');
    expect(() => approvalArtifactRef('')).toThrow();
  });
});

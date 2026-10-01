import { describe, expect, it } from 'vitest';

import type { AuthenticatedApprovalConfirmation } from '@payswap/interfaces';
import { ApprovalPolicyViolationError } from '@payswap/interfaces';
import { DeterministicClock } from '@payswap/protocol';

import { ApprovalService, asApprovalSigningKey } from '../src/approvals.js';
import { runApprovalContractTests } from '@payswap/interfaces';
import type { ApprovalContractSubject } from '@payswap/interfaces';

import { APPROVAL_KEY, CLOCK_SEED_MS } from './fixtures.js';

const REQUEST_HASH = 'hash_test_round_trip_1';

function buildService(clock?: DeterministicClock): ApprovalService {
  return new ApprovalService({ clock: clock ?? new DeterministicClock(CLOCK_SEED_MS), signingKey: APPROVAL_KEY });
}

async function requestRoundTrip(service: ApprovalService): Promise<{ status: string }> {
  const pending = await service.requestApproval({
    principal: 'user:owner',
    requestedAuthorityScope: { domain: 'payments', actions: ['payments.intent.create'] },
    requestHash: REQUEST_HASH,
    expiresAt: '2030-01-01T00:00:00Z',
    channel: 'SMS',
  });
  return pending;
}

describe('ApprovalService (approvals.ts)', () => {
  it('round-trips: request → trusted confirmation → signed artifact → verified', async () => {
    const service = buildService();
    const pending = await requestRoundTrip(service);
    expect(pending.status).toBe('PENDING');
    const confirmation = service.trustedChannelConfirmation({
      principal: 'user:owner',
      requestHash: REQUEST_HASH,
      decision: 'APPROVED',
    });
    const artifact = await service.issueArtifact(confirmation);
    expect(artifact.signature.length).toBe(64); // hex HMAC-SHA256
    const verification = await service.verifyArtifact(artifact, REQUEST_HASH);
    expect(verification.valid).toBe(true);
  });

  it('mints a trust-shaped SignedApprovalArtifact signed over the canonical payload', async () => {
    const service = buildService();
    await requestRoundTrip(service);
    const confirmation = service.trustedChannelConfirmation({
      principal: 'user:owner',
      requestHash: REQUEST_HASH,
      decision: 'APPROVED',
    });
    const signed = await service.issueSignedApproval(confirmation);
    expect(signed.principal).toBe('user:owner');
    expect(signed.requestHash).toBe(REQUEST_HASH);
    expect(signed.expiry).toBe(Date.parse('2030-01-01T00:00:00Z'));
    expect(signed.issuedAt).toBe(Number(CLOCK_SEED_MS));
    expect(service.verifySignedApproval(signed)).toEqual({ valid: true });
    // retrievable by reference for grant issuance:
    expect(service.signedArtifactByRef(`approval:${REQUEST_HASH}`)?.requestHash).toBe(REQUEST_HASH);
  });

  it('REJECTS raw chat text submitted as approval — chat is never authority (INV-A03)', async () => {
    const service = buildService();
    await requestRoundTrip(service);
    const rawChatText = 'yes I approve this payment, please go ahead' as unknown as AuthenticatedApprovalConfirmation;
    await expect(service.issueArtifact(rawChatText)).rejects.toThrow(ApprovalPolicyViolationError);
    await expect(service.issueSignedApproval(rawChatText)).rejects.toThrow(/never authority/);
  });

  it('rejects forged confirmation objects that did not come from the trusted channel', async () => {
    const service = buildService();
    await requestRoundTrip(service);
    const forged = {
      principal: 'user:owner',
      requestHash: REQUEST_HASH,
      decision: 'APPROVED',
      confirmedAt: '2026-09-30T00:00:00Z',
      channel: 'SMS',
    } as unknown as AuthenticatedApprovalConfirmation;
    await expect(service.issueArtifact(forged)).rejects.toThrow(ApprovalPolicyViolationError);
  });

  it('rejects confirmations from a principal other than the authority holder', async () => {
    const service = buildService();
    await requestRoundTrip(service);
    const confirmation = service.trustedChannelConfirmation({
      principal: 'user:attacker',
      requestHash: REQUEST_HASH,
      decision: 'APPROVED',
    });
    await expect(service.issueArtifact(confirmation)).rejects.toThrow(/authority holder/);
  });

  it('a REJECTED decision never issues an artifact', async () => {
    const service = buildService();
    await requestRoundTrip(service);
    const confirmation = service.trustedChannelConfirmation({
      principal: 'user:owner',
      requestHash: REQUEST_HASH,
      decision: 'REJECTED',
    });
    await expect(service.issueArtifact(confirmation)).rejects.toThrow(/REJECTED/);
    expect(service.getApprovalRecord(REQUEST_HASH)?.status).toBe('REJECTED');
  });

  it('rejects expired approval requests (contract: no artifacts from expired requests)', async () => {
    const service = buildService();
    await expect(
      service.requestApproval({
        principal: 'user:owner',
        requestedAuthorityScope: { domain: 'payments', actions: ['payments.intent.create'] },
        requestHash: 'hash_expired',
        expiresAt: '2020-01-01T00:00:00Z',
        channel: 'SMS',
      }),
    ).rejects.toThrow(/expired/);
  });

  it('rejects artifacts for requests that expired between request and confirmation', async () => {
    const clock = new DeterministicClock(CLOCK_SEED_MS);
    const service = buildService(clock);
    await service.requestApproval({
      principal: 'user:owner',
      requestedAuthorityScope: { domain: 'payments', actions: ['payments.intent.create'] },
      requestHash: 'hash_window_elapsed',
      expiresAt: new Date(Number(clock.now()) + 1_000).toISOString(),
      channel: 'IN_APP',
    });
    clock.advanceMs(2_000);
    const confirmation = service.trustedChannelConfirmation({
      principal: 'user:owner',
      requestHash: 'hash_window_elapsed',
      decision: 'APPROVED',
    });
    await expect(service.issueArtifact(confirmation)).rejects.toThrow(/expired/);
  });

  it('verifies tampered artifacts as SIGNATURE_INVALID (scope tampering breaks the HMAC)', async () => {
    const service = buildService();
    await requestRoundTrip(service);
    const confirmation = service.trustedChannelConfirmation({
      principal: 'user:owner',
      requestHash: REQUEST_HASH,
      decision: 'APPROVED',
    });
    const artifact = await service.issueArtifact(confirmation);
    const tampered = {
      ...artifact,
      scope: { domain: 'payments', actions: ['payments.intent.create', 'payments.unlimited'] },
    };
    const verification = await service.verifyArtifact(tampered, REQUEST_HASH);
    expect(verification).toEqual({ valid: false, reason: 'SIGNATURE_INVALID' });
    // Same for the trust-shaped artifact (tampered expiry):
    const signed = await service.issueSignedApproval(confirmation);
    const tamperedSigned = { ...signed, expiry: signed.expiry + 3_600_000 };
    expect(service.verifySignedApproval(tamperedSigned)).toEqual({ valid: false, reason: 'SIGNATURE_INVALID' });
  });

  it('verifies expired artifacts as EXPIRED', async () => {
    const clock = new DeterministicClock(CLOCK_SEED_MS);
    const service = buildService(clock);
    await service.requestApproval({
      principal: 'user:owner',
      requestedAuthorityScope: { domain: 'payments', actions: ['payments.intent.create'] },
      requestHash: 'hash_short_window',
      expiresAt: new Date(Number(clock.now()) + 1_000).toISOString(),
      channel: 'IN_APP',
    });
    const confirmation = service.trustedChannelConfirmation({
      principal: 'user:owner',
      requestHash: 'hash_short_window',
      decision: 'APPROVED',
    });
    const artifact = await service.issueArtifact(confirmation);
    const signed = await service.issueSignedApproval(confirmation);
    clock.advanceMs(2_000);
    expect(await service.verifyArtifact(artifact, 'hash_short_window')).toEqual({ valid: false, reason: 'EXPIRED' });
    expect(service.verifySignedApproval(signed)).toEqual({ valid: false, reason: 'EXPIRED' });
  });

  it('fails verification on request-hash mismatch', async () => {
    const service = buildService();
    await requestRoundTrip(service);
    const confirmation = service.trustedChannelConfirmation({
      principal: 'user:owner',
      requestHash: REQUEST_HASH,
      decision: 'APPROVED',
    });
    const artifact = await service.issueArtifact(confirmation);
    expect(await service.verifyArtifact(artifact, 'hash_of_a_different_request')).toEqual({
      valid: false,
      reason: 'REQUEST_HASH_MISMATCH',
    });
  });

  it('deterministically re-issues the same artifacts for the same approved confirmation', async () => {
    const service = buildService();
    await requestRoundTrip(service);
    const confirmation = service.trustedChannelConfirmation({
      principal: 'user:owner',
      requestHash: REQUEST_HASH,
      decision: 'APPROVED',
    });
    const first = await service.issueArtifact(confirmation);
    const second = await service.issueArtifact(confirmation);
    expect(second).toEqual(first);
  });

  it('creates approval requests from NEEDS_APPROVAL decisions with exact trust scope', async () => {
    const service = buildService();
    const pending = await service.createApprovalRequest({
      principal: 'user:owner',
      scope: {
        actions: ['payments.intent.create'],
        resources: [{ type: 'intent' }],
        maxAmount: { currency: 'USD', minorUnits: '500000' },
      },
      requestHash: 'hash_decision_origin',
      expiresAtMs: Number(CLOCK_SEED_MS) + 600_000,
      channel: 'HARDWARE_KEY',
    });
    expect(pending).toEqual({
      requestHash: 'hash_decision_origin',
      status: 'PENDING',
      channel: 'HARDWARE_KEY',
      expiresAt: new Date(Number(CLOCK_SEED_MS) + 600_000).toISOString(),
    });
    const confirmation = service.trustedChannelConfirmation({
      principal: 'user:owner',
      requestHash: 'hash_decision_origin',
      decision: 'APPROVED',
    });
    const signed = await service.issueSignedApproval(confirmation);
    expect(signed.scope.resources).toEqual([{ type: 'intent' }]);
    expect(signed.scope.maxAmount).toEqual({ currency: 'USD', minorUnits: '500000' });
  });

  it('renders and parses messaging intents only (adapter is UX, never authority)', () => {
    const service = buildService();
    const message = service.renderApprovalMessage({
      principal: 'user:owner',
      requestedAuthorityScope: { domain: 'payments', actions: ['payments.intent.create'] },
      requestHash: REQUEST_HASH,
      expiresAt: '2030-01-01T00:00:00Z',
      channel: 'SMS',
    });
    expect(message.requestHash).toBe(REQUEST_HASH);
    expect(message.text).toContain(`APPROVE ${REQUEST_HASH}`);
    expect(message.deepLink).toContain(`/approvals/${REQUEST_HASH}`);

    const parsed = service.parseApprovalResponse({
      text: `APPROVE ${REQUEST_HASH}`,
      senderRef: 'user:owner',
      sentAt: '2026-09-30T12:00:00Z',
    });
    expect(parsed).toEqual({ kind: 'INTENT', intent: 'APPROVE', requestHash: REQUEST_HASH });

    const rejectParsed = service.parseApprovalResponse({
      text: `REJECT ${REQUEST_HASH}`,
      senderRef: 'user:owner',
      sentAt: '2026-09-30T12:00:00Z',
    });
    expect(rejectParsed).toEqual({ kind: 'INTENT', intent: 'REJECT', requestHash: REQUEST_HASH });

    const chatter = service.parseApprovalResponse({
      text: 'hey, what is the weather like?',
      senderRef: 'user:owner',
      sentAt: '2026-09-30T12:01:00Z',
    });
    expect(chatter).toEqual({ kind: 'NOT_AN_APPROVAL' });
  });

  it('rejects malformed signing keys', () => {
    expect(() => asApprovalSigningKey('')).toThrow(/non-empty/);
  });
});

describe('W3-001 approval contract conformance (runApprovalContractTests against ApprovalService)', () => {
  // One shared service instance: the harness is stateful per test
  // (request → confirm) and re-records the same request hash per case.
  const shared = buildService();
  const subject: ApprovalContractSubject = {
    surface: shared,
    adapter: shared,
    trustedChannelConfirmation: (input) => shared.trustedChannelConfirmation(input),
  };
  runApprovalContractTests(subject, (name, fn) => {
    it(name, fn);
  });
});

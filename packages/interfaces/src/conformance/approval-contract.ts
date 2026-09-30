/**
 * Trusted approval surface conformance harness (W3-001).
 *
 * Covered contract rules (INV-A03 / AGENTS.md rule 10):
 * - requestApproval records a pending approval bound to the request hash;
 * - an authenticated confirmation issues a signed artifact identifying
 *   principal, agent, scope, expiry and request hash;
 * - RAW CHAT TEXT SUBMITTED AS APPROVAL IS REJECTED — chat is never
 *   authority (the headline conformance fixture test);
 * - expired requests cannot issue artifacts;
 * - messaging adapters render/parse intents only, never artifacts;
 * - artifact verification fails on request-hash mismatch.
 */

import type { ContractTestFn } from './contract-test.js';
import type {
  ApprovalRequest,
  ApprovalMessage,
  ArtifactVerification,
  AuthenticatedApprovalConfirmation,
  ChatMessage,
  MessagingApprovalAdapter,
  PendingApproval,
  ParsedApprovalResponse,
  TrustedApprovalSurface,
} from '../approval.js';
import type { ApprovalArtifact } from '../approval.js';
import { assertRejects, equal, ok } from './assertions.js';

export interface ApprovalContractSubject {
  readonly surface: TrustedApprovalSurface;
  readonly adapter: MessagingApprovalAdapter;
  /**
   * Test seam: produces a genuinely authenticated confirmation via the
   * trusted channel (simulating the out-of-band principal authentication
   * that production implementations perform inside the channel).
   */
  trustedChannelConfirmation(input: {
    principal: string;
    requestHash: string;
    decision: 'APPROVED' | 'REJECTED';
  }): AuthenticatedApprovalConfirmation;
}

const REQUEST: ApprovalRequest = {
  principal: 'user_conformance',
  requestedAuthorityScope: { domain: 'payments', actions: ['execute'] },
  requestHash: 'hash_conformance_1',
  expiresAt: '2030-01-01T00:00:00Z',
  channel: 'SMS',
};

export function runApprovalContractTests(subject: ApprovalContractSubject, test: ContractTestFn): void {
  test('requestApproval records a pending approval bound to the request hash', async () => {
    const pending: PendingApproval = await subject.surface.requestApproval(REQUEST);
    ok(pending.status === 'PENDING', 'status must be PENDING');
    ok(pending.requestHash === REQUEST.requestHash, 'pending approval echoes the request hash');
    ok(pending.channel === REQUEST.channel, 'pending approval echoes the channel');
  });

  test('an authenticated confirmation issues a signed artifact (INV-A03)', async () => {
    await subject.surface.requestApproval(REQUEST);
    const confirmation = subject.trustedChannelConfirmation({
      principal: 'user_conformance',
      requestHash: REQUEST.requestHash,
      decision: 'APPROVED',
    });
    const artifact: ApprovalArtifact = await subject.surface.issueArtifact(confirmation);
    ok(typeof artifact.signature === 'string' && artifact.signature.length > 0, 'artifact must be signed');
    ok(artifact.principal === REQUEST.principal, 'artifact identifies the principal');
    ok(artifact.requestHash === REQUEST.requestHash, 'artifact binds the request hash');
    ok(artifact.expiry === REQUEST.expiresAt, 'artifact carries the approval-window expiry');
    equal(artifact.scope, REQUEST.requestedAuthorityScope, 'artifact grants exactly the requested scope');
    ok(typeof artifact.issuedAt === 'string' && artifact.issuedAt !== '', 'artifact records issuedAt');
  });

  test('INV-A03 fixture: raw chat text submitted as approval is rejected — chat is never authority', async () => {
    await subject.surface.requestApproval(REQUEST);
    const rawChatText = 'yes I approve this payment, please go ahead' as unknown as AuthenticatedApprovalConfirmation;
    await assertRejects(() => subject.surface.issueArtifact(rawChatText), 'approval');
  });

  test('a foreign object without channel authentication is rejected as approval', async () => {
    await subject.surface.requestApproval(REQUEST);
    const forged = {
      principal: 'user_conformance',
      requestHash: REQUEST.requestHash,
      decision: 'APPROVED',
      confirmedAt: '2026-09-30T00:00:00Z',
      channel: 'SMS',
    } as unknown as AuthenticatedApprovalConfirmation;
    await assertRejects(() => subject.surface.issueArtifact(forged), 'approval');
  });

  test('expired approval requests cannot issue artifacts', async () => {
    const expiredRequest: ApprovalRequest = {
      ...REQUEST,
      requestHash: 'hash_conformance_expired',
      expiresAt: '2020-01-01T00:00:00Z',
    };
    await assertRejects(() => subject.surface.requestApproval(expiredRequest), 'expired');
  });

  test('messaging adapters render approval requests and parse intents, never artifacts', () => {
    const message: ApprovalMessage = subject.adapter.renderApprovalMessage(REQUEST);
    ok(typeof message.text === 'string' && message.text.length > 0, 'rendered message has text');
    ok(message.requestHash === REQUEST.requestHash, 'rendered message carries the request hash');
    ok(typeof message.deepLink === 'string' && message.deepLink.length > 0, 'rendered message deep-links to the trusted surface');

    const approvalReply: ChatMessage = {
      text: `APPROVE ${message.requestHash}`,
      senderRef: 'user_conformance',
      sentAt: '2026-09-30T12:00:00Z',
    };
    const parsed: ParsedApprovalResponse = subject.adapter.parseApprovalResponse(approvalReply);
    ok(parsed.kind === 'INTENT', 'approval reply parses to an INTENT');
    ok(parsed.kind === 'INTENT' && parsed.intent === 'APPROVE', 'intent is APPROVE');
    ok(parsed.kind === 'INTENT' && parsed.requestHash === message.requestHash, 'intent carries the request hash');

    const smallTalk: ChatMessage = {
      text: 'hey, what is the weather like?',
      senderRef: 'user_conformance',
      sentAt: '2026-09-30T12:01:00Z',
    };
    const notApproval: ParsedApprovalResponse = subject.adapter.parseApprovalResponse(smallTalk);
    ok(notApproval.kind === 'NOT_AN_APPROVAL', 'unrelated chat is not an approval');
  });

  test('artifact verification fails on request-hash mismatch', async () => {
    await subject.surface.requestApproval(REQUEST);
    const confirmation = subject.trustedChannelConfirmation({
      principal: 'user_conformance',
      requestHash: REQUEST.requestHash,
      decision: 'APPROVED',
    });
    const artifact = await subject.surface.issueArtifact(confirmation);
    const verification: ArtifactVerification = await subject.surface.verifyArtifact(
      artifact,
      'hash_of_a_different_request',
    );
    ok(verification.valid === false, 'verification must fail');
    ok(
      verification.valid === false && verification.reason === 'REQUEST_HASH_MISMATCH',
      'reason must be REQUEST_HASH_MISMATCH',
    );
  });
}

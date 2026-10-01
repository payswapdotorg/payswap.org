import { describe, expect, it } from 'vitest';

import type { ApprovalRequest } from '@payswap/interfaces';

import { bindMessagingGateway, defineMessagingChannel } from '../src/messaging-adapters.js';
import type { MessagingApprovalAdapterBinding } from '../src/messaging-adapters.js';
import { allowHarness, NOW_MS } from './fixtures.js';

function approvalRequestFixture(): ApprovalRequest {
  return {
    principal: 'user:alice',
    requestedAuthorityScope: { domain: 'payments', actions: ['payments.intent.create'] },
    requestHash: 'reqhash_msg_1',
    expiresAt: new Date(NOW_MS + 3_600_000).toISOString(),
    channel: 'IN_APP',
  };
}

/** The real @payswap/api ApprovalService implements the adapter binding. */
function apiAdapterBinding(): MessagingApprovalAdapterBinding {
  const service = allowHarness().approvals;
  return {
    renderApprovalMessage: (request) => service.renderApprovalMessage(request),
    parseApprovalResponse: (message) =>
      service.parseApprovalResponse({
        text: message.text,
        senderRef: 'sms-gateway',
        sentAt: new Date(NOW_MS).toISOString(),
      }),
  };
}

const FULL_CHANNEL = defineMessagingChannel({
  channelId: 'sms',
  displayName: 'SMS',
  canRenderApprovalRequests: true,
  canReceiveReplies: true,
  canDeliverNotifications: true,
  supportedReplyKinds: ['APPROVAL_REPLY', 'STATUS_QUERY', 'FREE_TEXT'],
});

const NOTIFICATION_ONLY_CHANNEL = defineMessagingChannel({
  channelId: 'push',
  displayName: 'Push',
  canRenderApprovalRequests: false,
  canReceiveReplies: false,
  canDeliverNotifications: true,
});

describe('defineMessagingChannel — capability declarations are validated', () => {
  it('rejects approval rendering without notification delivery', () => {
    expect(() =>
      defineMessagingChannel({
        channelId: 'bad',
        displayName: 'Bad',
        canRenderApprovalRequests: true,
        canReceiveReplies: false,
        canDeliverNotifications: false,
      }),
    ).toThrow(/notification delivery/);
  });

  it('rejects reply capability without declared reply kinds', () => {
    expect(() =>
      defineMessagingChannel({
        channelId: 'bad2',
        displayName: 'Bad2',
        canRenderApprovalRequests: false,
        canReceiveReplies: true,
        canDeliverNotifications: true,
      }),
    ).toThrow(/reply kinds/);
  });
});

describe('bindMessagingGateway — outbound approval requests (gated + deep-linked)', () => {
  it('a capable channel renders the approval message with the trusted-surface deep link', () => {
    const gateway = bindMessagingGateway({ channel: FULL_CHANNEL, adapter: apiAdapterBinding() });
    const outbound = gateway.renderApprovalRequest(approvalRequestFixture(), 'user:alice');
    expect(outbound.kind).toBe('APPROVAL_REQUEST');
    expect(outbound.deepLink).toContain('/approvals/reqhash_msg_1');
    expect(outbound.authorizationNote).toContain('trusted surface');
    expect(outbound.requestHash).toBe('reqhash_msg_1');
  });

  it('a channel without approval capability FAILS CLOSED', () => {
    const gateway = bindMessagingGateway({
      channel: NOTIFICATION_ONLY_CHANNEL,
      adapter: apiAdapterBinding(),
    });
    expect(() => gateway.renderApprovalRequest(approvalRequestFixture(), 'user:alice')).toThrow(
      /does not declare approval-request rendering/,
    );
  });

  it('an approval message without a trusted-surface deep link is rejected (a chat reply is never the completion path)', () => {
    const gateway = bindMessagingGateway({
      channel: FULL_CHANNEL,
      adapter: {
        renderApprovalMessage: () => ({
          text: 'approve?',
          requestHash: 'reqhash_msg_1',
          deepLink: '',
        }),
        parseApprovalResponse: () => ({ kind: 'NOT_AN_APPROVAL' as const }),
      },
    });
    expect(() => gateway.renderApprovalRequest(approvalRequestFixture(), 'user:alice')).toThrow(
      /no trusted-surface deep link/,
    );
  });

  it('notifications carry no authority (informational only)', () => {
    const gateway = bindMessagingGateway({ channel: FULL_CHANNEL, adapter: apiAdapterBinding() });
    const notification = gateway.deliverNotification('user:alice', 'Your payment is reconciling');
    expect(notification.kind).toBe('NOTIFICATION');
    expect(notification.authorizationNote).toContain('no authority');
  });

  it('notification delivery on a channel without the capability fails closed', () => {
    const gateway = bindMessagingGateway({
      channel: defineMessagingChannel({
        channelId: 'inbound-only',
        displayName: 'Inbound Only',
        canRenderApprovalRequests: false,
        canReceiveReplies: true,
        canDeliverNotifications: false,
        supportedReplyKinds: ['FREE_TEXT'],
      }),
      adapter: apiAdapterBinding(),
    });
    expect(() => gateway.deliverNotification('user:alice', 'hi')).toThrow(/notification delivery/);
  });
});

describe('bindMessagingGateway — inbound replies are INTENTS AT MOST (same authorization gates)', () => {
  it('an APPROVE reply yields an intent that still REQUIRES the trusted surface (INV-A03)', () => {
    const gateway = bindMessagingGateway({ channel: FULL_CHANNEL, adapter: apiAdapterBinding() });
    const outcome = gateway.receive({
      channelId: 'sms',
      senderRef: 'user:alice',
      sentAt: new Date(NOW_MS).toISOString(),
      text: 'APPROVE reqhash_msg_1',
    });
    expect(outcome.kind).toBe('APPROVAL_INTENT');
    if (outcome.kind !== 'APPROVAL_INTENT') {
      throw new Error('expected intent');
    }
    expect(outcome.intent).toBe('APPROVE');
    expect(outcome.requiresTrustedSurfaceConfirmation).toBe(true);
    expect(outcome.nextAction.kind).toBe('TRUSTED_SURFACE');
    expect(outcome.nextAction.trustedSurface?.requestHash).toBe('reqhash_msg_1');
  });

  it('a REJECT reply is also just an intent for the trusted surface', () => {
    const gateway = bindMessagingGateway({ channel: FULL_CHANNEL, adapter: apiAdapterBinding() });
    const outcome = gateway.receive({
      channelId: 'sms',
      senderRef: 'user:alice',
      sentAt: new Date(NOW_MS).toISOString(),
      text: 'REJECT reqhash_msg_1',
    });
    expect(outcome.kind).toBe('APPROVAL_INTENT');
    if (outcome.kind === 'APPROVAL_INTENT') {
      expect(outcome.intent).toBe('REJECT');
    }
  });

  it('a status query yields a read-only status intent (INV-A05: no override)', () => {
    const gateway = bindMessagingGateway({ channel: FULL_CHANNEL, adapter: apiAdapterBinding() });
    const outcome = gateway.receive({
      channelId: 'sms',
      senderRef: 'user:alice',
      sentAt: new Date(NOW_MS).toISOString(),
      text: 'status of payment 42?',
    });
    expect(outcome.kind).toBe('STATUS_QUERY');
    if (outcome.kind === 'STATUS_QUERY') {
      expect(outcome.authorizationNote).toContain('read-only');
      expect(outcome.nextAction.kind).toBe('NAVIGATION');
    }
  });

  it('free text without intent is NOT_ACTIONABLE', () => {
    const gateway = bindMessagingGateway({ channel: FULL_CHANNEL, adapter: apiAdapterBinding() });
    const outcome = gateway.receive({
      channelId: 'sms',
      senderRef: 'user:alice',
      sentAt: new Date(NOW_MS).toISOString(),
      text: 'hello there',
    });
    expect(outcome.kind).toBe('NOT_ACTIONABLE');
  });

  it('a channel that does not declare APPROVAL_REPLY support does not accept approval replies', () => {
    const gateway = bindMessagingGateway({
      channel: defineMessagingChannel({
        channelId: 'status-only',
        displayName: 'Status Only',
        canRenderApprovalRequests: false,
        canReceiveReplies: true,
        canDeliverNotifications: true,
        supportedReplyKinds: ['STATUS_QUERY'],
      }),
      adapter: apiAdapterBinding(),
    });
    const outcome = gateway.receive({
      channelId: 'status-only',
      senderRef: 'user:alice',
      sentAt: new Date(NOW_MS).toISOString(),
      text: 'APPROVE reqhash_msg_1',
    });
    expect(outcome.kind).toBe('NOT_ACTIONABLE');
  });

  it('messages bound to a different channel are rejected', () => {
    const gateway = bindMessagingGateway({ channel: FULL_CHANNEL, adapter: apiAdapterBinding() });
    expect(() =>
      gateway.receive({
        channelId: 'push',
        senderRef: 'user:alice',
        sentAt: new Date(NOW_MS).toISOString(),
        text: 'APPROVE reqhash_msg_1',
      }),
    ).toThrow(/not sms/);
  });

  it('a channel without reply capability fails closed on receive', () => {
    const gateway = bindMessagingGateway({
      channel: NOTIFICATION_ONLY_CHANNEL,
      adapter: apiAdapterBinding(),
    });
    expect(() =>
      gateway.receive({
        channelId: 'push',
        senderRef: 'user:alice',
        sentAt: new Date(NOW_MS).toISOString(),
        text: 'APPROVE reqhash_msg_1',
      }),
    ).toThrow(/does not declare reply capability/);
  });
});

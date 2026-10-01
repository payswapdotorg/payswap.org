/**
 * @payswap/ux — messaging adapter interfaces (W3-006, "where allowed").
 *
 * FROZEN-ARCHITECTURE §20: messaging is a trusted human approval surface —
 * and AGENTS.md rule 10: a chat message itself is not authority. The
 * messaging adapters defined here are CHANNEL-AGNOSTIC inbound/outbound
 * message contracts BOUND TO THE SAME AUTHORIZATION GATES as every other
 * surface:
 *
 * - channels declare their CAPABILITIES up front
 *   (`defineMessagingChannel`): a channel that cannot render approval
 *   requests never renders one (`bindMessagingGateway` fails closed);
 * - outbound approval messages MUST carry the deep link into the trusted
 *   in-app surface (the @payswap/api ApprovalMessage contract) — a bare chat
 *   reply is never the completion path;
 * - inbound messages are parsed to INTENTS AT MOST
 *   (`receive`): an APPROVE reply yields an intent that still REQUIRES the
 *   trusted-surface confirmation (INV-A03); suggestions are structurally
 *   marked non-authoritative (INV-A05: they cannot override protocol,
 *   policy, compliance or security constraints);
 * - the gateway interface has NO method that mints an ApprovalArtifact and
 *   NO method that executes a payment — the type system makes
 *   chat-as-authority unrepresentable (W3-001 approval contract shape).
 *
 * Deterministic by construction: pure validation and folding over the
 * injected @payswap/api MessagingApprovalAdapter (ApprovalService); no
 * network, no DOM.
 */

import type { ApprovalRequest } from '@payswap/interfaces';

import type { ViewAction } from './command-center.js';

/** Raised when a messaging channel violates its capability declaration. */
export class MessagingChannelCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MessagingChannelCapabilityError';
  }
}

// ---------------------------------------------------------------------------
// Channel capability declarations
// ---------------------------------------------------------------------------

export type MessagingReplyKind = 'APPROVAL_REPLY' | 'STATUS_QUERY' | 'FREE_TEXT';

/** The declared capabilities of one messaging channel. */
export interface MessagingChannelDeclaration {
  readonly channelId: string;
  readonly displayName: string;
  readonly canRenderApprovalRequests: boolean;
  readonly canReceiveReplies: boolean;
  readonly canDeliverNotifications: boolean;
  readonly supportedReplyKinds: readonly MessagingReplyKind[];
}

/** Declare (and validate) one messaging channel's capabilities. */
export function defineMessagingChannel(input: {
  readonly channelId: string;
  readonly displayName: string;
  readonly canRenderApprovalRequests: boolean;
  readonly canReceiveReplies: boolean;
  readonly canDeliverNotifications: boolean;
  readonly supportedReplyKinds?: readonly MessagingReplyKind[];
}): MessagingChannelDeclaration {
  if (typeof input.channelId !== 'string' || input.channelId === '') {
    throw new MessagingChannelCapabilityError('channelId must be a non-empty string');
  }
  if (typeof input.displayName !== 'string' || input.displayName === '') {
    throw new MessagingChannelCapabilityError('displayName must be a non-empty string');
  }
  if (input.canRenderApprovalRequests && !input.canDeliverNotifications) {
    throw new MessagingChannelCapabilityError(
      `channel ${input.channelId} cannot render approval requests without notification delivery capability`,
    );
  }
  if (input.canReceiveReplies && (input.supportedReplyKinds ?? []).length === 0) {
    throw new MessagingChannelCapabilityError(
      `channel ${input.channelId} receives replies but declares no supported reply kinds`,
    );
  }
  return Object.freeze({
    channelId: input.channelId,
    displayName: input.displayName,
    canRenderApprovalRequests: input.canRenderApprovalRequests,
    canReceiveReplies: input.canReceiveReplies,
    canDeliverNotifications: input.canDeliverNotifications,
    supportedReplyKinds: Object.freeze([...(input.supportedReplyKinds ?? [])]),
  });
}

// ---------------------------------------------------------------------------
// Inbound / outbound message contracts
// ---------------------------------------------------------------------------

export interface InboundChannelMessage {
  readonly channelId: string;
  readonly senderRef: string;
  readonly sentAt: string;
  readonly text: string;
}

export type OutboundMessageKind = 'APPROVAL_REQUEST' | 'NOTIFICATION' | 'STATUS_UPDATE';

export interface OutboundChannelMessage {
  readonly channelId: string;
  readonly recipientRef: string;
  readonly kind: OutboundMessageKind;
  readonly text: string;
  /** Present on approval requests: the trusted-surface deep link. */
  readonly deepLink?: string;
  readonly requestHash?: string;
  readonly authorizationNote: string;
}

/**
 * The outcome of an inbound message: an intent at most, a read-only status
 * query, or nothing actionable. There is deliberately NO artifact variant
 * and NO execution variant.
 */
export type InboundMessageOutcome =
  | {
      readonly kind: 'APPROVAL_INTENT';
      readonly intent: 'APPROVE' | 'REJECT';
      readonly requestHash: string;
      readonly requiresTrustedSurfaceConfirmation: true;
      readonly authorizationNote: string;
      readonly nextAction: ViewAction;
    }
  | {
      readonly kind: 'STATUS_QUERY';
      readonly query: string;
      readonly authorizationNote: string;
      readonly nextAction: ViewAction;
    }
  | {
      readonly kind: 'NOT_ACTIONABLE';
      readonly reason: string;
    };

// ---------------------------------------------------------------------------
// The gated messaging gateway
// ---------------------------------------------------------------------------

/**
 * The minimal @payswap/interfaces MessagingApprovalAdapter surface the
 * gateway consumes (implemented by @payswap/api ApprovalService). Only the
 * two read-only operations are required — rendering and parsing; the gateway
 * adds NO authority of its own.
 */
export interface MessagingApprovalAdapterBinding {
  renderApprovalMessage(request: ApprovalRequest): { readonly text: string; readonly requestHash: string; readonly deepLink: string };
  parseApprovalResponse(message: { readonly text: string }): {
    readonly kind: 'INTENT';
    readonly intent: 'APPROVE' | 'REJECT';
    readonly requestHash: string;
  } | { readonly kind: 'NOT_AN_APPROVAL' };
}

/** A messaging gateway bound to one channel and one approval adapter. */
export interface MessagingGateway {
  readonly channel: MessagingChannelDeclaration;
  /** Render an approval request for the channel (gated by capability + deep link). */
  renderApprovalRequest(request: ApprovalRequest, recipientRef: string): OutboundChannelMessage;
  /** Deliver a notification (gated by capability). */
  deliverNotification(recipientRef: string, text: string): OutboundChannelMessage;
  /** Parse one inbound message into an intent at most (gated by capability). */
  receive(message: InboundChannelMessage): InboundMessageOutcome;
}

/**
 * Bind a messaging gateway to a channel and an approval adapter. The gates:
 *
 * 1. the channel must declare `canRenderApprovalRequests` for
 *    `renderApprovalRequest`;
 * 2. the adapter's rendered approval message MUST carry a non-empty
 *    trusted-surface deep link — an approval message without the trusted
 *    surface path is rejected (the chat reply is never the authority);
 * 3. the channel must declare `canReceiveReplies` (and the FREE_TEXT or
 *    APPROVAL_REPLY reply kind) for `receive`;
 * 4. inbound approval replies yield INTENTS that still require the trusted
 *    surface (INV-A03) — the outcome carries the next action bound to the
 *    trusted surface, never an artifact.
 */
export function bindMessagingGateway(input: {
  readonly channel: MessagingChannelDeclaration;
  readonly adapter: MessagingApprovalAdapterBinding;
}): MessagingGateway {
  const { channel, adapter } = input;

  return Object.freeze({
    channel,

    renderApprovalRequest(request: ApprovalRequest, recipientRef: string): OutboundChannelMessage {
      if (!channel.canRenderApprovalRequests) {
        throw new MessagingChannelCapabilityError(
          `channel ${channel.channelId} does not declare approval-request rendering capability`,
        );
      }
      const message = adapter.renderApprovalMessage(request);
      if (typeof message.deepLink !== 'string' || message.deepLink === '') {
        throw new MessagingChannelCapabilityError(
          `approval message for channel ${channel.channelId} carries no trusted-surface deep link; a chat reply is never the completion path (INV-A03)`,
        );
      }
      return Object.freeze({
        channelId: channel.channelId,
        recipientRef,
        kind: 'APPROVAL_REQUEST',
        text: message.text,
        deepLink: message.deepLink,
        requestHash: message.requestHash,
        authorizationNote:
          'approval completes exclusively on the trusted surface (INV-A03); a reply expresses intent only',
      });
    },

    deliverNotification(recipientRef: string, text: string): OutboundChannelMessage {
      if (!channel.canDeliverNotifications) {
        throw new MessagingChannelCapabilityError(
          `channel ${channel.channelId} does not declare notification delivery capability`,
        );
      }
      return Object.freeze({
        channelId: channel.channelId,
        recipientRef,
        kind: 'NOTIFICATION',
        text,
        authorizationNote: 'notifications are informational; they carry no authority',
      });
    },

    receive(message: InboundChannelMessage): InboundMessageOutcome {
      if (!channel.canReceiveReplies) {
        throw new MessagingChannelCapabilityError(
          `channel ${channel.channelId} does not declare reply capability`,
        );
      }
      if (message.channelId !== channel.channelId) {
        throw new MessagingChannelCapabilityError(
          `message is bound to channel ${message.channelId}, not ${channel.channelId}`,
        );
      }
      if (typeof message.senderRef !== 'string' || message.senderRef === '') {
        throw new MessagingChannelCapabilityError('an inbound message requires a sender reference');
      }
      const parsed = adapter.parseApprovalResponse({ text: message.text });
      if (parsed.kind === 'INTENT') {
        if (!channel.supportedReplyKinds.includes('APPROVAL_REPLY')) {
          return {
            kind: 'NOT_ACTIONABLE',
            reason: `channel ${channel.channelId} does not support approval replies`,
          };
        }
        return {
          kind: 'APPROVAL_INTENT',
          intent: parsed.intent,
          requestHash: parsed.requestHash,
          requiresTrustedSurfaceConfirmation: true,
          authorizationNote:
            'INV-A03: the reply expresses intent only; authority is granted exclusively on the trusted approval surface',
          nextAction: {
            actionId: 'complete-on-trusted-surface',
            label: 'Complete the decision on the trusted approval surface',
            kind: 'TRUSTED_SURFACE',
            authorityRef: parsed.requestHash,
            available: true,
            trustedSurface: { requestHash: parsed.requestHash },
          },
        };
      }
      if (channel.supportedReplyKinds.includes('STATUS_QUERY') && /\bstatus\b/i.test(message.text)) {
        return {
          kind: 'STATUS_QUERY',
          query: message.text,
          authorizationNote: 'status queries are read-only views of authority state (INV-A05: no override)',
          nextAction: {
            actionId: 'open-status-view',
            label: 'Open the authoritative status view',
            kind: 'NAVIGATION',
            authorityRef: 'command-center-status',
            available: true,
          },
        };
      }
      return {
        kind: 'NOT_ACTIONABLE',
        reason: 'the message expresses no approval intent and no status query',
      };
    },
  });
}

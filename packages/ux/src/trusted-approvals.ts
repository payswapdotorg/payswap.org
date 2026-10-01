/**
 * @payswap/ux — approval completion through a trusted surface (W3-006).
 *
 * FROZEN-ARCHITECTURE §20 / AGENTS.md rule 10 / INV-A03: user approval is a
 * TRUSTED-SURFACE operation that creates a signed authorization artifact;
 * a chat message or a UI click is never authority.
 *
 * This module is the UX-side contract for that rule:
 *
 * - `completeApprovalOnTrustedSurface` is the ONLY approval-completion path:
 *   it obtains the AuthenticatedApprovalConfirmation from the trusted
 *   channel seam (`ApprovalService.trustedChannelConfirmation`, W3-002 — the
 *   out-of-band principal authentication a production channel performs
 *   inside itself) and issues the SIGNED artifact through the service. The
 *   confirmation constructor is never exposed to raw chat or click input;
 * - `expressApprovalIntentFromChat` parses a chat reply into an INTENT AT
 *   MOST (via the @payswap/api MessagingApprovalAdapter implementation):
 *   there is deliberately NO function in this module whose input is a
 *   ChatMessage and whose output is an ApprovalArtifact — the type system
 *   makes chat-as-authority unrepresentable (INV-A05: intents cannot
 *   override protocol/policy/compliance/security constraints either);
 * - the artifact identifies principal, scope, expiry and request hash, and
 *   carries a real signature verifiable through the SAME service
 *   (`verifyApprovalArtifact`, INV-A03 / INV-E04: the UI consumes
 *   authenticated provenance, never manufactures it).
 *
 * Deterministic by construction: all state lives in the injected
 * @payswap/api services; this module adds no state of its own.
 */

import type { ApprovalService } from '@payswap/api';
import type {
  ApprovalArtifact,
  ApprovalMessage,
  ApprovalRequest,
  ChatMessage,
  ParsedApprovalResponse,
} from '@payswap/interfaces';

/** Raised when the trusted-approval UX contract is violated. */
export class TrustedApprovalUxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrustedApprovalUxError';
  }
}

/**
 * Render an approval request for the trusted surface. The message carries
 * the deep link into the in-app trusted surface — a bare chat reply is
 * explicitly NOT the completion path (the adapter's copy says so).
 */
export function renderApprovalRequest(
  service: ApprovalService,
  request: ApprovalRequest,
): ApprovalMessage {
  return service.renderApprovalMessage(request);
}

/**
 * Complete an approval decision ON THE TRUSTED SURFACE and mint the SIGNED
 * authorization artifact (INV-A03). `decision` is what the trusted channel
 * authenticated out-of-band; the service seam
 * (`trustedChannelConfirmation`) is the only constructor of authenticated
 * confirmations, so this function cannot be driven by raw chat or clicks.
 */
export async function completeApprovalOnTrustedSurface(
  service: ApprovalService,
  decision: {
    readonly principal: string;
    readonly requestHash: string;
    readonly decision: 'APPROVED' | 'REJECTED';
  },
): Promise<
  | { readonly outcome: 'ARTIFACT_ISSUED'; readonly artifact: ApprovalArtifact }
  | { readonly outcome: 'REJECTION_RECORDED' }
> {
  if (
    typeof decision.principal !== 'string' ||
    decision.principal === '' ||
    typeof decision.requestHash !== 'string' ||
    decision.requestHash === ''
  ) {
    throw new TrustedApprovalUxError('a trusted-surface decision requires principal and request hash');
  }
  if (decision.decision !== 'APPROVED' && decision.decision !== 'REJECTED') {
    throw new TrustedApprovalUxError('a trusted-surface decision is APPROVED or REJECTED');
  }
  const confirmation = service.trustedChannelConfirmation(decision);
  if (decision.decision === 'REJECTED') {
    try {
      await service.issueArtifact(confirmation);
      throw new TrustedApprovalUxError(
        'a REJECTED decision unexpectedly issued an artifact (trusted surface contract violation)',
      );
    } catch (error) {
      // The @payswap/api surface rejects the artifact issuance for a REJECTED
      // decision with ApprovalPolicyViolationError; the rejection is recorded
      // by the service and surfaced here as an honest outcome.
      if (error instanceof TrustedApprovalUxError) {
        throw error;
      }
      if (
        error instanceof Error &&
        (error.name === 'ApprovalPolicyViolationError' || error.name === 'ValidationError')
      ) {
        return { outcome: 'REJECTION_RECORDED' };
      }
      throw error;
    }
  }
  const artifact = await service.issueArtifact(confirmation);
  return { outcome: 'ARTIFACT_ISSUED', artifact };
}

/**
 * Parse a chat message into an approval INTENT — never authority. The return
 * type has no artifact variant: converting an intent into authority
 * requires `completeApprovalOnTrustedSurface` (the trusted out-of-band
 * channel), exactly as the W3-001 `ParsedApprovalResponse` contract states.
 */
export interface ChatApprovalIntent {
  readonly kind: 'APPROVAL_INTENT';
  readonly intent: 'APPROVE' | 'REJECT';
  readonly requestHash: string;
  /** Always true — an intent from chat ALWAYS requires the trusted surface. */
  readonly requiresTrustedSurfaceConfirmation: true;
  readonly note: string;
}

export type ChatParseOutcome = ChatApprovalIntent | { readonly kind: 'NOT_AN_APPROVAL' };

/** Express (at most) an approval intent from an inbound chat message. */
export function expressApprovalIntentFromChat(
  service: ApprovalService,
  message: ChatMessage,
): ChatParseOutcome {
  const parsed: ParsedApprovalResponse = service.parseApprovalResponse(message);
  if (parsed.kind === 'NOT_AN_APPROVAL') {
    return { kind: 'NOT_AN_APPROVAL' };
  }
  return {
    kind: 'APPROVAL_INTENT',
    intent: parsed.intent,
    requestHash: parsed.requestHash,
    requiresTrustedSurfaceConfirmation: true,
    note:
      'a chat reply expresses intent only; authority is granted exclusively on the trusted approval surface (INV-A03)',
  };
}

/**
 * Verify a signed approval artifact against the expected request hash —
 * through the SAME trusted surface that issued it. The UX never verifies
 * (or forges) artifacts by itself (INV-E04).
 */
export async function verifyApprovalArtifact(
  service: ApprovalService,
  artifact: ApprovalArtifact,
  expectedRequestHash: string,
): Promise<boolean> {
  const verification = await service.verifyArtifact(artifact, expectedRequestHash);
  return verification.valid;
}

/**
 * The reference an approved artifact is referenced by when re-submitting the
 * authorized command through the API (`approval:<requestHash>` — the
 * @payswap/api ApprovalService artifact reference format).
 */
export function approvalArtifactRef(requestHash: string): string {
  if (typeof requestHash !== 'string' || requestHash.length === 0) {
    throw new TrustedApprovalUxError('a request hash is required to derive an artifact reference');
  }
  return `approval:${requestHash}`;
}

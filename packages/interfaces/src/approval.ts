/**
 * Trusted approval surface contract (FROZEN-ARCHITECTURE §20: messaging is a
 * trusted human approval surface; AGENTS.md rule 10).
 *
 * THE RULE ENCODED IN THIS CONTRACT (INV-A03 / AGENTS.md rule 10):
 * User approval is a trusted-surface operation that creates a signed
 * authorization artifact; RAW CHAT TEXT IS NEVER AUTHORITY.
 *
 * Structural encoding:
 * - the only way to obtain an ApprovalArtifact is
 *   TrustedApprovalSurface.issueArtifact with an AuthenticatedApprovalConfirmation
 *   that a trusted channel has authenticated out-of-band;
 * - there is deliberately NO entry point that converts a chat string (or any
 *   untrusted input) into an artifact;
 * - MessagingApprovalAdapter.parseApprovalResponse returns an INTENT at most —
 *   never an artifact and never authority (INV-A05: suggestions cannot
 *   override protocol/policy/compliance/security constraints);
 * - ApprovalArtifact identifies principal, agent, scope, expiry and request
 *   hash exactly as INV-A03 requires;
 * - implementations MUST validate the provenance/shape of confirmations and
 *   MUST reject anything that was not produced by an authenticated trusted
 *   channel. The conformance suite (src/conformance/approval-contract.ts)
 *   enforces this: submitting raw chat text as approval is rejected.
 */

import { createHash } from 'node:crypto';

import { canonicalJson } from './canonical-json.js';

/** Trusted channels able to authenticate an approving principal out-of-band. */
export type ApprovalChannel = 'SMS' | 'EMAIL' | 'IN_APP' | 'HARDWARE_KEY';

/** Delegated authority being requested/ granted, keyed by domain + actions. */
export interface AuthorityScope {
  readonly domain: string;
  readonly actions: readonly string[];
}

/**
 * A request for approval. `requestHash` binds the approval to the exact
 * underlying request (proposal/command payload); see computeRequestHash.
 */
export interface ApprovalRequest {
  /** The principal whose approval is required (the authority holder). */
  readonly principal: string;
  /** The agent acting on behalf of the principal, when applicable. */
  readonly agentRef?: string;
  readonly requestedAuthorityScope: AuthorityScope;
  /** Hash binding this approval to the underlying request payload. */
  readonly requestHash: string;
  /** RFC 3339 expiry of the approval window. */
  readonly expiresAt: string;
  readonly channel: ApprovalChannel;
}

/**
 * The signed authorization artifact created by a trusted approval surface
 * (INV-A03: identifies principal, agent, scope, expiry and request hash).
 * This artifact — never a chat message — is what downstream authorization
 * decisions reference (see RuntimeAdapter).
 */
export interface ApprovalArtifact {
  readonly principal: string;
  readonly agentRef?: string;
  readonly scope: AuthorityScope;
  readonly expiry: string;
  readonly requestHash: string;
  readonly signature: string;
  readonly issuedAt: string;
}

/** Opaque reference to a stored ApprovalArtifact. */
export type ApprovalArtifactRef = string;

/** A recorded, pending approval request awaiting the principal's decision. */
export interface PendingApproval {
  readonly requestHash: string;
  readonly status: 'PENDING';
  readonly channel: ApprovalChannel;
  readonly expiresAt: string;
}

/**
 * A confirmation that a trusted channel has AUTHENTICATED the principal's
 * decision out-of-band. Only trusted-channel code may construct one;
 * implementations must reject forgeries (see contract rules above).
 */
export interface AuthenticatedApprovalConfirmation {
  readonly principal: string;
  readonly requestHash: string;
  readonly decision: 'APPROVED' | 'REJECTED';
  readonly confirmedAt: string;
  readonly channel: ApprovalChannel;
}

export type ArtifactVerification =
  | { readonly valid: true; readonly scope: AuthorityScope }
  | {
      readonly valid: false;
      readonly reason: 'UNKNOWN_ARTIFACT' | 'SIGNATURE_INVALID' | 'EXPIRED' | 'REQUEST_HASH_MISMATCH';
    };

/** Error thrown when an approval operation violates the trust contract. */
export class ApprovalPolicyViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalPolicyViolationError';
  }
}

/**
 * The trusted approval surface contract. Implementations MUST:
 * - refuse to issue artifacts for expired requests;
 * - refuse to issue artifacts from anything other than a genuinely
 *   authenticated confirmation (raw chat text, deep links, screenshots are
 *   never authority — INV-E04: UI/browser artifacts are not stronger than
 *   their authenticated provenance);
 * - sign artifacts over the bound request hash and scope.
 */
export interface TrustedApprovalSurface {
  requestApproval(request: ApprovalRequest): Promise<PendingApproval>;
  issueArtifact(confirmation: AuthenticatedApprovalConfirmation): Promise<ApprovalArtifact>;
  verifyArtifact(artifact: ApprovalArtifact, expectedRequestHash: string): Promise<ArtifactVerification>;
}

/** A rendered approval message for a messaging channel. */
export interface ApprovalMessage {
  readonly text: string;
  readonly requestHash: string;
  readonly expiresAt: string;
  /** Deep link into the trusted in-app approval surface (never a bare chat reply). */
  readonly deepLink: string;
}

/** An inbound chat message (untrusted input). */
export interface ChatMessage {
  readonly text: string;
  readonly senderRef: string;
  readonly sentAt: string;
}

/**
 * The result of parsing a chat reply: an intent at most. There is
 * deliberately no artifact variant — converting an intent into authority
 * requires the trusted out-of-band channel (AuthenticatedApprovalConfirmation).
 */
export type ParsedApprovalResponse =
  | { readonly kind: 'INTENT'; readonly intent: 'APPROVE' | 'REJECT'; readonly requestHash: string }
  | { readonly kind: 'NOT_AN_APPROVAL' };

/**
 * Adapter that renders approval requests into human messages and parses
 * replies back into intents. Rendering/parsing is UX convenience only and
 * never confers authority (INV-A03, AGENTS.md rule 10).
 */
export interface MessagingApprovalAdapter {
  renderApprovalMessage(request: ApprovalRequest): ApprovalMessage;
  parseApprovalResponse(message: ChatMessage): ParsedApprovalResponse;
}

/**
 * Computes the request hash binding an approval to its underlying payload
 * (SHA-256 over the canonical JSON of the payload).
 */
export function computeRequestHash(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
}

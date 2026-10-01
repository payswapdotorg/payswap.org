/**
 * @payswap/api — trusted approval surface implementation (W3-002).
 *
 * Implements the W3-001 `TrustedApprovalSurface` and `MessagingApprovalAdapter`
 * contracts (INV-A03 / AGENTS.md rule 10) and mints the @payswap/trust
 * `SignedApprovalArtifact` with REAL HMAC-SHA256 signatures:
 *
 * - the W3-001-shaped `ApprovalArtifact` is signed over the canonical JSON of
 *   the unsigned artifact;
 * - the trust-shaped `SignedApprovalArtifact` is signed over the canonical
 *   signing payload defined by @payswap/trust `approvalSigningPayload()`
 *   (W3-001 comment: "The trusted approval surface (W3-002) signs exactly
 *   this serialization");
 * - RAW CHAT TEXT IS NEVER AUTHORITY: the only path to an artifact is
 *   `issueArtifact`/`issueSignedApproval` with an AuthenticatedApprovalConfirmation
 *   that a trusted channel has authenticated out-of-band. The
 *   `trustedChannelConfirmation` seam stands in for the out-of-band principal
 *   authentication a production channel (SMS OTP, hardware key, in-app
 *   trusted surface) performs inside the channel — exactly the pattern
 *   documented by the W3-001 reference fixture. Anything without the trusted
 *   channel authentication — raw chat strings, forged foreign objects — is
 *   rejected (INV-A03, INV-E04);
 * - a REJECTED decision never issues an artifact;
 * - artifacts are single-redemption for grant issuance (see grants.ts);
 *   re-issuing for the same confirmation returns the recorded artifact
 *   deterministically.
 *
 * PRODUCTION NOTE: ApprovalSigningKey must be injected from a secrets vault
 * by the composition root. Tests inject deterministic keys.
 */

import { createHmac } from 'node:crypto';

import type {
  ApprovalArtifact,
  ApprovalChannel,
  ApprovalMessage,
  ApprovalRequest,
  ArtifactVerification,
  AuthenticatedApprovalConfirmation,
  ChatMessage,
  MessagingApprovalAdapter,
  ParsedApprovalResponse,
  PendingApproval,
  TrustedApprovalSurface,
} from '@payswap/interfaces';
import { ApprovalPolicyViolationError, canonicalJson } from '@payswap/interfaces';
import type { ProtocolClock } from '@payswap/protocol';
import { ValidationError } from '@payswap/protocol';
import type { ApprovalScope, SignedApprovalArtifact } from '@payswap/trust';
import { approvalSigningPayload } from '@payswap/trust';

/** Key material for artifact signatures. Branded; injected, never ambient. */
export type ApprovalSigningKey = string & { readonly __approvalSigningKey: unique symbol };

/** Brand a validated string as an ApprovalSigningKey. */
export function asApprovalSigningKey(value: string): ApprovalSigningKey {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError('ApprovalSigningKey must be a non-empty string');
  }
  if (value.length > 512) {
    throw new ValidationError('ApprovalSigningKey must not exceed 512 characters');
  }
  return value as ApprovalSigningKey;
}

const AUTHENTICATION_MARKER = '__payswap_trusted_channel_confirmation__';

interface MarkedConfirmation extends AuthenticatedApprovalConfirmation {
  readonly [AUTHENTICATION_MARKER]: true;
}

const APPROVAL_CHANNELS: readonly ApprovalChannel[] = ['SMS', 'EMAIL', 'IN_APP', 'HARDWARE_KEY'];

/** Status of a recorded approval request. */
export type ApprovalRecordStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CONSUMED';

/** A recorded approval request (the API-visible projection of the flow). */
export interface ApprovalRecord {
  readonly requestHash: string;
  readonly status: ApprovalRecordStatus;
  readonly channel: ApprovalChannel;
  readonly expiresAt: string;
  /** Present once an artifact was issued (APPROVED) — reference for grants. */
  readonly artifactRef?: string;
}

/** Input for creating an approval request from an authorization NEEDS_APPROVAL decision. */
export interface CreateApprovalRequestInput {
  /** The authority holder whose approval is required (approver principal ref). */
  readonly principal: string;
  /** The agent acting on behalf of the principal, when applicable. */
  readonly agentRef?: string;
  /** The trust-shaped scope being requested (actions, resources, max amount). */
  readonly scope: ApprovalScope;
  readonly requestHash: string;
  /** Approval window expiry in epoch milliseconds. */
  readonly expiresAtMs: number;
  readonly channel: ApprovalChannel;
}

export interface ApprovalServiceDeps {
  readonly clock: ProtocolClock;
  readonly signingKey: ApprovalSigningKey;
  /** Base URL of the trusted in-app approval surface used in rendered deep links. */
  readonly deepLinkBaseUrl?: string;
}

export type SignedApprovalVerification =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: 'SIGNATURE_INVALID' | 'EXPIRED' };

interface PendingRequestRecord {
  readonly request: ApprovalRequest;
  readonly trustScope: ApprovalScope;
  readonly expiresAtMs: number;
  readonly status: ApprovalRecordStatus;
  readonly artifactRef?: string;
  readonly interfacesArtifact?: ApprovalArtifact;
  readonly signedArtifact?: SignedApprovalArtifact;
}

function requireNonEmpty(value: string, label: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`${label} must be a non-empty string`);
  }
}

function requireChannel(channel: ApprovalChannel): void {
  if (!(APPROVAL_CHANNELS as readonly string[]).includes(channel)) {
    throw new ValidationError(`channel must be one of ${APPROVAL_CHANNELS.join(', ')}`);
  }
}

function isGenuinelyAuthenticated(value: unknown): value is MarkedConfirmation {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<MarkedConfirmation>;
  return (
    candidate[AUTHENTICATION_MARKER] === true &&
    typeof candidate.principal === 'string' &&
    candidate.principal !== '' &&
    typeof candidate.requestHash === 'string' &&
    candidate.requestHash !== '' &&
    (candidate.decision === 'APPROVED' || candidate.decision === 'REJECTED') &&
    typeof candidate.confirmedAt === 'string' &&
    candidate.confirmedAt !== '' &&
    typeof candidate.channel === 'string'
  );
}

function deriveDomain(scope: ApprovalScope): string {
  const firstAction = scope.actions[0];
  if (firstAction === undefined) {
    throw new ValidationError('scope.actions must contain at least one action');
  }
  const dot = firstAction.indexOf('.');
  return dot > 0 ? firstAction.slice(0, dot) : 'general';
}

function isoFromMs(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * The trusted approval surface. Implements both W3-001 contracts
 * (TrustedApprovalSurface + MessagingApprovalAdapter) and mints trust-shaped
 * signed artifacts for grant issuance.
 */
export class ApprovalService implements TrustedApprovalSurface, MessagingApprovalAdapter {
  readonly #clock: ProtocolClock;
  readonly #signingKey: ApprovalSigningKey;
  readonly #deepLinkBaseUrl: string;
  readonly #pending = new Map<string, PendingRequestRecord>();

  constructor(deps: ApprovalServiceDeps) {
    this.#clock = deps.clock;
    this.#signingKey = deps.signingKey;
    this.#deepLinkBaseUrl = deps.deepLinkBaseUrl ?? 'https://app.payswap.example';
  }

  // ---------------------------------------------------------------------------
  // Creation paths
  // ---------------------------------------------------------------------------

  /** W3-001 contract path: record an ApprovalRequest as pending. */
  async requestApproval(request: ApprovalRequest): Promise<PendingApproval> {
    requireNonEmpty(request.principal, 'request.principal');
    requireNonEmpty(request.requestHash, 'request.requestHash');
    requireChannel(request.channel);
    const scope = request.requestedAuthorityScope;
    if (
      scope === undefined ||
      typeof scope.domain !== 'string' ||
      scope.domain.length === 0 ||
      !Array.isArray(scope.actions) ||
      scope.actions.length === 0
    ) {
      throw new ValidationError('request.requestedAuthorityScope requires a domain and actions');
    }
    const expiresAtMs = Date.parse(request.expiresAt);
    if (!Number.isFinite(expiresAtMs)) {
      throw new ValidationError('request.expiresAt must be an RFC 3339 timestamp');
    }
    if (expiresAtMs <= this.#nowMs()) {
      throw new ApprovalPolicyViolationError(
        `approval request expired at ${request.expiresAt}; expired requests cannot be approved`,
      );
    }
    this.#pending.set(request.requestHash, {
      request,
      trustScope: {
        actions: [...scope.actions],
        resources: [{ type: scope.domain }],
      },
      expiresAtMs,
      status: 'PENDING',
    });
    return {
      requestHash: request.requestHash,
      status: 'PENDING',
      channel: request.channel,
      expiresAt: request.expiresAt,
    };
  }

  /**
   * Decision-origin path: create an approval request from an authorization
   * NEEDS_APPROVAL decision (AGENTS.md rule 10). The trust scope (exact
   * resources and optional amount bound) is preserved for the signed artifact.
   */
  async createApprovalRequest(input: CreateApprovalRequestInput): Promise<PendingApproval> {
    requireNonEmpty(input.principal, 'input.principal');
    requireNonEmpty(input.requestHash, 'input.requestHash');
    requireChannel(input.channel);
    if (!Array.isArray(input.scope.actions) || input.scope.actions.length === 0) {
      throw new ValidationError('input.scope.actions must contain at least one action');
    }
    if (!Array.isArray(input.scope.resources) || input.scope.resources.length === 0) {
      throw new ValidationError('input.scope.resources must contain at least one resource');
    }
    if (typeof input.expiresAtMs !== 'number' || !Number.isInteger(input.expiresAtMs)) {
      throw new ValidationError('input.expiresAtMs must be integer epoch milliseconds');
    }
    if (input.expiresAtMs <= this.#nowMs()) {
      throw new ApprovalPolicyViolationError(
        `approval request expired at ${input.expiresAtMs}; expired requests cannot be approved`,
      );
    }
    const domain = deriveDomain(input.scope);
    const request: ApprovalRequest = {
      principal: input.principal,
      ...(input.agentRef === undefined ? {} : { agentRef: input.agentRef }),
      requestedAuthorityScope: { domain, actions: [...input.scope.actions] },
      requestHash: input.requestHash,
      expiresAt: isoFromMs(input.expiresAtMs),
      channel: input.channel,
    };
    this.#pending.set(input.requestHash, {
      request,
      trustScope: {
        actions: [...input.scope.actions],
        resources: [...input.scope.resources],
        ...(input.scope.maxAmount === undefined ? {} : { maxAmount: input.scope.maxAmount }),
      },
      expiresAtMs: input.expiresAtMs,
      status: 'PENDING',
    });
    return {
      requestHash: input.requestHash,
      status: 'PENDING',
      channel: input.channel,
      expiresAt: request.expiresAt,
    };
  }

  // ---------------------------------------------------------------------------
  // Artifact issuance (trusted channel only)
  // ---------------------------------------------------------------------------

  /**
   * Test/production seam for the trusted channel: produces a GENUINELY
   * authenticated confirmation (the out-of-band principal authentication a
   * production channel performs inside itself — SMS OTP verification,
   * hardware-key challenge, in-app trusted surface). This seam is the ONLY
   * constructor of authenticated confirmations; there is deliberately no
   * entry point that converts a chat string into authority.
   */
  trustedChannelConfirmation(input: {
    principal: string;
    requestHash: string;
    decision: 'APPROVED' | 'REJECTED';
  }): AuthenticatedApprovalConfirmation {
    const confirmation: MarkedConfirmation = {
      [AUTHENTICATION_MARKER]: true,
      principal: input.principal,
      requestHash: input.requestHash,
      decision: input.decision,
      confirmedAt: isoFromMs(this.#nowMs()),
      channel: 'IN_APP',
    };
    return confirmation;
  }

  /** W3-001 contract: issue the signed ApprovalArtifact (canonical-JSON HMAC). */
  async issueArtifact(confirmation: AuthenticatedApprovalConfirmation): Promise<ApprovalArtifact> {
    return (await this.#mint(confirmation)).interfacesArtifact;
  }

  /**
   * Mint the trust-shaped SignedApprovalArtifact (INV-A03). The signature is
   * real HMAC-SHA256 over the canonical signing payload from @payswap/trust.
   */
  async issueSignedApproval(confirmation: AuthenticatedApprovalConfirmation): Promise<SignedApprovalArtifact> {
    return (await this.#mint(confirmation)).signedArtifact;
  }

  async #mint(
    confirmation: AuthenticatedApprovalConfirmation,
  ): Promise<{ readonly interfacesArtifact: ApprovalArtifact; readonly signedArtifact: SignedApprovalArtifact }> {
    if (!isGenuinelyAuthenticated(confirmation)) {
      throw new ApprovalPolicyViolationError(
        'approval rejected: raw chat text or unauthenticated input is never authority (INV-A03); an AuthenticatedApprovalConfirmation produced by a trusted channel is required',
      );
    }
    const record = this.#pending.get(confirmation.requestHash);
    if (record === undefined) {
      throw new ApprovalPolicyViolationError(
        `approval request not found for request hash ${confirmation.requestHash}; artifacts bind to recorded requests only`,
      );
    }
    if (record.request.principal !== confirmation.principal) {
      throw new ApprovalPolicyViolationError(
        'approval principal mismatch: the confirmation must come from the authority holder',
      );
    }
    if (confirmation.decision === 'REJECTED') {
      if (record.status === 'PENDING') {
        this.#pending.set(confirmation.requestHash, { ...record, status: 'REJECTED' });
      }
      throw new ApprovalPolicyViolationError(
        'approval rejected: a REJECTED decision cannot issue an authorization artifact',
      );
    }
    if (record.expiresAtMs <= this.#nowMs()) {
      throw new ApprovalPolicyViolationError(
        `approval request expired at ${record.request.expiresAt}`,
      );
    }
    if (
      (record.status === 'APPROVED' || record.status === 'CONSUMED') &&
      record.interfacesArtifact !== undefined &&
      record.signedArtifact !== undefined
    ) {
      // Deterministic re-issue: the same approved confirmation returns the
      // recorded artifacts (never a second, differently-stamped mint).
      return { interfacesArtifact: record.interfacesArtifact, signedArtifact: record.signedArtifact };
    }

    const issuedAtMs = this.#nowMs();
    const unsigned: Omit<ApprovalArtifact, 'signature'> = {
      principal: record.request.principal,
      ...(record.request.agentRef === undefined ? {} : { agentRef: record.request.agentRef }),
      scope: record.request.requestedAuthorityScope,
      expiry: record.request.expiresAt,
      requestHash: record.request.requestHash,
      issuedAt: isoFromMs(issuedAtMs),
    };
    const interfacesArtifact: ApprovalArtifact = {
      ...unsigned,
      signature: this.#signCanonicalJson(unsigned),
    };

    const unsignedSigned: Omit<SignedApprovalArtifact, 'signature'> = {
      principal: record.request.principal,
      ...(record.request.agentRef === undefined ? {} : { agentRef: record.request.agentRef }),
      scope: record.trustScope,
      expiry: record.expiresAtMs,
      requestHash: record.request.requestHash,
      issuedAt: issuedAtMs,
    };
    const signedArtifact: SignedApprovalArtifact = {
      ...unsignedSigned,
      signature: this.#signApprovalPayload(unsignedSigned),
    };

    const artifactRef = `approval:${record.request.requestHash}`;
    this.#pending.set(confirmation.requestHash, {
      ...record,
      status: 'APPROVED',
      artifactRef,
      interfacesArtifact,
      signedArtifact,
    });
    return { interfacesArtifact, signedArtifact };
  }

  // ---------------------------------------------------------------------------
  // Verification
  // ---------------------------------------------------------------------------

  /** W3-001 contract: verify an ApprovalArtifact against an expected request hash. */
  async verifyArtifact(
    artifact: ApprovalArtifact,
    expectedRequestHash: string,
  ): Promise<ArtifactVerification> {
    if (artifact.requestHash !== expectedRequestHash) {
      return { valid: false, reason: 'REQUEST_HASH_MISMATCH' };
    }
    const expected = this.#signCanonicalJson({
      principal: artifact.principal,
      ...(artifact.agentRef === undefined ? {} : { agentRef: artifact.agentRef }),
      scope: artifact.scope,
      expiry: artifact.expiry,
      requestHash: artifact.requestHash,
      issuedAt: artifact.issuedAt,
    });
    if (artifact.signature !== expected) {
      return { valid: false, reason: 'SIGNATURE_INVALID' };
    }
    const expiryMs = Date.parse(artifact.expiry);
    if (!Number.isFinite(expiryMs) || expiryMs <= this.#nowMs()) {
      return { valid: false, reason: 'EXPIRED' };
    }
    return { valid: true, scope: artifact.scope };
  }

  /** Verify a trust-shaped SignedApprovalArtifact (real signature + expiry). */
  verifySignedApproval(artifact: SignedApprovalArtifact): SignedApprovalVerification {
    const expected = this.#signApprovalPayload(artifact);
    if (artifact.signature !== expected) {
      return { valid: false, reason: 'SIGNATURE_INVALID' };
    }
    if (this.#nowMs() >= artifact.expiry) {
      return { valid: false, reason: 'EXPIRED' };
    }
    return { valid: true };
  }

  /** Fetch a minted SignedApprovalArtifact by its reference (for grant issuance). */
  signedArtifactByRef(ref: string): SignedApprovalArtifact | undefined {
    if (!ref.startsWith('approval:')) {
      return undefined;
    }
    const record = this.#pending.get(ref.slice('approval:'.length));
    return record?.signedArtifact;
  }

  /** Mark an artifact as consumed (single redemption — see grants.ts). */
  markArtifactConsumed(ref: string): boolean {
    if (!ref.startsWith('approval:')) {
      return false;
    }
    const record = this.#pending.get(ref.slice('approval:'.length));
    if (record === undefined || record.status !== 'APPROVED') {
      return false;
    }
    this.#pending.set(ref.slice('approval:'.length), { ...record, status: 'CONSUMED' });
    return true;
  }

  /** API-visible projection of a recorded approval request. */
  getApprovalRecord(requestHash: string): ApprovalRecord | undefined {
    const record = this.#pending.get(requestHash);
    if (record === undefined) {
      return undefined;
    }
    return {
      requestHash: record.request.requestHash,
      status: record.status,
      channel: record.request.channel,
      expiresAt: record.request.expiresAt,
      ...(record.artifactRef === undefined ? {} : { artifactRef: record.artifactRef }),
    };
  }

  // ---------------------------------------------------------------------------
  // Messaging adapter (UX convenience only — never authority)
  // ---------------------------------------------------------------------------

  renderApprovalMessage(request: ApprovalRequest): ApprovalMessage {
    const actions = request.requestedAuthorityScope.actions.join(',');
    return {
      text:
        `PaySwap approval requested: grant "${request.requestedAuthorityScope.domain}:${actions}"? ` +
        `Reply APPROVE ${request.requestHash} or REJECT ${request.requestHash}. ` +
        'A chat reply expresses intent only; authority is granted exclusively on the trusted approval surface.',
      requestHash: request.requestHash,
      expiresAt: request.expiresAt,
      deepLink: `${this.#deepLinkBaseUrl}/approvals/${request.requestHash}`,
    };
  }

  parseApprovalResponse(message: ChatMessage): ParsedApprovalResponse {
    const approve = /\bAPPROVE\s+([A-Za-z0-9_-]+)/.exec(message.text);
    if (approve !== null) {
      const requestHash = approve[1];
      if (requestHash !== undefined) {
        return { kind: 'INTENT', intent: 'APPROVE', requestHash };
      }
    }
    const reject = /\bREJECT\s+([A-Za-z0-9_-]+)/.exec(message.text);
    if (reject !== null) {
      const requestHash = reject[1];
      if (requestHash !== undefined) {
        return { kind: 'INTENT', intent: 'REJECT', requestHash };
      }
    }
    return { kind: 'NOT_AN_APPROVAL' };
  }

  // ---------------------------------------------------------------------------
  // Signing primitives
  // ---------------------------------------------------------------------------

  #signCanonicalJson(unsigned: Omit<ApprovalArtifact, 'signature'>): string {
    return createHmac('sha256', this.#signingKey)
      .update(canonicalJson(unsigned), 'utf8')
      .digest('hex');
  }

  #signApprovalPayload(artifact: SignedApprovalArtifact | Omit<SignedApprovalArtifact, 'signature'>): string {
    const withPlaceholder: SignedApprovalArtifact = { ...artifact, signature: '' };
    const payload = approvalSigningPayload(withPlaceholder);
    return createHmac('sha256', this.#signingKey).update(payload, 'utf8').digest('hex');
  }

  #nowMs(): number {
    return Number(this.#clock.now());
  }
}

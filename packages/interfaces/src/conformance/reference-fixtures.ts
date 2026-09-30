/**
 * Reference fixture implementations of the W3-001 conformance subjects.
 *
 * These are in-memory, side-effect-free reference implementations used to
 * prove the conformance harnesses are satisfiable and to serve as executable
 * documentation of each contract. They are TEST INFRASTRUCTURE, not
 * production behavior: per the worker runbook, unresolved production
 * behavior is never replaced with mocks — production adapters are delivered
 * by their own Work Orders (e.g. W3-003).
 */

import { createHmac, randomUUID } from 'node:crypto';

import { ApprovalPolicyViolationError } from '../approval.js';
import type {
  ApprovalArtifact,
  ApprovalMessage,
  ApprovalRequest,
  ArtifactVerification,
  AuthenticatedApprovalConfirmation,
  ChatMessage,
  MessagingApprovalAdapter,
  ParsedApprovalResponse,
  PendingApproval,
  TrustedApprovalSurface,
} from '../approval.js';
import { canonicalJson } from '../canonical-json.js';
import {
  EXTERNAL_AMBIGUITY_HTTP_STATUS,
  EXTERNAL_AMBIGUITY_OUTCOME_MARKER,
  OUTCOME_HEADER,
  mapErrorCategoryToHttpStatus,
  validateRequestEnvelope,
} from '../http.js';
import type { ApiError, ErrorResponse, RequestEnvelope, ResponseEnvelope, ResponseMeta } from '../http.js';
import type { ConnectorExecutionResult, ConnectorExecutionRequest, ExternalFundsLocation, ExternalFundsPositionObservation, ProviderCatalogueEntry, ProviderStateEnvelope } from '../psp-connector.js';
import { validateConnectorExecutionRequest } from '../psp-connector.js';
import { signWebhookEvent, verifyWebhookEvent } from '../webhooks.js';
import type { WebhookEventEnvelope, WebhookSignatureHeaders, WebhookVerification, WebhookVerificationOptions } from '../webhooks.js';
import { CONTRACT_SCHEMA_VERSION } from '../version.js';
import type { ApprovalContractSubject } from './approval-contract.js';
import type { HttpContractSubject, HttpTransportResult } from './http-contract.js';
import type { PspConnectorContractSubject } from './psp-connector-contract.js';
import type { WebhookContractSubject } from './webhook-contract.js';

function newRequestId(): string {
  return `req_${randomUUID()}`;
}

// ---------------------------------------------------------------------------
// HTTP reference fixture
// ---------------------------------------------------------------------------

/**
 * In-memory reference REST endpoint:
 * - validates the request envelope (auth, explicit API version, idempotency
 *   on mutations);
 * - returns the success envelope, marking idempotent replays;
 * - simulates an externally ambiguous outcome at
 *   POST /simulations/external-ambiguity (409 + outcome marker + reconciliation ref);
 * - answers GET /payments/pm_does_not_exist with NOT_FOUND.
 */
export function createReferenceHttpEndpoint(): HttpContractSubject {
  const authoritativeKeys = new Set<string>();
  return {
    async handle(request: RequestEnvelope<unknown>): Promise<HttpTransportResult> {
      const validation = validateRequestEnvelope(request);
      if (!validation.ok) {
        return {
          kind: 'error',
          status: mapErrorCategoryToHttpStatus('VALIDATION'),
          body: {
            error: {
              code: 'request.invalid',
              category: 'VALIDATION',
              message: validation.violations.join('; '),
            },
            meta: { schemaVersion: CONTRACT_SCHEMA_VERSION, requestId: newRequestId() },
          },
        };
      }

      if (request.path === '/simulations/external-ambiguity') {
        const error: ApiError = {
          code: 'provider.outcome_unknown',
          category: 'EXTERNAL_AMBIGUITY',
          message: 'the external provider outcome is unknown; reconciliation is authoritative (INV-X01/INV-X03)',
          reconciliationRef: `recon_${randomUUID()}`,
        };
        const body: ErrorResponse = {
          error,
          meta: { schemaVersion: CONTRACT_SCHEMA_VERSION, requestId: newRequestId() },
        };
        return {
          kind: 'error',
          status: EXTERNAL_AMBIGUITY_HTTP_STATUS,
          body,
          headers: { [OUTCOME_HEADER]: EXTERNAL_AMBIGUITY_OUTCOME_MARKER },
        };
      }

      if (request.method === 'GET' && request.path === '/payments/pm_does_not_exist') {
        return {
          kind: 'error',
          status: mapErrorCategoryToHttpStatus('NOT_FOUND'),
          body: {
            error: { code: 'resource.not_found', category: 'NOT_FOUND', message: 'payment not found' },
            meta: { schemaVersion: CONTRACT_SCHEMA_VERSION, requestId: newRequestId() },
          },
        };
      }

      const key = request.idempotencyKey;
      let replayed = false;
      if (key !== undefined) {
        replayed = authoritativeKeys.has(key);
        authoritativeKeys.add(key);
      }
      const meta: ResponseMeta = {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        requestId: newRequestId(),
        ...(replayed ? { idempotentReplay: true } : {}),
      };
      const envelope: ResponseEnvelope<unknown> = { data: { accepted: true }, meta };
      return { kind: 'success', status: 200, envelope };
    },
  };
}

// ---------------------------------------------------------------------------
// Webhook reference fixture
// ---------------------------------------------------------------------------

/** Reference signer/verifier delegating to the contract's conformance helpers. */
export function createReferenceWebhookSubject(): WebhookContractSubject {
  return {
    sign: (
      envelope: WebhookEventEnvelope,
      secret: string,
      timestampSeconds: number,
    ): WebhookSignatureHeaders => signWebhookEvent(envelope, secret, timestampSeconds),
    verify: (
      envelope: WebhookEventEnvelope,
      secret: string,
      headers: WebhookSignatureHeaders,
      options?: WebhookVerificationOptions,
    ): WebhookVerification => verifyWebhookEvent(envelope, secret, headers, options),
  };
}

// ---------------------------------------------------------------------------
// Approval reference fixture
// ---------------------------------------------------------------------------

const AUTHENTICATION_MARKER = '__payswap_authenticated_confirmation__';
const ARTIFACT_SIGNING_KEY = 'conformance-approval-signing-key';

interface MarkedConfirmation extends AuthenticatedApprovalConfirmation {
  readonly [AUTHENTICATION_MARKER]: true;
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

function artifactSignature(unsigned: Omit<ApprovalArtifact, 'signature'>): string {
  return createHmac('sha256', ARTIFACT_SIGNING_KEY).update(canonicalJson(unsigned), 'utf8').digest('hex');
}

/**
 * Reference trusted approval surface: a pending-request map plus a
 * channel-authenticated confirmation path. The internal marker stands in for
 * the out-of-band principal authentication a production channel (SMS OTP,
 * hardware key, ...) performs; anything without it — raw chat text included —
 * is rejected (INV-A03).
 */
export function createReferenceApprovalSubject(clock: () => Date = () => new Date()): ApprovalContractSubject {
  const pending = new Map<string, ApprovalRequest>();

  const surface: TrustedApprovalSurface = {
    async requestApproval(request: ApprovalRequest): Promise<PendingApproval> {
      if (Date.parse(request.expiresAt) <= clock().getTime()) {
        throw new ApprovalPolicyViolationError(
          `approval request expired at ${request.expiresAt}; expired requests cannot be approved`,
        );
      }
      pending.set(request.requestHash, request);
      return {
        requestHash: request.requestHash,
        status: 'PENDING',
        channel: request.channel,
        expiresAt: request.expiresAt,
      };
    },

    async issueArtifact(confirmation: AuthenticatedApprovalConfirmation): Promise<ApprovalArtifact> {
      if (!isGenuinelyAuthenticated(confirmation)) {
        throw new ApprovalPolicyViolationError(
          'approval rejected: raw chat text or unauthenticated input is never authority (INV-A03); an AuthenticatedApprovalConfirmation produced by a trusted channel is required',
        );
      }
      if (confirmation.decision === 'REJECTED') {
        throw new ApprovalPolicyViolationError(
          'approval rejected: a REJECTED decision cannot issue an authorization artifact',
        );
      }
      const request = pending.get(confirmation.requestHash);
      if (request === undefined) {
        throw new ApprovalPolicyViolationError(
          'approval request not found for the bound request hash; artifacts bind to recorded requests only',
        );
      }
      if (request.principal !== confirmation.principal) {
        throw new ApprovalPolicyViolationError(
          'approval principal mismatch: the confirmation must come from the authority holder',
        );
      }
      if (Date.parse(request.expiresAt) <= clock().getTime()) {
        throw new ApprovalPolicyViolationError(`approval request expired at ${request.expiresAt}`);
      }
      const unsigned: Omit<ApprovalArtifact, 'signature'> = {
        principal: request.principal,
        scope: request.requestedAuthorityScope,
        expiry: request.expiresAt,
        requestHash: request.requestHash,
        issuedAt: clock().toISOString(),
      };
      const signature = artifactSignature(unsigned);
      const artifact: ApprovalArtifact =
        request.agentRef === undefined
          ? { ...unsigned, signature }
          : { ...unsigned, signature, agentRef: request.agentRef };
      return artifact;
    },

    async verifyArtifact(artifact: ApprovalArtifact, expectedRequestHash: string): Promise<ArtifactVerification> {
      if (artifact.requestHash !== expectedRequestHash) {
        return { valid: false, reason: 'REQUEST_HASH_MISMATCH' };
      }
      const expected = artifactSignature({
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
      if (Date.parse(artifact.expiry) <= clock().getTime()) {
        return { valid: false, reason: 'EXPIRED' };
      }
      return { valid: true, scope: artifact.scope };
    },
  };

  const adapter: MessagingApprovalAdapter = {
    renderApprovalMessage(request: ApprovalRequest): ApprovalMessage {
      const actions = request.requestedAuthorityScope.actions.join(',');
      return {
        text:
          `PaySwap approval requested: grant "${request.requestedAuthorityScope.domain}:${actions}"? ` +
          `Reply APPROVE ${request.requestHash} or REJECT ${request.requestHash}. ` +
          'A chat reply expresses intent only; authority is granted exclusively on the trusted approval surface.',
        requestHash: request.requestHash,
        expiresAt: request.expiresAt,
        deepLink: `https://app.payswap.example/approvals/${request.requestHash}`,
      };
    },
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
    },
  };

  return {
    surface,
    adapter,
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
        confirmedAt: clock().toISOString(),
        channel: 'SMS',
      };
      return confirmation;
    },
  };
}

// ---------------------------------------------------------------------------
// PSP connector reference fixture
// ---------------------------------------------------------------------------

/**
 * Reference merchant PSP connector boundary:
 * - refuses catalogue entries as connected instances (INV-C05);
 * - wraps provider state losslessly (INV-C06);
 * - executes only with an explicit mode, echoing it (INV-C07);
 * - observes external funds positions with freshness + provenance (INV-C09).
 */
export function createReferencePspConnectorSubject(clock: () => Date = () => new Date()): PspConnectorContractSubject {
  const preserveProviderState = (rawProviderState: unknown): ProviderStateEnvelope => {
    const observedAt = clock().toISOString();
    return {
      provider: { name: 'example-psp', version: '2026-09' },
      object: { objectType: 'payment_intent', externalId: 'pi_external_reference_1' },
      revision: 'rev_1',
      state: rawProviderState,
      history: [{ toRevision: 'rev_1', occurredAt: observedAt, note: 'observed via provider api' }],
      timestamps: { observedAt },
      provenance: { source: 'PROVIDER_API', fetchId: `fetch_${randomUUID()}` },
    };
  };

  return {
    adoptAsConnected(entry: ProviderCatalogueEntry) {
      void entry;
      return {
        ok: false,
        error: {
          code: 'connector.catalogue_entry_not_authority',
          category: 'POLICY',
          message:
            'INV-C05: a provider catalogue entry is not a ConnectedCapabilityInstance; connect a real provider account/tenant with authorization, geography/currency and permission state before executing',
        },
      };
    },

    preserveProviderState,

    observeFundsPosition(location: ExternalFundsLocation): ExternalFundsPositionObservation {
      const observedAt = clock().toISOString();
      return {
        observationId: `obs_${randomUUID()}`,
        observedAt,
        freshness: { asOf: observedAt, maxAgeSeconds: 300 },
        location,
        observedAmount: { currency: 'USD', minorUnits: '100000' },
        provenance: { providerName: location.providerName, source: 'PROVIDER_API', capturedAt: observedAt },
      };
    },

    async execute(request: ConnectorExecutionRequest): Promise<ConnectorExecutionResult> {
      const validation = validateConnectorExecutionRequest(request);
      if (!validation.ok) {
        throw new Error(`connector execution contract violation: ${validation.violations.join('; ')}`);
      }
      return {
        executionMode: request.executionMode,
        providerState: preserveProviderState({
          status: 'processing',
          execution_mode: request.executionMode,
        }),
        terminalState: 'WAITING',
      };
    },
  };
}

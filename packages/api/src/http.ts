/**
 * @payswap/api — core REST surface (W3-002).
 *
 * Router-agnostic pure `ApiHandler` implementing the W3-001 REST boundary
 * contract on top of the merged Stage-0 kernels:
 *
 * - auth via session token (SessionManager): every request is authenticated
 *   (RequestAuth + token proof); SESSION is the supported scheme in W3-002 —
 *   other schemes fail closed with AUTHORIZATION;
 * - every mutation requires an idempotency key (INV-F05) integrated with the
 *   @payswap/protocol IdempotencyRegistrar: replays return the ORIGINAL
 *   authoritative result with meta.idempotentReplay=true; same key + different
 *   command → 409 CONFLICT; EXTERNAL_AMBIGUITY outcomes are COMPLETED (never
 *   re-armed) so unknown external writes cannot be blindly retried (INV-X02);
 * - error mapping per W3-001 mapErrorCategoryToHttpStatus INCLUDING
 *   EXTERNAL_AMBIGUITY → 409 + `X-PaySwap-Outcome: unknown` — never a generic
 *   500 (INV-X01: UNKNOWN is not FAILED);
 * - every mutation response carries meta.evidenceRef linking to the
 *   authorization lineage (INV-E01); EXTERNAL_AMBIGUITY errors carry a
 *   reconciliationRef (INV-X03);
 * - out-of-scope actions (NEEDS_APPROVAL) produce an approval REQUEST, never
 *   an error-less execution (W3-002 acceptance);
 * - revoked/expired authority fails closed (403 AUTHORIZATION).
 *
 * Endpoints (W3-002 work order): POST /v1/intents, GET /v1/intents/:id,
 * POST /v1/approvals, GET /v1/approvals/:id, GET /v1/capabilities,
 * GET /v1/health — plus the W3-001 conformance surface (/payments,
 * /simulations/external-ambiguity) required to satisfy the frozen contract's
 * conformance harness (echoing the reference fixture shipped in
 * @payswap/interfaces).
 *
 * NO FAKE SETTLEMENT: POST /v1/intents records a stub intent object echoing
 * the @payswap/protocol command-envelope shape. Nothing here declares
 * financial finality (AGENTS.md rule 5; settlement belongs to later Work
 * Orders).
 */

import type {
  ApiError,
  ApprovalMessage,
  ErrorResponse,
  HttpTransportResult,
  PendingApproval,
  RequestAuth,
  RequestEnvelope,
  ResponseEnvelope,
  ResponseMeta,
} from '@payswap/interfaces';
import {
  CONTRACT_SCHEMA_VERSION,
  EXTERNAL_AMBIGUITY_OUTCOME_MARKER,
  OUTCOME_HEADER,
  computeRequestHash,
  mapErrorCategoryToHttpStatus,
  outcomeMarkerForErrorCategory,
  validateRequestEnvelope,
} from '@payswap/interfaces';
import type {
  CommandEnvelope,
  ErrorCategory as ProtocolErrorCategory,
  IdFactory,
  IdempotencyRegistrar,
  PaySwapErrorDetails,
  ProtocolClock,
} from '@payswap/protocol';
import { PaySwapError, PROTOCOL_SCHEMA_VERSION, canonicalScopeKey, createCommandEnvelope } from '@payswap/protocol';
import type { AmountSpec, AuthorizationDecision, Principal } from '@payswap/trust';
import { InvalidAmountError, principalRef, validateAmountSpec } from '@payswap/trust';

import type { ApprovalService } from './approvals.js';
import type { GrantAuthority } from './grants.js';
import type { SessionManager } from './identity.js';

/** The authenticated REST request: W3-001 RequestEnvelope + session token proof. */
export type ApiRequest = RequestEnvelope<unknown> & { readonly sessionToken?: string };

/** The REST response: W3-001 transport result. */
export type ApiResponse = HttpTransportResult;

/** Router-agnostic API handler: a pure function from request to response. */
export type ApiHandler = (request: ApiRequest) => Promise<ApiResponse>;

/** Success meta carrying the mutation evidence link (INV-E01). */
export interface ApiSuccessMeta extends ResponseMeta {
  /** Authorization-lineage reference; present on every mutation response. */
  readonly evidenceRef?: string;
}

export type ApiSuccessEnvelope = ResponseEnvelope<unknown> & { readonly meta: ApiSuccessMeta };

/** Deps of createApiHandler: every dependency injected (clock, ids, services). */
export interface ApiDeps {
  readonly clock: ProtocolClock;
  readonly ids: IdFactory;
  readonly sessions: SessionManager;
  readonly approvals: ApprovalService;
  readonly grants: GrantAuthority;
  readonly idempotency: IdempotencyRegistrar;
}

/** Raised for REST-level request failures (auth, routing, body shape). */
export class ApiRequestError extends PaySwapError {
  constructor(
    code: string,
    category: ProtocolErrorCategory,
    message: string,
    details?: PaySwapErrorDetails,
  ) {
    super({ code, category, message, details });
  }
}

/**
 * Deterministic mapping from the @payswap/protocol error taxonomy to the
 * W3-001 REST error categories (the two vocabularies differ deliberately:
 * protocol categories are domain-semantic; REST categories are wire-semantic).
 */
const PROTOCOL_TO_REST_CATEGORY: Readonly<Record<ProtocolErrorCategory, ApiError['category']>> = {
  VALIDATION: 'VALIDATION',
  CONFLICT: 'CONFLICT',
  NOT_FOUND: 'NOT_FOUND',
  AUTHORIZATION_REQUIRED: 'AUTHORIZATION',
  POLICY_BLOCKED: 'POLICY',
  EXTERNAL_AMBIGUITY: 'EXTERNAL_AMBIGUITY',
  TERMINAL_STATE: 'CONFLICT',
  MIGRATION_INCOMPATIBLE: 'CONFLICT',
  INTERNAL: 'INTERNAL',
};

/** Stored authoritative result of a completed idempotent mutation (INV-F05). */
interface StoredAuthoritativeResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly data?: unknown;
  readonly error?: ApiError;
  readonly evidenceRef?: string;
}

interface RouteContext {
  readonly request: ApiRequest;
  readonly requestId: string;
  readonly principal: Principal;
  readonly tenantId: string;
  readonly pathParams: Readonly<Record<string, string>>;
}

type EndpointResult =
  | { readonly kind: 'success'; readonly status: number; readonly data: unknown; readonly evidenceRef?: string }
  | { readonly kind: 'error'; readonly error: ApiError };

interface RouteDefinition {
  readonly method: 'GET' | 'POST';
  readonly pattern: readonly string[];
  readonly mutating: boolean;
  readonly handler: (ctx: RouteContext) => Promise<EndpointResult>;
}

// ---------------------------------------------------------------------------
// Body shapes (validated structurally; money validated via trust)
// ---------------------------------------------------------------------------

interface IntentBody {
  readonly amount?: AmountSpec;
  readonly approvalArtifactRef?: string;
  readonly correlationId?: string;
  readonly commandType?: string;
}

interface CreateApprovalBody {
  readonly principal: string;
  readonly agentRef?: string;
  readonly scope: {
    readonly actions: readonly string[];
    readonly resources?: readonly { readonly type: string; readonly resourceId?: string }[];
    readonly maxAmount?: AmountSpec;
  };
  readonly requestHash?: string;
  readonly channel?: 'SMS' | 'EMAIL' | 'IN_APP' | 'HARDWARE_KEY';
  readonly ttlMs?: number;
}

const DEFAULT_INTENT_COMMAND_TYPE = 'payments.intent.create';
const DEFAULT_APPROVAL_CHANNEL: 'SMS' | 'EMAIL' | 'IN_APP' | 'HARDWARE_KEY' = 'IN_APP';
const DEFAULT_APPROVAL_TTL_MS = 3_600_000;
const INTENT_RESOURCE_TYPE = 'intent';

// ---------------------------------------------------------------------------
// Capability stubs (two-axis availability)
// ---------------------------------------------------------------------------

/** Two-axis availability: what the capability reports vs source reachability. */
export type CapabilityStubState = 'AVAILABLE' | 'DEGRADED' | 'UNAVAILABLE';
export type CapabilityStubSource = 'REACHABLE' | 'UNREACHABLE' | 'UNKNOWN';
/**
 * Effective availability. Deliberately has no FAILED member: external
 * ambiguity can never be converted into failure (INV-X01).
 */
export type CapabilityStubEffective = 'AVAILABLE' | 'DEGRADED' | 'UNAVAILABLE' | 'UNKNOWN';

/** One API-visible capability stub (W3-002 work order: stubs, two axes). */
export interface CapabilityStub {
  readonly capabilityId: string;
  readonly description: string;
  readonly state: CapabilityStubState;
  readonly source: CapabilityStubSource;
  readonly effectiveAvailability: CapabilityStubEffective;
}

/**
 * Resolve the two axes into the effective availability: an unreachable or
 * unknown source means UNKNOWN — never success, never failure (INV-X01,
 * INV-C01/C02 semantics; the canonical connector capability vocabulary is
 * owned by W2-003 and consumed by W3-003 — these API stubs deliberately
 * duplicate nothing from that vocabulary).
 */
export function resolveCapabilityStubEffective(
  state: CapabilityStubState,
  source: CapabilityStubSource,
): CapabilityStubEffective {
  switch (source) {
    case 'REACHABLE':
      return state;
    case 'UNREACHABLE':
    case 'UNKNOWN':
      return 'UNKNOWN';
  }
}

const CAPABILITY_STUBS: readonly CapabilityStub[] = [
  {
    capabilityId: 'api.developer_surface',
    description: 'The developer REST surface itself (this handler).',
    state: 'AVAILABLE',
    source: 'REACHABLE',
    effectiveAvailability: resolveCapabilityStubEffective('AVAILABLE', 'REACHABLE'),
  },
  {
    capabilityId: 'api.trusted_approval_channel',
    description: 'Trusted approval surface reachable for out-of-band confirmations.',
    state: 'AVAILABLE',
    source: 'REACHABLE',
    effectiveAvailability: resolveCapabilityStubEffective('AVAILABLE', 'REACHABLE'),
  },
  {
    capabilityId: 'api.external_observation_probe',
    description:
      'Probe for external provider observation; source reachability is unknown in Stage 1 (no connectors yet — W3-003).',
    state: 'AVAILABLE',
    source: 'UNKNOWN',
    effectiveAvailability: resolveCapabilityStubEffective('AVAILABLE', 'UNKNOWN'),
  },
];

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

function splitPath(path: string): readonly string[] {
  return path.split('/').filter((segment) => segment.length > 0);
}

/**
 * Bigint-safe canonicalization for hashing mutation results: protocol
 * envelopes carry TimestampMs bigints, and the canonical JSON contract
 * prescribes encoding bigints as decimal strings. The transform is
 * deterministic and structure-preserving.
 */
function canonicalSafe(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map((element) => canonicalSafe(element));
  }
  if (typeof value === 'object' && value !== null) {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) {
        output[key] = canonicalSafe(entry);
      }
    }
    return output;
  }
  return value;
}

function isoFromMs(ms: bigint): string {
  return new Date(Number(ms)).toISOString();
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ApiRequestError('request.body_invalid', 'VALIDATION', `${label} must be a non-empty string`);
  }
  return value;
}

function parseIntentBody(body: unknown): IntentBody {
  if (body === undefined || body === null) {
    return {};
  }
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiRequestError('request.body_invalid', 'VALIDATION', 'intent body must be a JSON object');
  }
  const raw = body as Record<string, unknown>;
  const parsed: { -readonly [K in keyof IntentBody]: IntentBody[K] } = {};
  if (raw.amount !== undefined) {
    if (typeof raw.amount !== 'object' || raw.amount === null) {
      throw new ApiRequestError('request.body_invalid', 'VALIDATION', 'amount must be an object');
    }
    const amount = raw.amount as Record<string, unknown>;
    if (typeof amount.currency !== 'string' || typeof amount.minorUnits !== 'string') {
      throw new ApiRequestError(
        'request.body_invalid',
        'VALIDATION',
        'amount requires string currency and minorUnits (integer minor units; INV-F01)',
      );
    }
    const spec: AmountSpec = { currency: amount.currency, minorUnits: amount.minorUnits };
    try {
      validateAmountSpec(spec);
    } catch (error) {
      if (error instanceof InvalidAmountError) {
        throw new ApiRequestError('request.body_invalid', 'VALIDATION', `invalid amount: ${error.message}`);
      }
      throw error;
    }
    parsed.amount = spec;
  }
  if (raw.approvalArtifactRef !== undefined) {
    parsed.approvalArtifactRef = requireString(raw.approvalArtifactRef, 'approvalArtifactRef');
  }
  if (raw.correlationId !== undefined) {
    parsed.correlationId = requireString(raw.correlationId, 'correlationId');
  }
  if (raw.commandType !== undefined) {
    parsed.commandType = requireString(raw.commandType, 'commandType');
  }
  return parsed;
}

function parseCreateApprovalBody(body: unknown): CreateApprovalBody {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ApiRequestError(
      'request.body_invalid',
      'VALIDATION',
      'approval creation requires a JSON body with principal and scope',
    );
  }
  const raw = body as Record<string, unknown>;
  const principal = requireString(raw.principal, 'principal');
  if (typeof raw.scope !== 'object' || raw.scope === null || Array.isArray(raw.scope)) {
    throw new ApiRequestError('request.body_invalid', 'VALIDATION', 'scope must be an object');
  }
  const scopeRaw = raw.scope as Record<string, unknown>;
  if (!Array.isArray(scopeRaw.actions) || scopeRaw.actions.length === 0) {
    throw new ApiRequestError(
      'request.body_invalid',
      'VALIDATION',
      'scope.actions must be a non-empty array of action ids',
    );
  }
  const actions: string[] = [];
  for (const action of scopeRaw.actions) {
    actions.push(requireString(action, 'scope.actions entry'));
  }
  let resources: { readonly type: string; readonly resourceId?: string }[] | undefined;
  if (scopeRaw.resources !== undefined) {
    if (!Array.isArray(scopeRaw.resources) || scopeRaw.resources.length === 0) {
      throw new ApiRequestError(
        'request.body_invalid',
        'VALIDATION',
        'scope.resources must be a non-empty array when present',
      );
    }
    resources = [];
    for (const resource of scopeRaw.resources) {
      if (typeof resource !== 'object' || resource === null) {
        throw new ApiRequestError('request.body_invalid', 'VALIDATION', 'scope.resources entries must be objects');
      }
      const record = resource as Record<string, unknown>;
      const type = requireString(record.type, 'scope.resources[].type');
      const resourceId =
        record.resourceId === undefined ? undefined : requireString(record.resourceId, 'scope.resources[].resourceId');
      resources.push(resourceId === undefined ? { type } : { type, resourceId });
    }
  }
  let maxAmount: AmountSpec | undefined;
  if (scopeRaw.maxAmount !== undefined) {
    if (
      typeof scopeRaw.maxAmount !== 'object' ||
      scopeRaw.maxAmount === null ||
      typeof (scopeRaw.maxAmount as Record<string, unknown>).currency !== 'string' ||
      typeof (scopeRaw.maxAmount as Record<string, unknown>).minorUnits !== 'string'
    ) {
      throw new ApiRequestError(
        'request.body_invalid',
        'VALIDATION',
        'scope.maxAmount requires string currency and minorUnits (INV-F01)',
      );
    }
    maxAmount = {
      currency: (scopeRaw.maxAmount as Record<string, unknown>).currency as string,
      minorUnits: (scopeRaw.maxAmount as Record<string, unknown>).minorUnits as string,
    };
    try {
      validateAmountSpec(maxAmount);
    } catch (error) {
      if (error instanceof InvalidAmountError) {
        throw new ApiRequestError('request.body_invalid', 'VALIDATION', `invalid maxAmount: ${error.message}`);
      }
      throw error;
    }
  }
  let channel: CreateApprovalBody['channel'];
  if (raw.channel !== undefined) {
    const value = requireString(raw.channel, 'channel');
    if (value !== 'SMS' && value !== 'EMAIL' && value !== 'IN_APP' && value !== 'HARDWARE_KEY') {
      throw new ApiRequestError(
        'request.body_invalid',
        'VALIDATION',
        'channel must be one of SMS, EMAIL, IN_APP, HARDWARE_KEY',
      );
    }
    channel = value;
  }
  let ttlMs: number | undefined;
  if (raw.ttlMs !== undefined) {
    if (typeof raw.ttlMs !== 'number' || !Number.isInteger(raw.ttlMs) || raw.ttlMs <= 0) {
      throw new ApiRequestError('request.body_invalid', 'VALIDATION', 'ttlMs must be a positive integer');
    }
    ttlMs = raw.ttlMs;
  }
  let agentRef: string | undefined;
  if (raw.agentRef !== undefined) {
    agentRef = requireString(raw.agentRef, 'agentRef');
  }
  let requestHash: string | undefined;
  if (raw.requestHash !== undefined) {
    requestHash = requireString(raw.requestHash, 'requestHash');
  }
  return {
    principal,
    ...(agentRef === undefined ? {} : { agentRef }),
    scope: {
      actions,
      ...(resources === undefined ? {} : { resources }),
      ...(maxAmount === undefined ? {} : { maxAmount }),
    },
    ...(requestHash === undefined ? {} : { requestHash }),
    ...(channel === undefined ? {} : { channel }),
    ...(ttlMs === undefined ? {} : { ttlMs }),
  };
}

/**
 * Creates the router-agnostic API handler. All state (intents, approvals
 * projections, authoritative idempotent results) is per-handler in-memory
 * Stage-1 state; production persists via the @payswap/protocol persistence
 * contracts (later Work Orders).
 */
export function createApiHandler(deps: ApiDeps): ApiHandler {
  const intents = new Map<string, CommandEnvelope<unknown>>();
  const payments = new Map<string, { readonly paymentId: string; readonly accepted: boolean }>();
  const authoritativeResults = new Map<string, StoredAuthoritativeResponse>();

  const routes: readonly RouteDefinition[] = buildRoutes();

  function buildRoutes(): readonly RouteDefinition[] {
    const route = (
      method: 'GET' | 'POST',
      path: string,
      mutating: boolean,
      handler: (ctx: RouteContext) => Promise<EndpointResult>,
    ): RouteDefinition => ({ method, pattern: splitPath(path), mutating, handler });

    return [
      route('GET', '/v1/health', false, async (ctx) => ({
        kind: 'success',
        status: 200,
        data: {
          status: 'ok',
          apiVersion: ctx.request.apiVersion,
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          serverTime: isoFromMs(deps.clock.now()),
        },
      })),

      route('POST', '/v1/intents', true, handleCreateIntent),
      route('GET', '/v1/intents/:id', false, handleGetIntent),

      route('POST', '/v1/approvals', true, handleCreateApproval),
      route('GET', '/v1/approvals/:id', false, handleGetApproval),

      route('GET', '/v1/capabilities', false, async () => ({
        kind: 'success',
        status: 200,
        data: { capabilities: CAPABILITY_STUBS },
      })),

      // W3-001 conformance surface (echoes the reference fixture; see module
      // header). The stub payment mutation runs the SAME authorization
      // pipeline as real endpoints — no fabricated evidence.
      route('POST', '/payments', true, handleConformancePayment),
      route('GET', '/payments', false, async () => ({
        kind: 'success',
        status: 200,
        data: { accepted: true, note: 'conformance surface (W3-001 reference fixture echo)' },
      })),
      route('GET', '/payments/:id', false, async (ctx) => {
        const id = ctx.pathParams['id'];
        if (id === undefined || payments.get(id) === undefined) {
          return notFound(`payment not found: ${id ?? ''}`);
        }
        return { kind: 'success', status: 200, data: payments.get(id) };
      }),

      // Failure-path simulation for the conformance harness: an externally
      // ambiguous provider outcome. NEVER a fake settlement — it returns the
      // EXTERNAL_AMBIGUITY error state that reconciliation owns (INV-X01/X03).
      route('POST', '/simulations/external-ambiguity', true, async () => ({
        kind: 'error',
        error: externalAmbiguityError(),
      })),
    ];
  }

  // -------------------------------------------------------------------------
  // Endpoint logic
  // -------------------------------------------------------------------------

  async function handleCreateIntent(ctx: RouteContext): Promise<EndpointResult> {
    const body = parseIntentBody(ctx.request.body);
    const commandType = body.commandType ?? DEFAULT_INTENT_COMMAND_TYPE;
    const nowMs = Number(deps.clock.now());

    // The authorization binding hash covers the CORE intent payload: the
    // approval artifact reference is presentation meta and excluded, so the
    // post-approval re-submission of the same intent binds to the same hash
    // (and therefore to the approval artifact minted for it).
    const corePayload = {
      kind: 'intent',
      commandType,
      ...(body.amount === undefined ? {} : { amount: body.amount }),
      ...(body.correlationId === undefined ? {} : { correlationId: body.correlationId }),
    };
    const requestHash = computeRequestHash(corePayload);
    const principal = ctx.principal;
    const authorizationRequest = {
      principal,
      action: commandType,
      resource: { type: INTENT_RESOURCE_TYPE },
      context: {
        ...(body.amount === undefined ? {} : { amount: body.amount }),
      },
      requestHash,
      requestedAt: nowMs,
    };

    if (body.approvalArtifactRef !== undefined) {
      // Approved NEEDS_APPROVAL flow: the artifact is the authority (INV-A03).
      const grant = deps.grants.issueFromApproval({
        tenantId: ctx.tenantId,
        principal,
        request: authorizationRequest,
        approvalArtifactRef: body.approvalArtifactRef,
      });
      const envelope = mintIntentEnvelope(ctx, commandType, body, requestHash);
      return {
        kind: 'success',
        status: 200,
        data: { intent: envelope, grantRef: grant.lineage.grantRef, approvalArtifactRef: grant.lineage.approvalArtifactRef },
        evidenceRef: grant.lineage.grantRef,
      };
    }

    const adjudication = deps.grants.adjudicate({
      tenantId: ctx.tenantId,
      principal,
      request: authorizationRequest,
    });

    if (adjudication.kind === 'GRANT_ISSUED') {
      const envelope = mintIntentEnvelope(ctx, commandType, body, requestHash);
      return {
        kind: 'success',
        status: 200,
        data: { intent: envelope, grantRef: adjudication.grant.lineage.grantRef },
        evidenceRef: adjudication.grant.lineage.grantRef,
      };
    }

    if (adjudication.kind === 'NEEDS_APPROVAL') {
      // W3-002 acceptance: a principal acting beyond mandate receives an
      // approval REQUEST — not an error-less execution and not a silent deny.
      const spec = adjudication.decision.approvalSpec;
      const agentRef = principal.kind === 'agent' ? principalRef(principal) : undefined;
      const approvalRequest: PendingApproval = await deps.approvals.createApprovalRequest({
        principal: spec.approverRef,
        ...(agentRef === undefined ? {} : { agentRef }),
        scope: spec.scope,
        requestHash,
        expiresAtMs: spec.expiresAt,
        channel: DEFAULT_APPROVAL_CHANNEL,
      });
      const approvalMessage: ApprovalMessage = deps.approvals.renderApprovalMessage({
        principal: spec.approverRef,
        ...(agentRef === undefined ? {} : { agentRef }),
        requestedAuthorityScope: {
          domain: INTENT_RESOURCE_TYPE === 'intent' ? 'payments' : 'general',
          actions: [...spec.scope.actions],
        },
        requestHash,
        expiresAt: approvalRequest.expiresAt,
        channel: DEFAULT_APPROVAL_CHANNEL,
      });
      return {
        kind: 'success',
        status: 202,
        data: { approvalRequest, approvalMessage },
        evidenceRef: `decision:${requestHash}`,
      };
    }

    // DENY — fail closed with the deterministic reason (revoked/expired
    // authority lands here too: stale_security_epoch, mandate_expired, ...).
    return {
      kind: 'error',
      error: apiErrorFromAdjudicationDeny(adjudication.decision),
    };
  }

  function mintIntentEnvelope(
    ctx: RouteContext,
    commandType: string,
    body: IntentBody,
    requestHash: string,
  ): CommandEnvelope<unknown> {
    const principal = ctx.principal;
    const envelope = createCommandEnvelope<unknown>(
      {
        commandType,
        payload: {
          intentStub: true,
          // NO FAKE SETTLEMENT: an intent is a recorded proposal-shaped
          // command; financial finality belongs to the protocol authority
          // (INV-F06, AGENTS.md rule 5).
          authorizationRequestHash: requestHash,
          ...(body.amount === undefined ? {} : { amount: body.amount }),
        },
        principalRef: {
          principalType: principal.kind,
          principalId:
            principal.kind === 'agent' ? principal.agentKeyFingerprint : principal.id,
        },
        idempotencyKey: requireString(ctx.request.idempotencyKey, 'idempotencyKey'),
        ...(body.correlationId === undefined ? {} : { correlationId: body.correlationId }),
        schemaVersion: PROTOCOL_SCHEMA_VERSION,
      },
      { ids: deps.ids, clock: deps.clock },
    );
    intents.set(envelope.id, envelope);
    return envelope;
  }

  async function handleGetIntent(ctx: RouteContext): Promise<EndpointResult> {
    const id = ctx.pathParams['id'];
    const envelope = id === undefined ? undefined : intents.get(id);
    if (envelope === undefined) {
      return notFound(`intent not found: ${id ?? ''}`);
    }
    return { kind: 'success', status: 200, data: { intent: envelope } };
  }

  async function handleCreateApproval(ctx: RouteContext): Promise<EndpointResult> {
    const body = parseCreateApprovalBody(ctx.request.body);
    const nowMs = Number(deps.clock.now());
    const requestHash =
      body.requestHash ?? computeRequestHash({ kind: 'approval', principal: body.principal, scope: body.scope });
    const approvalRequest: PendingApproval = await deps.approvals.createApprovalRequest({
      principal: body.principal,
      ...(body.agentRef === undefined ? {} : { agentRef: body.agentRef }),
      scope: {
        actions: [...body.scope.actions],
        resources: body.scope.resources ?? [{ type: 'general' }],
        ...(body.scope.maxAmount === undefined ? {} : { maxAmount: body.scope.maxAmount }),
      },
      requestHash,
      expiresAtMs: nowMs + (body.ttlMs ?? DEFAULT_APPROVAL_TTL_MS),
      channel: body.channel ?? DEFAULT_APPROVAL_CHANNEL,
    });
    const approvalMessage = deps.approvals.renderApprovalMessage({
      principal: body.principal,
      ...(body.agentRef === undefined ? {} : { agentRef: body.agentRef }),
      requestedAuthorityScope: {
        domain: body.scope.actions[0]?.split('.')[0] ?? 'general',
        actions: [...body.scope.actions],
      },
      requestHash,
      expiresAt: approvalRequest.expiresAt,
      channel: body.channel ?? DEFAULT_APPROVAL_CHANNEL,
    });
    return {
      kind: 'success',
      status: 202,
      data: { approvalRequest, approvalMessage },
      evidenceRef: `approval:${requestHash}`,
    };
  }

  async function handleGetApproval(ctx: RouteContext): Promise<EndpointResult> {
    const requestHash = ctx.pathParams['id'];
    const record = requestHash === undefined ? undefined : deps.approvals.getApprovalRecord(requestHash);
    if (record === undefined) {
      return notFound(`approval not found: ${requestHash ?? ''}`);
    }
    return { kind: 'success', status: 200, data: { approval: record } };
  }

  async function handleConformancePayment(ctx: RouteContext): Promise<EndpointResult> {
    // The conformance stub payment runs the same deterministic authorization
    // pipeline as the real endpoints (action on the conformance demo surface).
    const requestHash = computeRequestHash({ kind: 'conformance-payment', path: ctx.request.path });
    const adjudication = deps.grants.adjudicate({
      tenantId: ctx.tenantId,
      principal: ctx.principal,
      request: {
        principal: ctx.principal,
        action: 'conformance.payments.accept',
        resource: { type: 'payment' },
        context: {},
        requestHash,
        requestedAt: Number(deps.clock.now()),
      },
    });
    if (adjudication.kind === 'DENIED') {
      return { kind: 'error', error: apiErrorFromAdjudicationDeny(adjudication.decision) };
    }
    if (adjudication.kind === 'NEEDS_APPROVAL') {
      // The conformance surface demands immediate acceptance (reference
      // fixture semantics); requiring approval here is a configuration error.
      return {
        kind: 'error',
        error: {
          code: 'conformance.approval_required',
          category: 'POLICY',
          message:
            'the conformance payment surface requires a mandate allowing conformance.payments.accept for the authenticated principal',
        },
      };
    }
    const paymentId = deps.ids.mintId('pm');
    payments.set(paymentId, { paymentId, accepted: true });
    return {
      kind: 'success',
      status: 200,
      data: { accepted: true, paymentId },
      evidenceRef: adjudication.grant.lineage.grantRef,
    };
  }

  // -------------------------------------------------------------------------
  // Dispatch pipeline
  // -------------------------------------------------------------------------

  function matchRoute(method: string, path: string): { route: RouteDefinition; params: Record<string, string> } | undefined {
    const segments = splitPath(path);
    for (const route of routes) {
      if (route.method !== method || route.pattern.length !== segments.length) {
        continue;
      }
      const params: Record<string, string> = {};
      let matched = true;
      for (let index = 0; index < route.pattern.length; index += 1) {
        const patternSegment = route.pattern[index];
        const actualSegment = segments[index];
        if (patternSegment === undefined || actualSegment === undefined) {
          matched = false;
          break;
        }
        if (patternSegment.startsWith(':')) {
          params[patternSegment.slice(1)] = actualSegment;
        } else if (patternSegment !== actualSegment) {
          matched = false;
          break;
        }
      }
      if (matched) {
        return { route, params };
      }
    }
    return undefined;
  }

  function authenticate(request: ApiRequest): { principal: Principal; tenantId: string } {
    const auth: RequestAuth = request.auth;
    if (auth.scheme !== 'SESSION') {
      throw new ApiRequestError(
        'auth.scheme_unsupported',
        'AUTHORIZATION_REQUIRED',
        `W3-002 authenticates via session tokens; scheme ${auth.scheme} is not supported here`,
      );
    }
    const token = request.sessionToken;
    if (typeof token !== 'string' || token.length === 0) {
      throw new ApiRequestError(
        'auth.session_token_required',
        'AUTHORIZATION_REQUIRED',
        'SESSION authentication requires the session token',
      );
    }
    const lookup = deps.sessions.lookupSession(token);
    if (!lookup.valid) {
      // Fail closed: unknown, revoked, expired or epoch-stale sessions never
      // authenticate (INV-A02).
      throw new ApiRequestError(
        'auth.session_invalid',
        'AUTHORIZATION_REQUIRED',
        `session rejected: ${lookup.reason}`,
        { reason: lookup.reason },
      );
    }
    const session = lookup.session;
    const claimedPrincipal = auth.principal;
    if (claimedPrincipal !== principalRef(session.principal)) {
      throw new ApiRequestError(
        'auth.principal_mismatch',
        'AUTHORIZATION_REQUIRED',
        'the claimed principal does not match the authenticated session principal',
      );
    }
    return { principal: session.principal, tenantId: session.tenantId };
  }

  function toApiError(error: unknown): ApiError {
    if (error instanceof PaySwapError) {
      const category = PROTOCOL_TO_REST_CATEGORY[error.category];
      const reconciliationRef =
        error.category === 'EXTERNAL_AMBIGUITY' ? deps.ids.mintId('recon') : undefined;
      return {
        code: error.code,
        category,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
        ...(reconciliationRef === undefined ? {} : { reconciliationRef }),
      };
    }
    // A foreign error is a genuine internal failure (never an ambiguity:
    // ambiguity is an explicit protocol state, INV-X01).
    return {
      code: 'internal.unhandled_error',
      category: 'INTERNAL',
      message: error instanceof Error ? error.message : 'unhandled internal error',
    };
  }

  function externalAmbiguityError(): ApiError {
    return {
      code: 'provider.outcome_unknown',
      category: 'EXTERNAL_AMBIGUITY',
      message:
        'the external provider outcome is unknown; reconciliation is authoritative (INV-X01/INV-X03)',
      reconciliationRef: deps.ids.mintId('recon'),
    };
  }

  function notFound(message: string): EndpointResult {
    return {
      kind: 'error',
      error: { code: 'resource.not_found', category: 'NOT_FOUND', message },
    };
  }

  function apiErrorFromAdjudicationDeny(
    decision: Extract<AuthorizationDecision, { decision: 'DENY' }>,
  ): ApiError {
    return {
      code: 'authorization.denied',
      category: 'AUTHORIZATION',
      message: `authorization denied: ${decision.reason} (fail closed)`,
      details: { reason: decision.reason, policyRefs: [...decision.policyRefs] },
    };
  }

  function errorResponse(error: ApiError, requestId: string): Extract<ApiResponse, { kind: 'error' }> {
    const body: ErrorResponse = {
      error,
      meta: { schemaVersion: CONTRACT_SCHEMA_VERSION, requestId },
    };
    const marker = outcomeMarkerForErrorCategory(error.category);
    return {
      kind: 'error',
      status: mapErrorCategoryToHttpStatus(error.category),
      body,
      ...(marker === undefined ? {} : { headers: { [OUTCOME_HEADER]: marker } }),
    };
  }

  function successResponse(
    stored: StoredAuthoritativeResponse,
    requestId: string,
    idempotentReplay: boolean,
  ): ApiResponse {
    if (stored.error !== undefined) {
      // Authoritative ambiguous outcome replay: identical error + marker,
      // fresh requestId, explicit idempotentReplay flag.
      const body: ErrorResponse = {
        error: stored.error,
        meta: { schemaVersion: CONTRACT_SCHEMA_VERSION, requestId },
      };
      const marker = outcomeMarkerForErrorCategory(stored.error.category);
      return {
        kind: 'error',
        status: stored.status,
        body,
        ...(stored.headers === undefined && marker === undefined
          ? {}
          : {
              headers: {
                ...(stored.headers ?? {}),
                ...(marker === undefined ? {} : { [OUTCOME_HEADER]: marker }),
              },
            }),
      };
    }
    const meta: ApiSuccessMeta = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      requestId,
      ...(idempotentReplay ? { idempotentReplay: true } : {}),
      ...(stored.evidenceRef === undefined ? {} : { evidenceRef: stored.evidenceRef }),
    };
    const envelope: ApiSuccessEnvelope = { data: stored.data, meta };
    return {
      kind: 'success',
      status: stored.status,
      envelope,
      ...(stored.headers === undefined ? {} : { headers: { ...stored.headers } }),
    };
  }

  async function runEndpoint(ctx: RouteContext, route: RouteDefinition): Promise<EndpointResult> {
    try {
      return await route.handler(ctx);
    } catch (error) {
      // toApiError maps PaySwapError categories deterministically — including
      // EXTERNAL_AMBIGUITY (with a reconciliationRef); foreign errors map to
      // INTERNAL, never to a fabricated success or a coerced failure.
      return { kind: 'error', error: toApiError(error) };
    }
  }

  /**
   * INV-F05 idempotency wrapper for mutations: begin → execute → complete/fail,
   * replays return the stored authoritative result, same key + different
   * command → CONFLICT. EXTERNAL_AMBIGUITY results are completed (never
   * re-armed) so unknown external writes cannot be blindly retried (INV-X02).
   */
  async function executeMutation(
    ctx: RouteContext,
    route: RouteDefinition,
    commandType: string,
  ): Promise<ApiResponse> {
    const idempotencyKey = ctx.request.idempotencyKey;
    if (idempotencyKey === undefined) {
      // Defensive: validateRequestEnvelope already guarantees the key on
      // mutations; reaching here is an internal pipeline error (never silent).
      return errorResponse(
        {
          code: 'internal.idempotency_key_missing',
          category: 'INTERNAL',
          message: 'mutation reached execution without an idempotency key',
        },
        ctx.requestId,
      );
    }
    const scope = {
      commandType,
      principal: {
        principalType: ctx.principal.kind,
        principalId: ctx.principal.kind === 'agent' ? ctx.principal.agentKeyFingerprint : ctx.principal.id,
      },
      key: idempotencyKey,
    };
    const commandHash = computeRequestHash({ method: ctx.request.method, path: ctx.request.path, body: ctx.request.body });
    const outcome = deps.idempotency.begin(scope, commandHash);
    const resultKey = canonicalScopeKey(scope);

    if (outcome.kind === 'CONFLICT') {
      return errorResponse(
        {
          code: 'request.idempotency_conflict',
          category: 'CONFLICT',
          message:
            'this idempotency key was already used for a different command; one key maps to one authoritative result (INV-F05)',
          details: { commandType, recordedCommandHash: outcome.record.commandHash },
        },
        ctx.requestId,
      );
    }
    if (outcome.kind === 'REPLAY') {
      if (outcome.record.status === 'IN_FLIGHT') {
        return errorResponse(
          {
            code: 'request.in_flight',
            category: 'CONFLICT',
            message: 'the command for this idempotency key is currently in flight',
            details: { commandType },
          },
          ctx.requestId,
        );
      }
      const stored = authoritativeResults.get(resultKey);
      if (stored === undefined) {
        // Registrar says COMPLETED but the authoritative result is gone — an
        // internal consistency failure, surfaced as INTERNAL (never silent).
        return errorResponse(
          {
            code: 'internal.idempotency_result_missing',
            category: 'INTERNAL',
            message: 'idempotency record completed but the authoritative result is unavailable',
          },
          ctx.requestId,
        );
      }
      return successResponse(stored, ctx.requestId, true);
    }

    const result = await runEndpoint(ctx, route);

    if (result.kind === 'success') {
      const resultHash = computeRequestHash(canonicalSafe({ status: result.status, data: result.data }));
      deps.idempotency.complete(scope, resultHash);
      const stored: StoredAuthoritativeResponse = {
        status: result.status,
        data: result.data,
        ...(result.evidenceRef === undefined ? {} : { evidenceRef: result.evidenceRef }),
      };
      authoritativeResults.set(resultKey, stored);
      return successResponse(stored, ctx.requestId, false);
    }

    if (result.error.category === 'EXTERNAL_AMBIGUITY') {
      // INV-X02: the authoritative outcome of this key is "unknown" — complete
      // the scope so a retry replays the same ambiguous result instead of
      // blindly re-executing.
      const resultHash = computeRequestHash(
        canonicalSafe({ status: mapErrorCategoryToHttpStatus('EXTERNAL_AMBIGUITY'), error: result.error }),
      );
      deps.idempotency.complete(scope, resultHash);
      const stored: StoredAuthoritativeResponse = {
        status: mapErrorCategoryToHttpStatus('EXTERNAL_AMBIGUITY'),
        error: result.error,
        headers: { [OUTCOME_HEADER]: EXTERNAL_AMBIGUITY_OUTCOME_MARKER },
      };
      authoritativeResults.set(resultKey, stored);
      return successResponse(stored, ctx.requestId, false);
    }

    // Deterministic failure: fail the scope so a corrected retry may re-arm
    // (INV-O01 retry-safety).
    deps.idempotency.fail(scope);
    return errorResponse(result.error, ctx.requestId);
  }

  return async function handle(request: ApiRequest): Promise<ApiResponse> {
    const requestId = deps.ids.mintId('req');

    const validation = validateRequestEnvelope(request);
    if (!validation.ok) {
      return errorResponse(
        {
          code: 'request.invalid',
          category: 'VALIDATION',
          message: validation.violations.join('; '),
        },
        requestId,
      );
    }

    const match = matchRoute(request.method, request.path);
    if (match === undefined) {
      return errorResponse(
        {
          code: 'route.not_found',
          category: 'NOT_FOUND',
          message: `no route for ${request.method} ${request.path}`,
        },
        requestId,
      );
    }

    let authenticated: { principal: Principal; tenantId: string };
    try {
      authenticated = authenticate(request);
    } catch (error) {
      return errorResponse(toApiError(error), requestId);
    }

    const ctx: RouteContext = {
      request,
      requestId,
      principal: authenticated.principal,
      tenantId: authenticated.tenantId,
      pathParams: match.params,
    };

    if (match.route.mutating) {
      return executeMutation(ctx, match.route, `${request.method} ${request.path}`);
    }
    const result = await runEndpoint(ctx, match.route);
    if (result.kind === 'success') {
      return successResponse(
        {
          status: result.status,
          data: result.data,
          ...(result.evidenceRef === undefined ? {} : { evidenceRef: result.evidenceRef }),
        },
        requestId,
        false,
      );
    }
    return errorResponse(result.error, requestId);
  };
}

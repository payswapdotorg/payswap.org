import { describe, expect, it } from 'vitest';

import type { HttpContractSubject, HttpTransportResult } from '@payswap/interfaces';
import { CURRENT_API_VERSION, OUTCOME_HEADER, runHttpContractTests } from '@payswap/interfaces';
import { principalRef } from '@payswap/trust';

import type { ApiRequest, ApiResponse } from '../src/http.js';

import {
  ALICE,
  CLOCK_SEED_MS,
  LARGE_AMOUNT,
  SMALL_AMOUNT,
  authedRequest,
  buildHarness,
  conformanceGrants,
  grantFixture,
  mandateFixture,
  type AuthedRequestOptions,
  type TestHarness,
} from './fixtures.js';

const NOW_MS = Number(CLOCK_SEED_MS);

function allowHarness(): TestHarness {
  const mandate = mandateFixture({ id: 'mand_http_allow', grantee: principalRef(ALICE) });
  return buildHarness([grantFixture(mandate, 'grant_http_allow_1', NOW_MS)]);
}

function escalationHarness(): TestHarness {
  const mandate = mandateFixture({
    id: 'mand_http_escalate',
    grantee: principalRef(ALICE),
    perTransactionAmount: { currency: 'USD', minorUnits: '100000' },
    escalation: 'require_approval',
    approverRef: 'user:owner',
  });
  return buildHarness([grantFixture(mandate, 'grant_http_escalate_1', NOW_MS)]);
}

function denyHarness(): TestHarness {
  const mandate = mandateFixture({
    id: 'mand_http_deny',
    grantee: principalRef(ALICE),
    perTransactionAmount: { currency: 'USD', minorUnits: '100000' },
    escalation: 'deny',
  });
  return buildHarness([grantFixture(mandate, 'grant_http_deny_1', NOW_MS)]);
}

/**
 * Harness-bound request helper: authenticates with alice's live session
 * token by default (the raw authedRequest builder is used directly by the
 * adversarial auth tests that must NOT carry a token).
 */
async function api(
  harness: TestHarness,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  options?: AuthedRequestOptions,
): Promise<ApiResponse> {
  const opts: AuthedRequestOptions = options ?? {};
  const token = opts.sessionToken ?? harness.aliceSessionToken;
  return harness.handler(
    authedRequest(method, path, {
      ...opts,
      ...(token === undefined ? {} : { sessionToken: token }),
    }),
  );
}

function expectSuccess(result: ApiResponse): Extract<HttpTransportResult, { kind: 'success' }> {
  if (result.kind !== 'success') {
    throw new Error(`expected success, got error: ${JSON.stringify(result.body.error)}`);
  }
  return result;
}

function expectError(result: ApiResponse): Extract<HttpTransportResult, { kind: 'error' }> {
  if (result.kind !== 'error') {
    throw new Error('expected error response');
  }
  return result;
}

describe('createApiHandler (http.ts) — W3-001 REST contract conformance', () => {
  // The conformance harness speaks the plain W3-001 RequestEnvelope; this
  // wrapper is the TEST transport: it carries the session token (from the
  // Authorization header in a production edge) and derives auth.principal
  // from the authenticated session. The handler itself independently
  // re-validates the session ↔ principal binding — the wrapper cannot
  // smuggle authority.
  const harness = buildHarness(conformanceGrants(NOW_MS));
  const conformanceSession = harness.sessions.issueSession({
    tenantId: 'tenant_conformance',
    principalRef: 'user:user_conformance',
    ttlMs: 3_600_000,
  });
  const subject: HttpContractSubject = {
    handle: (request) =>
      harness.handler({
        ...request,
        auth: { principal: principalRef(conformanceSession.principal), scheme: 'SESSION' },
        sessionToken: conformanceSession.token,
      } satisfies ApiRequest),
  };
  runHttpContractTests(subject, (name, fn) => {
    it(name, fn);
  });
});

describe('createApiHandler (http.ts) — session authentication', () => {
  it('rejects SESSION requests without a token (fail closed)', async () => {
    const harness = allowHarness();
    const error = expectError(await harness.handler(authedRequest('GET', '/v1/health')));
    expect(error.status).toBe(403);
    expect(error.body.error.category).toBe('AUTHORIZATION');
    expect(error.body.error.code).toBe('auth.session_token_required');
  });

  it('rejects unknown session tokens', async () => {
    const harness = allowHarness();
    const error = expectError(
      await harness.handler(authedRequest('GET', '/v1/health', { sessionToken: 'sess_forged' })),
    );
    expect(error.status).toBe(403);
    expect(error.body.error.code).toBe('auth.session_invalid');
  });

  it('rejects a claimed principal that does not match the session (fail closed)', async () => {
    const harness = allowHarness();
    const error = expectError(await api(harness, 'GET', '/v1/health', { principal: 'user:mallory' }));
    expect(error.status).toBe(403);
    expect(error.body.error.code).toBe('auth.principal_mismatch');
  });

  it('rejects unsupported auth schemes (W3-002 scope: session flows)', async () => {
    const harness = allowHarness();
    const error = expectError(
      await harness.handler({
        method: 'GET',
        path: '/v1/health',
        auth: { principal: 'user:alice', scheme: 'API_KEY' },
        apiVersion: CURRENT_API_VERSION,
        sessionToken: harness.aliceSessionToken,
      }),
    );
    expect(error.status).toBe(403);
    expect(error.body.error.code).toBe('auth.scheme_unsupported');
  });

  it('serves health for an authenticated session', async () => {
    const harness = allowHarness();
    const success = expectSuccess(await api(harness, 'GET', '/v1/health'));
    expect(success.status).toBe(200);
    const data = success.envelope.data as { status: string; apiVersion: string };
    expect(data.status).toBe('ok');
    expect(data.apiVersion).toBe(CURRENT_API_VERSION);
  });

  it('revoked sessions fail closed (W3-002 acceptance: revoked authority)', async () => {
    const harness = allowHarness();
    harness.sessions.revokeSession(harness.aliceSessionToken);
    const error = expectError(await api(harness, 'GET', '/v1/health'));
    expect(error.status).toBe(403);
    expect(error.body.error.details).toEqual({ reason: 'REVOKED' });
  });

  it('expired sessions fail closed (W3-002 acceptance: expired authority)', async () => {
    const harness = allowHarness();
    // issue a short-lived session directly
    const short = harness.sessions.issueSession({
      tenantId: 'tenant_demo',
      principalRef: principalRef(ALICE),
      ttlMs: 1_000,
    });
    harness.clock.advanceMs(2_000);
    const error = expectError(
      await harness.handler(authedRequest('GET', '/v1/health', { sessionToken: short.token })),
    );
    expect(error.status).toBe(403);
    expect(error.body.error.details).toEqual({ reason: 'EXPIRED' });
  });

  it('epoch-stale sessions fail closed (INV-A02: revoked credential)', async () => {
    const harness = allowHarness();
    harness.epochLedger.raiseEpoch(principalRef(ALICE), 'credential rotation', NOW_MS);
    const error = expectError(await api(harness, 'POST', '/v1/intents', { idempotencyKey: 'ik-stale-epoch' }));
    expect(error.status).toBe(403);
    expect(error.body.error.details).toEqual({ reason: 'STALE_SECURITY_EPOCH' });
  });
});

describe('createApiHandler (http.ts) — POST /v1/intents', () => {
  it('creates a stub intent echoing the protocol envelope shape (no fake settlement)', async () => {
    const harness = allowHarness();
    const success = expectSuccess(
      await api(harness, 'POST', '/v1/intents', {
        idempotencyKey: 'ik-intent-1',
        body: { amount: SMALL_AMOUNT, correlationId: 'corr-1' },
      }),
    );
    expect(success.status).toBe(200);
    const data = success.envelope.data as {
      intent: {
        id: string;
        commandType: string;
        principalRef: { principalType: string; principalId: string };
        idempotencyKey: string;
        issuedAt: bigint;
        schemaVersion: number;
        correlationId?: string;
        payload: { intentStub: boolean; authorizationRequestHash: string; amount?: unknown };
      };
      grantRef: string;
    };
    expect(data.intent.id).toMatch(/^cmd_/);
    expect(data.intent.commandType).toBe('payments.intent.create');
    expect(data.intent.principalRef).toEqual({ principalType: 'user', principalId: 'alice' });
    expect(data.intent.idempotencyKey).toBe('ik-intent-1');
    expect(data.intent.schemaVersion).toBe(1);
    expect(data.intent.correlationId).toBe('corr-1');
    expect(data.intent.payload.intentStub).toBe(true);
    expect(data.grantRef).toMatch(/^grant:/);

    // GET /v1/intents/:id returns the stored envelope
    const fetched = expectSuccess(await api(harness, 'GET', `/v1/intents/${data.intent.id}`));
    const fetchedData = fetched.envelope.data as { intent: { id: string } };
    expect(fetchedData.intent.id).toBe(data.intent.id);
  });

  it('GET /v1/intents/:id answers unknown ids with NOT_FOUND', async () => {
    const harness = allowHarness();
    const error = expectError(await api(harness, 'GET', '/v1/intents/int_does_not_exist'));
    expect(error.status).toBe(404);
    expect(error.body.error.category).toBe('NOT_FOUND');
  });

  it('every mutation response carries meta.evidenceRef (W3-002 acceptance: evidence links)', async () => {
    const harness = allowHarness();
    const success = expectSuccess(
      await api(harness, 'POST', '/v1/intents', {
        idempotencyKey: 'ik-evidence-1',
        body: { amount: SMALL_AMOUNT },
      }),
    );
    const meta = success.envelope.meta as { evidenceRef?: string };
    expect(typeof meta.evidenceRef).toBe('string');
    expect(meta.evidenceRef).toMatch(/^grant:/);
  });

  it('idempotent mutations: replay returns the original result with idempotentReplay (INV-F05)', async () => {
    const harness = allowHarness();
    const first = expectSuccess(
      await api(harness, 'POST', '/v1/intents', {
        idempotencyKey: 'ik-replay-demo',
        body: { amount: SMALL_AMOUNT },
      }),
    );
    const second = expectSuccess(
      await api(harness, 'POST', '/v1/intents', {
        idempotencyKey: 'ik-replay-demo',
        body: { amount: SMALL_AMOUNT },
      }),
    );
    expect(second.envelope.meta.idempotentReplay).toBe(true);
    expect(second.envelope.data).toEqual(first.envelope.data);
    expect(second.envelope.meta.requestId).not.toBe(first.envelope.meta.requestId);
    // Only ONE intent exists (no double execution):
    const intentId = (first.envelope.data as { intent: { id: string } }).intent.id;
    const again = expectSuccess(await api(harness, 'GET', `/v1/intents/${intentId}`));
    expect((again.envelope.data as { intent: unknown }).intent).toEqual(
      (first.envelope.data as { intent: unknown }).intent,
    );
  });

  it('same idempotency key with a different command is a CONFLICT (INV-F05 violation)', async () => {
    const harness = allowHarness();
    expectSuccess(
      await api(harness, 'POST', '/v1/intents', {
        idempotencyKey: 'ik-conflict-1',
        body: { amount: SMALL_AMOUNT },
      }),
    );
    const error = expectError(
      await api(harness, 'POST', '/v1/intents', {
        idempotencyKey: 'ik-conflict-1',
        body: { amount: LARGE_AMOUNT },
      }),
    );
    expect(error.status).toBe(409);
    expect(error.body.error.category).toBe('CONFLICT');
    expect(error.body.error.code).toBe('request.idempotency_conflict');
  });

  it('failed mutations re-arm (retry-safety): a DENIED request can be retried after correction', async () => {
    const harness = denyHarness();
    const denied = expectError(
      await api(harness, 'POST', '/v1/intents', {
        idempotencyKey: 'ik-retry-1',
        body: { amount: LARGE_AMOUNT },
      }),
    );
    expect(denied.status).toBe(403);
    // Deterministic failure -> the scope failed -> a retry with the SAME key
    // and the SAME command deterministically denies again (no silent second
    // execution, no stuck in-flight state).
    const deniedAgain = expectError(
      await api(harness, 'POST', '/v1/intents', {
        idempotencyKey: 'ik-retry-1',
        body: { amount: LARGE_AMOUNT },
      }),
    );
    expect(deniedAgain.status).toBe(403);
    expect(deniedAgain.body.error.details).toEqual(denied.body.error.details);
  });

  it('out-of-scope action produces an approval request — not an execution and not a silent deny (WO acceptance)', async () => {
    const harness = escalationHarness();
    const success = expectSuccess(
      await api(harness, 'POST', '/v1/intents', {
        idempotencyKey: 'ik-approval-1',
        body: { amount: LARGE_AMOUNT },
      }),
    );
    expect(success.status).toBe(202);
    const data = success.envelope.data as {
      approvalRequest: { requestHash: string; status: string; channel: string };
      approvalMessage: { text: string; deepLink: string };
    };
    expect(data.approvalRequest.status).toBe('PENDING');
    expect(data.approvalMessage.text).toContain(`APPROVE ${data.approvalRequest.requestHash}`);
    expect(data.approvalMessage.deepLink).toContain('/approvals/');
    const meta = success.envelope.meta as { evidenceRef?: string };
    expect(meta.evidenceRef).toMatch(/^decision:/);
    // The approval request is retrievable via GET /v1/approvals/:id:
    const record = expectSuccess(
      await api(harness, 'GET', `/v1/approvals/${data.approvalRequest.requestHash}`),
    );
    const recordData = record.envelope.data as { approval: { requestHash: string; status: string } };
    expect(recordData.approval.status).toBe('PENDING');
  });

  it('the full approved journey: approval request → out-of-band confirmation → re-submission with the artifact → grant with lineage', async () => {
    const harness = escalationHarness();
    const body = { amount: LARGE_AMOUNT, correlationId: 'corr-journey' };

    // 1. Beyond mandate → approval request
    const needsApproval = expectSuccess(
      await api(harness, 'POST', '/v1/intents', { idempotencyKey: 'ik-journey-1', body }),
    );
    expect(needsApproval.status).toBe(202);
    const requestHash = (needsApproval.envelope.data as { approvalRequest: { requestHash: string } })
      .approvalRequest.requestHash;

    // 2. Out-of-band trusted-channel confirmation (never chat text)
    const confirmation = harness.approvals.trustedChannelConfirmation({
      principal: 'user:owner',
      requestHash,
      decision: 'APPROVED',
    });
    await harness.approvals.issueSignedApproval(confirmation);

    // 3. Re-submit the SAME intent payload + the artifact reference
    const approved = expectSuccess(
      await api(harness, 'POST', '/v1/intents', {
        idempotencyKey: 'ik-journey-2',
        body: { ...body, approvalArtifactRef: `approval:${requestHash}` },
      }),
    );
    expect(approved.status).toBe(200);
    const data = approved.envelope.data as {
      intent: { id: string; payload: { authorizationRequestHash: string } };
      grantRef: string;
      approvalArtifactRef: string;
    };
    expect(data.intent.payload.authorizationRequestHash).toBe(requestHash);
    expect(data.approvalArtifactRef).toBe(`approval:${requestHash}`);
    const meta = approved.envelope.meta as { evidenceRef?: string };
    expect(meta.evidenceRef).toBe(data.grantRef);

    // The grant carries its full authorization lineage (approved actions
    // CARRY their lineage — W3-002 acceptance).
    const grant = harness.grants.getGrant(data.grantRef.replace(/^grant:/, ''));
    expect(grant).toBeDefined();
    if (grant !== undefined) {
      expect(grant.lineage.decisionRef).toBe(`decision:${requestHash}`);
      expect(grant.lineage.approvalArtifactRef).toBe(`approval:${requestHash}`);
    }

    // 4. The artifact is single-redemption: re-use fails closed.
    const replayed = expectError(
      await api(harness, 'POST', '/v1/intents', {
        idempotencyKey: 'ik-journey-3',
        body: { ...body, approvalArtifactRef: `approval:${requestHash}` },
      }),
    );
    expect(replayed.status).toBe(403);
    expect(replayed.body.error.details).toEqual({
      approvalArtifactRef: `approval:${requestHash}`,
      reason: 'ARTIFACT_CONSUMED',
    });
  });

  it('out-of-scope action with a deny policy fails closed with 403 and the deterministic reason', async () => {
    const harness = denyHarness();
    const error = expectError(
      await api(harness, 'POST', '/v1/intents', {
        idempotencyKey: 'ik-deny-1',
        body: { amount: LARGE_AMOUNT },
      }),
    );
    expect(error.status).toBe(403);
    expect(error.body.error.category).toBe('AUTHORIZATION');
    expect(error.body.error.code).toBe('authorization.denied');
    expect((error.body.error.details as { reason: string }).reason).toBe('per_transaction_limit_exceeded');
    expect((error.body.error.details as { policyRefs: string[] }).policyRefs.length).toBeGreaterThan(0);
  });

  it('rejects invalid intent bodies with 400 VALIDATION (exact integer money, INV-F01)', async () => {
    const harness = allowHarness();
    const badAmount = expectError(
      await api(harness, 'POST', '/v1/intents', {
        idempotencyKey: 'ik-bad-amount-1',
        body: { amount: { currency: 'usd', minorUnits: '100' } },
      }),
    );
    expect(badAmount.status).toBe(400);
    expect(badAmount.body.error.category).toBe('VALIDATION');
    const floatAmount = expectError(
      await api(harness, 'POST', '/v1/intents', {
        idempotencyKey: 'ik-bad-amount-2',
        body: { amount: { currency: 'USD', minorUnits: '1.5' } },
      }),
    );
    expect(floatAmount.status).toBe(400);
  });
});

describe('createApiHandler (http.ts) — POST /v1/approvals', () => {
  it('creates an approval request for an explicit scope and exposes the record', async () => {
    const harness = allowHarness();
    const success = expectSuccess(
      await api(harness, 'POST', '/v1/approvals', {
        idempotencyKey: 'ik-approval-create-1',
        body: {
          principal: 'user:owner',
          scope: {
            actions: ['payments.intent.create'],
            resources: [{ type: 'intent' }],
            maxAmount: { currency: 'USD', minorUnits: '500000' },
          },
          channel: 'SMS',
          ttlMs: 600_000,
        },
      }),
    );
    expect(success.status).toBe(202);
    const data = success.envelope.data as { approvalRequest: { requestHash: string; channel: string } };
    expect(data.approvalRequest.channel).toBe('SMS');
    const meta = success.envelope.meta as { evidenceRef?: string };
    expect(meta.evidenceRef).toMatch(/^approval:/);
    const record = expectSuccess(
      await api(harness, 'GET', `/v1/approvals/${data.approvalRequest.requestHash}`),
    );
    expect((record.envelope.data as { approval: { status: string } }).approval.status).toBe('PENDING');
  });

  it('GET /v1/approvals/:id answers unknown hashes with NOT_FOUND', async () => {
    const harness = allowHarness();
    const error = expectError(await api(harness, 'GET', '/v1/approvals/hash_none'));
    expect(error.status).toBe(404);
  });
});

describe('createApiHandler (http.ts) — GET /v1/capabilities', () => {
  it('returns capability stubs with two-axis availability (UNKNOWN effective when source is unknown, INV-X01)', async () => {
    const harness = allowHarness();
    const success = expectSuccess(await api(harness, 'GET', '/v1/capabilities'));
    const data = success.envelope.data as {
      capabilities: {
        capabilityId: string;
        state: string;
        source: string;
        effectiveAvailability: string;
      }[];
    };
    expect(data.capabilities.length).toBeGreaterThanOrEqual(3);
    const unknown = data.capabilities.find((c) => c.source === 'UNKNOWN');
    expect(unknown).toBeDefined();
    expect(unknown?.effectiveAvailability).toBe('UNKNOWN');
    for (const stub of data.capabilities) {
      if (stub.source === 'REACHABLE') {
        expect(stub.effectiveAvailability).toBe(stub.state);
      }
    }
  });
});

describe('createApiHandler (http.ts) — UNKNOWN outcome mapping (INV-X01)', () => {
  it('EXTERNAL_AMBIGUITY maps to 409 + X-PaySwap-Outcome: unknown + reconciliationRef — never a generic 500', async () => {
    const harness = allowHarness();
    const error = expectError(
      await api(harness, 'POST', '/simulations/external-ambiguity', { idempotencyKey: 'ik-unknown-1' }),
    );
    expect(error.status).toBe(409);
    expect(error.status).not.toBe(500);
    expect(error.body.error.category).toBe('EXTERNAL_AMBIGUITY');
    expect(error.headers?.[OUTCOME_HEADER]).toBe('unknown');
    expect(typeof error.body.error.reconciliationRef).toBe('string');
  });

  it('an ambiguous outcome is authoritative for its idempotency key: retries replay the SAME ambiguous result (INV-X02: no blind retry)', async () => {
    const harness = allowHarness();
    const first = expectError(
      await api(harness, 'POST', '/simulations/external-ambiguity', { idempotencyKey: 'ik-unknown-replay' }),
    );
    const second = expectError(
      await api(harness, 'POST', '/simulations/external-ambiguity', { idempotencyKey: 'ik-unknown-replay' }),
    );
    expect(second.status).toBe(409);
    expect(second.headers?.[OUTCOME_HEADER]).toBe('unknown');
    expect(second.body.error.reconciliationRef).toBe(first.body.error.reconciliationRef);
    expect(second.body.error.message).toBe(first.body.error.message);
  });
});

describe('createApiHandler (http.ts) — routing and envelope validation', () => {
  it('unknown routes answer NOT_FOUND', async () => {
    const harness = allowHarness();
    const error = expectError(await api(harness, 'GET', '/v1/nonsense'));
    expect(error.status).toBe(404);
    expect(error.body.error.code).toBe('route.not_found');
  });

  it('rejects unsupported API versions (explicit external versioning)', async () => {
    const harness = allowHarness();
    const error = expectError(await api(harness, 'GET', '/v1/health', { apiVersion: '2020-01-01' }));
    expect(error.status).toBe(400);
    expect(error.body.error.category).toBe('VALIDATION');
  });

  it('rejections still use the response envelope shape (schemaVersion + requestId)', async () => {
    const harness = allowHarness();
    const error = expectError(await harness.handler(authedRequest('POST', '/v1/intents')));
    expect(error.body.meta.schemaVersion).toBeTypeOf('string');
    expect(error.body.meta.requestId).toBeTypeOf('string');
  });
});

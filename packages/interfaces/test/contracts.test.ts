import { describe, expect, it } from 'vitest';

import { canonicalJson } from '../src/canonical-json.js';
import {
  ERROR_CATEGORIES,
  EXTERNAL_AMBIGUITY_HTTP_STATUS,
  IDEMPOTENCY_KEY_HEADER,
  MUTATING_HTTP_METHODS,
  isMutatingHttpMethod,
  mapErrorCategoryToHttpStatus,
  outcomeMarkerForErrorCategory,
  validateRequestEnvelope,
} from '../src/http.js';
import type { RequestEnvelope } from '../src/http.js';
import {
  TERMINAL_STATES,
  UI_STATES,
  isTerminalState,
  mapTerminalStateToUi,
} from '../src/protocol-state.js';
import {
  EXECUTION_MODES,
  isExecutionMode,
  isExternalFundsPositionObservation,
  isConnectedCapabilityInstance,
  validateConnectorExecutionRequest,
} from '../src/psp-connector.js';
import type { ConnectedCapabilityInstance, ProviderCatalogueEntry } from '../src/psp-connector.js';
import { computeRequestHash } from '../src/approval.js';
import { validateCommandExecution } from '../src/runtime-adapter.js';
import type { CommandExecution } from '../src/runtime-adapter.js';
import { DEFAULT_REPLAY_WINDOW_SECONDS, signWebhookEvent, verifyWebhookEvent } from '../src/webhooks.js';
import type { WebhookEventEnvelope } from '../src/webhooks.js';
import { CURRENT_API_VERSION } from '../src/version.js';

// ---------------------------------------------------------------------------
// protocol-state
// ---------------------------------------------------------------------------

describe('protocol-state (§22 terminal states, INV-X01)', () => {
  it('exposes the nine §22 terminal states', () => {
    expect(TERMINAL_STATES).toHaveLength(9);
    expect([...TERMINAL_STATES]).toEqual([
      'FULFILLED',
      'WAITING',
      'USER_ACTION_REQUIRED',
      'NO_VIABLE_ROUTE',
      'COMPLIANCE_BLOCKED',
      'EXPIRED',
      'CANCELLED',
      'FAILED',
      'UNKNOWN',
    ]);
  });

  it('maps every terminal state exhaustively into a canonical UI state', () => {
    expect(UI_STATES).toHaveLength(8);
    for (const state of TERMINAL_STATES) {
      const ui = mapTerminalStateToUi(state);
      expect((UI_STATES as readonly string[]).includes(ui)).toBe(true);
    }
  });

  it('INV-X01: UNKNOWN maps to reconciling and never failed', () => {
    expect(mapTerminalStateToUi('UNKNOWN')).toBe('reconciling');
    expect(mapTerminalStateToUi('UNKNOWN')).not.toBe('failed');
  });

  it('USER_ACTION_REQUIRED maps to the explicit action-required state', () => {
    expect(mapTerminalStateToUi('USER_ACTION_REQUIRED')).toBe('action-required');
  });

  it('WAITING (external settlement pending) maps to reconciling', () => {
    expect(mapTerminalStateToUi('WAITING')).toBe('reconciling');
  });

  it('isTerminalState narrows unknown values', () => {
    expect(isTerminalState('FULFILLED')).toBe(true);
    expect(isTerminalState('PENDING')).toBe(false);
    expect(isTerminalState(42)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// http
// ---------------------------------------------------------------------------

describe('http contract (REST boundary)', () => {
  it('maps every error category deterministically to a status', () => {
    expect(ERROR_CATEGORIES).toHaveLength(8);
    for (const category of ERROR_CATEGORIES) {
      const status = mapErrorCategoryToHttpStatus(category);
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
      expect(mapErrorCategoryToHttpStatus(category)).toBe(status);
    }
  });

  it('maps categories to their documented statuses', () => {
    expect(mapErrorCategoryToHttpStatus('VALIDATION')).toBe(400);
    expect(mapErrorCategoryToHttpStatus('NOT_FOUND')).toBe(404);
    expect(mapErrorCategoryToHttpStatus('AUTHORIZATION')).toBe(403);
    expect(mapErrorCategoryToHttpStatus('POLICY')).toBe(422);
    expect(mapErrorCategoryToHttpStatus('CONFLICT')).toBe(409);
    expect(mapErrorCategoryToHttpStatus('RATE_LIMITED')).toBe(429);
    expect(mapErrorCategoryToHttpStatus('INTERNAL')).toBe(500);
  });

  it('EXTERNAL_AMBIGUITY is 409 with the outcome marker, never a generic 500', () => {
    expect(mapErrorCategoryToHttpStatus('EXTERNAL_AMBIGUITY')).toBe(EXTERNAL_AMBIGUITY_HTTP_STATUS);
    expect(EXTERNAL_AMBIGUITY_HTTP_STATUS).toBe(409);
    expect(mapErrorCategoryToHttpStatus('EXTERNAL_AMBIGUITY')).not.toBe(500);
    expect(outcomeMarkerForErrorCategory('EXTERNAL_AMBIGUITY')).toBe('unknown');
    expect(outcomeMarkerForErrorCategory('VALIDATION')).toBeUndefined();
  });

  it('flags every mutating method', () => {
    expect(MUTATING_HTTP_METHODS).toEqual(['POST', 'PUT', 'PATCH', 'DELETE']);
    for (const method of MUTATING_HTTP_METHODS) {
      expect(isMutatingHttpMethod(method)).toBe(true);
    }
    expect(isMutatingHttpMethod('GET')).toBe(false);
  });

  function baseRequest(overrides: Partial<RequestEnvelope<unknown>>): RequestEnvelope<unknown> {
    return { method: 'GET', path: '/payments', auth: { principal: 'user_1', scheme: 'SESSION' }, apiVersion: CURRENT_API_VERSION, ...overrides };
  }

  it('INV-F05: mutations without an idempotency key are contract violations', () => {
    for (const method of MUTATING_HTTP_METHODS) {
      const validation = validateRequestEnvelope(baseRequest({ method }));
      expect(validation.ok).toBe(false);
      if (!validation.ok) {
        expect(validation.violations.some((violation) => violation.includes('idempotencyKey'))).toBe(true);
      }
    }
  });

  it('accepts mutations carrying an idempotency key', () => {
    const validation = validateRequestEnvelope(baseRequest({ method: 'POST', idempotencyKey: 'ik_1' }));
    expect(validation.ok).toBe(true);
  });

  it('accepts GET without an idempotency key', () => {
    const validation = validateRequestEnvelope(baseRequest({ method: 'GET' }));
    expect(validation.ok).toBe(true);
  });

  it('requires an authenticated principal', () => {
    const validation = validateRequestEnvelope(baseRequest({ auth: { principal: '', scheme: 'SESSION' } }));
    expect(validation.ok).toBe(false);
  });

  it('requires an explicit, supported API version (explicit external versioning)', () => {
    const missing = validateRequestEnvelope(baseRequest({ apiVersion: '' }));
    expect(missing.ok).toBe(false);
    const unsupported = validateRequestEnvelope(baseRequest({ apiVersion: '2000-01-01' }));
    expect(unsupported.ok).toBe(false);
    if (!unsupported.ok) {
      expect(unsupported.violations.some((violation) => violation.includes('api.version_unsupported'))).toBe(true);
    }
    const supported = validateRequestEnvelope(baseRequest({ apiVersion: CURRENT_API_VERSION }));
    expect(supported.ok).toBe(true);
    expect(IDEMPOTENCY_KEY_HEADER).toBe('Idempotency-Key');
  });
});

// ---------------------------------------------------------------------------
// canonical JSON
// ---------------------------------------------------------------------------

describe('canonical JSON', () => {
  it('is independent of key insertion order', () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  it('sorts keys recursively and preserves array order', () => {
    expect(canonicalJson({ z: { y: 1, x: 2 }, a: [3, 1, 2] })).toBe('{"a":[3,1,2],"z":{"x":2,"y":1}}');
  });

  it('drops undefined-valued keys', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('rejects non-finite numbers', () => {
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// webhooks
// ---------------------------------------------------------------------------

describe('webhook signatures', () => {
  const SIGNING_TIME = 1_767_052_800;
  const secret = 'whsec_unit';
  const envelope: WebhookEventEnvelope<{ readonly amount: string }> = {
    id: 'evt_unit_1',
    type: 'payment.outcome_observed',
    occurredAt: '2026-09-30T00:00:00Z',
    schemaVersion: '2026-09-30',
    data: { amount: '1500' },
  };

  it('round-trips a valid signature', () => {
    const headers = signWebhookEvent(envelope, secret, SIGNING_TIME);
    expect(headers.signature.startsWith('v1=')).toBe(true);
    expect(verifyWebhookEvent(envelope, secret, headers, { nowSeconds: SIGNING_TIME })).toEqual({ valid: true });
  });

  it('rejects a tampered payload', () => {
    const headers = signWebhookEvent(envelope, secret, SIGNING_TIME);
    const tampered = { ...envelope, data: { amount: '1' } };
    expect(verifyWebhookEvent(tampered, secret, headers, { nowSeconds: SIGNING_TIME })).toEqual({
      valid: false,
      reason: 'SIGNATURE_MISMATCH',
    });
  });

  it('verifies semantically identical envelopes regardless of key order (canonicalization)', () => {
    const headers = signWebhookEvent(envelope, secret, SIGNING_TIME);
    const reordered: WebhookEventEnvelope<{ readonly amount: string }> = {
      data: { amount: '1500' },
      schemaVersion: '2026-09-30',
      occurredAt: '2026-09-30T00:00:00Z',
      type: 'payment.outcome_observed',
      id: 'evt_unit_1',
    };
    expect(verifyWebhookEvent(reordered, secret, headers, { nowSeconds: SIGNING_TIME })).toEqual({ valid: true });
  });

  it('rejects expired timestamps outside the replay window', () => {
    const headers = signWebhookEvent(envelope, secret, SIGNING_TIME);
    const stale = verifyWebhookEvent(envelope, secret, headers, {
      nowSeconds: SIGNING_TIME + DEFAULT_REPLAY_WINDOW_SECONDS + 1,
    });
    expect(stale).toEqual({ valid: false, reason: 'TIMESTAMP_OUTSIDE_REPLAY_WINDOW' });
  });

  it('rejects a wrong secret', () => {
    const headers = signWebhookEvent(envelope, secret, SIGNING_TIME);
    expect(verifyWebhookEvent(envelope, 'whsec_other', headers, { nowSeconds: SIGNING_TIME })).toEqual({
      valid: false,
      reason: 'SIGNATURE_MISMATCH',
    });
  });

  it('rejects a malformed timestamp', () => {
    const headers = signWebhookEvent(envelope, secret, SIGNING_TIME);
    expect(verifyWebhookEvent(envelope, secret, { ...headers, timestamp: 'not-a-number' }, { nowSeconds: SIGNING_TIME })).toEqual({
      valid: false,
      reason: 'MALFORMED_TIMESTAMP',
    });
  });
});

// ---------------------------------------------------------------------------
// approval
// ---------------------------------------------------------------------------

describe('approval request hashing', () => {
  it('is deterministic and key-order independent', () => {
    const payload = { command: { commandType: 'payments.execute', commandId: 'cmd_1' }, amount: '1500' };
    const reordered = { amount: '1500', command: { commandId: 'cmd_1', commandType: 'payments.execute' } };
    expect(computeRequestHash(payload)).toBe(computeRequestHash(reordered));
    expect(computeRequestHash(payload)).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// runtime adapter
// ---------------------------------------------------------------------------

describe('runtime adapter contract', () => {
  const validExecution: CommandExecution = {
    command: { commandType: 'payments.execute', commandId: 'cmd_unit_1' },
    authorizationDecisionRef: {
      decisionId: 'dec_1',
      approvalArtifactRef: 'artifact_ref_1',
      scope: { domain: 'payments', actions: ['execute'] },
      decidedAt: '2026-09-30T00:00:00Z',
    },
    idempotencyKey: 'ik_runtime_1',
  };

  it('accepts a fully authorized execution', () => {
    expect(validateCommandExecution(validExecution).ok).toBe(true);
  });

  it('execution without an authorization-decision reference is a contract violation', () => {
    const unauthorized = {
      command: validExecution.command,
      idempotencyKey: 'ik_runtime_2',
    } as unknown as CommandExecution;
    const validation = validateCommandExecution(unauthorized);
    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(validation.violations.some((violation) => violation.includes('authorizationDecisionRef'))).toBe(true);
    }
  });

  it('rejects executions without a command or idempotency key', () => {
    const noCommand = { ...validExecution, command: undefined } as unknown as CommandExecution;
    expect(validateCommandExecution(noCommand).ok).toBe(false);
    const noKey = { ...validExecution, idempotencyKey: '' };
    expect(validateCommandExecution(noKey).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// psp connector
// ---------------------------------------------------------------------------

describe('psp connector contract', () => {
  const catalogueEntry: ProviderCatalogueEntry = {
    catalogueEntryId: 'cat_unit_1',
    providerName: 'example-psp',
    providerVersion: '2026-09',
    capabilityId: 'payments.execute',
    summary: 'advertised platform-wide capability',
    advertisedScope: {
      platformWide: true,
      advertisedGeographies: ['US'],
      advertisedCurrencies: ['USD'],
    },
  };

  const connectedInstance: ConnectedCapabilityInstance = {
    instanceId: 'cci_unit_1',
    capabilityId: 'payments.execute',
    providerName: 'example-psp',
    providerVersion: '2026-09',
    accountRef: 'acct_1',
    tenantRef: 'tenant_1',
    authorization: { status: 'ACTIVE' },
    geography: { countries: ['US'] },
    currencies: ['USD'],
    permissionState: { granted: ['charges:read', 'charges:write'], requested: [], missing: [] },
  };

  it('INV-C05: catalogue entries fail the connected-instance guard and vice versa', () => {
    expect(isConnectedCapabilityInstance(catalogueEntry)).toBe(false);
    expect(isConnectedCapabilityInstance(connectedInstance)).toBe(true);
  });

  it('INV-C07: exposes exactly the three execution modes', () => {
    expect([...EXECUTION_MODES]).toEqual(['PASS_THROUGH_NATIVE', 'COMPOSED_PAYSWAP', 'OPTIMIZED_MULTI_PROVIDER']);
    expect(isExecutionMode('PASS_THROUGH_NATIVE')).toBe(true);
    expect(isExecutionMode('SUPER_MODE')).toBe(false);
  });

  it('INV-C07: execution requests require an explicit mode', () => {
    const valid = validateConnectorExecutionRequest({
      executionMode: 'PASS_THROUGH_NATIVE',
      capabilityInstanceId: 'cci_unit_1',
      providerRequest: {},
      idempotencyKey: 'ik_connector_1',
    });
    expect(valid.ok).toBe(true);
    const invalid = validateConnectorExecutionRequest({
      capabilityInstanceId: 'cci_unit_1',
      providerRequest: {},
      idempotencyKey: 'ik_connector_2',
    } as unknown as Parameters<typeof validateConnectorExecutionRequest>[0]);
    expect(invalid.ok).toBe(false);
  });

  it('INV-C09: balance-shaped objects are not funds position observations', () => {
    expect(isExternalFundsPositionObservation({ available: '1000', pending: '50' })).toBe(false);
    expect(
      isExternalFundsPositionObservation({
        observationId: 'obs_1',
        observedAt: '2026-09-30T00:00:00Z',
        freshness: { asOf: '2026-09-30T00:00:00Z', maxAgeSeconds: 300 },
        location: { providerName: 'example-psp', accountRef: 'acct_1' },
        observedAmount: { currency: 'USD', minorUnits: '1000' },
        provenance: { providerName: 'example-psp', source: 'PROVIDER_API', capturedAt: '2026-09-30T00:00:00Z' },
      }),
    ).toBe(true);
  });
});

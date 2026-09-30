/**
 * REST boundary conformance harness (W3-001).
 *
 * Runs the contract test suite against any HttpContractSubject (an
 * implementation of the REST boundary contract). The reference fixture in
 * reference-fixtures.ts demonstrates a passing implementation.
 *
 * Covered contract rules:
 * - INV-F05: mutations without an idempotency key are rejected;
 * - response envelope shape (data + meta.schemaVersion + meta.requestId);
 * - idempotent replay marks meta.idempotentReplay;
 * - EXTERNAL_AMBIGUITY → 409 with X-PaySwap-Outcome: unknown, never 500.
 */

import type { ContractTestFn } from './contract-test.js';
import {
  EXTERNAL_AMBIGUITY_HTTP_STATUS,
  EXTERNAL_AMBIGUITY_OUTCOME_MARKER,
  MUTATING_HTTP_METHODS,
  OUTCOME_HEADER,
} from '../http.js';
import type { ErrorResponse, RequestAuth, RequestEnvelope, ResponseEnvelope } from '../http.js';
import { ok } from './assertions.js';
import { CURRENT_API_VERSION } from '../version.js';

export type HttpTransportResult =
  | {
      readonly kind: 'success';
      readonly status: number;
      readonly envelope: ResponseEnvelope<unknown>;
      readonly headers?: Readonly<Record<string, string>>;
    }
  | {
      readonly kind: 'error';
      readonly status: number;
      readonly body: ErrorResponse;
      readonly headers?: Readonly<Record<string, string>>;
    };

/** The subject under conformance test: one REST boundary implementation. */
export interface HttpContractSubject {
  handle(request: RequestEnvelope<unknown>): Promise<HttpTransportResult>;
}

const AUTH: RequestAuth = { principal: 'user_conformance', scheme: 'SESSION' };

function request(partial: {
  method: RequestEnvelope<unknown>['method'];
  path: string;
  idempotencyKey?: string;
}): RequestEnvelope<unknown> {
  return {
    method: partial.method,
    path: partial.path,
    auth: AUTH,
    apiVersion: CURRENT_API_VERSION,
    ...(partial.idempotencyKey !== undefined ? { idempotencyKey: partial.idempotencyKey } : {}),
  };
}

function expectError(result: HttpTransportResult, context: string): Extract<HttpTransportResult, { kind: 'error' }> {
  if (result.kind !== 'error') {
    throw new Error(`assertion failed: expected an error response (${context}), got kind=${result.kind}`);
  }
  return result;
}

function expectSuccess(result: HttpTransportResult, context: string): Extract<HttpTransportResult, { kind: 'success' }> {
  if (result.kind !== 'success') {
    throw new Error(`assertion failed: expected a success response (${context}), got kind=${result.kind}`);
  }
  return result;
}

export function runHttpContractTests(subject: HttpContractSubject, test: ContractTestFn): void {
  test('INV-F05: every mutation without an idempotency key is rejected', async () => {
    for (const method of MUTATING_HTTP_METHODS) {
      const error = expectError(
        await subject.handle(request({ method, path: '/payments' })),
        `${method} without idempotency key`,
      );
      ok(error.status === 400, `${method} without idempotency key must be 400, got ${error.status}`);
      ok(error.body.error.category === 'VALIDATION', `${method} rejection must be VALIDATION`);
      ok(
        typeof error.body.error.message === 'string' && error.body.error.message.length > 0,
        'error message must be present',
      );
    }
  });

  test('GET requests do not require an idempotency key', async () => {
    const result = await subject.handle(request({ method: 'GET', path: '/payments' }));
    ok(result.kind === 'success', 'GET without idempotency key must succeed');
  });

  test('successful responses use the envelope with schemaVersion and requestId', async () => {
    const success = expectSuccess(
      await subject.handle(request({ method: 'POST', path: '/payments', idempotencyKey: 'ik-envelope-1' })),
      'mutation with idempotency key',
    );
    ok(typeof success.envelope.meta.schemaVersion === 'string' && success.envelope.meta.schemaVersion !== '', 'meta.schemaVersion required');
    ok(typeof success.envelope.meta.requestId === 'string' && success.envelope.meta.requestId !== '', 'meta.requestId required');
    ok(success.envelope.data !== undefined, 'envelope.data required');
  });

  test('INV-F05: replaying the same mutation returns idempotentReplay: true', async () => {
    const first = expectSuccess(
      await subject.handle(request({ method: 'POST', path: '/payments', idempotencyKey: 'ik-replay-1' })),
      'first mutation',
    );
    const second = expectSuccess(
      await subject.handle(request({ method: 'POST', path: '/payments', idempotencyKey: 'ik-replay-1' })),
      'replayed mutation',
    );
    ok(second.envelope.meta.idempotentReplay === true, 'meta.idempotentReplay must be true on replay');
    ok(first.envelope.meta.requestId !== second.envelope.meta.requestId, 'replays still get their own requestId');
  });

  test('EXTERNAL_AMBIGUITY is 409 with X-PaySwap-Outcome: unknown, never a generic 500', async () => {
    const error = expectError(
      await subject.handle(
        request({ method: 'POST', path: '/simulations/external-ambiguity', idempotencyKey: 'ik-ambiguity-1' }),
      ),
      'externally ambiguous outcome',
    );
    ok(error.status === EXTERNAL_AMBIGUITY_HTTP_STATUS, `status must be ${EXTERNAL_AMBIGUITY_HTTP_STATUS}, got ${error.status}`);
    ok(error.status !== 500, 'never a generic 500');
    ok(error.body.error.category === 'EXTERNAL_AMBIGUITY', 'category must be EXTERNAL_AMBIGUITY');
    ok(
      error.headers !== undefined && error.headers[OUTCOME_HEADER] === EXTERNAL_AMBIGUITY_OUTCOME_MARKER,
      `response must carry ${OUTCOME_HEADER}: ${EXTERNAL_AMBIGUITY_OUTCOME_MARKER}`,
    );
    ok(
      typeof error.body.error.reconciliationRef === 'string' && error.body.error.reconciliationRef !== '',
      'EXTERNAL_AMBIGUITY errors must carry a reconciliationRef',
    );
  });

  test('unknown resources produce NOT_FOUND errors, not success', async () => {
    const error = expectError(
      await subject.handle(request({ method: 'GET', path: '/payments/pm_does_not_exist' })),
      'unknown resource',
    );
    ok(error.body.error.category === 'NOT_FOUND', 'category must be NOT_FOUND');
  });
}

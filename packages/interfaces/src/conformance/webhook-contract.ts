/**
 * Webhook boundary conformance harness (W3-001).
 *
 * Covered contract rules:
 * - a correctly signed envelope verifies;
 * - a tampered payload fails signature verification;
 * - canonical JSON makes verification independent of key order;
 * - timestamps outside the replay window are rejected;
 * - a wrong secret fails verification;
 * - malformed signatures are rejected.
 */

import type { ContractTestFn } from './contract-test.js';
import { DEFAULT_REPLAY_WINDOW_SECONDS } from '../webhooks.js';
import type {
  WebhookEventEnvelope,
  WebhookSignatureHeaders,
  WebhookVerification,
  WebhookVerificationOptions,
} from '../webhooks.js';
import { ok } from './assertions.js';
import { CONTRACT_SCHEMA_VERSION } from '../version.js';

export interface WebhookContractSubject {
  sign(
    envelope: WebhookEventEnvelope,
    secret: string,
    timestampSeconds: number,
  ): WebhookSignatureHeaders;
  verify(
    envelope: WebhookEventEnvelope,
    secret: string,
    headers: WebhookSignatureHeaders,
    options?: WebhookVerificationOptions,
  ): WebhookVerification;
}

interface PaymentEventData {
  readonly amountMinorUnits: string;
  readonly currency: string;
}

const SIGNING_TIME = 1_767_052_800; // 2026-09-30T00:00:00Z

function sampleEnvelope(): WebhookEventEnvelope<PaymentEventData> {
  return {
    id: 'evt_conformance_1',
    type: 'payment.outcome_observed',
    occurredAt: '2026-09-30T00:00:00Z',
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    data: { amountMinorUnits: '1500', currency: 'USD' },
  };
}

export function runWebhookContractTests(subject: WebhookContractSubject, test: ContractTestFn): void {
  const secret = 'whsec_conformance';

  test('a correctly signed event verifies', () => {
    const envelope = sampleEnvelope();
    const headers = subject.sign(envelope, secret, SIGNING_TIME);
    const verification = subject.verify(envelope, secret, headers, { nowSeconds: SIGNING_TIME });
    ok(verification.valid, 'valid signature must verify');
  });

  test('a tampered payload fails verification', () => {
    const envelope = sampleEnvelope();
    const headers = subject.sign(envelope, secret, SIGNING_TIME);
    const tampered: WebhookEventEnvelope<PaymentEventData> = {
      ...envelope,
      data: { ...envelope.data, amountMinorUnits: '1' },
    };
    const verification = subject.verify(tampered, secret, headers, { nowSeconds: SIGNING_TIME });
    ok(!verification.valid, 'tampered payload must not verify');
    ok(verification.valid === false && verification.reason === 'SIGNATURE_MISMATCH', 'reason must be SIGNATURE_MISMATCH');
  });

  test('canonical JSON: key order does not affect verification', () => {
    const envelope = sampleEnvelope();
    const headers = subject.sign(envelope, secret, SIGNING_TIME);
    // Same semantic object, different insertion order of keys.
    const reordered: WebhookEventEnvelope<PaymentEventData> = {
      data: { currency: 'USD', amountMinorUnits: '1500' },
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      occurredAt: '2026-09-30T00:00:00Z',
      type: 'payment.outcome_observed',
      id: 'evt_conformance_1',
    };
    const verification = subject.verify(reordered, secret, headers, { nowSeconds: SIGNING_TIME });
    ok(verification.valid, 'semantically identical envelope with reordered keys must verify');
  });

  test('an expired timestamp is rejected outside the replay window', () => {
    const envelope = sampleEnvelope();
    const staleTime = SIGNING_TIME - DEFAULT_REPLAY_WINDOW_SECONDS - 1;
    const headers = subject.sign(envelope, secret, staleTime);
    const verification = subject.verify(envelope, secret, headers, { nowSeconds: SIGNING_TIME });
    ok(!verification.valid, 'stale timestamp must not verify');
    ok(
      verification.valid === false && verification.reason === 'TIMESTAMP_OUTSIDE_REPLAY_WINDOW',
      'reason must be TIMESTAMP_OUTSIDE_REPLAY_WINDOW',
    );
  });

  test('a future timestamp beyond the replay window is rejected', () => {
    const envelope = sampleEnvelope();
    const futureTime = SIGNING_TIME + DEFAULT_REPLAY_WINDOW_SECONDS + 1;
    const headers = subject.sign(envelope, secret, futureTime);
    const verification = subject.verify(envelope, secret, headers, { nowSeconds: SIGNING_TIME });
    ok(!verification.valid, 'far-future timestamp must not verify');
  });

  test('a wrong secret fails verification', () => {
    const envelope = sampleEnvelope();
    const headers = subject.sign(envelope, secret, SIGNING_TIME);
    const verification = subject.verify(envelope, 'whsec_wrong_secret', headers, { nowSeconds: SIGNING_TIME });
    ok(!verification.valid, 'wrong secret must not verify');
    ok(verification.valid === false && verification.reason === 'SIGNATURE_MISMATCH', 'reason must be SIGNATURE_MISMATCH');
  });

  test('a malformed signature is rejected', () => {
    const envelope = sampleEnvelope();
    const verification = subject.verify(envelope, secret, { signature: 'garbage', timestamp: String(SIGNING_TIME) }, { nowSeconds: SIGNING_TIME });
    ok(!verification.valid, 'malformed signature must not verify');
    ok(verification.valid === false && verification.reason === 'MALFORMED_SIGNATURE', 'reason must be MALFORMED_SIGNATURE');
  });
}

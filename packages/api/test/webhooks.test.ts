import { describe, expect, it } from 'vitest';

import type { WebhookEventEnvelope, WebhookSignatureHeaders } from '@payswap/interfaces';
import { runWebhookContractTests } from '@payswap/interfaces';
import { DeterministicClock, createIdFactory } from '@payswap/protocol';

import type { WebhookTransportOutcome } from '../src/webhooks.js';
import { WebhookDispatcher } from '../src/webhooks.js';

import { CLOCK_SEED_MS } from './fixtures.js';

const SECRET = 'whsec_test_endpoint';
const URL = 'https://example.test/webhooks/payswap';

interface RecordedDelivery {
  readonly url: string;
  readonly envelope: WebhookEventEnvelope;
  readonly headers: WebhookSignatureHeaders;
}

/** Deterministic recording transport with a script of outcomes. */
class ScriptedTransport {
  readonly delivered: RecordedDelivery[] = [];
  readonly #outcomes: WebhookTransportOutcome[];

  constructor(outcomes: readonly WebhookTransportOutcome[]) {
    this.#outcomes = [...outcomes];
  }

  readonly deliver = (input: {
    readonly url: string;
    readonly envelope: WebhookEventEnvelope;
    readonly headers: WebhookSignatureHeaders;
  }): Promise<WebhookTransportOutcome> => {
    this.delivered.push({ url: input.url, envelope: input.envelope, headers: input.headers });
    const outcome = this.#outcomes.shift();
    return Promise.resolve(outcome ?? { ok: true, responseStatus: 200 });
  };
}

function buildDispatcher(
  outcomes: readonly WebhookTransportOutcome[],
  options?: { readonly maxAttempts?: number; readonly backoffBaseMs?: number },
): { readonly dispatcher: WebhookDispatcher; readonly transport: ScriptedTransport; readonly clock: DeterministicClock } {
  const clock = new DeterministicClock(CLOCK_SEED_MS);
  const transport = new ScriptedTransport(outcomes);
  const dispatcher = new WebhookDispatcher(
    { clock, transport, ids: createIdFactory(clock) },
    options,
  );
  dispatcher.registerEndpoint({ endpointId: 'endpoint_primary', url: URL, secret: SECRET });
  return { dispatcher, transport, clock };
}

interface PaymentEventData {
  readonly amountMinorUnits: string;
  readonly currency: string;
}

function sampleEnvelope(id: string): WebhookEventEnvelope<PaymentEventData> {
  return {
    id,
    type: 'payment.outcome_observed',
    occurredAt: '2026-09-30T00:00:00Z',
    schemaVersion: '2026-09-30',
    data: { amountMinorUnits: '1500', currency: 'USD' },
  };
}

describe('WebhookDispatcher (webhooks.ts)', () => {
  it('delivers signed events and the signature verifies against the contract (round trip)', async () => {
    const { dispatcher, transport } = buildDispatcher([{ ok: true, responseStatus: 200 }]);
    const envelope = sampleEnvelope('evt_wh_1');
    const attempt = await dispatcher.dispatch(envelope, 'endpoint_primary');
    expect(attempt.outcome).toBe('SUCCEEDED');
    expect(attempt.attemptNumber).toBe(1);
    expect(attempt.responseStatus).toBe(200);
    expect(attempt.envelopeId).toBe('evt_wh_1');
    expect(attempt.attemptedAt).toBe(new Date(Number(CLOCK_SEED_MS)).toISOString());

    expect(transport.delivered.length).toBe(1);
    const delivery = transport.delivered[0];
    if (delivery === undefined) {
      throw new Error('delivery not recorded');
    }
    expect(delivery.url).toBe(URL);
    expect(delivery.headers.signature).toMatch(/^v1=[0-9a-f]{64}$/);
    // The delivered signature verifies (receiver side, via the dispatcher):
    const verification = dispatcher.verifyDelivery(envelope, SECRET, delivery.headers);
    expect(verification).toEqual({ valid: true });
  });

  it('a wrong secret fails verification (SIGNATURE_MISMATCH)', async () => {
    const { dispatcher, transport } = buildDispatcher([{ ok: true, responseStatus: 200 }]);
    const envelope = sampleEnvelope('evt_wh_2');
    await dispatcher.dispatch(envelope, 'endpoint_primary');
    const delivery = transport.delivered[0];
    if (delivery === undefined) {
      throw new Error('delivery not recorded');
    }
    expect(dispatcher.verifyDelivery(envelope, 'whsec_wrong', delivery.headers)).toEqual({
      valid: false,
      reason: 'SIGNATURE_MISMATCH',
    });
  });

  it('a tampered payload fails verification (SIGNATURE_MISMATCH)', async () => {
    const { dispatcher, transport } = buildDispatcher([{ ok: true, responseStatus: 200 }]);
    const envelope = sampleEnvelope('evt_wh_3');
    await dispatcher.dispatch(envelope, 'endpoint_primary');
    const delivery = transport.delivered[0];
    if (delivery === undefined) {
      throw new Error('delivery not recorded');
    }
    const tampered = {
      ...envelope,
      data: { ...envelope.data, amountMinorUnits: '1' },
    } as WebhookEventEnvelope;
    expect(dispatcher.verifyDelivery(tampered, SECRET, delivery.headers)).toEqual({
      valid: false,
      reason: 'SIGNATURE_MISMATCH',
    });
  });

  it('timestamps outside the replay window are rejected (replay protection)', async () => {
    const { dispatcher, transport, clock } = buildDispatcher([{ ok: true, responseStatus: 200 }]);
    const envelope = sampleEnvelope('evt_wh_4');
    await dispatcher.dispatch(envelope, 'endpoint_primary');
    const delivery = transport.delivered[0];
    if (delivery === undefined) {
      throw new Error('delivery not recorded');
    }
    // Advance far beyond the 300-second replay window:
    clock.advanceMs(301_000);
    expect(dispatcher.verifyDelivery(envelope, SECRET, delivery.headers)).toEqual({
      valid: false,
      reason: 'TIMESTAMP_OUTSIDE_REPLAY_WINDOW',
    });
  });

  it('failed deliveries are marked RETRY_SCHEDULED with deterministic clock-based backoff', async () => {
    const { dispatcher, clock } = buildDispatcher([{ ok: false, responseStatus: 503 }], {
      backoffBaseMs: 1_000,
    });
    const envelope = sampleEnvelope('evt_wh_5');
    const attempt = await dispatcher.dispatch(envelope, 'endpoint_primary');
    expect(attempt.outcome).toBe('RETRY_SCHEDULED');
    expect(attempt.nextAttemptAt).toBe(new Date(Number(CLOCK_SEED_MS) + 1_000).toISOString());
    // Nothing due yet:
    expect((await dispatcher.runDueDeliveries()).length).toBe(0);
    // After the backoff window elapses, the retry runs:
    clock.advanceMs(1_000);
    const retries = await dispatcher.runDueDeliveries();
    expect(retries.length).toBe(1);
    const retry = retries[0];
    if (retry === undefined) {
      throw new Error('retry not run');
    }
    expect(retry.attemptNumber).toBe(2);
    expect(dispatcher.lastAttemptFor('evt_wh_5')?.attemptNumber).toBe(2);
  });

  it('succeeds on a retry after failures, recording every attempt', async () => {
    const { dispatcher, clock } = buildDispatcher(
      [{ ok: false, responseStatus: 500 }, { ok: false, responseStatus: 503 }, { ok: true, responseStatus: 200 }],
      { backoffBaseMs: 1_000 },
    );
    const envelope = sampleEnvelope('evt_wh_6');
    const first = await dispatcher.dispatch(envelope, 'endpoint_primary');
    expect(first.outcome).toBe('RETRY_SCHEDULED');
    clock.advanceMs(1_000); // backoff 1s after attempt 1
    await dispatcher.runDueDeliveries();
    clock.advanceMs(2_000); // backoff 2s after attempt 2
    const retries = await dispatcher.runDueDeliveries();
    expect(retries[0]?.outcome).toBe('SUCCEEDED');
    const log = dispatcher.attempts();
    expect(log.length).toBe(3);
    expect(log.map((attempt) => attempt.outcome)).toEqual(['RETRY_SCHEDULED', 'RETRY_SCHEDULED', 'SUCCEEDED']);
    expect(dispatcher.lastAttemptFor('evt_wh_6')?.outcome).toBe('SUCCEEDED');
  });

  it('marks a delivery FAILED after exhausting maxAttempts', async () => {
    const alwaysFail: WebhookTransportOutcome = { ok: false, responseStatus: 500 };
    const { dispatcher, clock } = buildDispatcher([alwaysFail, alwaysFail, alwaysFail], {
      maxAttempts: 3,
      backoffBaseMs: 1_000,
    });
    const envelope = sampleEnvelope('evt_wh_7');
    const first = await dispatcher.dispatch(envelope, 'endpoint_primary');
    expect(first.outcome).toBe('RETRY_SCHEDULED');
    clock.advanceMs(1_000);
    const second = (await dispatcher.runDueDeliveries())[0];
    expect(second?.outcome).toBe('RETRY_SCHEDULED');
    clock.advanceMs(2_000);
    const third = (await dispatcher.runDueDeliveries())[0];
    expect(third?.outcome).toBe('FAILED');
    // Terminal: nothing further is scheduled.
    expect((await dispatcher.runDueDeliveries()).length).toBe(0);
    expect(dispatcher.attempts().length).toBe(3);
  });

  it('rejects dispatch to unknown endpoints', async () => {
    const { dispatcher } = buildDispatcher([]);
    await expect(dispatcher.dispatch(sampleEnvelope('evt_wh_8'), 'endpoint_missing')).rejects.toThrow(
      /unknown webhook endpoint/,
    );
  });

  it('signs with the timestamp taken from the injected clock (deterministic)', async () => {
    const first = buildDispatcher([{ ok: true, responseStatus: 200 }]);
    const second = buildDispatcher([{ ok: true, responseStatus: 200 }]);
    const envelope = sampleEnvelope('evt_wh_determinism');
    await first.dispatcher.dispatch(envelope, 'endpoint_primary');
    await second.dispatcher.dispatch(envelope, 'endpoint_primary');
    const signatureA = first.transport.delivered[0]?.headers.signature;
    const signatureB = second.transport.delivered[0]?.headers.signature;
    expect(signatureA).toBe(signatureB);
    expect(signatureA).toBeDefined();
  });
});

describe('W3-001 webhook contract conformance (runWebhookContractTests against the dispatcher signing surface)', () => {
  const { dispatcher } = buildDispatcher([]);
  runWebhookContractTests(
    {
      sign: (envelope, secret, timestampSeconds) =>
        signViaDispatcherDelivery(envelope, secret, timestampSeconds),
      verify: (envelope, secret, headers, options) =>
        dispatcher.verifyDelivery(envelope, secret, headers, options),
    },
    (name, fn) => {
      it(name, fn);
    },
  );
});

/**
 * Conformance signing seam: signs by driving a REAL dispatcher delivery with
 * the clock pinned to the requested timestamp (the recording transport
 * captures the headers synchronously inside deliver(), before the awaited
 * promise resolves).
 */
function signViaDispatcherDelivery(
  envelope: WebhookEventEnvelope,
  secret: string,
  timestampSeconds: number,
): WebhookSignatureHeaders {
  const clock = new DeterministicClock(BigInt(timestampSeconds) * 1000n);
  const transport = new ScriptedTransport([{ ok: true, responseStatus: 200 }]);
  const dispatcher = new WebhookDispatcher({ clock, transport, ids: createIdFactory(clock) });
  dispatcher.registerEndpoint({ endpointId: 'endpoint_conformance', url: URL, secret });
  void dispatcher.dispatch(envelope, 'endpoint_conformance');
  const headers = transport.delivered[0]?.headers;
  if (headers === undefined) {
    throw new Error('conformance dispatch did not record headers');
  }
  return headers;
}

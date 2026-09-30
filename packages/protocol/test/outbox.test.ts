import { describe, expect, it } from 'vitest';
import {
  DeterministicClock,
  ExternalAmbiguityError,
  PROTOCOL_SCHEMA_VERSION,
  asAggregateId,
  asEventId,
  createEventEnvelope,
  createIdFactory,
  isFailureOutcome,
  type DomainEventEnvelope,
} from '../src/index.js';
import {
  DEFAULT_OUTBOX_BACKOFF_BASE_MS,
  InMemoryOutbox,
  OutboxEventConflictError,
  OutboxStateError,
  computeBackoffMs,
  drain,
  type DrainReport,
  type Outbox,
  type OutboxPublisher,
} from '../src/outbox.js';

const clock = new DeterministicClock(10_000n);
const ids = createIdFactory(clock);

function envelope(): DomainEventEnvelope<unknown> {
  return createEventEnvelope(
    {
      eventType: 'protocol.ledger.entry.posted',
      payload: { deterministic: true },
      aggregate: { id: asAggregateId('agg-ledger'), version: 1n },
      schemaVersion: PROTOCOL_SCHEMA_VERSION,
    },
    { ids, clock },
  );
}

interface ScriptedPublisher extends OutboxPublisher {
  readonly published: readonly DomainEventEnvelope<unknown>[];
}

/** Publisher whose per-call behavior is scripted by event id (deterministic). */
function scriptedPublisher(script: {
  readonly succeed: readonly string[];
  readonly fail: readonly string[];
  readonly ambiguous: readonly string[];
}): ScriptedPublisher {
  const published: DomainEventEnvelope<unknown>[] = [];
  return {
    published,
    async publish(event: DomainEventEnvelope<unknown>): Promise<void> {
      published.push(event);
      if (script.ambiguous.includes(event.id)) {
        throw new ExternalAmbiguityError('transport reported an unknown outcome', {
          eventId: event.id,
        });
      }
      if (script.fail.includes(event.id)) {
        throw new Error('simulated definitive transport failure');
      }
      if (script.succeed.includes(event.id)) {
        return;
      }
      throw new Error('unscripted event id');
    },
  };
}

const alwaysSucceed: OutboxPublisher = {
  publish: async () => undefined,
};

describe('outbox: enqueue semantics (INV-O02, INV-O01)', () => {
  it('enqueues events and records them PENDING with zero attempts', () => {
    const outbox = new InMemoryOutbox();
    const a = envelope();
    const b = envelope();
    outbox.enqueue([a, b]);
    expect(outbox.records).toHaveLength(2);
    expect(outbox.get(a.id)?.status).toBe('PENDING');
    expect(outbox.get(a.id)?.attempts).toBe(0);
    expect(outbox.get(a.id)?.event).toBe(a);
  });

  it('enqueue is ATOMIC: an invalid event in a batch inserts nothing (no partial commit)', () => {
    const outbox = new InMemoryOutbox();
    const good = envelope();
    const malformed = { eventType: 'x' } as unknown as DomainEventEnvelope<unknown>;
    expect(() => outbox.enqueue([good, malformed])).toThrow();
    expect(outbox.records).toHaveLength(0);
  });

  it('re-enqueue of the identical event is an idempotent no-op (retry-safe, INV-O01)', () => {
    const outbox = new InMemoryOutbox();
    const a = envelope();
    outbox.enqueue([a]);
    outbox.enqueue([a]);
    expect(outbox.records).toHaveLength(1);
  });

  it('re-enqueue of the same id with different content is a conflict', () => {
    const outbox = new InMemoryOutbox();
    const a = envelope();
    outbox.enqueue([a]);
    const forged: DomainEventEnvelope<unknown> = {
      ...a,
      payload: { deterministic: false },
    };
    expect(() => outbox.enqueue([forged])).toThrow(OutboxEventConflictError);
    expect(outbox.records).toHaveLength(1);
  });
});

describe('outbox: drain — published only after success (INV-O01)', () => {
  it('marks PUBLISHED with attempts counted only after the publisher resolves', async () => {
    const outbox = new InMemoryOutbox();
    const a = envelope();
    outbox.enqueue([a]);
    const publisher = scriptedPublisher({ succeed: [a.id], fail: [], ambiguous: [] });

    const report: DrainReport = await drain(outbox, publisher, { clock });
    expect(report.published).toEqual([a.id]);
    expect(outbox.get(a.id)?.status).toBe('PUBLISHED');
    expect(outbox.get(a.id)?.attempts).toBe(1);
    expect(publisher.published).toHaveLength(1);

    // Re-draining never re-publishes committed records.
    const second = await drain(outbox, publisher, { clock });
    expect(second.published).toEqual([]);
    expect(publisher.published).toHaveLength(1);
    expect(outbox.get(a.id)?.attempts).toBe(1);
  });

  it('a failed publication leaves the record PENDING — never PUBLISHED without success', async () => {
    const outbox = new InMemoryOutbox();
    const a = envelope();
    outbox.enqueue([a]);
    const failFirst = scriptedPublisher({ succeed: [], fail: [a.id], ambiguous: [] });

    const report = await drain(outbox, failFirst, { clock });
    expect(report.published).toEqual([]);
    expect(report.deferred).toEqual([a.id]);
    expect(outbox.get(a.id)?.status).toBe('PENDING');
    expect(outbox.get(a.id)?.attempts).toBe(1);
  });
});

describe('outbox: deterministic backoff from the injected clock (no setTimeout)', () => {
  it('computeBackoffMs is a pure exponential with a cap', () => {
    expect(computeBackoffMs(1, 100n)).toBe(100n);
    expect(computeBackoffMs(2, 100n)).toBe(200n);
    expect(computeBackoffMs(3, 100n)).toBe(400n);
    expect(computeBackoffMs(4, 100n)).toBe(800n);
    expect(computeBackoffMs(20, 100n)).toBe(60_000n); // capped
    expect(() => computeBackoffMs(0, 100n)).toThrow();
    expect(() => computeBackoffMs(1, 0n)).toThrow();
  });

  it('defers the retry until the injected clock passes nextAttemptAt, then publishes', async () => {
    const outbox = new InMemoryOutbox();
    const a = envelope();
    outbox.enqueue([a]);
    let failures = 0;
    const flaky: OutboxPublisher = {
      publish: async (event) => {
        if (failures < 1) {
          failures += 1;
          throw new Error('simulated failure');
        }
        void event;
      },
    };

    const drainClock = new DeterministicClock(10_000n);
    const first = await drain(outbox, flaky, { clock: drainClock, backoffBaseMs: 1000n });
    expect(first.deferred).toEqual([a.id]);
    const record = outbox.get(a.id);
    expect(record?.nextAttemptAt).toBe(11_000n); // 10_000n + backoff(1) = 1000n

    // Clock has NOT advanced: the record is ineligible and not retried.
    const second = await drain(outbox, flaky, { clock: drainClock, backoffBaseMs: 1000n });
    expect(second.deferred).toEqual([]);
    expect(second.published).toEqual([]);
    expect(outbox.get(a.id)?.attempts).toBe(1);

    // Advance past the backoff window: the retry runs and succeeds.
    drainClock.advanceMs(1_000n);
    const third = await drain(outbox, flaky, { clock: drainClock, backoffBaseMs: 1000n });
    expect(third.published).toEqual([a.id]);
    expect(outbox.get(a.id)?.status).toBe('PUBLISHED');
    expect(outbox.get(a.id)?.attempts).toBe(2);
  });

  it('backoff grows exponentially across consecutive failures', async () => {
    const outbox = new InMemoryOutbox();
    const a = envelope();
    outbox.enqueue([a]);
    const alwaysFail: OutboxPublisher = {
      publish: async () => {
        throw new Error('persistent failure');
      },
    };
    const drainClock = new DeterministicClock(0n);
    const base = 100n;

    await drain(outbox, alwaysFail, { clock: drainClock, backoffBaseMs: base, maxAttempts: 10 });
    expect(outbox.get(a.id)?.nextAttemptAt).toBe(100n);

    drainClock.advanceMs(100n);
    await drain(outbox, alwaysFail, { clock: drainClock, backoffBaseMs: base, maxAttempts: 10 });
    expect(outbox.get(a.id)?.nextAttemptAt).toBe(300n); // 100n + 200n

    drainClock.advanceMs(200n);
    await drain(outbox, alwaysFail, { clock: drainClock, backoffBaseMs: base, maxAttempts: 10 });
    expect(outbox.get(a.id)?.nextAttemptAt).toBe(700n); // 300n + 400n
    expect(outbox.get(a.id)?.attempts).toBe(3);
  });
});

describe('outbox: no-loss and attempt exhaustion (INV-O02)', () => {
  it('parks the record as FAILED after maxAttempts and RETAINS it — never silently dropped', async () => {
    const outbox = new InMemoryOutbox();
    const a = envelope();
    outbox.enqueue([a]);
    const alwaysFail: OutboxPublisher = {
      publish: async () => {
        throw new Error('persistent failure');
      },
    };
    const drainClock = new DeterministicClock(0n);
    const options = { clock: drainClock, maxAttempts: 2, backoffBaseMs: 10n };

    const first = await drain(outbox, alwaysFail, options);
    expect(first.deferred).toEqual([a.id]);
    drainClock.advanceMs(10n);
    const second = await drain(outbox, alwaysFail, options);
    expect(second.failed).toEqual([a.id]);

    const record = outbox.get(a.id);
    expect(record).toBeDefined();
    expect(record?.status).toBe('FAILED');
    expect(record?.attempts).toBe(2);
    expect(record?.nextAttemptAt).toBeUndefined();

    // A FAILED record is never retried and never re-published by further drains.
    const third = await drain(outbox, alwaysFail, options);
    expect(third.failed).toEqual([]);
    expect(third.deferred).toEqual([]);
    expect(outbox.get(a.id)?.attempts).toBe(2);
  });

  it('markPublished on a FAILED record is refused (recovery must be explicit)', () => {
    const outbox = new InMemoryOutbox();
    const a = envelope();
    outbox.enqueue([a]);
    outbox.markFailed(a.id);
    expect(() => outbox.markPublished(a.id)).toThrow(OutboxStateError);
  });

  it('markPublished is idempotent for an already published record', () => {
    const outbox = new InMemoryOutbox();
    const a = envelope();
    outbox.enqueue([a]);
    outbox.markPublished(a.id);
    outbox.markPublished(a.id);
    expect(outbox.get(a.id)?.attempts).toBe(1);
  });
});

describe('outbox: UNKNOWN publication outcomes (INV-X01/X02)', () => {
  it('an ambiguous publisher fails the drain stop and leaves the record untouched', async () => {
    const outbox = new InMemoryOutbox();
    const ok = envelope();
    const ambiguous = envelope();
    const later = envelope();
    outbox.enqueue([ok, ambiguous, later]);

    const publisher = scriptedPublisher({
      succeed: [ok.id],
      fail: [],
      ambiguous: [ambiguous.id],
    });

    await expect(drain(outbox, publisher, { clock })).rejects.toThrow(ExternalAmbiguityError);

    // The ambiguous record: still PENDING, attempts untouched, no blind retry.
    const record = outbox.get(ambiguous.id);
    expect(record?.status).toBe('PENDING');
    expect(record?.attempts).toBe(0);
    expect(record?.nextAttemptAt).toBeUndefined();
    // Events before it in order were processed; the event after it was NOT dispatched.
    expect(outbox.get(ok.id)?.status).toBe('PUBLISHED');
    expect(outbox.get(later.id)?.status).toBe('PENDING');
    expect(publisher.published).toHaveLength(2); // ok + the ambiguous attempt itself
  });

  it('the propagated ambiguity is NOT a failure outcome (INV-X01)', async () => {
    const outbox = new InMemoryOutbox();
    const a = envelope();
    outbox.enqueue([a]);
    const publisher = scriptedPublisher({ succeed: [], fail: [], ambiguous: [a.id] });
    let caught: unknown;
    try {
      await drain(outbox, publisher, { clock });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ExternalAmbiguityError);
    expect(isFailureOutcome(caught)).toBe(false);
  });
});

describe('outbox: contract checks', () => {
  it('rejects malformed drain arguments', async () => {
    const outbox: Outbox = new InMemoryOutbox();
    await expect(
      drain(outbox, alwaysSucceed, { clock: null as unknown as never }),
    ).rejects.toThrow();
    await expect(
      drain(null as unknown as Outbox, alwaysSucceed, { clock }),
    ).rejects.toThrow();
    await expect(
      drain(outbox, null as unknown as OutboxPublisher, { clock }),
    ).rejects.toThrow();
  });

  it('default backoff base is 1000ms and default max attempts is 5', async () => {
    const outbox = new InMemoryOutbox();
    const a = envelope();
    outbox.enqueue([a]);
    const failOnce: OutboxPublisher = {
      publish: async () => {
        throw new Error('fail');
      },
    };
    const drainClock = new DeterministicClock(0n);
    await drain(outbox, failOnce, { clock: drainClock });
    expect(outbox.get(a.id)?.nextAttemptAt).toBe(DEFAULT_OUTBOX_BACKOFF_BASE_MS);
  });
});

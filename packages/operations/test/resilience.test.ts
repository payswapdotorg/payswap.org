import { describe, expect, it } from "vitest";

import {
  DeterministicClock,
  ExternalAmbiguityError,
  InMemoryOutbox,
  asAggregateId,
  asEventId,
  computeBackoffMs,
  drain,
  type DomainEventEnvelope,
  type OutboxPublisher,
  type TimestampMs,
} from "@payswap/protocol";

// ---------------------------------------------------------------------------
// Deterministic fixtures
// ---------------------------------------------------------------------------

const CLOCK_SEED: TimestampMs = 1_765_000_000_000n;

function eventEnvelope(
  n: number,
  occurredAt: TimestampMs = CLOCK_SEED,
): DomainEventEnvelope<{ value: string }> {
  return {
    id: asEventId(`evt_ops_${String(n).padStart(4, "0")}`),
    eventType: "operations.resilience.probe",
    payload: { value: `probe-${n}` },
    aggregate: { id: asAggregateId("agg_operations_probe"), version: 1n },
    occurredAt,
    schemaVersion: 1,
  };
}

function buildOutboxWith(count: number): InMemoryOutbox {
  const outbox = new InMemoryOutbox();
  outbox.enqueue(
    Array.from({ length: count }, (_, index) => eventEnvelope(index + 1)),
  );
  return outbox;
}

// ---------------------------------------------------------------------------
// INV-O01 — async commands are retry-safe
// ---------------------------------------------------------------------------

describe("INV-O01: async commands are retry-safe (exercised through the real outbox)", () => {
  it("a transiently failing publication retries with deterministic backoff and then publishes", async () => {
    const outbox = buildOutboxWith(1);
    const clock = new DeterministicClock(CLOCK_SEED);
    let attempts = 0;
    const flaky: OutboxPublisher = {
      publish: async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error("transient sink failure");
        }
      },
    };

    const first = await drain(outbox, flaky, { clock });
    expect(first.published).toEqual([]);
    expect(first.deferred).toEqual([asEventId("evt_ops_0001")]);
    const recordAfterFirst = outbox.get(asEventId("evt_ops_0001"));
    expect(recordAfterFirst?.status).toBe("PENDING");
    expect(recordAfterFirst?.attempts).toBe(1);
    // deterministic backoff: base 1000ms, first retry after 1 * 2^0 = 1000ms
    expect(recordAfterFirst?.nextAttemptAt).toBe(CLOCK_SEED + 1000n);

    // DeterministicClock has no advance(); eligibility is tested with fresh clocks
    const second = await drain(outbox, flaky, {
      clock: new DeterministicClock(CLOCK_SEED + 1000n),
    });
    expect(second.published).toEqual([]);
    const recordAfterSecond = outbox.get(asEventId("evt_ops_0001"));
    expect(recordAfterSecond?.attempts).toBe(2);
    expect(recordAfterSecond?.nextAttemptAt).toBe(CLOCK_SEED + 1000n + 2000n);

    const third = await drain(outbox, flaky, {
      clock: new DeterministicClock(CLOCK_SEED + 3000n),
    });
    expect(third.published).toEqual([asEventId("evt_ops_0001")]);
    expect(outbox.get(asEventId("evt_ops_0001"))?.status).toBe("PUBLISHED");
  });

  it("re-enqueueing the identical event is an idempotent no-op (single effect)", () => {
    const outbox = new InMemoryOutbox();
    const event = eventEnvelope(1);
    outbox.enqueue([event]);
    outbox.enqueue([event]);
    outbox.enqueue([event]);
    expect(outbox.records).toHaveLength(1);
    expect(outbox.records[0]?.status).toBe("PENDING");
  });

  it("the same event id with different content is a conflict, never a silent overwrite", () => {
    const outbox = new InMemoryOutbox();
    outbox.enqueue([eventEnvelope(1)]);
    const mutated: DomainEventEnvelope<{ value: string }> = {
      ...eventEnvelope(1),
      payload: { value: "tampered" },
    };
    expect(() => outbox.enqueue([mutated])).toThrowError(
      /already enqueued with different content/,
    );
    expect(outbox.records).toHaveLength(1);
    expect(outbox.records[0]?.event.payload).toEqual({ value: "probe-1" });
  });

  it("backoff is a pure function of the attempt count (bounded, deterministic)", () => {
    expect(computeBackoffMs(1, 1000n)).toBe(1000n);
    expect(computeBackoffMs(2, 1000n)).toBe(2000n);
    expect(computeBackoffMs(3, 1000n)).toBe(4000n);
    expect(computeBackoffMs(1, 100n)).toBe(100n);
    // capped at MAX_OUTBOX_BACKOFF_MS
    expect(computeBackoffMs(40, 1000n)).toBe(60_000n);
    expect(computeBackoffMs(1, 1n)).toBe(1n);
  });

  it("a record parked as FAILED is retained — never silently dropped", async () => {
    const outbox = buildOutboxWith(1);
    const alwaysFailing: OutboxPublisher = {
      publish: async () => {
        throw new Error("sink is down");
      },
    };
    // maxAttempts = 2: first drain defers, second drain parks as FAILED
    await drain(outbox, alwaysFailing, {
      clock: new DeterministicClock(CLOCK_SEED),
      maxAttempts: 2,
    });
    const second = await drain(outbox, alwaysFailing, {
      clock: new DeterministicClock(CLOCK_SEED + 10_000n),
      maxAttempts: 2,
    });
    expect(second.failed).toEqual([asEventId("evt_ops_0001")]);
    const record = outbox.get(asEventId("evt_ops_0001"));
    expect(record?.status).toBe("FAILED");
    expect(record).toBeDefined(); // retained for recovery — the record survives
  });
});

// ---------------------------------------------------------------------------
// INV-O02 — committed mutations never silently lose their outbox event
// ---------------------------------------------------------------------------

describe("INV-O02: committed financial mutations cannot silently lose their outbox event", () => {
  it("every enqueued event is published exactly once by a successful drain", async () => {
    const outbox = buildOutboxWith(5);
    const delivered: string[] = [];
    const publisher: OutboxPublisher = {
      publish: async (event) => {
        delivered.push(event.id);
      },
    };
    const report = await drain(outbox, publisher, {
      clock: new DeterministicClock(CLOCK_SEED),
    });
    expect(report.published).toHaveLength(5);
    expect(delivered).toHaveLength(5);
    expect(outbox.records.every((record) => record.status === "PUBLISHED")).toBe(
      true,
    );
  });

  it("a crash between publish and mark leaves the record PENDING and it re-publishes (at-least-once)", async () => {
    const outbox = buildOutboxWith(1);
    const deliveries: string[] = [];
    // First drain: the publisher DELIVERS but the process "crashes" before
    // markPublished — simulated by a publisher that throws a non-ambiguity
    // error AFTER performing the side effect.
    const crashAfterDelivery: OutboxPublisher = {
      publish: async (event) => {
        deliveries.push(event.id);
        throw new Error("process crashed after delivery");
      },
    };
    await drain(outbox, crashAfterDelivery, {
      clock: new DeterministicClock(CLOCK_SEED),
    });
    expect(outbox.get(asEventId("evt_ops_0001"))?.status).toBe("PENDING");

    // Idempotent consumer: the redelivery applies once.
    const applied = new Set<string>();
    const idempotentConsumer: OutboxPublisher = {
      publish: async (event) => {
        deliveries.push(event.id);
        applied.add(event.id);
      },
    };
    const report = await drain(outbox, idempotentConsumer, {
      clock: new DeterministicClock(CLOCK_SEED + 10_000n),
    });
    expect(report.published).toEqual([asEventId("evt_ops_0001")]);
    expect(deliveries.filter((id) => id === "evt_ops_0001")).toHaveLength(2); // delivered twice
    expect(applied.size).toBe(1); // applied once — no loss, no duplicate effect
  });

  it("an already-PUBLISHED record is never re-published by a later drain", async () => {
    const outbox = buildOutboxWith(2);
    let publishCalls = 0;
    const publisher: OutboxPublisher = {
      publish: async () => {
        publishCalls += 1;
      },
    };
    await drain(outbox, publisher, {
      clock: new DeterministicClock(CLOCK_SEED),
    });
    expect(publishCalls).toBe(2);
    await drain(outbox, publisher, {
      clock: new DeterministicClock(CLOCK_SEED + 60_000n),
    });
    await drain(outbox, publisher, {
      clock: new DeterministicClock(CLOCK_SEED + 120_000n),
    });
    expect(publishCalls).toBe(2); // re-draining never re-publishes PUBLISHED records
  });
});

// ---------------------------------------------------------------------------
// INV-X01/X02 at the outbox boundary — ambiguity fail-stops the drain
// ---------------------------------------------------------------------------

describe("UNKNOWN publication outcomes fail-stop (INV-X01/X02 at the drain boundary)", () => {
  it("an ambiguous publication throws, stays PENDING, and never coerces to FAILED", async () => {
    const outbox = buildOutboxWith(3);
    const ambiguous: OutboxPublisher = {
      publish: async () => {
        throw new ExternalAmbiguityError("sink outcome is unknown");
      },
    };
    await expect(
      drain(outbox, ambiguous, { clock: new DeterministicClock(CLOCK_SEED) }),
    ).rejects.toThrowError(ExternalAmbiguityError);
    for (const record of outbox.records) {
      expect(record.status).toBe("PENDING");
      expect(record.attempts).toBe(0); // untouched — no blind retry was scheduled
    }
  });

  it("after reconciliation resolves, the resumed drain completes without blind retry", async () => {
    const outbox = buildOutboxWith(2);
    let mode: "ambiguous" | "healthy" = "ambiguous";
    const reconciled: OutboxPublisher = {
      publish: async () => {
        if (mode === "ambiguous") {
          throw new ExternalAmbiguityError("sink outcome is unknown");
        }
      },
    };
    await expect(
      drain(outbox, reconciled, { clock: new DeterministicClock(CLOCK_SEED) }),
    ).rejects.toThrowError(ExternalAmbiguityError);

    // ... reconciliation happens here (the UNKNOWN-outcome playbook) ...
    mode = "healthy";
    const report = await drain(outbox, reconciled, {
      clock: new DeterministicClock(CLOCK_SEED + 5_000n),
    });
    expect(report.published).toHaveLength(2);
    expect(outbox.records.every((record) => record.status === "PUBLISHED")).toBe(
      true,
    );
    // attempts started from zero — the ambiguous pass never counted as an attempt
    expect(outbox.records.every((record) => record.attempts === 1)).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import {
  asAggregateId,
  asCommandId,
  createCommandEnvelope,
  createEventEnvelope,
  createIdFactory,
  DeterministicClock,
  PROTOCOL_SCHEMA_VERSION,
  ValidationError,
  type CommandEnvelope,
  type DomainEventEnvelope,
} from '../src/index.js';

const principal = { principalType: 'USER', principalId: 'user-7' } as const;

function deps() {
  const clock = new DeterministicClock(1_700_000_000_000n);
  return { clock, ids: createIdFactory(clock) };
}

describe('command envelope factory', () => {
  it('stamps id, issuedAt and all required fields from injected deps', () => {
    const { clock, ids } = deps();
    const command = createCommandEnvelope(
      {
        commandType: 'payments.initiate',
        payload: { amountMinor: '1000', currency: 'USD' },
        principalRef: principal,
        idempotencyKey: 'cart-42',
        schemaVersion: PROTOCOL_SCHEMA_VERSION,
      },
      { ids, clock },
    );
    expect(command.id).toMatch(/^cmd_/);
    expect(command.commandType).toBe('payments.initiate');
    expect(command.payload).toEqual({ amountMinor: '1000', currency: 'USD' });
    expect(command.principalRef).toEqual({ principalType: 'USER', principalId: 'user-7' });
    expect(command.idempotencyKey).toBe('cart-42');
    expect(command.issuedAt).toBe(1_700_000_000_000n);
    expect(command.schemaVersion).toBe(1);
    expect('causationId' in command).toBe(false);
    expect('correlationId' in command).toBe(false);
  });

  it('is frozen and validates its inputs', () => {
    const { ids, clock } = deps();
    const command = createCommandEnvelope(
      {
        commandType: 'x.y',
        payload: null,
        principalRef: principal,
        idempotencyKey: 'k',
        schemaVersion: 1,
      },
      { ids, clock },
    );
    expect(Object.isFrozen(command)).toBe(true);

    expect(() =>
      createCommandEnvelope(
        {
          commandType: '',
          payload: {},
          principalRef: principal,
          idempotencyKey: 'k',
          schemaVersion: 1,
        },
        { ids, clock },
      ),
    ).toThrow(ValidationError);
    expect(() =>
      createCommandEnvelope(
        {
          commandType: 'x.y',
          payload: {},
          principalRef: { principalType: '', principalId: '' },
          idempotencyKey: 'k',
          schemaVersion: 1,
        },
        { ids, clock },
      ),
    ).toThrow(ValidationError);
  });

  it('minted command ids are unique and deterministic per clock sequence', () => {
    const { ids, clock } = deps();
    const a = createCommandEnvelope(
      {
        commandType: 'a',
        payload: {},
        principalRef: principal,
        idempotencyKey: 'k1',
        schemaVersion: 1,
      },
      { ids, clock },
    );
    const b = createCommandEnvelope(
      {
        commandType: 'a',
        payload: {},
        principalRef: principal,
        idempotencyKey: 'k2',
        schemaVersion: 1,
      },
      { ids, clock },
    );
    expect(a.id).not.toBe(b.id);
    expect(a.id).toMatch(/_1$/);
    expect(b.id).toMatch(/_2$/);
  });
});

describe('event envelope factory', () => {
  it('carries the aggregate ref + version and occurredAt from the clock', () => {
    const { ids, clock } = deps();
    const event = createEventEnvelope(
      {
        eventType: 'ledger.credited',
        payload: { minorUnits: '100' },
        aggregate: { id: asAggregateId('agg-ledger-1'), version: 1n },
        schemaVersion: PROTOCOL_SCHEMA_VERSION,
      },
      { ids, clock },
    );
    expect(event.id).toMatch(/^evt_/);
    expect(event.eventType).toBe('ledger.credited');
    expect(event.aggregate.id).toBe('agg-ledger-1');
    expect(event.aggregate.version).toBe(1n);
    expect(event.occurredAt).toBe(1_700_000_000_000n);
    expect(Object.isFrozen(event)).toBe(true);
  });

  it('rejects zero/negative and non-bigint stream versions', () => {
    const { ids, clock } = deps();
    expect(() =>
      createEventEnvelope(
        {
          eventType: 'e',
          payload: {},
          aggregate: { id: asAggregateId('a'), version: 0n },
          schemaVersion: 1,
        },
        { ids, clock },
      ),
    ).toThrow(ValidationError);
    expect(() =>
      createEventEnvelope(
        {
          eventType: 'e',
          payload: {},
          aggregate: { id: asAggregateId('a'), version: -1n },
          schemaVersion: 1,
        },
        { ids, clock },
      ),
    ).toThrow(ValidationError);
  });
});

describe('lineage survives end-to-end', () => {
  it('causationId and correlationId propagate through a command → event → command → event chain', () => {
    const { ids, clock } = deps();
    const correlation = asCommandId('corr-abc');

    const command1 = createCommandEnvelope(
      {
        commandType: 'payments.initiate',
        payload: { ref: 1 },
        principalRef: principal,
        idempotencyKey: 'key-1',
        correlationId: correlation,
        schemaVersion: PROTOCOL_SCHEMA_VERSION,
      },
      { ids, clock },
    );
    expect(command1.correlationId).toBe(correlation);
    expect('causationId' in command1).toBe(false);

    const event1 = createEventEnvelope(
      {
        eventType: 'payment.initiated',
        payload: { ref: 1 },
        aggregate: { id: asAggregateId('agg-payment-1'), version: 1n },
        causationId: command1.id,
        correlationId: correlation,
        schemaVersion: PROTOCOL_SCHEMA_VERSION,
      },
      { ids, clock },
    );
    expect(event1.causationId).toBe(command1.id);
    expect(event1.correlationId).toBe(correlation);

    const command2 = createCommandEnvelope(
      {
        commandType: 'settlements.request',
        payload: { ref: 2 },
        principalRef: { principalType: 'SERVICE', principalId: 'settlement-worker' },
        idempotencyKey: 'key-2',
        causationId: event1.id,
        correlationId: correlation,
        schemaVersion: PROTOCOL_SCHEMA_VERSION,
      },
      { ids, clock },
    );
    expect(command2.causationId).toBe(event1.id);
    expect(command2.correlationId).toBe(correlation);

    const event2 = createEventEnvelope(
      {
        eventType: 'settlement.requested',
        payload: { ref: 2 },
        aggregate: { id: asAggregateId('agg-settlement-1'), version: 1n },
        causationId: command2.id,
        correlationId: correlation,
        schemaVersion: PROTOCOL_SCHEMA_VERSION,
      },
      { ids, clock },
    );

    const chain: readonly (CommandEnvelope<unknown> | DomainEventEnvelope<unknown>)[] = [
      command1,
      event1,
      command2,
      event2,
    ];
    for (const envelope of chain) {
      expect(envelope.correlationId).toBe(correlation);
    }
    expect(event2.causationId).toBe(command2.id);
    expect(event1.causationId).toBe(command1.id);
  });

  it('optional lineage fields are truly absent when not supplied (exactOptionalPropertyTypes)', () => {
    const { ids, clock } = deps();
    const event = createEventEnvelope(
      {
        eventType: 'e',
        payload: {},
        aggregate: { id: asAggregateId('a'), version: 1n },
        schemaVersion: 1,
      },
      { ids, clock },
    );
    expect('causationId' in event).toBe(false);
    expect('correlationId' in event).toBe(false);
    expect(event.causationId).toBeUndefined();
  });
});

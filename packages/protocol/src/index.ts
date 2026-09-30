/**
 * @payswap/protocol — Protocol kernel, ledger core and persistence contracts.
 *
 * Work Orders: W1-001 (Stage 0 contract freeze) + W1-002 (Stage 1) —
 * deterministic, NO rails, NO mocks. Exact money, branded identifiers,
 * command/event envelopes, retry-safe idempotency, deterministic state
 * machines, event-sourced aggregate boundaries, PostgreSQL persistence
 * conventions, the domain error taxonomy and the deterministic clock/epoch
 * abstraction; on top of that kernel: the append-only double-entry
 * accountability journal, balance projections, atomic reservations,
 * fulfillment activities → clearing records → obligations, and the durable
 * outbox with deterministic backoff.
 */

export const PACKAGE_NAME = '@payswap/protocol' as const;

export * from './errors.js';
export * from './clock.js';
export * from './identifiers.js';
export * from './money.js';
export * from './envelope.js';
export * from './idempotency.js';
export * from './state-machine.js';
export * from './aggregate.js';
export * from './persistence.js';
export * from './ledger/index.js';
export * from './reservation.js';
export * from './obligation.js';
export * from './outbox.js';

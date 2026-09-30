/**
 * @payswap/protocol — Protocol kernel and persistence contracts.
 *
 * Work Order: W1-001 (Stage 0 contract freeze) — deterministic, NO rails,
 * NO mocks. Exact money, branded identifiers, command/event envelopes,
 * retry-safe idempotency, deterministic state machines, event-sourced
 * aggregate boundaries, PostgreSQL persistence contracts, the domain error
 * taxonomy and the deterministic clock/epoch abstraction.
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

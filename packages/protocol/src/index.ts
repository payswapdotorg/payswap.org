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
 *
 * W1-003 (Stage 2) adds the netting/liquidity/credit/FX layer: temporal
 * netting sets with INV-F07 gross-derivation preservation and
 * settlement-instruction reduction; observed liquidity assets/positions
 * (never custody), atomic liquidity reservations on the shared reservation
 * state machine and deterministic forecasts; explicit credit lines and
 * per-draw CreditExposure records (INV-F08 — delay is never hidden credit);
 * exact rational FX quotes with mandatory rate/fee/spread provenance
 * (INV-F09) and documented banker's rounding; and the FROZEN §10 Value
 * Conversion Graph with deterministic bounded route enumeration.
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
export * from './netting.js';
export * from './liquidity.js';
export * from './collateral.js';
export * from './credit.js';
export * from './fx.js';
export * from './value-graph.js';

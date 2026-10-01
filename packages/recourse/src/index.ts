/**
 * @payswap/recourse — disputes, recourse, escrow, bonds and guarantees
 * (Work Order W1-006, Stage 6).
 *
 * - `policy.ts` — the transaction RecoursePolicy: declared at initiation,
 *   IMMUTABLE afterwards (registry-enforced), with claim windows and evidence
 *   requirements declared up front and ENFORCED at claim time (proof levels
 *   capped by INV-E04 provenance, consumed from @payswap/settlement).
 * - `disputes.ts` — the DisputeCase: a separate append-only record that
 *   references the original transaction by id and never rewrites it; lifecycle
 *   states with monotonic terminal transitions and exactly one explicit
 *   recovery (REJECTED --REOPEN--> UNDER_REVIEW with new evidence, INV-X04).
 * - `recourse-obligations.ts` — recourse produces SEPARATE obligations
 *   derived through the protocol's own fulfillment-activity → clearing-record
 *   → obligation machinery; clawback-style adjustments follow the INV-F02
 *   append-only discipline (the original obligation is never mutated).
 * - `escrow.ts` — the escrow protection mechanism: escrowed value lives in
 *   its own dedicated RESERVE account locked by a protocol reservation
 *   (never merged with operational balances); release/forfeit/refund are
 *   explicit evidence-backed decisions, forfeit requiring a GRANTED dispute.
 * - `bonds.ts` — the ExecutionBond: issuance with separately-accounted
 *   collateral, forfeiture conditions (granted dispute + window + proof
 *   threshold + exposure cap), and bond claims that create separate recourse
 *   obligations.
 * - `guarantees.ts` — the guarantee protection mechanism: immutable guarantor
 *   declarations, invocation windows, guarantee-backed recourse obligations.
 * - `evidence.ts` — dispute/recourse evidence attached to the settlement
 *   evidence graph: full lineage queryable (INV-E01/E02), historical evidence
 *   immutable (INV-E05), provenance caps enforced (INV-E04).
 *
 * Invariants structurally exercised by this package:
 * - INV-F01: exact integer minor-unit money everywhere (bigint only).
 * - INV-F02: append-only discipline — adjustments are new facts, never edits.
 * - INV-F03: every journal-relevant effect posted through the protocol
 *   journal's balanced-entry validation.
 * - INV-F04: reservations gate escrow/bond funding against available value.
 * - INV-F06: recourse effects are produced through the protocol's own
 *   obligation machinery — never beside it.
 * - INV-X04: terminal transitions are monotonic except declared recovery.
 * - INV-E01/E02/E05: evidence lineage is queryable and history is immutable.
 */

export const PACKAGE_NAME = '@payswap/recourse' as const;

export * from './policy.js';
export * from './evidence.js';
export * from './disputes.js';
export * from './recourse-obligations.js';
export * from './escrow.js';
export * from './bonds.js';
export * from './guarantees.js';

# Persistence Conventions — @payswap/protocol (W1-001)

Status: **Stage 0 contract freeze.** This document plus the typed contracts in
`src/persistence.ts` define how PostgreSQL persists protocol truth. The DDL
shipped in `src/persistence.ts` is *reference documentation* — nothing is
executed against a database at Stage 0. The implementation Work Orders (W1-002
ledger and beyond) must implement these contracts without weakening them;
any deviation is an architecture-conflict report, not an improvisation.

Authority: `spec/architecture/FROZEN-ARCHITECTURE.md` §21 (PostgreSQL is the
system of record) and `spec/architecture/INVARIANTS.md`.

## 1. Append-only event journal (INV-F02)

`protocol_event_journal` is the immutable record of protocol facts:

| Column          | Type    | Notes                                        |
|-----------------|---------|----------------------------------------------|
| `event_id`      | TEXT    | Primary key; minted by the deterministic `IdFactory`. |
| `aggregate_type`| TEXT    | Aggregate kind, e.g. `ledger.account`.       |
| `aggregate_id`  | TEXT    | Stream id within the aggregate type.         |
| `version`       | BIGINT  | 1-based, strictly consecutive per stream.    |
| `event_type`    | TEXT    | Stable event name, e.g. `ledger.account.credited`. |
| `payload`       | JSONB   | Event payload; `schemaVersion` travels inside the envelope. |
| `occurred_at`   | BIGINT  | Milliseconds since epoch, from the injected `ProtocolClock`. |

Rules:

1. `UNIQUE (aggregate_id, version)` is the stream-integrity constraint. A
   stream id must be globally unique across aggregate types (ids are minted
   with an aggregate-type prefix), or the uniqueness key must be widened to
   `(aggregate_type, aggregate_id, version)` by later Work Orders — widening
   is an additive change, permitted under INV-O03.
2. The `trg_event_journal_append_only` trigger rejects `UPDATE` and `DELETE`
   on the table. Historical protocol facts are immutable (AGENTS.md rule 8);
   corrections are new compensating events, never edits.
3. Application roles receive `INSERT`/`SELECT` only. Reconciliation may
   append but never rewrite history (INV-X03 operates through new events).
4. `BIGINT` values cross language boundaries as decimal strings and are
   parsed back with `BigInt(...)` (see `parseVersion`). Money never becomes a
   float at any boundary (INV-F01).

## 2. Optimistic concurrency

Every mutation of an aggregate is an append of its next version:

1. Load the stream (or rely on the cached aggregate).
2. Append with `expectedVersion = currentVersion`; the insert must fail when
   the journal already contains a row at any event's version.
3. A `UNIQUE (aggregate_id, version)` violation — or an `expectedVersion`
   mismatch — maps to `EventVersionConflictError` (`EVENT_VERSION_CONFLICT`,
   category `CONFLICT`). The command is retried by re-reading the stream,
   never by overwriting.

Under this scheme two writers can never both commit version N of the same
stream; the loser re-folds from the journal.

## 3. Transactional outbox (INV-O02)

A committed financial mutation can never silently lose its outbox event.

- `protocol_outbox` rows are inserted **in the same database transaction** as
  their `protocol_event_journal` rows. `commitAtomically` is the only
  sanctioned write path: journal append and outbox enqueue succeed or fail
  together.
- Dispatch workers claim pending rows (`dispatched_at IS NULL`) at-least-once
  and mark them dispatched after the downstream effect is durably accepted.
  At-least-once dispatch requires idempotent consumers: consumers key on
  `event_id` through the `IdempotencyRegistrar` contract.
- The outbox is the only channel through which protocol facts trigger
  external effects. No dual-write, no best-effort side channel.

## 4. Projections and rebuilds (INV-O04)

Balances, positions and every derived view are projections over the journal
(INV-F02). Restore/replay must reconstruct authoritative state.

- Each projection records a `protocol_projection_checkpoint`
  (`projection_name`, `stream_id`, `last_version`) so replay is resumable.
- A rebuild replays journal events in `(aggregate_id, version)` order from
  version 0 and is idempotent: replaying the same prefix twice yields the
  same projection state.
- A projection may be dropped and rebuilt at any time. Losing a projection
  is an availability incident, never a correctness incident.
- Projection consumers treat UNKNOWN outcomes as reconciliation work items
  (INV-X01/X03); a projection may never flatten UNKNOWN into FAILED.

## 5. Migration compatibility (INV-O03)

Schema migrations are deployment-compatible: expand → migrate → contract.

1. **EXPAND (additive-first)**: add columns/tables/indexes. No existing
   reader or writer may break. Destructive changes are forbidden here.
2. **MIGRATE**: backfill and dual-write while both old and new shapes are
   live. Verification steps assert consistency.
3. **CONTRACT (destructive)**: remove old shapes only after a declared
   `DeprecationWindow` (`introducedIn` → `eligibleForRemovalAfter`) has
   elapsed and the ordered verifications pass.

A `MigrationPlan` is validated by `validateMigrationPlan` (phase ordering,
additive-first, mandatory deprecation windows on CONTRACT steps, callable
`verify()` per step) and executed by `runMigrationVerifies` during deployment
gates. Deploy-time rollback is always possible during EXPAND; after CONTRACT
the rollback is the next forward migration.

## 6. Determinism requirements on the write path

- Event ids come from the deterministic `IdFactory` (prefix + injected clock
  + monotonic sequence) — never from database sequence defaults.
- `occurred_at` comes from the injected `ProtocolClock` — never from
  `CURRENT_TIMESTAMP` inside the database, because replay must reproduce the
  recorded value, and reconciliation compares recorded times.
- Payloads are canonical JSON with `bigint`-shaped values encoded as decimal
  strings (never IEEE-754 doubles).

## 7. Stage 0 boundaries

- No database connection, no ORM, no driver import lives in this package
  (enforced by `test/boundary.test.ts`: only relative imports under `src/`).
- The DDL strings are documentation for the implementing Work Orders.
- `ProtocolEventPersistence` implementations must be provided by
  infrastructure packages, never by domain packages.

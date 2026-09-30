/**
 * @payswap/protocol — PostgreSQL persistence contracts (W1-001).
 *
 * Stage 0 ships the TYPED CONTRACTS and the reference DDL as documented
 * strings — nothing here is executed against a database. The PostgreSQL
 * implementation lands in later Work Orders under these contracts.
 *
 * Invariants encoded here:
 * - INV-F02 / runbook "rewriting history is forbidden": the event journal
 *   is append-only (DDL-level UPDATE/DELETE rejection).
 * - Optimistic concurrency: UNIQUE (aggregate_id, version) + expected
 *   version check; violations map to `EventVersionConflictError`.
 * - INV-O02: a committed financial mutation can never silently lose its
 *   outbox event — journal append and outbox insert happen in ONE
 *   transaction (`ProtocolEventPersistence.commitAtomically`).
 * - INV-O04: projections are rebuildable from the journal.
 * - INV-O03: schema migrations are deployment-compatible — expand/contract,
 *   additive-first, no destructive change without a declared deprecation
 *   window, verified by ordered `verify()` steps.
 *
 * See src/conventions/persistence.md for the full conventions document.
 */

import { PaySwapError, ValidationError, type PaySwapErrorDetails } from './errors.js';
import type { TimestampMs } from './clock.js';
import type { AggregateId, EventId } from './identifiers.js';

/**
 * Reference DDL for the append-only event journal. Documented contract —
 * NOT executed at Stage 0. `BIGINT` columns cross the wire as decimal
 * strings; parse them back with `BigInt(...)`.
 */
export const EVENT_JOURNAL_DDL: readonly string[] = Object.freeze([
  `CREATE TABLE protocol_event_journal (
    event_id       TEXT   NOT NULL PRIMARY KEY,
    aggregate_type TEXT   NOT NULL,
    aggregate_id   TEXT   NOT NULL,
    version        BIGINT NOT NULL,
    event_type     TEXT   NOT NULL,
    payload        JSONB  NOT NULL,
    occurred_at    BIGINT NOT NULL,
    CONSTRAINT uq_event_journal_stream UNIQUE (aggregate_id, version)
);`,
  `CREATE INDEX idx_event_journal_stream ON protocol_event_journal (aggregate_id, version);`,
  `CREATE FUNCTION protocol_journal_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'protocol_event_journal is append-only (INV-F02): % forbidden', TG_OP;
END;
$$ LANGUAGE plpgsql;`,
  `CREATE TRIGGER trg_event_journal_append_only
    BEFORE UPDATE OR DELETE ON protocol_event_journal
    FOR EACH ROW EXECUTE FUNCTION protocol_journal_append_only();`,
]);

/**
 * Reference DDL for the transactional outbox. Rows are inserted in the SAME
 * transaction as their journal events (INV-O02); dispatchers claim rows by
 * nulling `dispatched_at` under an optimistic claim.
 */
export const TRANSACTIONAL_OUTBOX_DDL: readonly string[] = Object.freeze([
  `CREATE TABLE protocol_outbox (
    outbox_id    BIGSERIAL PRIMARY KEY,
    event_id     TEXT   NOT NULL REFERENCES protocol_event_journal (event_id),
    dispatch_type TEXT  NOT NULL,
    payload      JSONB  NOT NULL,
    enqueued_at  BIGINT NOT NULL,
    dispatched_at BIGINT
);`,
  `CREATE INDEX idx_protocol_outbox_pending ON protocol_outbox (outbox_id)
    WHERE dispatched_at IS NULL;`,
]);

/** Reference DDL for projection checkpoints (INV-O04 rebuild positions). */
export const PROJECTION_CHECKPOINT_DDL: readonly string[] = Object.freeze([
  `CREATE TABLE protocol_projection_checkpoint (
    projection_name TEXT   NOT NULL,
    stream_id       TEXT   NOT NULL,
    last_version    BIGINT NOT NULL,
    updated_at      BIGINT NOT NULL,
    PRIMARY KEY (projection_name, stream_id)
);`,
]);

/** One journalled event, exactly as persisted. */
export interface JournalEventRecord {
  readonly eventId: EventId;
  readonly aggregateType: string;
  readonly aggregateId: AggregateId;
  readonly version: bigint;
  readonly eventType: string;
  readonly payload: unknown;
  readonly occurredAt: TimestampMs;
}

/** One outbox message tied to a journalled event. */
export interface OutboxMessage {
  readonly eventId: EventId;
  readonly dispatchType: string;
  readonly payload: unknown;
}

/**
 * The atomic commit unit: journal append + outbox insert in one transaction.
 *
 * `expectedVersion` is the aggregate version the caller believes is current
 * (optimistic concurrency); a mismatch or a UNIQUE (aggregate_id, version)
 * violation surfaces as `EVENT_VERSION_CONFLICT`.
 */
export interface AtomicEventCommit {
  readonly aggregateId: AggregateId;
  readonly expectedVersion: bigint;
  readonly events: readonly JournalEventRecord[];
  readonly outbox: readonly OutboxMessage[];
}

/**
 * Journal read/write contract. `appendEvents` MUST join the caller's
 * transaction; it MUST NOT commit independently.
 */
export interface EventJournalStore {
  appendEvents(commit: AtomicEventCommit): Promise<void>;
  readStream(
    aggregateId: AggregateId,
    options?: { readonly afterVersionExclusive?: bigint },
  ): Promise<readonly JournalEventRecord[]>;
}

/** Outbox read/claim contract for dispatch workers. */
export interface TransactionalOutboxStore {
  readPending(limit: number): Promise<readonly (OutboxMessage & { readonly outboxId: bigint })[]>;
  markDispatched(outboxIds: readonly bigint[]): Promise<void>;
}

/**
 * INV-O02 contract: appending events and enqueueing their outbox messages
 * is one atomic operation. An implementation that can commit the journal
 * write while losing the outbox write violates this interface.
 */
export interface ProtocolEventPersistence extends EventJournalStore, TransactionalOutboxStore {}

/** Rebuild position of one projection over one stream (INV-O04). */
export interface ProjectionCheckpoint {
  readonly projectionName: string;
  readonly streamId: string;
  readonly lastVersion: bigint;
  readonly updatedAt: TimestampMs;
}

/** Migration phases in mandatory order: expand, migrate, contract. */
export type MigrationPhase = 'EXPAND' | 'MIGRATE' | 'CONTRACT';

/**
 * Declared deprecation window for a destructive (CONTRACT) step — INV-O03:
 * no destructive change without a deprecation window.
 */
export interface DeprecationWindow {
  /** Release in which the deprecated element was marked deprecated. */
  readonly introducedIn: string;
  /** Earliest release in which removal is allowed. */
  readonly eligibleForRemovalAfter: string;
}

/** One ordered migration step with its own verification. */
export interface MigrationStep {
  readonly id: string;
  readonly phase: MigrationPhase;
  readonly description: string;
  /** REQUIRED for CONTRACT steps; forbidden otherwise. */
  readonly deprecationWindow?: DeprecationWindow;
  /** Pure verification of this step's postcondition. */
  verify(): void | Promise<void>;
}

/** An ordered, deployment-compatible migration plan (INV-O03). */
export interface MigrationPlan {
  readonly id: string;
  readonly description: string;
  readonly steps: readonly MigrationStep[];
}

/** The migration plan violates deployment-compatibility rules (INV-O03). */
export class MigrationPlanError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({
      code: 'MIGRATION_PLAN_INVALID',
      category: 'MIGRATION_INCOMPATIBLE',
      message,
      details,
    });
  }
}

const PHASE_RANK: Readonly<Record<MigrationPhase, number>> = Object.freeze({
  EXPAND: 0,
  MIGRATE: 1,
  CONTRACT: 2,
});

/**
 * Validate a migration plan against INV-O03:
 * - step ids are non-empty and unique;
 * - phases never regress (EXPAND steps precede MIGRATE precede CONTRACT);
 * - the first CONTRACT step is preceded by at least one EXPAND step
 *   (additive-first);
 * - every CONTRACT (destructive) step declares a deprecation window;
 * - EXPAND/MIGRATE steps never declare one;
 * - every step carries a callable `verify`.
 */
export function validateMigrationPlan(plan: MigrationPlan): void {
  if (typeof plan.id !== 'string' || plan.id.length === 0) {
    throw new MigrationPlanError('plan id must be a non-empty string');
  }
  const seen = new Set<string>();
  let lastPhaseRank = -1;
  let expandSeen = false;
  for (const [index, step] of plan.steps.entries()) {
    if (typeof step.id !== 'string' || step.id.length === 0) {
      throw new MigrationPlanError('step id must be a non-empty string', { index });
    }
    if (seen.has(step.id)) {
      throw new MigrationPlanError('duplicate step id', { id: step.id });
    }
    seen.add(step.id);
    const rank: number | undefined = PHASE_RANK[step.phase];
    if (rank === undefined) {
      throw new MigrationPlanError('unknown migration phase', { id: step.id, phase: step.phase });
    }
    if (rank < lastPhaseRank) {
      throw new MigrationPlanError(
        'migration phases must not regress (EXPAND before MIGRATE before CONTRACT)',
        { id: step.id, phase: step.phase },
      );
    }
    lastPhaseRank = rank;
    if (step.phase === 'EXPAND') {
      expandSeen = true;
    }
    if (step.phase === 'CONTRACT') {
      if (!expandSeen) {
        throw new MigrationPlanError(
          'additive-first violated: a CONTRACT step appears before any EXPAND step',
          { id: step.id },
        );
      }
      if (
        step.deprecationWindow === undefined ||
        typeof step.deprecationWindow.introducedIn !== 'string' ||
        step.deprecationWindow.introducedIn.length === 0 ||
        typeof step.deprecationWindow.eligibleForRemovalAfter !== 'string' ||
        step.deprecationWindow.eligibleForRemovalAfter.length === 0
      ) {
        throw new MigrationPlanError(
          'destructive (CONTRACT) step requires a deprecation window (INV-O03)',
          { id: step.id },
        );
      }
    } else if (step.deprecationWindow !== undefined) {
      throw new MigrationPlanError(
        'only CONTRACT steps may declare a deprecation window',
        { id: step.id, phase: step.phase },
      );
    }
    if (typeof step.verify !== 'function') {
      throw new MigrationPlanError('every step must provide a callable verify()', { id: step.id });
    }
    if (typeof step.description !== 'string' || step.description.length === 0) {
      throw new MigrationPlanError('step description must be a non-empty string', { id: step.id });
    }
  }
}

/**
 * Run the plan's `verify()` steps in declared order (after validating the
 * plan). Used by deployment gates: a plan whose verifications fail is not
 * deployment-compatible.
 */
export async function runMigrationVerifies(plan: MigrationPlan): Promise<void> {
  validateMigrationPlan(plan);
  for (const step of plan.steps) {
    await step.verify();
  }
}

const DECIMAL_DIGITS_PATTERN = /^[0-9]+$/;

/**
 * Guard helper for wire-boundary parsing: accepts strictly non-negative
 * decimal digit strings (`"0"`, `"42"`, `"9007199254740993"`). Hex (`"0x10"`),
 * floats (`"1.5"`), signed, empty or whitespace inputs are rejected —
 * `BigInt(...)` alone would happily accept hex, so the boundary stays strict.
 */
export function parseVersion(value: string, label = 'version'): bigint {
  if (typeof value !== 'string' || !DECIMAL_DIGITS_PATTERN.test(value)) {
    throw new ValidationError(`${label} must be a decimal string of digits`, { value });
  }
  return BigInt(value);
}

import { describe, expect, it } from 'vitest';
import {
  EVENT_JOURNAL_DDL,
  MigrationPlanError,
  parseVersion,
  PROJECTION_CHECKPOINT_DDL,
  runMigrationVerifies,
  TRANSACTIONAL_OUTBOX_DDL,
  validateMigrationPlan,
  type DeprecationWindow,
  type MigrationPlan,
  type MigrationStep,
} from '../src/index.js';

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}

const allDdl = [...EVENT_JOURNAL_DDL, ...TRANSACTIONAL_OUTBOX_DDL, ...PROJECTION_CHECKPOINT_DDL]
  .map(normalize)
  .join(' ');

describe('reference DDL contract (documented, not executed)', () => {
  it('journal enforces UNIQUE (aggregate_id, version) for stream integrity', () => {
    const journal = EVENT_JOURNAL_DDL.map(normalize).join(' ');
    expect(journal).toContain('unique (aggregate_id, version)');
    expect(journal).toContain('event_id');
    expect(journal).toContain('aggregate_type');
    expect(journal).toContain('event_type');
    expect(journal).toContain('payload');
    expect(journal).toContain('occurred_at');
    expect(journal).toContain('version');
  });

  it('journal is append-only: UPDATE and DELETE are rejected by trigger (INV-F02)', () => {
    const journal = EVENT_JOURNAL_DDL.map(normalize).join(' ');
    expect(journal).toContain('before update or delete');
    expect(journal).toContain('append-only');
  });

  it('outbox exists and references the journal (INV-O02 same-transaction insert)', () => {
    const outbox = TRANSACTIONAL_OUTBOX_DDL.map(normalize).join(' ');
    expect(outbox).toContain('references protocol_event_journal');
    expect(outbox).toContain('dispatched_at');
  });

  it('projection checkpoints exist for rebuildable projections (INV-O04)', () => {
    const checkpoint = PROJECTION_CHECKPOINT_DDL.map(normalize).join(' ');
    expect(checkpoint).toContain('projection_name');
    expect(checkpoint).toContain('last_version');
  });

  it('uses bigint columns and jsonb payloads throughout', () => {
    expect(allDdl).toContain('bigint');
    expect(allDdl).toContain('jsonb');
  });
});

describe('MigrationPlan validation (INV-O03)', () => {
  const step = (
    id: string,
    phase: MigrationStep['phase'],
    extra?: { readonly deprecationWindow?: DeprecationWindow },
  ): MigrationStep => ({
    id,
    phase,
    description: `${phase} ${id}`,
    verify: () => undefined,
    ...extra,
  });

  const validPlan: MigrationPlan = {
    id: 'plan-1',
    description: 'add fees table then drop legacy column',
    steps: [
      step('expand-1', 'EXPAND'),
      step('migrate-1', 'MIGRATE'),
      {
        id: 'contract-1',
        phase: 'CONTRACT',
        description: 'drop legacy.fee_column after deprecation window',
        deprecationWindow: { introducedIn: 'v0.2.0', eligibleForRemovalAfter: 'v0.4.0' },
        verify: () => undefined,
      },
    ],
  };

  it('accepts a well-formed expand → migrate → contract plan', () => {
    expect(() => validateMigrationPlan(validPlan)).not.toThrow();
  });

  it('rejects phase regression (CONTRACT before EXPAND)', () => {
    const plan: MigrationPlan = {
      id: 'plan-2',
      description: 'bad order',
      steps: [
        {
          id: 'contract-1',
          phase: 'CONTRACT',
          description: 'destructive first',
          deprecationWindow: { introducedIn: 'v0.1.0', eligibleForRemovalAfter: 'v0.3.0' },
          verify: () => undefined,
        },
        step('expand-1', 'EXPAND'),
      ],
    };
    expect(() => validateMigrationPlan(plan)).toThrow(MigrationPlanError);
  });

  it('rejects destructive steps without a deprecation window', () => {
    const plan: MigrationPlan = {
      id: 'plan-3',
      description: 'no window',
      steps: [
        step('expand-1', 'EXPAND'),
        step('migrate-1', 'MIGRATE'),
        step('contract-1', 'CONTRACT'), // no deprecationWindow
      ],
    };
    expect(() => validateMigrationPlan(plan)).toThrow(MigrationPlanError);
    try {
      validateMigrationPlan(plan);
      expect.unreachable('must throw');
    } catch (error) {
      expect((error as MigrationPlanError).category).toBe('MIGRATION_INCOMPATIBLE');
    }
  });

  it('rejects a CONTRACT phase with no preceding EXPAND (additive-first)', () => {
    const plan: MigrationPlan = {
      id: 'plan-4',
      description: 'contract only',
      steps: [
        {
          id: 'c',
          phase: 'CONTRACT',
          description: 'x',
          deprecationWindow: { introducedIn: 'a', eligibleForRemovalAfter: 'b' },
          verify: () => undefined,
        },
      ],
    };
    expect(() => validateMigrationPlan(plan)).toThrow(MigrationPlanError);
  });

  it('rejects duplicate step ids, empty ids and missing verify()', () => {
    expect(() =>
      validateMigrationPlan({ ...validPlan, steps: [step('a', 'EXPAND'), step('a', 'EXPAND')] }),
    ).toThrow(MigrationPlanError);
    expect(() =>
      validateMigrationPlan({ ...validPlan, steps: [step('', 'EXPAND')] }),
    ).toThrow(MigrationPlanError);
    expect(() =>
      validateMigrationPlan({
        ...validPlan,
        steps: [{ id: 'x', phase: 'EXPAND', description: 'x', verify: undefined as unknown as () => void }],
      }),
    ).toThrow(MigrationPlanError);
  });

  it('rejects deprecation windows on non-destructive phases and empty plan ids', () => {
    expect(() =>
      validateMigrationPlan({
        ...validPlan,
        steps: [
          {
            id: 'e1',
            phase: 'EXPAND',
            description: 'x',
            deprecationWindow: { introducedIn: 'a', eligibleForRemovalAfter: 'b' },
            verify: () => undefined,
          },
        ],
      }),
    ).toThrow(MigrationPlanError);
    expect(() => validateMigrationPlan({ ...validPlan, id: '' })).toThrow(MigrationPlanError);
  });
});

describe('runMigrationVerifies', () => {
  it('runs verify() steps in declared order', async () => {
    const calls: string[] = [];
    const plan: MigrationPlan = {
      id: 'ordered',
      description: 'ordered verifies',
      steps: [
        { id: 's1', phase: 'EXPAND', description: 'a', verify: () => void calls.push('s1') },
        { id: 's2', phase: 'MIGRATE', description: 'b', verify: async () => void calls.push('s2') },
        {
          id: 's3',
          phase: 'CONTRACT',
          description: 'c',
          deprecationWindow: { introducedIn: 'v1', eligibleForRemovalAfter: 'v2' },
          verify: () => void calls.push('s3'),
        },
      ],
    };
    await runMigrationVerifies(plan);
    expect(calls).toEqual(['s1', 's2', 's3']);
  });

  it('propagates verification failures and validates first', async () => {
    const plan: MigrationPlan = {
      id: 'failing',
      description: 'x',
      steps: [
        {
          id: 'boom',
          phase: 'EXPAND',
          description: 'x',
          verify: () => {
            throw new Error('postcondition failed');
          },
        },
      ],
    };
    await expect(runMigrationVerifies(plan)).rejects.toThrow('postcondition failed');
    await expect(
      runMigrationVerifies({ id: '', description: 'x', steps: [] }),
    ).rejects.toThrow(MigrationPlanError);
  });
});

describe('wire-boundary helpers', () => {
  it('parses decimal-string versions back to bigint exactly', () => {
    expect(parseVersion('9007199254740993')).toBe(9007199254740993n);
    expect(parseVersion('0')).toBe(0n);
    expect(() => parseVersion('')).toThrow();
    expect(() => parseVersion('1.5')).toThrow();
    expect(() => parseVersion('0x10')).toThrow();
  });
});

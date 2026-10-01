/**
 * W3-005 test helpers — fully deterministic fixtures.
 *
 * Determinism discipline: every clock is a `DeterministicClock`, every id
 * factory is seeded from a fresh identically-seeded clock, funder balances
 * are posted through the real protocol journal (no fake balances), budgets
 * are funded through real protocol reservations. No Math.random, no ambient
 * host time, no timers.
 */

import {
  DeterministicClock,
  USD,
  asPartyId,
  createIdFactory,
  fromMinorUnits,
  InMemoryLedgerJournal,
  InMemoryObligationBook,
  InMemoryReservationBook,
  accountId,
  createJournalEntry,
  postJournal,
  type IdFactory,
  type LedgerJournal,
  type Money,
  type ObligationBook,
  type ReservationLedgerState,
  type TimestampMs,
} from '@payswap/protocol';
import {
  asIncentiveProgramId,
  asParticipationGoalId,
  ContributionLedger,
  IncentiveBudgetLedger,
  incentiveFundingAccount,
  InMemoryRewardBook,
  ProgramVersionRegistry,
  type ContributionRecord,
  type EvidenceReference,
  type IncentiveProgramDraft,
  type IncentiveProgramVersion,
  type ProofLevel,
  type ProgramVersionRef,
} from '@payswap/participation';
import { CampaignEngine, type CampaignEngineDeps } from '../src/campaigns.js';

export const T0 = 1_000_000n;

export function usd(minorUnits: bigint): Money {
  return fromMinorUnits(USD, minorUnits);
}

/** The full deterministic campaign fixture state. */
export interface CampaignFixture {
  readonly clock: DeterministicClock;
  readonly ids: IdFactory;
  readonly journal: LedgerJournal;
  readonly reservationState: ReservationLedgerState;
  readonly programs: ProgramVersionRegistry;
  readonly budgets: IncentiveBudgetLedger;
  readonly rewards: InMemoryRewardBook;
  readonly obligations: ObligationBook;
  readonly ledger: ContributionLedger;
  readonly engine: CampaignEngine;
}

/**
 * Deterministic fixture: journal with the funder's incentive account seeded
 * through a balanced double-entry posting (real INV-F03 discipline), the
 * protocol reservation state, funded budget ledger, program registry,
 * reward book and the campaign engine — all over one injected clock.
 */
export function campaignFixture(
  funderBalanceMinorUnits = 1_000_000n,
  seedMs: TimestampMs = T0,
): CampaignFixture {
  const clock = new DeterministicClock(seedMs);
  const ids = createIdFactory(clock);
  const journal = new InMemoryLedgerJournal();
  if (funderBalanceMinorUnits > 0n) {
    const funding = incentiveFundingAccount(asPartyId('sponsor-1'));
    const equity = accountId('EQUITY', 'opening.usd');
    postJournal(
      journal,
      createJournalEntry(
        {
          lines: [
            { accountId: funding, amount: usd(funderBalanceMinorUnits) },
            { accountId: equity, amount: usd(-funderBalanceMinorUnits) },
          ],
          memo: 'deterministic funder seeding',
        },
        { ids, clock },
      ),
    );
  }
  const reservationState: ReservationLedgerState = {
    journal,
    reservations: new InMemoryReservationBook(),
    ids: createIdFactory(clock),
    clock,
  };
  const budgets = new IncentiveBudgetLedger(reservationState);
  const rewards = new InMemoryRewardBook();
  const obligations = new InMemoryObligationBook();
  const ledger = new ContributionLedger();
  const programs = new ProgramVersionRegistry();
  const deps: CampaignEngineDeps = {
    ids,
    clock,
    rewards,
    budgets,
    obligations,
    programs,
    ledger,
  };
  return {
    clock,
    ids,
    journal,
    reservationState,
    programs,
    budgets,
    rewards,
    obligations,
    ledger,
    engine: new CampaignEngine(deps),
  };
}

/** Register the standard test program (version 1, ACTIVE). */
export function registerProgram(
  fixture: CampaignFixture,
  overrides?: Partial<IncentiveProgramDraft>,
  programId = 'prog_campaigns_test',
): IncentiveProgramVersion {
  return fixture.programs.registerProgram(
    {
      programId: asIncentiveProgramId(programId),
      effectiveFrom: 1_000n,
      sponsor: asPartyId('sponsor-1'),
      objective: 'raise verified first-time adoption',
      eligibleRole: 'SENDER',
      eligibilityRules: [{ kind: 'MIN_PROOF_LEVEL', level: 'P1' }],
      contributionEvents: ['PAYMENT_METHOD_ADOPTED', 'REFERRAL_CREDIT'],
      proofRequirements: { minProofLevel: 'P1' },
      reward: {
        mechanism: 'FEE_REBATE',
        formula: { kind: 'FIXED_PER_CONTRIBUTION', amount: usd(500n) },
      },
      budget: { totalAmount: usd(10_000n), funding: 'REQUIRES_FUNDED_RESERVATION' },
      antiGamingPolicy: {
        forbidSelfReferral: true,
        requireIdentityLinkageChecks: true,
        velocity: { maxContributions: 100n, windowMs: 600_000n },
      },
      clawbackPolicy: { clawbackWindowMs: 2_592_000_000n, requiresDisputeRecord: false },
      ...overrides,
    },
    'ACTIVE',
  );
}

/** The goal id used across campaign tests. */
export function testGoalId(): ReturnType<typeof asParticipationGoalId> {
  return asParticipationGoalId('goal_campaigns_test');
}

export function evidence(kind: string, locator: string, level: ProofLevel): EvidenceReference {
  return { kind, locator, level };
}

/** Minimal anti-gaming inputs (clean: no links, no surfaces). */
export function cleanInputs(observedParticipation: bigint): {
  readonly identityLinks: readonly never[];
  readonly declaredSurfaces: readonly never[];
  readonly observedParticipation: bigint;
} {
  return { identityLinks: [], declaredSurfaces: [], observedParticipation };
}

export interface ContributionSpec {
  readonly id: string;
  readonly actor: string;
  readonly actorRole?: ContributionRecord['actorRole'];
  readonly behavior?: string;
  readonly quantity?: bigint;
  readonly value?: Money;
  readonly occurredAt?: TimestampMs;
  readonly outcome?: ContributionRecord['outcome'];
  readonly counterparty?: string;
  readonly programVersion?: ProgramVersionRef;
  readonly evidenceLevel?: ProofLevel;
}

/**
 * A minimal qualifying contribution: P2 rail evidence, direct attribution,
 * VERIFIED_COMPLETED outcome. Everything overridable per test.
 */
export function contribution(spec: ContributionSpec): ContributionRecord {
  const actorRole = spec.actorRole ?? 'SENDER';
  const refs: readonly EvidenceReference[] = [
    evidence('rail_receipt', `evd:${spec.id}:receipt`, spec.evidenceLevel ?? 'P2'),
  ];
  const attribution = {
    attributedActor: spec.actor as ContributionRecord['attribution']['attributedActor'],
    creditedRole: actorRole,
    basis: 'DIRECT_EVIDENCE' as const,
    evidenceRefs: refs.map((reference) => reference.locator),
    decisionTrace: [
      {
        ruleId: 'direct:participant',
        matched: true,
        note: 'direct participation evidence matched',
      },
    ],
  };
  const record: {
    -readonly [K in keyof ContributionRecord]: ContributionRecord[K];
  } = {
    id: spec.id as ContributionRecord['id'],
    actor: spec.actor as ContributionRecord['actor'],
    actorRole,
    behavior: spec.behavior ?? 'PAYMENT_METHOD_ADOPTED',
    affectedObjects: [{ objectType: 'payment_intent', objectId: `pi_${spec.id}` }],
    quantity: spec.quantity ?? 1n,
    occurredAt: spec.occurredAt ?? T0,
    outcome: spec.outcome ?? 'VERIFIED_COMPLETED',
    evidence: refs,
    attribution,
  };
  if (spec.value !== undefined) record.value = spec.value;
  if (spec.counterparty !== undefined) {
    record.counterparty = asPartyId(spec.counterparty);
  }
  if (spec.programVersion !== undefined) record.programVersion = spec.programVersion;
  return Object.freeze(record);
}

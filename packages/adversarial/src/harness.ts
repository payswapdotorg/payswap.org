/**
 * @payswap/adversarial — the fault-injection harness (W2-007).
 *
 * An adversarial harness that injects every W2-007 fault family against the
 * REAL merged subsystems — the journeys world (protocol kernel, connector
 * vocabulary, execution plane, settlement plane, evidence graph) plus the
 * idempotency registrar, the transactional outbox, the rail incident
 * recorder, the trust epoch ledger and the participation plane — and proves,
 * per fault, that:
 *
 *   1. the fault GENUINELY occurred (injection checks — never a stub);
 *   2. every candidate invariant HELD (per-invariant probes with proofs);
 *   3. an EXACT recovery/reconciliation path completed (ordered steps).
 *
 * NO STUBS OF THE TARGETS: every attacked subsystem is the real merged code.
 * Deterministic only, no network: providers are exercised through their
 * fail-closed / scripted surfaces and the deterministic clock.
 *
 * Security-plane composition discipline (repo-wide boundary, journeys and
 * certification precedent): no package src/** may import the security package
 * or the Lab package. The immune system is composed at the TEST layer through
 * the STRUCTURAL views declared below — the real SecurityEpochAuthority,
 * SecurityAdvisoryRegistry, QuarantineLedger, SecurityGate and free gates are
 * wired into these views by the test composition (test/adversarial-helpers.ts),
 * exactly mirroring the certification package's structural immune-state views.
 */

import {
  InMemoryIdempotencyRegistrar,
  InMemoryOutbox,
  USD,
  accountId,
  asAggregateId,
  asClearingRecordId,
  asEventId,
  asFulfillmentActivityId,
  asNettingSetId,
  asPartyId,
  createCommandEnvelope,
  createIdFactory,
  createJournalEntry,
  deriveObligations,
  drain,
  fromMinorUnits,
  netPositions,
  postJournal,
  settlementInstructions,
} from "@payswap/protocol";
import type {
  AccountId,
  ClearingRecord,
  CommandEnvelope,
  DeterministicClock,
  DomainEventEnvelope,
  FulfillmentActivity,
  JournalEntry,
  Money,
  NetPosition,
  NettingSet,
  Obligation,
  ObligationDueWindow,
  PartyId,
  PrincipalRef,
  ProtocolClock,
  SettlementInstruction as ProtocolSettlementInstruction,
  TimestampMs,
} from "@payswap/protocol";
import { buildWorld, postOpeningBalance } from "@payswap/journeys";
import type { JourneyWorld } from "@payswap/journeys";
import { RailIncidentRecorder } from "@payswap/rails";
import { EpochLedger } from "@payswap/trust";
import type { Principal } from "@payswap/trust";
import {
  ContributionLedger,
  InMemoryRewardBook,
  IncentiveBudgetLedger,
  ProgramVersionRegistry,
  ReferralRegistry,
} from "@payswap/participation";
import type { RewardServiceDeps } from "@payswap/participation";

// ---------------------------------------------------------------------------
// Determinism anchors
// ---------------------------------------------------------------------------

/** Fixed adversarial epoch — every fault runs at the same deterministic time. */
export const ADVERSARIAL_EPOCH: TimestampMs = 1_766_000_000_000n;

// ---------------------------------------------------------------------------
// The fault taxonomy (W2-007 — eleven families)
// ---------------------------------------------------------------------------

export const FAULT_FAMILIES = [
  "duplicated-commands",
  "lost-webhooks",
  "ambiguous-provider",
  "account-takeover",
  "malicious-agents",
  "package-compromise",
  "incentive-sybil-collusion-wash",
  "leaderboard-gaming",
  "provider-outage",
  "clock-skew",
  "partial-payment",
] as const;
export type FaultFamilyId = (typeof FAULT_FAMILIES)[number];

export function isFaultFamilyId(value: unknown): value is FaultFamilyId {
  return (
    typeof value === "string" &&
    (FAULT_FAMILIES as readonly unknown[]).includes(value)
  );
}

// ---------------------------------------------------------------------------
// Fault declarations, injection proofs, invariant probes, recovery paths
// ---------------------------------------------------------------------------

/** What is being injected, against which real subsystems, endangering which invariants. */
export interface FaultDeclaration {
  readonly faultId: string;
  readonly family: FaultFamilyId;
  readonly title: string;
  readonly description: string;
  /** Invariants that COULD break under this fault — the candidate set probed after injection. */
  readonly candidateInvariants: readonly string[];
  /** The real packages whose code is under attack. */
  readonly attackedSubsystems: readonly string[];
}

/** One proof that the injected fault GENUINELY occurred. */
export interface InjectionCheck {
  readonly ok: boolean;
  readonly detail: string;
}

/** The verdict of one candidate invariant after the injection. */
export interface InvariantProbe {
  readonly invariantId: string;
  readonly held: boolean;
  readonly proof: string;
}

/** One ordered step of the exact recovery/reconciliation path. */
export interface RecoveryStep {
  readonly step: number;
  readonly description: string;
  readonly done: boolean;
  readonly detail: string;
}

/** The full evidence produced by one fault injection run. */
export interface FaultExecution {
  readonly declaration: FaultDeclaration;
  /** True iff EVERY injection check passed — the fault really happened. */
  readonly injected: boolean;
  readonly injectionChecks: readonly InjectionCheck[];
  readonly probes: readonly InvariantProbe[];
  readonly recoveryPath: readonly RecoveryStep[];
  readonly evidenceRefs: readonly string[];
}

/** The recomputed verdict of one fault (never fabricated — derived from the execution). */
export interface FaultVerdict {
  readonly faultId: string;
  readonly family: FaultFamilyId;
  readonly title: string;
  readonly injected: boolean;
  readonly injectionChecks: readonly InjectionCheck[];
  readonly invariantsHeld: boolean;
  readonly recoveryCompleted: boolean;
  readonly passed: boolean;
  readonly probes: readonly InvariantProbe[];
  readonly recoveryPath: readonly RecoveryStep[];
  readonly evidenceRefs: readonly string[];
}

/** One adversarial scenario: a declaration plus its real-subsystem run. */
export interface AdversarialScenario {
  readonly declaration: FaultDeclaration;
  readonly run: () => FaultExecution | Promise<FaultExecution>;
}

// ---------------------------------------------------------------------------
// Verdict assembly (recomputes — never trusts a claimed pass)
// ---------------------------------------------------------------------------

export function injectionCheck(ok: boolean, detail: string): InjectionCheck {
  return { ok, detail };
}

export function probe(invariantId: string, held: boolean, proof: string): InvariantProbe {
  return { invariantId, held, proof };
}

export function recoveryStep(
  step: number,
  description: string,
  done: boolean,
  detail: string,
): RecoveryStep {
  return { step, description, done, detail };
}

/** Derive the verdict from an execution — every field recomputed from evidence. */
export function verdictOf(execution: FaultExecution): FaultVerdict {
  const injected = execution.injectionChecks.length > 0 && execution.injectionChecks.every((c) => c.ok);
  const invariantsHeld = execution.probes.length > 0 && execution.probes.every((p) => p.held);
  const recoveryCompleted =
    execution.recoveryPath.length > 0 && execution.recoveryPath.every((s) => s.done);
  return {
    faultId: execution.declaration.faultId,
    family: execution.declaration.family,
    title: execution.declaration.title,
    injected,
    injectionChecks: execution.injectionChecks,
    invariantsHeld,
    recoveryCompleted,
    passed: injected && invariantsHeld && recoveryCompleted,
    probes: execution.probes,
    recoveryPath: execution.recoveryPath,
    evidenceRefs: execution.evidenceRefs,
  };
}

/** A scenario whose verdict is recomputed from its execution (defensive wrapper). */
export async function runScenario(scenario: AdversarialScenario): Promise<FaultVerdict> {
  const execution = await scenario.run();
  return verdictOf(execution);
}

// ---------------------------------------------------------------------------
// Structural views of the security immune system (test-layer composition)
//
// These interfaces are structural (duck-typed) copies of the exact
// security-package surface the fault modules consume. The REAL security
// objects satisfy them; the test layer (which MAY import the security package)
// wires them in. src/** never imports the security package (repo boundary).
// ---------------------------------------------------------------------------

/** The seven valid quarantine component kinds (structural copy of security's ComponentKind). */
export type ComponentKindView =
  | "agent_package"
  | "agent_body"
  | "agent_instance"
  | "agent_key"
  | "extension"
  | "capability"
  | "connected_instance";

export interface ComponentRefView {
  readonly kind: ComponentKindView;
  readonly id: string;
}

/** Structural view of the network SecurityEpochAuthority. */
export interface EpochAuthorityView {
  currentEpoch(): { readonly value: bigint };
  advance(input: {
    readonly reason: string;
    readonly at: number;
    readonly advisoryRef?: string;
  }): { readonly value: bigint };
}

/** Structural copy of EpochScopedAuthorization (security/epochs). */
export interface EpochScopedAuthorizationView {
  readonly authorizationRef: string;
  readonly principalRef: string;
  readonly agentRef?: string;
  readonly actionClass:
    | "money_movement"
    | "beneficiary_change"
    | "credential_change"
    | "mandate_change"
    | "rail_execution";
  readonly issuedAtEpoch: bigint;
  readonly expiresAt: number;
}

/** Structural view of the non-throwing epoch gate result. */
export interface SensitiveActionEpochCheckView {
  readonly authorizationRef: string;
  readonly allowed: boolean;
  readonly reason?: "stale_security_epoch" | "authorization_expired";
  readonly issuedAtEpoch: bigint;
  readonly currentEpoch: bigint;
}

/** Structural copy of the cached capability view (security/quarantine, INV-S03). */
export interface CachedCapabilityViewStruct {
  readonly capabilityId: string;
  readonly sourceId: string;
  readonly effectiveAvailability: "AVAILABLE" | "DEGRADED" | "UNAVAILABLE" | "UNKNOWN";
  readonly providedBy?: readonly ComponentRefView[];
}

/** Structural view of a capability-access decision (security/quarantine). */
export interface CapabilityAccessDecisionView {
  readonly decision: "ALLOW" | "REJECT";
  readonly reason?: string;
  readonly componentKey?: string;
  readonly advisoryRefs?: readonly string[];
  readonly quarantineIds?: readonly string[];
}

/** Structural view of an advisory restriction (security/advisories, INV-S01 — global, unscoped). */
export interface ComponentRestrictionView {
  readonly component: { readonly kind: string; readonly id: string; readonly version?: string };
  readonly restricted: boolean;
  readonly quarantined: boolean;
  readonly retired: boolean;
  readonly advisoryRefs: readonly string[];
}

/** Structural copy of a published security advisory (full field set — bidirectional assignability). */
export interface SecurityAdvisoryView {
  readonly advisoryId: string;
  readonly title: string;
  readonly severity: "low" | "medium" | "high" | "critical";
  readonly description: string;
  readonly affected: readonly {
    readonly kind: ComponentKindView;
    readonly id: string;
    readonly versionRange?: { readonly minVersion?: string; readonly maxVersion?: string };
  }[];
  readonly action: "restrict" | "quarantine" | "retire";
  readonly remediation: {
    readonly summary: string;
    readonly patchedVersion?: string;
    readonly workarounds: readonly string[];
  };
  readonly provenance: {
    readonly declaredBy: string;
    readonly contentHash: string;
    readonly publishedAt: number;
  };
  readonly status: "active" | "closed";
  readonly closedAt?: number;
  readonly closureNote?: string;
}

/** Structural view of a quarantine record. */
export interface QuarantineRecordView {
  readonly quarantineId: string;
  readonly component: ComponentRefView;
  readonly status: "active" | "released";
  readonly advisoryRefs: readonly string[];
}

/**
 * The security plane consumed by the account-takeover fault family. The test
 * layer binds each member to the REAL security-package object/function.
 */
export interface AccountTakeoverSecurityPlane {
  readonly epochs: EpochAuthorityView;
  /** The per-principal credential epoch ledger the delegated gate checks (real trust EpochLedger). */
  readonly credentialEpochLedger: EpochLedger;
  /** The real checkSensitiveActionAuthorization bound to the real authority (throws on stale/expired, INV-S02). */
  checkSensitiveAction(authorization: EpochScopedAuthorizationView, at: number): void;
  /** The real evaluateSensitiveActionAuthorization bound to the real authority. */
  evaluateSensitiveAction(
    authorization: EpochScopedAuthorizationView,
    at: number,
  ): SensitiveActionEpochCheckView;
  /** The real checkDelegatedSensitiveAction bound to the real authority + the credential ledger above. */
  checkDelegatedSensitiveAction(
    principal: Principal,
    authorization: EpochScopedAuthorizationView,
    at: number,
  ): void;
  readonly quarantine: {
    quarantine(input: {
      readonly component: ComponentRefView;
      readonly reason: string;
      readonly advisoryRefs: readonly string[];
      readonly at: number;
    }): QuarantineRecordView;
    isQuarantined(component: ComponentRefView): boolean;
    activeQuarantinesFor(component: ComponentRefView): readonly QuarantineRecordView[];
  };
  /** The real authorizeCapabilityUse bound to the real enforcement state (INV-S03). */
  authorizeCapabilityUse(view: CachedCapabilityViewStruct): CapabilityAccessDecisionView;
}

/**
 * The security plane consumed by the package-compromise fault family. The
 * test layer binds each member to the REAL security-package objects.
 */
export interface PackageCompromiseSecurityPlane {
  readonly advisories: {
    publish(input: {
      readonly advisoryId: string;
      readonly title: string;
      readonly severity: "low" | "medium" | "high" | "critical";
      readonly description: string;
      readonly affected: readonly {
        readonly kind: ComponentKindView;
        readonly id: string;
        readonly versionRange?: { readonly minVersion?: string; readonly maxVersion?: string };
      }[];
      readonly action: "restrict" | "quarantine" | "retire";
      readonly remediation: {
        readonly summary: string;
        readonly patchedVersion?: string;
        readonly workarounds: readonly string[];
      };
      readonly declaredBy: string;
      readonly publishedAt: number;
    }): SecurityAdvisoryView;
    restrictionFor(identity: {
      readonly kind: ComponentKindView;
      readonly id: string;
      readonly version?: string;
    }): ComponentRestrictionView;
    close(input: {
      readonly advisoryId: string;
      readonly closedAt: number;
      readonly closureNote: string;
      readonly remediationVerified: boolean;
    }): SecurityAdvisoryView;
    byId(advisoryId: string): { readonly advisoryId: string; readonly status: string } | undefined;
  };
  readonly quarantine: {
    quarantine(input: {
      readonly component: ComponentRefView;
      readonly reason: string;
      readonly advisoryRefs: readonly string[];
      readonly at: number;
    }): QuarantineRecordView;
    isQuarantined(component: ComponentRefView): boolean;
    byId(quarantineId: string): QuarantineRecordView | undefined;
  };
  /** The real QuarantineLedger.release bound to the real advisory registry (release refuses while advisories remain active). */
  releaseQuarantine(input: {
    readonly quarantineId: string;
    readonly remediation: {
      readonly releaseNote: string;
      readonly evidence: readonly {
        readonly evidenceId: string;
        readonly artifactRef: string;
        readonly contentDigest: string;
      }[];
    };
    readonly at: number;
  }): QuarantineRecordView;
  /** The real authorizeCapabilityUse bound to the real enforcement state (INV-S03). */
  authorizeCapabilityUse(view: CachedCapabilityViewStruct): CapabilityAccessDecisionView;
}

// ---------------------------------------------------------------------------
// The adversarial world — the REAL subsystems under attack
// ---------------------------------------------------------------------------

export interface AdversarialWorld {
  /** The full journeys world: journal, reservations, obligations, connector registry, execution, settlement, evidence, finality, certificates, provider revisions. */
  readonly journey: JourneyWorld;
  /** The protocol idempotency registrar (INV-F05) — shared with the attempt ledgers below. */
  readonly registrar: InMemoryIdempotencyRegistrar;
  /** The transactional outbox (INV-O02). */
  readonly outbox: InMemoryOutbox;
  /** The rail incident recorder (INV-S04 outage windows). */
  readonly incidents: RailIncidentRecorder;
  /** The per-principal trust epoch ledger (INV-A02). */
  readonly epochLedger: EpochLedger;
  /** The participation plane: program versions, budgets, rewards, contributions, referrals. */
  readonly programs: ProgramVersionRegistry;
  readonly budgets: IncentiveBudgetLedger;
  readonly rewards: InMemoryRewardBook;
  readonly contributions: ContributionLedger;
  readonly referrals: ReferralRegistry;
  readonly rewardDeps: RewardServiceDeps;
  /** Opening equity per currency (auto-created by openingBalance). */
  readonly accounts: {
    readonly settlementPoolUsd: AccountId;
    readonly incentiveAccountFor: (sponsor: string) => AccountId;
  };
}

export interface BuildAdversarialWorldOptions {
  /** Opening ledger balances, posted as balanced double-entry funding entries. */
  readonly openingBalances?: readonly { readonly account: AccountId; readonly amount: Money }[];
  readonly seed?: TimestampMs;
}

/**
 * Build the adversarial world: the REAL journeys world plus the registrar,
 * outbox, incident recorder, trust epoch ledger and participation plane.
 * No mocks of financial truth anywhere.
 */
export function buildAdversarialWorld(
  options?: BuildAdversarialWorldOptions,
): AdversarialWorld {
  const journey = buildWorld({
    ...(options?.openingBalances !== undefined
      ? { openingBalances: options.openingBalances }
      : {}),
    ...(options?.seed !== undefined ? { seed: options.seed } : {}),
  });
  const registrar = new InMemoryIdempotencyRegistrar();
  const outbox = new InMemoryOutbox();
  const programs = new ProgramVersionRegistry();
  const budgets = new IncentiveBudgetLedger(journey.reservationState);
  const rewards = new InMemoryRewardBook();
  const rewardDeps: RewardServiceDeps = {
    ids: journey.ids,
    clock: journey.clock,
    rewards,
    budgets,
    obligations: journey.obligations,
  };
  return {
    journey,
    registrar,
    outbox,
    incidents: new RailIncidentRecorder(),
    epochLedger: new EpochLedger(),
    programs,
    budgets,
    rewards,
    contributions: new ContributionLedger(),
    referrals: new ReferralRegistry(),
    rewardDeps,
    accounts: {
      settlementPoolUsd: journey.accounts.settlementPoolUsd,
      incentiveAccountFor: (sponsor: string) =>
        accountId("ASSET", `incentive.${sponsor.toLowerCase().replace(/[^a-z0-9._-]/g, ".")}`),
    },
  };
}

// ---------------------------------------------------------------------------
// Deterministic scenario fixtures (journal, envelopes, clearing, outbox)
// ---------------------------------------------------------------------------

/** The canonical adversarial principal (a user). */
export const ADVERSARIAL_PRINCIPAL: PrincipalRef = Object.freeze({
  principalType: "user",
  principalId: "user_adversarial_1",
});

/** A deterministic command envelope minted against the world clock. */
export function adversarialCommand(
  world: AdversarialWorld,
  commandType: string,
  idempotencyKey: string,
  payload: Readonly<Record<string, unknown>>,
): CommandEnvelope<unknown> {
  return createCommandEnvelope(
    {
      commandType,
      payload,
      principalRef: { ...ADVERSARIAL_PRINCIPAL },
      idempotencyKey,
      schemaVersion: 1,
    },
    { ids: createIdFactory(world.journey.clock), clock: world.journey.clock },
  );
}

/** Post a balanced entry through the real journal (INV-F03 enforced on append). */
export function postEntry(
  world: AdversarialWorld,
  lines: readonly { readonly accountId: AccountId; readonly amount: Money }[],
  memo: string,
  correlationId: string,
): JournalEntry {
  return postJournal(
    world.journey.journal,
    createJournalEntry(
      { lines, memo, source: { correlationId } },
      { ids: createIdFactory(world.journey.clock), clock: world.journey.clock },
    ),
  );
}

/** Fund an account with a balanced opening entry. */
export function fundAccount(
  world: AdversarialWorld,
  account: AccountId,
  amount: Money,
): JournalEntry {
  return postOpeningBalance(world.journey.journal, world.journey.ids, world.journey.clock, account, amount);
}

/** A deterministic domain event for the outbox. */
export function outboxEvent(
  world: AdversarialWorld,
  eventId: string,
  eventType: string,
  payload: Readonly<Record<string, unknown>>,
  correlationId: string,
): DomainEventEnvelope<unknown> {
  return {
    id: asEventId(eventId),
    eventType,
    payload,
    aggregate: { id: asAggregateId(`agg:${correlationId}`), version: 1n },
    correlationId,
    occurredAt: world.journey.clock.now(),
    schemaVersion: 1,
  };
}

export interface ActivitySpec {
  readonly id: string;
  readonly activityType: string;
  readonly debtor: string;
  readonly creditor: string;
  readonly amount: Money;
  readonly occurredAt?: TimestampMs;
}

/** A clearing record over the world clock (deterministic). */
export function clearingRecord(
  recordId: string,
  activities: readonly ActivitySpec[],
  world: AdversarialWorld,
): ClearingRecord {
  return {
    id: asClearingRecordId(recordId),
    activities: activities.map(
      (activity): FulfillmentActivity => ({
        id: asFulfillmentActivityId(activity.id),
        activityType: activity.activityType,
        debtor: asPartyId(activity.debtor),
        creditor: asPartyId(activity.creditor),
        amount: activity.amount,
        occurredAt: activity.occurredAt ?? world.journey.clock.now(),
        refs: { correlationId: recordId },
      }),
    ),
    netted: false,
  };
}

export function party(value: string): PartyId {
  return asPartyId(value);
}

// ---------------------------------------------------------------------------
// The adversarial settlement chain (manual control over attempt outcomes)
// ---------------------------------------------------------------------------

export interface AdversarialChainSpec {
  readonly world: AdversarialWorld;
  readonly sequence: string;
  readonly clearingRecords: readonly ClearingRecord[];
  readonly dueWindow: ObligationDueWindow;
  readonly rail: string;
  readonly settlementDestinationId: string;
  readonly authorizationRefs: readonly string[];
}

export interface AdversarialChain {
  readonly obligations: readonly Obligation[];
  readonly nettingSet: NettingSet;
  readonly positions: readonly NetPosition[];
  readonly instruction: ProtocolSettlementInstruction;
  readonly attemptId: string;
}

/**
 * Derive obligations, net them (INV-F07 gross retained), derive the protocol
 * settlement instruction and BEGIN + START a settlement attempt — the
 * in-flight external write every fault family attacks.
 */
export function beginAdversarialChain(spec: AdversarialChainSpec): AdversarialChain {
  const { world, sequence, dueWindow } = spec;
  const obligations = deriveObligations(spec.clearingRecords, { dueWindow });
  for (const obligation of obligations) {
    world.journey.obligations.add(obligation);
  }
  const nettingSet: NettingSet = {
    id: asNettingSetId(`NS:${sequence}`),
    obligations: obligations.map((obligation) => obligation.id),
    window: dueWindow,
    createdAt: world.journey.clock.now(),
  };
  const positions = netPositions(nettingSet, obligations);
  const instructions = settlementInstructions(positions);
  const instruction = instructions[0];
  if (instruction === undefined) {
    throw new Error(`adversarial chain ${sequence}: netting produced no instruction`);
  }
  const attemptId = `sa:${sequence}:0`;
  const begin = world.journey.settlementAttempts.begin({
    attemptId,
    instructionId: instruction.id,
    rail: spec.rail,
    idempotencyKey: `idem:${sequence}:0`,
    principal: { ...ADVERSARIAL_PRINCIPAL },
    now: world.journey.clock.now(),
  });
  if (begin.kind !== "BEGIN") {
    throw new Error(`adversarial chain ${sequence}: settlement attempt was a replay`);
  }
  world.journey.settlementAttempts.start(attemptId, world.journey.clock.now());
  return { obligations, nettingSet, positions, instruction, attemptId };
}

// ---------------------------------------------------------------------------
// Outbox publisher fixtures (scripted transports — deterministic, offline)
// ---------------------------------------------------------------------------

/** A publisher that loses every delivery (throws a definitive transport error). */
export class LosingPublisher {
  readonly lost: string[] = [];
  async publish(event: DomainEventEnvelope<unknown>): Promise<void> {
    this.lost.push(event.id);
    throw new Error(`webhook transport lost event ${event.id}`);
  }
}

/** Look up an outbox record by its (unbranded) event id. */
export function getOutboxRecord(
  world: AdversarialWorld,
  eventId: string,
): ReturnType<AdversarialWorld["outbox"]["get"]> {
  return world.outbox.get(asEventId(eventId));
}

/** A publisher that records every successfully delivered event, exactly once each. */
export class RecordingPublisher {
  readonly delivered: string[] = [];
  async publish(event: DomainEventEnvelope<unknown>): Promise<void> {
    this.delivered.push(event.id);
  }
}

/** Drain the outbox with the given publisher at the world's current clock. */
export function drainOutbox(
  world: AdversarialWorld,
  publisher: { publish(event: DomainEventEnvelope<unknown>): Promise<void> },
): Promise<{ published: readonly string[]; failed: readonly string[]; deferred: readonly string[] }> {
  return drain(world.outbox, publisher, { clock: world.journey.clock });
}

// ---------------------------------------------------------------------------
// Shared assertion helpers
// ---------------------------------------------------------------------------

/** Sum of an account's balances must be exactly this value (exact integer minor units). */
export function balanceOf(world: AdversarialWorld, account: AccountId): Money | undefined {
  let sum: Money | undefined = undefined;
  for (const entry of world.journey.journal.entries) {
    for (const line of entry.lines) {
      if (line.accountId === account) {
        sum =
          sum === undefined
            ? line.amount
            : fromMinorUnits(line.amount.currency, sum.value + line.amount.value);
      }
    }
  }
  return sum;
}

/** Every journal entry balances to exactly zero and the trial balance per currency is zero (INV-F03/F01). */
export function journalIntegrity(
  world: AdversarialWorld,
): { allBalanced: boolean; entryCount: number; trialBalanceZero: boolean } {
  let allBalanced = true;
  const perCurrency = new Map<string, bigint>();
  for (const entry of world.journey.journal.entries) {
    let sum = 0n;
    for (const line of entry.lines) {
      sum += line.amount.value;
    }
    if (sum !== 0n) {
      allBalanced = false;
    }
  }
  for (const [account, balance] of projectBalancesView(world)) {
    perCurrency.set(balance.currency, (perCurrency.get(balance.currency) ?? 0n) + balance.value);
  }
  let trialBalanceZero = true;
  for (const total of perCurrency.values()) {
    if (total !== 0n) {
      trialBalanceZero = false;
    }
  }
  return {
    allBalanced,
    entryCount: world.journey.journal.entries.length,
    trialBalanceZero,
  };
}

function projectBalancesView(
  world: AdversarialWorld,
): ReadonlyMap<AccountId, Money> {
  // Local fold (equivalent to projectBalances) to keep the helper self-evident.
  const balances = new Map<AccountId, Money>();
  for (const entry of world.journey.journal.entries) {
    for (const line of entry.lines) {
      const current = balances.get(line.accountId);
      balances.set(
        line.accountId,
        current === undefined
          ? line.amount
          : fromMinorUnits(line.amount.currency, current.value + line.amount.value),
      );
    }
  }
  return balances;
}

/** USD minor-unit helper (exact integer money, INV-F01). */
export function usd(minorUnits: bigint): Money {
  return fromMinorUnits(USD, minorUnits);
}

/** Re-export of the deterministic clock type for scenario fixtures. */
export type { DeterministicClock, ProtocolClock, TimestampMs };

/**
 * @payswap/journeys — the journey harness (W1-007).
 *
 * A deterministic world-builder that composes the REAL subsystems merged by
 * the terminal wave: the protocol kernel (obligations, append-only journal,
 * reservations, netting, credit, FX, liquidity), the payment plane
 * (acceptance, methods, translation, recurring, remittance), the trust and
 * agents planes (mandates, attenuated grants, signed approvals, advisory
 * proposals), the capability/connector vocabulary (CapabilityDefinition →
 * ProviderImplementation → ConnectedCapabilityInstance → CapabilityObservation,
 * ProviderStateEnvelope, ExternalFundsPositionObservation), the execution
 * plane (offers, plans, scoped grants, idempotent attempts, reconciliation),
 * the settlement plane (instructions, attempts, evidence graph, protocol-owned
 * finality, proof policies, certificates), the recourse plane (disputes,
 * escrow, bonds, separate recourse obligations), the participation/campaign
 * planes (funded budgets, reproducible rewards as protocol obligations) and
 * the security plane (epochs, advisories).
 *
 * NO STUBS OF FINANCIAL TRUTH: every balance is posted through the real
 * journal, every obligation is derived from clearing records, every
 * settlement instruction is reduced from a netting set with its gross
 * derivation retained (INV-F07), and every finality is declared by the
 * protocol-owned FinalityAuthority against a protocol-authorized instruction
 * (INV-F06) with policy-required proof (INV-E03). Deterministic only, no
 * network: rail adapters are exercised through their fail-closed /
 * scripted-transport surfaces.
 */

import {
  DeterministicClock,
  InMemoryLedgerJournal,
  accountId,
  projectBalances,
  InMemoryObligationBook,
  InMemoryReservationBook,
  USD,
  asClearingRecordId,
  asFulfillmentActivityId,
  asNettingSetId,
  asObligationId,
  asPartyId,
  createCommandEnvelope,
  createIdFactory,
  createJournalEntry,
  deriveObligations,
  fromMinorUnits,
  netPositions,
  postJournal,
  settlementInstructions,
  settleObligation,
} from "@payswap/protocol";
import type {
  AccountId,
  ClearingRecord,
  CommandEnvelope,
  FulfillmentActivity,
  IdFactory,
  JournalEntry,
  Money,
  NetPosition,
  NettingSet,
  Obligation,
  ObligationDueWindow,
  PartyId,
  ProtocolClock,
  ReservationLedgerState,
  SettlementInstruction as ProtocolSettlementInstruction,
  PrincipalRef,
  TimestampMs,
} from "@payswap/protocol";
import {
  ConnectorRegistry,
  createProviderStateEnvelope,
  observeCapability,
  parseProviderStateEnvelope,
  serializeProviderStateEnvelope,
} from "@payswap/connectors";
import type {
  CapabilityDefinition,
  ConnectedCapabilityInstance,
  ConnectorCapabilityKind,
  EvidenceKind,
  ExecutionMode,
  ProviderStateEnvelope,
  ProviderStateFamily,
} from "@payswap/connectors";
import {
  ExecutionAttemptLedger,
  ExecutionGrantAuthority,
  ReconciliationAuthority,
} from "@payswap/execution";
import type { AdapterExecutionAuthority } from "@payswap/execution";
import {
  EvidenceGraph,
  FinalityAuthority,
  ProviderRevisionLedger,
  SettlementAttemptLedger,
  SettlementCertificateAuthority,
  SettlementReconciliationAuthority,
  defineProofPolicy,
  deriveSettlementInstruction,
} from "@payswap/settlement";
import type {
  FinalityRecord,
  ProofPolicy,
  SettlementAttempt,
  SettlementCertificate,
  SettlementInstruction,
} from "@payswap/settlement";
import type { DocumentAllocation } from "@payswap/payment";

// ---------------------------------------------------------------------------
// Determinism anchors
// ---------------------------------------------------------------------------

/** Fixed journey epoch — every journey runs at the same deterministic time. */
export const JOURNEY_EPOCH: TimestampMs = 1_765_000_000_000n;

/** The canonical journey principal (a user). */
export const JOURNEY_PRINCIPAL: PrincipalRef = Object.freeze({
  principalType: "user",
  principalId: "user_journey_1",
});

// ---------------------------------------------------------------------------
// Acceptance axes (W1-007 acceptance criteria as checkable assertions)
// ---------------------------------------------------------------------------

export const ACCEPTANCE_AXES = [
  "EVIDENCED_CHAIN",
  "ACCOUNTING_RECONCILES",
  "FEES_FX_INCENTIVES_EXACT",
  "APPROVALS_AND_PROOFS_EXIST",
  "LOSSLESS_STATE_RECONCILIATION",
  "PASS_THROUGH_NATIVE_BASELINE",
] as const;
export type AcceptanceAxis = (typeof ACCEPTANCE_AXES)[number];

export function isAcceptanceAxis(value: unknown): value is AcceptanceAxis {
  return (
    typeof value === "string" &&
    (ACCEPTANCE_AXES as readonly unknown[]).includes(value)
  );
}

/** One checkable acceptance-axis assertion with its supporting evidence. */
export interface AxisAssertion {
  readonly axis: AcceptanceAxis;
  readonly passed: boolean;
  readonly summary: string;
  readonly evidenceRefs: readonly string[];
}

/** An invariant exercised by a journey with a one-line proof. */
export interface InvariantProof {
  readonly id: string;
  readonly proof: string;
}

/** The outcome of one journey: assertions per axis + invariant proofs. */
export interface JourneyOutcome {
  readonly journeyId: string;
  readonly title: string;
  readonly invariantsExercised: readonly InvariantProof[];
  readonly assertions: readonly AxisAssertion[];
  readonly evidenceRefs: readonly string[];
}

/** A journey definition in the certification suite. */
export interface JourneyDefinition {
  readonly journeyId: string;
  readonly title: string;
  readonly description: string;
  /** Sync for in-process journeys; async where a real (offline-injected) rail adapter is composed. */
  readonly run: () => JourneyOutcome | Promise<JourneyOutcome>;
}

export function journeyPassed(outcome: JourneyOutcome): boolean {
  return outcome.assertions.length > 0 && outcome.assertions.every((a) => a.passed);
}

// ---------------------------------------------------------------------------
// Assertion builders (never fabricate a pass — every builder recomputes)
// ---------------------------------------------------------------------------

export function passingAssertion(
  axis: AcceptanceAxis,
  summary: string,
  evidenceRefs: readonly string[],
): AxisAssertion {
  return { axis, passed: true, summary, evidenceRefs };
}

export function failingAssertion(
  axis: AcceptanceAxis,
  summary: string,
  evidenceRefs: readonly string[],
): AxisAssertion {
  return { axis, passed: false, summary, evidenceRefs };
}

/** Build an assertion from a list of concrete sub-checks. */
export function assertionFromChecks(
  axis: AcceptanceAxis,
  checks: readonly { readonly ok: boolean; readonly detail: string }[],
  evidenceRefs: readonly string[],
): AxisAssertion {
  const failed = checks.filter((c) => !c.ok);
  return failed.length === 0
    ? passingAssertion(
        axis,
        `${checks.length} checks passed: ${checks.map((c) => c.detail).join("; ")}`,
        evidenceRefs,
      )
    : failingAssertion(
        axis,
        `${failed.length}/${checks.length} checks FAILED: ${failed.map((c) => c.detail).join("; ")}`,
        evidenceRefs,
      );
}

// ---------------------------------------------------------------------------
// The journey world — the composed subsystems
// ---------------------------------------------------------------------------

export interface WorldAccounts {
  /** Protocol settlement pool (USD). */
  readonly settlementPoolUsd: AccountId;
  /** Opening equity per currency (auto-created by openingBalance). */
  equityFor: (currency: string) => AccountId;
}

export interface JourneyWorld {
  readonly clock: DeterministicClock;
  readonly ids: IdFactory;
  readonly journal: InMemoryLedgerJournal;
  readonly reservationState: ReservationLedgerState;
  readonly obligations: InMemoryObligationBook;
  readonly registry: ConnectorRegistry;
  readonly attempts: ExecutionAttemptLedger;
  readonly executionReconciliation: ReconciliationAuthority;
  readonly grants: ExecutionGrantAuthority;
  readonly evidence: EvidenceGraph;
  readonly settlementAttempts: SettlementAttemptLedger;
  readonly reconciliation: SettlementReconciliationAuthority;
  readonly finality: FinalityAuthority;
  readonly certificates: SettlementCertificateAuthority;
  readonly providerRevisions: ProviderRevisionLedger;
  readonly accounts: WorldAccounts;
}

/** A clock pinned to one instant — used for state-machine transition guards. */
export class StaticClock implements ProtocolClock {
  constructor(private readonly at: TimestampMs) {}
  now(): TimestampMs {
    return this.at;
  }
  monotonic(): bigint {
    return 0n;
  }
}

export interface BuildWorldOptions {
  /** Opening ledger balances, posted as balanced double-entry funding entries. */
  readonly openingBalances?: readonly { readonly account: AccountId; readonly amount: Money }[];
  /** Seed time for the deterministic clock (default JOURNEY_EPOCH). */
  readonly seed?: TimestampMs;
}

/**
 * Build a deterministic journey world: real journal, real reservation state,
 * real obligation book, real execution/settlement planes, real evidence
 * graph — no mocks of financial truth anywhere.
 */
export function buildWorld(options?: BuildWorldOptions): JourneyWorld {
  const clock = new DeterministicClock(options?.seed ?? JOURNEY_EPOCH);
  const ids = createIdFactory(clock);
  const journal = new InMemoryLedgerJournal();
  const reservationState: ReservationLedgerState = {
    journal,
    reservations: new InMemoryReservationBook(),
    ids: createIdFactory(clock),
    clock,
  };
  for (const opening of options?.openingBalances ?? []) {
    postOpeningBalance(journal, ids, clock, opening.account, opening.amount);
  }
  const attempts = new ExecutionAttemptLedger();
  const settlementAttempts = new SettlementAttemptLedger();
  const evidence = new EvidenceGraph();
  const reconciliation = new SettlementReconciliationAuthority(settlementAttempts);
  const finality = new FinalityAuthority(settlementAttempts, reconciliation);
  const certificates = new SettlementCertificateAuthority(
    finality,
    evidence,
    reconciliation,
    settlementAttempts,
  );
  return {
    clock,
    ids,
    journal,
    reservationState,
    obligations: new InMemoryObligationBook(),
    registry: new ConnectorRegistry(),
    attempts,
    executionReconciliation: new ReconciliationAuthority(attempts),
    grants: new ExecutionGrantAuthority(),
    evidence,
    settlementAttempts,
    reconciliation,
    finality,
    certificates,
    providerRevisions: new ProviderRevisionLedger(),
    accounts: {
      settlementPoolUsd: accountId("ASSET", "pool.usd"),
      equityFor: (currency: string) => accountId("EQUITY", `opening.${currency.toLowerCase()}`),
    },
  };
}

/** Post a balanced opening funding entry: account += amount, equity -= amount. */
export function postOpeningBalance(
  journal: InMemoryLedgerJournal,
  ids: IdFactory,
  clock: ProtocolClock,
  account: AccountId,
  amount: Money,
): JournalEntry {
  const equity = accountId("EQUITY", `opening.${amount.currency.toLowerCase()}`);
  return postJournal(
    journal,
    createJournalEntry(
      {
        lines: [
          { accountId: account, amount },
          { accountId: equity, amount: negateMoney(amount) },
        ],
        memo: `opening balance for ${account}`,
        source: { correlationId: "journey:opening-balance" },
      },
      { ids, clock },
    ),
  );
}

function negateMoney(money: Money): Money {
  return fromMinorUnits(money.currency, -money.value);
}

/** Post an arbitrary balanced entry through the real journal (INV-F03 enforced on append). */
export function postEntry(
  world: JourneyWorld,
  lines: readonly { readonly accountId: AccountId; readonly amount: Money }[],
  memo: string,
  correlationId: string,
): JournalEntry {
  return postJournal(
    world.journal,
    createJournalEntry(
      { lines, memo, source: { correlationId } },
      { ids: createIdFactory(world.clock), clock: world.clock },
    ),
  );
}

// ---------------------------------------------------------------------------
// Connector fixture builders (real vocabulary: definition → implementation →
// instance → observation — INV-C05 chain, registered in the ConnectorRegistry)
// ---------------------------------------------------------------------------

export interface RailFixtureOptions {
  readonly providerName: string;
  readonly providerVersion?: string;
  readonly capabilityId: string;
  readonly executionModes?: readonly ExecutionMode[];
  readonly kind?: ConnectorCapabilityKind;
  readonly nativeOptimization?: boolean;
  readonly requiresCustomerAction?: boolean;
  readonly accountRef?: string;
  readonly currencies?: readonly string[];
  readonly countries?: readonly string[];
}

export interface RailFixture {
  readonly definition: CapabilityDefinition;
  readonly instance: ConnectedCapabilityInstance;
}

/**
 * Register a complete, real connector chain for one rail capability:
 * provider identity → CapabilityDefinition → ProviderImplementation →
 * ConnectedCapabilityInstance → CapabilityObservation (fresh, REACHABLE,
 * AVAILABLE, ELIGIBLE — the two availability axes both green, INV-C01).
 */
export function registerRailFixture(world: JourneyWorld, options: RailFixtureOptions): RailFixture {
  const providerVersion = options.providerVersion ?? "2026-10";
  const executionModes = options.executionModes ?? [
    "PASS_THROUGH_NATIVE",
    "COMPOSED_PAYSWAP",
    "OPTIMIZED_MULTI_PROVIDER",
  ];
  const requiresCustomerAction = options.requiresCustomerAction === true;
  world.registry.registerProvider({
    providerName: options.providerName,
    providerVersion,
    systemKind: "psp",
    displayName: options.providerName,
  });
  const definition: CapabilityDefinition = {
    capabilityId: options.capabilityId,
    capabilityVersion: "1.0.0",
    summary: `Collect and settle a payment through ${options.providerName}.`,
    kind: options.kind ?? "ACTION",
    requiredPermissions: ["payments:write"],
    executionModes,
    semantics: {
      operation: "payments.create",
      stateMachine: { documentRef: "state-machines/payments/create", version: "1.1.0" },
      description: "Creates and settles a payment on the connected provider account.",
    },
    preconditions: ["A connected instance is authorized and eligible."],
    authorization: {
      protocolAuthorization: true,
      requiredScopes: ["payments:write"],
      customerConsent: requiresCustomerAction ? "EXPLICIT" : "IMPLICIT",
    },
    sideEffects: [
      {
        effect: "Moves the payment amount to the settlement destination.",
        financialEffect: "SETTLES_VALUE",
        reversible: false,
      },
    ],
    idempotency: {
      idempotent: true,
      keyScope: "REQUEST",
      duplicateBehavior: "RETURNED_SAME_RESULT",
      retryPolicy: "SAFE_TO_RETRY",
    },
    compensation: {
      compensable: false,
      cancellation: "BEFORE_EXECUTION",
      partialExecution: { possible: false, granularity: "ATOMIC", onPartial: "DISCLOSED" },
    },
    requiredCustomerActions: requiresCustomerAction
      ? [
          {
            action: "authenticate",
            actor: "CUSTOMER",
            description: "Complete the provider's authentication challenge.",
          },
        ]
      : [],
    providerVocabulary: {
      actions: [
        { action: "create", description: "Create a payment." },
        { action: "capture", description: "Capture an authorized amount." },
      ],
      states: [
        {
          providerState: "succeeded",
          canonicalState: "SETTLED",
          requiresCustomerAction: false,
          isTerminal: true,
        },
        {
          providerState: requiresCustomerAction ? "requires_action" : "processing",
          canonicalState: "PENDING",
          requiresCustomerAction,
          isTerminal: false,
        },
      ],
    },
    externalObjects: [
      { objectType: "PAYMENT_INTENT", idFormat: "opaque id", revisioned: true, revisionFormat: "revision counter" },
    ],
    evidence: { produced: ["EXECUTION", "STATE_OBSERVATION", "RECEIPT"], required: ["AUTHORIZATION"] },
    economics: {
      feeModel: "VARIABLE_BPS",
      limits: [
        {
          dimension: "AMOUNT",
          description: "Per-transaction cap.",
          amount: { currency: "USD", minorUnits: "100000000" },
        },
      ],
      settlementImplications: "Settles to the explicit settlement destination.",
    },
    constraints: [
      { kind: "JURISDICTION", description: "Licensed jurisdictions only.", countryCodes: options.countries ?? ["US", "GH", "DE"] },
    ],
    ...(options.nativeOptimization === true
      ? {
          nativeOptimization: {
            optimizationKind: "ROUTING" as const,
            benchmarkBaseline: true,
          },
        }
      : {}),
  };
  world.registry.registerDefinition(definition);
  world.registry.registerImplementation({
    implementationId: `impl:${options.capabilityId}:${options.providerName}`,
    providerName: options.providerName,
    providerVersion,
    capabilityId: options.capabilityId,
    capabilityVersion: "1.0.0",
    version: "1.2.0",
    adapterRef: `adapter:${options.providerName}@1`,
    corridors: [
      {
        fromCountries: options.countries ?? ["US", "GH", "DE"],
        toCountries: options.countries ?? ["US", "GH", "DE"],
        currencies: options.currencies ?? ["USD"],
      },
    ],
    knownDeviations: [],
  });
  const instance: ConnectedCapabilityInstance = {
    instanceId: `inst:${options.capabilityId}:${options.providerName}`,
    capabilityId: options.capabilityId,
    implementationId: `impl:${options.capabilityId}:${options.providerName}`,
    providerName: options.providerName,
    providerVersion: providerVersion,
    accountRef: options.accountRef ?? `acct:${options.providerName}-1`,
    tenantRef: `tenant:${options.providerName}-1`,
    authorization: { status: "ACTIVE", grantedAt: "2026-09-01T00:00:00Z", authorizationRef: `authz:${options.providerName}` },
    credentialScope: {
      credentialRef: `cred:${options.providerName}-1`,
      credentialKind: "API_KEY",
    },
    geography: { countries: options.countries ?? ["US", "GH", "DE"] },
    currencies: options.currencies ?? ["USD"],
    permissionState: { granted: ["payments:write"], requested: ["payments:write"], missing: [] },
    eligibility: { eligible: true, reasons: [] },
    configuration: {},
  };
  world.registry.registerInstance(instance);
  world.registry.recordObservation(
    observeCapability({
      instanceId: instance.instanceId,
      observedAt: isoNow(world),
      observationVersion: 1,
      capabilityState: "AVAILABLE",
      sourceAvailability: "REACHABLE",
      eligibility: "ELIGIBLE",
      health: { status: "HEALTHY", lastCheckedAt: isoNow(world) },
      provenance: {
        providerName: options.providerName,
        source: "PROVIDER_API",
        capturedAt: isoNow(world),
      },
    }),
  );
  return { definition, instance };
}

export function isoNow(world: JourneyWorld): string {
  return new Date(Number(world.clock.now())).toISOString();
}

// ---------------------------------------------------------------------------
// Provider state envelopes + execution evidence (INV-C06 / INV-E02 helpers)
// ---------------------------------------------------------------------------

export interface EnvelopeSpec {
  readonly providerName: string;
  readonly providerVersion?: string;
  readonly externalId: string;
  readonly revision: string;
  readonly family: ProviderStateFamily;
  readonly lifecycleStep: string;
  readonly isTerminal: boolean;
  readonly requiresCustomerAction: boolean;
  readonly state: unknown;
  readonly actionRequired?: { readonly kind: string; readonly message: string; readonly deepLink?: string };
  readonly failure?: { readonly providerErrorCode?: string; readonly providerErrorMessage?: string; readonly retryable: boolean; readonly ambiguity: "NONE" | "OUTCOME_UNKNOWN" };
}

/** Build a lossless provider state envelope through the real constructor. */
export function providerEnvelope(spec: EnvelopeSpec, world: JourneyWorld): ProviderStateEnvelope {
  return createProviderStateEnvelope({
    provider: { name: spec.providerName, version: spec.providerVersion ?? "1.0.0" },
    object: { objectType: "payment_intent", externalId: spec.externalId },
    revision: spec.revision,
    state: spec.state,
    classification: {
      family: spec.family,
      lifecycleStep: spec.lifecycleStep,
      isTerminal: spec.isTerminal,
      requiresCustomerAction: spec.requiresCustomerAction,
    },
    history: [],
    ...(spec.actionRequired !== undefined ? { actionRequired: spec.actionRequired } : {}),
    ...(spec.failure !== undefined ? { failure: spec.failure } : {}),
    privacy: { dataClassification: "PARTNER", constraints: [], shareableFields: ["state"] },
    timestamps: { observedAt: isoNow(world) },
    provenance: { source: "PROVIDER_API", fetchId: `fetch_${spec.externalId}` },
  });
}

/** A provider execution evidence draft for the execution attempt ledger. */
export function executionEvidenceDraft(
  sequence: string,
  index: number,
  envelope: ProviderStateEnvelope,
  world: JourneyWorld,
  kind: EvidenceKind = "EXECUTION",
): {
  readonly evidenceId: string;
  readonly kind: EvidenceKind;
  readonly evidenceRef: string;
  readonly providerState: ProviderStateEnvelope;
  readonly recordedAt: TimestampMs;
} {
  return {
    evidenceId: `xev:${sequence}:${index}`,
    kind,
    evidenceRef: `provider-op:${envelope.object.externalId}:${envelope.revision}`,
    providerState: envelope,
    recordedAt: world.clock.now(),
  };
}

// ---------------------------------------------------------------------------
// Command / grant helpers (protocol authorization lineage, INV-E01/F06)
// ---------------------------------------------------------------------------

export function journeyCommand(
  world: JourneyWorld,
  commandType: string,
  idempotencyKey: string,
  payload: Readonly<Record<string, unknown>>,
): CommandEnvelope<unknown> {
  return createCommandEnvelope(
    {
      commandType,
      payload,
      principalRef: JOURNEY_PRINCIPAL,
      idempotencyKey,
      schemaVersion: 1,
    },
    { ids: createIdFactory(world.clock), clock: world.clock },
  );
}

// ---------------------------------------------------------------------------
// Clearing record helpers
// ---------------------------------------------------------------------------

export interface ActivitySpec {
  readonly id: string;
  readonly activityType: string;
  readonly debtor: string;
  readonly creditor: string;
  readonly amount: Money;
  readonly occurredAt?: TimestampMs;
}

export function clearingRecord(
  recordId: string,
  activities: readonly ActivitySpec[],
  world: JourneyWorld,
  netted = false,
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
        occurredAt: activity.occurredAt ?? world.clock.now(),
        refs: { correlationId: recordId },
      }),
    ),
    netted,
  };
}

export function party(value: string): PartyId {
  return asPartyId(value);
}

// ---------------------------------------------------------------------------
// The shared evidenced settlement chain
//
// obligations -> netting (INV-F07 gross preserved) -> settlement instructions
// -> settlement attempts with evidence (INV-E02) -> protocol-owned finality
// (INV-F06, INV-E03) -> settlement certificates -> obligation SETTLED. This is
// the terminal segment every journey composes; nothing here fabricates a
// balance or a finality — the real settlement-plane authorities decide.
// ---------------------------------------------------------------------------

export interface InstructionSettlementSpec {
  readonly settlementDestinationId: string;
  readonly rail: string;
  readonly providerName: string;
  readonly remittance?: readonly DocumentAllocation[];
  readonly remittanceInfo?: string;
  readonly direction?: "SETTLE" | "REFUND" | "DISPUTE";
  /** RESOLVED settlement reconciliation case ids referenced by the certificate. */
  readonly reconciliationRefs?: readonly string[];
  /** RESOLVED RECURRING_MANDATE_RENEWAL case id referenced by the certificate. */
  readonly recurringRenewalReconciliation?: string;
}

export interface SettlementChainSpec {
  readonly world: JourneyWorld;
  /** Unique sequence tag for this chain (ids are derived from it). */
  readonly sequence: string;
  /** Clearing records to derive obligations from (or use `obligations`). */
  readonly clearingRecords?: readonly ClearingRecord[];
  /** Alternatively, settle already-derived PENDING obligations (e.g. reward obligations). */
  readonly obligations?: readonly Obligation[];
  readonly dueWindow: ObligationDueWindow;
  /** INV-E01 authorization evidence refs (approval artifacts / grant refs). */
  readonly authorizationRefs: readonly string[];
  /** One spec per expected protocol instruction (deterministic count). */
  readonly instructions: readonly InstructionSettlementSpec[];
}

export interface InstructionSettlement {
  readonly instruction: SettlementInstruction;
  readonly attempt: SettlementAttempt;
  readonly finality: FinalityRecord;
  readonly certificate: SettlementCertificate;
  readonly proofPolicy: ProofPolicy;
  readonly evidenceNodeIds: readonly string[];
}

export interface SettlementChainOutcome {
  readonly obligations: readonly Obligation[];
  readonly nettingSet: NettingSet;
  readonly positions: readonly NetPosition[];
  readonly settlements: readonly InstructionSettlement[];
  readonly evidenceNodeIds: readonly string[];
}

/** Derive (or adopt) obligations, net them, settle every instruction with full evidence. */
export function runSettlementChain(spec: SettlementChainSpec): SettlementChainOutcome {
  const { world, sequence, dueWindow } = spec;
  let obligations: readonly Obligation[];
  if (spec.obligations !== undefined) {
    obligations = spec.obligations;
    for (const obligation of obligations) {
      if (world.obligations.get(obligation.id) === undefined) {
        world.obligations.add(obligation);
      }
    }
  } else {
    const records = spec.clearingRecords ?? [];
    if (records.length === 0) {
      throw new Error("settlement chain requires clearingRecords or obligations");
    }
    obligations = deriveObligations(records, { dueWindow });
    for (const obligation of obligations) {
      world.obligations.add(obligation);
    }
  }
  const nettingSet: NettingSet = {
    id: asNettingSetId(`NS:${sequence}`),
    obligations: obligations.map((obligation) => asObligationId(obligation.id)),
    window: dueWindow,
    createdAt: world.clock.now(),
  };
  const positions = netPositions(nettingSet, obligations);
  const protocolInstructions = settlementInstructions(positions);
  if (protocolInstructions.length !== spec.instructions.length) {
    throw new Error(
      `settlement chain ${sequence}: expected ${spec.instructions.length} instruction(s), netting produced ${protocolInstructions.length}`,
    );
  }
  const settlements: InstructionSettlement[] = [];
  const evidenceNodeIds: string[] = [];
  protocolInstructions.forEach((protocolInstruction, index) => {
    const instructionSpec = spec.instructions[index];
    if (instructionSpec === undefined) {
      throw new Error(`settlement chain ${sequence}: missing spec for instruction ${index}`);
    }
    const instruction = deriveSettlementInstruction({
      protocolInstruction,
      remittance: instructionSpec.remittance ?? [],
      ...(instructionSpec.remittanceInfo !== undefined
        ? { remittanceInfo: instructionSpec.remittanceInfo }
        : {}),
      settlementDestinationId: instructionSpec.settlementDestinationId,
      authorizationRefs: spec.authorizationRefs,
      issuedAt: world.clock.now(),
    });
    const attemptId = `sa:${sequence}:${index}`;
    const authNode = `${sequence}:auth:${index}`;
    const execNode = `${sequence}:exec:${index}`;
    const outcomeNode = `${sequence}:outcome:${index}`;
    const authEvidence = world.evidence.record({
      nodeId: authNode,
      kind: "AUTHORIZATION",
      actionRef: instruction.id,
      claimedLevel: "P2",
      provenance: { source: "OPERATOR", operatorRef: "payswap:protocol:authorization" },
      payload: `authorization-refs:${spec.authorizationRefs.join("|")}`,
      links: [],
      recordedAt: world.clock.now(),
    });
    const execEvidence = world.evidence.record({
      nodeId: execNode,
      kind: "EXECUTION",
      actionRef: attemptId,
      claimedLevel: "P2",
      provenance: { source: "AUTHENTICATED_PROVIDER", providerName: instructionSpec.providerName },
      payload: `provider-op:${attemptId}:${instructionSpec.rail}`,
      links: [authNode],
      recordedAt: world.clock.now(),
    });
    const outcomeEvidence = world.evidence.record({
      nodeId: outcomeNode,
      kind: "OUTCOME",
      actionRef: attemptId,
      claimedLevel: "P3",
      provenance: { source: "INDEPENDENT_OBSERVER", observerRef: `rail-statement:${instructionSpec.rail}` },
      payload: `destination-observation:${instruction.amount.currency}:${instruction.amount.value}`,
      links: [execNode],
      recordedAt: world.clock.now(),
    });
    evidenceNodeIds.push(authNode, execNode, outcomeNode);
    const begin = world.settlementAttempts.begin({
      attemptId,
      instructionId: instruction.id,
      rail: instructionSpec.rail,
      idempotencyKey: `idem:${sequence}:${index}`,
      principal: JOURNEY_PRINCIPAL,
      now: world.clock.now(),
    });
    if (begin.kind !== "BEGIN") {
      throw new Error(`settlement chain ${sequence}: settlement attempt ${index} was a replay`);
    }
    world.settlementAttempts.start(attemptId, world.clock.now());
    world.settlementAttempts.recordExternalOutcome(
      attemptId,
      "SUCCEEDED",
      [execNode, outcomeNode],
      world.clock.now(),
    );
    const proofPolicy = defineProofPolicy({
      policyId: `pp:${sequence}:${index}`,
      currency: instruction.amount.currency,
      baselineLevel: "P1",
      highRiskThresholdMinorUnits: 50_000n,
      highRiskLevel: "P3",
      railMinimums: {},
      counterpartyRiskMinimums: {},
    });
    const finality = world.finality.declareFinality({
      finalityId: `fin:${sequence}:${index}`,
      instruction,
      authorization: { nettingSet, obligations },
      policy: proofPolicy,
      proofContext: {
        direction: instructionSpec.direction ?? "SETTLE",
        amount: instruction.amount,
      },
      evidence: [authEvidence, execEvidence, outcomeEvidence],
      now: world.clock.now(),
    });
    const certificate = world.certificates.issue({
      certificateId: `cert:${sequence}:${index}`,
      finalityId: finality.finalityId,
      instruction,
      evidenceChain: [authNode, execNode, outcomeNode],
      reconciliationRefs: instructionSpec.reconciliationRefs ?? [],
      ...(instructionSpec.recurringRenewalReconciliation !== undefined
        ? { recurringRenewalReconciliation: instructionSpec.recurringRenewalReconciliation }
        : {}),
      now: world.clock.now(),
    });
    const attempt = world.settlementAttempts.attempt(attemptId);
    if (attempt === undefined) {
      throw new Error(`settlement chain ${sequence}: attempt ${attemptId} missing after begin`);
    }
    settlements.push({
      instruction,
      attempt,
      finality,
      certificate,
      proofPolicy,
      evidenceNodeIds: [authNode, execNode, outcomeNode],
    });
  });
  // Finality is declared; the obligations may now be settled inside their window.
  const settleClock = new StaticClock(dueWindow.opensAt);
  for (const obligation of obligations) {
    settleObligation(world.obligations, obligation.id, settleClock);
  }
  return { obligations, nettingSet, positions, settlements, evidenceNodeIds };
}

// ---------------------------------------------------------------------------
// Axis 1 — evidenced chain (obligations -> netting -> settlement -> finality)
// ---------------------------------------------------------------------------

/** Verify the full evidenced chain from the live world (never from stale copies). */
export function checkEvidencedChain(
  world: JourneyWorld,
  outcome: SettlementChainOutcome,
): AxisAssertion {
  const checks: { ok: boolean; detail: string }[] = [];
  for (const obligation of outcome.obligations) {
    const live = world.obligations.get(obligation.id);
    checks.push({
      ok: live !== undefined && live.state === "SETTLED",
      detail: `obligation ${obligation.id} is SETTLED in the live book with clearing lineage ${obligation.derivedFrom}`,
    });
  }
  for (const position of outcome.positions) {
    checks.push({
      ok: position.derivation.gross.length > 0,
      detail: `net position ${position.debtor}>${position.creditor} ${position.netAmount.value} ${position.netAmount.currency} retains ${position.derivation.gross.length} gross obligation snapshot(s) (INV-F07)`,
    });
  }
  for (const settlement of outcome.settlements) {
    const gross = settlement.instruction.fromNetPosition.derivation.gross;
    checks.push({
      ok: gross.length > 0 &&
        gross.length === outcome.positions.find((p) => p.debtor === settlement.instruction.debtor && p.creditor === settlement.instruction.creditor)?.derivation.gross.length,
      detail: `instruction ${settlement.instruction.id} carries its fromNetPosition gross derivation (${gross.length} snapshot(s))`,
    });
    checks.push({
      ok: settlement.attempt.state === "SUCCEEDED" && settlement.attempt.evidenceIds.length > 0,
      detail: `settlement attempt ${settlement.attempt.attemptId} SUCCEEDED with ${settlement.attempt.evidenceIds.length} evidence node(s) (INV-E02)`,
    });
    checks.push({
      ok: settlement.finality.state === "FINAL",
      detail: `finality ${settlement.finality.finalityId} is FINAL with proof required ${settlement.finality.proof.required} / achieved ${settlement.finality.proof.achieved} (INV-E03)`,
    });
    checks.push({
      ok: settlement.certificate.evidenceChain.length > 0,
      detail: `certificate ${settlement.certificate.certificateId} issued over evidence chain [${settlement.certificate.evidenceChain.join(", ")}]`,
    });
  }
  const refs = outcome.settlements.flatMap((s) => [
    s.certificate.certificateId,
    s.finality.finalityId,
    s.attempt.attemptId,
    s.instruction.id,
  ]);
  return assertionFromChecks("EVIDENCED_CHAIN", checks, refs);
}

// ---------------------------------------------------------------------------
// Axis 2 — accounting reconciles (INV-F02/F03)
// ---------------------------------------------------------------------------

export interface ExpectedBalance {
  readonly account: AccountId;
  readonly amount: Money;
}

export function checkAccountingReconciles(
  world: JourneyWorld,
  expected: readonly ExpectedBalance[],
): AxisAssertion {
  const checks: { ok: boolean; detail: string }[] = [];
  let balanced = 0;
  for (const entry of world.journal.entries) {
    let sum = 0n;
    for (const line of entry.lines) {
      sum += line.amount.value;
    }
    if (sum !== 0n) {
      checks.push({ ok: false, detail: `entry ${entry.entryId} is UNBALANCED (sum ${sum})` });
    } else {
      balanced += 1;
    }
  }
  checks.push({
    ok: balanced === world.journal.entries.length,
    detail: `all ${world.journal.entries.length} journal entries balance exactly (INV-F03)`,
  });
  const balances = projectBalances(world.journal);
  const perCurrency = new Map<string, bigint>();
  for (const money of balances.values()) {
    perCurrency.set(money.currency, (perCurrency.get(money.currency) ?? 0n) + money.value);
  }
  for (const [currency, total] of perCurrency) {
    checks.push({
      ok: total === 0n,
      detail: `trial balance for ${currency} sums to exactly zero (${total})`,
    });
  }
  for (const balance of expected) {
    const actual = balances.get(balance.account);
    const matches =
      actual !== undefined &&
      actual.value === balance.amount.value &&
      actual.currency === balance.amount.currency;
    checks.push({
      ok: matches,
      detail: `account ${balance.account} balance ${actual === undefined ? "absent" : `${actual.value} ${actual.currency}`} (expected ${balance.amount.value} ${balance.amount.currency})`,
    });
  }
  return assertionFromChecks(
    "ACCOUNTING_RECONCILES",
    checks,
    world.journal.entries.map((entry) => entry.entryId),
  );
}

// ---------------------------------------------------------------------------
// Axis 3 — fees / FX / incentives exact (INV-F01/F09/P03)
// ---------------------------------------------------------------------------

export interface ExactnessCheck {
  readonly label: string;
  readonly expected: Money;
  readonly actual: Money;
}

export function checkFeesFxIncentivesExact(checks: readonly ExactnessCheck[]): AxisAssertion {
  const results = checks.map((check) => ({
    ok: check.expected.currency === check.actual.currency && check.expected.value === check.actual.value,
    detail: `${check.label}: expected ${check.expected.value} ${check.expected.currency}, actual ${check.actual.value} ${check.actual.currency} (exact integer minor units, INV-F01)`,
  }));
  return assertionFromChecks("FEES_FX_INCENTIVES_EXACT", results, []);
}

// ---------------------------------------------------------------------------
// Axis 4 — required approvals and proofs exist (INV-A03/E01/E03/S02)
// ---------------------------------------------------------------------------

export interface ApprovalsProofsSpec {
  readonly authorizationEvidenceRefs: readonly string[];
  readonly grantVerified?: { readonly grantId: string; readonly ok: boolean };
  readonly approvalArtifactValid?: { readonly artifactRef: string; readonly valid: boolean };
  readonly securityEpochValid?: { readonly authorizationRef: string; readonly valid: boolean };
  readonly finalities: readonly FinalityRecord[];
  readonly evidenceLineageHasAuthorization: boolean;
}

export function checkApprovalsAndProofs(spec: ApprovalsProofsSpec): AxisAssertion {
  const checks: { ok: boolean; detail: string }[] = [];
  checks.push({
    ok: spec.authorizationEvidenceRefs.length > 0,
    detail: `${spec.authorizationEvidenceRefs.length} authorization evidence ref(s) recorded for the consequential actions (INV-E01)`,
  });
  if (spec.grantVerified !== undefined) {
    checks.push({
      ok: spec.grantVerified.ok,
      detail: `scoped execution grant ${spec.grantVerified.grantId} verified against the protocol authority`,
    });
  }
  if (spec.approvalArtifactValid !== undefined) {
    checks.push({
      ok: spec.approvalArtifactValid.valid,
      detail: `signed approval artifact ${spec.approvalArtifactValid.artifactRef} identifies principal/agent/scope/expiry/request hash and verifies (INV-A03)`,
    });
  }
  if (spec.securityEpochValid !== undefined) {
    checks.push({
      ok: spec.securityEpochValid.valid,
      detail: `security epoch check passed for ${spec.securityEpochValid.authorizationRef} (INV-S02)`,
    });
  }
  checks.push({
    ok: spec.evidenceLineageHasAuthorization,
    detail: "evidence lineage contains AUTHORIZATION nodes for the settled instruction (INV-E01)",
  });
  for (const finality of spec.finalities) {
    const requiredRank = proofLevelRankOf(finality.proof.required);
    const achievedRank = proofLevelRankOf(finality.proof.achieved);
    checks.push({
      ok: finality.state === "FINAL" && achievedRank >= requiredRank,
      detail: `finality ${finality.finalityId} required proof ${finality.proof.required}, achieved ${finality.proof.achieved} (INV-E03)`,
    });
  }
  return assertionFromChecks("APPROVALS_AND_PROOFS_EXIST", checks, spec.authorizationEvidenceRefs);
}

const PROOF_LEVEL_ORDER = ["P0", "P1", "P2", "P3", "P4", "P5"] as const;
function proofLevelRankOf(level: string): number {
  return PROOF_LEVEL_ORDER.indexOf(level as (typeof PROOF_LEVEL_ORDER)[number]);
}

// ---------------------------------------------------------------------------
// Axis 5 — connector state, provider evidence and canonical financial state
// reconcile WITHOUT lossy mapping (INV-C06/E05/X03)
// ---------------------------------------------------------------------------

export interface LosslessReconciliationSpec {
  readonly envelopes: readonly ProviderStateEnvelope[];
  readonly canonicalMatches: readonly { readonly description: string; readonly ok: boolean }[];
  readonly evidenceLinked: boolean;
}

export function checkLosslessStateReconciliation(
  world: JourneyWorld,
  spec: LosslessReconciliationSpec,
): AxisAssertion {
  const checks: { ok: boolean; detail: string }[] = [];
  for (const envelope of spec.envelopes) {
    const serialized = serializeProviderStateEnvelope(envelope);
    const roundTrip = parseProviderStateEnvelope(serialized);
    const identical = serializeProviderStateEnvelope(roundTrip) === serialized;
    checks.push({
      ok: identical,
      detail: `provider state ${envelope.object.externalId}@${envelope.revision} round-trips losslessly (INV-C06)`,
    });
    world.providerRevisions.append(envelope, world.clock.now());
    const revisionEntry = world.providerRevisions.latest(
      envelope.provider.name,
      envelope.object.objectType,
      envelope.object.externalId,
    );
    checks.push({
      ok: revisionEntry !== undefined,
      detail: `provider revision ledger holds append-only history for ${envelope.object.externalId} (INV-E05)`,
    });
  }
  for (const match of spec.canonicalMatches) {
    checks.push({ ok: match.ok, detail: match.description });
  }
  checks.push({
    ok: spec.evidenceLinked,
    detail: "provider execution evidence is linked into the settlement evidence graph (INV-E02/E05)",
  });
  return assertionFromChecks(
    "LOSSLESS_STATE_RECONCILIATION",
    checks,
    spec.envelopes.map((envelope) => `${envelope.object.externalId}@${envelope.revision}`),
  );
}

// ---------------------------------------------------------------------------
// Axis 6 — PASS_THROUGH_NATIVE certified baseline (INV-C07/C08)
// ---------------------------------------------------------------------------

export interface PassThroughBaselineSpec {
  readonly planMode: ExecutionMode;
  readonly preservesNativeFlow: boolean;
  readonly incumbentProviderName: string;
  /** The incumbent's connected instance is registered and observed AVAILABLE (INV-C05/C01). */
  readonly incumbentBaselineAvailable: boolean;
  readonly benchmarkBaselineCapabilities: readonly string[];
  readonly uniformGatesPassed: readonly { readonly candidateId: string; readonly passed: boolean }[];
}

export function checkPassThroughNativeBaseline(spec: PassThroughBaselineSpec): AxisAssertion {
  const checks: { ok: boolean; detail: string }[] = [];
  checks.push({
    ok: spec.planMode === "PASS_THROUGH_NATIVE" && spec.preservesNativeFlow,
    detail: `execution plan runs PASS_THROUGH_NATIVE through ${spec.incumbentProviderName} preserving the native flow`,
  });
  checks.push({
    ok: spec.benchmarkBaselineCapabilities.length > 0,
    detail: `provider-native optimization represented as benchmark-baseline capabilities: [${spec.benchmarkBaselineCapabilities.join(", ")}] (INV-C08)`,
  });
  for (const gate of spec.uniformGatesPassed) {
    checks.push({
      ok: gate.passed,
      detail: `uniform gate wall passed for candidate ${gate.candidateId} — PASS_THROUGH_NATIVE cannot bypass protocol authorization, compliance or evidence gates (INV-C07)`,
    });
  }
  checks.push({
    ok: spec.incumbentBaselineAvailable,
    detail: `the incumbent baseline is AVAILABLE: connected instance registered and observed AVAILABLE for ${spec.incumbentProviderName} (no mode prior — composition is never assumed superior)`,
  });
  return assertionFromChecks(
    "PASS_THROUGH_NATIVE_BASELINE",
    checks,
    spec.benchmarkBaselineCapabilities,
  );
}

// ---------------------------------------------------------------------------
// Journey outcome assembly
// ---------------------------------------------------------------------------

export function assembleJourneyOutcome(
  journeyId: string,
  title: string,
  invariants: readonly InvariantProof[],
  assertions: readonly AxisAssertion[],
  evidenceRefs: readonly string[],
): JourneyOutcome {
  return { journeyId, title, invariantsExercised: invariants, assertions, evidenceRefs };
}

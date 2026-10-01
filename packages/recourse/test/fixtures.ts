/**
 * Shared deterministic fixtures for @payswap/recourse tests. All shapes are
 * CONSUMED from the canonical packages: @payswap/protocol (kernel, journal,
 * reservations, obligations), @payswap/settlement (evidence graph, proof
 * levels). Nothing here redefines vocabulary.
 *
 * The scenario models one original transaction `TX-1`:
 *   alice (payer, funder) pays bob (payee, beneficiary) 900.00 USD over an
 *   invoice; the protocol derives the ORIGINAL obligation (alice → bob);
 *   the transaction carries authorization/execution/outcome evidence in the
 *   settlement evidence graph; a recourse policy is declared at initiation
 *   with a 30-day claim window and two evidence requirements.
 */
import {
  USD,
  asClearingRecordId,
  asFulfillmentActivityId,
  asPartyId,
  createJournalEntry,
  deriveObligations,
  fromMinorUnits,
  negate,
  postJournal,
} from "@payswap/protocol";
import type {
  ClearingRecord,
  JournalEntry,
  Obligation,
  TimestampMs,
} from "@payswap/protocol";
import { DeterministicClock, InMemoryLedgerJournal } from "@payswap/protocol";
import { createIdFactory } from "@payswap/protocol";
import { InMemoryObligationBook, InMemoryReservationBook } from "@payswap/protocol";
import { accountId } from "@payswap/protocol";
import { EvidenceGraph } from "@payswap/settlement";
import { initiateRecoursePolicy, RecoursePolicyRegistry } from "../src/policy.js";
import { DisputeAuthority } from "../src/disputes.js";
import { RecourseObligationAuthority } from "../src/recourse-obligations.js";
import { EscrowAuthority } from "../src/escrow.js";
import { BondAuthority } from "../src/bonds.js";
import { GuaranteeAuthority } from "../src/guarantees.js";

// ---------------------------------------------------------------------------
// Deterministic constants
// ---------------------------------------------------------------------------

export const NOW: TimestampMs = 1_700_000_000_000n;
export const DAY_MS = 86_400_000n;
export const CLAIM_WINDOW = Object.freeze({
  opensAt: NOW,
  closesAt: NOW + 30n * DAY_MS,
});
export const DISPUTED_AMOUNT = fromMinorUnits(USD, 90_000n); // 900.00 USD
export const GRANTED_AMOUNT = fromMinorUnits(USD, 60_000n); // 600.00 USD

export const ALICE = asPartyId("party_alice");
export const BOB = asPartyId("party_bob");
export const CAROL = asPartyId("party_carol");
export const GUARANTOR = asPartyId("party_guarantor");
export const SURETY = asPartyId("party_surety");

export const EQUITY_GENESIS = accountId("EQUITY", "genesis");
export const ALICE_ACCOUNT = accountId("ASSET", "operational.alice");
export const BOB_ACCOUNT = accountId("ASSET", "operational.bob");
export const CAROL_ACCOUNT = accountId("ASSET", "operational.carol");
export const SURETY_ACCOUNT = accountId("ASSET", "operational.surety");

export const TRANSACTION_REF = "TX-1";
export const DUE_WINDOW = Object.freeze({
  opensAt: NOW,
  closesAt: NOW + 1_000_000n,
});

// ---------------------------------------------------------------------------
// The wired scenario
// ---------------------------------------------------------------------------

export interface RecourseScenario {
  readonly clock: DeterministicClock;
  readonly journal: InMemoryLedgerJournal;
  readonly reservationBook: InMemoryReservationBook;
  readonly ledger: {
    readonly journal: InMemoryLedgerJournal;
    readonly reservations: InMemoryReservationBook;
    readonly ids: ReturnType<typeof createIdFactory>;
    readonly clock: DeterministicClock;
  };
  readonly book: InMemoryObligationBook;
  readonly evidence: EvidenceGraph;
  readonly policies: RecoursePolicyRegistry;
  readonly disputes: DisputeAuthority;
  readonly obligations: RecourseObligationAuthority;
  readonly escrow: EscrowAuthority;
  readonly bonds: BondAuthority;
  readonly guarantees: GuaranteeAuthority;
  /** The ORIGINAL transaction artifacts (must never be rewritten). */
  readonly originalClearingRecord: ClearingRecord;
  readonly originalObligation: Obligation;
  /** Evidence node ids of the original transaction (in the graph). */
  readonly originalEvidenceRefs: readonly string[];
}

/** Evidence nodes recorded for the ORIGINAL transaction TX-1. */
function recordOriginalTransactionEvidence(
  evidence: EvidenceGraph,
  now: TimestampMs,
): readonly string[] {
  const nodes = [
    evidence.record({
      nodeId: "ev_tx_auth",
      kind: "AUTHORIZATION",
      actionRef: TRANSACTION_REF,
      claimedLevel: "P2",
      provenance: { source: "AUTHENTICATED_PROVIDER", providerName: "test-psp" },
      payload: "approval-artifact:art-tx-1",
      links: [],
      recordedAt: now,
    }),
    evidence.record({
      nodeId: "ev_tx_exec",
      kind: "EXECUTION",
      actionRef: TRANSACTION_REF,
      claimedLevel: "P2",
      provenance: { source: "AUTHENTICATED_PROVIDER", providerName: "test-psp" },
      payload: "provider-op:op-tx-1",
      links: ["ev_tx_auth"],
      recordedAt: now + 1n,
    }),
    evidence.record({
      nodeId: "ev_tx_outcome",
      kind: "OUTCOME",
      actionRef: TRANSACTION_REF,
      claimedLevel: "P3",
      provenance: { source: "INDEPENDENT_OBSERVER", observerRef: "bank-statement:line-1" },
      payload: "destination-observation:credit-90000",
      links: ["ev_tx_exec"],
      recordedAt: now + 2n,
    }),
  ];
  return nodes.map((node) => node.nodeId);
}

/** Fund the operational accounts from equity (a balanced genesis entry). */
function fundOperationalAccounts(scenario: {
  readonly journal: InMemoryLedgerJournal;
  readonly ids: ReturnType<typeof createIdFactory>;
  readonly clock: DeterministicClock;
}): JournalEntry {
  const total = fromMinorUnits(USD, 4_000_000n); // 40,000.00 USD
  const quarter = fromMinorUnits(USD, 1_000_000n); // 10,000.00 USD each
  return postJournal(
    scenario.journal,
    createJournalEntry(
      {
        lines: [
          { accountId: EQUITY_GENESIS, amount: negate(total) },
          { accountId: ALICE_ACCOUNT, amount: quarter },
          { accountId: BOB_ACCOUNT, amount: quarter },
          { accountId: CAROL_ACCOUNT, amount: quarter },
          { accountId: SURETY_ACCOUNT, amount: quarter },
        ],
        memo: "GENESIS_FUNDING",
      },
      { ids: scenario.ids, clock: scenario.clock },
    ),
  );
}

/** Build the full deterministic scenario at clock reading NOW. */
export function buildScenario(): RecourseScenario {
  const clock = new DeterministicClock(NOW);
  const ids = createIdFactory(clock);
  const journal = new InMemoryLedgerJournal();
  const reservationBook = new InMemoryReservationBook();
  const ledger = { journal, reservations: reservationBook, ids, clock };
  const book = new InMemoryObligationBook();

  fundOperationalAccounts({ journal, ids, clock });

  const evidence = new EvidenceGraph();
  const originalEvidenceRefs = recordOriginalTransactionEvidence(evidence, NOW);

  // The ORIGINAL transaction: alice owes bob 900.00 USD (invoice payment),
  // derived through the protocol's own obligation machinery.
  const originalClearingRecord: ClearingRecord = Object.freeze({
    id: asClearingRecordId("CR-TX-1"),
    activities: Object.freeze([
      Object.freeze({
        id: asFulfillmentActivityId("FA-TX-1"),
        activityType: "INVOICE_PAYMENT",
        debtor: ALICE,
        creditor: BOB,
        amount: DISPUTED_AMOUNT,
        occurredAt: NOW,
      }),
    ]),
    netted: false,
  });
  const [originalObligation] = deriveObligations([originalClearingRecord], {
    dueWindow: DUE_WINDOW,
  });
  if (originalObligation === undefined) {
    throw new Error("fixture setup failed: no original obligation derived");
  }
  book.add(originalObligation);

  // The recourse policy, declared at initiation and registered.
  const policies = new RecoursePolicyRegistry();
  const policy = initiateRecoursePolicy(
    {
      transactionRef: TRANSACTION_REF,
      currency: USD,
      mechanisms: ["ESCROW", "BOND", "GUARANTEE", "EXPLICIT_CREDIT"],
      claimWindow: CLAIM_WINDOW,
      evidenceRequirements: [
        {
          requirementId: "authorization-proof",
          description: "proof that the original payment was authorized",
          requiredKinds: ["AUTHORIZATION"],
          minimumProofLevel: "P2",
        },
        {
          requirementId: "delivery-outcome",
          description: "independent observation of what was actually delivered",
          requiredKinds: ["OUTCOME", "PROOF"],
          minimumProofLevel: "P2",
        },
      ],
    },
    { now: NOW },
  );
  policies.register(policy);

  const disputes = new DisputeAuthority({ policies, evidence, ids, clock });
  const obligations = new RecourseObligationAuthority({ book, ids, clock });
  const escrow = new EscrowAuthority({ ledger, disputes });
  const bonds = new BondAuthority({ ledger, disputes, obligations, evidence });
  const guarantees = new GuaranteeAuthority({ disputes, obligations, evidence, ids, clock });

  return {
    clock,
    journal,
    reservationBook,
    ledger,
    book,
    evidence,
    policies,
    disputes,
    obligations,
    escrow,
    bonds,
    guarantees,
    originalClearingRecord,
    originalObligation,
    originalEvidenceRefs,
  };
}

/** Open + grant a dispute over TX-1 (claimant: alice against bob). */
export function openGrantedDispute(
  scenario: RecourseScenario,
  options?: {
    readonly disputedAmount?: typeof DISPUTED_AMOUNT;
    readonly evidenceRefs?: readonly string[];
  },
): ReturnType<DisputeAuthority["applyEvent"]> {
  const dispute = scenario.disputes.openDispute({
    transactionRef: TRANSACTION_REF,
    claimant: ALICE,
    respondent: BOB,
    disputedAmount: options?.disputedAmount ?? DISPUTED_AMOUNT,
    reason: "goods not delivered as described",
    evidenceRefs: options?.evidenceRefs ?? scenario.originalEvidenceRefs,
  });
  return scenario.disputes.applyEvent({
    disputeId: dispute.disputeId,
    event: "GRANT",
    decidedBy: "operator:adjudicator-1",
    grantedAmount: GRANTED_AMOUNT,
  });
}

/** Record an extra evidence node (e.g. new facts for a REOPEN). */
export function recordExtraEvidence(
  scenario: RecourseScenario,
  nodeId: string,
  actionRef: string,
): string {
  scenario.evidence.record({
    nodeId,
    kind: "PROOF",
    actionRef,
    claimedLevel: "P3",
    provenance: { source: "INDEPENDENT_OBSERVER", observerRef: "inspector:report-1" },
    payload: `extra-proof:${nodeId}`,
    links: [],
    recordedAt: scenario.clock.now(),
  });
  return nodeId;
}

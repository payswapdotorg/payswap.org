/**
 * Journey 10 — refund/dispute lifecycle (W1-007).
 *
 * The dispute does not rewrite the original (recourse immutability), the
 * recourse obligation is separate, and escrow is separately accounted.
 * Composes the recourse plane (RecoursePolicy, DisputeAuthority,
 * RecourseObligationAuthority, EscrowAuthority with a dedicated RESERVE
 * account) over the shared evidenced settlement chain.
 */

import {
  USD,
  fromMinorUnits,
  accountId,
} from "@payswap/protocol";
import type { AccountId, Money, Obligation } from "@payswap/protocol";
import { projectBalances } from "@payswap/protocol";
import {
  DisputeAuthority,
  EscrowAuthority,
  RecourseObligationAuthority,
  RecoursePolicyRegistry,
  initiateRecoursePolicy,
} from "@payswap/recourse";
import type { DisputeCase, EscrowHold } from "@payswap/recourse";
import {
  assembleJourneyOutcome,
  buildWorld,
  checkAccountingReconciles,
  checkApprovalsAndProofs,
  checkEvidencedChain,
  checkFeesFxIncentivesExact,
  checkLosslessStateReconciliation,
  clearingRecord,
  party as partyRef,
  postEntry,
  providerEnvelope,
  registerRailFixture,
  runSettlementChain,
} from "../harness.js";
import type {
  AxisAssertion,
  InvariantProof,
  JourneyOutcome,
  SettlementChainOutcome,
} from "../harness.js";
import type { JourneyWorld } from "../harness.js";

export interface RefundDisputeJourneyDetails {
  readonly originalObligationId: string;
  readonly originalObligationState: string;
  readonly originalFinalityState: string;
  readonly disputeState: string;
  readonly grantedAmount: Money;
  readonly recourseObligationId: string;
  readonly recourseObligationSeparate: boolean;
  readonly escrowState: string;
  readonly escrowAccountBalance: Money;
  readonly payerBalanceAfter: Money;
  readonly merchantBalanceAfter: Money;
  readonly originalChain: SettlementChainOutcome;
  readonly recourseChain: SettlementChainOutcome;
}

export interface RefundDisputeJourneyOutcome {
  readonly journey: JourneyOutcome;
  readonly details: RefundDisputeJourneyDetails;
}

const PAYER_WALLET: AccountId = accountId("ASSET", "wallet.payer-dispute");
const MERCHANT_WALLET: AccountId = accountId("ASSET", "wallet.merchant-dispute");

/** Run the refund/dispute lifecycle journey deterministically. */
export function runRefundDisputeJourney(): RefundDisputeJourneyOutcome {
  const world = buildWorld({
    openingBalances: [{ account: PAYER_WALLET, amount: fromMinorUnits(USD, 200_000n) }],
  });
  const now = world.clock.now();

  registerRailFixture(world, {
    providerName: "psp-escrow-protected",
    capabilityId: "cap.escrow.collect",
    currencies: ["USD"],
  });

  // ---- Recourse policy for the transaction (escrow-protected, evidence-gated).
  const policies = new RecoursePolicyRegistry();
  const policy = initiateRecoursePolicy(
    {
      transactionRef: "TX:refund:1",
      currency: USD,
      mechanisms: ["ESCROW"],
      claimWindow: { opensAt: now, closesAt: now + 86_400_000n },
      evidenceRequirements: [
        {
          requirementId: "req:delivery-proof",
          description: "Provider execution evidence plus a receipt of the original payment",
          requiredKinds: ["EXECUTION", "RECEIPT"],
          minimumProofLevel: "P2",
        },
      ],
    },
    { now },
  );
  policies.register(policy);

  // ---- The original payment settles through the protocol chain.
  const originalAmount = fromMinorUnits(USD, 90_000n);
  const originalChain = runSettlementChain({
    world,
    sequence: "refund-original",
    clearingRecords: [
      clearingRecord("CR:refund:original", [
        {
          id: "FA:refund:original",
          activityType: "MERCHANT_PAYMENT",
          debtor: "user:payer-dispute",
          creditor: "merchant:dispute-merchant",
          amount: originalAmount,
          occurredAt: now,
        },
      ], world),
    ],
    dueWindow: { opensAt: now, closesAt: now + 1_000_000n },
    authorizationRefs: ["approval:refund:original-1", "grant:refund:execution"],
    instructions: [
      { settlementDestinationId: "dest:merchant-dispute", rail: "ESCROW_PROTECTED_RAIL", providerName: "psp-escrow-protected" },
    ],
  });
  const originalObligation = originalChain.obligations[0];
  if (originalObligation === undefined) {
    throw new Error("refund journey: no original obligation");
  }
  const originalBeforeDispute: Obligation = world.obligations.get(originalObligation.id) ?? originalObligation;

  // ---- Escrow: the payment is escrow-protected; funds flow through a
  // dedicated RESERVE account (separately accounted).
  const disputes = new DisputeAuthority({
    policies,
    evidence: world.evidence,
    ids: world.ids,
    clock: world.clock,
  });
  const escrow = new EscrowAuthority({ ledger: world.reservationState, disputes });
  const deliveryEvidence = world.evidence.record({
    nodeId: "refund:delivery-receipt",
    kind: "RECEIPT",
    actionRef: "TX:refund:1",
    claimedLevel: "P3",
    provenance: { source: "INDEPENDENT_OBSERVER", observerRef: "carrier:proof-of-delivery:1" },
    payload: "delivery-confirmation:TX:refund:1",
    links: [],
    recordedAt: world.clock.now(),
  });
  const executionEvidence = world.evidence.record({
    nodeId: "refund:execution-proof",
    kind: "EXECUTION",
    actionRef: "TX:refund:1",
    claimedLevel: "P2",
    provenance: { source: "AUTHENTICATED_PROVIDER", providerName: "psp-escrow-protected" },
    payload: "provider-op:TX:refund:1",
    links: [],
    recordedAt: world.clock.now(),
  });
  const hold: EscrowHold = escrow.openEscrow({
    transactionRef: "TX:refund:1",
    amount: originalAmount,
    funderAccount: PAYER_WALLET,
    beneficiaryAccount: MERCHANT_WALLET,
    policy,
  });
  const released = escrow.releaseEscrow({
    escrowId: hold.escrowId,
    evidenceRefs: [deliveryEvidence.nodeId, executionEvidence.nodeId],
  });

  // ---- The dispute: does NOT rewrite the original.
  const dispute: DisputeCase = disputes.openDispute({
    transactionRef: "TX:refund:1",
    claimant: partyRef("user:payer-dispute"),
    respondent: partyRef("merchant:dispute-merchant"),
    disputedAmount: originalAmount,
    reason: "goods not delivered as described",
    evidenceRefs: [deliveryEvidence.nodeId, executionEvidence.nodeId],
  });
  disputes.applyEvent({ disputeId: dispute.disputeId, event: "REVIEW" });
  const granted = disputes.applyEvent({
    disputeId: dispute.disputeId,
    event: "GRANT",
    decidedBy: "operator:adjudicator-1",
    grantedAmount: fromMinorUnits(USD, 60_000n),
  });

  // ---- The refund is a SEPARATE recourse obligation (recourse immutability).
  const recourse = new RecourseObligationAuthority({
    book: world.obligations,
    ids: world.ids,
    clock: world.clock,
  });
  const recourseObligations = recourse.grantRecourseObligations({
    dispute: granted,
    debtor: partyRef("merchant:dispute-merchant"),
    creditor: partyRef("user:payer-dispute"),
    amount: fromMinorUnits(USD, 60_000n),
    mechanism: "ESCROW",
    adjustmentKind: "REFUND",
    ...(originalObligation !== undefined
      ? { originalObligationRef: originalObligation.id }
      : {}),
    dueWindow: { opensAt: world.clock.now(), closesAt: world.clock.now() + 1_000_000n },
  });
  const recourseObligation = recourseObligations[0];
  if (recourseObligation === undefined) {
    throw new Error("refund journey: no recourse obligation minted");
  }

  const recourseChain = runSettlementChain({
    world,
    sequence: "refund-recourse",
    obligations: recourseObligations,
    dueWindow: { opensAt: world.clock.now(), closesAt: world.clock.now() + 1_000_000n },
    authorizationRefs: [`dispute:${granted.disputeId}`, "grant:refund:execution"],
    instructions: [
      {
        settlementDestinationId: "dest:payer-dispute",
        rail: "ESCROW_REFUND_RAIL",
        providerName: "psp-escrow-protected",
        direction: "REFUND",
      },
    ],
  });
  postEntry(
    world,
    [
      { accountId: MERCHANT_WALLET, amount: fromMinorUnits(USD, -60_000n) },
      { accountId: PAYER_WALLET, amount: fromMinorUnits(USD, 60_000n) },
    ],
    "dispute refund movement",
    "refund:recourse",
  );

  const envelope = providerEnvelope(
    {
      providerName: "psp-escrow-protected",
      externalId: "pi_escrow_1",
      revision: "rev_1",
      family: "refund",
      lifecycleStep: "refunded",
      isTerminal: true,
      requiresCustomerAction: false,
      state: { providerNativeStatus: "refunded", disputeId: granted.disputeId, amountMinor: "60000" },
    },
    world,
  );

  const originalAfter = world.obligations.get(originalObligation.id);
  const assertions: readonly AxisAssertion[] = [
    checkEvidencedChain(world, originalChain),
    checkEvidencedChain(world, recourseChain),
    checkAccountingReconciles(world, [
      { account: PAYER_WALLET, amount: fromMinorUnits(USD, 170_000n) },
      { account: MERCHANT_WALLET, amount: fromMinorUnits(USD, 30_000n) },
      { account: accountId("RESERVE", `escrow.${hold.escrowId}`), amount: fromMinorUnits(USD, 0n) },
    ]),
    checkFeesFxIncentivesExact([
      { label: "granted refund amount exact", expected: fromMinorUnits(USD, 60_000n), actual: granted.resolution?.grantedAmount ?? fromMinorUnits(USD, 0n) },
      { label: "recourse obligation amount exact", expected: fromMinorUnits(USD, 60_000n), actual: recourseObligation.amount },
    ]),
    checkApprovalsAndProofs({
      authorizationEvidenceRefs: [`dispute:${granted.disputeId}`, "approval:refund:original-1", "grant:refund:execution"],
      finalities: [...originalChain.settlements, ...recourseChain.settlements].map((s) => s.finality),
      evidenceLineageHasAuthorization:
        world.evidence.lineageForAction(originalChain.settlements[0]?.instruction.id ?? "").authorization.length > 0,
    }),
    checkLosslessStateReconciliation(world, {
      envelopes: [envelope],
      canonicalMatches: [
        {
          description: "the dispute did NOT rewrite the original obligation (byte-identical, still SETTLED)",
          ok:
            originalAfter !== undefined &&
            originalAfter.state === "SETTLED" &&
            canonical(originalAfter) === canonical(originalBeforeDispute),
        },
        {
          description: "the original finality was not reversed (recourse immutability)",
          ok: originalChain.settlements[0]?.finality.state === "FINAL",
        },
        {
          description: `the refund is a SEPARATE obligation ${recourseObligation.id} with reversed direction`,
          ok:
            recourseObligation.id !== originalObligation.id &&
            recourseObligation.debtor === originalObligation.creditor &&
            recourseObligation.creditor === originalObligation.debtor,
        },
        {
          description: "escrow is separately accounted (dedicated RESERVE account, zero after release)",
          ok: released.state === "RELEASED" && projected(world, accountId("RESERVE", `escrow.${hold.escrowId}`)).value === 0n,
        },
        {
          description: "the refund provider state carries the dispute reference verbatim",
          ok: JSON.stringify(envelope.state).includes(granted.disputeId),
        },
      ],
      evidenceLinked:
        originalChain.settlements.every((s) => s.certificate.evidenceChain.length === 3) &&
        recourseChain.settlements.every((s) => s.certificate.evidenceChain.length === 3),
    }),
  ];

  const invariants: readonly InvariantProof[] = [
    { id: "INV-E05", proof: `the original obligation and finality are immutable after the dispute (original still SETTLED and FINAL; the refund is obligation ${recourseObligation.id})` },
    { id: "INV-F06", proof: "the refund settled through a SECOND protocol-authorized netting/finality chain, not by rewriting the first" },
    { id: "INV-F03", proof: "escrow funding/release and the refund movement all balance; USD trial balance zero" },
    { id: "INV-F04", proof: `escrow opened through a real reservation on the funder account (${hold.reservationId})` },
    { id: "INV-E03", proof: "dispute evidence met the policy's proof requirements (EXECUTION P2 + RECEIPT P3) before the claim opened" },
    { id: "INV-F01", proof: "disputed, granted and refunded amounts are exact integer minor units" },
  ];

  const journey = assembleJourneyOutcome(
    "refund-dispute",
    "Refund/dispute lifecycle",
    invariants,
    assertions,
    [...originalChain.evidenceNodeIds, ...recourseChain.evidenceNodeIds, deliveryEvidence.nodeId],
  );
  return {
    journey,
    details: {
      originalObligationId: originalObligation.id,
      originalObligationState: originalAfter?.state ?? "MISSING",
      originalFinalityState: originalChain.settlements[0]?.finality.state ?? "MISSING",
      disputeState: granted.state,
      grantedAmount: granted.resolution?.grantedAmount ?? fromMinorUnits(USD, 0n),
      recourseObligationId: recourseObligation.id,
      recourseObligationSeparate:
        recourseObligation.id !== originalObligation.id &&
        recourseObligation.debtor === originalObligation.creditor,
      escrowState: released.state,
      escrowAccountBalance: projected(world, accountId("RESERVE", `escrow.${hold.escrowId}`)),
      payerBalanceAfter: projected(world, PAYER_WALLET),
      merchantBalanceAfter: projected(world, MERCHANT_WALLET),
      originalChain,
      recourseChain,
    },
  };
}

/** Deterministic bigint-safe serialization for immutability comparison. */
function canonical(value: unknown): string {
  if (typeof value === "bigint") return `${value}n`;
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${k}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function projected(world: JourneyWorld, account: AccountId): Money {
  return projectBalances(world.journal, account).get(account) ?? fromMinorUnits(USD, 0n);
}

export const refundDisputeJourney = {
  journeyId: "refund-dispute",
  title: "Refund/dispute lifecycle",
  description:
    "dispute does not rewrite the original (recourse immutability), recourse obligation separate, escrow separately accounted",
  run: (): JourneyOutcome => runRefundDisputeJourney().journey,
} as const;

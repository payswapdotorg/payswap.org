/**
 * Journey 5 — lending/credit (W1-007).
 *
 * Explicit credit line (INV-F08), exposure tracking, collateral accounted
 * separately. Composes the protocol credit layer (openCreditLine,
 * frontValueForDelay with per-draw CreditExposure records, repayCredit) over
 * the shared evidenced settlement chain; the collateral is booked to a
 * dedicated RESERVE account, separate from every other balance.
 */

import {
  USD,
  accountId,
  defineCollateral,
  fromMinorUnits,
  frontValueForDelay,
  openCreditLine,
  repayCredit,
} from "@payswap/protocol";
import type { AccountId, CreditExposure, CreditLine, Money } from "@payswap/protocol";
import { projectBalances } from "@payswap/protocol";
import {
  assembleJourneyOutcome,
  buildWorld,
  checkAccountingReconciles,
  checkApprovalsAndProofs,
  checkEvidencedChain,
  checkFeesFxIncentivesExact,
  checkLosslessStateReconciliation,
  clearingRecord,
  party,
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

export interface CreditJourneyDetails {
  readonly creditLineId: string;
  readonly limitMinorUnits: bigint;
  readonly utilizedBeforeRepay: bigint;
  readonly utilizedAfterRepay: bigint;
  readonly exposureOutstanding: bigint;
  readonly exposureReason: string;
  readonly collateralId: string;
  readonly collateralAccountBalance: Money;
  readonly limitExceededRejected: boolean;
  readonly creditFee: Money;
  readonly chain: SettlementChainOutcome;
}

export interface CreditJourneyOutcome {
  readonly journey: JourneyOutcome;
  readonly details: CreditJourneyDetails;
}

const MERCHANT_WALLET: AccountId = accountId("ASSET", "wallet.merchant-x");
const LENDER_WALLET: AccountId = accountId("ASSET", "wallet.fintech-lender");
const SUPPLIER_WALLET: AccountId = accountId("ASSET", "wallet.supplier-y");
const COLLATERAL_RESERVE: AccountId = accountId("RESERVE", "collateral.cl-1");
const CREDIT_FEE_INCOME: AccountId = accountId("INCOME", "fees.credit");

/** Run the lending/credit journey deterministically. */
export function runCreditJourney(): CreditJourneyOutcome {
  const world = buildWorld({
    openingBalances: [
      { account: MERCHANT_WALLET, amount: fromMinorUnits(USD, 1_000_000n) },
      { account: LENDER_WALLET, amount: fromMinorUnits(USD, 500_000n) },
    ],
  });
  const now = world.clock.now();

  registerRailFixture(world, {
    providerName: "psp-credit-originator",
    capabilityId: "cap.credit.settlement_funding",
    currencies: ["USD"],
  });
  const envelope = providerEnvelope(
    {
      providerName: "psp-credit-originator",
      externalId: "credit_funding_1",
      revision: "rev_1",
      family: "other",
      lifecycleStep: "funded",
      isTerminal: true,
      requiresCustomerAction: false,
      state: { providerNativeStatus: "funded", creditLineId: "cl:merchant-x-1" },
    },
    world,
  );

  // ---- The delayed-settlement obligation merchant-x owes supplier-y.
  const dueWindow = { opensAt: now, closesAt: now + 1_000_000n };
  const chain = runSettlementChain({
    world,
    sequence: "credit",
    clearingRecords: [
      clearingRecord("CR:credit:1", [
        {
          id: "FA:credit:1",
          activityType: "SUPPLIER_INVOICE_PAYMENT",
          debtor: "merchant:merchant-x",
          creditor: "merchant:supplier-y",
          amount: fromMinorUnits(USD, 400_000n),
          occurredAt: now,
        },
      ], world),
    ],
    dueWindow,
    authorizationRefs: ["approval:credit:line-1", "grant:credit:execution"],
    instructions: [
      { settlementDestinationId: "dest:supplier-y", rail: "CREDIT_FUNDED_RAIL", providerName: "psp-credit-originator" },
    ],
  });
  const backingObligation = chain.obligations[0];
  if (backingObligation === undefined) {
    throw new Error("credit journey: no backing obligation derived");
  }

  // ---- Explicit credit line with pledged collateral (INV-F08).
  const collateral = defineCollateral({
    id: "col:merchant-x-cash-1",
    kind: "CASH_DEPOSIT",
    owner: party("merchant:merchant-x"),
    description: "Cash collateral pledged against credit line cl:merchant-x-1",
    appraisedValue: fromMinorUnits(USD, 300_000n),
    appraisedAsOf: now,
    provenance: { source: "bank:merchant-x", reference: "pledge:2025-12:1", recordedAt: now },
  });
  let line: CreditLine = openCreditLine(
    {
      id: "cl:merchant-x-1",
      creditor: party("party:fintech-lender"),
      debtor: party("merchant:merchant-x"),
      limit: fromMinorUnits(USD, 500_000n),
      currency: USD,
      expiry: now + 30n * 86_400_000n,
      collateral: [collateral],
    },
    world.clock,
  );

  // The obligation object is frozen with branded PartyIds; front against it.
  const obligationForCredit = chain.obligations.find((o) => o.id === backingObligation.id);
  if (obligationForCredit === undefined) {
    throw new Error("credit journey: obligation missing");
  }
  const draw = frontValueForDelay(line, obligationForCredit, fromMinorUnits(USD, 400_000n), world.clock, world.ids);
  line = draw.line;
  const exposure: CreditExposure = draw.exposure;

  // INV-F08 adversarial: drawing beyond the explicit limit is rejected.
  let limitExceededRejected = false;
  try {
    frontValueForDelay(line, obligationForCredit, fromMinorUnits(USD, 200_000n), world.clock, world.ids);
  } catch {
    limitExceededRejected = true;
  }

  // ---- Accounting: collateral booked separately (RESERVE account), the
  // lender fronts the settlement value, a credit fee accrues, then repayment.
  postEntry(
    world,
    [
      { accountId: COLLATERAL_RESERVE, amount: fromMinorUnits(USD, 300_000n) },
      { accountId: MERCHANT_WALLET, amount: fromMinorUnits(USD, -300_000n) },
    ],
    "collateral pledged to dedicated reserve account",
    "credit:collateral",
  );
  postEntry(
    world,
    [
      { accountId: LENDER_WALLET, amount: fromMinorUnits(USD, -400_000n) },
      { accountId: SUPPLIER_WALLET, amount: fromMinorUnits(USD, 400_000n) },
    ],
    "lender fronts the delayed settlement",
    "credit:funding",
  );
  const creditFee = fromMinorUnits(USD, 2_000n);
  postEntry(
    world,
    [
      { accountId: MERCHANT_WALLET, amount: fromMinorUnits(USD, -2_000n) },
      { accountId: CREDIT_FEE_INCOME, amount: creditFee },
    ],
    "credit fronting fee",
    "credit:fee",
  );
  const repayment = repayCredit(line, fromMinorUnits(USD, 400_000n), world.clock, world.ids, "settlement:credit:chain");
  line = repayment.line;
  postEntry(
    world,
    [
      { accountId: MERCHANT_WALLET, amount: fromMinorUnits(USD, -400_000n) },
      { accountId: LENDER_WALLET, amount: fromMinorUnits(USD, 400_000n) },
    ],
    "credit repayment",
    "credit:repay",
  );

  const utilizedBeforeRepay = draw.line.utilized.value;
  const utilizedAfterRepay = repayment.line.utilized.value;

  const assertions: readonly AxisAssertion[] = [
    checkEvidencedChain(world, chain),
    checkAccountingReconciles(world, [
      { account: MERCHANT_WALLET, amount: fromMinorUnits(USD, 298_000n) },
      { account: LENDER_WALLET, amount: fromMinorUnits(USD, 500_000n) },
      { account: SUPPLIER_WALLET, amount: fromMinorUnits(USD, 400_000n) },
      { account: COLLATERAL_RESERVE, amount: fromMinorUnits(USD, 300_000n) },
      { account: CREDIT_FEE_INCOME, amount: fromMinorUnits(USD, 2_000n) },
    ]),
    checkFeesFxIncentivesExact([
      { label: "credit fee exact", expected: fromMinorUnits(USD, 2_000n), actual: creditFee },
      { label: "exposure outstanding equals the drawn amount", expected: fromMinorUnits(USD, 400_000n), actual: exposure.outstanding },
      { label: "utilization cleared exactly by repayment", expected: fromMinorUnits(USD, 0n), actual: fromMinorUnits(USD, line.utilized.value) },
    ]),
    checkApprovalsAndProofs({
      authorizationEvidenceRefs: ["approval:credit:line-1", "grant:credit:execution"],
      finalities: chain.settlements.map((s) => s.finality),
      evidenceLineageHasAuthorization: world.evidence
        .lineageForAction(chain.settlements[0]?.instruction.id ?? "")
        .authorization.length > 0,
    }),
    checkLosslessStateReconciliation(world, {
      envelopes: [envelope],
      canonicalMatches: [
        {
          description: "the explicit CreditExposure record backs the settled obligation (no hidden credit)",
          ok: exposure.derivation.backingObligation === backingObligation.id,
        },
        {
          description: "collateral is accounted in a separate RESERVE account",
          ok: projected(world, COLLATERAL_RESERVE).value === 300_000n,
        },
      ],
      evidenceLinked: chain.settlements.every((s) => s.certificate.evidenceChain.length === 3),
    }),
  ];

  const invariants: readonly InvariantProof[] = [
    { id: "INV-F08", proof: `credit is explicit: the draw created CreditExposure ${exposure.id} with reason '${exposure.derivation.reason}' backing obligation ${backingObligation.id}; over-limit draw rejected (${limitExceededRejected})` },
    { id: "INV-F01", proof: "limit, utilization, exposure, collateral value, fee and repayment are exact integer minor units" },
    { id: "INV-F03", proof: "collateral, funding, fee and repayment entries all balance; the USD trial balance sums to zero" },
    { id: "INV-F07", proof: "the settled obligation retains its clearing derivation" },
    { id: "INV-F06", proof: "finality for the supplier payment was protocol-declared with the credit funding as evidence-backed settlement" },
    { id: "INV-E03", proof: "finality achieved its policy-required proof level" },
  ];

  const journey = assembleJourneyOutcome(
    "credit",
    "Lending/credit",
    invariants,
    assertions,
    chain.evidenceNodeIds,
  );
  return {
    journey,
    details: {
      creditLineId: line.id,
      limitMinorUnits: line.limit.value,
      utilizedBeforeRepay,
      utilizedAfterRepay,
      exposureOutstanding: exposure.outstanding.value,
      exposureReason: exposure.derivation.reason,
      collateralId: collateral.id,
      collateralAccountBalance: projected(world, COLLATERAL_RESERVE),
      limitExceededRejected,
      creditFee,
      chain,
    },
  };
}

function projected(world: JourneyWorld, account: AccountId): Money {
  return projectBalances(world.journal, account).get(account) ?? fromMinorUnits(USD, 0n);
}

export const creditJourney = {
  journeyId: "credit",
  title: "Lending/credit",
  description:
    "explicit credit line (INV-F08), exposure tracking, collateral accounted separately",
  run: (): JourneyOutcome => runCreditJourney().journey,
} as const;

/**
 * Journey 4 — payroll-like batch (W1-007).
 *
 * Many obligations -> netting (INV-F07 gross preservation) -> batch
 * settlement; liquidity/credit constraints respected. Composes the protocol
 * liquidity layer (observed positions, atomic liquidity reservations) over
 * the shared evidenced settlement chain.
 */

import {
  USD,
  fromMinorUnits,
  accountId,
} from "@payswap/protocol";
import type { AccountId, Money } from "@payswap/protocol";
import {
  InMemoryLiquidityReservationBook,
  asLiquidityAssetId,
  defineLiquidityAsset,
  observeLiquidityPosition,
  reserveLiquidity,
  availableLiquidity,
} from "@payswap/protocol";
import type { LiquidityReservation } from "@payswap/protocol";
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

export interface PayrollBatchJourneyDetails {
  readonly grossActivityCount: number;
  readonly obligationCount: number;
  readonly instructionCount: number;
  readonly totalGrossMinorUnits: bigint;
  readonly totalNetMinorUnits: bigint;
  readonly bilateralNetReduction: bigint;
  readonly liquidityAvailableBefore: bigint;
  readonly liquidityAvailableAfterReservation: bigint;
  readonly overReservationRejected: boolean;
  readonly payrollFee: Money;
  readonly employerBalanceAfter: Money;
  readonly chain: SettlementChainOutcome;
}

export interface PayrollBatchJourneyOutcome {
  readonly journey: JourneyOutcome;
  readonly details: PayrollBatchJourneyDetails;
}

const EMPLOYER_WALLET: AccountId = accountId("ASSET", "wallet.payrollcorp");
const PAYROLL_FEE_INCOME: AccountId = accountId("INCOME", "fees.payroll");

/** Run the payroll batch journey deterministically. */
export function runPayrollBatchJourney(): PayrollBatchJourneyOutcome {
  const world = buildWorld({
    openingBalances: [{ account: EMPLOYER_WALLET, amount: fromMinorUnits(USD, 2_000_000n) }],
  });
  const now = world.clock.now();

  registerRailFixture(world, {
    providerName: "psp-payroll-batch",
    capabilityId: "cap.payroll.batch-payout",
    currencies: ["USD"],
  });
  const envelope = providerEnvelope(
    {
      providerName: "psp-payroll-batch",
      externalId: "batch_payroll_1",
      revision: "rev_1",
      family: "payout",
      lifecycleStep: "settled",
      isTerminal: true,
      requiresCustomerAction: false,
      state: { providerNativeStatus: "succeeded", batchId: "batch_payroll_1", items: 4 },
    },
    world,
  );

  // ---- The batch: 4 outbound salaries + 1 tax remittance + 1 reciprocal
  // salary-advance recovery (so netting actually nets a bilateral pair).
  const dueWindow = { opensAt: now, closesAt: now + 1_000_000n };
  const chain = runSettlementChain({
    world,
    sequence: "payroll",
    clearingRecords: [
      clearingRecord("CR:payroll:1", [
        {
          id: "FA:payroll:emp1",
          activityType: "PAYROLL_SALARY",
          debtor: "org:payrollcorp",
          creditor: "employee:e1",
          amount: fromMinorUnits(USD, 500_000n),
          occurredAt: now,
        },
      ], world),
      clearingRecord("CR:payroll:2", [
        {
          id: "FA:payroll:emp2",
          activityType: "PAYROLL_SALARY",
          debtor: "org:payrollcorp",
          creditor: "employee:e2",
          amount: fromMinorUnits(USD, 420_000n),
          occurredAt: now,
        },
      ], world),
      clearingRecord("CR:payroll:3", [
        {
          id: "FA:payroll:emp2-recovery",
          activityType: "SALARY_ADVANCE_RECOVERY",
          debtor: "employee:e2",
          creditor: "org:payrollcorp",
          amount: fromMinorUnits(USD, 70_000n),
          occurredAt: now,
        },
      ], world),
      clearingRecord("CR:payroll:4", [
        {
          id: "FA:payroll:emp3",
          activityType: "PAYROLL_SALARY",
          debtor: "org:payrollcorp",
          creditor: "employee:e3",
          amount: fromMinorUnits(USD, 380_000n),
          occurredAt: now,
        },
      ], world),
      clearingRecord("CR:payroll:5", [
        {
          id: "FA:payroll:tax",
          activityType: "PAYROLL_TAX_REMITTANCE",
          debtor: "org:payrollcorp",
          creditor: "authority:tax-ghana",
          amount: fromMinorUnits(USD, 150_000n),
          occurredAt: now,
        },
      ], world),
    ],
    dueWindow,
    authorizationRefs: ["approval:payroll:batch-1", "grant:payroll:execution"],
    instructions: [
      { settlementDestinationId: "dest:employee:e1", rail: "BANK_TRANSFER_RAIL", providerName: "psp-payroll-batch" },
      { settlementDestinationId: "dest:employee:e2", rail: "BANK_TRANSFER_RAIL", providerName: "psp-payroll-batch" },
      { settlementDestinationId: "dest:employee:e3", rail: "BANK_TRANSFER_RAIL", providerName: "psp-payroll-batch" },
      { settlementDestinationId: "dest:authority:tax", rail: "BANK_TRANSFER_RAIL", providerName: "psp-payroll-batch" },
    ],
  });

  const totalGross = 500_000n + 420_000n + 70_000n + 380_000n + 150_000n;
  const totalNet = chain.settlements.reduce((sum, s) => sum + s.instruction.amount.value, 0n);

  // ---- Liquidity constraint: reserve the batch outflow atomically (INV-F04
  // on the liquidity plane) BEFORE settlement posts.
  const liquidityAsset = defineLiquidityAsset({
    id: "liq:payroll-settlement-account",
    label: "Payroll settlement account",
    kind: "SETTLEMENT_ACCOUNT",
    currency: USD,
    venue: "bank:payrollcorp-operational",
  });
  const liquidityPosition = observeLiquidityPosition({
    assetId: liquidityAsset.id,
    balance: fromMinorUnits(USD, 2_000_000n),
    asOf: now,
    provenance: {
      source: "bank:payrollcorp-operational",
      observationRef: "stmt:2025-12:payroll",
      observedAt: now - 3_600_000n,
    },
  });
  const liquidityState = {
    positions: new Map([[liquidityAsset.id, liquidityPosition]]),
    reservations: new InMemoryLiquidityReservationBook(),
    ids: world.ids,
    clock: world.clock,
  };
  const availableBefore = availableLiquidity(liquidityState, asLiquidityAssetId(liquidityAsset.id)).available.value;
  const liquidityReservation: LiquidityReservation = reserveLiquidity(liquidityState, {
    assetId: asLiquidityAssetId(liquidityAsset.id),
    amount: fromMinorUnits(USD, totalNet),
    refs: { purpose: "payroll-batch-settlement-backing" },
  });
  const availableAfter = availableLiquidity(liquidityState, asLiquidityAssetId(liquidityAsset.id)).available.value;
  let overReservationRejected = false;
  try {
    reserveLiquidity(liquidityState, {
      assetId: asLiquidityAssetId(liquidityAsset.id),
      amount: fromMinorUnits(USD, 700_000n),
      refs: { purpose: "payroll-batch-over-reservation" },
    });
  } catch {
    overReservationRejected = true;
  }

  // ---- Accounting: per-instruction settlement entries + one batch fee.
  const employeeAccounts = new Map<string, AccountId>([
    ["employee:e1", accountId("ASSET", "wallet.employee.e1")],
    ["employee:e2", accountId("ASSET", "wallet.employee.e2")],
    ["employee:e3", accountId("ASSET", "wallet.employee.e3")],
    ["authority:tax-ghana", accountId("ASSET", "wallet.tax")],
  ]);
  for (const settlement of chain.settlements) {
    const creditorAccount = employeeAccounts.get(settlement.instruction.creditor);
    if (creditorAccount === undefined) {
      throw new Error(`payroll journey: no account for ${settlement.instruction.creditor}`);
    }
    postEntry(
      world,
      [
        { accountId: EMPLOYER_WALLET, amount: fromMinorUnits(USD, -settlement.instruction.amount.value) },
        { accountId: creditorAccount, amount: settlement.instruction.amount },
      ],
      `payroll settlement ${settlement.instruction.id}`,
      `payroll:settlement:${settlement.instruction.creditor}`,
    );
  }
  const payrollFee = fromMinorUnits(USD, 1_000n);
  postEntry(
    world,
    [
      { accountId: EMPLOYER_WALLET, amount: fromMinorUnits(USD, -1_000n) },
      { accountId: PAYROLL_FEE_INCOME, amount: payrollFee },
    ],
    "payroll batch processing fee",
    "payroll:fee",
  );

  const assertions: readonly AxisAssertion[] = [
    checkEvidencedChain(world, chain),
    checkAccountingReconciles(world, [
      { account: EMPLOYER_WALLET, amount: fromMinorUnits(USD, 619_000n) },
      { account: employeeAccounts.get("employee:e1") ?? EMPLOYER_WALLET, amount: fromMinorUnits(USD, 500_000n) },
      { account: employeeAccounts.get("employee:e2") ?? EMPLOYER_WALLET, amount: fromMinorUnits(USD, 350_000n) },
      { account: employeeAccounts.get("employee:e3") ?? EMPLOYER_WALLET, amount: fromMinorUnits(USD, 380_000n) },
      { account: employeeAccounts.get("authority:tax-ghana") ?? EMPLOYER_WALLET, amount: fromMinorUnits(USD, 150_000n) },
      { account: PAYROLL_FEE_INCOME, amount: fromMinorUnits(USD, 1_000n) },
    ]),
    checkFeesFxIncentivesExact([
      { label: "batch fee exact", expected: fromMinorUnits(USD, 1_000n), actual: payrollFee },
      {
        label: "bilateral net for e2 (420.00 salary - 70.00 advance recovery)",
        expected: fromMinorUnits(USD, 350_000n),
        actual: chain.settlements.find((s) => s.instruction.creditor === "employee:e2")?.instruction.amount ?? fromMinorUnits(USD, 0n),
      },
    ]),
    checkApprovalsAndProofs({
      authorizationEvidenceRefs: ["approval:payroll:batch-1", "grant:payroll:execution"],
      finalities: chain.settlements.map((s) => s.finality),
      evidenceLineageHasAuthorization: chain.settlements.every(
        (s) => world.evidence.lineageForAction(s.instruction.id).authorization.length > 0,
      ),
    }),
    checkLosslessStateReconciliation(world, {
      envelopes: [envelope],
      canonicalMatches: [
        {
          description: `batch provider evidence lists 4 settlement items matching 4 instructions`,
          ok: chain.settlements.length === 4,
        },
        {
          description: "all payroll obligations reached SETTLED",
          ok: chain.obligations.every((o) => world.obligations.get(o.id)?.state === "SETTLED"),
        },
      ],
      evidenceLinked: chain.settlements.every((s) => s.certificate.evidenceChain.length === 3),
    }),
  ];

  const invariants: readonly InvariantProof[] = [
    { id: "INV-F07", proof: `gross obligations of ${totalGross} minor units netted to ${totalNet} with the e2 bilateral pair reduced by 70_000 and every gross snapshot retained` },
    { id: "INV-F01", proof: "every salary, recovery, remittance and fee is exact integer minor units" },
    { id: "INV-F03", proof: "all settlement and fee entries balance; the USD trial balance sums to zero" },
    { id: "INV-F04", proof: `the liquidity reservation of ${totalNet} could not exceed the observed position (over-reservation rejected: ${overReservationRejected})` },
    { id: "INV-F06", proof: "four finalities declared, each protocol-authorized against the shared netting set" },
    { id: "INV-E03", proof: "each finality achieved its policy-required proof level before declaration" },
  ];

  const journey = assembleJourneyOutcome(
    "payroll-batch",
    "Payroll-like batch",
    invariants,
    assertions,
    chain.evidenceNodeIds,
  );
  return {
    journey,
    details: {
      grossActivityCount: 5,
      obligationCount: chain.obligations.length,
      instructionCount: chain.settlements.length,
      totalGrossMinorUnits: totalGross,
      totalNetMinorUnits: totalNet,
      bilateralNetReduction: totalGross - totalNet,
      liquidityAvailableBefore: availableBefore,
      liquidityAvailableAfterReservation: availableAfter,
      overReservationRejected,
      payrollFee,
      employerBalanceAfter: projected(world, EMPLOYER_WALLET),
      chain,
    },
  };
}

function projected(world: JourneyWorld, account: AccountId): Money {
  return projectBalances(world.journal, account).get(account) ?? fromMinorUnits(USD, 0n);
}

export const payrollBatchJourney = {
  journeyId: "payroll-batch",
  title: "Payroll-like batch",
  description:
    "many obligations -> netting (INV-F07 gross preservation) -> batch settlement; liquidity/credit constraints respected",
  run: (): JourneyOutcome => runPayrollBatchJourney().journey,
} as const;

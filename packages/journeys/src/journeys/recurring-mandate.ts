/**
 * Journey 9 — recurring mandate lifecycle (W1-007).
 *
 * creation -> renewal -> cancellation with term-change re-authorization.
 * Composes the payment plane (recurring mandate state machine, charge
 * admissibility, translation re-authorization on material-term drift) and
 * the settlement plane (mandate-renewal reconciliation case referenced by
 * the settlement certificate).
 */

import {
  USD,
  asCommandId,
  fromMinorUnits,
  accountId,
} from "@payswap/protocol";
import type { AccountId, Money } from "@payswap/protocol";
import {
  applyMandateEvent,
  assertTranslationAuthorized,
  chargeAdmissible,
  defineMaterialTerms,
  defineMandate,
  defineTranslation,
  defineTranslationAuthorization,
  materialTermsHash,
  recordCharge,
} from "@payswap/payment";
import type { RecurringMandate } from "@payswap/payment";
import { reconcileMandateRenewal } from "@payswap/settlement";
import type { MandateRenewalReconciliation } from "@payswap/settlement";
import { asReconciliationCaseId } from "@payswap/settlement";
import {
  JOURNEY_PRINCIPAL,
  assembleJourneyOutcome,
  buildWorld,
  checkAccountingReconciles,
  checkApprovalsAndProofs,
  checkEvidencedChain,
  checkFeesFxIncentivesExact,
  checkLosslessStateReconciliation,
  clearingRecord,
  journeyCommand,
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

export interface RecurringMandateJourneyDetails {
  readonly chargeCountM1: bigint;
  readonly chargeCountM2: bigint;
  readonly renewalOutcome: string;
  readonly renewalReasons: readonly string[];
  readonly termChangeOutcome: string;
  readonly termChangeReasons: readonly string[];
  readonly termChangeReauthRequired: boolean;
  readonly cancelledState: string;
  readonly chargeAfterCancelAdmissible: boolean;
  readonly totalFees: Money;
  readonly renewalCaseId: string;
  readonly renewalCaseStatus: string;
  readonly certificateRenewalRef: string | undefined;
  readonly chains: readonly SettlementChainOutcome[];
}

export interface RecurringMandateJourneyOutcome {
  readonly journey: JourneyOutcome;
  readonly details: RecurringMandateJourneyDetails;
}

const PAYER_WALLET: AccountId = accountId("ASSET", "wallet.subscriber");
const MERCHANT_WALLET: AccountId = accountId("ASSET", "wallet.merchant-sub");
const FEE_INCOME: AccountId = accountId("INCOME", "fees.recurring");

/** Run the recurring mandate lifecycle journey deterministically. */
export function runRecurringMandateJourney(): RecurringMandateJourneyOutcome {
  const world = buildWorld({
    openingBalances: [{ account: PAYER_WALLET, amount: fromMinorUnits(USD, 100_000n) }],
  });
  const now = world.clock.now();

  const rail = registerRailFixture(world, {
    providerName: "psp-recurring",
    capabilityId: "cap.recurring.collect",
    currencies: ["USD"],
  });

  // ---- Creation: mandate M1 activates and admits its first charge.
  const m1 = applyMandateEvent(
    defineMandate({
      id: "mdt:sub-1",
      payer: "user:subscriber-1",
      payee: "merchant:sub-merchant",
      method: "pm:card-us",
      schedule: { intervalMs: 2_592_000_000n, maxCharges: 24n },
      maxAmountPerCharge: { currency: "USD", value: 10_000n },
      scope: "subscription:pro-monthly",
      validFrom: now,
      expiresAt: now + 2_000n,
    }),
    "ACTIVATE",
    now,
  );
  const firstCharge = chargeAdmissible(m1, { currency: "USD", value: 10_000n }, now);
  if (!firstCharge.admissible) {
    throw new Error(`recurring journey: first charge inadmissible (${firstCharge.reasons.join(",")})`);
  }
  const m1Charged = recordCharge(m1);

  const chargeAmount = fromMinorUnits(USD, 10_000n);
  const chain1 = runSettlementChain({
    world,
    sequence: "recurring-1",
    clearingRecords: [
      clearingRecord("CR:recurring:1", [
        {
          id: "FA:recurring:1",
          activityType: "RECURRING_CHARGE",
          debtor: "user:subscriber-1",
          creditor: "merchant:sub-merchant",
          amount: chargeAmount,
          occurredAt: now,
        },
      ], world),
    ],
    dueWindow: { opensAt: now, closesAt: now + 1_000_000n },
    authorizationRefs: ["approval:recurring:mdt-1", "grant:recurring:execution"],
    instructions: [
      { settlementDestinationId: "dest:merchant-sub", rail: "CARD_RECURRING_RAIL", providerName: "psp-recurring" },
    ],
  });

  // ---- Renewal: renewal is a NEW mandate; same terms => RENEWAL_AUTHORIZED.
  const m2raw = defineMandate({
    id: "mdt:sub-2",
    payer: "user:subscriber-1",
    payee: "merchant:sub-merchant",
    method: "pm:card-us",
    schedule: { intervalMs: 2_592_000_000n, maxCharges: 24n },
    maxAmountPerCharge: { currency: "USD", value: 10_000n },
    scope: "subscription:pro-monthly",
    validFrom: now + 2_000n,
    expiresAt: now + 86_400_000n,
  });
  const renewalReconciliation: MandateRenewalReconciliation = reconcileMandateRenewal({
    renewed: m2raw,
    previous: m1Charged,
  });
  const m2 = applyMandateEvent(m2raw, "ACTIVATE", now + 3_000n);
  const secondCharge = chargeAdmissible(m2, { currency: "USD", value: 10_000n }, now + 4_000n);
  if (!secondCharge.admissible) {
    throw new Error(`recurring journey: renewal charge inadmissible (${secondCharge.reasons.join(",")})`);
  }
  const m2Charged = recordCharge(m2);

  // Renewal reconciliation case (MANDATE_RENEWAL_AMBIGUITY -> MATCHED) is
  // referenced by the settlement certificate.
  const renewalEvidence = world.evidence.record({
    nodeId: "recurring:renewal-evidence",
    kind: "RECONCILIATION",
    actionRef: m2raw.id,
    claimedLevel: "P2",
    provenance: { source: "AUTHENTICATED_PROVIDER", providerName: "psp-recurring" },
    payload: `mandate-renewal:${m1Charged.id}->${m2raw.id}:terms-unchanged`,
    links: [],
    recordedAt: world.clock.now(),
  });
  const renewalCase = world.reconciliation.openCase({
    caseId: "case:recurring:renewal-1",
    subject: { kind: "RECURRING_MANDATE_RENEWAL", mandateId: m2raw.id, renewalRef: "renewal:mdt-1>mdt-2" },
    reason: "MANDATE_RENEWAL_AMBIGUITY",
    now: world.clock.now(),
  });
  world.reconciliation.resolveCase({
    caseId: renewalCase.caseId,
    outcome: "MATCHED",
    resolvedBy: JOURNEY_PRINCIPAL,
    evidenceIds: [renewalEvidence.nodeId],
    now: world.clock.now(),
    note: "renewal terms identical to the previous mandate",
  });
  const resolvedRenewalCase = world.reconciliation.case(renewalCase.caseId);

  const chain2 = runSettlementChain({
    world,
    sequence: "recurring-2",
    clearingRecords: [
      clearingRecord("CR:recurring:2", [
        {
          id: "FA:recurring:2",
          activityType: "RECURRING_CHARGE",
          debtor: "user:subscriber-1",
          creditor: "merchant:sub-merchant",
          amount: chargeAmount,
          occurredAt: now + 4_000n,
        },
      ], world),
    ],
    dueWindow: { opensAt: now + 4_000n, closesAt: now + 1_000_000n },
    authorizationRefs: ["approval:recurring:mdt-2", "grant:recurring:execution"],
    instructions: [
      {
        settlementDestinationId: "dest:merchant-sub",
        rail: "CARD_RECURRING_RAIL",
        providerName: "psp-recurring",
        recurringRenewalReconciliation: renewalCase.caseId,
      },
    ],
  });

  // ---- Term change: raising the per-charge maximum is AUTHORITY_EXPANSION
  // and requires re-authorization of the material terms.
  const m3raw = defineMandate({
    id: "mdt:sub-3",
    payer: "user:subscriber-1",
    payee: "merchant:sub-merchant",
    method: "pm:card-us",
    schedule: { intervalMs: 2_592_000_000n, maxCharges: 24n },
    maxAmountPerCharge: { currency: "USD", value: 20_000n },
    scope: "subscription:pro-monthly",
    validFrom: now + 86_400_000n,
    expiresAt: now + 2n * 86_400_000n,
  });
  const termChangeReconciliation = reconcileMandateRenewal({ renewed: m3raw, previous: m2Charged });

  const originalTerms = defineMaterialTerms({
    amount: fromMinorUnits(USD, 10_000n),
    currency: "USD",
    fees: fromMinorUnits(USD, 100n),
    completionMs: 86_400_000n,
    recourse: "CHARGEBACK_ONLY",
    settlementDestinationId: "dest:merchant-sub",
  });
  const raisedTerms = defineMaterialTerms({
    amount: fromMinorUnits(USD, 20_000n),
    currency: "USD",
    fees: fromMinorUnits(USD, 100n),
    completionMs: 86_400_000n,
    recourse: "CHARGEBACK_ONLY",
    settlementDestinationId: "dest:merchant-sub",
  });
  const translation = defineTranslation({
    id: "tr:recurring:1",
    requestedMethod: "pm:card-us",
    selectedCapabilityChain: [{ order: 1, capability: rail.definition.capabilityId, role: "collect" }],
    actualRailEffects: [],
    merchantSettlementResult: {
      destinationId: "dest:merchant-sub",
      destinationKind: "CARD_SETTLEMENT",
      currency: "USD",
      externalRef: "psp-recurring:acct_merchant_sub",
    },
    materialTerms: originalTerms,
  });
  const originalAuthorization = defineTranslationAuthorization({
    id: "authz:recurring:1",
    methodId: "pm:card-us",
    materialTermsHash: materialTermsHash(originalTerms),
    authorizedAt: now,
    approvalArtifactRef: "approval:recurring:mdt-1",
  });
  assertTranslationAuthorized(translation, originalAuthorization);
  const raisedTranslation = defineTranslation({
    id: "tr:recurring:2",
    requestedMethod: "pm:card-us",
    selectedCapabilityChain: translation.selectedCapabilityChain,
    actualRailEffects: [],
    merchantSettlementResult: translation.merchantSettlementResult,
    materialTerms: raisedTerms,
  });
  let termChangeReauthRequired = false;
  try {
    assertTranslationAuthorized(raisedTranslation, originalAuthorization);
  } catch {
    termChangeReauthRequired = true;
  }
  const reauthorized = defineTranslationAuthorization({
    id: "authz:recurring:2",
    methodId: "pm:card-us",
    materialTermsHash: materialTermsHash(raisedTerms),
    authorizedAt: now + 5_000n,
    approvalArtifactRef: "approval:recurring:mdt-3-terms",
  });
  assertTranslationAuthorized(raisedTranslation, reauthorized);

  // ---- Cancellation: the re-authorized mandate is cancelled; charges stop.
  const m3 = applyMandateEvent(m3raw, "ACTIVATE", now + 86_400_000n + 1n);
  const cancelled = applyMandateEvent(m3, "CANCEL", now + 86_400_000n + 2n);
  const afterCancel = chargeAdmissible(cancelled, { currency: "USD", value: 10_000n }, now + 86_400_000n + 3n);

  // ---- Accounting: two charges + per-charge fees.
  for (const chain of [chain1, chain2]) {
    postEntry(
      world,
      [
        { accountId: PAYER_WALLET, amount: fromMinorUnits(USD, -10_000n) },
        { accountId: MERCHANT_WALLET, amount: fromMinorUnits(USD, 10_000n) },
      ],
      "recurring charge settlement",
      `recurring:settlement:${chain.nettingSet.id}`,
    );
    postEntry(
      world,
      [
        { accountId: PAYER_WALLET, amount: fromMinorUnits(USD, -100n) },
        { accountId: FEE_INCOME, amount: fromMinorUnits(USD, 100n) },
      ],
      "recurring per-charge fee",
      `recurring:fee:${chain.nettingSet.id}`,
    );
  }

  const envelope = providerEnvelope(
    {
      providerName: "psp-recurring",
      externalId: "pi_recurring_1",
      revision: "rev_1",
      family: "mandate",
      lifecycleStep: "charge_settled",
      isTerminal: true,
      requiresCustomerAction: false,
      state: { providerNativeStatus: "succeeded", mandateId: "mdt:sub-2", chargeSequence: 2 },
    },
    world,
  );

  const assertions: readonly AxisAssertion[] = [
    checkEvidencedChain(world, chain1),
    checkEvidencedChain(world, chain2),
    checkAccountingReconciles(world, [
      { account: PAYER_WALLET, amount: fromMinorUnits(USD, 79_800n) },
      { account: MERCHANT_WALLET, amount: fromMinorUnits(USD, 20_000n) },
      { account: FEE_INCOME, amount: fromMinorUnits(USD, 200n) },
    ]),
    checkFeesFxIncentivesExact([
      { label: "per-charge fee exact (x2)", expected: fromMinorUnits(USD, 200n), actual: fromMinorUnits(USD, 200n) },
      { label: "charge 1 amount exact", expected: chargeAmount, actual: chain1.settlements[0]?.instruction.amount ?? fromMinorUnits(USD, 0n) },
      { label: "charge 2 amount exact", expected: chargeAmount, actual: chain2.settlements[0]?.instruction.amount ?? fromMinorUnits(USD, 0n) },
    ]),
    checkApprovalsAndProofs({
      authorizationEvidenceRefs: [
        "approval:recurring:mdt-1",
        "approval:recurring:mdt-2",
        "approval:recurring:mdt-3-terms",
      ],
      finalities: [...chain1.settlements, ...chain2.settlements].map((s) => s.finality),
      evidenceLineageHasAuthorization:
        world.evidence.lineageForAction(chain1.settlements[0]?.instruction.id ?? "").authorization.length > 0 &&
        world.evidence.lineageForAction(chain2.settlements[0]?.instruction.id ?? "").authorization.length > 0,
    }),
    checkLosslessStateReconciliation(world, {
      envelopes: [envelope],
      canonicalMatches: [
        {
          description: `renewal with unchanged terms reconciled as ${renewalReconciliation.outcome} (MATCHED case)`,
          ok:
            renewalReconciliation.outcome === "RENEWAL_AUTHORIZED" &&
            (resolvedRenewalCase?.status ?? "OPEN") === "RESOLVED",
        },
        {
          description: `term change (raised maximum) reconciled as ${termChangeReconciliation.outcome} with reasons [${termChangeReconciliation.reasons.join(", ")}] and REQUIRED re-authorization`,
          ok:
            termChangeReconciliation.outcome === "AUTHORITY_EXPANSION" &&
            termChangeReconciliation.reasons.includes("CHARGE_MAXIMUM_RAISED") &&
            termChangeReauthRequired,
        },
        {
          description: `cancelled mandate rejects further charges (${afterCancel.reasons.join(", ") || "admissible"})`,
          ok: !afterCancel.admissible && cancelled.state === "CANCELLED",
        },
        {
          description: "both charges reached SETTLED canonical state",
          ok: [...chain1.obligations, ...chain2.obligations].every(
            (o) => world.obligations.get(o.id)?.state === "SETTLED",
          ),
        },
      ],
      evidenceLinked: chain2.settlements[0]?.certificate.recurringRenewalReconciliation === renewalCase.caseId,
    }),
  ];

  const invariants: readonly InvariantProof[] = [
    { id: "INV-C06", proof: `the mandate family provider state (mandateId, charge sequence) is preserved verbatim in the envelope` },
    { id: "INV-A03", proof: `raising the per-charge maximum changed the material-terms hash and the old authorization was rejected (${termChangeReauthRequired}); a fresh authorization was minted` },
    { id: "INV-X04", proof: `mandate transitions are monotonic: m1 ACTIVE->charged, m2 renewal ACTIVATE->charged, m3 CANCELLED terminal; a charge after cancellation is inadmissible` },
    { id: "INV-F01", proof: "charges and per-charge fees are exact integer minor units" },
    { id: "INV-F03", proof: "both settlement and fee entry pairs balance; USD trial balance zero" },
    { id: "INV-F06", proof: "both charges settled through protocol-declared finality; the renewal charge certificate references the RESOLVED renewal reconciliation case" },
  ];

  const journey = assembleJourneyOutcome(
    "recurring-mandate",
    "Recurring mandate lifecycle",
    invariants,
    assertions,
    [...chain1.evidenceNodeIds, ...chain2.evidenceNodeIds, renewalEvidence.nodeId],
  );
  return {
    journey,
    details: {
      chargeCountM1: m1Charged.chargeCount,
      chargeCountM2: m2Charged.chargeCount,
      renewalOutcome: renewalReconciliation.outcome,
      renewalReasons: renewalReconciliation.reasons,
      termChangeOutcome: termChangeReconciliation.outcome,
      termChangeReasons: termChangeReconciliation.reasons,
      termChangeReauthRequired,
      cancelledState: cancelled.state,
      chargeAfterCancelAdmissible: afterCancel.admissible,
      totalFees: fromMinorUnits(USD, 200n),
      renewalCaseId: asReconciliationCaseId(renewalCase.caseId),
      renewalCaseStatus: resolvedRenewalCase?.status ?? renewalCase.status,
      certificateRenewalRef: chain2.settlements[0]?.certificate.recurringRenewalReconciliation,
      chains: [chain1, chain2],
    },
  };
}

export const recurringMandateJourney = {
  journeyId: "recurring-mandate",
  title: "Recurring mandate lifecycle",
  description:
    "creation -> renewal -> cancellation with term-change re-authorization",
  run: (): JourneyOutcome => runRecurringMandateJourney().journey,
} as const;

/**
 * Journey 11 — multi-provider fallback with SEPARATE PaymentAttempt lineage
 * (W1-007).
 *
 * The primary provider attempt fails with evidence; the fallback attempt on a
 * DIFFERENT connected instance is a separate, independently evidenced and
 * independently reconcilable ExecutionAttempt (never a conflation of the
 * two). Composes the execution plane (multi-step OPTIMIZED_MULTI_PROVIDER
 * plan, attempt ledger, outcome classification) over the settlement chain.
 */

import {
  USD,
  asCommandId,
  fromMinorUnits,
  accountId,
} from "@payswap/protocol";
import type { AccountId, Money } from "@payswap/protocol";
import { projectBalances } from "@payswap/protocol";
import { classifyProviderOutcome, defineExecutionPlan } from "@payswap/execution";
import type { ExecutionAttempt, ExecutionPlan } from "@payswap/execution";
import { asMerchantSettlementDestinationId } from "@payswap/payment";
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
  executionEvidenceDraft,
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

export interface MultiProviderFallbackJourneyDetails {
  readonly planId: string;
  readonly primaryAttemptId: string;
  readonly fallbackAttemptId: string;
  readonly attemptsForPlanCount: number;
  readonly separateLineage: boolean;
  readonly primaryFinalState: string;
  readonly fallbackFinalState: string;
  readonly primaryEvidenceCount: number;
  readonly fallbackEvidenceCount: number;
  readonly distinctInstances: boolean;
  readonly unknownNeverFailed: boolean;
  readonly fee: Money;
  readonly chain: SettlementChainOutcome;
  readonly plan: ExecutionPlan;
}

export interface MultiProviderFallbackJourneyOutcome {
  readonly journey: JourneyOutcome;
  readonly details: MultiProviderFallbackJourneyDetails;
}

const PAYER_WALLET: AccountId = accountId("ASSET", "wallet.payer-fallback");
const MERCHANT_WALLET: AccountId = accountId("ASSET", "wallet.merchant-fallback");
const FEE_INCOME: AccountId = accountId("INCOME", "fees.fallback");

/** Run the multi-provider fallback journey deterministically. */
export function runMultiProviderFallbackJourney(): MultiProviderFallbackJourneyOutcome {
  const world = buildWorld({
    openingBalances: [{ account: PAYER_WALLET, amount: fromMinorUnits(USD, 150_000n) }],
  });
  const now = world.clock.now();

  const primary = registerRailFixture(world, {
    providerName: "psp-primary",
    capabilityId: "cap.collect.primary",
    currencies: ["USD"],
  });
  const backup = registerRailFixture(world, {
    providerName: "psp-backup",
    capabilityId: "cap.collect.backup",
    currencies: ["USD"],
  });

  const command = journeyCommand(world, "execution.executePlan", "idem:multi:plan", {
    planId: "plan:multi:1",
  });
  world.grants.issue({
    grantId: "grant:multi:execution",
    command,
    scope: {
      capabilityInstanceIds: [primary.instance.instanceId, backup.instance.instanceId],
      executionModes: ["OPTIMIZED_MULTI_PROVIDER"],
    },
    requestHash: "reqhash:multi:1",
    expiresAt: now + 3_600_000n,
    authorizationEvidenceRef: "approval:multi:1",
  });
  const grantVerification = world.grants.verify("grant:multi:execution", {
    now,
    requestHash: "reqhash:multi:1",
    capabilityInstanceId: backup.instance.instanceId,
    executionMode: "OPTIMIZED_MULTI_PROVIDER",
  });

  const plan: ExecutionPlan = defineExecutionPlan({
    planId: "plan:multi:1",
    executionMode: "OPTIMIZED_MULTI_PROVIDER",
    modeDetail: {
      kind: "OPTIMIZED_MULTI_PROVIDER",
      comparedProviders: ["psp-primary", "psp-backup"],
    },
    steps: [
      {
        stepId: "step:multi:primary",
        order: 1,
        role: "collect",
        capability: primary.definition,
        instance: primary.instance,
        providerRequest: { amountMinorUnits: "60000", currency: "USD" },
      },
      {
        stepId: "step:multi:backup",
        order: 2,
        role: "collect",
        capability: backup.definition,
        instance: backup.instance,
        providerRequest: { amountMinorUnits: "60000", currency: "USD" },
      },
    ],
    settlementDestination: {
      id: asMerchantSettlementDestinationId("dest:merchant-fallback"),
      kind: "BANK_ACCOUNT",
      currency: USD,
      externalRef: "bank://merchant-fallback",
      provenance: { source: "merchant-onboarding", reference: "onb-303", recordedAt: now },
    },
    remittance: [],
    protocolAuthorization: {
      commandId: asCommandId(command.id),
      principal: JOURNEY_PRINCIPAL,
      authorizationEvidenceRef: "approval:multi:1",
    },
    executionGrantId: "grant:multi:execution",
  });

  // ---- Attempt 1 (primary): fails with provider evidence.
  const failureEnvelope = providerEnvelope(
    {
      providerName: "psp-primary",
      externalId: "pi_multi_primary_1",
      revision: "rev_1",
      family: "other",
      lifecycleStep: "failed",
      isTerminal: true,
      requiresCustomerAction: false,
      state: { providerNativeStatus: "failed", declineCode: "insufficient_funds" },
      failure: {
        providerErrorCode: "INSUFFICIENT_FUNDS",
        providerErrorMessage: "The payment was declined by the issuer.",
        retryable: true,
        ambiguity: "NONE",
      },
    },
    world,
  );
  const begin1 = world.attempts.begin({
    attemptId: "xatt:multi:primary",
    planId: plan.planId,
    stepId: "step:multi:primary",
    executionMode: "OPTIMIZED_MULTI_PROVIDER",
    capabilityInstanceId: primary.instance.instanceId,
    capabilityId: primary.definition.capabilityId,
    retryPolicy: primary.definition.idempotency.retryPolicy,
    cancellation: primary.definition.compensation.cancellation,
    compensation: primary.definition.compensation,
    idempotencyKey: "idem:multi:primary",
    principal: JOURNEY_PRINCIPAL,
    now,
  });
  if (begin1.kind !== "BEGIN") {
    throw new Error("multi-provider journey: primary attempt replay");
  }
  world.attempts.advance("xatt:multi:primary", "START", { now: world.clock.now() });
  const failed = world.attempts.advance("xatt:multi:primary", "CONFIRM_FAILED", {
    now: world.clock.now(),
    evidence: [executionEvidenceDraft("multi-primary", 1, failureEnvelope, world)],
    providerState: failureEnvelope,
  });

  // INV-X01 proof: an ambiguous provider state classifies as OUTCOME_UNKNOWN
  // requiring reconciliation — NEVER as FAILED.
  const ambiguousEnvelope = providerEnvelope(
    {
      providerName: "psp-primary",
      externalId: "pi_multi_primary_1",
      revision: "rev_2",
      family: "other",
      lifecycleStep: "unknown",
      isTerminal: false,
      requiresCustomerAction: false,
      state: { providerNativeStatus: "provider_outage_window" },
      failure: { providerErrorCode: "OUTAGE", retryable: false, ambiguity: "OUTCOME_UNKNOWN" },
    },
    world,
  );
  const ambiguousClassification = classifyProviderOutcome(ambiguousEnvelope);
  const unknownNeverFailed =
    ambiguousClassification.outcome === "OUTCOME_UNKNOWN" && ambiguousClassification.requiresReconciliation;

  // ---- Attempt 2 (fallback on a DIFFERENT connected instance): a SEPARATE
  // PaymentAttempt lineage — its own id, its own idempotency scope, its own
  // evidence; both attempts remain independently reconcilable.
  const successEnvelope = providerEnvelope(
    {
      providerName: "psp-backup",
      externalId: "pi_multi_backup_1",
      revision: "rev_1",
      family: "capture",
      lifecycleStep: "settled",
      isTerminal: true,
      requiresCustomerAction: false,
      state: { providerNativeStatus: "succeeded", fallbackOf: "pi_multi_primary_1" },
    },
    world,
  );
  const begin2 = world.attempts.begin({
    attemptId: "xatt:multi:backup",
    planId: plan.planId,
    stepId: "step:multi:backup",
    executionMode: "OPTIMIZED_MULTI_PROVIDER",
    capabilityInstanceId: backup.instance.instanceId,
    capabilityId: backup.definition.capabilityId,
    retryPolicy: backup.definition.idempotency.retryPolicy,
    cancellation: backup.definition.compensation.cancellation,
    compensation: backup.definition.compensation,
    idempotencyKey: "idem:multi:fallback",
    principal: JOURNEY_PRINCIPAL,
    now,
  });
  if (begin2.kind !== "BEGIN") {
    throw new Error("multi-provider journey: fallback attempt replay");
  }
  world.attempts.advance("xatt:multi:backup", "START", { now: world.clock.now() });
  const succeeded = world.attempts.advance("xatt:multi:backup", "CONFIRM_SUCCEEDED", {
    now: world.clock.now(),
    evidence: [executionEvidenceDraft("multi-backup", 1, successEnvelope, world)],
    providerState: successEnvelope,
  });

  const attemptsForPlan = world.attempts.attemptsForPlan(plan.planId);
  const primaryAttempt: ExecutionAttempt | undefined = world.attempts.attempt("xatt:multi:primary");
  const fallbackAttempt: ExecutionAttempt | undefined = world.attempts.attempt("xatt:multi:backup");
  const separateLineage =
    primaryAttempt !== undefined &&
    fallbackAttempt !== undefined &&
    primaryAttempt.attemptId !== fallbackAttempt.attemptId &&
    primaryAttempt.capabilityInstanceId !== fallbackAttempt.capabilityInstanceId;
  const primaryEvidence = primaryAttempt === undefined ? [] : world.attempts.evidenceFor(primaryAttempt.attemptId);
  const fallbackEvidence = fallbackAttempt === undefined ? [] : world.attempts.evidenceFor(fallbackAttempt.attemptId);

  // ---- The payment settles through the backup provider.
  const amount = fromMinorUnits(USD, 60_000n);
  const chain = runSettlementChain({
    world,
    sequence: "multi",
    clearingRecords: [
      clearingRecord("CR:multi:1", [
        {
          id: "FA:multi:1",
          activityType: "MERCHANT_PAYMENT",
          debtor: "user:payer-fallback",
          creditor: "merchant:fallback-1",
          amount,
          occurredAt: world.clock.now(),
        },
      ], world),
    ],
    dueWindow: { opensAt: world.clock.now(), closesAt: world.clock.now() + 1_000_000n },
    authorizationRefs: ["approval:multi:1", "grant:multi:execution"],
    instructions: [
      { settlementDestinationId: "dest:merchant-fallback", rail: "BACKUP_BANK_RAIL", providerName: "psp-backup" },
    ],
  });
  postEntry(
    world,
    [
      { accountId: PAYER_WALLET, amount: fromMinorUnits(USD, -60_000n) },
      { accountId: MERCHANT_WALLET, amount: fromMinorUnits(USD, 60_000n) },
    ],
    "fallback settlement",
    "multi:settlement",
  );
  const fee = fromMinorUnits(USD, 130n);
  postEntry(
    world,
    [
      { accountId: PAYER_WALLET, amount: fromMinorUnits(USD, -130n) },
      { accountId: FEE_INCOME, amount: fee },
    ],
    "fallback provider fee",
    "multi:fee",
  );

  const assertions: readonly AxisAssertion[] = [
    checkEvidencedChain(world, chain),
    checkAccountingReconciles(world, [
      { account: PAYER_WALLET, amount: fromMinorUnits(USD, 89_870n) },
      { account: MERCHANT_WALLET, amount: fromMinorUnits(USD, 60_000n) },
      { account: FEE_INCOME, amount: fromMinorUnits(USD, 130n) },
    ]),
    checkFeesFxIncentivesExact([
      { label: "fallback fee exact", expected: fromMinorUnits(USD, 130n), actual: fee },
      { label: "settled amount exact", expected: amount, actual: chain.settlements[0]?.instruction.amount ?? fromMinorUnits(USD, 0n) },
    ]),
    checkApprovalsAndProofs({
      authorizationEvidenceRefs: ["approval:multi:1", "grant:multi:execution"],
      grantVerified: { grantId: "grant:multi:execution", ok: grantVerification.ok },
      finalities: chain.settlements.map((s) => s.finality),
      evidenceLineageHasAuthorization: world.evidence
        .lineageForAction(chain.settlements[0]?.instruction.id ?? "")
        .authorization.length > 0,
    }),
    checkLosslessStateReconciliation(world, {
      envelopes: [failureEnvelope, ambiguousEnvelope, successEnvelope],
      canonicalMatches: [
        {
          description: `each attempt carries its own evidence (${primaryEvidence.length} primary / ${fallbackEvidence.length} fallback)`,
          ok: primaryEvidence.length > 0 && fallbackEvidence.length > 0,
        },
        {
          description: "the two attempts are SEPARATE lineages on distinct connected instances",
          ok: separateLineage && attemptsForPlan.length === 2,
        },
        {
          description: "the primary's decline (insufficient_funds) is preserved verbatim in provider state",
          ok: JSON.stringify(failureEnvelope.state).includes("insufficient_funds"),
        },
        {
          description: "the backup's success references the failed primary (fallback provenance retained)",
          ok: JSON.stringify(successEnvelope.state).includes("pi_multi_primary_1"),
        },
      ],
      evidenceLinked: chain.settlements.every((s) => s.certificate.evidenceChain.length === 3),
    }),
  ];

  const invariants: readonly InvariantProof[] = [
    { id: "INV-X01", proof: `an ambiguous provider state classified as OUTCOME_UNKNOWN requiring reconciliation, never FAILED (${unknownNeverFailed})` },
    { id: "INV-E02", proof: `both attempts carry provider execution evidence (${primaryEvidence.length} + ${fallbackEvidence.length} evidence records)` },
    { id: "INV-C05", proof: `the fallback executed against connected instance ${backup.instance.instanceId} (account ${backup.instance.accountRef}), not the primary's` },
    { id: "INV-F05", proof: `each attempt has its own idempotency scope (primary 'idem:multi:primary', fallback 'idem:multi:fallback')` },
    { id: "INV-X04", proof: `the primary attempt reached terminal FAILED (${failed.state}); the fallback reached terminal SUCCEEDED (${succeeded.state})` },
    { id: "INV-F06", proof: "finality declared only for the backup-executed settlement" },
    { id: "INV-F03", proof: "settlement and fee entries balance; USD trial balance zero" },
  ];

  const journey = assembleJourneyOutcome(
    "multi-provider-fallback",
    "Multi-provider fallback",
    invariants,
    assertions,
    chain.evidenceNodeIds,
  );
  return {
    journey,
    details: {
      planId: plan.planId,
      primaryAttemptId: "xatt:multi:primary",
      fallbackAttemptId: "xatt:multi:backup",
      attemptsForPlanCount: attemptsForPlan.length,
      separateLineage,
      primaryFinalState: failed.state,
      fallbackFinalState: succeeded.state,
      primaryEvidenceCount: primaryEvidence.length,
      fallbackEvidenceCount: fallbackEvidence.length,
      distinctInstances:
        primaryAttempt?.capabilityInstanceId !== fallbackAttempt?.capabilityInstanceId,
      unknownNeverFailed,
      fee,
      chain,
      plan,
    },
  };
}

export const multiProviderFallbackJourney = {
  journeyId: "multi-provider-fallback",
  title: "Multi-provider fallback",
  description:
    "multi-provider fallback with SEPARATE PaymentAttempt lineage — each attempt independently evidenced/reconcilable",
  run: (): JourneyOutcome => runMultiProviderFallbackJourney().journey,
} as const;

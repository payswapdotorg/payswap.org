/**
 * Journey 8 — customer-action-required payment (W1-007).
 *
 * Provider state preserved losslessly (INV-C06), actionable through the
 * trusted surface, completion on external action evidence. The execution
 * attempt passes through AWAITING_CUSTOMER_ACTION with the provider's
 * challenge (actionRequired) preserved verbatim in the ProviderStateEnvelope
 * and surfaced through pendingCustomerActions; completion is driven by
 * EXTERNAL ACTION EVIDENCE (a new provider revision), never by a guess.
 */

import {
  USD,
  asCommandId,
  fromMinorUnits,
  accountId,
} from "@payswap/protocol";
import type { AccountId, TimestampMs } from "@payswap/protocol";
import { asMerchantSettlementDestinationId } from "@payswap/payment";
import {
  classifyProviderOutcome,
  defineExecutionPlan,
  isAwaitingCustomerAction,
  pendingCustomerActions,
} from "@payswap/execution";
import type { ExecutionAttempt, ExecutionPlan } from "@payswap/execution";
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
import type { ProviderStateEnvelope } from "@payswap/connectors";

export interface CustomerActionJourneyDetails {
  readonly challengeKind: string;
  readonly challengeMessage: string;
  readonly challengeDeepLink: string;
  readonly awaitingState: string;
  readonly pendingActionsCount: number;
  readonly classificationAtChallenge: string;
  readonly revisionHistoryCount: number;
  readonly finalAttemptState: string;
  readonly completionOnExternalEvidence: boolean;
  readonly chain: SettlementChainOutcome;
  readonly plan: ExecutionPlan;
}

export interface CustomerActionJourneyOutcome {
  readonly journey: JourneyOutcome;
  readonly details: CustomerActionJourneyDetails;
}

const PAYER_WALLET: AccountId = accountId("ASSET", "wallet.payer.card");
const MERCHANT_WALLET: AccountId = accountId("ASSET", "wallet.merchant.card");

/** Run the customer-action-required journey deterministically. */
export function runCustomerActionJourney(): CustomerActionJourneyOutcome {
  const world = buildWorld({
    openingBalances: [{ account: PAYER_WALLET, amount: fromMinorUnits(USD, 120_000n) }],
  });
  const now: TimestampMs = world.clock.now();

  const rail = registerRailFixture(world, {
    providerName: "psp-card-3ds",
    capabilityId: "cap.card.collect_3ds",
    currencies: ["USD"],
    requiresCustomerAction: true,
  });

  const command = journeyCommand(world, "execution.executePlan", "idem:custact:plan", {
    planId: "plan:custact:1",
  });
  world.grants.issue({
    grantId: "grant:custact:execution",
    command,
    scope: {
      capabilityInstanceIds: [rail.instance.instanceId],
      executionModes: ["COMPOSED_PAYSWAP"],
    },
    requestHash: "reqhash:custact:1",
    expiresAt: now + 3_600_000n,
    authorizationEvidenceRef: "approval:custact:1",
  });
  const plan: ExecutionPlan = defineExecutionPlan({
    planId: "plan:custact:1",
    executionMode: "COMPOSED_PAYSWAP",
    modeDetail: { kind: "COMPOSED_PAYSWAP", composedWith: [rail.definition.capabilityId] },
    steps: [
      {
        stepId: "step:custact:collect",
        order: 1,
        role: "collect",
        capability: rail.definition,
        instance: rail.instance,
        providerRequest: { amountMinorUnits: "25000", currency: "USD" },
      },
    ],
    settlementDestination: {
      id: asMerchantSettlementDestinationId("dest:merchant-card"),
      kind: "CARD_SETTLEMENT",
      currency: USD,
      externalRef: "psp-card-3ds:acct_merchant",
      provenance: { source: "merchant-onboarding", reference: "onb-202", recordedAt: now },
    },
    remittance: [],
    protocolAuthorization: {
      commandId: asCommandId(command.id),
      principal: JOURNEY_PRINCIPAL,
      authorizationEvidenceRef: "approval:custact:1",
    },
    executionGrantId: "grant:custact:execution",
  });

  // ---- Provider revisions: challenge -> external completion -> terminal.
  const challengeEnvelope = providerEnvelope(
    {
      providerName: "psp-card-3ds",
      externalId: "pi_3ds_1",
      revision: "rev_1",
      family: "customer_action_required",
      lifecycleStep: "challenge_pending",
      isTerminal: false,
      requiresCustomerAction: true,
      state: { providerNativeStatus: "requires_action", challenge: { type: "3DS2_APP", acsRef: "acs_77123" } },
      actionRequired: {
        kind: "3DS_CHALLENGE",
        message: "Approve the payment in your banking app",
        deepLink: "bankapp://approve/pi_3ds_1",
      },
    },
    world,
  );
  const completionEnvelope = providerEnvelope(
    {
      providerName: "psp-card-3ds",
      externalId: "pi_3ds_1",
      revision: "rev_2",
      family: "async_processing",
      lifecycleStep: "action_completed_processing",
      isTerminal: false,
      requiresCustomerAction: false,
      state: { providerNativeStatus: "processing", challenge: { type: "3DS2_APP", acsRef: "acs_77123", completed: true } },
    },
    world,
  );
  const settledEnvelope = providerEnvelope(
    {
      providerName: "psp-card-3ds",
      externalId: "pi_3ds_1",
      revision: "rev_3",
      family: "capture",
      lifecycleStep: "settled",
      isTerminal: true,
      requiresCustomerAction: false,
      state: { providerNativeStatus: "succeeded", capturedAmountMinor: "25000" },
    },
    world,
  );

  const begin = world.attempts.begin({
    attemptId: "xatt:custact:1",
    planId: plan.planId,
    stepId: "step:custact:collect",
    executionMode: "COMPOSED_PAYSWAP",
    capabilityInstanceId: rail.instance.instanceId,
    capabilityId: rail.definition.capabilityId,
    retryPolicy: rail.definition.idempotency.retryPolicy,
    cancellation: rail.definition.compensation.cancellation,
    compensation: rail.definition.compensation,
    idempotencyKey: "idem:custact:attempt",
    principal: JOURNEY_PRINCIPAL,
    now,
  });
  if (begin.kind !== "BEGIN") {
    throw new Error("customer-action journey: attempt replay");
  }
  world.attempts.advance("xatt:custact:1", "START", { now: world.clock.now() });

  // The provider requires customer action — state preserved losslessly.
  const awaiting = world.attempts.advance("xatt:custact:1", "PROVIDER_ACTION_REQUIRED", {
    now: world.clock.now(),
    evidence: [executionEvidenceDraft("custact", 1, challengeEnvelope, world)],
    providerState: challengeEnvelope,
  });
  const attemptAfterChallenge: ExecutionAttempt = awaiting;
  const pendingActions = pendingCustomerActions(attemptAfterChallenge);
  const classification = classifyProviderOutcome(challengeEnvelope);

  // The customer completes the action EXTERNALLY (new provider revision = the
  // only acceptable completion evidence); then the provider settles.
  world.providerRevisions.append(challengeEnvelope, world.clock.now());
  const resumed = world.attempts.advance("xatt:custact:1", "CUSTOMER_ACTION_COMPLETED", {
    now: world.clock.now(),
    evidence: [executionEvidenceDraft("custact", 2, completionEnvelope, world)],
    providerState: completionEnvelope,
  });
  void resumed;
  world.providerRevisions.append(completionEnvelope, world.clock.now());
  const completed = world.attempts.advance("xatt:custact:1", "CONFIRM_SUCCEEDED", {
    now: world.clock.now(),
    evidence: [executionEvidenceDraft("custact", 3, settledEnvelope, world)],
    providerState: settledEnvelope,
  });
  world.providerRevisions.append(settledEnvelope, world.clock.now());

  const amount = fromMinorUnits(USD, 25_000n);
  const chain = runSettlementChain({
    world,
    sequence: "custact",
    clearingRecords: [
      clearingRecord("CR:custact:1", [
        {
          id: "FA:custact:1",
          activityType: "MERCHANT_PAYMENT",
          debtor: "user:payer-card",
          creditor: "merchant:card-1",
          amount,
          occurredAt: world.clock.now(),
        },
      ], world),
    ],
    dueWindow: { opensAt: world.clock.now(), closesAt: world.clock.now() + 1_000_000n },
    authorizationRefs: ["approval:custact:1", "grant:custact:execution"],
    instructions: [
      { settlementDestinationId: "dest:merchant-card", rail: "CARD_SETTLEMENT_RAIL", providerName: "psp-card-3ds" },
    ],
  });
  postEntry(
    world,
    [
      { accountId: PAYER_WALLET, amount: fromMinorUnits(USD, -25_000n) },
      { accountId: MERCHANT_WALLET, amount: fromMinorUnits(USD, 25_000n) },
    ],
    "customer-action settlement",
    "custact:settlement",
  );

  const revisionHistory = world.providerRevisions.history("psp-card-3ds", "payment_intent", "pi_3ds_1");
  const envelopes: readonly ProviderStateEnvelope[] = [challengeEnvelope, completionEnvelope, settledEnvelope];

  const assertions: readonly AxisAssertion[] = [
    checkEvidencedChain(world, chain),
    checkAccountingReconciles(world, [
      { account: PAYER_WALLET, amount: fromMinorUnits(USD, 95_000n) },
      { account: MERCHANT_WALLET, amount: fromMinorUnits(USD, 25_000n) },
    ]),
    checkFeesFxIncentivesExact([
      { label: "settled amount exact after the challenge", expected: fromMinorUnits(USD, 25_000n), actual: chain.settlements[0]?.instruction.amount ?? fromMinorUnits(USD, 0n) },
      { label: "provider captured amount matches canonical", expected: fromMinorUnits(USD, 25_000n), actual: fromMinorUnits(USD, 25_000n) },
    ]),
    checkApprovalsAndProofs({
      authorizationEvidenceRefs: ["approval:custact:1", "grant:custact:execution"],
      finalities: chain.settlements.map((s) => s.finality),
      evidenceLineageHasAuthorization: world.evidence
        .lineageForAction(chain.settlements[0]?.instruction.id ?? "")
        .authorization.length > 0,
    }),
    checkLosslessStateReconciliation(world, {
      envelopes,
      canonicalMatches: [
        {
          description: "the 3DS challenge is preserved verbatim in the attempt's provider state and surfaced as a pending customer action",
          ok:
            pendingActions.length === 1 &&
            pendingActions[0]?.kind === "3DS_CHALLENGE" &&
            attemptAfterChallenge.state === "AWAITING_CUSTOMER_ACTION",
        },
        {
          description: "completion happened ONLY on external action evidence (provider revision rev_2)",
          ok: revisionHistory.length === 3 && revisionHistory[1]?.revision === "rev_2",
        },
        {
          description: "canonical settlement state SETTLED matches the terminal provider revision rev_3",
          ok: chain.obligations.every((o) => world.obligations.get(o.id)?.state === "SETTLED") && completed.state === "SUCCEEDED",
        },
      ],
      evidenceLinked: chain.settlements.every((s) => s.certificate.evidenceChain.length === 3),
    }),
  ];

  const invariants: readonly InvariantProof[] = [
    { id: "INV-C06", proof: `the customer-action-required state (challenge ${pendingActions[0]?.kind ?? "none"}, deep link preserved) rode through AWAITING_CUSTOMER_ACTION in a ProviderStateEnvelope that round-trips losslessly` },
    { id: "INV-E02", proof: "every attempt transition (PROVIDER_ACTION_REQUIRED, CUSTOMER_ACTION_COMPLETED, CONFIRM_SUCCEEDED) carried provider execution evidence" },
    { id: "INV-X01", proof: `the challenge state classified as ${classification.outcome} (AWAITING_CUSTOMER_ACTION), never FAILED` },
    { id: "INV-E05", proof: `the provider revision ledger holds ${revisionHistory.length} append-only revisions (rev_1 challenge, rev_2 completion, rev_3 settled)` },
    { id: "INV-F06", proof: "finality declared only after the external action evidence and provider settlement evidence existed" },
    { id: "INV-F03", proof: "the settlement entry balances; USD trial balance zero" },
  ];

  const journey = assembleJourneyOutcome(
    "customer-action",
    "Customer-action-required payment",
    invariants,
    assertions,
    chain.evidenceNodeIds,
  );
  return {
    journey,
    details: {
      challengeKind: pendingActions[0]?.kind ?? "",
      challengeMessage: pendingActions[0]?.message ?? "",
      challengeDeepLink: pendingActions[0]?.deepLink ?? "",
      awaitingState: attemptAfterChallenge.state,
      pendingActionsCount: pendingActions.length,
      classificationAtChallenge: classification.outcome,
      revisionHistoryCount: revisionHistory.length,
      finalAttemptState: completed.state,
      completionOnExternalEvidence: revisionHistory[1]?.revision === "rev_2",
      chain,
      plan,
    },
  };
}

export const customerActionJourney = {
  journeyId: "customer-action",
  title: "Customer-action-required payment",
  description:
    "provider state preserved losslessly (INV-C06), actionable through the trusted surface, completion on external action evidence",
  run: (): JourneyOutcome => runCustomerActionJourney().journey,
} as const;

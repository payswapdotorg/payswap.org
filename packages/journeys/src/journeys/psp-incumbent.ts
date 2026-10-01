/**
 * Journey 7 — incumbent-preserving PSP payment execution (W1-007).
 *
 * PASS_THROUGH_NATIVE mode through the uniform gates (INV-C07) — certified
 * as an available baseline against composed/multi-provider candidates. The
 * journey composes the payment plane (acceptance + translation), the
 * connector vocabulary (incumbent connected instance + native-optimization
 * benchmark-baseline capability, INV-C08), the execution plane
 * (single-step PASS_THROUGH_NATIVE plan), the settlement plane, the
 * certification plane (uniform gate wall — identical gates for every mode)
 * and the lab plane (deterministic baseline-suite candidate comparison with
 * NO mode prior: composition is never assumed superior).
 */

import {
  USD,
  asCommandId,
  fromMinorUnits,
} from "@payswap/protocol";
import type { Money } from "@payswap/protocol";
import {
  asMerchantSettlementDestinationId,
  defineAcceptancePolicy,
  defineCredentialCapability,
  defineMaterialTerms,
  definePaymentMethod,
  defineSettlementDestination,
  defineTranslation,
  defineTranslationAuthorization,
  matchesAcceptance,
  materialTermsHash,
  settlementResultFrom,
} from "@payswap/payment";
import type { PaymentAcceptancePolicy, PaymentMethod } from "@payswap/payment";
import { defineExecutionPlan, derivePaymentMethodOffer } from "@payswap/execution";
import type { ExecutionPlan } from "@payswap/execution";
import { runUniformGateWall } from "@payswap/certification";
import type { UniformGateWallResult } from "@payswap/certification";
import {
  JOURNEY_PRINCIPAL,
  assembleJourneyOutcome,
  buildWorld,
  checkAccountingReconciles,
  checkApprovalsAndProofs,
  checkEvidencedChain,
  checkFeesFxIncentivesExact,
  checkLosslessStateReconciliation,
  checkPassThroughNativeBaseline,
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
  JourneyWorld,
  SettlementChainOutcome,
} from "../harness.js";
import { accountId } from "@payswap/protocol";
import type { AccountId } from "@payswap/protocol";
import { projectBalances } from "@payswap/protocol";

export interface PspIncumbentJourneyDetails {
  readonly planMode: "PASS_THROUGH_NATIVE";
  readonly preservesNativeFlow: boolean;
  readonly incumbentProviderName: string;
  readonly incumbentInstanceAvailable: boolean;
  readonly benchmarkBaselineCapabilities: readonly string[];
  readonly uniformGateResults: readonly { readonly candidateId: string; readonly mode: string; readonly passed: boolean }[];
  readonly offerFees: Money;
  readonly chain: SettlementChainOutcome;
  readonly plan: ExecutionPlan;
}

export interface PspIncumbentJourneyOutcome {
  readonly journey: JourneyOutcome;
  readonly details: PspIncumbentJourneyDetails;
}

const PAYER_WALLET: AccountId = accountId("ASSET", "wallet.payer.us");
const MERCHANT_WALLET: AccountId = accountId("ASSET", "wallet.merchant.us");
const FEE_INCOME: AccountId = accountId("INCOME", "fees.psp");

/** Run the incumbent-preserving PSP execution journey deterministically. */
export function runPspIncumbentJourney(): PspIncumbentJourneyOutcome {
  const world = buildWorld({
    openingBalances: [{ account: PAYER_WALLET, amount: fromMinorUnits(USD, 300_000n) }],
  });
  const now = world.clock.now();

  // ---- The incumbent provider: a REAL connected instance whose capability
  // declares provider-native optimization as a benchmark baseline (INV-C08).
  const incumbent = registerRailFixture(world, {
    providerName: "psp-native",
    capabilityId: "cap.native.card.collect",
    currencies: ["USD"],
    nativeOptimization: true,
  });
  const benchmarkBaselines = world.registry
    .benchmarkBaselines()
    .map((definition) => definition.capabilityId);

  // ---- Acceptance + translation (the payment plane does not care about the mode).
  const card: PaymentMethod = definePaymentMethod({
    id: "pm:card-us",
    kind: "CARD",
    displayName: "Card (incumbent PSP)",
    currencies: [USD],
    credentialRequirements: [
      defineCredentialCapability({
        id: "cred:card-token",
        kind: "TOKEN",
        required: true,
        scope: "card tokenization",
      }),
    ],
  });
  const destination = defineSettlementDestination({
    id: "dest:merchant-us",
    kind: "CARD_SETTLEMENT",
    currency: USD,
    externalRef: "psp-native:acct_merchant_us",
    provenance: { source: "merchant-onboarding", reference: "onb-101", recordedAt: now },
  });
  const acceptance: PaymentAcceptancePolicy = defineAcceptancePolicy({
    id: "accept:merchant-us",
    merchantRef: "merchant:us-1",
    methods: ["CARD"],
    methodCatalog: [card],
    currencies: [USD],
    recurring: { supported: false },
    partialPayments: { supported: false },
    refunds: { supported: true, cutoffMs: 1_209_600_000n },
    recourse: "CHARGEBACK_ONLY",
    customerEligibility: [],
    settlementDestination: destination,
    timing: { maxCompletionMs: 86_400_000n },
    remittance: { requiredDocumentKinds: ["ORDER"] },
    geography: ["US"],
  });
  const acceptanceRequest = {
    methodId: card.id,
    currency: USD,
    country: "US",
  };
  const decision = matchesAcceptance(acceptance, acceptanceRequest);
  if (!decision.accepted) {
    throw new Error(`psp-incumbent journey: acceptance rejected (${decision.reasons.join(",")})`);
  }
  const amount = fromMinorUnits(USD, 80_000n);
  const fees = fromMinorUnits(USD, 2_400n);
  const terms = defineMaterialTerms({
    amount,
    currency: "USD",
    fees,
    completionMs: 86_400_000n,
    recourse: "CHARGEBACK_ONLY",
    settlementDestinationId: destination.id,
  });
  const translation = defineTranslation({
    id: "tr:psp:1",
    requestedMethod: card.id,
    selectedCapabilityChain: [
      { order: 1, capability: incumbent.definition.capabilityId, role: "collect" },
    ],
    actualRailEffects: [],
    merchantSettlementResult: settlementResultFrom(destination),
    materialTerms: terms,
  });
  defineTranslationAuthorization({
    id: "authz:psp:1",
    methodId: card.id,
    materialTermsHash: materialTermsHash(terms),
    authorizedAt: now,
    approvalArtifactRef: "approval:psp:1",
  });
  const observation = world.registry.latestObservationFor(incumbent.instance.instanceId);
  if (observation === undefined) {
    throw new Error("psp-incumbent journey: no observation for the incumbent instance");
  }
  const offerDerivation = derivePaymentMethodOffer({
    offerId: "offer:psp:1",
    acceptance,
    request: acceptanceRequest,
    instance: incumbent.instance,
    observation,
    translation,
    capability: incumbent.definition,
    amount,
    fees,
    executionMode: "PASS_THROUGH_NATIVE",
    expiresAt: now + 600_000n,
  });
  if (!offerDerivation.ok) {
    throw new Error(`psp-incumbent journey: offer rejected (${offerDerivation.reason})`);
  }

  // ---- PASS_THROUGH_NATIVE plan: exactly ONE step through the incumbent.
  const command = journeyCommand(world, "execution.executePlan", "idem:psp:plan", {
    planId: "plan:psp:1",
  });
  world.grants.issue({
    grantId: "grant:psp:execution",
    command,
    scope: {
      capabilityInstanceIds: [incumbent.instance.instanceId],
      executionModes: ["PASS_THROUGH_NATIVE"],
    },
    requestHash: "reqhash:psp:1",
    expiresAt: now + 3_600_000n,
    authorizationEvidenceRef: "approval:psp:1",
  });
  const grantVerification = world.grants.verify("grant:psp:execution", {
    now,
    requestHash: "reqhash:psp:1",
    capabilityInstanceId: incumbent.instance.instanceId,
    executionMode: "PASS_THROUGH_NATIVE",
  });
  const plan: ExecutionPlan = defineExecutionPlan({
    planId: "plan:psp:1",
    executionMode: "PASS_THROUGH_NATIVE",
    modeDetail: {
      kind: "PASS_THROUGH_NATIVE",
      incumbentProviderName: incumbent.instance.providerName,
      preservesNativeFlow: true,
    },
    steps: [
      {
        stepId: "step:psp:native-collect",
        order: 1,
        role: "collect",
        capability: incumbent.definition,
        instance: incumbent.instance,
        providerRequest: { amountMinorUnits: "80000", currency: "USD" },
      },
    ],
    settlementDestination: destination,
    remittance: [{ documentKind: "ORDER", documentId: "order-9001" }],
    protocolAuthorization: {
      commandId: asCommandId(command.id),
      principal: JOURNEY_PRINCIPAL,
      authorizationEvidenceRef: "approval:psp:1",
    },
    executionGrantId: "grant:psp:execution",
  });
  const envelope = providerEnvelope(
    {
      providerName: "psp-native",
      externalId: "pi_psp_native_1",
      revision: "rev_1",
      family: "capture",
      lifecycleStep: "settled",
      isTerminal: true,
      requiresCustomerAction: false,
      state: { providerNativeStatus: "succeeded", nativeRouting: "psp-native-smart-router" },
    },
    world,
  );
  const begin = world.attempts.begin({
    attemptId: "xatt:psp:1",
    planId: plan.planId,
    stepId: "step:psp:native-collect",
    executionMode: "PASS_THROUGH_NATIVE",
    capabilityInstanceId: incumbent.instance.instanceId,
    capabilityId: incumbent.definition.capabilityId,
    retryPolicy: incumbent.definition.idempotency.retryPolicy,
    cancellation: incumbent.definition.compensation.cancellation,
    compensation: incumbent.definition.compensation,
    idempotencyKey: "idem:psp:attempt",
    principal: JOURNEY_PRINCIPAL,
    now,
  });
  if (begin.kind !== "BEGIN") {
    throw new Error("psp-incumbent journey: attempt replay");
  }
  world.attempts.advance("xatt:psp:1", "START", { now: world.clock.now() });
  world.attempts.advance("xatt:psp:1", "CONFIRM_SUCCEEDED", {
    now: world.clock.now(),
    evidence: [executionEvidenceDraft("psp", 1, envelope, world)],
  });

  // ---- Settlement through the shared evidenced chain.
  const chain = runSettlementChain({
    world,
    sequence: "psp",
    clearingRecords: [
      clearingRecord("CR:psp:1", [
        {
          id: "FA:psp:1",
          activityType: "MERCHANT_PAYMENT",
          debtor: "user:payer-us",
          creditor: "merchant:us-1",
          amount,
          occurredAt: now,
        },
      ], world),
    ],
    dueWindow: { opensAt: now, closesAt: now + 1_000_000n },
    authorizationRefs: ["approval:psp:1", "grant:psp:execution"],
    instructions: [
      {
        settlementDestinationId: destination.id,
        rail: "CARD_SETTLEMENT_RAIL",
        providerName: "psp-native",
        remittance: [{ documentKind: "ORDER", documentId: "order-9001", allocatedAmount: amount }],
      },
    ],
  });
  postEntry(
    world,
    [
      { accountId: PAYER_WALLET, amount: fromMinorUnits(USD, -80_000n) },
      { accountId: MERCHANT_WALLET, amount: fromMinorUnits(USD, 80_000n) },
    ],
    "psp native settlement",
    "psp:settlement",
  );
  postEntry(
    world,
    [
      { accountId: PAYER_WALLET, amount: fromMinorUnits(USD, -2_400n) },
      { accountId: FEE_INCOME, amount: fees },
    ],
    "psp native fee",
    "psp:fee",
  );

  // ---- INV-C07: the uniform gate wall — the SAME gates for every mode.
  const gateCandidates = [
    { candidateId: "cand:incumbent-native", mode: "PASS_THROUGH_NATIVE" as const },
    { candidateId: "cand:composed", mode: "COMPOSED_PAYSWAP" as const },
    { candidateId: "cand:multi-provider", mode: "OPTIMIZED_MULTI_PROVIDER" as const },
  ];
  const uniformGateResults: { candidateId: string; mode: string; passed: boolean }[] = [];
  const gateWalls: UniformGateWallResult[] = [];
  for (const candidate of gateCandidates) {
    const wall = runUniformGateWall({
      candidateId: candidate.candidateId,
      executionMode: candidate.mode,
      isIncumbentBaseline: candidate.mode === "PASS_THROUGH_NATIVE",
      authorizationEvidence: [
        {
          authorizationRef: `authz:${candidate.candidateId}`,
          evidenceRef: "evidence:protocol-authorization:1",
          issuedAtEpoch: 0n,
        },
      ],
      complianceClearances: [
        {
          clearanceId: `clearance:${candidate.candidateId}:us`,
          policyRef: "policy:us-payments@2",
          evidenceRef: "evidence:screening:1",
        },
      ],
      evidence: [
        { evidenceId: "ev:replay:1", kind: "REPLAY", artifactRef: "lab/replay-1.json", contentDigest: "fnv1a64:replay1" },
        { evidenceId: "ev:counterfactual:1", kind: "COUNTERFACTUAL", artifactRef: "lab/counterfactual-1.json", contentDigest: "fnv1a64:cf1" },
        { evidenceId: "ev:robustness:1", kind: "ROBUSTNESS", artifactRef: "lab/robustness-1.json", contentDigest: "fnv1a64:rb1" },
      ],
    });
    gateWalls.push(wall);
    uniformGateResults.push({ candidateId: candidate.candidateId, mode: candidate.mode, passed: wall.passed });
  }

  // ---- INV-C08 + acceptance: the incumbent baseline is AVAILABLE for
  // benchmarking — its connected instance is registered, observed AVAILABLE
  // (both availability axes green) and its native optimization is
  // represented as a benchmark-baseline capability. The evidence-only
  // candidate comparison record (incumbent vs composed vs multi-provider,
  // NO mode prior) is produced by the certification tests through the Lab's
  // baseline suite — the Lab is composed at the test layer per the
  // repo-wide simulation-isolation boundary (INV-L01, AGENTS rule 7).

  const assertions: readonly AxisAssertion[] = [
    checkEvidencedChain(world, chain),
    checkAccountingReconciles(world, [
      { account: PAYER_WALLET, amount: fromMinorUnits(USD, 217_600n) },
      { account: MERCHANT_WALLET, amount: fromMinorUnits(USD, 80_000n) },
      { account: FEE_INCOME, amount: fromMinorUnits(USD, 2_400n) },
    ]),
    checkFeesFxIncentivesExact([
      { label: "incumbent fee exact", expected: fromMinorUnits(USD, 2_400n), actual: offerDerivation.ok ? offerDerivation.offer.fees : fromMinorUnits(USD, 0n) },
      { label: "settled amount exact", expected: amount, actual: chain.settlements[0]?.instruction.amount ?? fromMinorUnits(USD, 0n) },
    ]),
    checkApprovalsAndProofs({
      authorizationEvidenceRefs: ["approval:psp:1", "grant:psp:execution"],
      grantVerified: { grantId: "grant:psp:execution", ok: grantVerification.ok },
      finalities: chain.settlements.map((s) => s.finality),
      evidenceLineageHasAuthorization: world.evidence
        .lineageForAction(chain.settlements[0]?.instruction.id ?? "")
        .authorization.length > 0,
    }),
    checkLosslessStateReconciliation(world, {
      envelopes: [envelope],
      canonicalMatches: [
        {
          description: "the incumbent's native routing decision is preserved verbatim in the provider state",
          ok: JSON.stringify(envelope.state).includes("psp-native-smart-router"),
        },
        {
          description: "pass-through settlement reached SETTLED canonical state",
          ok: chain.obligations.every((o) => world.obligations.get(o.id)?.state === "SETTLED"),
        },
      ],
      evidenceLinked: chain.settlements.every((s) => s.certificate.evidenceChain.length === 3),
    }),
    checkPassThroughNativeBaseline({
      planMode: plan.executionMode,
      preservesNativeFlow: plan.modeDetail.kind === "PASS_THROUGH_NATIVE" ? plan.modeDetail.preservesNativeFlow : false,
      incumbentProviderName: incumbent.instance.providerName,
      incumbentBaselineAvailable:
        observation.availability === "AVAILABLE" &&
        world.registry.instance(incumbent.instance.instanceId) !== undefined,
      benchmarkBaselineCapabilities: benchmarkBaselines,
      uniformGatesPassed: uniformGateResults.map((r) => ({ candidateId: r.candidateId, passed: r.passed })),
    }),
  ];

  const invariants: readonly InvariantProof[] = [
    { id: "INV-C07", proof: `PASS_THROUGH_NATIVE passed the SAME uniform gate wall as the composed and multi-provider candidates (${uniformGateResults.map((g) => `${g.candidateId}:${g.passed}`).join(", ")})` },
    { id: "INV-C08", proof: `the incumbent's native optimization is represented as benchmark-baseline capabilities [${benchmarkBaselines.join(", ")}] and remains an available, benchmarkable baseline (never assumed inferior or superior)` },
    { id: "INV-C05", proof: `execution scoped to connected instance ${incumbent.instance.instanceId} on account ${incumbent.instance.accountRef}` },
    { id: "INV-F06", proof: "finality protocol-declared for the pass-through settlement" },
    { id: "INV-E03", proof: "finality achieved its policy-required proof" },
    { id: "INV-F01", proof: "fee and settlement amounts exact integer minor units" },
    { id: "INV-F03", proof: "settlement and fee entries balance; USD trial balance zero" },
  ];

  const journey = assembleJourneyOutcome(
    "psp-incumbent",
    "Incumbent-preserving PSP execution",
    invariants,
    assertions,
    [...chain.evidenceNodeIds, ...gateWalls.map((w) => w.wallDigest)],
  );
  return {
    journey,
    details: {
      planMode: "PASS_THROUGH_NATIVE",
      preservesNativeFlow: true,
      incumbentProviderName: incumbent.instance.providerName,
      incumbentInstanceAvailable: observation.availability === "AVAILABLE",
      benchmarkBaselineCapabilities: benchmarkBaselines,
      uniformGateResults,
      offerFees: offerDerivation.ok ? offerDerivation.offer.fees : fromMinorUnits(USD, 0n),
      chain,
      plan,
    },
  };
}

export const pspIncumbentJourney = {
  journeyId: "psp-incumbent",
  title: "Incumbent-preserving PSP execution",
  description:
    "PASS_THROUGH_NATIVE mode through the uniform gates (INV-C07) — certified as an available baseline against composed/multi-provider candidates",
  run: (): JourneyOutcome => runPspIncumbentJourney().journey,
} as const;

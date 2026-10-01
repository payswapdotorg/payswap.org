/**
 * Journey 2 — merchant checkout (W1-007).
 *
 * acceptance-derived offer -> method selection with reasons -> execution
 * attempt -> settlement to an explicit destination; fee accounting exact.
 * Composes the payment plane (method catalog, acceptance policy, translation
 * with material-terms authorization), the connector vocabulary (connected
 * instance + observation) and the execution/settlement planes.
 */

import {
  GHS,
  fromMinorUnits,
} from "@payswap/protocol";
import type { AccountId, Money } from "@payswap/protocol";
import {
  asMerchantSettlementDestinationId,
  assertTranslationAuthorized,
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
import type {
  AcceptanceDecision,
  PaymentAcceptancePolicy,
  PaymentMethod,
} from "@payswap/payment";
import { derivePaymentMethodOffer, defineExecutionPlan } from "@payswap/execution";
import { resolveEffectiveAvailability } from "@payswap/capabilities";
import type { OfferDerivation } from "@payswap/execution";
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
  JourneyWorld,
  SettlementChainOutcome,
} from "../harness.js";
import { asCommandId } from "@payswap/protocol";

export interface MerchantCheckoutJourneyDetails {
  readonly offerDerived: boolean;
  readonly offerFees: Money;
  readonly offerRailPath: readonly string[];
  readonly offerMode: string;
  readonly acceptedReasons: readonly string[];
  readonly cardRejected: boolean;
  readonly cardRejectionReasons: readonly string[];
  readonly geographyRejectionReasons: readonly string[];
  readonly translationAuthorized: boolean;
  readonly translationDriftRequiresReauth: boolean;
  readonly twoAxisAvailability: { readonly reachableAvailable: string; readonly unreachableUnknown: string };
  readonly certificateDocumentRefs: readonly { readonly documentKind: string; readonly documentId: string }[];
  readonly merchantBalanceAfter: Money;
  readonly feeIncome: Money;
  readonly chain: SettlementChainOutcome;
}

export interface MerchantCheckoutJourneyOutcome {
  readonly journey: JourneyOutcome;
  readonly details: MerchantCheckoutJourneyDetails;
}

/** Run the merchant checkout journey deterministically. */
export function runMerchantCheckoutJourney(): MerchantCheckoutJourneyOutcome {
  const world = buildWorld({
    openingBalances: [
      { account: accountOf("ASSET", "wallet.payer.ghs"), amount: fromMinorUnits(GHS, 200_000n) },
    ],
  });
  const now = world.clock.now();

  // ---- Payment plane: method catalog + acceptance policy.
  const mobileMoney: PaymentMethod = definePaymentMethod({
    id: "pm:mobile-money-gh",
    kind: "MOBILE_MONEY",
    displayName: "Mobile Money (Ghana)",
    currencies: [GHS],
    credentialRequirements: [
      defineCredentialCapability({
        id: "cred:momo-pin",
        kind: "MOBILE_MONEY_AUTHORIZATION",
        required: true,
        scope: "authorize one collection",
      }),
    ],
  });
  const card: PaymentMethod = definePaymentMethod({
    id: "pm:card-visa",
    kind: "CARD",
    displayName: "Visa card",
    currencies: [GHS],
    credentialRequirements: [
      defineCredentialCapability({
        id: "cred:3ds",
        kind: "TOKEN",
        required: true,
        scope: "3-D Secure authentication",
      }),
    ],
  });
  const destination = defineSettlementDestination({
    id: "dest:merchant-gh",
    kind: "MOBILE_MONEY_WALLET",
    currency: GHS,
    externalRef: "momo:0244xxxxxxx",
    provenance: { source: "merchant-onboarding", reference: "onb-77", recordedAt: now },
  });
  const acceptance: PaymentAcceptancePolicy = defineAcceptancePolicy({
    id: "accept:merchant-gh",
    merchantRef: "merchant:acme-gh",
    methods: ["MOBILE_MONEY"],
    methodCatalog: [mobileMoney],
    currencies: [GHS],
    recurring: { supported: true, maxIntervalMs: 2_592_000_000n },
    partialPayments: { supported: true, minAmountBasisPoints: 5_000n },
    refunds: { supported: true, cutoffMs: 1_209_600_000n },
    recourse: "MERCHANT_DISPUTE_WINDOW",
    customerEligibility: [{ key: "kyc-tier", requires: "2" }],
    settlementDestination: destination,
    timing: { maxCompletionMs: 86_400_000n },
    remittance: { requiredDocumentKinds: ["INVOICE"] },
    geography: ["GH"],
  });

  // Method selection WITH REASONS: the accepted method, a kind not accepted,
  // and a geography not served.
  const accepted: AcceptanceDecision = matchesAcceptance(acceptance, {
    methodId: mobileMoney.id,
    currency: GHS,
    country: "GH",
    payerAttributes: { "kyc-tier": "2" },
  });
  const cardDecision: AcceptanceDecision = matchesAcceptance(acceptance, {
    methodId: card.id,
    currency: GHS,
    country: "GH",
    payerAttributes: { "kyc-tier": "2" },
  });
  const geographyDecision: AcceptanceDecision = matchesAcceptance(acceptance, {
    methodId: mobileMoney.id,
    currency: GHS,
    country: "US",
    payerAttributes: { "kyc-tier": "2" },
  });

  // ---- Capability vocabulary: the two availability axes are separate
  // (INV-C01) and an unreachable source means UNKNOWN, never success/failure
  // (INV-C02).
  const twoAxisAvailability = {
    reachableAvailable: resolveEffectiveAvailability("AVAILABLE", "REACHABLE"),
    unreachableUnknown: resolveEffectiveAvailability("AVAILABLE", "UNREACHABLE"),
  };

  // ---- Connector vocabulary: connected instance + observation (INV-C05/C01).
  const rail = registerRailFixture(world, {
    providerName: "psp-momo-gh",
    capabilityId: "cap.mobile_money.collect",
    currencies: ["GHS"],
    countries: ["GH"],
  });
  const observation = world.registry.latestObservationFor(rail.instance.instanceId);
  if (observation === undefined) {
    throw new Error("merchant checkout journey: no capability observation recorded");
  }

  // ---- Translation with material terms + authorization (re-auth on drift).
  const amount = fromMinorUnits(GHS, 50_000n);
  const fees = fromMinorUnits(GHS, 1_500n);
  const terms = defineMaterialTerms({
    amount,
    currency: "GHS",
    fees,
    completionMs: 600_000n,
    recourse: "MERCHANT_DISPUTE_WINDOW",
    settlementDestinationId: destination.id,
  });
  const translation = defineTranslation({
    id: "tr:checkout:1",
    requestedMethod: mobileMoney.id,
    selectedCapabilityChain: [
      { order: 1, capability: rail.definition.capabilityId, role: "collect" },
    ],
    actualRailEffects: [],
    merchantSettlementResult: settlementResultFrom(destination),
    materialTerms: terms,
  });
  const translationAuth = defineTranslationAuthorization({
    id: "authz:checkout:1",
    methodId: mobileMoney.id,
    materialTermsHash: materialTermsHash(terms),
    authorizedAt: now,
    approvalArtifactRef: "approval:checkout:1",
  });
  assertTranslationAuthorized(translation, translationAuth);
  const translationAuthorized = true;
  const driftedTerms = defineMaterialTerms({
    amount,
    currency: "GHS",
    fees: fromMinorUnits(GHS, 2_500n),
    completionMs: 600_000n,
    recourse: "MERCHANT_DISPUTE_WINDOW",
    settlementDestinationId: destination.id,
  });
  const driftedTranslation = defineTranslation({
    id: "tr:checkout:1-drifted",
    requestedMethod: mobileMoney.id,
    selectedCapabilityChain: translation.selectedCapabilityChain,
    actualRailEffects: [],
    merchantSettlementResult: settlementResultFrom(destination),
    materialTerms: driftedTerms,
  });
  let translationDriftRequiresReauth = false;
  try {
    assertTranslationAuthorized(driftedTranslation, translationAuth);
  } catch {
    translationDriftRequiresReauth = true;
  }

  // ---- Acceptance-derived offer (execution plane).
  const offerDerivation: OfferDerivation = derivePaymentMethodOffer({
    offerId: "offer:checkout:1",
    acceptance,
    request: {
      methodId: mobileMoney.id,
      currency: GHS,
      country: "GH",
      payerAttributes: { "kyc-tier": "2" },
    },
    instance: rail.instance,
    observation,
    translation,
    capability: rail.definition,
    amount,
    fees,
    executionMode: "COMPOSED_PAYSWAP",
    expiresAt: now + 600_000n,
  });
  if (!offerDerivation.ok) {
    throw new Error(`merchant checkout journey: offer rejected (${offerDerivation.reason})`);
  }
  const offer = offerDerivation.offer;

  // ---- Execution plan + attempt with provider evidence.
  const command = journeyCommand(world, "execution.executePlan", "idem:checkout:plan", {
    planId: "plan:checkout:1",
  });
  world.grants.issue({
    grantId: "grant:checkout:execution",
    command,
    scope: {
      capabilityInstanceIds: [rail.instance.instanceId],
      executionModes: ["COMPOSED_PAYSWAP"],
    },
    requestHash: "reqhash:checkout:1",
    expiresAt: now + 3_600_000n,
    authorizationEvidenceRef: "approval:checkout:1",
  });
  const grantVerification = world.grants.verify("grant:checkout:execution", {
    now,
    requestHash: "reqhash:checkout:1",
    capabilityInstanceId: rail.instance.instanceId,
    executionMode: "COMPOSED_PAYSWAP",
  });
  const plan = defineExecutionPlan({
    planId: "plan:checkout:1",
    executionMode: "COMPOSED_PAYSWAP",
    modeDetail: { kind: "COMPOSED_PAYSWAP", composedWith: [rail.definition.capabilityId] },
    steps: [
      {
        stepId: "step:checkout:collect",
        order: 1,
        role: "collect",
        capability: rail.definition,
        instance: rail.instance,
        providerRequest: { amountMinorUnits: "50000", currency: "GHS" },
      },
    ],
    settlementDestination: destination,
    remittance: [{ documentKind: "INVOICE", documentId: "doc-5001" }],
    protocolAuthorization: {
      commandId: asCommandId(command.id),
      principal: JOURNEY_PRINCIPAL,
      authorizationEvidenceRef: "approval:checkout:1",
    },
    executionGrantId: "grant:checkout:execution",
  });
  const envelope = providerEnvelope(
    {
      providerName: "psp-momo-gh",
      externalId: "pi_checkout_1",
      revision: "rev_1",
      family: "capture",
      lifecycleStep: "settled",
      isTerminal: true,
      requiresCustomerAction: false,
      state: { providerNativeStatus: "succeeded", momoRef: "MM-889931" },
    },
    world,
  );
  const begin = world.attempts.begin({
    attemptId: "xatt:checkout:1",
    planId: plan.planId,
    stepId: "step:checkout:collect",
    executionMode: "COMPOSED_PAYSWAP",
    capabilityInstanceId: rail.instance.instanceId,
    capabilityId: rail.definition.capabilityId,
    retryPolicy: rail.definition.idempotency.retryPolicy,
    cancellation: rail.definition.compensation.cancellation,
    compensation: rail.definition.compensation,
    idempotencyKey: "idem:checkout:attempt",
    principal: JOURNEY_PRINCIPAL,
    now,
  });
  if (begin.kind !== "BEGIN") {
    throw new Error("merchant checkout journey: execution attempt was a replay");
  }
  world.attempts.advance("xatt:checkout:1", "START", { now: world.clock.now() });
  world.attempts.advance("xatt:checkout:1", "CONFIRM_SUCCEEDED", {
    now: world.clock.now(),
    evidence: [executionEvidenceDraft("checkout", 1, envelope, world)],
  });

  // ---- Settlement to the EXPLICIT destination with remittance preserved.
  const dueWindow = { opensAt: world.clock.now(), closesAt: world.clock.now() + 1_000_000n };
  const chain = runSettlementChain({
    world,
    sequence: "checkout",
    clearingRecords: [
      clearingRecord("CR:checkout:1", [
        {
          id: "FA:checkout:1",
          activityType: "MERCHANT_PAYMENT",
          debtor: "user:payer-gh",
          creditor: "merchant:acme-gh",
          amount,
          occurredAt: world.clock.now(),
        },
      ], world),
    ],
    dueWindow,
    authorizationRefs: ["approval:checkout:1", "grant:checkout:execution"],
    instructions: [
      {
        settlementDestinationId: destination.id,
        rail: "MOBILE_MONEY_RAIL",
        providerName: "psp-momo-gh",
        remittance: [
          { documentKind: "INVOICE", documentId: "doc-5001", allocatedAmount: amount },
        ],
        remittanceInfo: "invoice doc-5001",
      },
    ],
  });

  // ---- Accounting: settlement movement + exact fee.
  postEntry(
    world,
    [
      { accountId: accountOf("ASSET", "wallet.payer.ghs"), amount: fromMinorUnits(GHS, -50_000n) },
      { accountId: accountOf("ASSET", "wallet.merchant.ghs"), amount: fromMinorUnits(GHS, 50_000n) },
    ],
    "merchant checkout settlement",
    "checkout:settlement",
  );
  postEntry(
    world,
    [
      { accountId: accountOf("ASSET", "wallet.payer.ghs"), amount: fromMinorUnits(GHS, -1_500n) },
      { accountId: accountOf("INCOME", "fees.checkout"), amount: fees },
    ],
    "merchant checkout fee",
    "checkout:fee",
  );

  const merchantBalanceAfter = projected(world, accountOf("ASSET", "wallet.merchant.ghs"));
  const feeIncome = projected(world, accountOf("INCOME", "fees.checkout"));

  const assertions: readonly AxisAssertion[] = [
    checkEvidencedChain(world, chain),
    checkAccountingReconciles(world, [
      { account: accountOf("ASSET", "wallet.payer.ghs"), amount: fromMinorUnits(GHS, 148_500n) },
      { account: accountOf("ASSET", "wallet.merchant.ghs"), amount: fromMinorUnits(GHS, 50_000n) },
      { account: accountOf("INCOME", "fees.checkout"), amount: fromMinorUnits(GHS, 1_500n) },
    ]),
    checkFeesFxIncentivesExact([
      { label: "offer fees equal the disclosed material terms", expected: fees, actual: offer.fees },
      { label: "fee income posted exactly", expected: fromMinorUnits(GHS, 1_500n), actual: feeIncome },
      { label: "settled amount exact", expected: amount, actual: chain.settlements[0]?.instruction.amount ?? fromMinorUnits(GHS, 0n) },
    ]),
    checkApprovalsAndProofs({
      authorizationEvidenceRefs: ["approval:checkout:1", "grant:checkout:execution", translationAuth.approvalArtifactRef],
      grantVerified: { grantId: "grant:checkout:execution", ok: grantVerification.ok },
      finalities: chain.settlements.map((s) => s.finality),
      evidenceLineageHasAuthorization: world.evidence
        .lineageForAction(chain.settlements[0]?.instruction.id ?? "")
        .authorization.length > 0,
    }),
    checkLosslessStateReconciliation(world, {
      envelopes: [envelope],
      canonicalMatches: [
        {
          description: `instruction settles to the explicit destination ${destination.id} (${destination.externalRef})`,
          ok: chain.settlements[0]?.instruction.settlementDestinationId === destination.id,
        },
        {
          description: "provider 'succeeded' evidence reconciles with the SETTLED obligation",
          ok: chain.obligations.every((o) => world.obligations.get(o.id)?.state === "SETTLED"),
        },
      ],
      evidenceLinked: chain.settlements.every((s) => s.certificate.evidenceChain.length === 3),
    }),
  ];

  const invariants: readonly InvariantProof[] = [
    { id: "INV-C05", proof: `the offer and plan execute against connected instance ${rail.instance.instanceId} scoped to account ${rail.instance.accountRef}, never the catalogue` },
    { id: "INV-C01", proof: `capability state and source availability are separate axes (AVAILABLE + REACHABLE -> ${twoAxisAvailability.reachableAvailable}); the observation carries both` },
    { id: "INV-C02", proof: `an unreachable source resolves to ${twoAxisAvailability.unreachableUnknown} — availability UNKNOWN, never success or failure` },
    { id: "INV-F01", proof: "the 500.00 GHS amount and 15.00 GHS fee are exact integer minor units end-to-end" },
    { id: "INV-F09", proof: "the fee is disclosed in the material terms with provenance and hashed into the translation authorization" },
    { id: "INV-A03", proof: `material-term drift raised TranslationReauthorizationRequiredError (${translationDriftRequiresReauth})` },
    { id: "INV-F03", proof: "settlement and fee entries balance and the GHS trial balance sums to zero" },
    { id: "INV-F06", proof: "finality was declared only for the protocol-derived instruction settling to the acceptance-declared destination" },
    { id: "INV-E03", proof: "the certificate was issued only after policy-required proof was achieved" },
  ];

  const journey = assembleJourneyOutcome(
    "merchant-checkout",
    "Merchant checkout",
    invariants,
    assertions,
    chain.evidenceNodeIds,
  );
  return {
    journey,
    details: {
      offerDerived: offerDerivation.ok,
      offerFees: offer.fees,
      offerRailPath: offer.railPath,
      offerMode: offer.executionMode,
      acceptedReasons: accepted.reasons,
      cardRejected: !cardDecision.accepted,
      cardRejectionReasons: cardDecision.reasons,
      geographyRejectionReasons: geographyDecision.reasons,
      translationAuthorized,
      translationDriftRequiresReauth,
      twoAxisAvailability,
      certificateDocumentRefs: chain.settlements[0]?.certificate.remittance.map((allocation) => ({
        documentKind: allocation.documentKind,
        documentId: allocation.documentId,
      })) ?? [],
      merchantBalanceAfter,
      feeIncome,
      chain,
    },
  };
}

import { accountId } from "@payswap/protocol";
function accountOf(
  type: "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "EXPENSE" | "PROTOCOL_OBLIGATION" | "RESERVE",
  name: string,
): AccountId {
  return accountId(type, name);
}

function projected(world: JourneyWorld, account: AccountId): Money {
  return projectBalancesOf(world, account);
}

import { projectBalances } from "@payswap/protocol";
function projectBalancesOf(world: JourneyWorld, account: AccountId): Money {
  return projectBalances(world.journal, account).get(account) ?? zeroGhs();
}
function zeroGhs(): Money {
  return fromMinorUnits(GHS, 0n);
}

export const merchantCheckoutJourney = {
  journeyId: "merchant-checkout",
  title: "Merchant checkout",
  description:
    "acceptance-derived offer -> method selection with reasons -> execution attempt -> settlement to an explicit destination; fee accounting exact",
  run: (): JourneyOutcome => runMerchantCheckoutJourney().journey,
} as const;

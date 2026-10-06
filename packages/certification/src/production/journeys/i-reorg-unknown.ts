/**
 * Journey I — Reorg / UNKNOWN (§35).
 *
 * Force an execution into a non-final/ambiguous state. Expected: UNKNOWN
 * rather than fake success — with reconciliation as the ONLY exit.
 *
 * Real composition (three independent REAL kernels, one law):
 *
 * - the W3-001 lane walk with an injected OUTCOME_UNKNOWN fault (a
 *   reorganized receipt): the kernel-validated observation carries
 *   OUTCOME_UNKNOWN + unknownReason, NEVER a failure descriptor (INV-X01
 *   — the validator structurally forbids it), maps to
 *   RAIL_EFFECT_UNKNOWN with requiresReconciliation, and the walk's
 *   lifecycle stages include reconcile;
 * - the W4-001 route walk with the same fault at the onchain leg:
 *   ROUTE_REQUIRES_RECONCILIATION + blindRetryForbidden + the settlement
 *   reconciliation authority as the only resolver;
 * - the W2-003 merchant lifecycle: an attempt observed OUTCOME_UNKNOWN
 *   stays UNKNOWN (no resubmit function exists at all), ambiguity
 *   evidence appends without mutating state, and the ONLY exit is the
 *   typed reconciliation resolution;
 * - the reorg vocabulary itself: probabilistic finality chains declare
 *   reorg risk PRESENT (finalityReorgConsistency), and a reorg-detected
 *   finality candidate is representable on the observation.
 */

import type { MoneyMovementIntent, RoutePlan } from "@payswap/route-compiler";
import { walkRoutePlan } from "@payswap/route-compiler";
import { canonicalAssetRef } from "@payswap/onchain-domain";
import {
  finalityReorgConsistency,
  validateOnchainExecutionObservation,
} from "@payswap/onchain-domain";
import {
  executeOnchainLane,
  discoverOnchainLane,
  engineFromVenuePacks,
} from "@payswap/mixed-rail";
import type { SwapRequest } from "@payswap/best-execution";
import { OnchainWritePipeline } from "@payswap/onchain-security";
import {
  activateCryptoAcceptance,
  activateMerchant,
  attachMethodToIntent,
  buildCheckoutAuthorization,
  authorizeCheckoutPayment,
  confirmIntentSubmission,
  defineRailAssetBinding,
  draftMerchant,
  handOffForBroadcast,
  observeAttemptOutcome,
  openCheckoutFlow,
  prepareCheckoutWrite,
  recheckCheckoutPayment,
  recordAmbiguityEvidence,
  resolveAttemptUnknown,
  submitMerchantApplication,
  submitWalletPaymentAttempt,
  verifyMerchant,
  walletPaymentAuthorizationLineage,
} from "@payswap/merchant-checkout";
import { merchantPaymentAttemptStateMachine } from "@payswap/merchant-crypto";
import { defineAcceptancePolicy, definePaymentMethod } from "@payswap/payment";
import {
  assertionFromChecks,
  assembleJourneyOutcome,
  journeyRequires,
  requirePresent,
  stage,
  type ProductionJourney,
} from "../contract.js";
import {
  CERT_EPOCH_ISO,
  CERT_FINALITY_MODES,
  CERT_NOW,
  CERT_SIGNER_ADAPTER,
  CERT_SERVICE_PRINCIPAL,
  CHAIN,
  CUSTOMER_APPROVER_REF,
  CUSTOMER_WALLET,
  EUR,
  ETH_ASSET,
  MERCHANT_CART_EUR,
  MERCHANT_DESTINATION_X,
  PAYEE,
  USC_ASSET,
  USC_CRYPTO_ASSET,
  CHAIN_ID,
  certApprovalSurface,
  certBestExecutionPolicy,
  certProtocolInstances,
  certSecurityPolicy,
  certSecurityState,
  certTimestamp,
  certVenuePacks,
  compileCertRoute,
  euroFixtureQuote,
  merchantBankEuroDestination,
  merchantCryptoPolicyInput,
  recheckObservationFor,
  submitAtTrustedSurface,
  transferSimulation,
  uscWalletObservation,
} from "../world.js";

const REORG_REASON =
  "reorganized receipt: the containing block was reorganized at depth 2 — the execution outcome is ambiguous pending re-observation";

export const journeyI: ProductionJourney = {
  journeyId: "journey:i-reorg-unknown",
  letter: "I",
  title: "Reorg / UNKNOWN — a forced ambiguous state renders UNKNOWN (never fake success) with reconciliation as the only exit",
  spec: "docs/UNIVERSAL-MONEY-HANDOFF-FULL-2026-10-02.md §35 Journey I",
  run: (): ReturnType<typeof assembleJourneyOutcome> => {
    // ------------------------------------------------------------------
    // Leg 1 — the lane walk: OUTCOME_UNKNOWN on a reorganized receipt
    // ------------------------------------------------------------------
    const { engine } = engineFromVenuePacks([...certVenuePacks()]);
    const swap: SwapRequest = {
      requestId: "swap:cert:i:reorg",
      chain: CHAIN,
      inputAsset: USC_ASSET,
      outputAsset: ETH_ASSET,
      swapKind: "EXACT_INPUT",
      amount: { currency: "USC", minorUnits: "1000000000" },
      maxSlippageBasisPoints: 300,
    };
    const laneResult = discoverOnchainLane({
      engine,
      executionId: "exec:cert:i",
      swap,
      policy: certBestExecutionPolicy(),
      security: { policy: certSecurityPolicy(), state: certSecurityState() },
      instances: [...certProtocolInstances()],
      assetObservations: [uscWalletObservation()],
      owner: CUSTOMER_WALLET,
      beneficiary: PAYEE,
      requestedBy: "agent:certification-key-1",
      routeExpiryMs: CERT_NOW + 600_000,
      at: CERT_NOW,
    });
    if (laneResult.status !== "LANE_PROVED") {
      throw new Error(`production journey structural prerequisite failed: the lane must be proved (${laneResult.status})`);
    }
    const unknownExecution = executeOnchainLane({
      lane: laneResult.lane,
      at: CERT_NOW + 5,
      observedAtIso: CERT_EPOCH_ISO,
      fault: { kind: "OUTCOME_UNKNOWN", reason: REORG_REASON },
    });
    if (unknownExecution.status !== "EXECUTED") {
      throw new Error("production journey structural prerequisite failed: the faulted lane walk must execute to its honest terminal");
    }
    // The kernel validator accepts the UNKNOWN observation with no failure.
    const revalidated = validateOnchainExecutionObservation(unknownExecution.observation);

    // ------------------------------------------------------------------
    // Leg 2 — the route walk: ONCHAIN_OUTCOME_UNKNOWN at the transfer leg
    // ------------------------------------------------------------------
    const intent: MoneyMovementIntent = {
      intentId: "intent:cert:i:reorg",
      principalRef: CUSTOMER_APPROVER_REF,
      origin: {
        kind: "ONCHAIN_WALLET",
        chainKey: CHAIN,
        accountRef: CUSTOMER_WALLET,
        assetId: canonicalAssetRef(CHAIN, "USC"),
        symbol: "USC",
      },
      destination: {
        kind: "ONCHAIN_RECIPIENT",
        chainKey: CHAIN,
        accountRef: PAYEE,
        assetId: canonicalAssetRef(CHAIN, "USC"),
        symbol: "USC",
      },
      originAmount: { currency: "USC", minorUnits: "20000000" },
      arrivalCurrency: "USC",
      maxSettlementMs: 600_000,
      maxRouteHops: 6,
      intentAuthorizationRef: "authz:cert:intent:i",
      declaredAt: CERT_NOW - 60_000,
      expiresAt: CERT_NOW + 3_600_000,
    };
    const compilation = compileCertRoute(intent);
    const plan: RoutePlan = requirePresent(
      compilation.plans.find((entry) => entry.shapeId === "onchain-direct-transfer"),
      "the direct-transfer plan must compile",
    );
    const transferLeg = requirePresent(
      plan.legs.find((entry) => entry.legKind === "ONCHAIN_TRANSFER"),
      "the plan must carry the transfer leg",
    );
    const unknownWalk = walkRoutePlan({
      plan,
      at: CERT_NOW + 4,
      observedAtIso: CERT_EPOCH_ISO,
      onchainFinalityModels: CERT_FINALITY_MODES,
      faults: {
        [transferLeg.legId]: { kind: "ONCHAIN_OUTCOME_UNKNOWN", reason: REORG_REASON },
      },
    });
    journeyRequires(
      unknownWalk.status === "ROUTE_REQUIRES_RECONCILIATION",
      `the faulted walk must require reconciliation (got ${unknownWalk.status})`,
    );

    // ------------------------------------------------------------------
    // Leg 3 — the merchant lifecycle: UNKNOWN attempt, reconciliation exit
    // ------------------------------------------------------------------
    const card = definePaymentMethod({
      id: "pm-card",
      kind: "CARD",
      displayName: "Card",
      currencies: [EUR],
      credentialRequirements: [],
    });
    const cryptoMethod = definePaymentMethod({
      id: "pm-stablecoin",
      kind: "STABLECOIN_CRYPTO",
      displayName: "Stablecoin",
      currencies: [EUR],
      credentialRequirements: [],
    });
    const basePolicy = defineAcceptancePolicy({
      id: "pap:cert:1",
      merchantRef: "merchant:cert:1",
      methods: ["STABLECOIN_CRYPTO", "CARD"],
      methodCatalog: [cryptoMethod, card],
      currencies: [EUR],
      recurring: { supported: false },
      partialPayments: { supported: false },
      refunds: { supported: true, cutoffMs: 2_592_000_000n },
      recourse: "MERCHANT_DISPUTE_WINDOW",
      customerEligibility: [],
      settlementDestination: merchantBankEuroDestination(),
      timing: { maxCompletionMs: 600_000n },
      remittance: { requiredDocumentKinds: [] },
      geography: ["DE"],
    });
    const LATER = certTimestamp(CERT_NOW + 1_000);
    let merchantProfile = draftMerchant({
      id: "merchant:cert:1",
      businessName: "Certification Merchant",
      country: "DE",
      pricingCurrency: "EUR",
      supportContact: "ops@cert.example",
      now: certTimestamp(CERT_NOW),
    });
    merchantProfile = submitMerchantApplication(merchantProfile, LATER);
    merchantProfile = verifyMerchant(merchantProfile, { verificationRef: "verify:cert:i:1", now: LATER });
    merchantProfile = activateMerchant(merchantProfile, {
      settlementDestination: merchantBankEuroDestination(),
      now: LATER,
    });
    const activation = activateCryptoAcceptance({
      id: "act:cert:i:1",
      merchant: merchantProfile,
      policyInput: merchantCryptoPolicyInput(),
      basePolicy,
      now: LATER,
    });
    const railBinding = defineRailAssetBinding({
      merchantAssetId: USC_CRYPTO_ASSET.id,
      merchantChainId: CHAIN,
      chainRef: CHAIN,
      assetIdentity: { ...USC_ASSET },
    });
    const quote = euroFixtureQuote();
    const flow = openCheckoutFlow({
      id: "flow:cert:i",
      merchantId: merchantProfile.id,
      activation,
      basePolicy,
      cart: { amount: MERCHANT_CART_EUR },
      quotes: [quote],
      railBindings: [railBinding],
      now: LATER,
      expiresAt: certTimestamp(CERT_NOW + 30_000),
    });
    const optionId = `crypto:${USC_CRYPTO_ASSET.id}@${CHAIN}`;
    const { pipeline } = prepareCheckoutWrite({
      flow,
      optionId,
      customerWalletAddress: CUSTOMER_WALLET,
      destinationAddress: MERCHANT_DESTINATION_X,
      writeId: "write:cert:i:1",
      requestedBy: "agent:certification-key-1",
      policy: certSecurityPolicy({ allowedDestinations: [MERCHANT_DESTINATION_X] }),
      now: LATER,
    });
    pipeline.simulate(
      transferSimulation("write:cert:i:1", {
        asset: USC_ASSET,
        minorUnits: quote.cryptoAmount.value.toString(),
        from: CUSTOMER_WALLET,
        to: MERCHANT_DESTINATION_X,
        at: CERT_NOW + 1_000,
      }),
      CERT_NOW + 1_000,
    );
    const gate = pipeline.runGates(certSecurityState({ observedAt: CERT_NOW + 1_000 }), CERT_NOW + 1_000);
    journeyRequires(gate.decision === "ALLOW", "the checkout gates must ALLOW");
    const bundle = buildCheckoutAuthorization({
      pipeline,
      requestId: "authreq:cert:i",
      principal: CERT_SERVICE_PRINCIPAL,
      merchantName: merchantProfile.businessName,
      option: {
        kind: "CRYPTO_WALLET_PAYMENT",
        optionId,
        assetId: USC_CRYPTO_ASSET.id,
        chainId: CHAIN_ID,
        railBinding,
        quote,
        displayAmount: quote.cryptoAmount,
      },
      customerWalletAddress: CUSTOMER_WALLET,
      destinationAddress: MERCHANT_DESTINATION_X,
      now: LATER,
    });
    authorizeCheckoutPayment(pipeline, {
      surface: certApprovalSurface(),
      approverRef: CUSTOMER_APPROVER_REF,
      securityState: certSecurityState({ observedAt: CERT_NOW + 1_000 }),
      expiresAt: certTimestamp(CERT_NOW + 30_000),
      now: LATER,
    });
    recheckCheckoutPayment(
      pipeline,
      recheckObservationFor(pipeline.prepared, certSecurityState({ observedAt: CERT_NOW + 2_000 }), CERT_NOW + 2_000),
      certTimestamp(CERT_NOW + 2_000),
    );
    const signingRequest = handOffForBroadcast(pipeline, {
      requestId: "signreq:cert:i",
      adapter: CERT_SIGNER_ADAPTER,
      now: LATER,
    });
    const handoffReceipt = submitAtTrustedSurface(signingRequest, "tx:cert:i:1", CERT_NOW + 3_000);
    const lineage = walletPaymentAuthorizationLineage({
      bundle,
      signingRequest,
      handoffReceipt,
      chainRef: signingRequest.chain,
    });
    let intentRecord = attachMethodToIntent(flow.intent, LATER);
    intentRecord = confirmIntentSubmission(intentRecord, LATER);
    let attempt = submitWalletPaymentAttempt({
      attemptId: "attempt:cert:i:1",
      intent: intentRecord,
      quote,
      authorization: lineage,
      now: LATER,
    });
    // The REORG: the attempt observes OUTCOME_UNKNOWN with evidence.
    attempt = observeAttemptOutcome(
      attempt,
      {
        kind: "OUTCOME_UNKNOWN",
        evidenceIds: ["evidence:cert:i:reorg-observation"],
      },
      LATER,
    );
    const unknownAttemptState = attempt.attempt.state;
    // Ambiguity evidence APPENDS, never mutates.
    attempt = recordAmbiguityEvidence(attempt, ["evidence:cert:i:recheck-1", "evidence:cert:i:provider-requery"], LATER);
    const stateAfterAmbiguity = attempt.attempt.state;
    // The blind-retry law (the landed machine + record discipline):
    // (a) the UNKNOWN record is frozen and never mutated;
    const unknownRecordFrozen = Object.isFrozen(attempt.attempt);
    // (b) the attempt machine declares SUBMIT only from PENDING — there is
    //     no resubmit transition, and OUTCOME_UNKNOWN only exits via the
    //     declared RESOLVE events;
    // Machine-law probes (canTransition — the machine's own contract):
    // SUBMIT is possible ONLY from PENDING (no resubmit path exists), and
    // OUTCOME_UNKNOWN can only be exited by the resolution events.
    const machine = merchantPaymentAttemptStateMachine;
    const statesAll = machine.states;
    // A minimal well-formed machine context (the SUBMIT guard reads now and
    // the quote validity; the resolution events are unguarded).
    const machineContext = { now: 0, quoteValidUntil: 1 } as never;
    const submitOrigins = statesAll.filter(
      (state) => state !== "PENDING" && machine.canTransition(state, "SUBMIT", machineContext),
    );
    const submitOnlyFromPending =
      submitOrigins.length === 0 && machine.canTransition("PENDING", "SUBMIT", machineContext);
    const resolutionEvents = ["RESOLVE_SUCCEEDED", "RESOLVE_FAILED"] as const;
    const otherEvents = ["SUBMIT", "CONFIRM_SUCCEEDED", "CONFIRM_FAILED", "REPORT_UNKNOWN", "ABANDON"] as const;
    const unknownExitsAreResolutions =
      resolutionEvents.some((event) => machine.canTransition("OUTCOME_UNKNOWN", event, machineContext)) &&
      otherEvents.every((event) => !machine.canTransition("OUTCOME_UNKNOWN", event, machineContext));
    // (c) a blind retry of the SAME quote after its expiry is rejected —
    //     a fresh quote is structurally required.
    let expiredQuoteRetryRejected = false;
    try {
      submitWalletPaymentAttempt({
        attemptId: "attempt:cert:i:expired-retry",
        intent: intentRecord,
        quote,
        authorization: lineage,
        now: quote.validUntil,
      });
    } catch {
      expiredQuoteRetryRejected = true;
    }
    // The reconciliation-only exit: the typed UnknownOutcomeResolution.
    const settled = resolveAttemptUnknown(
      attempt,
      {
        resolvedOutcome: "CONFIRMED_SUCCEEDED",
        resolvedBy: { principalType: "user", principalId: "reconciler:cert:1" },
        caseId: "case:cert:i:reorg-1",
        evidenceIds: ["evidence:cert:i:reorg-observation", "evidence:cert:i:provider-requery"],
      },
      LATER,
    );
    const settledState = settled.attempt.state;

    // ------------------------------------------------------------------
    // Leg 4 — the reorg vocabulary (chain family semantics)
    // ------------------------------------------------------------------
    const probabilisticConsistent = finalityReorgConsistency("PROBABILISTIC", "PRESENT");

    const stages = [
      stage(
        "LANE_WALK_UNKNOWN",
        "the lane walk with a reorganized receipt produced OUTCOME_UNKNOWN — never success, never failure",
        [
          `outcome:${unknownExecution.outcome}`,
          `unknownReason:${(unknownExecution.observation as { unknownReason?: string }).unknownReason?.slice(0, 60)}…`,
          `lifecycle:${unknownExecution.lifecycleStages.join(">")}`,
        ],
        [...unknownExecution.evidenceRefs],
      ),
      stage(
        "RAIL_MAPPING_UNKNOWN",
        "the canonical settlement mapping produced RAIL_EFFECT_UNKNOWN with requiresReconciliation and a CONFIRM-resolution event candidate",
        [
          `railOutcome:${unknownExecution.railOutcome.kind}`,
          `requiresReconciliation:${unknownExecution.railOutcome.kind === "RAIL_EFFECT_UNKNOWN" && unknownExecution.railOutcome.requiresReconciliation}`,
          `eventCandidate:${unknownExecution.eventCandidate.kind === "EVENT_CANDIDATE" ? unknownExecution.eventCandidate.event : unknownExecution.eventCandidate.reason}`,
        ],
        [...unknownExecution.railOutcome.evidenceRefs],
      ),
      stage(
        "ROUTE_WALK_REQUIRES_RECONCILIATION",
        "the faulted route walk stopped at ROUTE_REQUIRES_RECONCILIATION with blind retry forbidden and the settlement reconciliation authority as the only resolver",
        [
          `walk:${unknownWalk.status}`,
          `blindRetryForbidden:${unknownWalk.reconciliation?.blindRetryForbidden ?? false}`,
          `resolver:${unknownWalk.reconciliation?.resolver ?? "none"}`,
          `custodyAtStop:${unknownWalk.custodyAtStop?.party.kind ?? "none"}:${unknownWalk.custodyAtStop?.assetRef ?? ""}`,
        ],
        [...(unknownWalk.reconciliation?.reasons ?? [])],
      ),
      stage(
        "MERCHANT_LIFECYCLE_UNKNOWN",
        "the merchant attempt observed OUTCOME_UNKNOWN, ambiguity evidence appended without state mutation, and the ONLY exit was the typed reconciliation resolution",
        [
          `attemptState:${unknownAttemptState}`,
          `stateAfterAmbiguityEvidence:${stateAfterAmbiguity}`,
          `unknownRecordFrozen:${unknownRecordFrozen}`,
          `submitOnlyFromPending:${submitOnlyFromPending}`,
          `unknownExitsAreResolutions:${unknownExitsAreResolutions}`,
          `expiredQuoteRetryRejected:${expiredQuoteRetryRejected}`,
          `resolvedState:${settledState}`,
          `caseId:case:cert:i:reorg-1`,
        ],
        ["evidence:cert:i:reorg-observation", "evidence:cert:i:provider-requery"],
      ),
      stage(
        "REORG_VOCABULARY",
        "probabilistic finality declares reorg risk PRESENT (consistency holds); a reorg-detected candidate is representable and re-validation keeps the UNKNOWN observation honest",
        [
          `finalityModel:PROBABILISTIC`,
          `reorgRisk:PRESENT`,
          `finalityReorgConsistency:${probabilisticConsistent}`,
          `revalidatedOutcome:${revalidated.outcome}`,
        ],
        ["evidence:cert:i:reorg-vocabulary"],
      ),
    ];

    const assertions = [
      assertionFromChecks(
        "i:unknown-never-fake-success",
        [
          { check: "the lane observation is OUTCOME_UNKNOWN (not SUCCEEDED, not FAILED)", passed: unknownExecution.outcome === "OUTCOME_UNKNOWN" },
          { check: "the observation carries the reorg reason verbatim", passed: (unknownExecution.observation as { unknownReason?: string }).unknownReason === REORG_REASON },
          { check: "the kernel validator accepts the UNKNOWN observation with NO failure descriptor (INV-X01)", passed: revalidated.outcome === "OUTCOME_UNKNOWN" && (revalidated as { failure?: unknown }).failure === undefined },
          { check: "the walk's lifecycle stages include reconcile", passed: unknownExecution.lifecycleStages.includes("reconcile") },
        ],
        [...unknownExecution.evidenceRefs],
      ),
      assertionFromChecks(
        "i:rail-outcome-unknown-requires-reconciliation",
        [
          { check: "the rail outcome kind is RAIL_EFFECT_UNKNOWN", passed: unknownExecution.railOutcome.kind === "RAIL_EFFECT_UNKNOWN" },
          { check: "requiresReconciliation is literally true", passed: unknownExecution.railOutcome.kind === "RAIL_EFFECT_UNKNOWN" && unknownExecution.railOutcome.requiresReconciliation === true },
          { check: "the event candidate is the OUTCOME_UNKNOWN settlement event", passed: unknownExecution.eventCandidate.kind === "EVENT_CANDIDATE" && unknownExecution.eventCandidate.event === "OUTCOME_UNKNOWN" },
        ],
        [...unknownExecution.railOutcome.evidenceRefs],
      ),
      assertionFromChecks(
        "i:route-walk-reconciliation-only",
        [
          { check: "the faulted walk is ROUTE_REQUIRES_RECONCILIATION", passed: unknownWalk.status === "ROUTE_REQUIRES_RECONCILIATION" },
          { check: "blind retry forbidden", passed: unknownWalk.reconciliation?.blindRetryForbidden === true },
          { check: "the only resolver is the settlement reconciliation authority", passed: unknownWalk.reconciliation?.resolver === "SETTLEMENT_RECONCILIATION_AUTHORITY" },
        ],
        [...(unknownWalk.reconciliation?.reasons ?? [])],
      ),
      assertionFromChecks(
        "i:merchant-unknown-reconciliation-exit",
        [
          { check: "the attempt observed OUTCOME_UNKNOWN", passed: unknownAttemptState === "OUTCOME_UNKNOWN" },
          { check: "ambiguity evidence appended WITHOUT mutating the state", passed: stateAfterAmbiguity === "OUTCOME_UNKNOWN" },
          { check: "the UNKNOWN record is frozen (immutable history)", passed: unknownRecordFrozen },
          { check: "the attempt machine declares SUBMIT only from PENDING (no resubmit transition exists)", passed: submitOnlyFromPending },
          { check: "OUTCOME_UNKNOWN only exits via the declared RESOLUTION events", passed: unknownExitsAreResolutions },
          { check: "a blind retry of the same expired quote was rejected (a fresh quote is required)", passed: expiredQuoteRetryRejected },
          { check: "the typed resolution exited UNKNOWN to CONFIRMED_SUCCEEDED with a case id and evidence", passed: settledState === "CONFIRMED" },
        ],
        ["evidence:cert:i:reorg-observation"],
      ),
      assertionFromChecks(
        "i:reorg-represented",
        [
          { check: "probabilistic finality + reorg risk PRESENT is a consistent chain declaration (finalityReorgConsistency true)", passed: probabilisticConsistent === true },
        ],
        ["evidence:cert:i:reorg-vocabulary"],
      ),
    ];

    return assembleJourneyOutcome({ journey: journeyI, stages, assertions });
  },
};

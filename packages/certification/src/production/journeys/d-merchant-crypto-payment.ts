/**
 * Journey D — Merchant crypto payment (§35).
 *
 * Merchant: charge €100. Customer: pays crypto.
 * PaySwap: accept → route → secure → settle → merchant receives
 * configured settlement.
 *
 * Where eligible: customer crypto → Stripe-supported crypto payment →
 * Stripe → merchant fiat Stripe balance (settlement mode
 * NATIVE_STRIPE_CRYPTO); otherwise the external conversion settlement
 * (mode PAYSWAP_EXTERNAL_SETTLEMENT) carrying the W4-001
 * honest-unavailability notice verbatim. The §3.9 reconciliation between
 * the work-item mode vocabulary and the landed route-family literals is
 * asserted in BOTH directions (round-trip + disjointness).
 *
 * Real composition: the W2-003 merchant-checkout package end-to-end —
 * onboarding machine (DRAFT→SUBMITTED→VERIFIED→ACTIVE), composed crypto
 * acceptance activation, checkout session with quotes-as-observations and
 * exact bigint cross-multiplication display amounts, the customer wallet
 * payment through the REAL W1-002 kernel (explicit signing at the
 * injected trusted surface; authorization-without-explicit-signing is
 * structurally unrepresentable), the payment lifecycle with mandatory
 * wallet-authorization lineage, idempotent-by-event-id webhooks,
 * rail-capability-gated refunds, and BOTH settlement modes through the
 * provider-verified Stripe confirmation law.
 */

import { fromMinorUnits } from "@payswap/protocol";
import { defineAcceptancePolicy, definePaymentMethod } from "@payswap/payment";
import {
  STRIPE_NATIVE_SETTLEMENT_UNAVAILABLE_NOTICE,
} from "@payswap/route-compiler";
import {
  activateCryptoAcceptance,
  activateMerchant,
  assertSettlementModeDiscriminated,
  attachAttemptSettlementRoute,
  attachMethodToIntent,
  authorizeCheckoutPayment,
  buildCheckoutAuthorization,
  confirmIntentSubmission,
  defineRailAssetBinding,
  draftMerchant,
  handOffForBroadcast,
  initiateRefund,
  observeAttemptOutcome,
  observeNativeStripeRefundSupport,
  observeRefundOutcome,
  openCheckoutFlow,
  prepareCheckoutWrite,
  recheckCheckoutPayment,
  routeFamilySettlementMode,
  selectSettlementRoute,
  settleConfirmedAttempt,
  settleIntentOutcome,
  settlementModeRouteFamily,
  submitMerchantApplication,
  submitRefund,
  submitWalletPaymentAttempt,
  verifyMerchant,
  walletPaymentAuthorizationLineage,
} from "@payswap/merchant-checkout";
import type { CheckoutFlow, MerchantProfile } from "@payswap/merchant-checkout";
import { OnchainWritePipeline } from "@payswap/onchain-security";
import {
  assertionFromChecks,
  assembleJourneyOutcome,
  journeyRequires,
  stage,
  type ProductionJourney,
} from "../contract.js";
import {
  CERT_NOW,
  CERT_SIGNER_ADAPTER,
  CERT_SERVICE_PRINCIPAL,
  CHAIN,
  CUSTOMER_APPROVER_REF,
  CUSTOMER_WALLET,
  EUR,
  MERCHANT_CART_EUR,
  MERCHANT_DESTINATION_X,
  USC_ASSET,
  USC_CRYPTO_ASSET,
  CHAIN_ID,
  certApprovalSurface,
  certSecurityPolicy,
  certSecurityState,
  certTimestamp,
  euroFixtureQuote,
  merchantBankEuroDestination,
  merchantCryptoPolicyInput,
  recheckObservationFor,
  stripeConnectedInstance,
  submitAtTrustedSurface,
  transferSimulation,
} from "../world.js";

const LATER = certTimestamp(CERT_NOW + 1_000);
const RECHECK_AT = CERT_NOW + 2_000;

function basePolicyForCertMerchant() {
  const card = definePaymentMethod({
    id: "pm-card",
    kind: "CARD",
    displayName: "Card",
    currencies: [EUR],
    credentialRequirements: [],
  });
  const crypto = definePaymentMethod({
    id: "pm-stablecoin",
    kind: "STABLECOIN_CRYPTO",
    displayName: "Stablecoin",
    currencies: [EUR],
    credentialRequirements: [],
  });
  return defineAcceptancePolicy({
    id: "pap:cert:1",
    merchantRef: "merchant:cert:1",
    methods: ["STABLECOIN_CRYPTO", "CARD"],
    methodCatalog: [crypto, card],
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
}

export const journeyD: ProductionJourney = {
  journeyId: "journey:d-merchant-crypto-payment",
  letter: "D",
  title: "Merchant crypto payment — charge \u20ac100, customer pays crypto (both Stripe settlement modes)",
  spec: "docs/UNIVERSAL-MONEY-HANDOFF-FULL-2026-10-02.md §35 Journey D",
  run: (): ReturnType<typeof assembleJourneyOutcome> => {
    const basePolicy = basePolicyForCertMerchant();

    // ------------------------------------------------------------------
    // 1. Accept: merchant onboarding (DRAFT→SUBMITTED→VERIFIED→ACTIVE)
    // ------------------------------------------------------------------
    let profile: MerchantProfile = draftMerchant({
      id: "merchant:cert:1",
      businessName: "Certification Merchant",
      country: "DE",
      pricingCurrency: "EUR",
      supportContact: "ops@cert.example",
      now: certTimestamp(CERT_NOW),
    });
    profile = submitMerchantApplication(profile, LATER);
    profile = verifyMerchant(profile, { verificationRef: "verify:cert:1", now: LATER });
    profile = activateMerchant(profile, {
      settlementDestination: merchantBankEuroDestination(),
      now: LATER,
    });
    const activation = activateCryptoAcceptance({
      id: "act:cert:1",
      merchant: profile,
      policyInput: merchantCryptoPolicyInput(),
      basePolicy,
      now: LATER,
    });

    // ------------------------------------------------------------------
    // 2. Route: checkout session with the exact cross-multiplied quote
    // ------------------------------------------------------------------
    const railBinding = defineRailAssetBinding({
      merchantAssetId: USC_CRYPTO_ASSET.id,
      merchantChainId: CHAIN,
      chainRef: CHAIN,
      assetIdentity: { ...USC_ASSET },
    });
    const quote = euroFixtureQuote();
    const flow: CheckoutFlow = openCheckoutFlow({
      id: "flow:cert:d",
      merchantId: profile.id,
      activation,
      basePolicy,
      cart: { amount: MERCHANT_CART_EUR },
      quotes: [quote],
      railBindings: [railBinding],
      now: LATER,
      expiresAt: certTimestamp(CERT_NOW + 30_000),
    });
    const cryptoOptionId = `crypto:${USC_CRYPTO_ASSET.id}@${CHAIN}`;
    const cryptoOption = flow.options.find((option) => option.optionId === cryptoOptionId);
    journeyRequires(cryptoOption !== undefined, "the crypto wallet payment option must be offered");

    // ------------------------------------------------------------------
    // 3. Secure: the REAL kernel walk for the customer wallet payment
    // ------------------------------------------------------------------
    const { pipeline } = prepareCheckoutWrite({
      flow,
      optionId: cryptoOptionId,
      customerWalletAddress: CUSTOMER_WALLET,
      destinationAddress: MERCHANT_DESTINATION_X,
      writeId: "write:cert:d:1",
      requestedBy: "agent:certification-key-1",
      policy: certSecurityPolicy({
        allowedDestinations: [MERCHANT_DESTINATION_X, ...[]],
      }),
      now: LATER,
    });
    pipeline.simulate(
      transferSimulation("write:cert:d:1", {
        asset: USC_ASSET,
        minorUnits: quote.cryptoAmount.value.toString(),
        from: CUSTOMER_WALLET,
        to: MERCHANT_DESTINATION_X,
        at: CERT_NOW + 1_000,
      }),
      CERT_NOW + 1_000,
    );
    const gateDecision = pipeline.runGates(certSecurityState({ observedAt: CERT_NOW + 1_000 }), CERT_NOW + 1_000);
    journeyRequires(gateDecision.decision === "ALLOW", `the checkout gates must ALLOW (got ${gateDecision.decision})`);
    const bundle = buildCheckoutAuthorization({
      pipeline,
      requestId: "authreq:cert:d",
      principal: CERT_SERVICE_PRINCIPAL,
      merchantName: profile.businessName,
      option: {
        kind: "CRYPTO_WALLET_PAYMENT",
        optionId: cryptoOptionId,
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
    const recheckOutcome = recheckCheckoutPayment(
      pipeline,
      recheckObservationFor(pipeline.prepared, certSecurityState({ observedAt: RECHECK_AT }), RECHECK_AT),
      certTimestamp(RECHECK_AT),
    );
    journeyRequires(recheckOutcome.outcome === "RECHECK_OK", "the checkout recheck must pass");
    const signingRequest = handOffForBroadcast(pipeline, {
      requestId: "signreq:cert:d",
      adapter: CERT_SIGNER_ADAPTER,
      now: LATER,
    });
    const handoffReceipt = submitAtTrustedSurface(signingRequest, "tx:cert:d:1", CERT_NOW + 3_000);
    const lineage = walletPaymentAuthorizationLineage({
      bundle,
      signingRequest,
      handoffReceipt,
      chainRef: signingRequest.chain,
    });

    // ------------------------------------------------------------------
    // 4. Lifecycle: intent + attempt with the MANDATORY lineage
    // ------------------------------------------------------------------
    let intent = attachMethodToIntent(flow.intent, LATER);
    intent = confirmIntentSubmission(intent, LATER);
    let attempt = submitWalletPaymentAttempt({
      attemptId: "attempt:cert:d:1",
      intent,
      quote,
      authorization: lineage,
      now: LATER,
    });
    const confirmed = observeAttemptOutcome(
      attempt,
      {
        kind: "SUCCEEDED",
        evidenceIds: ["evidence:cert:d:confirmation", "evidence:cert:d:receipt"],
        externalTxRef: "tx:cert:d:1",
      },
      LATER,
    );
    intent = settleIntentOutcome(intent, confirmed, {
      evidenceIds: ["evidence:cert:d:confirmation"],
      now: LATER,
    });
    attempt = confirmed;

    // ------------------------------------------------------------------
    // 5. Settle — mode A: NATIVE_STRIPE_CRYPTO (provider-verified)
    // ------------------------------------------------------------------
    const nativeSelection = selectSettlementRoute({
      desiredMode: "NATIVE_STRIPE_CRYPTO",
      native: {
        connectedInstance: stripeConnectedInstance(),
        settlementCurrency: "EUR",
        supportedAssets: [USC_CRYPTO_ASSET.id],
        evidenceRefs: ["evidence:cert:eligibility:native"],
      },
      external: {
        destination: merchantBankEuroDestination(),
        conversionChain: ["cap:cert:conversion-1"],
      },
    });
    journeyRequires(
      nativeSelection.selected === "NATIVE_STRIPE_CRYPTO",
      "the native Stripe path must be eligible for the EUR-scoped connected instance",
    );
    const withNativeRoute = attachAttemptSettlementRoute(confirmed, nativeSelection.route, LATER);
    const nativeSettled = settleConfirmedAttempt({
      settlementId: "settlement:cert:d:native",
      attempt: withNativeRoute,
      selection: nativeSelection,
      confirmationInput: {
        confirmationId: "stripe-confirmation:cert:1",
        connectedInstanceId: "inst:cert:stripe:1",
        stripeBalanceTxRef: "txn_cert-balance-1",
        amount: MERCHANT_CART_EUR,
        providerStateEnvelopeRef: "envelope:cert:stripe:1",
        evidenceIds: ["evidence:cert:stripe-confirmation"],
      },
      protocolInstructionId: "SI:cert:d:1",
      protocolSettlementAttemptIds: ["SA:cert:d:1"],
      now: LATER,
    });

    // ------------------------------------------------------------------
    // 5b. Settle — mode B: PAYSWAP_EXTERNAL_SETTLEMENT (the honest notice)
    // ------------------------------------------------------------------
    const externalSelection = selectSettlementRoute({
      desiredMode: "PAYSWAP_EXTERNAL_SETTLEMENT",
      external: {
        destination: merchantBankEuroDestination(),
        conversionChain: ["cap:cert:conversion-1"],
      },
    });
    if (externalSelection.selected !== "PAYSWAP_EXTERNAL_SETTLEMENT") {
      throw new Error("production journey structural prerequisite failed: the external settlement mode must select the external route");
    }
    const withExternalRoute = attachAttemptSettlementRoute(confirmed, externalSelection.route, LATER);
    const externalSettled = settleConfirmedAttempt({
      settlementId: "settlement:cert:d:external",
      attempt: withExternalRoute,
      selection: externalSelection,
      protocolInstructionId: "SI:cert:d:2",
      protocolSettlementAttemptIds: ["SA:cert:d:2"],
      now: LATER,
    });

    // ------------------------------------------------------------------
    // 6. Refund on the native rail (capability-gated, partial)
    // ------------------------------------------------------------------
    const refundSupport = observeNativeStripeRefundSupport({
      observationId: "rail-obs:cert:1",
      connectedInstance: stripeConnectedInstance(),
      evidenceRefs: ["evidence:cert:rail-observation"],
      observedAt: LATER,
    });
    const refundInitiation = initiateRefund({
      refundId: "refund:cert:1",
      attempt: confirmed,
      originalAmount: MERCHANT_CART_EUR,
      amount: fromMinorUnits(EUR, 5_000n),
      railSupport: refundSupport,
      destinationRef: CUSTOMER_WALLET,
      recourse: "MERCHANT_DISPUTE_WINDOW",
      now: LATER,
    });
    if (refundInitiation.outcome !== "REFUND_STARTED") {
      throw new Error("production journey structural prerequisite failed: the native rail refund must start (capability observed)");
    }
    let refund = submitRefund(refundInitiation.refund, {
      submissionRef: "refund-sub:cert:1",
      now: LATER,
    });
    refund = observeRefundOutcome(
      refund,
      { kind: "SUCCEEDED", evidenceIds: ["evidence:cert:refund-confirmation"] },
      LATER,
    );

    // §3.9 reconciliation: round-trip + disjointness both directions.
    const nativeFamily = settlementModeRouteFamily("NATIVE_STRIPE_CRYPTO");
    const externalFamily = settlementModeRouteFamily("PAYSWAP_EXTERNAL_SETTLEMENT");
    const discriminantsOk = (() => {
      try {
        assertSettlementModeDiscriminated({
          mode: "NATIVE_STRIPE_CRYPTO",
          connectedInstanceId: "inst:cert:stripe:1",
          stripeAccountRef: "acct-stripe-merchant-001",
          settlementCurrency: "EUR",
        });
        assertSettlementModeDiscriminated({
          mode: "PAYSWAP_EXTERNAL_SETTLEMENT",
          destination: merchantBankEuroDestination(),
          conversionChain: ["cap:cert:conversion-1"],
        });
        return true;
      } catch {
        return false;
      }
    })();

    const pipelineStates = pipeline
      .evidence()
      .map((entry) => entry.state);

    const stages = [
      stage(
        "MERCHANT_ACCEPT",
        "the onboarding machine accepted the merchant (DRAFT→SUBMITTED→VERIFIED→ACTIVE) and the composed crypto acceptance activated",
        [
          `merchant:${profile.id}:${profile.state}`,
          `activation:${activation.id}`,
          `acceptancePolicy:${activation.policy.id}`,
        ],
        [`evidence:cert:onboarding:${profile.id}`],
      ),
      stage(
        "CHECKOUT_ROUTE",
        "the checkout session opened with the crypto option quoted at an exact bigint cross-multiplication (€100.00 ↔ 100 USC)",
        [
          `flow:${flow.session.id}`,
          `option:${cryptoOptionId}`,
          `quote:${quote.id}`,
          `displayAmount:${quote.cryptoAmount.value.toString()}`,
        ],
        [`evidence:cert:quote:${quote.id}`],
      ),
      stage(
        "SECURE_KERNEL_WALK",
        "the REAL W1-002 kernel walked the customer wallet payment: simulate → gates ALLOW → diff → authorization request → explicit signing → recheck → handoff",
        [
          `pipelineStates:${pipelineStates.join(">")}`,
          `gate:${gateDecision.decision}`,
          `authorizationRequest:${bundle.request.requestHash}`,
        ],
        [`evidence:authorization:${bundle.request.requestHash}`],
      ),
      stage(
        "PAYMENT_LIFECYCLE",
        "the attempt was submitted with the MANDATORY wallet-authorization lineage and confirmed with evidence; the intent settled SUCCEEDED",
        [
          `attempt:${attempt.attempt.id}:${attempt.attempt.state}`,
          `intent:${intent.id}:${intent.state}`,
          `lineage:authReq:${lineage.authorizationRequestHash}`,
          `externalSubmission:${lineage.externalSubmissionRef}`,
        ],
        ["evidence:cert:d:confirmation", "evidence:cert:d:receipt"],
      ),
      stage(
        "SETTLE_NATIVE_STRIPE",
        "settlement mode NATIVE_STRIPE_CRYPTO settled through the provider-verified Stripe confirmation (no synthetic balance effect is representable)",
        [
          `selection:${nativeSelection.selected}`,
          `routeFamily:${nativeSettled.settlement.routeFamily}`,
          `stripeBalanceTx:${nativeSettled.settlement.routeFamily === "NATIVE_STRIPE_CRYPTO" ? "txn_cert-balance-1" : "none"}`,
        ],
        ["evidence:cert:stripe-confirmation", "evidence:cert:eligibility:native"],
      ),
      stage(
        "SETTLE_EXTERNAL_CONVERSION",
        "settlement mode PAYSWAP_EXTERNAL_SETTLEMENT settled through the external conversion route carrying the W4-001 honest-unavailability notice verbatim",
        [
          `selection:${externalSelection.selected}`,
          `routeFamily:${externalSettled.settlement.routeFamily}`,
          `notice:${externalSelection.nativeUnavailable.notice}`,
          `noticeReason:${externalSelection.nativeUnavailable.reason}`,
        ],
        ["evidence:cert:external-settlement"],
      ),
      stage(
        "REFUND",
        "the refund was capability-gated on the native rail observation and started as a partial refund",
        [
          `refundSupport:${refundSupport.supportsRefunds}`,
          `refund:${refundInitiation.outcome}`,
          `refundFinal:${refund.state}`,
        ],
        ["evidence:cert:rail-observation", "evidence:cert:refund-confirmation"],
      ),
      stage(
        "SECTION_3_9_RECONCILIATION",
        "the work-item mode vocabulary and the landed route-family literals reconcile in both directions with disjoint fields",
        [
          `NATIVE_STRIPE_CRYPTO→${nativeFamily}`,
          `PAYSWAP_EXTERNAL_SETTLEMENT→${externalFamily}`,
          `${nativeFamily}→${routeFamilySettlementMode(nativeFamily)}`,
          `${externalFamily}→${routeFamilySettlementMode(externalFamily)}`,
          `discriminantsOk:${discriminantsOk}`,
        ],
        ["evidence:cert:settlement-mode-reconciliation"],
      ),
    ];

    const assertions = [
      assertionFromChecks(
        "d:accept-and-route",
        [
          { check: "the merchant reached ACTIVE", passed: profile.state === "ACTIVE" },
          { check: "the crypto option was offered with the exact €100 quote", passed: cryptoOption !== undefined && quote.fiatAmount.value === 10_000n },
          { check: "the displayed crypto amount satisfies the exact cross-multiplication (INV-F01)", passed: quote.fiatAmount.value * quote.ratio.denominator === quote.cryptoAmount.value * quote.ratio.numerator },
        ],
        [`evidence:cert:quote:${quote.id}`],
      ),
      assertionFromChecks(
        "d:secure",
        [
          { check: "the kernel pipeline reached BROADCAST_HANDOFF through the full evidence chain", passed: pipeline.state === "BROADCAST_HANDOFF" && pipelineStates.includes("GATED_ALLOW") && pipelineStates.includes("AUTHORIZED") && pipelineStates.includes("RECHECKED") },
          { check: "the payment summary renders to the customer before signing", passed: bundle.paymentSummary.length > 0 },
          { check: "the diff rendering is human-readable (the typed disclosure)", passed: bundle.diffRendering.length > 0 },
        ],
        [`evidence:authorization:${bundle.request.requestHash}`],
      ),
      assertionFromChecks(
        "d:lifecycle-and-lineage",
        [
          { check: "the attempt is CONFIRMED with evidence", passed: attempt.attempt.state === "CONFIRMED" },
          { check: "the intent is SUCCEEDED at exactly €100.00", passed: intent.state === "SUCCEEDED" && intent.amount.value === 10_000n },
          { check: "the wallet-authorization lineage binds the request hash, signing request and external submission", passed: lineage.authorizationRequestHash === bundle.request.requestHash && lineage.externalSubmissionRef === "tx:cert:d:1" },
        ],
        ["evidence:cert:d:confirmation"],
      ),
      assertionFromChecks(
        "d:settle-both-modes",
        [
          { check: "native mode settled with a provider-verified confirmation", passed: nativeSettled.settlement.routeFamily === "NATIVE_STRIPE_CRYPTO" },
          { check: "external mode settled through the external conversion route", passed: externalSettled.settlement.routeFamily === "EXTERNAL_PAYSWAP_CONVERSION" },
          { check: "the external selection carries the honest-unavailability notice VERBATIM (the W4-001 law)", passed: externalSelection.nativeUnavailable.notice === STRIPE_NATIVE_SETTLEMENT_UNAVAILABLE_NOTICE },
          { check: "the notice reason is the typed MERCHANT_CONFIGURED_EXTERNAL", passed: externalSelection.nativeUnavailable.reason === "MERCHANT_CONFIGURED_EXTERNAL" },
        ],
        ["evidence:cert:stripe-confirmation", "evidence:cert:external-settlement"],
      ),
      assertionFromChecks(
        "d:section-3-9-reconciliation",
        [
          { check: "mode → family mapping is the documented one (never renamed)", passed: nativeFamily === "NATIVE_STRIPE_CRYPTO" && externalFamily === "EXTERNAL_PAYSWAP_CONVERSION" },
          { check: "family → mode round-trips both literals", passed: routeFamilySettlementMode("NATIVE_STRIPE_CRYPTO") === "NATIVE_STRIPE_CRYPTO" && routeFamilySettlementMode("EXTERNAL_PAYSWAP_CONVERSION") === "PAYSWAP_EXTERNAL_SETTLEMENT" },
          { check: "well-formed configs pass the disjointness discrimination", passed: discriminantsOk },
        ],
        ["evidence:cert:settlement-mode-reconciliation"],
      ),
      assertionFromChecks(
        "d:refund-capability-gated",
        [
          { check: "the refund started only after a typed rail-capability observation", passed: refundInitiation.outcome === "REFUND_STARTED" && refundSupport.supportsRefunds },
          { check: "the partial refund (€50.00) confirmed SUCCEEDED with evidence", passed: refund.state === "CONFIRMED" },
        ],
        ["evidence:cert:rail-observation"],
      ),
    ];

    return assembleJourneyOutcome({ journey: journeyD, stages, assertions });
  },
};

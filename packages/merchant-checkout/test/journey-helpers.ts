import { fromMinorUnits, currencyCode } from "@payswap/protocol";
import type { Money } from "@payswap/protocol";
import {
  attachMethodToIntent,
  attachAttemptSettlementRoute,
  buildCheckoutAuthorization,
  authorizeCheckoutPayment,
  handOffForBroadcast,
  observeAttemptOutcome,
  openCheckoutFlow,
  prepareCheckoutWrite,
  recheckCheckoutPayment,
  settleIntentOutcome,
  submitWalletPaymentAttempt,
  confirmIntentSubmission,
  walletPaymentAuthorizationLineage,
} from "../src/index.js";
import type {
  CheckoutAuthorizationBundle,
  CheckoutFlow,
  CheckoutPaymentAttempt,
  WalletAuthorizationLineage,
} from "../src/index.js";
import type { OnchainWritePipeline } from "@payswap/onchain-security";
import type { BroadcastHandoffReceipt } from "@payswap/onchain-security";
import {
  defineWebhookEvent,
  emptyWebhookInbox,
  processWebhookEvent,
} from "../src/index.js";
import type { WebhookInbox } from "../src/index.js";
import {
  initiateRefund,
  observeExternalConversionRefundSupport,
  observeNativeStripeRefundSupport,
  observeRefundOutcome,
  submitRefund,
} from "../src/index.js";
import type { RefundRecord } from "../src/index.js";
import {
  observeStripeCryptoSettlementEligibility,
  selectSettlementRoute,
  settleConfirmedAttempt,
} from "../src/index.js";
import type { MerchantSettlementRecord, SettlementRouteSelection } from "../src/index.js";
import {
  activeAcceptance,
  baseAcceptancePolicy,
  CART_AMOUNT,
  checkoutSecurityPolicy,
  checkoutSecurityState,
  CUSTOMER_APPROVER_REF,
  CUSTOMER_WALLET,
  CHECKOUT_SERVICE_PRINCIPAL,
  MERCHANT_DESTINATION,
  onboardedMerchant,
  successfulSimulation,
  testApprovalSurface,
  TEST_SIGNER_ADAPTER,
  recheckObservationFor,
  stripeConnectedInstance,
  USC_CRYPTO_ASSET,
  USC_RAIL_BINDING,
  NOW,
  LATER,
  EXPIRY,
  QUOTE_VALID_UNTIL,
  fixtureQuote,
} from "./fixtures.js";

/**
 * The full deterministic merchant-checkout journey through the REAL
 * composed functions (used by the journey test, the adversarial suite and
 * the evidence-file builder — one code path, no mocks of this package's
 * own logic).
 */

export interface FullJourneyResult {
  readonly profile: ReturnType<typeof onboardedMerchant>;
  readonly activation: ReturnType<typeof activeAcceptance>;
  readonly flow: CheckoutFlow;
  readonly pipeline: OnchainWritePipeline;
  readonly bundle: CheckoutAuthorizationBundle;
  readonly handoffReceipt: BroadcastHandoffReceipt;
  readonly lineage: WalletAuthorizationLineage;
  readonly intent: ReturnType<typeof flowIntent>;
  readonly attempt: CheckoutPaymentAttempt;
  readonly inbox: WebhookInbox;
  readonly refund: RefundRecord;
  readonly refundSupport: ReturnType<typeof observeNativeStripeRefundSupport>;
  readonly settlementSelection: SettlementRouteSelection;
  readonly settlement: MerchantSettlementRecord;
  readonly settledAttempt: CheckoutPaymentAttempt;
}

function flowIntent(flow: CheckoutFlow) {
  return flow.intent;
}

/**
 * Run the full journey: onboarding → acceptance activation → checkout →
 * wallet authorization (REAL kernel walk) → lifecycle → webhook updates →
 * refund → settlement (native Stripe path with a provider-verified
 * confirmation). Deterministic: same fixtures → same records.
 */
export function runFullJourney(): FullJourneyResult {
  // 1. Merchant onboarding (draft → submit → verify → activate).
  const profile = onboardedMerchant();
  // 2. Crypto acceptance activation (composed merchant-crypto policy).
  const activation = activeAcceptance({ merchant: profile });
  // 3. Checkout session construction.
  const flow = openCheckoutFlow({
    id: "flow-1",
    merchantId: profile.id,
    activation,
    basePolicy: baseAcceptancePolicy(),
    cart: { amount: CART_AMOUNT },
    quotes: [fixtureQuote()],
    railBindings: [USC_RAIL_BINDING],
    now: LATER,
    expiresAt: QUOTE_VALID_UNTIL,
  });

  // 4. Customer wallet payment through the REAL W1-002 kernel.
  const { pipeline } = prepareCheckoutWrite({
    flow,
    optionId: `crypto:${USC_CRYPTO_ASSET.id}@${USC_RAIL_BINDING.merchantChainId}`,
    customerWalletAddress: CUSTOMER_WALLET,
    destinationAddress: MERCHANT_DESTINATION,
    writeId: "write-1",
    requestedBy: "agent:checkout-service-key-1",
    policy: checkoutSecurityPolicy(),
    now: LATER,
  });
  pipeline.simulate(successfulSimulation("write-1"), Number(LATER));
  const gateDecision = pipeline.runGates(checkoutSecurityState({ observedAt: Number(LATER) }), Number(LATER));
  if (gateDecision.decision !== "ALLOW") {
    throw new Error(`fixture journey requires an ALLOW gate decision, got ${gateDecision.decision}`);
  }
  const bundle = buildCheckoutAuthorization({
    pipeline,
    requestId: "authreq-1",
    principal: CHECKOUT_SERVICE_PRINCIPAL,
    merchantName: profile.businessName,
    option: {
      kind: "CRYPTO_WALLET_PAYMENT",
      optionId: `crypto:${USC_CRYPTO_ASSET.id}@${USC_RAIL_BINDING.merchantChainId}`,
      assetId: USC_CRYPTO_ASSET.id,
      chainId: USC_RAIL_BINDING.merchantChainId,
      railBinding: USC_RAIL_BINDING,
      quote: fixtureQuote(),
      displayAmount: fixtureQuote().cryptoAmount,
    },
    customerWalletAddress: CUSTOMER_WALLET,
    destinationAddress: MERCHANT_DESTINATION,
    now: LATER,
  });
  authorizeCheckoutPayment(pipeline, {
    surface: testApprovalSurface(),
    approverRef: CUSTOMER_APPROVER_REF,
    securityState: checkoutSecurityState({ observedAt: Number(LATER) }),
    expiresAt: QUOTE_VALID_UNTIL,
    now: LATER,
  });
  const recheck = recheckCheckoutPayment(
    pipeline,
    recheckObservationFor(pipeline.prepared, checkoutSecurityState({ observedAt: Number(LATER) }), LATER),
    LATER,
  );
  if (recheck.outcome !== "RECHECK_OK") {
    throw new Error("fixture journey requires a passing recheck");
  }
  const signingRequest = handOffForBroadcast(pipeline, {
    requestId: "signreq-1",
    adapter: TEST_SIGNER_ADAPTER,
    now: LATER,
  });
  // The trusted-surface submission boundary (injected, deterministic).
  const handoffReceipt: BroadcastHandoffReceipt = {
    requestRef: signingRequest.requestId,
    submittedAt: Number(LATER),
    externalRef: "tx:fixture-external-1",
    evidenceRefs: ["evidence:submission-1"],
  };
  const lineage = walletPaymentAuthorizationLineage({
    bundle,
    signingRequest,
    handoffReceipt,
    chainRef: signingRequest.chain,
  });

  // 5. Payment lifecycle (intent + attempt over the canonical machines).
  let intent = attachMethodToIntent(flow.intent, LATER);
  intent = confirmIntentSubmission(intent, LATER);
  const attempt = submitWalletPaymentAttempt({
    attemptId: "attempt-1",
    intent,
    quote: fixtureQuote(),
    authorization: lineage,
    now: LATER,
  });
  const confirmed = observeAttemptOutcome(attempt, {
    kind: "SUCCEEDED",
    evidenceIds: ["evidence:confirmation-1", "evidence:receipt-1"],
    externalTxRef: "tx:fixture-external-1",
  }, LATER);
  intent = settleIntentOutcome(intent, confirmed, {
    evidenceIds: ["evidence:confirmation-1"],
    now: LATER,
  });

  // 6. Webhook updates (applied + a replayed duplicate).
  let inbox = emptyWebhookInbox();
  const submittedEvent = defineWebhookEvent({
    eventId: "evt-1",
    payload: {
      eventType: "payment_attempt.submitted",
      attemptId: "attempt-1",
      intentId: intent.id,
      authorizationRequestHash: lineage.authorizationRequestHash,
      externalTxRef: "tx:fixture-external-1",
      evidenceIds: ["evidence:submission-1"],
    },
    occurredAt: LATER,
  });
  inbox = processWebhookEvent(inbox, submittedEvent, () => undefined).inbox;
  const confirmedEvent = defineWebhookEvent({
    eventId: "evt-2",
    payload: {
      eventType: "payment_attempt.confirmed",
      attemptId: "attempt-1",
      intentId: intent.id,
      evidenceIds: ["evidence:confirmation-1"],
    },
    occurredAt: LATER,
  });
  inbox = processWebhookEvent(inbox, confirmedEvent, () => undefined).inbox;
  // Replay of evt-1: DUPLICATE, never applied twice.
  inbox = processWebhookEvent(inbox, submittedEvent, () => {
    throw new Error("a replayed event must never run the handler again");
  }).inbox;

  // 7. Refund (native rail observation → partial refund → confirmed).
  const refundSupport = observeNativeStripeRefundSupport({
    observationId: "rail-obs-1",
    connectedInstance: stripeConnectedInstance(),
    evidenceRefs: ["evidence:rail-observation-1"],
    observedAt: LATER,
  });
  const initiation = initiateRefund({
    refundId: "refund-1",
    attempt: confirmed,
    originalAmount: CART_AMOUNT,
    amount: fromMinorUnits(currencyCode("USD"), 4_950n),
    railSupport: refundSupport,
    destinationRef: CUSTOMER_WALLET,
    recourse: "MERCHANT_DISPUTE_WINDOW",
    now: LATER,
  });
  if (initiation.outcome !== "REFUND_STARTED") {
    throw new Error("fixture journey requires a refund-supporting rail");
  }
  let refund = submitRefund(initiation.refund, {
    submissionRef: "refund-sub-1",
    now: LATER,
  });
  refund = observeRefundOutcome(refund, {
    kind: "SUCCEEDED",
    evidenceIds: ["evidence:refund-confirmation-1"],
  }, LATER);

  // 8. Settlement: native Stripe path with a provider-verified confirmation.
  const settlementSelection = selectSettlementRoute({
    desiredMode: "NATIVE_STRIPE_CRYPTO",
    native: {
      connectedInstance: stripeConnectedInstance(),
      settlementCurrency: "USD",
      supportedAssets: [USC_CRYPTO_ASSET.id],
      evidenceRefs: ["evidence:eligibility-1"],
    },
    external: {
      destination: baseAcceptancePolicy().settlementDestination,
      conversionChain: ["cap:fixture-conversion-1"],
    },
  });
  const eligibilityObservation = observeStripeCryptoSettlementEligibility({
    observationId: "elig-obs-1",
    connectedInstance: stripeConnectedInstance(),
    settlementCurrency: "USD",
    supportedAssets: [USC_CRYPTO_ASSET.id],
    evidenceRefs: ["evidence:eligibility-1"],
    observedAt: LATER,
  });
  void eligibilityObservation;
  if (settlementSelection.selected !== "NATIVE_STRIPE_CRYPTO") {
    throw new Error("fixture journey requires the native path to be eligible");
  }
  const withRoute = attachAttemptSettlementRoute(confirmed, settlementSelection.route, LATER);
  const settled = settleConfirmedAttempt({
    settlementId: "settlement-1",
    attempt: withRoute,
    selection: settlementSelection,
    confirmationInput: {
      confirmationId: "stripe-confirmation-1",
      connectedInstanceId: "inst-stripe-1",
      stripeBalanceTxRef: "txn_fixture-balance-1",
      amount: CART_AMOUNT,
      providerStateEnvelopeRef: "envelope:stripe-1",
      evidenceIds: ["evidence:stripe-confirmation-1"],
    },
    protocolInstructionId: "SI:fixture-1",
    protocolSettlementAttemptIds: ["SA:fixture-1"],
    now: LATER,
  });

  return {
    profile,
    activation,
    flow,
    pipeline,
    bundle,
    handoffReceipt,
    lineage,
    intent,
    attempt: confirmed,
    inbox,
    refund,
    refundSupport,
    settlementSelection,
    settlement: settled.settlement,
    settledAttempt: settled.attempt,
  };
}

/** The external-conversion refund support observation (adversarial/journeys). */
export function externalRefundSupportFixture() {
  return observeExternalConversionRefundSupport({
    observationId: "rail-obs-external-1",
    conversionChain: ["cap:fixture-conversion-1"],
    supportsRefunds: false,
    partialRefunds: false,
    evidenceRefs: ["evidence:rail-observation-external-1"],
    observedAt: LATER,
  });
}

import { describe, expect, it } from "vitest";
import { ValidationError } from "@payswap/protocol";
import {
  defineWebhookEvent,
  dispatchMerchantCheckoutApi,
} from "../src/index.js";
import type {
  MerchantCheckoutApiContext,
  MerchantCheckoutApiResponse,
  MerchantCheckoutTrustedDeps,
} from "../src/index.js";
import {
  baseAcceptancePolicy,
  CART_AMOUNT,
  checkoutSecurityPolicy,
  checkoutSecurityState,
  CUSTOMER_APPROVER_REF,
  CUSTOMER_WALLET,
  CHECKOUT_SERVICE_PRINCIPAL,
  EXPIRY,
  fixtureQuote,
  LATER,
  MERCHANT_DESTINATION,
  settlementDestination,
  TEST_SIGNER_ADAPTER,
  testApprovalSurface,
  USC_CRYPTO_ASSET,
  USC_RAIL_BINDING,
  QUOTE_VALID_UNTIL,
  cryptoPolicyInput,
  onboardedMerchant,
  activeAcceptance,
  stripeConnectedInstance,
} from "./fixtures.js";
import type { BroadcastHandoffReceipt, SigningRequest } from "@payswap/onchain-security";
import type { TimestampMs } from "@payswap/protocol";

/**
 * P4-W2-003 §3.10 — the typed API-surface contracts: the merchant +
 * customer journeys proven end to end through the dispatch, which walks the
 * REAL package functions (no mocks of this package's own code).
 */

const deps: MerchantCheckoutTrustedDeps = {
  securityPolicy: checkoutSecurityPolicy(),
  approvalSurface: testApprovalSurface(),
  signerAdapter: TEST_SIGNER_ADAPTER,
  submitToTrustedSurface(request: SigningRequest, now: TimestampMs): BroadcastHandoffReceipt {
    return {
      requestRef: request.requestId,
      submittedAt: Number(now),
      externalRef: `tx:api-${request.requestId}`,
      evidenceRefs: ["evidence:api-submission-1"],
    };
  },
};

function freshContext(): MerchantCheckoutApiContext {
  return { inbox: { appliedEventIds: [], rejections: [], duplicates: [] } };
}

function dispatch(
  context: MerchantCheckoutApiContext,
  request: Parameters<typeof dispatchMerchantCheckoutApi>[2],
): { context: MerchantCheckoutApiContext; response: MerchantCheckoutApiResponse } {
  return dispatchMerchantCheckoutApi(context, deps, request);
}

describe("API surface — the merchant journey (onboarding → acceptance)", () => {
  it("walks draft → submit → verify → activate → acceptance activation", () => {
    let context = freshContext();
    let result = dispatch(context, {
      kind: "merchant/onboarding.draft",
      now: LATER,
      input: {
        id: "merchant-1",
        businessName: "Fixture Coffee Roasters",
        country: "US",
        pricingCurrency: "USD",
        supportContact: "support@fixture-coffee.example",
      },
    });
    expect(result.response.kind).toBe("merchant/onboarding");
    context = result.context;
    result = dispatch(context, { kind: "merchant/onboarding.submit", now: LATER });
    context = result.context;
    result = dispatch(context, {
      kind: "merchant/onboarding.verify",
      verificationRef: "verify-record-1",
      now: LATER,
    });
    context = result.context;
    result = dispatch(context, {
      kind: "merchant/onboarding.activate",
      settlementDestination: settlementDestination(),
      now: LATER,
    });
    if (result.response.kind !== "merchant/onboarding") {
      throw new Error("unreachable");
    }
    expect(result.response.profile.state).toBe("ACTIVE");
    context = result.context;
    result = dispatch(context, {
      kind: "merchant/acceptance.activate",
      now: LATER,
      policyInput: cryptoPolicyInput(),
      basePolicy: baseAcceptancePolicy(),
    });
    if (result.response.kind !== "merchant/acceptance") {
      throw new Error("unreachable");
    }
    expect(result.response.activation.state).toBe("ACTIVE");
    expect(result.response.offerView.assets).toHaveLength(1);
  });

  it("refuses acceptance activation before verification (fail-closed precondition)", () => {
    const context = dispatch(freshContext(), {
      kind: "merchant/onboarding.draft",
      now: LATER,
      input: {
        id: "merchant-1",
        businessName: "B",
        country: "US",
        pricingCurrency: "USD",
        supportContact: "s@example.com",
      },
    }).context;
    expect(() =>
      dispatch(context, {
        kind: "merchant/acceptance.activate",
        now: LATER,
        policyInput: cryptoPolicyInput(),
        basePolicy: baseAcceptancePolicy(),
      }),
    ).toThrow(ValidationError);
  });
});

function preparedCustomerJourney() {
    let context: MerchantCheckoutApiContext = {
      profile: onboardedMerchant(),
      activation: activeAcceptance(),
      inbox: { appliedEventIds: [], rejections: [], duplicates: [] },
    };
    let result = dispatch(context, {
      kind: "checkout/session.open",
      now: LATER,
      flowId: "flow-api-1",
      basePolicy: baseAcceptancePolicy(),
      cart: { amount: CART_AMOUNT },
      quotes: [fixtureQuote()],
      railBindings: [USC_RAIL_BINDING],
      expiresAt: EXPIRY,
    });
    if (result.response.kind !== "checkout/session.open") {
      throw new Error("unreachable");
    }
    expect(result.response.optionIds).toContain(
      `crypto:${USC_CRYPTO_ASSET.id}@${USC_RAIL_BINDING.merchantChainId}`,
    );
    expect(result.response.optionIds).toContain("fiat:pm-card");
    context = result.context;
    result = dispatch(context, {
      kind: "checkout/option.prepare",
      now: LATER,
      optionId: `crypto:${USC_CRYPTO_ASSET.id}@${USC_RAIL_BINDING.merchantChainId}`,
      customerWalletAddress: CUSTOMER_WALLET,
      destinationAddress: MERCHANT_DESTINATION,
      writeId: "write-api-1",
      requestedBy: "agent:checkout-service-key-1",
      principal: CHECKOUT_SERVICE_PRINCIPAL,
      securityState: checkoutSecurityState({ observedAt: Number(LATER) }),
    });
    if (result.response.kind !== "checkout/option.prepare") {
      throw new Error("unreachable");
    }
    if (result.response.status !== "PREPARED") {
      throw new Error(`expected PREPARED, got ${result.response.status}`);
    }
    // The customer-facing bundle: summary + diff (what they SEE).
    expect(result.response.bundle.paymentSummary.join("\n")).toContain("Fixture Coffee Roasters");
    expect(result.response.bundle.diffRendering.length).toBeGreaterThan(0);
    return result.context;
}

describe("API surface — the customer journey (checkout → signing → lifecycle → status)", () => {
  it("walks prepare → authorize (explicit signing at the trusted surface) → attempt → observe → status", () => {
    let context = preparedCustomerJourney();
    let result = dispatch(context, {
      kind: "checkout/option.authorize",
      now: LATER,
      approverRef: CUSTOMER_APPROVER_REF,
      securityState: checkoutSecurityState({ observedAt: Number(LATER) }),
      expiresAt: QUOTE_VALID_UNTIL,
      signingRequestId: "signreq-api-1",
    });
    if (result.response.kind !== "checkout/option.authorize" || result.response.status !== "AUTHORIZED") {
      throw new Error(`expected AUTHORIZED, got ${JSON.stringify(result.response)}`);
    }
    expect(result.response.lineage.externalSubmissionRef).toBe("tx:api-signreq-api-1");
    context = result.context;
    result = dispatch(context, {
      kind: "payment/attempt.submit",
      now: LATER,
      attemptId: "attempt-api-1",
    });
    if (result.response.kind !== "payment/attempt") {
      throw new Error("unreachable");
    }
    expect(result.response.attempt.attempt.state).toBe("SUBMITTED");
    expect(result.response.intent.state).toBe("PROCESSING");
    context = result.context;
    result = dispatch(context, {
      kind: "payment/attempt.observe",
      now: LATER,
      observation: {
        kind: "SUCCEEDED",
        evidenceIds: ["evidence:api-confirmation-1"],
        externalTxRef: "tx:api-signreq-api-1",
      },
    });
    if (result.response.kind !== "payment/attempt") {
      throw new Error("unreachable");
    }
    expect(result.response.attempt.attempt.state).toBe("CONFIRMED");
    expect(result.response.intent.state).toBe("SUCCEEDED");
    context = result.context;
    result = dispatch(context, { kind: "status/view", now: LATER });
    if (result.response.kind !== "status/view") {
      throw new Error("unreachable");
    }
    expect(result.response.attempt?.attempt.state).toBe("CONFIRMED");
    expect(result.response.intent?.state).toBe("SUCCEEDED");
    expect(result.response.inbox.appliedEventIds).toEqual([]);
  });

  it("surfaces a GATE_BLOCKED prepare honestly (no bundle is producible)", () => {
    let context: MerchantCheckoutApiContext = {
      profile: onboardedMerchant(),
      activation: activeAcceptance(),
      inbox: { appliedEventIds: [], rejections: [], duplicates: [] },
    };
    const opened = dispatch(context, {
      kind: "checkout/session.open",
      now: LATER,
      flowId: "flow-api-blocked",
      basePolicy: baseAcceptancePolicy(),
      cart: { amount: CART_AMOUNT },
      quotes: [fixtureQuote()],
      railBindings: [USC_RAIL_BINDING],
      expiresAt: EXPIRY,
    });
    context = opened.context;
    // A policy that does NOT permit the destination → deterministic BLOCK.
    const blockedDeps: MerchantCheckoutTrustedDeps = {
      ...deps,
      securityPolicy: checkoutSecurityPolicy({ allowedDestinations: ["0x9999999999999999999999999999999999999999"] }),
    };
    const result = dispatchMerchantCheckoutApi(context, blockedDeps, {
      kind: "checkout/option.prepare",
      now: LATER,
      optionId: `crypto:${USC_CRYPTO_ASSET.id}@${USC_RAIL_BINDING.merchantChainId}`,
      customerWalletAddress: CUSTOMER_WALLET,
      destinationAddress: MERCHANT_DESTINATION,
      writeId: "write-api-blocked",
      requestedBy: "agent:checkout-service-key-1",
      principal: CHECKOUT_SERVICE_PRINCIPAL,
      securityState: checkoutSecurityState({ observedAt: Number(LATER) }),
    });
    if (result.response.kind !== "checkout/option.prepare") {
      throw new Error("unreachable");
    }
    expect(result.response.status).toBe("GATE_BLOCKED");
    if (result.response.status === "GATE_BLOCKED") {
      expect(result.response.decision.decision).toBe("BLOCK");
      expect("bundle" in result.response).toBe(false);
    }
  });

  it("refuses authorization before preparation (precondition fail-closed)", () => {
    const context = preparedCustomerJourney();
    const { pipeline: omitPipeline, bundle: omitBundle, ...restContext } = context;
    void omitPipeline;
    void omitBundle;
    expect(() =>
      dispatch(restContext, {
        kind: "checkout/option.authorize",
        now: LATER,
        approverRef: CUSTOMER_APPROVER_REF,
        securityState: checkoutSecurityState({ observedAt: Number(LATER) }),
        expiresAt: QUOTE_VALID_UNTIL,
        signingRequestId: "signreq-x",
      }),
    ).toThrow(ValidationError);
  });
});

describe("API surface — webhooks, refunds and settlement endpoints", () => {
  it("processes a webhook event idempotently through the dispatch", () => {
    let context = preparedCustomerJourney();
    context = dispatch(context, {
      kind: "checkout/option.authorize",
      now: LATER,
      approverRef: CUSTOMER_APPROVER_REF,
      securityState: checkoutSecurityState({ observedAt: Number(LATER) }),
      expiresAt: QUOTE_VALID_UNTIL,
      signingRequestId: "signreq-api-2",
    }).context;
    context = dispatch(context, {
      kind: "payment/attempt.submit",
      now: LATER,
      attemptId: "attempt-api-2",
    }).context;
    const event = defineWebhookEvent({
      eventId: "evt-api-1",
      payload: {
        eventType: "payment_attempt.submitted" as const,
        attemptId: "attempt-api-2",
        intentId: context.intent?.id ?? "intent:flow-api-1",
        authorizationRequestHash: context.authorization?.lineage.authorizationRequestHash ?? "",
        externalTxRef: "tx:api-signreq-api-2",
        evidenceIds: ["evidence:api-submission-1"],
      },
      occurredAt: LATER,
    });
    let result = dispatch(context, {
      kind: "webhook/event.process",
      now: LATER,
      event,
      handler: () => undefined,
    });
    if (result.response.kind !== "webhook/event.process") {
      throw new Error("unreachable");
    }
    expect(result.response.result.status).toBe("APPLIED");
    context = result.context;
    result = dispatch(context, {
      kind: "webhook/event.process",
      now: LATER,
      event,
      handler: () => {
        throw new Error("replayed handler must never run");
      },
    });
    if (result.response.kind !== "webhook/event.process") {
      throw new Error("unreachable");
    }
    expect(result.response.result.status).toBe("DUPLICATE");
  });

  it("initiates a refund with the typed NOT_SUPPORTED outcome through the dispatch", () => {
    let context = preparedCustomerJourney();
    context = dispatch(context, {
      kind: "checkout/option.authorize",
      now: LATER,
      approverRef: CUSTOMER_APPROVER_REF,
      securityState: checkoutSecurityState({ observedAt: Number(LATER) }),
      expiresAt: QUOTE_VALID_UNTIL,
      signingRequestId: "signreq-api-3",
    }).context;
    context = dispatch(context, {
      kind: "payment/attempt.submit",
      now: LATER,
      attemptId: "attempt-api-3",
    }).context;
    context = dispatch(context, {
      kind: "payment/attempt.observe",
      now: LATER,
      observation: {
        kind: "SUCCEEDED",
        evidenceIds: ["evidence:api-confirmation-3"],
      },
    }).context;
    const result = dispatch(context, {
      kind: "refund/initiate",
      now: LATER,
      refundId: "refund-api-1",
      amount: CART_AMOUNT,
      railSupport: {
        observationId: "rail-obs-api",
        routeFamily: "EXTERNAL_PAYSWAP_CONVERSION",
        supportsRefunds: false,
        partialRefunds: false,
        chargebackPathAvailable: false,
        observedAt: LATER,
        evidenceRefs: ["evidence:rail-api"],
      },
      destinationRef: CUSTOMER_WALLET,
      recourse: "NONE",
    });
    if (result.response.kind !== "refund/initiate") {
      throw new Error("unreachable");
    }
    expect(result.response.initiation.outcome).toBe("NOT_SUPPORTED");
  });

  it("selects the settlement route and settles a confirmed attempt (native path)", () => {
    let context = preparedCustomerJourney();
    context = dispatch(context, {
      kind: "checkout/option.authorize",
      now: LATER,
      approverRef: CUSTOMER_APPROVER_REF,
      securityState: checkoutSecurityState({ observedAt: Number(LATER) }),
      expiresAt: QUOTE_VALID_UNTIL,
      signingRequestId: "signreq-api-4",
    }).context;
    context = dispatch(context, {
      kind: "payment/attempt.submit",
      now: LATER,
      attemptId: "attempt-api-4",
    }).context;
    context = dispatch(context, {
      kind: "payment/attempt.observe",
      now: LATER,
      observation: {
        kind: "SUCCEEDED",
        evidenceIds: ["evidence:api-confirmation-4"],
      },
    }).context;
    const selectionResult = dispatch(context, {
      kind: "settlement/route.select",
      now: LATER,
      desiredMode: "NATIVE_STRIPE_CRYPTO",
      native: {
        connectedInstance: stripeConnectedInstance(),
        settlementCurrency: "USD",
        supportedAssets: [USC_CRYPTO_ASSET.id],
        evidenceRefs: ["evidence:api-eligibility"],
      },
      external: {
        destination: settlementDestination(),
        conversionChain: ["cap:fixture-conversion-1"],
      },
      modeConfig: {
        mode: "NATIVE_STRIPE_CRYPTO",
        connectedInstanceId: "inst-stripe-1",
        stripeAccountRef: "acct_stripe_fixture",
        settlementCurrency: "USD",
      },
    });
    if (selectionResult.response.kind !== "settlement/route.select") {
      throw new Error("unreachable");
    }
    expect(selectionResult.response.selection.selected).toBe("NATIVE_STRIPE_CRYPTO");
    const settled = dispatch(selectionResult.context, {
      kind: "settlement/attempt.settle",
      now: LATER,
      settlementId: "settlement-api-1",
      selection: selectionResult.response.selection,
      confirmationInput: {
        confirmationId: "confirmation-api-1",
        connectedInstanceId: "inst-stripe-1",
        stripeBalanceTxRef: "txn_api-balance-1",
        amount: CART_AMOUNT,
        providerStateEnvelopeRef: "envelope:api-1",
        evidenceIds: ["evidence:api-stripe-confirmation"],
      },
      protocolInstructionId: "SI:api-1",
      protocolSettlementAttemptIds: ["SA:api-1"],
    });
    if (settled.response.kind !== "settlement/attempt.settle") {
      throw new Error("unreachable");
    }
    expect(settled.response.settlement.routeFamily).toBe("NATIVE_STRIPE_CRYPTO");
    expect(settled.response.settlement.settlementMode).toBe("NATIVE_STRIPE_CRYPTO");
  });
});

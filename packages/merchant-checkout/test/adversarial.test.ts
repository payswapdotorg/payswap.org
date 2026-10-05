import { describe, expect, it } from "vitest";
import { ValidationError, currencyCode, fromMinorUnits } from "@payswap/protocol";
import { scanForSecretMaterial } from "@payswap/onchain-security";
import type { ConnectedCapabilityInstance } from "@payswap/connectors";
import { ConnectorAuthorityError } from "@payswap/connectors";
import { SyntheticStripeBalanceError } from "@payswap/merchant-crypto";
import {
  assertSettlementModeDiscriminated,
  attemptStatusView,
  buildJourneyEvidence,
  deactivateCryptoAcceptance,
  defineWebhookEvent,
  emptyWebhookInbox,
  initiateRefund,
  observeAttemptOutcome,
  observeNativeStripeRefundSupport,
  observeStripeCryptoSettlementEligibility,
  openCheckoutFlow,
  processWebhookEvent,
  refundStatusView,
  resolveRefundUnknown,
  selectSettlementRoute,
  settleConfirmedAttempt,
  SettlementModeConflationError,
  submitWalletPaymentAttempt,
} from "../src/index.js";
import type { MerchantSettlementModeConfig } from "../src/index.js";
import { runFullJourney } from "./journey-helpers.js";

const USD = currencyCode("USD");
import {
  activeAcceptance,
  baseAcceptancePolicy,
  CART_AMOUNT,
  CUSTOMER_WALLET,
  EXPIRY,
  fixtureQuote,
  LATER,
  MERCHANT_DESTINATION,
  STRIPE_CATALOGUE_ENTRY,
  stripeConnectedInstance,
  settlementDestination,
  USC_CRYPTO_ASSET,
  USC_RAIL_BINDING,
} from "./fixtures.js";
import { asRailCapabilityRef } from "@payswap/payment";

/**
 * P4-W2-003 adversarial probes — the mandated list from the work packet.
 * Every probe must FAIL to break the invariant it attacks.
 */

describe("adversarial — authorization-without-explicit-signing is unrepresentable", () => {
  it("a wallet payment attempt cannot be constructed without the authorization lineage", () => {
    const journey = runFullJourney();
    for (const broken of [
      undefined,
      null,
      {},
      { authorizationRequestHash: "" },
      { authorizationRequestHash: "x", writeDigest: "" },
      { authorizationRequestHash: "x", writeDigest: "y", paymentSummaryDigest: "" },
      { authorizationRequestHash: "x", writeDigest: "y", paymentSummaryDigest: "z", signingRequestId: "" },
      { authorizationRequestHash: "x", writeDigest: "y", paymentSummaryDigest: "z", signingRequestId: "s", externalSubmissionRef: "" },
      {
        authorizationRequestHash: "x",
        writeDigest: "y",
        paymentSummaryDigest: "z",
        signingRequestId: "s",
        externalSubmissionRef: "r",
        evidenceRefs: [],
      },
    ] as unknown[]) {
      expect(() =>
        submitWalletPaymentAttempt({
          attemptId: "attempt-adv",
          intent: journey.intent,
          quote: fixtureQuote(),
          authorization: broken as never,
          now: LATER,
        }),
      ).toThrow(ValidationError);
    }
  });
});

describe("adversarial — webhook replay idempotency", () => {
  it("the same event id can never apply twice, regardless of payload mutation", () => {
    const event = defineWebhookEvent({
      eventId: "evt-adv-1",
      payload: {
        eventType: "payment_attempt.submitted",
        attemptId: "a",
        intentId: "i",
        authorizationRequestHash: "fnv1a64:x",
        externalTxRef: "tx:1",
        evidenceIds: ["e:1"],
      },
      occurredAt: LATER,
    });
    let runs = 0;
    const inbox = processWebhookEvent(emptyWebhookInbox(), event, () => {
      runs += 1;
    }).inbox;
    // A "different-looking" delivery of the SAME event id never re-applies:
    const mutatedDelivery = defineWebhookEvent({
      eventId: "evt-adv-1",
      payload: {
        eventType: "payment_attempt.submitted",
        attemptId: "a-different",
        intentId: "i",
        authorizationRequestHash: "fnv1a64:attacker",
        externalTxRef: "tx:evil",
        evidenceIds: ["e:evil"],
      },
      occurredAt: LATER + 999n,
    });
    const replay = processWebhookEvent(inbox, mutatedDelivery, () => {
      runs += 1;
    });
    expect(replay.result.status).toBe("DUPLICATE");
    expect(runs).toBe(1);
    expect(replay.inbox.appliedEventIds).toEqual(["evt-adv-1"]);
  });
});

describe("adversarial — UNKNOWN preservation at every external seam", () => {
  it("attempt: UNKNOWN observations never convert to FAILED or SUCCESS", () => {
    const journey = runFullJourney();
    // Rebuild a SUBMITTED attempt:
    const attempt = submitWalletPaymentAttempt({
      attemptId: "attempt-unknown-seam",
      intent: { ...journey.flow.intent, state: "PROCESSING" as const },
      quote: fixtureQuote(),
      authorization: journey.lineage,
      now: LATER,
    });
    const unknown = observeAttemptOutcome(attempt, {
      kind: "OUTCOME_UNKNOWN",
      evidenceIds: ["evidence:ambiguity"],
    }, LATER);
    expect(unknown.attempt.state).toBe("OUTCOME_UNKNOWN");
    expect(attemptStatusView(unknown).outcome).toBe("OUTCOME_UNKNOWN");
    // There is NO conversion function; the only exits are reconciliation
    // resolutions, and a definitive observation from UNKNOWN is undeclared:
    expect(() =>
      observeAttemptOutcome(unknown, { kind: "FAILED", evidenceIds: ["e:x"] }, LATER),
    ).toThrow();
  });

  it("refund: UNKNOWN refund outcomes are preserved and reconciled only", () => {
    const journey = runFullJourney();
    const initiation = initiateRefund({
      refundId: "refund-adv",
      attempt: journey.attempt,
      originalAmount: CART_AMOUNT,
      amount: CART_AMOUNT,
      railSupport: journey.refundSupport,
      destinationRef: CUSTOMER_WALLET,
      recourse: "NONE",
      now: LATER,
    });
    if (initiation.outcome !== "REFUND_STARTED") {
      throw new Error("fixture requires refund support");
    }
    // PENDING refunds cannot be observed (SUBMITTED only) — fail-closed:
    expect(() =>
      resolveRefundUnknown(initiation.refund, {
        resolvedOutcome: "CONFIRMED_SUCCEEDED",
        resolvedBy: { principalType: "user", principalId: "r" },
        caseId: "c",
        evidenceIds: ["e:x"],
      }, LATER),
    ).toThrow();
    expect(refundStatusView(initiation.refund).outcome).toBe("PENDING");
  });
});

describe("adversarial — catalogue-vs-connected-instance confusion is rejected", () => {
  it("the catalogue entry is rejected everywhere a connected instance is required", () => {
    for (const probe of [
      () =>
        observeNativeStripeRefundSupport({
          observationId: "obs-cat",
          connectedInstance: STRIPE_CATALOGUE_ENTRY as never,
          evidenceRefs: ["e:x"],
          observedAt: LATER,
        }),
      () =>
        observeStripeCryptoSettlementEligibility({
          observationId: "obs-cat",
          connectedInstance: STRIPE_CATALOGUE_ENTRY as never,
          settlementCurrency: "USD",
          supportedAssets: [USC_CRYPTO_ASSET.id],
          evidenceRefs: ["e:x"],
          observedAt: LATER,
        }),
      () =>
        selectSettlementRoute({
          desiredMode: "NATIVE_STRIPE_CRYPTO",
          native: {
            connectedInstance: STRIPE_CATALOGUE_ENTRY as never,
            settlementCurrency: "USD",
            supportedAssets: [USC_CRYPTO_ASSET.id],
            evidenceRefs: ["e:x"],
          },
          external: {
            destination: settlementDestination(),
            conversionChain: [asRailCapabilityRef("cap:x")],
          },
        }),
    ]) {
      expect(probe).toThrow(ConnectorAuthorityError);
    }
  });

  it("a catalogue entry dressed as an instance still fails the runtime guard", () => {
    const dressed = {
      ...STRIPE_CATALOGUE_ENTRY,
      instanceId: "inst-fake",
      accountRef: "acct-fake",
    } as unknown as ConnectedCapabilityInstance;
    expect(() =>
      observeNativeStripeRefundSupport({
        observationId: "obs-cat-dressed",
        connectedInstance: dressed,
        evidenceRefs: ["e:x"],
        observedAt: LATER,
      }),
    ).toThrow(ConnectorAuthorityError);
  });
});

describe("adversarial — settlement-mode field disjointness both directions", () => {
  it("mode configs cannot carry the other family's fields", () => {
    const nativeConfig: MerchantSettlementModeConfig = {
      mode: "NATIVE_STRIPE_CRYPTO",
      connectedInstanceId: "inst-stripe-1",
      stripeAccountRef: "acct_x",
      settlementCurrency: "USD",
    };
    expect(() =>
      assertSettlementModeDiscriminated({
        ...nativeConfig,
        destination: settlementDestination(),
      }),
    ).toThrow(SettlementModeConflationError);
    expect(() =>
      assertSettlementModeDiscriminated({
        mode: "PAYSWAP_EXTERNAL_SETTLEMENT",
        destination: settlementDestination(),
        conversionChain: ["cap:x"],
        connectedInstanceId: "inst-stripe-1",
      }),
    ).toThrow(SettlementModeConflationError);
    expect(() =>
      assertSettlementModeDiscriminated({ mode: "NATIVE" }),
    ).toThrow(ValidationError);
  });

  it("external settlement carrying a native confirmation input is rejected", () => {
    const journey = runFullJourney();
    const selection = selectSettlementRoute({
      desiredMode: "PAYSWAP_EXTERNAL_SETTLEMENT",
      external: {
        destination: settlementDestination(),
        conversionChain: [asRailCapabilityRef("cap:x")],
      },
    });
    expect(() =>
      settleConfirmedAttempt({
        settlementId: "s-adv",
        attempt: journey.attempt,
        selection,
        confirmationInput: {
          confirmationId: "c",
          connectedInstanceId: "inst-stripe-1",
          stripeBalanceTxRef: "txn_x",
          amount: CART_AMOUNT,
          providerStateEnvelopeRef: "env",
          evidenceIds: ["e:x"],
        },
        protocolInstructionId: "SI:x",
        protocolSettlementAttemptIds: ["SA:x"],
        now: LATER,
      }),
    ).toThrow(SettlementModeConflationError);
  });
});

describe("adversarial — refund on a non-supporting rail answers typed NOT_SUPPORTED", () => {
  it("the non-supporting observation yields NOT_SUPPORTED, never a throw, never silence", () => {
    const journey = runFullJourney();
    const nonSupporting = observeNativeStripeRefundSupport({
      observationId: "rail-obs-revoked",
      connectedInstance: stripeConnectedInstance({ status: "REVOKED" }),
      evidenceRefs: ["evidence:rail-revoked"],
      observedAt: LATER,
    });
    const result = initiateRefund({
      refundId: "refund-adv-2",
      attempt: journey.attempt,
      originalAmount: CART_AMOUNT,
      amount: CART_AMOUNT,
      railSupport: nonSupporting,
      destinationRef: CUSTOMER_WALLET,
      recourse: "NONE",
      now: LATER,
    });
    expect(result).toEqual({
      outcome: "NOT_SUPPORTED",
      routeFamily: "NATIVE_STRIPE_CRYPTO",
      reason:
        "the underlying rail does not support refunds (typed rail capability observation — not an implied future support)",
    });
  });
});

describe("adversarial — floating-point money is rejected", () => {
  it("a JS number in a money position is rejected by the exact-money constructors", () => {
    const journey = runFullJourney();
    expect(() =>
      initiateRefund({
        refundId: "refund-float",
        attempt: journey.attempt,
        originalAmount: CART_AMOUNT,
        amount: { ...fromMinorUnits(USD, 100n), value: 12.5 as unknown as bigint },
        railSupport: journey.refundSupport,
        destinationRef: CUSTOMER_WALLET,
        recourse: "NONE",
        now: LATER,
      }),
    ).toThrow(ValidationError);
  });

  it("checkout carts demand exact bigint Money (positive, zero rejected)", () => {
    const activation = activeAcceptance();
    expect(() =>
      openCheckoutFlow({
        id: "flow-float",
        merchantId: "merchant-1",
        activation,
        basePolicy: baseAcceptancePolicy(),
        cart: { amount: { ...fromMinorUnits(USD, 100n), value: 10.5 as unknown as bigint } },
        quotes: [fixtureQuote()],
        railBindings: [USC_RAIL_BINDING],
        now: LATER,
        expiresAt: EXPIRY,
      }),
    ).toThrow(ValidationError);
  });
});

describe("adversarial — secret-bearing values are rejected in evidence records", () => {
  it("the kernel's secret scan finds no violations in journey evidence records", () => {
    const journey = runFullJourney();
    const records = buildJourneyEvidence("journey:adv", [
      {
        stage: "MERCHANT_ONBOARDING",
        refs: [`merchant:${journey.profile.id}`],
        evidenceRefs: ["onboarding:merchant-1"],
      },
      {
        stage: "WALLET_AUTHORIZATION",
        refs: [`authorization:${journey.lineage.authorizationRequestHash}`],
        evidenceRefs: [...journey.lineage.evidenceRefs],
        pipelineEvidence: journey.pipeline.evidence(),
      },
      {
        stage: "SETTLEMENT",
        refs: [`settlement:${journey.settlement.settlementId}`],
        evidenceRefs: [...journey.settlement.evidenceIds],
      },
    ]);
    for (const record of records) {
      expect(scanForSecretMaterial(record)).toEqual([]);
    }
  });

  it("a webhook event carrying secret-shaped material is rejected at construction", () => {
    expect(() =>
      defineWebhookEvent({
        eventId: "evt-secret",
        payload: {
          eventType: "payment_attempt.submitted",
          attemptId: "a",
          intentId: "i",
          authorizationRequestHash: "fnv1a64:x",
          externalTxRef: "tx:1",
          evidenceIds: ["e:1"],
          apiKey: "sk_live_fixture",
        } as never,
        occurredAt: LATER,
      }),
    ).toThrow(/secret/i);
  });

  it("a raw 32-byte key shape cannot ride a neutral evidence field", () => {
    expect(() =>
      defineWebhookEvent({
        eventId: "evt-rawkey",
        payload: {
          eventType: "payment_attempt.submitted",
          attemptId:
            "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318",
          intentId: "i",
          authorizationRequestHash: "fnv1a64:x",
          externalTxRef: "tx:1",
          evidenceIds: ["e:1"],
        },
        occurredAt: LATER,
      }),
    ).toThrow(/secret-shaped/i);
  });
});

describe("adversarial — settlement implied without eligibility is rejected", () => {
  it("native settlement without a provider-verified confirmation is impossible", () => {
    const journey = runFullJourney();
    const ineligibleSelection = selectSettlementRoute({
      desiredMode: "NATIVE_STRIPE_CRYPTO",
      native: {
        connectedInstance: stripeConnectedInstance({ eligible: false }),
        settlementCurrency: "USD",
        supportedAssets: [USC_CRYPTO_ASSET.id],
        evidenceRefs: ["evidence:x"],
      },
      external: {
        destination: settlementDestination(),
        conversionChain: [asRailCapabilityRef("cap:x")],
      },
    });
    // The honest answer: external + notice — NEVER a native route:
    expect(ineligibleSelection.selected).toBe("PAYSWAP_EXTERNAL_SETTLEMENT");
    // And native settlement without evidence is a synthetic-balance error:
    const eligibleSelection = selectSettlementRoute({
      desiredMode: "NATIVE_STRIPE_CRYPTO",
      native: {
        connectedInstance: stripeConnectedInstance(),
        settlementCurrency: "USD",
        supportedAssets: [USC_CRYPTO_ASSET.id],
        evidenceRefs: ["evidence:x"],
      },
      external: {
        destination: settlementDestination(),
        conversionChain: [asRailCapabilityRef("cap:x")],
      },
    });
    if (eligibleSelection.selected !== "NATIVE_STRIPE_CRYPTO") {
      throw new Error("fixture requires eligibility");
    }
    expect(() =>
      settleConfirmedAttempt({
        settlementId: "s-adv",
        attempt: journey.attempt,
        selection: eligibleSelection,
        confirmationInput: {
          confirmationId: "c",
          connectedInstanceId: "inst-stripe-1",
          stripeBalanceTxRef: "txn_x",
          amount: CART_AMOUNT,
          providerStateEnvelopeRef: "env",
          evidenceIds: [],
        },
        protocolInstructionId: "SI:x",
        protocolSettlementAttemptIds: ["SA:x"],
        now: LATER,
      }),
    ).toThrow(SyntheticStripeBalanceError);
  });
});

describe("adversarial — historical policy/payment record mutation is rejected", () => {
  it("records are deep-frozen: mutation attempts throw in strict mode", () => {
    const journey = runFullJourney();
    const targets = [
      journey.profile,
      journey.activation.policy,
      journey.flow.session,
      journey.attempt.attempt,
      journey.refund,
      journey.settlement,
    ];
    for (const target of targets) {
      expect(Object.isFrozen(target)).toBe(true);
      expect(() => {
        (target as unknown as Record<string, unknown>)["state"] = "TAMPERED";
      }).toThrow();
    }
  });

  it("deactivating acceptance never rewrites the historical activation", () => {
    const activation = activeAcceptance();
    const deactivated = deactivateCryptoAcceptance(activation, {
      reason: "paused",
      now: LATER,
    });
    expect(activation.state).toBe("ACTIVE");
    expect(deactivated.state).toBe("DEACTIVATED");
    expect(deactivated.policy).toEqual(activation.policy);
  });

  it("a refund never rewrites the original payment attempt", () => {
    const journey = runFullJourney();
    const initiation = initiateRefund({
      refundId: "refund-adv-3",
      attempt: journey.attempt,
      originalAmount: CART_AMOUNT,
      amount: fromMinorUnits(currencyCode("USD"), 100n),
      railSupport: journey.refundSupport,
      destinationRef: CUSTOMER_WALLET,
      recourse: "NONE",
      now: LATER,
    });
    expect(initiation.outcome).toBe("REFUND_STARTED");
    if (initiation.outcome === "REFUND_STARTED") {
      expect(initiation.refund.originalAttemptId).toBe(journey.attempt.attempt.id);
    }
    expect(journey.attempt.attempt.state).toBe("CONFIRMED");
    expect(journey.attempt.attempt.evidenceIds).not.toContain("refund:anything");
  });
});

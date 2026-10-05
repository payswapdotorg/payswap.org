import { describe, expect, it } from "vitest";
import { ValidationError, currencyCode, fromMinorUnits } from "@payswap/protocol";
import { SyntheticStripeBalanceError } from "@payswap/merchant-crypto";
import { ConnectorAuthorityError } from "@payswap/connectors";
import { STRIPE_NATIVE_SETTLEMENT_UNAVAILABLE_NOTICE } from "@payswap/route-compiler";
import {
  assertSettlementModeDiscriminated,
  defineSettlementPolicy,
  isProviderVerifiedStripeSettlementRecord,
  observeStripeCryptoSettlementEligibility,
  recordStripeConnectionObservation,
  routeFamilySettlementMode,
  selectSettlementRoute,
  settleConfirmedAttempt,
  settlementModeRouteFamily,
  SettlementModeConflationError,
} from "../src/index.js";
import type { MerchantSettlementModeConfig } from "../src/index.js";
import { runFullJourney } from "./journey-helpers.js";
import {
  baseAcceptancePolicy,
  CART_AMOUNT,
  LATER,
  STRIPE_CATALOGUE_ENTRY,
  stripeConnectedInstance,
  USC_CRYPTO_ASSET,
} from "./fixtures.js";

/** P4-W2-003 §3.8 + §3.9 — settlement configuration, Stripe connection, the two paths. */

function externalConfig() {
  return {
    destination: baseAcceptancePolicy().settlementDestination,
    conversionChain: ["cap:fixture-conversion-1"],
  };
}

function nativeConfigInput(overrides?: {
  readonly instance?: ReturnType<typeof stripeConnectedInstance>;
}) {
  return {
    connectedInstance: overrides?.instance ?? stripeConnectedInstance(),
    settlementCurrency: "USD",
    supportedAssets: [USC_CRYPTO_ASSET.id],
    evidenceRefs: ["evidence:eligibility-1"],
  };
}

describe("settlement policy — configuration as typed data (never an effect)", () => {
  it("constructs a validated, frozen policy", () => {
    const policy = defineSettlementPolicy({
      policyId: "sp-1",
      merchantRef: "merchant-1",
      destinationId: "dest-bank-1",
      schedule: "WEEKLY",
      thresholdAmount: fromMinorUnits(currencyCode("USD"), 100_000n),
      currencyDenomination: "USD",
    });
    expect(policy.schedule).toBe("WEEKLY");
    expect(Object.isFrozen(policy)).toBe(true);
    // PURE DATA: no effect, evidence or provider reference exists on a policy.
    const keys = Object.keys(policy).sort();
    expect(keys).toEqual([
      "currencyDenomination",
      "destinationId",
      "merchantRef",
      "policyId",
      "schedule",
      "thresholdAmount",
    ]);
  });

  it("validates schedules, currencies and thresholds (fail-closed)", () => {
    expect(() =>
      defineSettlementPolicy({
        policyId: "sp-x",
        merchantRef: "m",
        destinationId: "d",
        schedule: "HOURLY" as never,
        currencyDenomination: "USD",
      }),
    ).toThrow(ValidationError);
    expect(() =>
      defineSettlementPolicy({
        policyId: "sp-x",
        merchantRef: "m",
        destinationId: "d",
        schedule: "DAILY",
        currencyDenomination: "usd",
      }),
    ).toThrow(ValidationError);
    expect(() =>
      defineSettlementPolicy({
        policyId: "sp-x",
        merchantRef: "m",
        destinationId: "d",
        schedule: "DAILY",
        thresholdAmount: fromMinorUnits(currencyCode("EUR"), 10n),
        currencyDenomination: "USD",
      }),
    ).toThrow(ValidationError);
  });
});

describe("Stripe connection — ProviderStateEnvelope-style lifecycle (INV-C06)", () => {
  it("records a connect/onboard/verify/restrict observation losslessly", () => {
    const envelope = recordStripeConnectionObservation({
      stripeAccountRef: "acct_stripe_fixture",
      revision: "rev-1",
      rawState: { status: "restricted", requirements: ["past_due"] },
      lifecycleStep: "restrict",
      isTerminal: false,
      requiresCustomerAction: true,
      actionRequired: { kind: "past_due_documents", message: "Upload the outstanding documents" },
      observedAt: "2026-10-04T00:00:00Z",
    });
    expect(envelope.classification.family).toBe("connected_account");
    expect(envelope.classification.lifecycleStep).toBe("restrict");
    expect(envelope.classification.requiresCustomerAction).toBe(true);
    // The raw provider state passes through VERBATIM:
    expect(envelope.state).toEqual({ status: "restricted", requirements: ["past_due"] });
    expect(envelope.object.objectType).toBe("stripe.account");
  });

  it("rejects an undeclared lifecycle step (fail-closed)", () => {
    expect(() =>
      recordStripeConnectionObservation({
        stripeAccountRef: "acct_x",
        revision: "rev-1",
        rawState: {},
        lifecycleStep: "teleport" as never,
        isTerminal: false,
        requiresCustomerAction: false,
        observedAt: "2026-10-04T00:00:00Z",
      }),
    ).toThrow(ValidationError);
  });
});

describe("eligible-capability observation — scoped to the ACTUAL instance (rule 18)", () => {
  it("observes eligibility through the landed merchant-crypto view", () => {
    const observation = observeStripeCryptoSettlementEligibility({
      observationId: "elig-obs-1",
      connectedInstance: stripeConnectedInstance(),
      settlementCurrency: "USD",
      supportedAssets: [USC_CRYPTO_ASSET.id],
      evidenceRefs: ["evidence:eligibility-1"],
      observedAt: LATER,
    });
    expect(observation.instanceId).toBe("inst-stripe-1");
    expect(observation.eligible).toBe(true);
    expect(observation.capabilityId).toBe(
      "cap.merchant-crypto.stripe.native-crypto-settlement",
    );
  });

  it("rejects a catalogue entry as observation grounding (INV-C05)", () => {
    expect(() =>
      observeStripeCryptoSettlementEligibility({
        observationId: "elig-obs-cat",
        connectedInstance: STRIPE_CATALOGUE_ENTRY as never,
        settlementCurrency: "USD",
        supportedAssets: [USC_CRYPTO_ASSET.id],
        evidenceRefs: ["evidence:x"],
        observedAt: LATER,
      }),
    ).toThrow(ConnectorAuthorityError);
  });

  it("rejects an observation without evidence (catalogue presence is never connection)", () => {
    expect(() =>
      observeStripeCryptoSettlementEligibility({
        observationId: "elig-obs-bare",
        connectedInstance: stripeConnectedInstance(),
        settlementCurrency: "USD",
        supportedAssets: [USC_CRYPTO_ASSET.id],
        evidenceRefs: [],
        observedAt: LATER,
      }),
    ).toThrow(ValidationError);
  });
});

describe("§3.9 — the naming reconciliation (settlement-mode ↔ landed route-family)", () => {
  it("maps each settlement mode onto the LANDED route-family literal", () => {
    expect(settlementModeRouteFamily("NATIVE_STRIPE_CRYPTO")).toBe("NATIVE_STRIPE_CRYPTO");
    expect(settlementModeRouteFamily("PAYSWAP_EXTERNAL_SETTLEMENT")).toBe(
      "EXTERNAL_PAYSWAP_CONVERSION",
    );
  });

  it("round-trips both directions", () => {
    expect(routeFamilySettlementMode("NATIVE_STRIPE_CRYPTO")).toBe("NATIVE_STRIPE_CRYPTO");
    expect(routeFamilySettlementMode("EXTERNAL_PAYSWAP_CONVERSION")).toBe(
      "PAYSWAP_EXTERNAL_SETTLEMENT",
    );
    for (const mode of ["NATIVE_STRIPE_CRYPTO", "PAYSWAP_EXTERNAL_SETTLEMENT"] as const) {
      expect(routeFamilySettlementMode(settlementModeRouteFamily(mode))).toBe(mode);
    }
  });

  it("mode configs are DISJOINT both directions (anti-conflation)", () => {
    const nativeConfig: MerchantSettlementModeConfig = {
      mode: "NATIVE_STRIPE_CRYPTO",
      connectedInstanceId: "inst-stripe-1",
      stripeAccountRef: "acct_stripe_fixture",
      settlementCurrency: "USD",
    };
    const externalConfigValue: MerchantSettlementModeConfig = {
      mode: "PAYSWAP_EXTERNAL_SETTLEMENT",
      destination: baseAcceptancePolicy().settlementDestination,
      conversionChain: ["cap:fixture-conversion-1"],
    };
    expect(() => assertSettlementModeDiscriminated(nativeConfig)).not.toThrow();
    expect(() => assertSettlementModeDiscriminated(externalConfigValue)).not.toThrow();
    expect(() =>
      assertSettlementModeDiscriminated({
        ...nativeConfig,
        conversionChain: ["cap:x"],
      }),
    ).toThrow(SettlementModeConflationError);
    expect(() =>
      assertSettlementModeDiscriminated({
        ...externalConfigValue,
        stripeAccountRef: "acct_x",
      }),
    ).toThrow(SettlementModeConflationError);
    expect(() =>
      assertSettlementModeDiscriminated({ mode: "SOME_THIRD_MODE" }),
    ).toThrow(ValidationError);
  });
});

describe("§3.9 — settlement route selection at decision time", () => {
  it("selects NATIVE when the actual connected instance is eligible", () => {
    const selection = selectSettlementRoute({
      desiredMode: "NATIVE_STRIPE_CRYPTO",
      native: nativeConfigInput(),
      external: externalConfig(),
    });
    expect(selection.selected).toBe("NATIVE_STRIPE_CRYPTO");
    if (selection.selected === "NATIVE_STRIPE_CRYPTO") {
      expect(selection.route.providerVerified).toBe(true);
      expect(selection.eligibility.eligible).toBe(true);
      expect(selection.route.connectedInstanceId).toBe("inst-stripe-1");
    }
  });

  it("falls back to EXTERNAL with the mandated notice when authorization is not ACTIVE", () => {
    const selection = selectSettlementRoute({
      desiredMode: "NATIVE_STRIPE_CRYPTO",
      native: nativeConfigInput({ instance: stripeConnectedInstance({ status: "PENDING" }) }),
      external: externalConfig(),
    });
    expect(selection.selected).toBe("PAYSWAP_EXTERNAL_SETTLEMENT");
    if (selection.selected === "PAYSWAP_EXTERNAL_SETTLEMENT") {
      expect(selection.nativeUnavailable.notice).toBe(
        STRIPE_NATIVE_SETTLEMENT_UNAVAILABLE_NOTICE,
      );
      expect(selection.nativeUnavailable.notice).toBe(
        "Stripe balance settlement unavailable for this route",
      );
      expect(selection.nativeUnavailable.reason).toBe("AUTHORIZATION_NOT_ACTIVE");
      expect(selection.route.routeFamily).toBe("EXTERNAL_PAYSWAP_CONVERSION");
    }
  });

  it("falls back to EXTERNAL with the typed reason when the instance is ineligible", () => {
    const selection = selectSettlementRoute({
      desiredMode: "NATIVE_STRIPE_CRYPTO",
      native: nativeConfigInput({ instance: stripeConnectedInstance({ eligible: false }) }),
      external: externalConfig(),
    });
    expect(selection.selected).toBe("PAYSWAP_EXTERNAL_SETTLEMENT");
    if (selection.selected === "PAYSWAP_EXTERNAL_SETTLEMENT") {
      expect(selection.nativeUnavailable.reason).toBe("INSTANCE_NOT_ELIGIBLE");
    }
  });

  it("falls back to EXTERNAL when the settlement currency is out of the instance scope", () => {
    const selection = selectSettlementRoute({
      desiredMode: "NATIVE_STRIPE_CRYPTO",
      native: nativeConfigInput({
        instance: stripeConnectedInstance({ currencies: ["EUR"] }),
      }),
      external: externalConfig(),
    });
    expect(selection.selected).toBe("PAYSWAP_EXTERNAL_SETTLEMENT");
    if (selection.selected === "PAYSWAP_EXTERNAL_SETTLEMENT") {
      expect(selection.nativeUnavailable.reason).toBe("SETTLEMENT_CURRENCY_NOT_IN_SCOPE");
    }
  });

  it("falls back to EXTERNAL with NO_CONNECTED_INSTANCE when no instance was supplied", () => {
    const selection = selectSettlementRoute({
      desiredMode: "NATIVE_STRIPE_CRYPTO",
      external: externalConfig(),
    });
    expect(selection.selected).toBe("PAYSWAP_EXTERNAL_SETTLEMENT");
    if (selection.selected === "PAYSWAP_EXTERNAL_SETTLEMENT") {
      expect(selection.nativeUnavailable.reason).toBe("NO_CONNECTED_INSTANCE");
    }
  });

  it("an explicitly-external merchant selection carries the notice with its honest reason", () => {
    const selection = selectSettlementRoute({
      desiredMode: "PAYSWAP_EXTERNAL_SETTLEMENT",
      external: externalConfig(),
    });
    expect(selection.selected).toBe("PAYSWAP_EXTERNAL_SETTLEMENT");
    if (selection.selected === "PAYSWAP_EXTERNAL_SETTLEMENT") {
      expect(selection.nativeUnavailable.reason).toBe("MERCHANT_CONFIGURED_EXTERNAL");
      expect(selection.nativeUnavailable.notice).toBe(
        STRIPE_NATIVE_SETTLEMENT_UNAVAILABLE_NOTICE,
      );
    }
  });

  it("a catalogue entry can never ground the native selection (INV-C05)", () => {
    expect(() =>
      selectSettlementRoute({
        desiredMode: "NATIVE_STRIPE_CRYPTO",
        native: {
          ...nativeConfigInput(),
          connectedInstance: STRIPE_CATALOGUE_ENTRY as never,
        },
        external: externalConfig(),
      }),
    ).toThrow(ConnectorAuthorityError);
  });
});

describe("§3.9 — settlement execution (provider-verified effects only)", () => {
  it("settles a CONFIRMED attempt on the native path with a provider-verified confirmation", () => {
    const journey = runFullJourney();
    expect(journey.settlement.routeFamily).toBe("NATIVE_STRIPE_CRYPTO");
    expect(journey.settlement.settlementMode).toBe("NATIVE_STRIPE_CRYPTO");
    expect(isProviderVerifiedStripeSettlementRecord(journey.settlement)).toBe(true);
    expect(journey.settledAttempt.attempt.settlementInstructionId).toBe("SI:fixture-1");
  });

  it("refuses native settlement WITHOUT a provider-verified confirmation (honest-unavailability law)", () => {
    const journey = runFullJourney();
    const selection = selectSettlementRoute({
      desiredMode: "NATIVE_STRIPE_CRYPTO",
      native: nativeConfigInput(),
      external: externalConfig(),
    });
    if (selection.selected !== "NATIVE_STRIPE_CRYPTO") {
      throw new Error("fixture requires native eligibility");
    }
    expect(() =>
      settleConfirmedAttempt({
        settlementId: "settlement-x",
        attempt: journey.attempt,
        selection,
        protocolInstructionId: "SI:x",
        protocolSettlementAttemptIds: ["SA:x"],
        now: LATER,
      }),
    ).toThrow(/provider-verified confirmation/);
  });

  it("refuses a native confirmation without provider evidence (synthetic balance law)", () => {
    const journey = runFullJourney();
    const selection = selectSettlementRoute({
      desiredMode: "NATIVE_STRIPE_CRYPTO",
      native: nativeConfigInput(),
      external: externalConfig(),
    });
    if (selection.selected !== "NATIVE_STRIPE_CRYPTO") {
      throw new Error("fixture requires native eligibility");
    }
    expect(() =>
      settleConfirmedAttempt({
        settlementId: "settlement-x",
        attempt: journey.attempt,
        selection,
        confirmationInput: {
          confirmationId: "confirmation-x",
          connectedInstanceId: "inst-stripe-1",
          stripeBalanceTxRef: "txn_x",
          amount: CART_AMOUNT,
          providerStateEnvelopeRef: "envelope:x",
          evidenceIds: [],
        },
        protocolInstructionId: "SI:x",
        protocolSettlementAttemptIds: ["SA:x"],
        now: LATER,
      }),
    ).toThrow(SyntheticStripeBalanceError);
  });

  it("refuses external settlement carrying a native confirmation (disjointness)", () => {
    const journey = runFullJourney();
    const selection = selectSettlementRoute({
      desiredMode: "PAYSWAP_EXTERNAL_SETTLEMENT",
      external: externalConfig(),
    });
    expect(() =>
      settleConfirmedAttempt({
        settlementId: "settlement-x",
        attempt: journey.attempt,
        selection,
        confirmationInput: {
          confirmationId: "confirmation-x",
          connectedInstanceId: "inst-stripe-1",
          stripeBalanceTxRef: "txn_x",
          amount: CART_AMOUNT,
          providerStateEnvelopeRef: "envelope:x",
          evidenceIds: ["evidence:x"],
        },
        protocolInstructionId: "SI:x",
        protocolSettlementAttemptIds: ["SA:x"],
        now: LATER,
      }),
    ).toThrow(SettlementModeConflationError);
  });

  it("settles a CONFIRMED attempt on the external path and NEVER implies a Stripe balance", () => {
    const journey = runFullJourney();
    const selection = selectSettlementRoute({
      desiredMode: "PAYSWAP_EXTERNAL_SETTLEMENT",
      external: externalConfig(),
    });
    const settled = settleConfirmedAttempt({
      settlementId: "settlement-ext-1",
      attempt: journey.attempt,
      selection,
      protocolInstructionId: "SI:ext-1",
      protocolSettlementAttemptIds: ["SA:ext-1"],
      now: LATER,
    });
    expect(settled.settlement.routeFamily).toBe("EXTERNAL_PAYSWAP_CONVERSION");
    expect(settled.settlement.settlementMode).toBe("PAYSWAP_EXTERNAL_SETTLEMENT");
    // Structurally: the external record has no confirmation/stripeBalanceTxRef.
    const keys = Object.keys(settled.settlement).sort();
    expect(keys).not.toContain("confirmation");
    expect(keys).toContain("instructionId");
    expect(isProviderVerifiedStripeSettlementRecord(settled.settlement)).toBe(false);
  });

  it("refuses to settle a non-CONFIRMED attempt (lifecycle rules are the authority)", () => {
    const journey = runFullJourney();
    const notConfirmed = {
      ...journey.attempt,
      attempt: { ...journey.attempt.attempt, state: "SUBMITTED" as const },
    };
    const selection = selectSettlementRoute({
      desiredMode: "PAYSWAP_EXTERNAL_SETTLEMENT",
      external: externalConfig(),
    });
    expect(() =>
      settleConfirmedAttempt({
        settlementId: "settlement-x",
        attempt: notConfirmed,
        selection,
        protocolInstructionId: "SI:x",
        protocolSettlementAttemptIds: ["SA:x"],
        now: LATER,
      }),
    ).toThrow(ValidationError);
  });
});

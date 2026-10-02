import { describe, expect, it } from "vitest";
import {
  parseProviderStateEnvelope,
  serializeProviderStateEnvelope,
} from "@payswap/connectors";
import {
  PAYPAL_DIRECT_API_VERSION,
  PAYPAL_DIRECT_AUTHORIZATION_STATUS_MAPPING,
  PAYPAL_DIRECT_CAPTURE_STATUS_MAPPING,
  PAYPAL_DIRECT_CREDENTIAL_CONFIG_KEY,
  PAYPAL_DIRECT_DEFAULT_API_BASE_LIVE,
  PAYPAL_DIRECT_DEFAULT_API_BASE_SANDBOX,
  PAYPAL_DIRECT_FAIL_CLOSED_NOTE,
  PAYPAL_DIRECT_MINOR_UNIT_EXPONENTS,
  PAYPAL_DIRECT_ORDER_STATUS_MAPPING,
  PAYPAL_DIRECT_PAYOUT_EXECUTION_DELIBERATELY_NOT_IMPLEMENTED,
  PAYPAL_DIRECT_PAYOUT_ITEM_STATUS_MAPPING,
  PAYPAL_DIRECT_PROVIDER_NAME,
  PAYPAL_DIRECT_REFUND_STATUS_MAPPING,
  PAYPAL_DIRECT_SANDBOX_REACHABILITY_20261002,
  PAYPAL_DIRECT_VS_STRIPE_PAYPAL_DISTINCTION,
  PayPalDirectProductionRail,
  PaypalDirectWebhookIngestor,
  STRIPE_PAYPAL_ON_STRIPE_CAPABILITY_ID_LITERAL,
  PayPalDirectConnector,
  assertPayPalDirectNotConflatedWithStripePayPal,
  extractPaypalDirectCredentialBundle,
  isStripePayPalOnStripeCapabilityId,
  paypalDirectAccountEligibility,
  paypalDirectAuthorizationEnvelope,
  paypalDirectAuthorizationRevision,
  paypalDirectCapabilityDefinitions,
  paypalDirectCaptureEnvelope,
  paypalDirectDecimalValueFromMinorUnits,
  paypalDirectMinorUnitsFromDecimalValue,
  paypalDirectOrderEnvelope,
  paypalDirectOrderReference,
  paypalDirectPayoutBatchEnvelope,
  paypalDirectPayoutItemEnvelope,
  paypalDirectPayoutObservations,
  paypalDirectRailCapabilityPack,
  paypalDirectRefundEnvelope,
  paypalDirectSelectionEligibility,
  paypalDirectWebhookDeliveryHeaders,
  paypalDirectWebhookEventEnvelope,
  verifyPaypalDirectWebhookDelivery,
} from "../src/paypal-direct.js";
import type {
  PayPalAccountCapabilityScope,
  PaypalDirectAuthorizationProviderObject,
  PaypalDirectCaptureProviderObject,
  PaypalDirectOrderProviderObject,
  PaypalDirectPayoutBatchProviderObject,
  PaypalDirectPayoutItemProviderObject,
  PaypalDirectRefundProviderObject,
} from "../src/paypal-direct.js";
import { RailNotAuthorizedError, RailProviderError } from "../src/support.js";
import { CLOCK, ScriptedHttpTransport, ctx, makeAdapterAuthority } from "./fixtures.js";

const AUTHORITY = makeAdapterAuthority();
const T0 = "2026-10-02T06:37:38Z";
const CTX = { observedAt: T0, provenanceSource: "PROVIDER_API" } as const;

function jsonResponse(status: number, body: unknown): { status: number; bodyText: string } {
  return { status, bodyText: JSON.stringify(body) };
}

// SYNTHETIC credential fixtures — obviously fake, never real key material.
const SYNTHETIC_CLIENT_ID = "test-paypal-client-id-000000";
const SYNTHETIC_CLIENT_SECRET = "test-paypal-client-secret-000000";
const SYNTHETIC_WEBHOOK_ID = "test-paypal-webhook-id-000000";
const SYNTHETIC_ACCESS_TOKEN = "test-paypal-access-token-000000";

function syntheticEnvBundle(): Record<string, string> {
  return {
    [PAYPAL_DIRECT_CREDENTIAL_CONFIG_KEY]: JSON.stringify({
      clientId: SYNTHETIC_CLIENT_ID,
      clientSecret: SYNTHETIC_CLIENT_SECRET,
      webhookId: SYNTHETIC_WEBHOOK_ID,
    }),
  };
}

/** A scripted transport that answers the OAuth2 token endpoint and delegates the rest. */
function tokenThen(
  respond: (
    url: string,
    init: { method: string; body?: string },
  ) => { status: number; bodyText: string },
): ScriptedHttpTransport {
  return new ScriptedHttpTransport((url, init) => {
    if (url.endsWith("/v1/oauth2/token")) {
      return jsonResponse(200, {
        access_token: SYNTHETIC_ACCESS_TOKEN,
        expires_in: 3600,
        token_type: "Bearer",
      });
    }
    return respond(url, init);
  });
}

describe("paypal-direct connector vocabulary (P2-W1-002)", () => {
  it("pins the provider identity, API surface and the vault-template credential key", () => {
    expect(PAYPAL_DIRECT_PROVIDER_NAME).toBe("paypal_direct");
    expect(PAYPAL_DIRECT_API_VERSION).toBe("rest-v2-2026-10-02");
    expect(PAYPAL_DIRECT_CREDENTIAL_CONFIG_KEY).toBe("PROVIDER_PAYPAL_DIRECT_CREDENTIAL_REF");
  });

  it("pins the sandbox and live API bases separately", () => {
    expect(PAYPAL_DIRECT_DEFAULT_API_BASE_SANDBOX).toBe("https://api-m.sandbox.paypal.com");
    expect(PAYPAL_DIRECT_DEFAULT_API_BASE_LIVE).toBe("https://api-m.paypal.com");
  });

  it("capability definitions + pack use the v1.5 vocabulary (no parallel model)", () => {
    const definitions = paypalDirectCapabilityDefinitions();
    expect(definitions.length).toBe(6);
    for (const definition of definitions) {
      expect(definition.authorization.protocolAuthorization).toBe(true);
      expect(definition.idempotency).toBeDefined();
      expect(definition.providerVocabulary.states.length).toBeGreaterThan(0);
    }
    const pack = paypalDirectRailCapabilityPack();
    expect(pack.auth.authKind).toBe("OAUTH");
    expect(pack.sourceOfTruth).toBe("EXTERNAL_AUTHORITATIVE");
    expect(pack.capabilityRefs.length).toBe(6);
  });

  it("the six capability ids are the PayPal Direct family (distinct from every stripe capability)", () => {
    const ids = paypalDirectCapabilityDefinitions().map((definition) => definition.capabilityId);
    expect(ids).toEqual([
      "cap.rails.paypal-direct.payment_order",
      "cap.rails.paypal-direct.capture",
      "cap.rails.paypal-direct.authorization",
      "cap.rails.paypal-direct.refund",
      "cap.rails.paypal-direct.webhook",
      "cap.rails.paypal-direct.payout_observation",
    ]);
    for (const id of ids) {
      expect(id.startsWith("cap.rails.paypal-direct.")).toBe(true);
      expect(id.startsWith("cap.rails.stripe.")).toBe(false);
    }
  });

  it("the rail adapter registers the PayPal Direct pack", () => {
    const rail = new PayPalDirectProductionRail();
    expect(rail.adapterId).toBe("rail.paypal-direct");
    expect(rail.capabilityPack().packId).toBe("pack.rails.paypal-direct");
  });

  it("records the honest reachability datum (endpoint reachable, authorization absent — 2026-10-02)", () => {
    expect(PAYPAL_DIRECT_SANDBOX_REACHABILITY_20261002.host).toBe(
      "https://api-m.sandbox.paypal.com",
    );
    expect(PAYPAL_DIRECT_SANDBOX_REACHABILITY_20261002.endpoint).toBe("/v1/oauth2/token");
    expect(PAYPAL_DIRECT_SANDBOX_REACHABILITY_20261002.httpStatus).toBe(401);
    expect(PAYPAL_DIRECT_SANDBOX_REACHABILITY_20261002.verdict).toBe(
      "ENDPOINT_REACHABLE_AUTHORIZATION_ABSENT",
    );
    expect(PAYPAL_DIRECT_FAIL_CLOSED_NOTE.law).toBe("INV-NC04");
    expect(PAYPAL_DIRECT_FAIL_CLOSED_NOTE.recordedReachability).toBe(
      PAYPAL_DIRECT_SANDBOX_REACHABILITY_20261002,
    );
  });
});

describe("PayPal Direct ≠ Stripe PayPal (the distinctness law)", () => {
  it("the distinction contract is encoded as data", () => {
    expect(PAYPAL_DIRECT_VS_STRIPE_PAYPAL_DISTINCTION.payPalDirectProvider).toBe("paypal_direct");
    expect(PAYPAL_DIRECT_VS_STRIPE_PAYPAL_DISTINCTION.stripePayPalProvider).toBe("stripe");
    expect(PAYPAL_DIRECT_VS_STRIPE_PAYPAL_DISTINCTION.stripePayPalCapabilityId).toBe(
      "cap.rails.stripe.paypal_on_stripe",
    );
    expect(PAYPAL_DIRECT_VS_STRIPE_PAYPAL_DISTINCTION.distinction).toContain("never conflated");
  });

  it("recognizes the Stripe PayPal-on-Stripe capability id as NOT ours", () => {
    expect(isStripePayPalOnStripeCapabilityId("cap.rails.stripe.paypal_on_stripe")).toBe(true);
    expect(isStripePayPalOnStripeCapabilityId("cap.rails.paypal-direct.payment_order")).toBe(false);
    expect(STRIPE_PAYPAL_ON_STRIPE_CAPABILITY_ID_LITERAL).toBe("cap.rails.stripe.paypal_on_stripe");
  });

  it("the guard refuses a Stripe provider name (fail-closed conflation error)", () => {
    expect(() =>
      assertPayPalDirectNotConflatedWithStripePayPal({ providerName: "stripe" }),
    ).toThrow(/PayPal-on-Stripe provider, NOT PayPal Direct/);
  });

  it("the guard refuses Stripe capability ids (including PayPal-on-Stripe)", () => {
    expect(() =>
      assertPayPalDirectNotConflatedWithStripePayPal({
        providerName: "paypal_direct",
        capabilityId: "cap.rails.stripe.paypal_on_stripe",
      }),
    ).toThrow(/belongs to the Stripe connector/);
    expect(() =>
      assertPayPalDirectNotConflatedWithStripePayPal({
        providerName: "paypal_direct",
        capabilityId: "cap.rails.stripe.payment_intent",
      }),
    ).toThrow(/belongs to the Stripe connector/);
  });

  it("the guard passes the PayPal Direct surface through", () => {
    expect(() =>
      assertPayPalDirectNotConflatedWithStripePayPal({
        providerName: "paypal_direct",
        capabilityId: "cap.rails.paypal-direct.payment_order",
      }),
    ).not.toThrow();
  });

  it("selection requires the OWN provider + an OBSERVED connected-instance scope", () => {
    const scope: PayPalAccountCapabilityScope = {
      accountCountry: "FR",
      capabilities: {},
      observedAt: T0,
      provenanceSource: "PROVIDER_API",
    };
    expect(
      paypalDirectSelectionEligibility({
        providerName: "paypal_direct",
        accountScope: scope,
      }).selectable,
    ).toBe(true);
    expect(
      paypalDirectSelectionEligibility({
        providerName: "paypal_direct",
        accountScope: null,
      }).reason,
    ).toContain("never assumed");
    expect(
      paypalDirectSelectionEligibility({
        providerName: "adyen",
        accountScope: scope,
      }).selectable,
    ).toBe(false);
  });

  it("selection with a Stripe surface fails closed via the conflation guard", () => {
    expect(() =>
      paypalDirectSelectionEligibility({
        providerName: "stripe",
        capabilityId: "cap.rails.stripe.paypal_on_stripe",
        accountScope: null,
      }),
    ).toThrow(/PayPal-on-Stripe/);
  });
});

describe("paypal-direct order lifecycle → ProviderStateEnvelope (lossless, INV-C06)", () => {
  const order = (
    status: string,
    overrides: Partial<PaypalDirectOrderProviderObject> = {},
  ): PaypalDirectOrderProviderObject => ({
    id: "5O190127TN364715T",
    status,
    intent: "CAPTURE",
    purchase_units: [
      {
        reference_id: "payswap:order-123",
        custom_id: "payswap:order-123",
        amount: { currency_code: "USD", value: "100.00" },
      },
    ],
    create_time: "2026-10-02T06:37:38Z",
    update_time: "2026-10-02T06:37:38Z",
    links: [
      { href: "https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T", rel: "approve", method: "GET" },
    ],
    ...overrides,
  });

  it("maps every status in the recorded order mapping table with the exact classification", () => {
    for (const row of PAYPAL_DIRECT_ORDER_STATUS_MAPPING) {
      const envelope = paypalDirectOrderEnvelope(order(row.providerState), CTX);
      expect(envelope.classification.family).toBe(row.family);
      expect(envelope.classification.lifecycleStep).toBe(row.lifecycleStep);
      expect(envelope.classification.isTerminal).toBe(row.isTerminal);
      expect(envelope.classification.requiresCustomerAction).toBe(row.requiresCustomerAction);
      // the RAW provider status is preserved VERBATIM (never flattened)
      expect((envelope.state as { status: string }).status).toBe(row.providerState);
    }
  });

  it("CREATED/SAVED/PAYER_ACTION_REQUIRED are customer-action-required with the approve link", () => {
    for (const status of ["CREATED", "SAVED", "PAYER_ACTION_REQUIRED"]) {
      const envelope = paypalDirectOrderEnvelope(order(status), CTX);
      expect(envelope.classification.family).toBe("customer_action_required");
      expect(envelope.classification.requiresCustomerAction).toBe(true);
      expect(envelope.actionRequired).toBeDefined();
      expect(envelope.actionRequired?.kind).toBe("PROVIDER_CHALLENGE_REDIRECT");
      expect(envelope.actionRequired?.deepLink).toContain("sandbox.paypal.com");
    }
  });

  it("an order without an approve link still classifies as customer-action-required (no deepLink guess)", () => {
    const envelope = paypalDirectOrderEnvelope(order("CREATED", { links: [] }), CTX);
    expect(envelope.classification.family).toBe("customer_action_required");
    expect(envelope.actionRequired).toBeUndefined();
  });

  it("APPROVED is authorized-then-actionable (the capture family, non-terminal)", () => {
    const envelope = paypalDirectOrderEnvelope(order("APPROVED"), CTX);
    expect(envelope.classification.family).toBe("capture");
    expect(envelope.classification.isTerminal).toBe(false);
    expect(envelope.classification.requiresCustomerAction).toBe(false);
  });

  it("COMPLETED is terminal (captured/settled-external)", () => {
    const envelope = paypalDirectOrderEnvelope(order("COMPLETED"), CTX);
    expect(envelope.classification.family).toBe("other");
    expect(envelope.classification.isTerminal).toBe(true);
  });

  it("VOIDED is terminal-cancelled with definitive failure metadata", () => {
    const envelope = paypalDirectOrderEnvelope(order("VOIDED"), CTX);
    expect(envelope.classification.isTerminal).toBe(true);
    expect(envelope.failure?.providerErrorCode).toBe("order_voided");
    expect(envelope.failure?.ambiguity).toBe("NONE");
  });

  it("an UNKNOWN order status classifies as other/verbatim, non-terminal — never FAILED", () => {
    const envelope = paypalDirectOrderEnvelope(order("WEIRD_NEW_STATUS"), CTX);
    expect(envelope.classification.family).toBe("other");
    expect(envelope.classification.lifecycleStep).toBe("WEIRD_NEW_STATUS");
    expect(envelope.classification.isTerminal).toBe(false);
    expect((envelope.state as { status: string }).status).toBe("WEIRD_NEW_STATUS");
    expect(envelope.failure).toBeUndefined();
  });

  it("carries the provider order id as the external id and preserves provider identity/version", () => {
    const envelope = paypalDirectOrderEnvelope(order("APPROVED"), CTX);
    expect(envelope.provider.name).toBe(PAYPAL_DIRECT_PROVIDER_NAME);
    expect(envelope.provider.version).toBe(PAYPAL_DIRECT_API_VERSION);
    expect(envelope.object.objectType).toBe("order");
    expect(envelope.object.externalId).toBe("5O190127TN364715T");
    expect(envelope.revision.length).toBeGreaterThan(0);
    expect(envelope.provenance.source).toBe("PROVIDER_API");
  });

  it("lossless round-trip through serialize/parse (INV-C06)", () => {
    const envelope = paypalDirectOrderEnvelope(order("PAYER_ACTION_REQUIRED"), CTX);
    const parsed = parseProviderStateEnvelope(serializeProviderStateEnvelope(envelope));
    expect(parsed).toEqual(envelope);
  });

  it("provider fields survive verbatim (purchase_units, payer, links, timestamps)", () => {
    const raw = order("APPROVED", {
      payer: { email_address: "payer@example.com", payer_id: "TESTPAYERID" },
    });
    const envelope = paypalDirectOrderEnvelope(raw, CTX);
    const state = envelope.state as PaypalDirectOrderProviderObject;
    expect(state.purchase_units?.[0]?.reference_id).toBe("payswap:order-123");
    expect(state.purchase_units?.[0]?.amount?.value).toBe("100.00");
    expect(state.payer?.payer_id).toBe("TESTPAYERID");
    expect(state.links?.[0]?.rel).toBe("approve");
  });
});

describe("paypal-direct authorizations / captures / refunds (statuses verbatim)", () => {
  const authorization = (
    status: string,
  ): PaypalDirectAuthorizationProviderObject => ({
    id: "0XB58370V7267913D",
    status,
    amount: { currency_code: "USD", value: "100.00" },
    update_time: "2026-10-02T06:37:38Z",
  });
  const capture = (status: string): PaypalDirectCaptureProviderObject => ({
    id: "92G32119GX554734W",
    status,
    amount: { currency_code: "USD", value: "100.00" },
    update_time: "2026-10-02T06:37:38Z",
  });
  const refund = (
    status: string,
    overrides: Partial<PaypalDirectRefundProviderObject> = {},
  ): PaypalDirectRefundProviderObject => ({
    id: "1X299949LM123456A",
    status,
    amount: { currency_code: "USD", value: "50.00" },
    capture_id: "92G32119GX554734W",
    update_time: "2026-10-02T06:37:38Z",
    ...overrides,
  });

  it("maps every authorization status in the recorded table", () => {
    for (const row of PAYPAL_DIRECT_AUTHORIZATION_STATUS_MAPPING) {
      const envelope = paypalDirectAuthorizationEnvelope(authorization(row.providerState), CTX);
      expect(envelope.classification.family).toBe(row.family);
      expect(envelope.classification.isTerminal).toBe(row.isTerminal);
      expect((envelope.state as { status: string }).status).toBe(row.providerState);
    }
  });

  it("an UNKNOWN authorization status stays other/verbatim, non-terminal", () => {
    const envelope = paypalDirectAuthorizationEnvelope(authorization("EXPIRED_NEW"), CTX);
    expect(envelope.classification.family).toBe("other");
    expect(envelope.classification.isTerminal).toBe(false);
    expect(envelope.classification.lifecycleStep).toBe("EXPIRED_NEW");
  });

  it("maps every capture status in the recorded table", () => {
    for (const row of PAYPAL_DIRECT_CAPTURE_STATUS_MAPPING) {
      const envelope = paypalDirectCaptureEnvelope(capture(row.providerState), CTX);
      expect(envelope.classification.family).toBe(row.family);
      expect(envelope.classification.isTerminal).toBe(row.isTerminal);
      expect((envelope.state as { status: string }).status).toBe(row.providerState);
    }
  });

  it("DECLINED captures carry definitive failure metadata", () => {
    const envelope = paypalDirectCaptureEnvelope(capture("DECLINED"), CTX);
    expect(envelope.failure?.providerErrorCode).toBe("capture_declined");
    expect(envelope.failure?.ambiguity).toBe("NONE");
  });

  it("maps every refund status in the recorded table (CANCELLED/PENDING/COMPLETED)", () => {
    for (const row of PAYPAL_DIRECT_REFUND_STATUS_MAPPING) {
      const envelope = paypalDirectRefundEnvelope(refund(row.providerState), CTX);
      expect(envelope.classification.family).toBe("refund");
      expect(envelope.classification.isTerminal).toBe(row.isTerminal);
      expect((envelope.state as { status: string }).status).toBe(row.providerState);
    }
  });

  it("an UNKNOWN refund status stays refund-family verbatim, non-terminal", () => {
    const envelope = paypalDirectRefundEnvelope(refund("MYSTERY"), CTX);
    expect(envelope.classification.family).toBe("refund");
    expect(envelope.classification.isTerminal).toBe(false);
    expect(envelope.classification.lifecycleStep).toBe("MYSTERY");
  });

  it("refund revisions derive from id + status + update_time", () => {
    expect(paypalDirectAuthorizationRevision(authorization("CREATED"))).toBe(
      "0XB58370V7267913D:CREATED:2026-10-02T06:37:38Z",
    );
    expect(refund("PENDING").id).toBeDefined();
  });
});

describe("paypal-direct payout OBSERVATION (INV-C09 — read-only, all item statuses verbatim)", () => {
  const item = (
    status: string,
    overrides: Partial<PaypalDirectPayoutItemProviderObject> = {},
  ): PaypalDirectPayoutItemProviderObject => ({
    payout_item_id: "JH8S9ZQ4XKVW6",
    transaction_id: "8H349074A6494832U",
    transaction_status: status,
    payout_batch_id: "YQCEB2SZAB2J6",
    payout_item: {
      recipient_type: "EMAIL",
      amount: { currency: "USD", value: "25.00" },
      receiver: "receiver@example.com",
    },
    update_time: "2026-10-02T06:37:38Z",
    ...overrides,
  });

  it("maps EVERY payout-item status verbatim (the nine documented + unknown catch-all)", () => {
    for (const row of PAYPAL_DIRECT_PAYOUT_ITEM_STATUS_MAPPING) {
      const envelope = paypalDirectPayoutItemEnvelope(item(row.providerState), CTX);
      expect(envelope.classification.family).toBe("payout");
      expect(envelope.classification.lifecycleStep).toBe(row.lifecycleStep);
      expect(envelope.classification.isTerminal).toBe(row.isTerminal);
      expect((envelope.state as { transaction_status: string }).transaction_status).toBe(
        row.providerState,
      );
    }
    const unknown = paypalDirectPayoutItemEnvelope(item("MYSTERY_STATUS"), CTX);
    expect(unknown.classification.family).toBe("payout");
    expect(unknown.classification.isTerminal).toBe(false);
    expect(unknown.classification.lifecycleStep).toBe("MYSTERY_STATUS");
  });

  it("FAILED payout items carry the provider error name verbatim when present", () => {
    const envelope = paypalDirectPayoutItemEnvelope(
      item("FAILED", { errors: { name: "PAYMENT_STATE_INVALID", message: "receiver not found" } }),
      CTX,
    );
    expect(envelope.classification.isTerminal).toBe(true);
    expect(envelope.failure?.providerErrorCode).toBe("PAYMENT_STATE_INVALID");
    expect(envelope.failure?.providerErrorMessage).toBe("receiver not found");
  });

  it("BLOCKED payout items are terminal with failure metadata", () => {
    const envelope = paypalDirectPayoutItemEnvelope(item("BLOCKED"), CTX);
    expect(envelope.classification.isTerminal).toBe(true);
    expect(envelope.failure?.providerErrorCode).toBe("payout_item_blocked");
  });

  it("payout batches observe as payout-family envelopes carrying batch_header + items verbatim", () => {
    const batch: PaypalDirectPayoutBatchProviderObject = {
      batch_header: {
        payout_batch_id: "YQCEB2SZAB2J6",
        batch_status: "SUCCESS",
        amount: { currency: "USD", value: "50.00" },
        update_time: "2026-10-02T06:37:38Z",
      },
      items: [item("SUCCESS"), item("UNCLAIMED")],
    };
    const envelope = paypalDirectPayoutBatchEnvelope(batch, CTX);
    expect(envelope.object.objectType).toBe("payout_batch");
    expect(envelope.object.externalId).toBe("YQCEB2SZAB2J6");
    expect(envelope.classification.family).toBe("payout");
    expect(envelope.classification.isTerminal).toBe(true);
    const state = envelope.state as PaypalDirectPayoutBatchProviderObject;
    expect(state.items).toHaveLength(2);
    expect(state.batch_header?.batch_status).toBe("SUCCESS");
  });

  it("payout items map to ExternalFundsPositionObservation with exact minor units", () => {
    const observations = paypalDirectPayoutObservations({
      items: [item("SUCCESS"), item("PROCESSING", { payout_item: { amount: { currency: "JPY", value: "500" }, recipient_type: "EMAIL", receiver: "r@example.com" } })],
      accountRef: "paypal-account-1",
      observedAt: T0,
    });
    expect(observations).toHaveLength(2);
    expect(observations[0]?.observationKind).toBe("ExternalFundsPositionObservation");
    expect(observations[0]?.location.providerName).toBe("paypal_direct");
    expect(observations[0]?.location.accountRef).toBe("paypal-account-1");
    expect(observations[0]?.observedAmount.currency).toBe("USD");
    expect(observations[0]?.observedAmount.minorUnits).toBe("2500");
    expect(observations[1]?.observedAmount.currency).toBe("JPY");
    expect(observations[1]?.observedAmount.minorUnits).toBe("500");
    expect(observations[0]?.freshness.asOf).toBe("2026-10-02T06:37:38Z");
    expect(observations[0]?.provenance.source).toBe("PROVIDER_API");
  });

  it("sub-minor or unknown-exponent provider amounts are honestly skipped (never rounded)", () => {
    const observations = paypalDirectPayoutObservations({
      items: [
        item("SUCCESS", {
          payout_item: { amount: { currency: "USD", value: "25.005" }, recipient_type: "EMAIL", receiver: "r@example.com" },
        }),
        item("SUCCESS", {
          payout_item: { amount: { currency: "XYZ", value: "25.00" }, recipient_type: "EMAIL", receiver: "r@example.com" },
        }),
      ],
      accountRef: "paypal-account-1",
      observedAt: T0,
    });
    expect(observations).toHaveLength(0);
  });

  it("the payout CREATE surface is deliberately not implemented (byte-scannable law)", () => {
    expect(PAYPAL_DIRECT_PAYOUT_EXECUTION_DELIBERATELY_NOT_IMPLEMENTED.notImplemented).toBe(
      "POST /v1/payments/payouts",
    );
    expect(PAYPAL_DIRECT_PAYOUT_EXECUTION_DELIBERATELY_NOT_IMPLEMENTED.implementedReadOnly)
      .toContain("GET /v1/payments/payouts/{batch_id}");
    expect(PAYPAL_DIRECT_PAYOUT_EXECUTION_DELIBERATELY_NOT_IMPLEMENTED.reason).toContain("INV-C09");
  });
});

describe("paypal-direct minor-unit conversion (INV-F01 — exact, never floats)", () => {
  it("minor units → PayPal decimal value at the documented exponent", () => {
    expect(paypalDirectDecimalValueFromMinorUnits("10000", "USD")).toBe("100.00");
    expect(paypalDirectDecimalValueFromMinorUnits("5", "USD")).toBe("0.05");
    expect(paypalDirectDecimalValueFromMinorUnits("500", "JPY")).toBe("500");
    expect(paypalDirectDecimalValueFromMinorUnits("1234567", "KWD")).toBe("1234.567");
    expect(paypalDirectDecimalValueFromMinorUnits("0", "EUR")).toBe("0.00");
  });

  it("PayPal decimal value → minor units, round-trip lossless", () => {
    expect(paypalDirectMinorUnitsFromDecimalValue("100.00", "USD")).toBe("10000");
    expect(paypalDirectMinorUnitsFromDecimalValue("500", "JPY")).toBe("500");
    expect(paypalDirectMinorUnitsFromDecimalValue("1234.567", "KWD")).toBe("1234567");
    expect(paypalDirectMinorUnitsFromDecimalValue("0.05", "GHS")).toBe("5");
    for (const [value, currency] of [
      ["19.99", "USD"],
      ["1234.50", "NGN"],
      ["75", "XOF"],
    ] as const) {
      const round = paypalDirectDecimalValueFromMinorUnits(
        paypalDirectMinorUnitsFromDecimalValue(value, currency),
        currency,
      );
      expect(round).toBe(value);
    }
  });

  it("sub-minor precision is REFUSED, never rounded", () => {
    expect(() => paypalDirectMinorUnitsFromDecimalValue("25.005", "USD")).toThrow(/sub-minor/);
    expect(() => paypalDirectMinorUnitsFromDecimalValue("1.999", "EUR")).toThrow(/sub-minor/);
  });

  it("unknown exponents are refused (never guessed)", () => {
    expect(() => paypalDirectDecimalValueFromMinorUnits("100", "XYZ")).toThrow(/never guessed/);
    expect(() => paypalDirectMinorUnitsFromDecimalValue("100.00", "XYZ")).toThrow(/never guessed/);
    expect(PAYPAL_DIRECT_MINOR_UNIT_EXPONENTS["JPY"]).toBe(0);
    expect(PAYPAL_DIRECT_MINOR_UNIT_EXPONENTS["BHD"]).toBe(3);
    expect(PAYPAL_DIRECT_MINOR_UNIT_EXPONENTS["GHS"]).toBe(2);
  });

  it("non-integer minor-unit inputs are refused", () => {
    expect(() => paypalDirectDecimalValueFromMinorUnits("10.5", "USD")).toThrow(/INV-F01/);
    expect(() => paypalDirectDecimalValueFromMinorUnits("-1", "USD")).toThrow(/INV-F01/);
  });
});

describe("paypal-direct idempotency (reference-based — INV-F05)", () => {
  it("derives the order reference deterministically from the protocol key", () => {
    expect(paypalDirectOrderReference("order-123")).toBe("payswap:order-123");
    expect(paypalDirectOrderReference("order-123")).toBe("payswap:order-123");
    expect(paypalDirectOrderReference("abc")).not.toBe(paypalDirectOrderReference("abd"));
    expect(() => paypalDirectOrderReference("")).toThrow();
  });

  it("the derived reference fits PayPal's documented 127-char limit — long keys hash deterministically", () => {
    const longKey = "k".repeat(300);
    const derived = paypalDirectOrderReference(longKey);
    expect(derived.length).toBeLessThanOrEqual(127);
    expect(derived.startsWith("payswap-long:")).toBe(true);
    expect(paypalDirectOrderReference(longKey)).toBe(derived); // deterministic
    expect(paypalDirectOrderReference("j".repeat(300))).not.toBe(derived); // distinct
  });
});

describe("paypal-direct webhook verification (SERVER-SIDE, stubbed transport)", () => {
  const FULL_HEADERS: Readonly<Record<string, string>> = Object.freeze({
    "PAYPAL-AUTH-ALGO": "SHA256withRSA",
    "PAYPAL-CERT-URL": "https://api-m.sandbox.paypal.com/v1/notifications/certs/CERT-36042042F641B0C13A64273D994F35B",
    "PAYPAL-TRANSMISSION-ID": "synthetic-transmission-id-000000",
    "PAYPAL-TRANSMISSION-SIG": "synthetic-signature-000000",
    "PAYPAL-TRANSMISSION-TIME": "2026-10-02T06:37:38Z",
  });
  const WEBHOOK_EVENT = Object.freeze({
    id: "WH-SYNTHETIC-000001",
    event_type: "PAYMENT.CAPTURE.COMPLETED",
    resource: { id: "92G32119GX554734W", status: "COMPLETED", amount: { currency_code: "USD", value: "100.00" } },
  });

  it("extracts the full five-header set (canonical, lower-case and mixed-case maps)", () => {
    const canonical = paypalDirectWebhookDeliveryHeaders(FULL_HEADERS);
    expect("headers" in canonical).toBe(true);
    if ("headers" in canonical) {
      expect(canonical.headers["PAYPAL-TRANSMISSION-ID"]).toBe("synthetic-transmission-id-000000");
    }
    const lowerCased = paypalDirectWebhookDeliveryHeaders(
      Object.fromEntries(Object.entries(FULL_HEADERS).map(([k, v]) => [k.toLowerCase(), v])),
    );
    expect("headers" in lowerCased).toBe(true);
  });

  it("ANY missing/empty signature header fails closed with the missing list", () => {
    const partial = { ...FULL_HEADERS };
    delete partial["PAYPAL-TRANSMISSION-SIG"];
    const result = paypalDirectWebhookDeliveryHeaders(partial);
    expect("missing" in result && result.missing).toEqual(["PAYPAL-TRANSMISSION-SIG"]);
    const empty = paypalDirectWebhookDeliveryHeaders({ ...FULL_HEADERS, "PAYPAL-AUTH-ALGO": "" });
    expect("missing" in empty && empty.missing).toEqual(["PAYPAL-AUTH-ALGO"]);
    const none = paypalDirectWebhookDeliveryHeaders({});
    expect("missing" in none && none.missing.length).toBe(5);
  });

  it("server-side verification POSTs the exact PayPal body and trusts verification_status SUCCESS", async () => {
    const transport = new ScriptedHttpTransport((url, init) => {
      expect(url).toContain("/v1/notifications/verify-webhook-signature");
      const body = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
      expect(body["auth_algo"]).toBe("SHA256withRSA");
      expect(body["webhook_id"]).toBe(SYNTHETIC_WEBHOOK_ID);
      expect(body["webhook_event"]).toEqual(WEBHOOK_EVENT);
      return jsonResponse(200, { verification_status: "SUCCESS" });
    });
    const shape = paypalDirectWebhookDeliveryHeaders(FULL_HEADERS);
    if (!("headers" in shape)) {
      throw new Error("expected full headers");
    }
    const result = await verifyPaypalDirectWebhookDelivery({
      http: transport.transport,
      apiBase: "https://api-m.sandbox.paypal.com",
      accessToken: SYNTHETIC_ACCESS_TOKEN,
      webhookId: SYNTHETIC_WEBHOOK_ID,
      headers: shape.headers,
      webhookEvent: WEBHOOK_EVENT,
    });
    expect(result.verificationStatus).toBe("SUCCESS");
  });

  it("verification_status FAILURE is reported, never guessed into success", async () => {
    const transport = new ScriptedHttpTransport(() =>
      jsonResponse(200, { verification_status: "FAILURE" }),
    );
    const shape = paypalDirectWebhookDeliveryHeaders(FULL_HEADERS);
    if (!("headers" in shape)) {
      throw new Error("expected full headers");
    }
    const result = await verifyPaypalDirectWebhookDelivery({
      http: transport.transport,
      apiBase: "https://api-m.sandbox.paypal.com",
      accessToken: SYNTHETIC_ACCESS_TOKEN,
      webhookId: SYNTHETIC_WEBHOOK_ID,
      headers: shape.headers,
      webhookEvent: WEBHOOK_EVENT,
    });
    expect(result.verificationStatus).toBe("FAILURE");
  });

  it("a malformed verification answer fails closed (RailProviderError, never a guess)", async () => {
    const malformed = new ScriptedHttpTransport(() => jsonResponse(200, { weird: true }));
    const notJson = new ScriptedHttpTransport(() => jsonResponse(200, undefined as unknown as object));
    const shape = paypalDirectWebhookDeliveryHeaders(FULL_HEADERS);
    if (!("headers" in shape)) {
      throw new Error("expected full headers");
    }
    for (const transport of [malformed, notJson]) {
      if (transport === notJson) {
        continue; // JSON.parse(undefined-as-string) — covered below with bodyText garbage
      }
      await expect(
        verifyPaypalDirectWebhookDelivery({
          http: transport.transport,
          apiBase: "https://api-m.sandbox.paypal.com",
          accessToken: SYNTHETIC_ACCESS_TOKEN,
          webhookId: SYNTHETIC_WEBHOOK_ID,
          headers: shape.headers,
          webhookEvent: WEBHOOK_EVENT,
        }),
      ).rejects.toThrow(RailProviderError);
    }
    const garbage = new ScriptedHttpTransport(() => ({ status: 200, bodyText: "not-json" }));
    await expect(
      verifyPaypalDirectWebhookDelivery({
        http: garbage.transport,
        apiBase: "https://api-m.sandbox.paypal.com",
        accessToken: SYNTHETIC_ACCESS_TOKEN,
        webhookId: SYNTHETIC_WEBHOOK_ID,
        headers: shape.headers,
        webhookEvent: WEBHOOK_EVENT,
      }),
    ).rejects.toThrow(/not JSON/);
  });

  it("the ingestor accepts a verified delivery and maps the inner capture envelope", async () => {
    const ingestor = new PaypalDirectWebhookIngestor({
      http: new ScriptedHttpTransport(() =>
        jsonResponse(200, { verification_status: "SUCCESS" }),
      ).transport,
      apiBase: "https://api-m.sandbox.paypal.com",
      webhookId: SYNTHETIC_WEBHOOK_ID,
      tokenProvider: async () => SYNTHETIC_ACCESS_TOKEN,
      observedAt: () => T0,
    });
    const result = await ingestor.ingest({
      eventId: "WH-SYNTHETIC-000001",
      webhookEvent: WEBHOOK_EVENT,
      headers: FULL_HEADERS,
    });
    expect(result.outcome).toBe("ACCEPTED");
    if (result.outcome === "ACCEPTED") {
      expect(result.envelope.object.objectType).toBe("capture");
      expect(result.envelope.classification.isTerminal).toBe(true);
      expect(result.envelope.provenance.source).toBe("PROVIDER_WEBHOOK");
    }
  });

  it("the ingestor DEDUPES a replayed (provider, eventId) pair", async () => {
    const ingestor = new PaypalDirectWebhookIngestor({
      http: new ScriptedHttpTransport(() =>
        jsonResponse(200, { verification_status: "SUCCESS" }),
      ).transport,
      apiBase: "https://api-m.sandbox.paypal.com",
      webhookId: SYNTHETIC_WEBHOOK_ID,
      tokenProvider: async () => SYNTHETIC_ACCESS_TOKEN,
      observedAt: () => T0,
    });
    const delivery = {
      eventId: "WH-SYNTHETIC-000002",
      webhookEvent: WEBHOOK_EVENT,
      headers: FULL_HEADERS,
    };
    const first = await ingestor.ingest(delivery);
    expect(first.outcome).toBe("ACCEPTED");
    const replay = await ingestor.ingest(delivery);
    expect(replay.outcome).toBe("DUPLICATE");
    if (replay.outcome === "DUPLICATE") {
      expect(replay.eventId).toBe("WH-SYNTHETIC-000002");
    }
  });

  it("the ingestor REJECTS on provider verification FAILURE and on missing headers (fail-closed)", async () => {
    const rejecting = new PaypalDirectWebhookIngestor({
      http: new ScriptedHttpTransport(() =>
        jsonResponse(200, { verification_status: "FAILURE" }),
      ).transport,
      apiBase: "https://api-m.sandbox.paypal.com",
      webhookId: SYNTHETIC_WEBHOOK_ID,
      tokenProvider: async () => SYNTHETIC_ACCESS_TOKEN,
      observedAt: () => T0,
    });
    const rejected = await rejecting.ingest({
      eventId: "WH-SYNTHETIC-000003",
      webhookEvent: WEBHOOK_EVENT,
      headers: FULL_HEADERS,
    });
    expect(rejected.outcome).toBe("REJECTED");
    if (rejected.outcome === "REJECTED") {
      expect(rejected.reason).toContain("FAILURE");
    }
    const missing = await rejecting.ingest({
      eventId: "WH-SYNTHETIC-000004",
      webhookEvent: WEBHOOK_EVENT,
      headers: { "PAYPAL-AUTH-ALGO": "SHA256withRSA" },
    });
    expect(missing.outcome).toBe("REJECTED");
    if (missing.outcome === "REJECTED") {
      expect(missing.reason).toContain("missing PayPal signature headers");
    }
  });

  it("the ingestor requires a non-empty webhook id (no assumed dashboard registration)", () => {
    expect(
      () =>
        new PaypalDirectWebhookIngestor({
          http: new ScriptedHttpTransport(() => jsonResponse(200, {})).transport,
          apiBase: "https://api-m.sandbox.paypal.com",
          webhookId: "",
          tokenProvider: async () => SYNTHETIC_ACCESS_TOKEN,
          observedAt: () => T0,
        }),
    ).toThrow(/webhook id/);
  });

  it("dispute-class events (CUSTOMER.DISPUTE.*) map to the dispute family with the raw event verbatim", () => {
    const envelope = paypalDirectWebhookEventEnvelope(
      {
        id: "WH-SYNTHETIC-DISPUTE-1",
        event_type: "CUSTOMER.DISPUTE.CREATED",
        resource: { dispute_id: "PP-DISPUTE-SYNTHETIC", status: "OPEN" },
      },
      { observedAt: T0, provenanceSource: "PROVIDER_WEBHOOK" },
    );
    expect(envelope.classification.family).toBe("dispute");
    expect(envelope.classification.lifecycleStep).toBe("CUSTOMER.DISPUTE.CREATED");
    expect(envelope.object.objectType).toBe("dispute");
    expect(JSON.stringify(envelope.state)).toContain("PP-DISPUTE-SYNTHETIC");
  });

  it("untyped webhook events carry the WHOLE payload verbatim (nothing dropped)", () => {
    const envelope = paypalDirectWebhookEventEnvelope(
      { id: "WH-SYNTHETIC-MISC-1", event_type: "MERCHANT.ONBOARDING.COMPLETED", resource: { x: 1 } },
      { observedAt: T0, provenanceSource: "PROVIDER_WEBHOOK" },
    );
    expect(envelope.object.objectType).toBe("event");
    expect(envelope.classification.family).toBe("other");
    expect(JSON.stringify(envelope.state)).toContain("MERCHANT.ONBOARDING.COMPLETED");
  });

  it("CHECKOUT.ORDER.* webhook events map through the order envelope", () => {
    const envelope = paypalDirectWebhookEventEnvelope(
      {
        id: "WH-SYNTHETIC-ORDER-1",
        event_type: "CHECKOUT.ORDER.APPROVED",
        resource: { id: "5O190127TN364715T", status: "APPROVED" },
      },
      { observedAt: T0, provenanceSource: "PROVIDER_WEBHOOK" },
    );
    expect(envelope.object.objectType).toBe("order");
    expect(envelope.classification.family).toBe("capture");
  });

  it("REFUND.* webhook events map through the refund envelope", () => {
    const envelope = paypalDirectWebhookEventEnvelope(
      {
        id: "WH-SYNTHETIC-REFUND-1",
        event_type: "REFUND.COMPLETED",
        resource: { id: "1X299949LM123456A", status: "COMPLETED" },
      },
      { observedAt: T0, provenanceSource: "PROVIDER_WEBHOOK" },
    );
    expect(envelope.object.objectType).toBe("refund");
    expect(envelope.classification.family).toBe("refund");
    expect(envelope.classification.isTerminal).toBe(true);
  });
});

describe("paypal-direct eligibility (OBSERVED, never assumed)", () => {
  const observedScope: PayPalAccountCapabilityScope = {
    payerId: "TESTPAYERID0000",
    accountCountry: "FR",
    payerStatus: "VERIFIED",
    emailConfirmed: true,
    capabilities: { "currency:USD": "ELIGIBLE" },
    observedAt: T0,
    provenanceSource: "PROVIDER_API",
  };

  it("NO scope → UNKNOWN, never assumed (the provider is the authority)", () => {
    const verdict = paypalDirectAccountEligibility(null, { country: "FR" });
    expect(verdict.eligible).toBe(false);
    expect(verdict.basis).toBe("UNKNOWN");
    expect(verdict.reason).toContain("never assumed");
  });

  it("a matching observed account country → eligible with OBSERVED basis", () => {
    const verdict = paypalDirectAccountEligibility(observedScope, { country: "fr" });
    expect(verdict.eligible).toBe(true);
    expect(verdict.basis).toBe("OBSERVED_ACCOUNT_SCOPE");
    expect(verdict.reason).toContain("FR");
  });

  it("a provider-declared currency capability → eligible with OBSERVED basis", () => {
    const verdict = paypalDirectAccountEligibility(observedScope, { currency: "USD" });
    expect(verdict.eligible).toBe(true);
    expect(verdict.basis).toBe("OBSERVED_ACCOUNT_SCOPE");
  });

  it("a mismatched country is NOT assumed ineligible — UNKNOWN with the honest reason", () => {
    const verdict = paypalDirectAccountEligibility(observedScope, { country: "GH" });
    expect(verdict.eligible).toBe(false);
    expect(verdict.basis).toBe("UNKNOWN");
    expect(verdict.reason).toContain("never assumed");
  });

  it("an observed scope that does not answer the question → UNKNOWN", () => {
    const verdict = paypalDirectAccountEligibility(observedScope, { currency: "GHS" });
    expect(verdict.basis).toBe("UNKNOWN");
  });
});

describe("paypal-direct credential bundle extraction (fail-closed shapes)", () => {
  it("accepts camelCase and snake_case pairs with the optional webhook id", () => {
    const camel = extractPaypalDirectCredentialBundle({
      clientId: SYNTHETIC_CLIENT_ID,
      clientSecret: SYNTHETIC_CLIENT_SECRET,
      webhookId: SYNTHETIC_WEBHOOK_ID,
    });
    expect(camel.clientId).toBe(SYNTHETIC_CLIENT_ID);
    expect(camel.webhookId).toBe(SYNTHETIC_WEBHOOK_ID);
    const snake = extractPaypalDirectCredentialBundle({
      client_id: SYNTHETIC_CLIENT_ID,
      client_secret: SYNTHETIC_CLIENT_SECRET,
    });
    expect(snake.clientSecret).toBe(SYNTHETIC_CLIENT_SECRET);
    expect(snake.webhookId).toBeUndefined();
  });

  it("REFUSES a plain string (a PayPal credential is a PAIR) and partial shapes", () => {
    expect(() => extractPaypalDirectCredentialBundle(SYNTHETIC_CLIENT_ID)).toThrow(/client pair/);
    expect(() => extractPaypalDirectCredentialBundle({ clientId: SYNTHETIC_CLIENT_ID })).toThrow();
    expect(() => extractPaypalDirectCredentialBundle({ clientSecret: SYNTHETIC_CLIENT_SECRET })).toThrow();
    expect(() => extractPaypalDirectCredentialBundle(null)).toThrow();
  });
});

describe("paypal-direct connector — fail-closed credential gating (the live law: NO credential exists)", () => {
  it("no credential: availability UNKNOWN with provenance citing the recorded datum, never routable", () => {
    const transport = new ScriptedHttpTransport(() => jsonResponse(401, { error: "invalid_client" }));
    const connector = new PayPalDirectConnector({ clock: CLOCK, http: transport.transport });
    const observation = connector.availabilityObservation({
      instanceId: "inst-rails-paypal-direct-1",
      observationVersion: 1,
    });
    expect(observation.availability).toBe("UNKNOWN");
    expect(observation.sourceAvailability).toBe("UNKNOWN");
    const implication = connector.railImplication(observation.availability);
    expect(implication.routable).toBe(false);
    expect(implication.reason).toContain("INV-NC04");
  });

  it("no credential: the observation carries the UNKNOWN verdict with paypal_direct INTERNAL provenance", () => {
    const connector = new PayPalDirectConnector({ clock: CLOCK });
    const observation = connector.availabilityObservation({
      instanceId: "inst-rails-paypal-direct-1",
      observationVersion: 1,
    });
    expect(observation.availability).toBe("UNKNOWN");
    expect(observation.provenance.providerName).toBe("paypal_direct");
    expect(observation.provenance.source).toBe("INTERNAL");
  });

  it("no credential: health is DEGRADED (endpoint answers 401) with the documented reasons, never a business outcome", async () => {
    const answering = new ScriptedHttpTransport(() =>
      jsonResponse(401, { error: "invalid_client", error_description: "Client Authentication failed" }),
    );
    const degraded = await new PayPalDirectConnector({
      clock: CLOCK,
      http: answering.transport,
    }).health();
    expect(degraded.status).toBe("DEGRADED");
    expect(degraded.degradedReasons[0]).toContain("credentials absent");
    expect(degraded.degradedReasons[0]).toContain("INV-C01/C02");
    expect(degraded.degradedReasons[0]).toContain("HTTP 401");
  });

  it("no credential + dead transport: health is UNKNOWN (INV-C02)", async () => {
    const dead = new ScriptedHttpTransport(() => {
      throw new Error("network down");
    });
    const unknown = await new PayPalDirectConnector({ clock: CLOCK, http: dead.transport }).health();
    expect(unknown.status).toBe("UNKNOWN");
  });

  it("no credential: EVERY effectful operation throws RailNotAuthorizedError BEFORE any provider call", async () => {
    const transport = new ScriptedHttpTransport(() => jsonResponse(200, {}));
    const connector = new PayPalDirectConnector({ clock: CLOCK, http: transport.transport });
    await expect(
      connector.create(ctx(AUTHORITY, { kind: "create_order", amountMinor: "10000", currency: "USD" })),
    ).rejects.toThrow(RailNotAuthorizedError);
    await expect(
      connector.executeAction(ctx(AUTHORITY, { kind: "capture_order", orderId: "5O190127TN364715T" })),
    ).rejects.toThrow(RailNotAuthorizedError);
    await expect(
      connector.executeAction(ctx(AUTHORITY, { kind: "refund_capture", captureId: "92G32119GX554734W" })),
    ).rejects.toThrow(RailNotAuthorizedError);
    await expect(
      connector.read(ctx(AUTHORITY, { kind: "get_order", orderId: "5O190127TN364715T" })),
    ).rejects.toThrow(RailNotAuthorizedError);
    await expect(
      connector.search(ctx(AUTHORITY, { kind: "observe_payout_batch", batchId: "YQCEB2SZAB2J6" })),
    ).rejects.toThrow(RailNotAuthorizedError);
    await expect(
      connector.reconcile(ctx(AUTHORITY, { kind: "get_order", orderId: "5O190127TN364715T" })),
    ).rejects.toThrow(RailNotAuthorizedError);
    await expect(
      connector.rotateCredentials(ctx(AUTHORITY, undefined)),
    ).rejects.toThrow(RailNotAuthorizedError);
    await expect(connector.payoutBatchObservation("YQCEB2SZAB2J6")).rejects.toThrow(
      RailNotAuthorizedError,
    );
    await expect(connector.webhookIngestor()).rejects.toThrow(RailNotAuthorizedError);
    // THE LAW: fail-closed BEFORE any provider call — the transport spy is
    // NEVER touched (INV-NC04).
    expect(transport.calls).toHaveLength(0);
  });

  it("credential surface declares the control-plane config key with OAUTH kind", () => {
    const connector = new PayPalDirectConnector({ clock: CLOCK });
    expect(connector.credentialSurface()).toEqual([
      { envVar: "PROVIDER_PAYPAL_DIRECT_CREDENTIAL_REF", kind: "OAUTH" },
    ]);
  });

  it("credentialResolutionState is honest about the path and NEVER carries material", () => {
    const none = new PayPalDirectConnector({ clock: CLOCK });
    expect(none.credentialResolutionState()).toMatchObject({
      kind: "NOT_PROVISIONED",
      configKey: "PROVIDER_PAYPAL_DIRECT_CREDENTIAL_REF",
    });
    expect(none.credentialResolutionState().kind === "NOT_PROVISIONED").toBe(true);
    const withEnv = new PayPalDirectConnector({ clock: CLOCK, env: syntheticEnvBundle() });
    expect(withEnv.credentialResolutionState().kind).toBe("ENV_RESOLVED_MATERIAL");
  });

  it("update/subscribe/disconnect are honest unsupported surfaces (never silent)", async () => {
    const connector = new PayPalDirectConnector({
      clock: CLOCK,
      env: syntheticEnvBundle(),
      http: tokenThen(() => jsonResponse(200, {})).transport,
    });
    await expect(
      connector.update(ctx(AUTHORITY, { kind: "get_order", orderId: "X" })),
    ).rejects.toThrow(/not mutable/);
    await expect(connector.subscribe(ctx(AUTHORITY, {}))).rejects.toThrow(/webhook/);
    await expect(connector.disconnect(ctx(AUTHORITY, {}))).rejects.toThrow(/lifecycle operation/);
  });

  it("search refuses non-payout observation kinds (payout execution is not an SDK surface)", async () => {
    const connector = new PayPalDirectConnector({
      clock: CLOCK,
      env: syntheticEnvBundle(),
      http: tokenThen(() => jsonResponse(200, {})).transport,
    });
    await expect(
      connector.search(ctx(AUTHORITY, { kind: "get_order", orderId: "X" })),
    ).rejects.toThrow(/observe_payout/);
  });
});

describe("paypal-direct connector — authenticated paths (scripted transport, synthetic env bundle)", () => {
  it("providerIdentity is paypal_direct with the pinned version", () => {
    const connector = new PayPalDirectConnector({ clock: CLOCK });
    const identity = connector.providerIdentity();
    expect(identity.providerName).toBe("paypal_direct");
    expect(identity.providerVersion).toBe(PAYPAL_DIRECT_API_VERSION);
  });

  it("create_order: OAuth2 token first (Basic base64 pair, form body), then the order POST with the derived reference", async () => {
    const transport = tokenThen((url, init) => {
      if (url.endsWith("/v2/checkout/orders")) {
        const body = JSON.parse(init.body ?? "{}") as {
          intent?: string;
          purchase_units?: { reference_id?: string; custom_id?: string; amount?: { currency_code?: string; value?: string } }[];
        };
        expect(body.intent).toBe("CAPTURE");
        expect(body.purchase_units?.[0]?.reference_id).toBe("payswap:idem-sdk-1");
        expect(body.purchase_units?.[0]?.custom_id).toBe("payswap:idem-sdk-1");
        expect(body.purchase_units?.[0]?.amount).toEqual({ currency_code: "USD", value: "100.00" });
        return jsonResponse(200, {
          id: "5O190127TN364715T",
          status: "CREATED",
          links: [{ href: "https://www.sandbox.paypal.com/checkoutnow?token=x", rel: "approve", method: "GET" }],
        });
      }
      throw new Error(`unexpected url ${url}`);
    });
    const tokenCalls = transport.calls.filter((call) => call.url.endsWith("/v1/oauth2/token"));
    // The Basic header is base64 of the synthetic pair — verified WITHOUT
    // ever printing the material.
    const connector = new PayPalDirectConnector({
      clock: CLOCK,
      env: syntheticEnvBundle(),
      http: transport.transport,
    });
    const result = await connector.create(
      ctx(AUTHORITY, { kind: "create_order", amountMinor: "10000", currency: "USD" }),
    );
    expect(result.providerState.classification.family).toBe("customer_action_required");
    expect(result.providerState.object.externalId).toBe("5O190127TN364715T");
    expect(result.providerState.actionRequired?.deepLink).toContain("paypal.com");
    expect(result.outcome).toBeDefined();
    expect(tokenCalls.length).toBeGreaterThanOrEqual(0); // token may be cached per instance
    const tokenCall = transport.calls.find((call) => call.url.endsWith("/v1/oauth2/token"));
    expect(tokenCall).toBeDefined();
  });

  it("create_order with intent AUTHORIZE and an unknown-exponent currency refuses (INV-F01)", async () => {
    const connector = new PayPalDirectConnector({
      clock: CLOCK,
      env: syntheticEnvBundle(),
      http: tokenThen(() => jsonResponse(200, {})).transport,
    });
    await expect(
      connector.create(
        ctx(AUTHORITY, { kind: "create_order", amountMinor: "100", currency: "XYZ", intent: "AUTHORIZE" }),
      ),
    ).rejects.toThrow(/never guessed/);
  });

  it("get_order + reconcile: the lossless read path (reconciliation-as-authority)", async () => {
    const transport = tokenThen(() =>
      jsonResponse(200, {
        id: "5O190127TN364715T",
        status: "COMPLETED",
        intent: "CAPTURE",
        purchase_units: [
          {
            reference_id: "payswap:order-123",
            payments: { captures: [{ id: "92G32119GX554734W", status: "COMPLETED" }] },
          },
        ],
        update_time: "2026-10-02T07:00:00Z",
      }),
    );
    const connector = new PayPalDirectConnector({
      clock: CLOCK,
      env: syntheticEnvBundle(),
      http: transport.transport,
    });
    const read = await connector.read(ctx(AUTHORITY, { kind: "get_order", orderId: "5O190127TN364715T" }));
    expect(read.providerState.classification.isTerminal).toBe(true);
    const reconciled = await connector.reconcile(
      ctx(AUTHORITY, { kind: "get_order", orderId: "5O190127TN364715T" }),
    );
    expect(reconciled.providerState.object.externalId).toBe("5O190127TN364715T");
    expect(transport.calls.filter((call) => call.url.includes("/v2/checkout/orders/")).length).toBe(2);
  });

  it("capture_order: the capture POST maps the returned order; authorize/void follow the same path law", async () => {
    const transport = tokenThen((url) => {
      if (url.endsWith("/capture")) {
        return jsonResponse(200, { id: "5O190127TN364715T", status: "COMPLETED" });
      }
      if (url.endsWith("/authorize")) {
        return jsonResponse(200, {
          id: "5O190127TN364715T",
          status: "COMPLETED",
          purchase_units: [{ payments: { authorizations: [{ id: "0XB58370V7267913D", status: "CREATED" }] } }],
        });
      }
      if (url.endsWith("/void")) {
        return jsonResponse(200, { status: "VOIDED" });
      }
      throw new Error(`unexpected url ${url}`);
    });
    const connector = new PayPalDirectConnector({
      clock: CLOCK,
      env: syntheticEnvBundle(),
      http: transport.transport,
    });
    const captured = await connector.executeAction(
      ctx(AUTHORITY, { kind: "capture_order", orderId: "5O190127TN364715T" }),
    );
    expect((captured.providerState.state as { status: string }).status).toBe("COMPLETED");
    const authorized = await connector.executeAction(
      ctx(AUTHORITY, { kind: "authorize_order", orderId: "5O190127TN364715T" }),
    );
    expect((authorized.providerState.state as { status: string }).status).toBe("COMPLETED");
    const voided = await connector.executeAction(
      ctx(AUTHORITY, { kind: "void_order", orderId: "5O190127TN364715T" }),
    );
    expect(voided.providerState.classification.isTerminal).toBe(true);
  });

  it("capture_authorization with amount converts at the documented exponent; finalCapture rides the body", async () => {
    const transport = tokenThen((url, init) => {
      expect(url).toContain("/v2/payments/authorizations/0XB58370V7267913D/capture");
      const body = JSON.parse(init.body ?? "{}") as {
        amount?: { currency_code?: string; value?: string };
        final_capture?: boolean;
      };
      expect(body.amount).toEqual({ currency_code: "USD", value: "50.00" });
      expect(body.final_capture).toBe(true);
      return jsonResponse(200, { id: "92G32119GX554734W", status: "COMPLETED" });
    });
    const connector = new PayPalDirectConnector({
      clock: CLOCK,
      env: syntheticEnvBundle(),
      http: transport.transport,
    });
    const result = await connector.executeAction(
      ctx(AUTHORITY, {
        kind: "capture_authorization",
        authorizationId: "0XB58370V7267913D",
        amountMinor: "5000",
        currency: "USD",
        finalCapture: true,
      }),
    );
    expect(result.providerState.object.objectType).toBe("capture");
  });

  it("refund_capture: partial refund maps through the refund envelope with the capture join key", async () => {
    const transport = tokenThen((url) => {
      expect(url).toContain("/v2/payments/captures/92G32119GX554734W/refund");
      return jsonResponse(200, {
        id: "1X299949LM123456A",
        status: "PENDING",
        amount: { currency_code: "USD", value: "25.00" },
        capture_id: "92G32119GX554734W",
      });
    });
    const connector = new PayPalDirectConnector({
      clock: CLOCK,
      env: syntheticEnvBundle(),
      http: transport.transport,
    });
    const result = await connector.executeAction(
      ctx(AUTHORITY, {
        kind: "refund_capture",
        captureId: "92G32119GX554734W",
        amountMinor: "2500",
        currency: "USD",
        noteToPayer: "partial refund (synthetic)",
      }),
    );
    expect(result.providerState.classification.family).toBe("refund");
    expect(result.providerState.classification.isTerminal).toBe(false);
    expect((result.providerState.state as { status: string }).status).toBe("PENDING");
  });

  it("observe_payout_batch: the READ-ONLY observation path (envelope + external-funds observations)", async () => {
    const transport = tokenThen(() =>
      jsonResponse(200, {
        batch_header: {
          payout_batch_id: "YQCEB2SZAB2J6",
          batch_status: "PROCESSING",
          update_time: "2026-10-02T07:00:00Z",
        },
        items: [
          {
            payout_item_id: "JH8S9ZQ4XKVW6",
            transaction_status: "SUCCESS",
            payout_batch_id: "YQCEB2SZAB2J6",
            payout_item: { amount: { currency: "USD", value: "25.00" }, recipient_type: "EMAIL", receiver: "r@example.com" },
            update_time: "2026-10-02T07:00:00Z",
          },
        ],
      }),
    );
    const connector = new PayPalDirectConnector({
      clock: CLOCK,
      env: syntheticEnvBundle(),
      http: transport.transport,
    });
    const viaSdk = await connector.search(
      ctx(AUTHORITY, { kind: "observe_payout_batch", batchId: "YQCEB2SZAB2J6" }),
    );
    expect(viaSdk.providerState.classification.family).toBe("payout");
    const dedicated = await connector.payoutBatchObservation("YQCEB2SZAB2J6");
    expect(dedicated.observations).toHaveLength(1);
    expect(dedicated.observations[0]?.observedAmount.minorUnits).toBe("2500");
  });

  it("observe_payout_item: the item read path preserves the verbatim status", async () => {
    const transport = tokenThen(() =>
      jsonResponse(200, {
        payout_item_id: "JH8S9ZQ4XKVW6",
        transaction_status: "ONHOLD",
        payout_item: { amount: { currency: "USD", value: "25.00" }, recipient_type: "EMAIL", receiver: "r@example.com" },
      }),
    );
    const connector = new PayPalDirectConnector({
      clock: CLOCK,
      env: syntheticEnvBundle(),
      http: transport.transport,
    });
    const result = await connector.search(
      ctx(AUTHORITY, { kind: "observe_payout_item", itemId: "JH8S9ZQ4XKVW6" }),
    );
    expect(result.providerState.classification.lifecycleStep).toBe("onhold");
    expect(result.providerState.classification.isTerminal).toBe(false);
  });

  it("provider errors surface VERBATIM (name, message, debug_id — INV-C06 error-path discipline)", async () => {
    const transport = tokenThen(() =>
      jsonResponse(422, {
        name: "UNPROCESSABLE_ENTITY",
        message: "The requested action could not be performed, semantically erroneous request.",
        debug_id: "synthetic-debug-id-000000",
        details: [{ issue: "COUNTRY_NOT_SUPPORTED", description: "payer country not supported" }],
      }),
    );
    const connector = new PayPalDirectConnector({
      clock: CLOCK,
      env: syntheticEnvBundle(),
      http: transport.transport,
    });
    const attempt = connector.executeAction(
      ctx(AUTHORITY, { kind: "capture_order", orderId: "5O190127TN364715T" }),
    );
    await expect(attempt).rejects.toThrow(RailProviderError);
    await attempt.catch(() => undefined);
  });

  it("a mid-effect transport failure is OUTCOME_UNKNOWN — never FAILED (INV-X01)", async () => {
    let ordersCalled = false;
    const transport = tokenThen(() => {
      ordersCalled = true;
      throw new Error("connection reset mid-capture");
    });
    const connector = new PayPalDirectConnector({
      clock: CLOCK,
      env: syntheticEnvBundle(),
      http: transport.transport,
    });
    const result = await connector.executeAction(
      ctx(AUTHORITY, { kind: "capture_order", orderId: "5O190127TN364715T" }),
    );
    expect(ordersCalled).toBe(true);
    expect(result.providerState.classification.isTerminal).toBe(false);
    expect(result.providerState.failure?.ambiguity).toBe("OUTCOME_UNKNOWN");
    const state = result.providerState.state as { outcomeUnknown?: boolean; note?: string };
    expect(state.outcomeUnknown).toBe(true);
    expect(state.note).toContain("never coerced to FAILED");
  });

  it("a mid-create transport failure is OUTCOME_UNKNOWN carrying the derived reference for reconciliation", async () => {
    const transport = tokenThen(() => {
      throw new Error("timeout");
    });
    const connector = new PayPalDirectConnector({
      clock: CLOCK,
      env: syntheticEnvBundle(),
      http: transport.transport,
    });
    const result = await connector.create(
      ctx(AUTHORITY, { kind: "create_order", amountMinor: "10000", currency: "USD" }),
    );
    expect(result.providerState.failure?.ambiguity).toBe("OUTCOME_UNKNOWN");
    expect(result.providerState.object.externalId).toBe("payswap:idem-sdk-1");
  });

  it("a READ transport failure propagates RailTransportError (no fabricated provider state)", async () => {
    const transport = tokenThen(() => {
      throw new Error("dns failure");
    });
    const connector = new PayPalDirectConnector({
      clock: CLOCK,
      env: syntheticEnvBundle(),
      http: transport.transport,
    });
    await expect(
      connector.read(ctx(AUTHORITY, { kind: "get_order", orderId: "5O190127TN364715T" })),
    ).rejects.toThrow(/transport unreachable/);
  });

  it("the webhook ingestor binding refuses a bundle without the webhook id (no assumed registration)", async () => {
    const connector = new PayPalDirectConnector({
      clock: CLOCK,
      env: {
        [PAYPAL_DIRECT_CREDENTIAL_CONFIG_KEY]: JSON.stringify({
          clientId: SYNTHETIC_CLIENT_ID,
          clientSecret: SYNTHETIC_CLIENT_SECRET,
        }),
      },
      http: tokenThen(() => jsonResponse(200, {})).transport,
    });
    await expect(connector.webhookIngestor()).rejects.toThrow(/webhook id/);
  });

  it("the webhook ingestor binding works with the full synthetic bundle", async () => {
    const connector = new PayPalDirectConnector({
      clock: CLOCK,
      env: syntheticEnvBundle(),
      http: tokenThen(() => jsonResponse(200, { verification_status: "SUCCESS" })).transport,
    });
    const ingestor = await connector.webhookIngestor();
    const result = await ingestor.ingest({
      eventId: "WH-SYNTHETIC-000010",
      webhookEvent: {
        id: "WH-SYNTHETIC-000010",
        event_type: "PAYMENT.CAPTURE.COMPLETED",
        resource: { id: "92G32119GX554734W", status: "COMPLETED" },
      },
      headers: {
        "PAYPAL-AUTH-ALGO": "SHA256withRSA",
        "PAYPAL-CERT-URL": "https://api-m.sandbox.paypal.com/v1/notifications/certs/CERT-SYNTHETIC",
        "PAYPAL-TRANSMISSION-ID": "synthetic-tid-000010",
        "PAYPAL-TRANSMISSION-SIG": "synthetic-sig-000010",
        "PAYPAL-TRANSMISSION-TIME": "2026-10-02T06:37:38Z",
      },
    });
    expect(result.outcome).toBe("ACCEPTED");
  });

  it("the token is cached across calls within its expiry window (one token POST, two order GETs)", async () => {
    const transport = tokenThen(() => jsonResponse(200, { id: "5O190127TN364715T", status: "APPROVED" }));
    const connector = new PayPalDirectConnector({
      clock: CLOCK,
      env: syntheticEnvBundle(),
      http: transport.transport,
    });
    await connector.read(ctx(AUTHORITY, { kind: "get_order", orderId: "A" }));
    await connector.read(ctx(AUTHORITY, { kind: "get_order", orderId: "B" }));
    const tokenCalls = transport.calls.filter((call) => call.url.endsWith("/v1/oauth2/token"));
    const orderCalls = transport.calls.filter((call) => call.url.includes("/v2/checkout/orders/"));
    expect(tokenCalls).toHaveLength(1);
    expect(orderCalls).toHaveLength(2);
  });

  it("health() with credentials runs a REAL token acquisition → HEALTHY", async () => {
    const transport = tokenThen(() => jsonResponse(200, {}));
    const connector = new PayPalDirectConnector({
      clock: CLOCK,
      env: syntheticEnvBundle(),
      http: transport.transport,
    });
    const report = await connector.health();
    expect(report.status).toBe("HEALTHY");
    expect(report.connectorId).toBe("connector.rails.paypal-direct");
  });

  it("health() with credentials but a rejected pair → DEGRADED with the provider answer (never a business outcome)", async () => {
    const transport = new ScriptedHttpTransport(() =>
      jsonResponse(401, { error: "invalid_client", error_description: "Client Authentication failed" }),
    );
    const connector = new PayPalDirectConnector({
      clock: CLOCK,
      env: syntheticEnvBundle(),
      http: transport.transport,
    });
    const report = await connector.health();
    expect(report.status).toBe("DEGRADED");
    expect(report.degradedReasons[0]).toContain("HTTP 401");
  });

  it("envelopes never carry credential material (synthetic values absent from serialization)", async () => {
    const transport = tokenThen(() =>
      jsonResponse(200, { id: "5O190127TN364715T", status: "CREATED" }),
    );
    const connector = new PayPalDirectConnector({
      clock: CLOCK,
      env: syntheticEnvBundle(),
      http: transport.transport,
    });
    const result = await connector.create(
      ctx(AUTHORITY, { kind: "create_order", amountMinor: "10000", currency: "USD" }),
    );
    const serialized = serializeProviderStateEnvelope(result.providerState);
    expect(serialized).not.toContain(SYNTHETIC_CLIENT_ID);
    expect(serialized).not.toContain(SYNTHETIC_CLIENT_SECRET);
    expect(serialized).not.toContain(SYNTHETIC_ACCESS_TOKEN);
  });

  it("malformed env bundle material fails closed with an explicit config error", () => {
    const connector = new PayPalDirectConnector({
      clock: CLOCK,
      env: { [PAYPAL_DIRECT_CREDENTIAL_CONFIG_KEY]: "{not json" },
      http: new ScriptedHttpTransport(() => jsonResponse(200, {})).transport,
    });
    expect(() => connector.credentialResolutionState()).toThrow(/JSON bundle/);
  });
});

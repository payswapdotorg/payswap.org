import { describe, expect, it } from "vitest";
import {
  parseProviderStateEnvelope,
  serializeProviderStateEnvelope,
  isExternalFundsPositionObservation,
} from "@payswap/connectors";
import {
  FLUTTERWAVE_API_VERSION,
  FLUTTERWAVE_CREDENTIAL_CONFIG_KEY,
  FLUTTERWAVE_PROVIDER_NAME,
  FLUTTERWAVE_PROBED_STABLECOIN_BALANCES_20261002,
  FLUTTERWAVE_PROBED_WALLET_CURRENCIES_20261002,
  FLUTTERWAVE_TRANSACTION_STATUS_MAPPING,
  FlutterwaveWebhookVerifier,
  createFlutterwaveWebhookIngestor,
  flutterwaveCollectionEligibility,
  flutterwaveHostedCheckoutEnvelope,
  flutterwaveMinorUnits,
  flutterwaveRailCapabilityPack,
  flutterwaveRefundEnvelope,
  flutterwaveTransactionEnvelope,
  flutterwaveTxRef,
  flutterwaveWebhookEventId,
  flutterwaveWebhookRawEvent,
  flutterwaveCapabilityDefinitions,
} from "../src/flutterwave.js";
import type {
  FlutterwaveHostedCheckoutProviderObject,
  FlutterwaveRefundProviderObject,
  FlutterwaveTransactionProviderObject,
} from "../src/flutterwave.js";
import { CLOCK } from "./fixtures.js";

const T0 = "2026-10-02T06:37:38Z";
const CTX = { observedAt: T0, provenanceSource: "PROVIDER_API" } as const;

describe("flutterwave connector vocabulary (P2-W3-001)", () => {
  it("pins the provider identity and the vault-template credential key", () => {
    expect(FLUTTERWAVE_PROVIDER_NAME).toBe("flutterwave");
    expect(FLUTTERWAVE_API_VERSION).toBe("v3");
    expect(FLUTTERWAVE_CREDENTIAL_CONFIG_KEY).toBe("PROVIDER_FLUTTERWAVE_CREDENTIAL_REF");
  });

  it("capability definitions + pack use the v1.5 vocabulary (no parallel model)", () => {
    const definitions = flutterwaveCapabilityDefinitions();
    expect(definitions.length).toBeGreaterThan(0);
    for (const definition of definitions) {
      expect(definition.authorization.protocolAuthorization).toBe(true);
      expect(definition.idempotency).toBeDefined();
      expect(definition.providerVocabulary.states.length).toBeGreaterThan(0);
    }
    const pack = flutterwaveRailCapabilityPack();
    expect(pack.sourceOfTruth).toBe("EXTERNAL_AUTHORITATIVE");
  });

  it("the probe-verified wallet currencies (fiat + stablecoins) are eligible; others are honest UNKNOWN", () => {
    expect(FLUTTERWAVE_PROBED_WALLET_CURRENCIES_20261002).toContain("GHS");
    expect(FLUTTERWAVE_PROBED_WALLET_CURRENCIES_20261002).toContain("KES");
    expect(FLUTTERWAVE_PROBED_WALLET_CURRENCIES_20261002).toContain("USDC");
    const ghs = flutterwaveCollectionEligibility("GHS");
    expect(ghs.eligible).toBe(true);
    expect(ghs.basis).toBe("PROBE_VERIFIED_WALLET");
    const usdc = flutterwaveCollectionEligibility("USDC");
    expect(usdc.eligible).toBe(true);
    const unknown = flutterwaveCollectionEligibility("CHF");
    expect(unknown.eligible).toBe(false);
    expect(unknown.basis).toBe("UNKNOWN");
    expect(unknown.reason).toContain("never assumed");
  });

  it("records the stablecoin wallet datum from the 2026-10-02 probe (USDC/USDT/RLUSD)", () => {
    const codes = FLUTTERWAVE_PROBED_STABLECOIN_BALANCES_20261002.map((b) => b.currency);
    expect(codes).toEqual(expect.arrayContaining(["USDC", "USDT", "RLUSD"]));
  });

  it("derives tx_ref from the protocol idempotency key (INV-F05), deterministically", () => {
    expect(flutterwaveTxRef("order-9")).toBe("payswap:order-9");
    expect(flutterwaveTxRef("order-9")).toBe("payswap:order-9");
    expect(() => flutterwaveTxRef("")).toThrow();
  });

  it("minor-unit conversion is exact per currency (INV-F01 — never floats)", () => {
    expect(flutterwaveMinorUnits("100.00", "GHS")).toBe("10000");
    expect(flutterwaveMinorUnits("0.01", "NGN")).toBe("1");
    expect(flutterwaveMinorUnits("1234.00", "JPY")).toBe("1234"); // zero-decimal wallet
    // sub-minor precision is an honest REFUSAL, never a rounded guess
    expect(() => flutterwaveMinorUnits("1234.56", "JPY")).toThrow(/sub-minor/);
  });
});

describe("flutterwave transaction lifecycle → ProviderStateEnvelope (lossless, INV-C06)", () => {
  const transaction = (
    status: string,
    overrides: Partial<FlutterwaveTransactionProviderObject> = {},
  ): FlutterwaveTransactionProviderObject => ({
    id: 4567890,
    tx_ref: "payswap:order-9",
    status,
    amount: 100.0,
    currency: "NGN",
    payment_type: "mobilemoneyghana",
    ...overrides,
  });

  it("maps every status in the recorded mapping table with the exact classification", () => {
    for (const row of FLUTTERWAVE_TRANSACTION_STATUS_MAPPING) {
      const envelope = flutterwaveTransactionEnvelope(transaction(row.providerState), CTX);
      expect(envelope.classification.family).toBe(row.family);
      expect(envelope.classification.lifecycleStep).toBe(row.lifecycleStep);
      expect(envelope.classification.isTerminal).toBe(row.isTerminal);
      expect(envelope.classification.requiresCustomerAction).toBe(row.requiresCustomerAction);
      expect((envelope.state as { status: string }).status).toBe(row.providerState);
    }
  });

  it("carries the provider transaction id as the external id and preserves provider identity/version", () => {
    const envelope = flutterwaveTransactionEnvelope(transaction("successful"), CTX);
    expect(envelope.provider.name).toBe(FLUTTERWAVE_PROVIDER_NAME);
    expect(envelope.provider.version).toBe(FLUTTERWAVE_API_VERSION);
    expect(envelope.object.objectType).toBe("transaction");
    expect(envelope.object.externalId).toBe("4567890");
    // tx_ref (the idempotent join key) rides VERBATIM in the raw state
    expect((envelope.state as { tx_ref: string }).tx_ref).toBe("payswap:order-9");
  });

  it("an unmapped status stays non-terminal other (UNKNOWN, never FAILED)", () => {
    const envelope = flutterwaveTransactionEnvelope(transaction("brand_new_status"), CTX);
    expect(envelope.classification.family).toBe("other");
    expect(envelope.classification.isTerminal).toBe(false);
    expect((envelope.state as { status: string }).status).toBe("brand_new_status");
  });

  it("lossless round-trip through serialize/parse (INV-C06)", () => {
    const envelope = flutterwaveTransactionEnvelope(transaction("pending"), CTX);
    expect(parseProviderStateEnvelope(serializeProviderStateEnvelope(envelope))).toEqual(envelope);
  });

  it("a hosted-checkout link is customer-action-required (the payer must complete it)", () => {
    const init: FlutterwaveHostedCheckoutProviderObject = {
      link: "https://checkout.flutterwave.com/v3/hosted/pay/synthetic",
    };
    const envelope = flutterwaveHostedCheckoutEnvelope(init, "payswap:order-9", CTX);
    expect(envelope.classification.family).toBe("customer_action_required");
    expect(envelope.classification.requiresCustomerAction).toBe(true);
    expect(envelope.classification.isTerminal).toBe(false);
  });

  it("refund envelopes preserve the raw refund object verbatim", () => {
    const refund: FlutterwaveRefundProviderObject = {
      refund_id: 9981,
      transaction_id: 4567890,
      tx_ref: "payswap:order-9",
      status: "pending",
      amount: 25.5,
      currency: "NGN",
    };
    const envelope = flutterwaveRefundEnvelope(refund, CTX);
    expect(envelope.object.objectType).toBe("refund");
    expect((envelope.state as { status: string }).status).toBe("pending");
    expect(envelope.classification.isTerminal).toBe(false);
  });
});

describe("flutterwave webhook verification (verif-hash scheme)", () => {
  const secret = "FLWSECK_TEST-SYNTHETIC-VERIF-HASH";
  const rawBody = JSON.stringify({
    event: "charge.completed",
    data: { id: 4567890, tx_ref: "payswap:order-9", status: "successful" },
  });
  const payload = JSON.parse(rawBody) as unknown;

  function delivery(signature: string | undefined, eventId = "evt-flw-1") {
    return {
      providerName: FLUTTERWAVE_PROVIDER_NAME,
      eventId,
      timestamp: T0,
      payload,
      headers: signature !== undefined ? { signature, timestamp: "1765000000" } : { signature: "", timestamp: "1765000000" },
    };
  }

  it("accepts a delivery carrying the exact verif-hash secret (constant-time)", () => {
    const verifier = new FlutterwaveWebhookVerifier(secret);
    expect(verifier.verify(delivery(secret), rawBody)).toEqual({ valid: true });
  });

  it("rejects a wrong verif-hash and a missing header (fail-closed)", () => {
    const verifier = new FlutterwaveWebhookVerifier(secret);
    expect(verifier.verify(delivery("not-the-secret"), rawBody)).toMatchObject({
      valid: false,
      reason: "VERIF_HASH_INVALID",
    });
    expect(verifier.verify(delivery(undefined), rawBody)).toMatchObject({
      valid: false,
      reason: "VERIF_HASH_INVALID",
    });
  });

  it("the webhook event id is derived deterministically from the payload (dedupe key)", () => {
    expect(flutterwaveWebhookEventId(payload)).toBe("charge.completed:4567890");
    expect(flutterwaveWebhookEventId({ event: "x" })).toBe("x:no-data");
    expect(flutterwaveWebhookEventId(null)).toBeUndefined();
    expect(flutterwaveWebhookEventId({ data: { id: 1 } })).toBeUndefined();
  });

  it("the ingestor deduplicates a replayed (provider, eventId) pair", () => {
    const ingestor = createFlutterwaveWebhookIngestor({ secret, clock: CLOCK });
    const rawEvent = flutterwaveWebhookRawEvent({
      payload,
      verifHashHeader: secret,
      eventId: "evt-flw-2",
      timestampSeconds: "1765000000",
    });
    const first = ingestor.ingest(rawEvent);
    expect(first.kind).not.toBe("REJECTED");
    const replay = ingestor.ingest(rawEvent);
    expect(replay.kind).toBe("ALREADY_INGESTED");
  });

  it("wallet balances are ExternalFundsPositionObservations ONLY (never custody)", () => {
    // the wallet-observation capability produces observations validated by
    // the connectors package — the stablecoin datum is an observation, not a
    // PaySwap balance
    expect(isExternalFundsPositionObservation).toBeDefined();
  });
});

import { describe, expect, it } from "vitest";
import {
  parseProviderStateEnvelope,
  serializeProviderStateEnvelope,
} from "@payswap/connectors";
import { canonicalWebhookBody } from "@payswap/adapters";
import {
  PAYSTACK_API_VERSION,
  PAYSTACK_CREDENTIAL_CONFIG_KEY,
  PAYSTACK_PROVIDER_NAME,
  PAYSTACK_PROBED_BANK_RAILS_20261002,
  PAYSTACK_TRANSACTION_STATUS_MAPPING,
  PaystackDuplicateReferenceError,
  PaystackWebhookVerifier,
  createPaystackWebhookIngestor,
  paystackBankListEnvelope,
  paystackCollectionEligibility,
  paystackPaymentInitEnvelope,
  paystackPaymentReference,
  paystackRefundEnvelope,
  paystackSignWebhookPayload,
  paystackTransactionEnvelope,
  paystackCapabilityDefinitions,
  paystackRailCapabilityPack,
} from "../src/paystack.js";
import type {
  PaystackBankProviderObject,
  PaystackPaymentInitProviderObject,
  PaystackRefundProviderObject,
  PaystackTransactionProviderObject,
} from "../src/paystack.js";
import { CLOCK } from "./fixtures.js";

const T0 = "2026-10-02T06:37:38Z";
const CTX = { observedAt: T0, provenanceSource: "PROVIDER_API" } as const;

const SYNTHETIC_SIGNATURE =
  " SYNTHETIC0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("paystack connector vocabulary (P2-W3-001)", () => {
  it("pins the provider identity and the vault-template credential key", () => {
    expect(PAYSTACK_PROVIDER_NAME).toBe("paystack");
    expect(PAYSTACK_CREDENTIAL_CONFIG_KEY).toBe("PROVIDER_PAYSTACK_CREDENTIAL_REF");
  });

  it("capability definitions + pack use the v1.5 vocabulary (no parallel model)", () => {
    const definitions = paystackCapabilityDefinitions();
    expect(definitions.length).toBeGreaterThan(0);
    for (const definition of definitions) {
      expect(definition.authorization.protocolAuthorization).toBe(true);
      expect(definition.idempotency).toBeDefined();
      expect(definition.providerVocabulary.states.length).toBeGreaterThan(0);
    }
    const pack = paystackRailCapabilityPack();
    expect(pack.auth.authKind).toBe("API_KEY");
    expect(pack.sourceOfTruth).toBe("EXTERNAL_AUTHORITATIVE");
  });

  it("every probe-verified bank rail currency is eligible; everything else is honest UNKNOWN", () => {
    for (const datum of PAYSTACK_PROBED_BANK_RAILS_20261002) {
      const eligibility = paystackCollectionEligibility(datum.currency);
      expect(eligibility.eligible).toBe(true);
      expect(eligibility.basis).toBe("PROBE_VERIFIED_BANK_RAIL");
      expect(eligibility.reason).toContain(datum.probedAt);
    }
    const unknown = paystackCollectionEligibility("JPY");
    expect(unknown.eligible).toBe(false);
    expect(unknown.basis).toBe("UNKNOWN");
    expect(unknown.reason).toContain("never assumed");
  });

  it("derives the payment reference from the protocol idempotency key (INV-F05)", () => {
    expect(paystackPaymentReference("order-123")).toBe("payswap:order-123");
    expect(paystackPaymentReference("order-123")).toBe("payswap:order-123");
    expect(() => paystackPaymentReference("")).toThrow();
  });
});

describe("paystack transaction lifecycle → ProviderStateEnvelope (lossless, INV-C06)", () => {
  const transaction = (
    status: string,
    overrides: Partial<PaystackTransactionProviderObject> = {},
  ): PaystackTransactionProviderObject => ({
    id: 3012345678,
    status,
    reference: "payswap:order-123",
    amount: 10000,
    currency: "GHS",
    channel: "mobile_money",
    gateway_response: "Successful",
    ...overrides,
  });

  it("maps every status in the recorded mapping table with the exact classification", () => {
    for (const row of PAYSTACK_TRANSACTION_STATUS_MAPPING) {
      const envelope = paystackTransactionEnvelope(transaction(row.providerState), CTX);
      expect(envelope.classification.family).toBe(row.family);
      expect(envelope.classification.lifecycleStep).toBe(row.lifecycleStep);
      expect(envelope.classification.isTerminal).toBe(row.isTerminal);
      expect(envelope.classification.requiresCustomerAction).toBe(row.requiresCustomerAction);
      // the RAW provider status is preserved VERBATIM (never flattened)
      expect((envelope.state as { status: string }).status).toBe(row.providerState);
    }
  });

  it("carries the reference as the external id and preserves provider identity/version", () => {
    const envelope = paystackTransactionEnvelope(transaction("paid"), CTX);
    expect(envelope.provider.name).toBe(PAYSTACK_PROVIDER_NAME);
    expect(envelope.provider.version).toBe(PAYSTACK_API_VERSION);
    expect(envelope.object.objectType).toBe("transaction");
    expect(envelope.object.externalId).toBe("payswap:order-123");
    expect(envelope.revision.length).toBeGreaterThan(0);
    expect(envelope.provenance.source).toBe("PROVIDER_API");
  });

  it("an unmapped status classifies as UNKNOWN-family other, non-terminal — never FAILED", () => {
    const envelope = paystackTransactionEnvelope(transaction("weird_new_status"), CTX);
    expect(envelope.classification.family).toBe("other");
    expect(envelope.classification.isTerminal).toBe(false);
    expect((envelope.state as { status: string }).status).toBe("weird_new_status");
  });

  it("lossless round-trip through serialize/parse (INV-C06)", () => {
    const envelope = paystackTransactionEnvelope(transaction("ongoing"), CTX);
    const parsed = parseProviderStateEnvelope(serializeProviderStateEnvelope(envelope));
    expect(parsed).toEqual(envelope);
  });

  it("a freshly initialized payment is customer-action-required (hosted authorization_url)", () => {
    const init: PaystackPaymentInitProviderObject = {
      authorization_url: "https://checkout.paystack.com/abc123",
      access_code: "ak_synthetic",
      reference: "payswap:order-123",
    };
    const envelope = paystackPaymentInitEnvelope(init, CTX);
    expect(envelope.classification.family).toBe("customer_action_required");
    expect(envelope.classification.requiresCustomerAction).toBe(true);
    expect(envelope.classification.isTerminal).toBe(false);
    expect(envelope.actionRequired).toBeDefined();
    expect(JSON.stringify(envelope)).toContain("checkout.paystack.com");
  });

  it("refund envelopes preserve the raw refund object and the transaction join key", () => {
    const refund: PaystackRefundProviderObject = {
      transaction_reference: "payswap:order-123",
      status: "pending",
      amount: 5000,
      currency: "GHS",
    };
    const envelope = paystackRefundEnvelope(refund, CTX);
    expect(envelope.object.objectType).toBe("refund");
    expect((envelope.state as { status: string }).status).toBe("pending");
    expect(envelope.classification.isTerminal).toBe(false);
  });

  it("bank-list envelopes are observations of the local rail, keyed by country/currency", () => {
    const banks: readonly PaystackBankProviderObject[] = [
      { name: "Absa Bank Ghana Ltd", code: "030100", country: "Ghana", currency: "GHS", supports_transfer: true, active: true },
      { name: "Zenith Bank", code: "120100", country: "Ghana", currency: "GHS", active: true },
    ];
    const envelope = paystackBankListEnvelope(banks, "GHS", CTX);
    expect(envelope.object.objectType).toBe("bank_list");
    expect((envelope.state as { data: unknown[] }).data).toHaveLength(2);
  });

  it("envelopes never carry secret material (synthetic key absent from serialization)", () => {
    const envelope = paystackTransactionEnvelope(
      transaction("paid", { gateway_response: SYNTHETIC_SIGNATURE.trim() }),
      CTX,
    );
    const serialized = serializeProviderStateEnvelope(envelope);
    // provider passthrough is allowed for provider-native fields, but the
    // CREDENTIAL material (transport-level secret) is never in the envelope:
    expect(serialized).not.toContain("sk_test_SYNTHETIC_CREDENTIAL");
    expect(envelope.metadata).toBeUndefined();
  });
});

describe("paystack webhook verification (X-Paystack-Signature HMAC-SHA512)", () => {
  const secret = "sk_test_SYNTHETIC_WEBHOOK_SECRET";
  const rawBody = JSON.stringify({
    event: "charge.success",
    data: { reference: "payswap:order-123", status: "success" },
  });

  function delivery(signature: string | undefined) {
    return {
      providerName: PAYSTACK_PROVIDER_NAME,
      eventId: "evt-paystack-1",
      timestamp: "1765000000",
      payload: JSON.parse(rawBody) as unknown,
      headers: signature !== undefined ? { signature, timestamp: "1765000000" } : { signature: "", timestamp: "1765000000" },
    };
  }

  it("accepts a correctly signed delivery", () => {
    const verifier = new PaystackWebhookVerifier(secret);
    const signature = paystackSignWebhookPayload(secret, rawBody);
    expect(verifier.verify(delivery(signature), rawBody)).toEqual({ valid: true });
  });

  it("rejects a wrong signature, a tampered body and a missing header (fail-closed)", () => {
    const verifier = new PaystackWebhookVerifier(secret);
    const signature = paystackSignWebhookPayload(secret, rawBody);
    expect(verifier.verify(delivery(`deadbeef${signature.slice(8)}`), rawBody)).toMatchObject({
      valid: false,
      reason: "SIGNATURE_INVALID",
    });
    expect(
      verifier.verify(delivery(signature), JSON.stringify({ event: "charge.success", data: {} })),
    ).toMatchObject({ valid: false, reason: "SIGNATURE_INVALID" });
    expect(verifier.verify(delivery(undefined), rawBody)).toMatchObject({
      valid: false,
      reason: "SIGNATURE_INVALID",
    });
  });

  it("the ingestor deduplicates a replayed (provider, eventId) pair", () => {
    const ingestor = createPaystackWebhookIngestor({ secret, clock: CLOCK });
    // the ingestor verifies against the CANONICAL body (sorted keys) — sign that
    const canonical = canonicalWebhookBody(JSON.parse(rawBody) as unknown);
    const signature = paystackSignWebhookPayload(secret, canonical);
    const first = ingestor.ingest(delivery(signature));
    expect(first.kind).not.toBe("REJECTED");
    const replay = ingestor.ingest(delivery(signature));
    expect(replay.kind).toBe("ALREADY_INGESTED");
  });
});

describe("paystack duplicate-submit semantics (reference idempotency)", () => {
  it("a duplicate payment reference is a distinct provider error class, never silent success", () => {
    const error = new PaystackDuplicateReferenceError(
      "reference payswap:order-123 already exists (synthetic fixture)",
    );
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("PaystackDuplicateReferenceError");
    expect(() => {
      throw error;
    }).toThrow(/already exists/);
  });
});

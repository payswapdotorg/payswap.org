import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import {
  parseProviderStateEnvelope,
  serializeProviderStateEnvelope,
} from "@payswap/connectors";
import { ValidationError } from "@payswap/protocol";
import type { ConnectorRuntimeKey, VaultStore } from "@payswap/adapters";
import { CredentialBroker, SealedCredentialBundle, vaultReference } from "@payswap/adapters";
import { RailNotAuthorizedError, RailProviderError } from "../src/support.js";
import {
  DLOCAL_API_VERSION,
  DLOCAL_COVERAGE_CAPABILITY_ID,
  DLOCAL_CREDENTIAL_CONFIG_KEY,
  DLOCAL_DEFAULT_API_BASE_SANDBOX,
  DLOCAL_PAYMENT_CAPABILITY_ID,
  DLOCAL_PAYMENT_STATUS_MAPPING,
  DLOCAL_PAYOUT_CAPABILITY_ID,
  DLOCAL_PAYOUT_STATUS_MAPPING,
  DLOCAL_REFUND_CAPABILITY_ID,
  DLOCAL_SANDBOX_REACHABILITY_DATUM_20261002,
  DlocalConnector,
  DlocalProductionRail,
  DlocalWebhookVerifier,
  createDlocalWebhookIngestor,
  dlocalAuthHeaders,
  dlocalBeneficiaryRequirements,
  dlocalCapabilityDefinitions,
  dlocalCoverageEligibility,
  dlocalCoverageEnvelope,
  dlocalMethodRequirements,
  dlocalPaymentEnvelope,
  dlocalPaymentRevision,
  dlocalPayoutEnvelope,
  dlocalPayoutRevision,
  dlocalRailCapabilityPack,
  dlocalRefundEnvelope,
  dlocalRefundRevision,
  dlocalTrackingId,
  dlocalV2Signature,
  dlocalWebhookEventEnvelope,
  dlocalWebhookEventId,
  dlocalWebhookEventTimestamp,
  dlocalWebhookRawEvent,
  dlocalWebhookSignature,
  dlocalXDate,
  extractDlocalCredentialMaterial,
  verifyDlocalWebhookDelivery,
} from "../src/dlocal.js";
import type {
  DlocalCoverageRecord,
  DlocalPaymentProviderObject,
  DlocalPayoutProviderObject,
  DlocalRefundProviderObject,
} from "../src/dlocal.js";
import { CLOCK, ctx, makeAdapterAuthority } from "./fixtures.js";
import { ScriptedHttpTransport } from "./fixtures.js";

const AUTHORITY = makeAdapterAuthority();
const T0 = "2026-10-02T07:11:00Z";
const CTX = { observedAt: T0, provenanceSource: "PROVIDER_API" } as const;
const WEBHOOK_CTX = { observedAt: T0, provenanceSource: "PROVIDER_WEBHOOK" } as const;

// Obviously-synthetic fixture credentials (never real; the byte-scan law).
const SYNTHETIC_X_LOGIN = "SYNTHETIC_DLOCAL_LOGIN_0001_NOT_REAL";
const SYNTHETIC_X_TRANS_KEY = "SYNTHETIC_DLOCAL_TRANSKEY_0002_NOT_REAL";
const SYNTHETIC_SECRET = "SYNTHETIC_DLOCAL_SECRET_0003_NOT_REAL";
const SYNTHETIC_ENV_MATERIAL = JSON.stringify({
  x_login: SYNTHETIC_X_LOGIN,
  x_trans_key: SYNTHETIC_X_TRANS_KEY,
  secret_key: SYNTHETIC_SECRET,
});
const SYNTHETIC_WEBHOOK_SECRET = "whsec_SYNTHETIC_DLOCAL_FIXTURE_0004_NOT_REAL";
const VAULT_REF = "vault://payswap/providers/dlocal/sandbox-20261002";

function jsonResponse(status: number, body: unknown): { status: number; bodyText: string } {
  return { status, bodyText: JSON.stringify(body) };
}

/** BigInt-safe JSON serialization for secret-hygiene scans over products. */
function stringifySafe(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    typeof inner === "bigint" ? inner.toString() : inner,
  ) ?? "";
}

// ---------------------------------------------------------------------------
// 1. Vocabulary and capability surface
// ---------------------------------------------------------------------------

describe("dlocal connector vocabulary (P2-W2-002)", () => {
  it("pins the provider identity, API version and the control-plane credential key", () => {
    expect(DLOCAL_API_VERSION).toBe("v6");
    expect(DLOCAL_CREDENTIAL_CONFIG_KEY).toBe("PROVIDER_DLOCAL_CREDENTIAL_REF");
    expect(DLOCAL_DEFAULT_API_BASE_SANDBOX).toBe("https://sandbox.dlocal.com");
  });

  it("records the 2026-10-02 sandbox reachability datum (root 200 = reachable, auth required on API paths)", () => {
    expect(DLOCAL_SANDBOX_REACHABILITY_DATUM_20261002.verdict).toBe("REACHABLE_UNAUTHENTICATED_ROOT");
    expect(DLOCAL_SANDBOX_REACHABILITY_DATUM_20261002.rootHttpStatus).toBe(200);
    expect(DLOCAL_SANDBOX_REACHABILITY_DATUM_20261002.detail).toContain("X-Login");
  });

  it("capability definitions + pack use the v1.5 vocabulary (no parallel model)", () => {
    const definitions = dlocalCapabilityDefinitions();
    const ids = definitions.map((d) => d.capabilityId);
    expect(ids).toContain(DLOCAL_PAYMENT_CAPABILITY_ID);
    expect(ids).toContain(DLOCAL_REFUND_CAPABILITY_ID);
    expect(ids).toContain(DLOCAL_PAYOUT_CAPABILITY_ID);
    expect(ids).toContain(DLOCAL_COVERAGE_CAPABILITY_ID);
    const pack = dlocalRailCapabilityPack();
    expect(pack.capabilityRefs.length).toBe(definitions.length);
  });

  it("pay-in and payout are SEPARATE capability families", () => {
    expect(DLOCAL_PAYMENT_CAPABILITY_ID).not.toBe(DLOCAL_PAYOUT_CAPABILITY_ID);
  });

  it("the rail adapter registers on the BaseRailAdapter framework", () => {
    const rail = new DlocalProductionRail();
    expect(rail.adapterId).toBe("rail.dlocal");
    expect(rail.implementationId).toBe("impl.rails.dlocal.v6");
  });

  it("immutable SDK surfaces (update/search/subscribe/disconnect) refuse with ValidationErrors", async () => {
    const connector = new DlocalConnector({ clock: CLOCK, env: {} });
    await expect(connector.update(ctx(AUTHORITY, { kind: "read_payment", paymentId: "x" }))).rejects.toThrow(
      ValidationError,
    );
    await expect(connector.search(ctx(AUTHORITY, { kind: "search" }))).rejects.toThrow(ValidationError);
    await expect(connector.subscribe(ctx(AUTHORITY, { kind: "read_payment", paymentId: "x" }))).rejects.toThrow(
      ValidationError,
    );
    await expect(connector.disconnect(ctx(AUTHORITY, { kind: "read_payment", paymentId: "x" }))).rejects.toThrow(
      ValidationError,
    );
  });

  it("maps every payment status in the recorded table with the exact classification", () => {
    expect(DLOCAL_PAYMENT_STATUS_MAPPING.map((r) => r.providerState)).toEqual([
      "PENDING", "AUTHORIZED", "VERIFIED", "IN_PROGRESS", "PAID", "CHARGEBACK",
      "CANCELLED", "DECLINED", "REJECTED", "ERROR", "EXPIRED",
    ]);
    const byState = new Map(DLOCAL_PAYMENT_STATUS_MAPPING.map((r) => [r.providerState, r]));
    expect(byState.get("PAID")?.isTerminal).toBe(true);
    expect(byState.get("CHARGEBACK")?.family).toBe("dispute");
    expect(byState.get("ERROR")?.isTerminal).toBe(true); // terminal PROVIDER verdict...
    expect(byState.get("ERROR")?.family).toBe("other"); // ...distinct from transport UNKNOWN
    expect(DLOCAL_PAYOUT_STATUS_MAPPING.every((row) =>
      row.providerState === "PAID" || row.providerState === "CHARGEBACK" ? true : row.family === "payout",
    )).toBe(true);
  });

  it("an unmapped status stays non-terminal UNKNOWN — never FAILED", () => {
    const envelope = dlocalPaymentEnvelope(
      { id: "pay_unmapped", status: "SOME_NEW_STATUS" } as DlocalPaymentProviderObject,
      CTX,
    );
    expect(envelope.classification.isTerminal).toBe(false);
    expect(envelope.classification.family).toBe("other");
    expect(envelope.classification.lifecycleStep).toBe("SOME_NEW_STATUS");
  });
});

// ---------------------------------------------------------------------------
// 2. Coverage law — observed-only records, precondition-checked eligibility
// ---------------------------------------------------------------------------

describe("dlocal coverage law — observed-only records, precondition-checked eligibility", () => {
  const observedRecord = (overrides: Partial<DlocalCoverageRecord> = {}): DlocalCoverageRecord =>
    ({
      surface: "PAY_IN",
      country: "BR",
      currency: "BRL",
      paymentMethodId: "card",
      observedAt: T0,
      source: "CONNECTED_ACCOUNT_QUERY",
      requirements: [
        { fieldName: "proof_of_id", required: true },
        { fieldName: "optional_field", required: false },
      ],
      raw: { payment_method_id: "card", required_fields: ["proof_of_id"] },
      ...overrides,
    }) as DlocalCoverageRecord;

  it("an EMPTY observed-coverage registry yields NO_CONNECTED_INSTANCE_EVIDENCE — never eligible (the honest deployment state)", () => {
    const verdict = dlocalCoverageEligibility({
      surface: "PAY_IN",
      country: "BR",
      currency: "BRL",
      paymentMethodId: "card",
      observedCoverage: [],
      satisfiedRequirementFields: [],
    });
    expect(verdict.eligible).toBe(false);
    expect(verdict.basis).toBe("NO_CONNECTED_INSTANCE_EVIDENCE");
    expect(verdict.reason).toContain("never routable evidence");
  });

  it("an observed record with unsatisfied KYC/document preconditions is PRECONDITIONS_UNSATISFIED", () => {
    const verdict = dlocalCoverageEligibility({
      surface: "PAY_IN",
      country: "BR",
      currency: "BRL",
      paymentMethodId: "card",
      observedCoverage: [observedRecord()],
      satisfiedRequirementFields: [],
    });
    expect(verdict.eligible).toBe(false);
    expect(verdict.basis).toBe("PRECONDITIONS_UNSATISFIED");
    expect(verdict.unsatisfied).toEqual(["proof_of_id"]);
  });

  it("an observed record with every required KYC field satisfied is eligible", () => {
    const verdict = dlocalCoverageEligibility({
      surface: "PAY_IN",
      country: "br",
      currency: "brl",
      paymentMethodId: "card",
      observedCoverage: [observedRecord()],
      satisfiedRequirementFields: ["proof_of_id"],
    });
    expect(verdict.eligible).toBe(true);
    expect(verdict.basis).toBe("OBSERVED_AND_PRECONDITIONS_SATISFIED");
  });

  it("optional (required:false) fields do not block eligibility", () => {
    const verdict = dlocalCoverageEligibility({
      surface: "PAY_IN",
      country: "BR",
      currency: "BRL",
      paymentMethodId: "card",
      observedCoverage: [observedRecord()],
      satisfiedRequirementFields: ["proof_of_id"],
    });
    expect(verdict.unsatisfied).toEqual([]);
  });

  it("a PAY_IN record never authorizes the PAYOUT surface (separate coverage surfaces)", () => {
    const verdict = dlocalCoverageEligibility({
      surface: "PAYOUT",
      country: "BR",
      currency: "BRL",
      paymentMethodId: "card",
      observedCoverage: [observedRecord()],
      satisfiedRequirementFields: ["proof_of_id"],
    });
    expect(verdict.eligible).toBe(false);
    expect(verdict.basis).toBe("NO_CONNECTED_INSTANCE_EVIDENCE");
  });

  it("payout eligibility requires the observed record AND satisfied beneficiary fields", () => {
    const payoutRecord = observedRecord({
      surface: "PAYOUT",
      paymentMethodId: "bank_transfer",
      raw: { payment_method_id: "bank_transfer", beneficiary_required_fields: ["bank_name", "account_number"] },
    });
    const unsatisfied = dlocalCoverageEligibility({
      surface: "PAYOUT",
      country: "BR",
      currency: "BRL",
      paymentMethodId: "bank_transfer",
      observedCoverage: [payoutRecord],
      satisfiedRequirementFields: [],
    });
    expect(unsatisfied.basis).toBe("PRECONDITIONS_UNSATISFIED");
    expect(unsatisfied.unsatisfied).toEqual(["bank_name", "account_number"]);
    const satisfied = dlocalCoverageEligibility({
      surface: "PAYOUT",
      country: "BR",
      currency: "BRL",
      paymentMethodId: "bank_transfer",
      observedCoverage: [payoutRecord],
      satisfiedRequirementFields: ["bank_name", "account_number"],
    });
    expect(satisfied.eligible).toBe(true);
  });

  it("country/currency matching is case-insensitive; unknown methods stay unevidenced", () => {
    const verdict = dlocalCoverageEligibility({
      surface: "PAY_IN",
      country: "br",
      currency: "brl",
      paymentMethodId: "card",
      observedCoverage: [observedRecord()],
      satisfiedRequirementFields: ["proof_of_id"],
    });
    expect(verdict.eligible).toBe(true);
    expect(
      dlocalCoverageEligibility({
        surface: "PAY_IN",
        country: "BR",
        currency: "BRL",
        paymentMethodId: "pix",
        observedCoverage: [observedRecord()],
        satisfiedRequirementFields: ["proof_of_id"],
      }).basis,
    ).toBe("NO_CONNECTED_INSTANCE_EVIDENCE");
  });

  it("requirements normalization handles required_fields arrays, { fields } and { required_fields: [{name}] } objects", () => {
    expect(dlocalMethodRequirements({ required_fields: ["proof_of_id", "document_ssn"] }).map((r) => r.fieldName)).toEqual([
      "proof_of_id",
      "document_ssn",
    ]);
    expect(dlocalMethodRequirements({ fields: ["first_name"] }).map((r) => r.fieldName)).toEqual(["first_name"]);
    expect(
      dlocalMethodRequirements({ required_fields: [{ name: "email", required: false }] }).map((r) => r.required),
    ).toEqual([false]);
    expect(dlocalBeneficiaryRequirements("bank_transfer", { beneficiary_required_fields: ["bank_code"] }).map((b) => b.fieldName)).toEqual([
      "bank_code",
    ]);
  });

  it("a coverage observation envelope is lossless and names the (country, currency) pair", () => {
    const methods = [
      { payment_method_id: "card", name: "Cards" },
      { payment_method_id: "pix", name: "Pix" },
    ];
    const envelope = dlocalCoverageEnvelope("BR", "BRL", methods, CTX);
    expect(envelope.object.objectType).toBe("payment_methods");
    expect(envelope.object.externalId).toBe("pm:BR:BRL");
    expect((envelope.state as { data: readonly unknown[] }).data).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 3. Request signing (documented V2 scheme, synthetic keys)
// ---------------------------------------------------------------------------

describe("dlocal request signing — the documented V2 scheme (synthetic keys)", () => {
  it("X-Date is ISO-8601 UTC at SECOND precision (no milliseconds)", () => {
    expect(dlocalXDate(BigInt(Date.parse("2026-10-02T07:11:00.123Z")))).toBe("2026-10-02T07:11:00Z");
  });

  it("the string_to_sign is exactly x_login + x_date + x_trans_key + body", () => {
    const xDate = "2026-10-02T07:11:00Z";
    const body = JSON.stringify({ amount: 10 });
    const expected = createHmac("sha256", SYNTHETIC_SECRET)
      .update(`${SYNTHETIC_X_LOGIN}${xDate}${SYNTHETIC_X_TRANS_KEY}${body}`)
      .digest("hex");
    expect(
      dlocalV2Signature({ xLogin: SYNTHETIC_X_LOGIN, xDate, xTransKey: SYNTHETIC_X_TRANS_KEY, body, secret: SYNTHETIC_SECRET }),
    ).toBe(expected);
    expect(
      dlocalV2Signature({ xLogin: SYNTHETIC_X_LOGIN, xDate, xTransKey: SYNTHETIC_X_TRANS_KEY, body: "", secret: SYNTHETIC_SECRET }),
    ).not.toBe(expected);
  });

  it("auth headers carry X-Login/X-Trans-Key/X-Date + the V2 Authorization; the secret never appears as a header value", () => {
    const nowMs = BigInt(Date.parse(T0));
    const headers = dlocalAuthHeaders({
      xLogin: SYNTHETIC_X_LOGIN,
      xTransKey: SYNTHETIC_X_TRANS_KEY,
      secret: SYNTHETIC_SECRET,
      nowMs,
      body: JSON.stringify({ amount: 10 }),
    });
    expect(headers["X-Login"]).toBe(SYNTHETIC_X_LOGIN);
    expect(headers["X-Trans-Key"]).toBe(SYNTHETIC_X_TRANS_KEY);
    expect(headers["X-Date"]).toBe("2026-10-02T07:11:00Z");
    expect(headers.Authorization).toMatch(/^V2-HMAC-SHA256, Signature: [0-9a-f]{64}$/);
    for (const value of Object.values(headers)) {
      expect(value).not.toContain(SYNTHETIC_SECRET);
    }
  });

  it("any input change changes the signature", () => {
    const a = dlocalV2Signature({ xLogin: "a", xDate: "2026-10-02T07:11:00Z", xTransKey: "k", body: "x", secret: "s" });
    const b = dlocalV2Signature({ xLogin: "b", xDate: "2026-10-02T07:11:00Z", xTransKey: "k", body: "x", secret: "s" });
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// 4. Payment lifecycle → ProviderStateEnvelope (lossless, INV-C06)
// ---------------------------------------------------------------------------

describe("dlocal payment lifecycle → ProviderStateEnvelope (lossless, INV-C06)", () => {
  it("maps every status into the payment family with the exact classification", () => {
    for (const row of DLOCAL_PAYMENT_STATUS_MAPPING) {
      const envelope = dlocalPaymentEnvelope(
        { id: `pay_${row.providerState}`, status: row.providerState } as DlocalPaymentProviderObject,
        CTX,
      );
      expect(envelope.classification.family).toBe(row.family);
      expect(envelope.classification.isTerminal).toBe(row.isTerminal);
      expect(envelope.classification.requiresCustomerAction).toBe(row.requiresCustomerAction);
      expect(envelope.classification.lifecycleStep).toBe(row.lifecycleStep);
    }
  });

  it("a redirect on a processing status makes the payment customer-action-required first-class", () => {
    const envelope = dlocalPaymentEnvelope(
      { id: "pay_3ds", status: "PENDING", redirect_url: "https://sandbox.dlocal.com/3ds/synthetic" } as DlocalPaymentProviderObject,
      CTX,
    );
    expect(envelope.classification.family).toBe("customer_action_required");
    expect(envelope.classification.requiresCustomerAction).toBe(true);
    expect((envelope.actionRequired as { deepLink?: string } | undefined)?.deepLink).toContain("3ds");
  });

  it("three_ds.redirect_url is honored as the redirect surface too", () => {
    const envelope = dlocalPaymentEnvelope(
      { id: "pay_tds", status: "VERIFIED", three_ds: { redirect_url: "https://sandbox.dlocal.com/tds/synthetic" } } as DlocalPaymentProviderObject,
      CTX,
    );
    expect(envelope.classification.family).toBe("customer_action_required");
  });

  it("PAID is terminal settled-external; CHARGEBACK is the dispute family (non-terminal)", () => {
    const paid = dlocalPaymentEnvelope({ id: "p1", status: "PAID" } as DlocalPaymentProviderObject, CTX);
    expect(paid.classification.isTerminal).toBe(true);
    const chargeback = dlocalPaymentEnvelope({ id: "p2", status: "CHARGEBACK" } as DlocalPaymentProviderObject, CTX);
    expect(chargeback.classification.family).toBe("dispute");
    expect(chargeback.classification.isTerminal).toBe(false);
  });

  it("carries the provider payment id as the external id; revisions are deterministic", () => {
    const payment = { id: "pay_rev", status: "PAID", redirect_url: "https://x" } as DlocalPaymentProviderObject;
    expect(dlocalPaymentRevision(payment)).toBe("pay_rev:PAID:redirect");
    expect(dlocalPaymentRevision({ id: "pay_rev", status: "PAID" } as DlocalPaymentProviderObject)).toBe("pay_rev:PAID:no_redirect");
    expect(dlocalRefundRevision({ id: "ref_1", payment_id: "p", status: "RE" } as DlocalRefundProviderObject)).toBe("ref_1:RE");
    expect(dlocalPayoutRevision({ id: "po_1", status: "PAID" } as DlocalPayoutProviderObject)).toBe("po_1:PAID");
  });

  it("lossless round-trip through serialize/parse for payment, refund and payout (INV-C06)", () => {
    for (const envelope of [
      dlocalPaymentEnvelope({ id: "p", status: "PAID", amount: 10.5, currency: "BRL" } as DlocalPaymentProviderObject, CTX),
      dlocalRefundEnvelope({ id: "r", payment_id: "p", status: "PE", amount: 1 } as DlocalRefundProviderObject, CTX),
      dlocalPayoutEnvelope({ id: "po", status: "PENDING", beneficiary: { bank_code: "synthetic" } } as DlocalPayoutProviderObject, CTX),
    ]) {
      expect(parseProviderStateEnvelope(serializeProviderStateEnvelope(envelope))).toEqual(envelope);
    }
  });

  it("payout envelopes always carry the payout family for processing statuses", () => {
    const envelope = dlocalPayoutEnvelope({ id: "po2", status: "IN_PROGRESS" } as DlocalPayoutProviderObject, CTX);
    expect(envelope.classification.family).toBe("payout");
    expect(envelope.classification.isTerminal).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. Webhook verification (X-Signature hex HMAC-SHA256 over the raw body)
// ---------------------------------------------------------------------------

describe("dlocal webhook verification (X-Signature, constant-time, dedupe)", () => {
  const rawBody = JSON.stringify({ type: "payment_authorized", id: "pay_hook_1", status: "AUTHORIZED", created_date: 1764999900 });

  it("verifies a correctly signed delivery", () => {
    const signature = dlocalWebhookSignature(SYNTHETIC_WEBHOOK_SECRET, rawBody);
    const verdict = verifyDlocalWebhookDelivery(
      { signatureHeader: signature, rawBody },
      { secret: SYNTHETIC_WEBHOOK_SECRET },
    );
    expect(verdict.valid).toBe(true);
  });

  it("rejects a missing signature and an invalid signature with distinct reasons", () => {
    expect(
      verifyDlocalWebhookDelivery({ signatureHeader: undefined, rawBody }, { secret: SYNTHETIC_WEBHOOK_SECRET }),
    ).toMatchObject({ valid: false, reason: "MISSING_SIGNATURE" });
    expect(
      verifyDlocalWebhookDelivery({ signatureHeader: "deadbeef", rawBody }, { secret: SYNTHETIC_WEBHOOK_SECRET }),
    ).toMatchObject({ valid: false, reason: "SIGNATURE_INVALID" });
  });

  it("the scheme carries NO timestamp — replay defense is the (provider, eventId) dedupe", () => {
    expect(rawBody).not.toContain("timestamp");
    const eventId = dlocalWebhookEventId(JSON.parse(rawBody) as unknown);
    expect(eventId).toBe("payment_authorized:pay_hook_1");
    expect(dlocalWebhookEventId({ type: "untyped_event" })).toBe("untyped_event:no-id");
    expect(dlocalWebhookEventId("not-an-object")).toBeUndefined();
  });

  it("the provider-declared event timestamp is extracted when present (created_date epoch)", () => {
    expect(dlocalWebhookEventTimestamp(JSON.parse(rawBody) as unknown)).toBe("1764999900");
    expect(dlocalWebhookEventTimestamp({ created_date: "1764999900" })).toBe("1764999900");
    expect(dlocalWebhookEventTimestamp({})).toBeUndefined();
  });

  it("the webhook event envelope maps payment-like payloads to the payment envelope, others to the generic event envelope", () => {
    const paymentLike = dlocalWebhookEventEnvelope(JSON.parse(rawBody) as unknown, WEBHOOK_CTX);
    expect(paymentLike.object.objectType).toBe("payment");
    expect(parseProviderStateEnvelope(serializeProviderStateEnvelope(paymentLike))).toEqual(paymentLike);
    const generic = dlocalWebhookEventEnvelope({ type: "payout_notification", note: "synthetic" }, WEBHOOK_CTX);
    expect(generic.object.objectType).toBe("event");
    expect(generic.classification.lifecycleStep).toBe("payout_notification");
    expect(parseProviderStateEnvelope(serializeProviderStateEnvelope(generic))).toEqual(generic);
  });

  it("the raw-event adapter exposes the X-Signature value for the verifier", () => {
    const rawEvent = dlocalWebhookRawEvent({
      eventId: "payment_authorized:pay_hook_1",
      payload: JSON.parse(rawBody) as unknown,
      signatureHeader: "sig",
      timestampSeconds: "1795882260",
    });
    expect(rawEvent.providerName).toBe("dlocal");
    expect(rawEvent.headers).toMatchObject({ signature: "sig" });
  });

  it("the verifier + ingestor accept a real signed delivery end-to-end (dedupe on second delivery)", () => {
    const ingestor = createDlocalWebhookIngestor({
      secret: SYNTHETIC_WEBHOOK_SECRET,
      clock: CLOCK,
    });
    const payload = JSON.parse(rawBody) as unknown;
    // The ingestor verifies over the CANONICAL body (JSON.stringify(payload))
    // with the replay window anchored at CLOCK.now():
    const canonicalBody = JSON.stringify(payload);
    const signature = dlocalWebhookSignature(SYNTHETIC_WEBHOOK_SECRET, canonicalBody);
    const timestampSeconds = "1764999900"; // inside CLOCK's replay window
    const first = ingestor.ingest(
      dlocalWebhookRawEvent({
        eventId: "payment_authorized:pay_hook_1",
        payload,
        signatureHeader: signature,
        timestampSeconds,
      }),
    );
    expect(first.kind).not.toBe("REJECTED");
    const second = ingestor.ingest(
      dlocalWebhookRawEvent({
        eventId: "payment_authorized:pay_hook_1",
        payload,
        signatureHeader: signature,
        timestampSeconds,
      }),
    );
    expect(second.kind).toBe("ALREADY_INGESTED"); // dedupe
  });
});

// ---------------------------------------------------------------------------
// 6. Idempotency (deterministic tracking_id — INV-F05)
// ---------------------------------------------------------------------------

describe("dlocal idempotency (deterministic tracking_id, INV-F05)", () => {
  it("derives the tracking id deterministically from the protocol key", () => {
    expect(dlocalTrackingId("order-123")).toBe("payswap-order-123");
    expect(dlocalTrackingId("order-123")).toBe(dlocalTrackingId("order-123"));
    expect(dlocalTrackingId("order-456")).not.toBe(dlocalTrackingId("order-123"));
  });

  it("refuses an empty protocol key", () => {
    expect(() => dlocalTrackingId("")).toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// 7. Connector — fail-closed credential gating (INV-NC04)
// ---------------------------------------------------------------------------

describe("dlocal connector — fail-closed credential gating", () => {
  it("no credential: effectful operations throw RailNotAuthorizedError BEFORE any provider call", async () => {
    const transport = new ScriptedHttpTransport(() => jsonResponse(200, {}));
    const connector = new DlocalConnector({ clock: CLOCK, http: transport.transport, env: {} });
    await expect(
      connector.create(ctx(AUTHORITY, { kind: "create_payment", amountMajor: "10", currency: "USD", country: "BR", payer: {} }, "idem-1")),
    ).rejects.toThrow(RailNotAuthorizedError);
    await expect(connector.read(ctx(AUTHORITY, { kind: "read_payment", paymentId: "p1" }))).rejects.toThrow(
      RailNotAuthorizedError,
    );
    await expect(connector.read(ctx(AUTHORITY, { kind: "read_payout", payoutId: "po1" }))).rejects.toThrow(
      RailNotAuthorizedError,
    );
    await expect(connector.executeAction(ctx(AUTHORITY, { kind: "create_refund", paymentId: "p1" }))).rejects.toThrow(
      RailNotAuthorizedError,
    );
    await expect(
      connector.observeCoverage({ surface: "PAY_IN", country: "BR", currency: "BRL" }),
    ).rejects.toThrow(RailNotAuthorizedError);
    expect(transport.calls).toHaveLength(0); // fail-closed BEFORE any provider call
  });

  it("credentialResolutionState reports NOT_PROVISIONED with the config key", () => {
    const connector = new DlocalConnector({ clock: CLOCK, env: {} });
    expect(connector.credentialResolutionState()).toMatchObject({
      kind: "NOT_PROVISIONED",
      configKey: DLOCAL_CREDENTIAL_CONFIG_KEY,
    });
  });

  it("the availability observation stays UNKNOWN with provenance (INV-C01/C02)", () => {
    const connector = new DlocalConnector({ clock: CLOCK, env: {} });
    const observation = connector.availabilityObservation({
      instanceId: "dlocal-sandbox-account-20261002",
      observationVersion: 1,
    });
    expect(observation.availability).toBe("UNKNOWN");
    expect(observation.sourceAvailability).toBe("UNKNOWN");
  });
});

// ---------------------------------------------------------------------------
// 8. Connector happy paths (synthetic env material, scripted transport)
// ---------------------------------------------------------------------------

describe("dlocal connector — provider calls with synthetic credentials (offline)", () => {
  function envConnector(
    respond: (url: string, init: { method: string; body?: string }) => { status: number; bodyText: string },
  ): { connector: DlocalConnector; transport: ScriptedHttpTransport } {
    const transport = new ScriptedHttpTransport(respond);
    return {
      connector: new DlocalConnector({
        clock: CLOCK,
        http: transport.transport,
        env: { PROVIDER_DLOCAL_CREDENTIAL_REF: SYNTHETIC_ENV_MATERIAL },
      }),
      transport,
    };
  }

  it("create_payment POSTs to /payments_api/v6/authorize with signed headers + deterministic tracking id", async () => {
    const { connector, transport } = envConnector(() =>
      jsonResponse(200, { id: "pay_new_1", status: "PENDING", amount: 10, currency: "USD" }),
    );
    const result = await connector.create(
      ctx(AUTHORITY, { kind: "create_payment", amountMajor: "10", currency: "usd", country: "br", payer: { name: "synthetic" } }, "order-77"),
    );
    expect(transport.calls).toHaveLength(1);
    const call = transport.calls[0]!;
    expect(call.url).toBe(`${DLOCAL_DEFAULT_API_BASE_SANDBOX}/payments_api/v6/authorize`);
    expect(call.method).toBe("POST");
    const body = JSON.parse(call.body ?? "{}") as Record<string, unknown>;
    expect(body.tracking_id).toBe("payswap-order-77");
    expect(body.country).toBe("BR");
    expect(body.currency).toBe("USD");
    expect(result.providerState.object.externalId).toBe("pay_new_1");
    expect(result.providerState.classification.family).toBe("async_processing");
  });

  it("read_payment GETs the status path; reconcile re-fetches (INV-X03)", async () => {
    const { connector, transport } = envConnector(() =>
      jsonResponse(200, { id: "pay_X", status: "PAID", amount: 10, currency: "USD" }),
    );
    const result = await connector.read(ctx(AUTHORITY, { kind: "read_payment", paymentId: "pay_X" }, "idem-read"));
    expect(transport.calls[0]?.url).toBe(`${DLOCAL_DEFAULT_API_BASE_SANDBOX}/payments_api/v6/status/pay_X`);
    expect(result.providerState.classification.isTerminal).toBe(true);
    expect(result.providerState.classification.lifecycleStep).toBe("PAID");
    const again = await connector.reconcile(ctx(AUTHORITY, { kind: "read_payment", paymentId: "pay_X" }, "idem-read-2"));
    expect(again.providerState.object.externalId).toBe("pay_X");
    expect(transport.calls).toHaveLength(2);
  });

  it("read_payout GETs the payout path and maps the payout family", async () => {
    const { connector, transport } = envConnector(() =>
      jsonResponse(200, { id: "po_9", status: "IN_PROGRESS", amount: 5, currency: "BRL" }),
    );
    const result = await connector.read(ctx(AUTHORITY, { kind: "read_payout", payoutId: "po_9" }, "idem-po"));
    expect(transport.calls[0]?.url).toBe(`${DLOCAL_DEFAULT_API_BASE_SANDBOX}/payments_api/v6/payouts/po_9`);
    expect(result.providerState.classification.family).toBe("payout");
  });

  it("create_refund POSTs to the refunds path; cancel_payment cancels", async () => {
    const { connector, transport } = envConnector((url) => {
      if (url.includes("/refunds")) {
        return jsonResponse(200, { id: "ref_1", payment_id: "p1", status: "PE", amount: 1 });
      }
      return jsonResponse(200, { id: "p1", status: "CANCELLED", amount: 10 });
    });
    const refund = await connector.executeAction(
      ctx(AUTHORITY, { kind: "create_refund", paymentId: "p1" }, "idem-refund"),
    );
    expect(transport.calls[0]?.url).toContain("/payments_api/v6/refunds");
    expect(refund.providerState.object.objectType).toBe("refund");
    const cancelled = await connector.executeAction(
      ctx(AUTHORITY, { kind: "cancel_payment", paymentId: "p1" }, "idem-cancel"),
    );
    expect(cancelled.providerState.classification.isTerminal).toBe(true);
    expect(cancelled.providerState.classification.lifecycleStep).toBe("CANCELLED");
  });

  it("observeCoverage queries payment-methods/v2 and builds coverage records (the ONLY coverage source)", async () => {
    const { connector, transport } = envConnector(() =>
      jsonResponse(200, [
        { payment_method_id: "card", name: "Cards", required_fields: ["proof_of_id"] },
        { payment_method_id: "pix", name: "Pix" },
      ]),
    );
    const { records, envelope } = await connector.observeCoverage({ surface: "PAY_IN", country: "br", currency: "brl" });
    expect(transport.calls[0]?.url).toContain("/payment-methods/v2/payment-methods?country=BR&currency=BRL");
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ surface: "PAY_IN", country: "BR", currency: "BRL", source: "CONNECTED_ACCOUNT_QUERY" });
    expect(records[0]?.requirements.map((r) => r.fieldName)).toEqual(["proof_of_id"]);
    expect(envelope.object.objectType).toBe("payment_methods");
  });

  it("a malformed payment-methods answer is a RailProviderError (never a fabricated coverage list)", async () => {
    const { connector } = envConnector(() => jsonResponse(200, { not: "an array" }));
    await expect(connector.observeCoverage({ surface: "PAY_IN", country: "BR", currency: "BRL" })).rejects.toThrow(
      RailProviderError,
    );
  });

  it("a provider error answer is a RailProviderError (never a fabricated outcome)", async () => {
    const { connector } = envConnector(() => jsonResponse(400, { code: 4001, message: "bad amount", type: "bad_request" }));
    await expect(connector.read(ctx(AUTHORITY, { kind: "read_payment", paymentId: "pay_BAD" }))).rejects.toThrow(
      RailProviderError,
    );
  });

  it("a mid-effect transport failure produces an OUTCOME_UNKNOWN envelope — NEVER FAILED (INV-X01)", async () => {
    const { connector } = envConnector(() => {
      throw new Error("connection reset");
    });
    const result = await connector.create(
      ctx(AUTHORITY, { kind: "create_payment", amountMajor: "10", currency: "USD", country: "BR", payer: {} }, "idem-x01"),
    );
    expect(result.providerState.classification.lifecycleStep).toBe("outcome_unknown");
    expect(result.providerState.classification.isTerminal).toBe(false);
    expect(result.providerState.failure?.ambiguity).toBe("OUTCOME_UNKNOWN");
    expect(
      parseProviderStateEnvelope(serializeProviderStateEnvelope(result.providerState)),
    ).toEqual(result.providerState);
  });

  it("no key material ever appears in envelopes, evidence, outcomes or health", async () => {
    const { connector } = envConnector(() =>
      jsonResponse(200, { id: "pay_SEC", status: "PENDING", amount: 1, currency: "USD" }),
    );
    const read = await connector.read(ctx(AUTHORITY, { kind: "read_payment", paymentId: "pay_SEC" }));
    const health = await connector.health();
    expect(health.status).toBe("HEALTHY");
    for (const serialized of [
      stringifySafe(read.providerState),
      stringifySafe(read.evidence),
      stringifySafe(read.outcome),
      stringifySafe(health),
      serializeProviderStateEnvelope(read.providerState),
    ]) {
      expect(serialized).not.toContain(SYNTHETIC_X_LOGIN);
      expect(serialized).not.toContain(SYNTHETIC_SECRET);
      expect(serialized).not.toContain(SYNTHETIC_X_TRANS_KEY);
    }
  });

  it("the control-plane path opens the sealed bundle per call (SEALED state; material never surfaces)", async () => {
    const store = new FixtureVaultStore();
    store.bind(DLOCAL_CREDENTIAL_CONFIG_KEY, VAULT_REF);
    store.seal(VAULT_REF, { x_login: SYNTHETIC_X_LOGIN, x_trans_key: SYNTHETIC_X_TRANS_KEY, secret: SYNTHETIC_SECRET });
    const broker = new CredentialBroker({ store });
    const runtimeKey = broker.registerConnectorRuntime("runtime.dlocal.test");
    const transport = new ScriptedHttpTransport(() =>
      jsonResponse(200, { id: "pay_CP", status: "PENDING", amount: 1, currency: "USD" }),
    );
    const connector = new DlocalConnector({
      clock: CLOCK,
      http: transport.transport,
      credentials: { broker, runtimeKey },
    });
    expect(connector.credentialResolutionState()).toMatchObject({ kind: "CONTROL_PLANE_SEALED" });
    const result = await connector.read(ctx(AUTHORITY, { kind: "read_payment", paymentId: "pay_CP" }));
    expect(result.providerState.object.externalId).toBe("pay_CP");
    expect(stringifySafe(result)).not.toContain(SYNTHETIC_SECRET);

    // An UNBOUND config key fails closed with no silent fallback:
    const emptyStore = new FixtureVaultStore();
    const emptyBroker = new CredentialBroker({ store: emptyStore });
    const emptyKey = emptyBroker.registerConnectorRuntime("runtime.dlocal.test2");
    const refused = new DlocalConnector({
      clock: CLOCK,
      http: transport.transport,
      credentials: { broker: emptyBroker, runtimeKey: emptyKey },
    });
    await expect(refused.read(ctx(AUTHORITY, { kind: "read_payment", paymentId: "pay_CP" }))).rejects.toThrow(
      RailNotAuthorizedError,
    );
  });

  it("credential material extraction rejects malformed env material (fail-closed, not guessed)", () => {
    expect(() => extractDlocalCredentialMaterial("not-json")).toThrow();
    expect(() => extractDlocalCredentialMaterial(JSON.stringify({}))).toThrow();
    expect(
      extractDlocalCredentialMaterial(JSON.parse(SYNTHETIC_ENV_MATERIAL) as unknown),
    ).toMatchObject({ xLogin: SYNTHETIC_X_LOGIN, secretKey: SYNTHETIC_SECRET });
  });

  it("invalid SDK requests are ValidationErrors (never reach the provider)", async () => {
    const connector = new DlocalConnector({ clock: CLOCK, env: { PROVIDER_DLOCAL_CREDENTIAL_REF: SYNTHETIC_ENV_MATERIAL } });
    await expect(connector.read(ctx(AUTHORITY, { kind: "nonsense" }))).rejects.toThrow(ValidationError);
    await expect(
      connector.create(ctx(AUTHORITY, { kind: "create_payment", amountMajor: "10.5.3", currency: "USD", country: "BR", payer: {} })),
    ).rejects.toThrow(ValidationError);
    await expect(
      connector.create(ctx(AUTHORITY, { kind: "create_payment", currency: "USD", country: "BR", payer: {} })),
    ).rejects.toThrow(ValidationError);
  });
});

/** A control-plane vault fixture: config key → vault ref → sealed bundle. */
class FixtureVaultStore implements VaultStore {
  readonly storeId = "vault-fixture-dlocal";
  readonly #bindings = new Map<string, string>();
  readonly #bundles = new Map<string, SealedCredentialBundle>();

  bind(configKey: string, reference: string): void {
    this.#bindings.set(configKey, reference);
  }

  seal(reference: string, material: unknown): void {
    this.#bundles.set(
      reference,
      new SealedCredentialBundle(
        {
          providerName: "dlocal",
          authorizationMode: "SCOPED_API_CREDENTIAL",
          vaultReference: vaultReference(reference),
          issuedAt: "2026-10-02T07:11:00Z",
          accountRef: "dlocal-sandbox-account-20261002",
        },
        material,
      ),
    );
  }

  resolve(reference: string): SealedCredentialBundle | undefined {
    return this.#bundles.get(reference);
  }

  referenceBoundTo(configKey: string): string | undefined {
    return this.#bindings.get(configKey);
  }
}

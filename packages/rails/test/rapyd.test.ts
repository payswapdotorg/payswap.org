import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import {
  parseProviderStateEnvelope,
  serializeProviderStateEnvelope,
  validateExternalFundsPositionObservation,
} from "@payswap/connectors";
import { ValidationError } from "@payswap/protocol";
import type { ConnectorRuntimeKey, VaultStore } from "@payswap/adapters";
import { CredentialBroker, SealedCredentialBundle, vaultReference } from "@payswap/adapters";
import {
  RAIL_CREDENTIAL_ENV_VARS,
  RailNotAuthorizedError,
  RailProviderError,
} from "../src/support.js";
import {
  RAPYD_API_VERSION,
  RAPYD_CREDENTIAL_CONFIG_KEY,
  RAPYD_DEFAULT_API_BASE_SANDBOX,
  RAPYD_PAYMENT_STATUS_MAPPING,
  RAPYD_PAYOUT_STATUS_MAPPING,
  RAPYD_SANDBOX_REACHABILITY_DATUM_20261002,
  RAPYD_WEBHOOK_SIGNATURE_SEPARATOR,
  RapydConnector,
  RapydProductionRail,
  RapydWebhookVerifier,
  createRapydWebhookIngestor,
  extractRapydCredentialMaterial,
  rapydBeneficiaryRequirements,
  rapydCapabilityDefinitions,
  rapydClientReference,
  rapydCoverageEligibility,
  rapydCoverageEnvelope,
  rapydMinorUnits,
  rapydPaymentEnvelope,
  rapydPaymentMethodRequirements,
  rapydPaymentRevision,
  rapydPayoutEnvelope,
  rapydPayoutRevision,
  rapydRailCapabilityPack,
  rapydRequirementsEnvelope,
  rapydSignatureHeaders,
  rapydSortedJsonString,
  rapydStringToSign,
  rapydWalletObservation,
  rapydWebhookEventEnvelope,
  rapydWebhookEventId,
  rapydWebhookEventTimestamp,
  rapydWebhookRawEvent,
  rapydWebhookSignature,
  verifyRapydWebhookDelivery,
} from "../src/rapyd.js";
import type {
  RapydCoverageRecord,
  RapydPaymentProviderObject,
  RapydPayoutProviderObject,
  RapydWalletProviderObject,
} from "../src/rapyd.js";
import { CLOCK, ctx, makeAdapterAuthority } from "./fixtures.js";
import { ScriptedHttpTransport } from "./fixtures.js";

const AUTHORITY = makeAdapterAuthority();
const T0 = "2026-10-02T06:37:38Z";
const CTX = { observedAt: T0, provenanceSource: "PROVIDER_API" } as const;
const WEBHOOK_CTX = { observedAt: T0, provenanceSource: "PROVIDER_WEBHOOK" } as const;

// Obviously-synthetic fixture credentials (never real; the byte-scan law).
const SYNTHETIC_ACCESS_KEY = "AK_SYNTHETIC_RAPYD_FIXTURE_0001_NOT_REAL";
const SYNTHETIC_SECRET_KEY = "SK_SYNTHETIC_RAPYD_FIXTURE_0002_NOT_REAL";
const SYNTHETIC_ENV_MATERIAL = JSON.stringify({
  access_key: SYNTHETIC_ACCESS_KEY,
  secret_key: SYNTHETIC_SECRET_KEY,
});
const SYNTHETIC_WEBHOOK_SECRET = "whsec_SYNTHETIC_RAPYD_FIXTURE_0003_NOT_REAL";
const VAULT_REF = "vault://payswap/providers/rapyd/sandbox-20261002";

function jsonResponse(status: number, body: unknown): { status: number; bodyText: string } {
  return { status, bodyText: JSON.stringify(body) };
}

/** BigInt-safe JSON serialization for secret-hygiene scans over products. */
function stringifySafe(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    typeof inner === "bigint" ? inner.toString() : inner,
  ) ?? "";
}

function rapydSuccess(data: unknown): { status: number; bodyText: string } {
  return jsonResponse(200, { status: { status: "SUCCESS", error_code: "0", message: "" }, data });
}

// ---------------------------------------------------------------------------
// 1. Vocabulary and capability surface
// ---------------------------------------------------------------------------

describe("rapyd connector vocabulary (P2-W2-002)", () => {
  it("pins the provider identity, API version and the control-plane credential key", () => {
    expect(RAPYD_CREDENTIAL_CONFIG_KEY).toBe("PROVIDER_RAPYD_CREDENTIAL_REF");
    expect(RAPYD_API_VERSION).toBe("v1");
    expect(RAPYD_DEFAULT_API_BASE_SANDBOX).toBe("https://sandboxapi.rapyd.net");
    expect(RAIL_CREDENTIAL_ENV_VARS.find((entry) => entry.envVar === RAPYD_CREDENTIAL_CONFIG_KEY)?.railId).toBe("rail.rapyd");
  });

  it("records the 2026-10-02 sandbox reachability datum (401 = reachable, auth required)", () => {
    expect(RAPYD_SANDBOX_REACHABILITY_DATUM_20261002.httpStatus).toBe(401);
    expect(RAPYD_SANDBOX_REACHABILITY_DATUM_20261002.verdict).toBe("REACHABLE_AUTH_REQUIRED");
    expect(RAPYD_SANDBOX_REACHABILITY_DATUM_20261002.path).toBe("/v1/payment_methods_by_country");
  });

  it("capability definitions + pack use the v1.5 vocabulary (no parallel model)", () => {
    const definitions = rapydCapabilityDefinitions();
    expect(definitions.length).toBe(5);
    for (const definition of definitions) {
      expect(definition.authorization.protocolAuthorization).toBe(true);
      expect(definition.idempotency.duplicateBehavior).toBe("PROVIDER_DEFINED");
      expect(definition.providerVocabulary.states.length).toBeGreaterThan(0);
    }
    const pack = rapydRailCapabilityPack();
    expect(pack.sourceOfTruth).toBe("EXTERNAL_AUTHORITATIVE");
    expect(pack.packId).toBe("pack.rails.rapyd");
  });

  it("pay-in and payout are SEPARATE capability families with separate coverage surfaces", () => {
    const definitions = rapydCapabilityDefinitions();
    const payin = definitions.find((d) => d.capabilityId === "cap.rails.rapyd.payin.payment");
    const payout = definitions.find((d) => d.capabilityId === "cap.rails.rapyd.payout.transfer");
    expect(payin).toBeDefined();
    expect(payout).toBeDefined();
    expect(payin?.capabilityId).not.toBe(payout?.capabilityId);
    // each family carries its own coverage-law precondition
    expect(payin?.preconditions.join(" ")).toContain("never assumed from the provider catalogue");
    expect(payout?.preconditions.join(" ")).toContain("the payout coverage surface is SEPARATE from pay-in");
    expect(payout?.preconditions.join(" ")).toContain("a pay-in observation never authorizes a payout");
  });

  it("KYC/document requirements are encoded as capability preconditions on the pay-in family", () => {
    const payin = rapydCapabilityDefinitions().find(
      (d) => d.capabilityId === "cap.rails.rapyd.payin.payment",
    );
    expect(payin?.preconditions.join(" ")).toContain("KYC/document requirement fields");
    expect(payin?.preconditions.join(" ")).toContain("they are capability preconditions, not suggestions");
    const coverage = rapydCapabilityDefinitions().find(
      (d) => d.capabilityId === "cap.rails.rapyd.payin.coverage_observation",
    );
    expect(coverage?.preconditions.join(" ")).toContain("ONLY from a connected-account query");
    expect(coverage?.preconditions.join(" ")).toContain("never routable evidence");
  });

  it("beneficiary requirements are explicit preconditions on the payout family", () => {
    const payout = rapydCapabilityDefinitions().find(
      (d) => d.capabilityId === "cap.rails.rapyd.payout.transfer",
    );
    expect(payout?.preconditions.join(" ")).toContain("beneficiary requirements");
    expect(payout?.preconditions.join(" ")).toContain("SATISFIED");
  });

  it("the rail adapter registers on the BaseRailAdapter framework", () => {
    const rail = new RapydProductionRail();
    expect(rail.adapterId).toBe("rail.rapyd");
    expect(rail.implementationId).toBe("impl.rails.rapyd.v1");
  });

  it("immutable SDK surfaces (update/subscribe/disconnect) refuse with ValidationErrors", async () => {
    const connector = new RapydConnector({ clock: CLOCK });
    await expect(connector.update(ctx(AUTHORITY, { kind: "update" }))).rejects.toThrow(ValidationError);
    await expect(connector.subscribe(ctx(AUTHORITY, { kind: "subscribe" }))).rejects.toThrow(ValidationError);
    await expect(connector.disconnect(ctx(AUTHORITY, { kind: "disconnect" }))).rejects.toThrow(ValidationError);
  });

  it("the requirements envelope round-trips losslessly with normalized preconditions inside", () => {
    const envelope = rapydRequirementsEnvelopeForTest();
    expect(parseProviderStateEnvelope(serializeProviderStateEnvelope(envelope))).toEqual(envelope);
  });

  it("an unmapped PAYOUT status stays non-terminal payout-family (UNKNOWN, never FAILED)", () => {
    const envelope = rapydPayoutEnvelope({ id: "payout_U", status: "WEIRD_NEW_STATUS" }, CTX);
    expect(envelope.classification.family).toBe("payout");
    expect(envelope.classification.isTerminal).toBe(false);
    expect(envelope.classification.lifecycleStep).toBe("WEIRD_NEW_STATUS");
  });
});

function rapydRequirementsEnvelopeForTest() {
  return rapydRequirementsEnvelope(
    "mastercard",
    { required_fields: ["proof_of_id"] },
    { observedAt: T0, provenanceSource: "PROVIDER_API" },
  );
}

// ---------------------------------------------------------------------------
// 2. THE COVERAGE LAW + KYC/beneficiary preconditions (executable)
// ---------------------------------------------------------------------------

describe("rapyd coverage law — observed-only records, precondition-checked eligibility", () => {
  const observedAt = "2026-10-02T07:00:00Z";
  const payinRecord = (requirements: readonly { fieldName: string; required: boolean }[]): RapydCoverageRecord => ({
    surface: "PAY_IN",
    country: "GH",
    paymentMethodType: "ug_mobilemoney_ussd",
    observedAt,
    source: "CONNECTED_ACCOUNT_QUERY",
    requirements,
    raw: { type: "ug_mobilemoney_ussd", name: "Uganda Mobile Money" },
  });

  it("an EMPTY observed-coverage registry yields NO_CONNECTED_INSTANCE_EVIDENCE — never eligible (the honest deployment state)", () => {
    const verdict = rapydCoverageEligibility({
      surface: "PAY_IN",
      country: "GH",
      paymentMethodType: "ug_mobilemoney_ussd",
      observedCoverage: [],
      satisfiedRequirementFields: [],
    });
    expect(verdict.eligible).toBe(false);
    expect(verdict.basis).toBe("NO_CONNECTED_INSTANCE_EVIDENCE");
    expect(verdict.reason).toContain("never routable evidence");
  });

  it("an observed record with unsatisfied KYC/document preconditions is PRECONDITIONS_UNSATISFIED", () => {
    const verdict = rapydCoverageEligibility({
      surface: "PAY_IN",
      country: "GH",
      paymentMethodType: "ug_mobilemoney_ussd",
      observedCoverage: [
        payinRecord([
          { fieldName: "proof_of_id", required: true },
          { fieldName: "document_ssn", required: true },
        ]),
      ],
      satisfiedRequirementFields: ["proof_of_id"],
    });
    expect(verdict.eligible).toBe(false);
    expect(verdict.basis).toBe("PRECONDITIONS_UNSATISFIED");
    expect(verdict.unsatisfied).toEqual(["document_ssn"]);
  });

  it("an observed record with every required KYC field satisfied is eligible", () => {
    const verdict = rapydCoverageEligibility({
      surface: "PAY_IN",
      country: "GH",
      paymentMethodType: "ug_mobilemoney_ussd",
      observedCoverage: [
        payinRecord([
          { fieldName: "proof_of_id", required: true },
          { fieldName: "document_ssn", required: true },
        ]),
      ],
      satisfiedRequirementFields: ["proof_of_id", "document_ssn"],
    });
    expect(verdict.eligible).toBe(true);
    expect(verdict.basis).toBe("OBSERVED_AND_PRECONDITIONS_SATISFIED");
    expect(verdict.unsatisfied).toEqual([]);
  });

  it("optional (required:false) KYC fields do not block eligibility", () => {
    const verdict = rapydCoverageEligibility({
      surface: "PAY_IN",
      country: "GH",
      paymentMethodType: "ug_mobilemoney_ussd",
      observedCoverage: [payinRecord([{ fieldName: "proof_of_id", required: true }, { fieldName: "document_ssn", required: false }])],
      satisfiedRequirementFields: ["proof_of_id"],
    });
    expect(verdict.eligible).toBe(true);
  });

  it("a PAY_IN record never authorizes the PAYOUT surface (separate coverage surfaces)", () => {
    const verdict = rapydCoverageEligibility({
      surface: "PAYOUT",
      country: "GH",
      paymentMethodType: "ug_mobilemoney_ussd",
      observedCoverage: [payinRecord([])], // pay-in evidence ONLY
      satisfiedRequirementFields: [],
    });
    expect(verdict.eligible).toBe(false);
    expect(verdict.basis).toBe("NO_CONNECTED_INSTANCE_EVIDENCE");
  });

  it("payout eligibility requires the observed record AND satisfied beneficiary fields", () => {
    const payoutRecord: RapydCoverageRecord = {
      surface: "PAYOUT",
      country: "GH",
      paymentMethodType: "gh_mobile_money",
      observedAt,
      source: "CONNECTED_ACCOUNT_QUERY",
      requirements: [],
      raw: {
        payout_method_type: "gh_mobile_money",
        fields: [{ field_name: "phone_number", required: true }, { field_name: "recipient_name" }],
      },
    };
    const blocked = rapydCoverageEligibility({
      surface: "PAYOUT",
      country: "GH",
      paymentMethodType: "gh_mobile_money",
      observedCoverage: [payoutRecord],
      satisfiedRequirementFields: [],
    });
    expect(blocked.eligible).toBe(false);
    expect(blocked.basis).toBe("PRECONDITIONS_UNSATISFIED");
    expect(blocked.unsatisfied).toEqual(["phone_number", "recipient_name"]);
    const ok = rapydCoverageEligibility({
      surface: "PAYOUT",
      country: "GH",
      paymentMethodType: "gh_mobile_money",
      observedCoverage: [payoutRecord],
      satisfiedRequirementFields: ["phone_number", "recipient_name"],
    });
    expect(ok.eligible).toBe(true);
    expect(ok.basis).toBe("OBSERVED_AND_PRECONDITIONS_SATISFIED");
  });

  it("country matching is case-insensitive; unknown countries stay UNKNOWN", () => {
    const verdict = rapydCoverageEligibility({
      surface: "PAY_IN",
      country: "gh",
      paymentMethodType: "ug_mobilemoney_ussd",
      observedCoverage: [payinRecord([])],
      satisfiedRequirementFields: [],
    });
    expect(verdict.country).toBe("GH");
    expect(verdict.eligible).toBe(true);
    const other = rapydCoverageEligibility({
      surface: "PAY_IN",
      country: "FR",
      paymentMethodType: "ug_mobilemoney_ussd",
      observedCoverage: [payinRecord([])],
      satisfiedRequirementFields: [],
    });
    expect(other.basis).toBe("NO_CONNECTED_INSTANCE_EVIDENCE");
  });

  it("requirements normalization handles arrays of names, { required_fields }, { fields } objects and objects with names", () => {
    expect(rapydPaymentMethodRequirements(["proof_of_id", "document_ssn"])).toEqual([
      { fieldName: "proof_of_id", required: true },
      { fieldName: "document_ssn", required: true },
    ]);
    expect(rapydPaymentMethodRequirements({ required_fields: ["proof_of_id"] })).toEqual([
      { fieldName: "proof_of_id", required: true },
    ]);
    expect(rapydPaymentMethodRequirements({ fields: [{ name: "proof_of_id", required: false }] })[0]).toMatchObject({
      fieldName: "proof_of_id",
      required: false,
    });
    expect(rapydPaymentMethodRequirements({ unrecognized: true })).toEqual([]);
    expect(rapydPaymentMethodRequirements(null)).toEqual([]);
  });

  it("beneficiary requirements are extracted from observed payout method types verbatim", () => {
    const requirements = rapydBeneficiaryRequirements("gh_mobile_money", {
      payout_method_type: "gh_mobile_money",
      fields: [{ field_name: "phone_number", required: true }, "recipient_name"],
    });
    expect(requirements.map((r) => r.fieldName)).toEqual(["phone_number", "recipient_name"]);
    expect(requirements[0]).toMatchObject({ payoutMethodType: "gh_mobile_money", required: true });
    expect(rapydBeneficiaryRequirements("gh_mobile_money", { type: "gh_mobile_money" })).toEqual([]);
    expect(rapydBeneficiaryRequirements("gh_mobile_money", null)).toEqual([]);
  });

  it("a coverage observation envelope is lossless and names the (surface, country) pair", () => {
    const methods = [{ type: "ug_mobilemoney_ussd" }, { type: "mastercard" }];
    const envelope = rapydCoverageEnvelope("PAY_IN", "gh", methods, CTX);
    expect(envelope.object.objectType).toBe("payment_methods_by_country");
    expect(envelope.object.externalId).toBe("pm-by-country:GH");
    expect((envelope.state as { data: unknown[] }).data).toHaveLength(2);
    expect(parseProviderStateEnvelope(serializeProviderStateEnvelope(envelope))).toEqual(envelope);
  });
});

// ---------------------------------------------------------------------------
// 3. Request signing — the documented salt/timestamp HMAC canonicalization
// ---------------------------------------------------------------------------

describe("rapyd request signing (documented canonicalization, synthetic keys)", () => {
  it("sorted-JSON canonicalization sorts keys recursively and is deterministic", () => {
    expect(rapydSortedJsonString({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(rapydSortedJsonString({ b: 1, a: { d: 2, c: 3 } })).toBe(rapydSortedJsonString({ a: { c: 3, d: 2 }, b: 1 }));
    expect(rapydSortedJsonString([2, 1])).toBe("[2,1]"); // array order preserved
    expect(rapydSortedJsonString("x")).toBe('"x"');
    expect(rapydSortedJsonString(null)).toBe("null");
  });

  it("the string_to_sign is exactly lowercased(url_path)+salt+timestamp+access_key+secret_key+body_string", () => {
    const stringToSign = rapydStringToSign({
      urlPath: "/V1/PAYMENTS",
      salt: "SALT123",
      timestamp: "1696224000",
      accessKey: "AK123",
      secretKey: "SK123",
      bodyString: '{"a":1}',
    });
    expect(stringToSign).toBe("/v1/paymentsSALT1231696224000AK123SK123{\"a\":1}");
  });

  it("signature headers carry salt/timestamp/access_key/signature and match an independent HMAC recomputation", () => {
    const body = { amount: 12.5, currency: "USD", metadata: { payswap_idempotency_key: "idem-1" } };
    const headers = rapydSignatureHeaders({
      urlPath: "/v1/payments",
      salt: "SALT123",
      timestamp: "1696224000",
      accessKey: SYNTHETIC_ACCESS_KEY,
      secretKey: SYNTHETIC_SECRET_KEY,
      body,
    });
    expect(headers.access_key).toBe(SYNTHETIC_ACCESS_KEY);
    expect(headers.salt).toBe("SALT123");
    expect(headers.timestamp).toBe("1696224000");
    expect(headers["Content-Type"]).toBe("application/json");
    // Independent recomputation with the documented canonicalization:
    const expected = createHmac("sha256", SYNTHETIC_SECRET_KEY)
      .update(`/v1/paymentsSALT1231696224000${SYNTHETIC_ACCESS_KEY}${SYNTHETIC_SECRET_KEY}${rapydSortedJsonString(body)}`)
      .digest("hex");
    expect(headers.signature).toBe(expected);
    expect(headers.signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it("GET requests sign the empty body string; any input change changes the signature", () => {
    const get = rapydSignatureHeaders({
      urlPath: "/v1/payment_methods_by_country",
      salt: "SALT123",
      timestamp: "1696224000",
      accessKey: SYNTHETIC_ACCESS_KEY,
      secretKey: SYNTHETIC_SECRET_KEY,
    });
    const tampered = rapydSignatureHeaders({
      urlPath: "/v1/payment_methods_by_country",
      salt: "SALT124", // one different character
      timestamp: "1696224000",
      accessKey: SYNTHETIC_ACCESS_KEY,
      secretKey: SYNTHETIC_SECRET_KEY,
    });
    expect(get.signature).not.toBe(tampered.signature);
    const withBody = rapydSignatureHeaders({
      urlPath: "/v1/payment_methods_by_country",
      salt: "SALT123",
      timestamp: "1696224000",
      accessKey: SYNTHETIC_ACCESS_KEY,
      secretKey: SYNTHETIC_SECRET_KEY,
      body: { a: 1 },
    });
    expect(get.signature).not.toBe(withBody.signature);
  });

  it("the secret key never appears as a header value", () => {
    const headers = rapydSignatureHeaders({
      urlPath: "/v1/payments",
      salt: "SALT123",
      timestamp: "1696224000",
      accessKey: SYNTHETIC_ACCESS_KEY,
      secretKey: SYNTHETIC_SECRET_KEY,
      body: { a: 1 },
    });
    expect(Object.values(headers).join(" ")).not.toContain(SYNTHETIC_SECRET_KEY);
  });
});

// ---------------------------------------------------------------------------
// 4. Status mapping + envelope losslessness (INV-C06)
// ---------------------------------------------------------------------------

describe("rapyd payment lifecycle → ProviderStateEnvelope (lossless, INV-C06)", () => {
  const payment = (
    status: string,
    overrides: Partial<RapydPaymentProviderObject> = {},
  ): RapydPaymentProviderObject => ({
    id: "pay_SYNTHETIC_0001",
    status,
    amount: 12.5,
    currency: "USD",
    ...overrides,
  });

  it("maps every payment status in the recorded table with the exact classification", () => {
    for (const row of RAPYD_PAYMENT_STATUS_MAPPING) {
      const envelope = rapydPaymentEnvelope(payment(row.providerState), CTX);
      expect(envelope.classification.family).toBe(row.family);
      expect(envelope.classification.lifecycleStep).toBe(row.lifecycleStep);
      expect(envelope.classification.isTerminal).toBe(row.isTerminal);
      expect(envelope.classification.requiresCustomerAction).toBe(row.requiresCustomerAction);
      expect((envelope.state as { status: string }).status).toBe(row.providerState);
    }
  });

  it("maps every payout status into the payout family with the exact classification", () => {
    const payout = (status: string): RapydPayoutProviderObject => ({
      id: "payout_SYNTHETIC_0001",
      status,
      amount: 45,
      currency: "GHS",
      payout_method_type: "gh_mobile_money",
    });
    for (const row of RAPYD_PAYOUT_STATUS_MAPPING) {
      const envelope = rapydPayoutEnvelope(payout(row.providerState), CTX);
      expect(envelope.classification.family).toBe(row.family);
      expect(envelope.classification.lifecycleStep).toBe(row.lifecycleStep);
      expect(envelope.classification.isTerminal).toBe(row.isTerminal);
      expect((envelope.state as { status: string }).status).toBe(row.providerState);
    }
  });

  it("carries the provider payment id as the external id and preserves provider identity/version", () => {
    const envelope = rapydPaymentEnvelope(payment("ACT"), CTX);
    expect(envelope.provider.name).toBe("rapyd");
    expect(envelope.provider.version).toBe(RAPYD_API_VERSION);
    expect(envelope.object.objectType).toBe("payment");
    expect(envelope.object.externalId).toBe("pay_SYNTHETIC_0001");
    expect(rapydPaymentRevision(payment("ACT"))).toContain("no_next_action");
  });

  it("payment_method_data.next_action with a redirect makes ACT customer-action-required first-class", () => {
    const envelope = rapydPaymentEnvelope(
      payment("ACT", {
        payment_method_data: { next_action: { redirect_url: "https://checkout.rapyd.net/synthetic" } },
      }),
      CTX,
    );
    expect(envelope.classification.family).toBe("customer_action_required");
    expect(envelope.classification.requiresCustomerAction).toBe(true);
    expect(envelope.classification.isTerminal).toBe(false);
    expect(envelope.actionRequired?.kind).toBe("PROVIDER_CHALLENGE_REDIRECT");
    expect(envelope.actionRequired?.deepLink).toBe("https://checkout.rapyd.net/synthetic");
    expect(rapydPaymentRevision(payment("ACT", { payment_method_data: { next_action: { redirect_url: "https://x" } } }))).toContain("next_action");
  });

  it("CLO is terminal (completed); ERR/EXP carry definitive failure metadata", () => {
    expect(rapydPaymentEnvelope(payment("CLO"), CTX).classification.isTerminal).toBe(true);
    const err = rapydPaymentEnvelope(payment("ERR"), CTX);
    expect(err.classification.isTerminal).toBe(true);
    expect(err.failure?.ambiguity).toBe("NONE");
    expect(err.failure?.providerErrorCode).toBe("payment_ERR");
    const exp = rapydPaymentEnvelope(payment("EXP"), CTX);
    expect(exp.failure?.retryable).toBe(false);
  });

  it("an unmapped status stays non-terminal other (UNKNOWN, never FAILED)", () => {
    const envelope = rapydPaymentEnvelope(payment("brand_new_status"), CTX);
    expect(envelope.classification.family).toBe("other");
    expect(envelope.classification.isTerminal).toBe(false);
    expect((envelope.state as { status: string }).status).toBe("brand_new_status");
  });

  it("lossless round-trip through serialize/parse for payment and payout (INV-C06)", () => {
    const pay = rapydPaymentEnvelope(payment("ACT"), CTX);
    expect(parseProviderStateEnvelope(serializeProviderStateEnvelope(pay))).toEqual(pay);
    const payout = rapydPayoutEnvelope({ id: "payout_1", status: "CLO", amount: 1, currency: "GHS" }, CTX);
    expect(parseProviderStateEnvelope(serializeProviderStateEnvelope(payout))).toEqual(payout);
    expect(rapydPayoutRevision({ id: "payout_1", status: "CLO" })).toBe("payout_1:CLO");
  });

  it("webhook payloads map to the inner object; unknown event types carry the WHOLE payload verbatim", () => {
    const paymentEvent = rapydWebhookEventEnvelope(
      { id: "evt_1", type: "PAYMENT_COMPLETED", body: { payment: payment("CLO") } },
      WEBHOOK_CTX,
    );
    expect(paymentEvent.object.objectType).toBe("payment");
    expect(paymentEvent.provenance.source).toBe("PROVIDER_WEBHOOK");
    const other = rapydWebhookEventEnvelope({ id: "evt_2", type: "SOMETHING_ELSE", body: { x: 1 } }, WEBHOOK_CTX);
    expect(other.object.objectType).toBe("event");
    expect(other.state).toMatchObject({ id: "evt_2", type: "SOMETHING_ELSE" });
  });
});

// ---------------------------------------------------------------------------
// 5. Wallet observation (INV-C09 — observation only, exact minor units)
// ---------------------------------------------------------------------------

describe("rapyd wallet observation (INV-C09, INV-F01)", () => {
  it("produces a validated ExternalFundsPositionObservation ONLY (never custody)", () => {
    const wallet: RapydWalletProviderObject = { id: "wal_SYNTHETIC_1", balance: 123.45, currency: "USD" };
    const { observation, unconverted } = rapydWalletObservation({
      wallet,
      accountRef: "vault:PROVIDER_RAPYD_CREDENTIAL_REF",
      observedAt: T0,
    });
    expect(unconverted).toBeUndefined();
    expect(observation?.observedAmount.currency).toBe("USD");
    expect(observation?.observedAmount.minorUnits).toBe("12345");
    expect(() => validateExternalFundsPositionObservation(observation!)).not.toThrow();
    expect(observation?.location.description).toContain("never custody");
  });

  it("exact minor-unit conversion per exponent; sub-minor precision and unknown exponents are honest refusals", () => {
    expect(rapydMinorUnits("100.00", "GHS")).toBe("10000");
    expect(rapydMinorUnits("1234.00", "JPY")).toBe("1234");
    expect(() => rapydMinorUnits("1234.56", "JPY")).toThrow(/sub-minor/);
    expect(() => rapydMinorUnits("10.00", "XYZ")).toThrow(/unknown minor-unit exponent/);
    const { observation, unconverted } = rapydWalletObservation({
      wallet: { id: "wal_2", balance: "1.005", currency: "KES" },
      accountRef: "vault:rapyd",
      observedAt: T0,
    });
    expect(observation).toBeUndefined();
    expect(unconverted).toMatchObject({ currency: "KES", reason: "SUB_MINOR_PRECISION" });
    const unknownCurrency = rapydWalletObservation({
      wallet: { id: "wal_3", balance: 5, currency: "XYZ" },
      accountRef: "vault:rapyd",
      observedAt: T0,
    });
    expect(unknownCurrency.unconverted).toMatchObject({ currency: "XYZ", reason: "UNKNOWN_EXPONENT" });
    const malformed = rapydWalletObservation({
      wallet: { id: "wal_4" },
      accountRef: "vault:rapyd",
      observedAt: T0,
    });
    expect(malformed.unconverted).toMatchObject({ reason: "MALFORMED_BALANCE" });
  });
});

// ---------------------------------------------------------------------------
// 6. Webhook verification (the salt/timestamp HMAC construction)
// ---------------------------------------------------------------------------

describe("rapyd webhook verification (salt+timestamp+body HMAC)", () => {
  const rawBody = JSON.stringify({
    id: "evt_SYNTHETIC_1",
    type: "PAYMENT_COMPLETED",
    body: { payment: { id: "pay_SYNTHETIC_0001", status: "CLO" } },
    timestamp: 1765000000,
  });
  const payload = JSON.parse(rawBody) as unknown;
  const salt = "SALT_WEBHOOK_1";
  const timestamp = "1765000000";

  function delivery(signature: string | undefined, overrides: { salt?: string | undefined; timestamp?: string | undefined } = {}) {
    return {
      saltHeader: overrides.salt !== undefined ? overrides.salt : salt,
      timestampHeader: overrides.timestamp !== undefined ? overrides.timestamp : timestamp,
      signatureHeader: signature,
      rawBody,
    };
  }

  it("a valid signature verifies (constant-time compare)", () => {
    const signature = rapydWebhookSignature(SYNTHETIC_WEBHOOK_SECRET, salt, timestamp, rawBody);
    expect(verifyRapydWebhookDelivery(delivery(signature), { secret: SYNTHETIC_WEBHOOK_SECRET })).toEqual({ valid: true });
  });

  it("a tampered body, wrong secret, wrong salt and wrong timestamp all fail", () => {
    const signature = rapydWebhookSignature(SYNTHETIC_WEBHOOK_SECRET, salt, timestamp, rawBody);
    expect(
      verifyRapydWebhookDelivery(delivery(signature), { secret: "whsec_OTHER_SYNTHETIC_SECRET" }),
    ).toMatchObject({ valid: false, reason: "SIGNATURE_INVALID" });
    const tamperedBody = `${rawBody} `;
    const tamperedSignature = rapydWebhookSignature(SYNTHETIC_WEBHOOK_SECRET, salt, timestamp, tamperedBody);
    expect(
      verifyRapydWebhookDelivery(
        { saltHeader: salt, timestampHeader: timestamp, signatureHeader: tamperedSignature, rawBody },
        { secret: SYNTHETIC_WEBHOOK_SECRET },
      ),
    ).toMatchObject({ valid: false });
    expect(
      verifyRapydWebhookDelivery(delivery(signature, { salt: "OTHER_SALT" }), { secret: SYNTHETIC_WEBHOOK_SECRET }),
    ).toMatchObject({ valid: false });
    expect(
      verifyRapydWebhookDelivery(delivery(signature, { timestamp: "1765000001" }), { secret: SYNTHETIC_WEBHOOK_SECRET }),
    ).toMatchObject({ valid: false });
  });

  it("missing salt/timestamp/signature parts fail closed with MISSING_SIGNATURE_PARTS", () => {
    expect(verifyRapydWebhookDelivery(delivery(undefined), { secret: SYNTHETIC_WEBHOOK_SECRET })).toEqual({
      valid: false,
      reason: "MISSING_SIGNATURE_PARTS",
    });
    expect(
      verifyRapydWebhookDelivery(delivery("x", { salt: "" }), { secret: SYNTHETIC_WEBHOOK_SECRET }),
    ).toMatchObject({ valid: false, reason: "MISSING_SIGNATURE_PARTS" });
    expect(
      verifyRapydWebhookDelivery(delivery("x", { timestamp: "" }), { secret: SYNTHETIC_WEBHOOK_SECRET }),
    ).toMatchObject({ valid: false, reason: "MISSING_SIGNATURE_PARTS" });
  });

  it("the event id is the (type, id) pair and the timestamp is the provider-declared one", () => {
    expect(rapydWebhookEventId(payload)).toBe("PAYMENT_COMPLETED:evt_SYNTHETIC_1");
    expect(rapydWebhookEventId(null)).toBeUndefined();
    expect(rapydWebhookEventId({ id: "x" })).toBeUndefined();
    expect(rapydWebhookEventId({ type: "T", id: 7 })).toBe("T:7");
    expect(rapydWebhookEventTimestamp(payload)).toBe("1765000000");
    expect(rapydWebhookEventTimestamp({ timestamp: 1765000000.9 })).toBe("1765000000");
    expect(rapydWebhookEventTimestamp({})).toBeUndefined();
  });

  it("the verifier on the WebhookSignatureVerifier hook decodes salt|signature and verifies the RAW body", () => {
    const verifier = new RapydWebhookVerifier(SYNTHETIC_WEBHOOK_SECRET);
    const signature = rapydWebhookSignature(SYNTHETIC_WEBHOOK_SECRET, salt, timestamp, rawBody);
    const event = rapydWebhookRawEvent({
      eventId: "evt_SYNTHETIC_1",
      payload,
      saltHeader: salt,
      timestampHeader: timestamp,
      signatureHeader: signature,
      timestampSeconds: timestamp,
    });
    expect(event.headers.signature).toBe(`${salt}${RAPYD_WEBHOOK_SIGNATURE_SEPARATOR}${signature}`);
    expect(verifier.verify(event, rawBody)).toEqual({ valid: true });
    // a tampered canonical body fails (the signature was over the original):
    expect(verifier.verify(event, `${rawBody}x`)).toMatchObject({ valid: false });
    // a signature computed over a DIFFERENT body fails against this body:
    const tampered = rapydWebhookRawEvent({
      eventId: "evt_SYNTHETIC_1",
      payload,
      saltHeader: salt,
      timestampHeader: timestamp,
      signatureHeader: rapydWebhookSignature(SYNTHETIC_WEBHOOK_SECRET, salt, timestamp, `${rawBody}x`),
      timestampSeconds: timestamp,
    });
    expect(verifier.verify(tampered, rawBody)).toMatchObject({ valid: false });
    const malformed = rapydWebhookRawEvent({
      eventId: "evt_SYNTHETIC_1",
      payload,
      saltHeader: "",
      timestampHeader: timestamp,
      signatureHeader: "noseparator",
      timestampSeconds: timestamp,
    });
    expect(verifier.verify(malformed, rawBody)).toMatchObject({ valid: false, reason: "MISSING_SIGNATURE_PARTS" });
  });

  it("the ingestor deduplicates a replayed (provider, eventId) pair", () => {
    const signature = rapydWebhookSignature(SYNTHETIC_WEBHOOK_SECRET, salt, timestamp, rawBody);
    const ingestor = createRapydWebhookIngestor({ secret: SYNTHETIC_WEBHOOK_SECRET, clock: CLOCK });
    const rawEvent = rapydWebhookRawEvent({
      payload,
      saltHeader: salt,
      timestampHeader: timestamp,
      signatureHeader: signature,
      eventId: "evt_SYNTHETIC_1",
      timestampSeconds: timestamp,
    });
    const first = ingestor.ingest(rawEvent);
    expect(first.kind).not.toBe("REJECTED");
    const replay = ingestor.ingest(rawEvent);
    expect(replay.kind).toBe("ALREADY_INGESTED");
  });
});

// ---------------------------------------------------------------------------
// 7. Idempotency derivation (INV-F05)
// ---------------------------------------------------------------------------

describe("rapyd idempotency derivation (INV-F05)", () => {
  it("derives the deterministic client reference from the protocol key", () => {
    expect(rapydClientReference("order-9")).toBe("payswap:order-9");
    expect(rapydClientReference("order-9")).toBe("payswap:order-9");
    expect(() => rapydClientReference("")).toThrow();
    expect(() => rapydClientReference("x")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 8. Fail-closed credential gating (INV-NC04, INV-C01/C02)
// ---------------------------------------------------------------------------

describe("rapyd connector — fail-closed credential gating", () => {
  it("no credential: availability UNKNOWN with provenance, never routable", () => {
    const transport = new ScriptedHttpTransport(() => jsonResponse(401, { status: { status: "ERROR", error_code: "UNAUTHENTICATED_API_CALL", message: "bad access key" } }));
    const connector = new RapydConnector({ clock: CLOCK, http: transport.transport });
    const observation = connector.availabilityObservation({
      instanceId: "inst-rails-rapyd-1",
      observationVersion: 1,
    });
    expect(observation.availability).toBe("UNKNOWN");
    expect(observation.sourceAvailability).toBe("UNKNOWN");
    const implication = connector.railImplication(observation.availability);
    expect(implication.routable).toBe(false);
    expect(implication.reason).toContain("INV-NC04");
  });

  it("no credential: health is DEGRADED when the endpoint answers (the recorded 401 datum) or UNKNOWN when transport-dead", async () => {
    const answering = new ScriptedHttpTransport(() => jsonResponse(401, {}));
    const degraded = await new RapydConnector({ clock: CLOCK, http: answering.transport }).health();
    expect(degraded.status).toBe("DEGRADED");
    expect(degraded.degradedReasons[0]).toContain("credentials absent");
    expect(degraded.degradedReasons[0]).toContain("INV-C01/C02");
    const dead = new ScriptedHttpTransport(() => {
      throw new Error("network down");
    });
    const unknown = await new RapydConnector({ clock: CLOCK, http: dead.transport }).health();
    expect(unknown.status).toBe("UNKNOWN");
  });

  it("no credential: effectful operations throw RailNotAuthorizedError BEFORE any provider call", async () => {
    const transport = new ScriptedHttpTransport(() => jsonResponse(200, {}));
    const connector = new RapydConnector({ clock: CLOCK, http: transport.transport });
    await expect(
      connector.create(ctx(AUTHORITY, { kind: "create_payment", amountMajor: "10", currency: "USD", paymentMethodType: "mastercard" })),
    ).rejects.toThrow(RailNotAuthorizedError);
    await expect(
      connector.executeAction(ctx(AUTHORITY, { kind: "create_payout", payoutMethodType: "gh_mobile_money", amountMajor: "1", currency: "GHS", beneficiary: {} })),
    ).rejects.toThrow(RailNotAuthorizedError);
    await expect(
      connector.executeAction(ctx(AUTHORITY, { kind: "create_beneficiary", payoutMethodType: "gh_mobile_money", fields: {} })),
    ).rejects.toThrow(RailNotAuthorizedError);
    await expect(
      connector.read(ctx(AUTHORITY, { kind: "read_payment", paymentId: "pay_1" })),
    ).rejects.toThrow(RailNotAuthorizedError);
    await expect(connector.observePayInCoverage("GH")).rejects.toThrow(RailNotAuthorizedError);
    await expect(connector.observePayoutCoverage("GH")).rejects.toThrow(RailNotAuthorizedError);
    await expect(connector.observePaymentMethodRequirements("mastercard")).rejects.toThrow(RailNotAuthorizedError);
    await expect(connector.observeWallet("wal_1")).rejects.toThrow(RailNotAuthorizedError);
    expect(transport.calls).toHaveLength(0); // fail-closed BEFORE any provider call
  });

  it("credentialResolutionState is honest; the env fallback refuses malformed material", async () => {
    const none = new RapydConnector({ clock: CLOCK });
    expect(none.credentialResolutionState()).toMatchObject({
      kind: "NOT_PROVISIONED",
      configKey: "PROVIDER_RAPYD_CREDENTIAL_REF",
    });
    const envConnector = new RapydConnector({
      clock: CLOCK,
      http: new ScriptedHttpTransport(() => jsonResponse(200, {})).transport,
      env: { PROVIDER_RAPYD_CREDENTIAL_REF: SYNTHETIC_ENV_MATERIAL },
    });
    expect(envConnector.credentialResolutionState().kind).toBe("ENV_RESOLVED_MATERIAL");
    expect(JSON.stringify(envConnector.credentialResolutionState())).not.toContain(SYNTHETIC_SECRET_KEY);
    const malformed = new RapydConnector({
      clock: CLOCK,
      http: new ScriptedHttpTransport(() => jsonResponse(200, {})).transport,
      env: { PROVIDER_RAPYD_CREDENTIAL_REF: "not-json-at-all" },
    });
    await expect(malformed.read(ctx(AUTHORITY, { kind: "read_payment", paymentId: "pay_1" }))).rejects.toThrow(
      ValidationError,
    );
  });

  it("credential surface declares the control-plane config key; rotation without a path refuses", async () => {
    const connector = new RapydConnector({ clock: CLOCK });
    expect(connector.credentialSurface()).toEqual([
      { envVar: "PROVIDER_RAPYD_CREDENTIAL_REF", kind: "API_KEY" },
    ]);
    await expect(
      connector.rotateCredentials(ctx(AUTHORITY, { kind: "credential_rotation" })),
    ).rejects.toThrow(RailNotAuthorizedError);
  });

  it("the sealed bundle material shape is validated ({access_key, secret_key}; anything else refuses)", () => {
    expect(extractRapydCredentialMaterial({ access_key: "a", secret_key: "s" })).toEqual({
      accessKey: "a",
      secretKey: "s",
    });
    expect(extractRapydCredentialMaterial({ accessKey: "a", secretKey: "s" })).toEqual({
      accessKey: "a",
      secretKey: "s",
    });
    expect(() => extractRapydCredentialMaterial("raw-string")).toThrow();
    expect(() => extractRapydCredentialMaterial({ access_key: "a" })).toThrow();
    expect(() => extractRapydCredentialMaterial({ unrelated: true })).toThrow();
  });

  it("unmapped SDK requests and invalid amounts are ValidationErrors (never provider guesses)", async () => {
    const connector = new RapydConnector({
      clock: CLOCK,
      http: new ScriptedHttpTransport(() => jsonResponse(200, {})).transport,
      env: { PROVIDER_RAPYD_CREDENTIAL_REF: SYNTHETIC_ENV_MATERIAL },
    });
    await expect(connector.read(ctx(AUTHORITY, { kind: "nonsense" }))).rejects.toThrow(ValidationError);
    await expect(
      connector.create(ctx(AUTHORITY, { kind: "create_payout", payoutMethodType: "x", amountMajor: "1", currency: "GHS", beneficiary: {} })),
    ).rejects.toThrow(ValidationError);
    await expect(
      connector.create(ctx(AUTHORITY, { kind: "create_payment", amountMajor: "10.5.3", currency: "USD", paymentMethodType: "x" })),
    ).rejects.toThrow(ValidationError);
    await expect(connector.search(ctx(AUTHORITY, { kind: "search" }))).rejects.toThrow(ValidationError);
    await expect(
      connector.create(ctx(AUTHORITY, { kind: "create_payment", amountMajor: "10", currency: "USD" })),
    ).rejects.toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// 9. Connector happy paths (synthetic env material, scripted transport)
// ---------------------------------------------------------------------------

describe("rapyd connector — provider calls with synthetic credentials (offline)", () => {
  function envConnector(
    respond: (url: string, init: { method: string; body?: string }) => { status: number; bodyText: string },
  ): { connector: RapydConnector; transport: ScriptedHttpTransport } {
    const transport = new ScriptedHttpTransport(respond);
    return {
      connector: new RapydConnector({
        clock: CLOCK,
        http: transport.transport,
        env: { PROVIDER_RAPYD_CREDENTIAL_REF: SYNTHETIC_ENV_MATERIAL },
      }),
      transport,
    };
  }

  it("create_payment POSTs to /v1/payments with signed headers, metadata reference and maps the answer", async () => {
    const { connector, transport } = envConnector(() =>
      rapydSuccess({ id: "pay_NEW_1", status: "ACT", amount: 10, currency: "USD" }),
    );
    const result = await connector.create(
      ctx(AUTHORITY, { kind: "create_payment", amountMajor: "10", currency: "usd", paymentMethodType: "mastercard" }, "idem-pay-1"),
    );
    expect(transport.calls).toHaveLength(1);
    const call = transport.calls[0]!;
    expect(call.url).toBe(`${RAPYD_DEFAULT_API_BASE_SANDBOX}/v1/payments`);
    expect(call.method).toBe("POST");
    const body = JSON.parse(call.body ?? "{}") as Record<string, unknown>;
    expect(body.metadata).toMatchObject({
      payswap_idempotency_key: "idem-pay-1",
      client_reference: "payswap:idem-pay-1",
    });
    expect((body.payment_method as { type: string }).type).toBe("mastercard");
    expect(result.providerState.object.externalId).toBe("pay_NEW_1");
    expect(result.providerState.classification.family).toBe("async_processing");
    expect(result.evidence.evidenceRef).toBe("payment:pay_NEW_1");
  });

  it("read_payment GETs the signed payment path; reconcile re-fetches (INV-X03)", async () => {
    const { connector, transport } = envConnector(() =>
      rapydSuccess({ id: "pay_X", status: "CLO", amount: 10, currency: "USD" }),
    );
    const result = await connector.read(
      ctx(AUTHORITY, { kind: "read_payment", paymentId: "pay_X" }, "idem-read-1"),
    );
    expect(transport.calls[0]?.url).toBe(`${RAPYD_DEFAULT_API_BASE_SANDBOX}/v1/payments/pay_X`);
    expect(result.providerState.classification.isTerminal).toBe(true);
    const reconciled = await connector.reconcile(
      ctx(AUTHORITY, { kind: "read_payment", paymentId: "pay_X" }, "idem-read-2"),
    );
    expect(reconciled.providerState.object.externalId).toBe("pay_X");
    expect(transport.calls).toHaveLength(2);
  });

  it("create_payout POSTs to /v1/payouts with payout_method_type + beneficiary; create_beneficiary to /v1/beneficiaries", async () => {
    const { connector, transport } = envConnector((url) => {
      if (url.endsWith("/v1/beneficiaries")) {
        return rapydSuccess({ id: "bene_1", payout_method_type: "gh_mobile_money", status: "ACT" });
      }
      return rapydSuccess({ id: "payout_NEW_1", status: "ACT", payout_method_type: "gh_mobile_money" });
    });
    const payout = await connector.executeAction(
      ctx(AUTHORITY, { kind: "create_payout", payoutMethodType: "gh_mobile_money", amountMajor: "5", currency: "GHS", beneficiary: { phone_number: "synthetic" } }, "idem-payout-1"),
    );
    expect(payout.providerState.object.objectType).toBe("payout");
    expect(payout.providerState.classification.family).toBe("payout");
    const body = JSON.parse(transport.calls[0]?.body ?? "{}") as Record<string, unknown>;
    expect(body.payout_method_type).toBe("gh_mobile_money");
    expect(body.beneficiary).toEqual({ phone_number: "synthetic" });
    const beneficiary = await connector.executeAction(
      ctx(AUTHORITY, { kind: "create_beneficiary", payoutMethodType: "gh_mobile_money", fields: { phone_number: "synthetic" } }, "idem-bene-1"),
    );
    expect(beneficiary.providerState.object.objectType).toBe("beneficiary");
    expect(transport.calls[1]?.url).toContain("/v1/beneficiaries");
  });

  it("observePayInCoverage queries the connected account and builds coverage records (the ONLY coverage source)", async () => {
    const { connector, transport } = envConnector(() =>
      rapydSuccess([{ type: "mastercard", name: "Mastercard" }, { type: "ug_mobilemoney_ussd", name: "Uganda Mobile Money" }]),
    );
    const { records, envelope } = await connector.observePayInCoverage("gh");
    expect(transport.calls[0]?.url).toContain("/v1/payment_methods_by_country?country=GH");
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ surface: "PAY_IN", country: "GH", source: "CONNECTED_ACCOUNT_QUERY" });
    expect(records[0]?.paymentMethodType).toBe("mastercard");
    expect(envelope.object.objectType).toBe("payment_methods_by_country");
  });

  it("observePayoutCoverage queries the separate payout surface (never inferred from pay-in)", async () => {
    const { connector, transport } = envConnector(() =>
      rapydSuccess([{ payout_method_type: "gh_mobile_money", fields: [{ field_name: "phone_number", required: true }] }]),
    );
    const { records } = await connector.observePayoutCoverage("GH");
    expect(transport.calls[0]?.url).toContain("/v1/payouts/method_types?country=GH");
    expect(records[0]?.surface).toBe("PAYOUT");
    const eligibility = rapydCoverageEligibility({
      surface: "PAYOUT",
      country: "GH",
      paymentMethodType: "gh_mobile_money",
      observedCoverage: records,
      satisfiedRequirementFields: [],
    });
    expect(eligibility.basis).toBe("PRECONDITIONS_UNSATISFIED");
    expect(eligibility.unsatisfied).toEqual(["phone_number"]);
  });

  it("observePaymentMethodRequirements preserves the KYC fields as preconditions", async () => {
    const { connector, transport } = envConnector(() =>
      rapydSuccess({ required_fields: ["proof_of_id", "document_ssn"] }),
    );
    const { requirements, envelope } = await connector.observePaymentMethodRequirements("mastercard");
    expect(transport.calls[0]?.url).toContain("/v1/payment_method_types/mastercard/requirements");
    expect(requirements.map((r) => r.fieldName)).toEqual(["proof_of_id", "document_ssn"]);
    expect((envelope.state as { preconditions: { fieldName: string }[] }).preconditions).toHaveLength(2);
  });

  it("observeWallet maps the wallet to an ExternalFundsPositionObservation ONLY", async () => {
    const { connector, transport } = envConnector(() =>
      rapydSuccess({ id: "wal_SYNTHETIC_9", balance: 1000.01, currency: "KES" }),
    );
    const { observation, unconverted, envelope } = await connector.observeWallet("wal_SYNTHETIC_9");
    expect(transport.calls[0]?.url).toContain("/v1/user/wallets/wal_SYNTHETIC_9");
    expect(observation?.observedAmount).toEqual({ currency: "KES", minorUnits: "100001" });
    expect(unconverted).toBeUndefined();
    expect(() => validateExternalFundsPositionObservation(observation!)).not.toThrow();
    expect(envelope.object.objectType).toBe("wallet");
  });

  it("a provider error answer is a RailProviderError (never a fabricated outcome)", async () => {
    const { connector } = envConnector(() =>
      jsonResponse(400, { status: { status: "ERROR", error_code: "VALIDATION_ERROR", message: "bad amount" }, data: null }),
    );
    await expect(
      connector.read(ctx(AUTHORITY, { kind: "read_payment", paymentId: "pay_BAD" })),
    ).rejects.toThrow(RailProviderError);
  });

  it("a mid-effect transport failure produces an OUTCOME_UNKNOWN envelope — NEVER FAILED (INV-X01)", async () => {
    const { connector } = envConnector(() => {
      throw new Error("connection reset");
    });
    const result = await connector.create(
      ctx(AUTHORITY, { kind: "create_payment", amountMajor: "10", currency: "USD", paymentMethodType: "mastercard" }, "idem-x01"),
    );
    expect(result.providerState.classification.lifecycleStep).toBe("outcome_unknown");
    expect(result.providerState.classification.isTerminal).toBe(false);
    expect(result.providerState.failure?.ambiguity).toBe("OUTCOME_UNKNOWN");
    expect((result.providerState.state as { note: string }).note).toContain("never coerced to FAILED");
    expect(
      parseProviderStateEnvelope(serializeProviderStateEnvelope(result.providerState)),
    ).toEqual(result.providerState);
  });

  it("no key material ever appears in envelopes, evidence, health or coverage records", async () => {
    const { connector } = envConnector(() =>
      rapydSuccess({ id: "pay_SEC", status: "ACT", amount: 1, currency: "USD" }),
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
      expect(serialized).not.toContain(SYNTHETIC_ACCESS_KEY);
      expect(serialized).not.toContain(SYNTHETIC_SECRET_KEY);
    }
  });

  it("the control-plane path opens the sealed bundle per call (SEALED state; material never surfaces)", async () => {
    const store = new FixtureVaultStore();
    store.bind(RAPYD_CREDENTIAL_CONFIG_KEY, VAULT_REF);
    store.seal(VAULT_REF, { access_key: SYNTHETIC_ACCESS_KEY, secret_key: SYNTHETIC_SECRET_KEY });
    const broker = new CredentialBroker({ store });
    const runtimeKey = broker.registerConnectorRuntime("runtime.rapyd.test");
    const transport = new ScriptedHttpTransport(() =>
      rapydSuccess({ id: "pay_CP", status: "ACT", amount: 1, currency: "USD" }),
    );
    const connector = new RapydConnector({
      clock: CLOCK,
      http: transport.transport,
      credentials: { broker, runtimeKey },
    });
    expect(connector.credentialResolutionState()).toMatchObject({ kind: "CONTROL_PLANE_SEALED" });
    const result = await connector.read(ctx(AUTHORITY, { kind: "read_payment", paymentId: "pay_CP" }));
    expect(result.providerState.object.externalId).toBe("pay_CP");
    expect(stringifySafe(result)).not.toContain(SYNTHETIC_SECRET_KEY);

    // An UNBOUND config key fails closed with no silent fallback:
    const emptyStore = new FixtureVaultStore();
    const emptyBroker = new CredentialBroker({ store: emptyStore });
    const emptyKey = emptyBroker.registerConnectorRuntime("runtime.rapyd.test2");
    const refused = new RapydConnector({
      clock: CLOCK,
      http: transport.transport,
      credentials: { broker: emptyBroker, runtimeKey: emptyKey },
    });
    await expect(refused.read(ctx(AUTHORITY, { kind: "read_payment", paymentId: "pay_CP" }))).rejects.toThrow(
      RailNotAuthorizedError,
    );
  });
});

/** A control-plane vault fixture: config key → vault ref → sealed bundle. */
class FixtureVaultStore implements VaultStore {
  readonly storeId = "vault-fixture-rapyd";
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
          providerName: "rapyd",
          authorizationMode: "SCOPED_API_CREDENTIAL",
          vaultReference: vaultReference(reference),
          issuedAt: "2026-10-02T06:37:38Z",
          accountRef: "rapyd-sandbox-account-20261002",
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

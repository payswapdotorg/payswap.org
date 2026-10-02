import { describe, expect, it } from "vitest";
import {
  parseProviderStateEnvelope,
  serializeProviderStateEnvelope,
  validateExternalFundsPositionObservation,
} from "@payswap/connectors";
import {
  CredentialBroker,
  SealedCredentialBundle,
  vaultReference,
} from "@payswap/adapters";
import type { ConnectorRuntimeKey, VaultStore } from "@payswap/adapters";
import { RailNotAuthorizedError } from "../src/support.js";
import type { HttpTransport } from "../src/support.js";
import {
  EBANX_API_VERSION,
  EBANX_BALANCE_OBSERVATION_CAPABILITY_ID,
  EBANX_CREDENTIAL_CONFIG_KEY,
  EBANX_DEFAULT_API_BASE_LIVE,
  EBANX_DEFAULT_API_BASE_SANDBOX,
  EBANX_DIRECT_PAYMENT_CAPABILITY_ID,
  EBANX_DOCUMENTED_COUNTRY_METHODS_20261002,
  EBANX_PAYOUT_CAPABILITY_ID,
  EBANX_PAYMENT_STATUS_MAPPING,
  EBANX_PROVIDER_NAME,
  EBANX_REFUND_CAPABILITY_ID,
  EBANX_REFUND_STATUS_MAPPING,
  EBANX_SANDBOX_REACHABILITY_20261002,
  EBANX_VOUCHER_PAYMENT_TYPES,
  EbanxConnector,
  EbanxDuplicateMerchantPaymentCodeError,
  EbanxProductionRail,
  ebanxBalanceObservations,
  ebanxCapabilityDefinitions,
  ebanxMerchantPaymentCode,
  ebanxMethodEligibility,
  ebanxMinorUnits,
  ebanxPayoutEnvelope,
  ebanxPaymentEnvelope,
  ebanxRailCapabilityPack,
  ebanxRefundEnvelope,
  ebanxVoucherUrl,
  ebanxWebhookEventId,
  ebanxNotificationReference,
  ebanxPayoutRevision,
  extractEbanxKeyMaterial,
  verifyEbanxQueryBack,
} from "../src/ebanx.js";
import type {
  EbanxPaymentProviderObject,
  EbanxPayoutProviderObject,
  EbanxRefundProviderObject,
} from "../src/ebanx.js";
import { CLOCK, ctx, makeAdapterAuthority } from "./fixtures.js";

const AUTHORITY = makeAdapterAuthority();
const T0 = "2026-10-02T12:00:00.000Z";
const CTX = { observedAt: T0, provenanceSource: "PROVIDER_API" } as const;

// ---------------------------------------------------------------------------
// Synthetic fixtures ONLY (never real key material; byte-scan safe)
// ---------------------------------------------------------------------------

const SYNTHETIC_CONTROL_PLANE_MATERIAL = "test_integration_key_SYNTHETIC_0001";
const SYNTHETIC_ENV_MATERIAL = "test_integration_key_SYNTHETIC_0002_env";

function payment(
  status: string,
  overrides: Partial<EbanxPaymentProviderObject> = {},
): EbanxPaymentProviderObject {
  return {
    hash: "5523f8a1612a5e36e2012a8c19f1010c17d90f5e9c2f6d5c",
    merchant_payment_code: "payswap-idem-sdk-1",
    status,
    payment_type: "creditcard",
    country: "br",
    currency: "BRL",
    amount_total: 100.0,
    ...overrides,
  };
}

function refund(
  status: string,
  overrides: Partial<EbanxRefundProviderObject> = {},
): EbanxRefundProviderObject {
  return {
    id: 9981,
    status,
    amount: 25.5,
    currency: "BRL",
    description: "synthetic partial refund",
    ...overrides,
  };
}

function tClaim(
  status: string,
  overrides: Partial<EbanxPayoutProviderObject> = {},
): EbanxPayoutProviderObject {
  return {
    id: 70001,
    status,
    amount: 500.0,
    currency: "BRL",
    country: "br",
    payee: { name: "Synthetic Beneficiary", bank_details: { ...{} } },
    merchant_payout_code: "payswap-idem-sdk-1",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test transports (offline, deterministic; record bodies for assertions)
// ---------------------------------------------------------------------------

interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

class ScriptedEbanxTransport {
  readonly calls: RecordedCall[] = [];
  readonly #respond: (
    call: RecordedCall,
  ) => { status: number; bodyText: string } | Promise<{ status: number; bodyText: string }>;

  constructor(
    respond: (
      call: RecordedCall,
    ) => { status: number; bodyText: string } | Promise<{ status: number; bodyText: string }>,
  ) {
    this.#respond = respond;
  }

  readonly transport: HttpTransport = async (url, init) => {
    const call: RecordedCall = {
      url,
      method: init.method,
      headers: init.headers,
      ...(init.body !== undefined ? { body: init.body } : {}),
    };
    this.calls.push(call);
    return this.#respond(call);
  };
}

function jsonResponse(status: number, body: unknown): { status: number; bodyText: string } {
  return { status, bodyText: JSON.stringify(body) };
}

/** A control-plane vault fixture: config key → vault ref → sealed bundle. */
class FixtureVaultStore implements VaultStore {
  readonly storeId = "vault-fixture-ebanx";
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
          providerName: "ebanx",
          authorizationMode: "SCOPED_API_CREDENTIAL",
          vaultReference: vaultReference(reference),
          issuedAt: "2026-10-02T06:37:38Z",
          accountRef: "ebanx-sandbox-account-20261002",
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

const VAULT_REF = "vault://payswap/providers/ebanx/sandbox-20261002";

function controlPlaneConnector(
  transport: ScriptedEbanxTransport,
  material: unknown = SYNTHETIC_CONTROL_PLANE_MATERIAL,
): { connector: EbanxConnector; store: FixtureVaultStore } {
  const store = new FixtureVaultStore();
  store.bind(EBANX_CREDENTIAL_CONFIG_KEY, VAULT_REF);
  store.seal(VAULT_REF, material);
  const broker = new CredentialBroker({ store });
  const runtimeKey = broker.registerConnectorRuntime("runtime.ebanx.test");
  const connector = new EbanxConnector({
    clock: CLOCK,
    http: transport.transport,
    credentials: { broker, runtimeKey },
  });
  return { connector, store };
}

function envConnector(
  transport: ScriptedEbanxTransport,
  env: NodeJS.ProcessEnv = { [EBANX_CREDENTIAL_CONFIG_KEY]: SYNTHETIC_ENV_MATERIAL },
): EbanxConnector {
  return new EbanxConnector({ clock: CLOCK, http: transport.transport, env });
}

// ---------------------------------------------------------------------------
// 1. Identity, capability vocabulary, idempotency, eligibility honesty
// ---------------------------------------------------------------------------

describe("ebanx connector vocabulary (P2-W3-002)", () => {
  it("pins the provider identity, the /ws surface and the vault-template credential key", () => {
    expect(EBANX_PROVIDER_NAME).toBe("ebanx");
    expect(EBANX_API_VERSION).toBe("ws");
    expect(EBANX_CREDENTIAL_CONFIG_KEY).toBe("PROVIDER_EBANX_CREDENTIAL_REF");
    expect(EBANX_DEFAULT_API_BASE_SANDBOX).toBe("https://sandbox.ebanx.com");
    expect(EBANX_DEFAULT_API_BASE_LIVE).toBe("https://api.ebanx.com");
  });

  it("records the 2026-10-02 reachability datum (HTTP 401 on /ws/query — reachable, integration key required)", () => {
    expect(EBANX_SANDBOX_REACHABILITY_20261002.httpStatus).toBe(401);
    expect(EBANX_SANDBOX_REACHABILITY_20261002.reachable).toBe(true);
    expect(EBANX_SANDBOX_REACHABILITY_20261002.baseUrl).toBe("https://sandbox.ebanx.com/ws/query");
    expect(EBANX_SANDBOX_REACHABILITY_20261002.interpretation).toContain("INV-C01/C02");
  });

  it("capability definitions + pack use the v1.5 vocabulary (no parallel model)", () => {
    const definitions = ebanxCapabilityDefinitions();
    expect(definitions.length).toBe(4);
    for (const definition of definitions) {
      expect(definition.authorization.protocolAuthorization).toBe(true);
      expect(definition.idempotency.duplicateBehavior).toBe("PROVIDER_DEFINED");
      expect(definition.providerVocabulary.states.length).toBeGreaterThan(0);
    }
    expect(ebanxRailCapabilityPack().sourceOfTruth).toBe("EXTERNAL_AUTHORITATIVE");
    const rail = new EbanxProductionRail();
    expect(rail.adapterId).toBe("rail.ebanx");
    expect(rail.implementationId).toBe("impl.rails.ebanx.ws");
  });

  it("pay-in and payout are DISTINCT capability families (separate ids)", () => {
    const ids = ebanxCapabilityDefinitions().map((definition) => definition.capabilityId);
    expect(ids).toContain(EBANX_DIRECT_PAYMENT_CAPABILITY_ID);
    expect(ids).toContain(EBANX_REFUND_CAPABILITY_ID);
    expect(ids).toContain(EBANX_PAYOUT_CAPABILITY_ID);
    expect(ids).toContain(EBANX_BALANCE_OBSERVATION_CAPABILITY_ID);
    const payout = ebanxCapabilityDefinitions().find(
      (definition) => definition.capabilityId === EBANX_PAYOUT_CAPABILITY_ID,
    );
    expect(
      payout?.providerVocabulary.states.map((state) => state.canonicalState.split(":")[0]),
    ).toEqual(expect.arrayContaining(["payout"]));
    const payIn = ebanxCapabilityDefinitions().find(
      (definition) => definition.capabilityId === EBANX_DIRECT_PAYMENT_CAPABILITY_ID,
    );
    expect(
      payIn?.providerVocabulary.states.map((state) => state.canonicalState.split(":")[0]),
    ).not.toContain("payout");
  });

  it("derives merchant_payment_code from the protocol idempotency key (INV-F05), deterministically", () => {
    expect(ebanxMerchantPaymentCode("order-9")).toBe("payswap-order-9");
    expect(ebanxMerchantPaymentCode("order-9")).toBe("payswap-order-9");
    expect(() => ebanxMerchantPaymentCode("")).toThrow();
  });

  it("extracts the integration key from every documented bundle shape (fail-closed otherwise)", () => {
    expect(extractEbanxKeyMaterial("raw-key")).toBe("raw-key");
    expect(extractEbanxKeyMaterial({ integrationKey: "bundled-key" })).toBe("bundled-key");
    expect(extractEbanxKeyMaterial({ integration_key: "alt-key" })).toBe("alt-key");
    expect(() => extractEbanxKeyMaterial({ unrelated: true })).toThrow();
    expect(() => extractEbanxKeyMaterial("")).toThrow();
  });

  it("minor-unit conversion is exact per currency (INV-F01 — never floats)", () => {
    expect(ebanxMinorUnits("100.00", "BRL")).toBe("10000");
    expect(ebanxMinorUnits("1234", "CLP")).toBe("1234"); // zero-decimal currency
    expect(ebanxMinorUnits("50000", "VND")).toBe("50000");
    expect(() => ebanxMinorUnits("1234.56", "CLP")).toThrow(/sub-minor/);
    expect(() => ebanxMinorUnits("100.00", "XYZ")).toThrow(/unknown minor-unit exponent/);
  });

  it("the documented country/method catalogue is recorded (13 countries) — and is NEVER an eligibility assertion", () => {
    expect(Object.keys(EBANX_DOCUMENTED_COUNTRY_METHODS_20261002).sort()).toEqual(
      ["BR", "CL", "CO", "GH", "ID", "IN", "KE", "MX", "NG", "PE", "PH", "VN", "ZA"].sort(),
    );
    expect(EBANX_DOCUMENTED_COUNTRY_METHODS_20261002["BR"]).toContain("pix");
    expect(EBANX_DOCUMENTED_COUNTRY_METHODS_20261002["MX"]).toContain("oxxo");
  });

  it("eligibility is OBSERVED-only: documented pairs are DOCUMENTED_NOT_OBSERVED, unknown pairs NOT_DOCUMENTED", () => {
    const boleto = ebanxMethodEligibility("br", "boleto");
    expect(boleto.eligible).toBe(false);
    expect(boleto.basis).toBe("DOCUMENTED_NOT_OBSERVED");
    expect(boleto.reason).toContain("never assumed");
    const unknown = ebanxMethodEligibility("us", "card");
    expect(unknown.eligible).toBe(false);
    expect(unknown.basis).toBe("NOT_DOCUMENTED");
    expect(unknown.reason).toContain("never assumed");
  });
});

// ---------------------------------------------------------------------------
// 2. Status lifecycle → ProviderStateEnvelope (lossless, INV-C06)
// ---------------------------------------------------------------------------

describe("ebanx connector — payment/refund/payout status mapping (lossless, INV-C06)", () => {
  it("the exported mapping table covers exactly the four two-letter payment statuses", () => {
    expect(EBANX_PAYMENT_STATUS_MAPPING.map((row) => row.providerState)).toEqual([
      "PE", "OP", "CO", "CA",
    ]);
  });

  for (const row of EBANX_PAYMENT_STATUS_MAPPING) {
    it(`maps payment '${row.providerState}' → family=${row.family} step=${row.lifecycleStep} terminal=${row.isTerminal}`, () => {
      const envelope = ebanxPaymentEnvelope(payment(row.providerState), CTX);
      expect(envelope.classification.family).toBe(row.family);
      expect(envelope.classification.lifecycleStep).toBe(row.lifecycleStep);
      expect(envelope.classification.isTerminal).toBe(row.isTerminal);
      expect(envelope.classification.requiresCustomerAction).toBe(row.requiresCustomerAction);
      expect((envelope.state as { status: string }).status).toBe(row.providerState);
    });
  }

  it("CO is settled-EXTERNAL (terminal; the connector claims no custody)", () => {
    const envelope = ebanxPaymentEnvelope(payment("CO"), CTX);
    expect(envelope.classification.lifecycleStep).toBe("settled_external");
    expect(envelope.classification.isTerminal).toBe(true);
  });

  it("an UNKNOWN status stays non-terminal other (UNKNOWN, never FAILED)", () => {
    const envelope = ebanxPaymentEnvelope(payment("ZZ"), CTX);
    expect(envelope.classification.family).toBe("other");
    expect(envelope.classification.isTerminal).toBe(false);
    expect(envelope.classification.lifecycleStep).toBe("ZZ");
    expect((envelope.state as { status: string }).status).toBe("ZZ");
  });

  it("carries the payment hash as the external id and preserves provider identity/version", () => {
    const envelope = ebanxPaymentEnvelope(payment("PE"), CTX);
    expect(envelope.provider.name).toBe(EBANX_PROVIDER_NAME);
    expect(envelope.provider.version).toBe(EBANX_API_VERSION);
    expect(envelope.object.objectType).toBe("payment");
    expect(envelope.object.externalId).toBe("5523f8a1612a5e36e2012a8c19f1010c17d90f5e9c2f6d5c");
  });

  it("payment envelopes round-trip LOSSLESSLY through serialize/parse for every status", () => {
    for (const row of EBANX_PAYMENT_STATUS_MAPPING) {
      const envelope = ebanxPaymentEnvelope(payment(row.providerState), CTX);
      expect(parseProviderStateEnvelope(serializeProviderStateEnvelope(envelope))).toEqual(envelope);
    }
  });

  it("PE for a VOUCHER type is customer-action-required with the voucher URL preserved (boleto/pix/oxxo…)", () => {
    expect(EBANX_VOUCHER_PAYMENT_TYPES).toContain("boleto");
    const voucherPayment = payment("PE", {
      payment_type: "boleto",
      voucher_url: "https://sandbox.ebanx.com/print/voucher/synthetic",
    });
    const envelope = ebanxPaymentEnvelope(voucherPayment, CTX);
    expect(envelope.classification.family).toBe("customer_action_required");
    expect(envelope.classification.requiresCustomerAction).toBe(true);
    expect(envelope.classification.isTerminal).toBe(false);
    expect(envelope.actionRequired?.kind).toBe("PROVIDER_VOUCHER_PRESENTATION");
    expect(envelope.actionRequired?.deepLink).toBe("https://sandbox.ebanx.com/print/voucher/synthetic");
    expect((envelope.state as { voucher_url: string }).voucher_url).toBe(
      "https://sandbox.ebanx.com/print/voucher/synthetic",
    );
    // PE for a NON-voucher type (e.g. card) stays processing
    const cardPending = ebanxPaymentEnvelope(payment("PE", { payment_type: "creditcard" }), CTX);
    expect(cardPending.classification.family).toBe("async_processing");
    expect(cardPending.classification.requiresCustomerAction).toBe(false);
  });

  it("the voucher URL is extracted tolerantly (voucher_url/boleto_url/oxxo_url/redirect_url)", () => {
    expect(ebanxVoucherUrl({ voucher_url: "https://a" })).toBe("https://a");
    expect(ebanxVoucherUrl({ boleto_url: "https://b" })).toBe("https://b");
    expect(ebanxVoucherUrl({ oxxo_url: "https://c" })).toBe("https://c");
    expect(ebanxVoucherUrl({}, { redirect_url: "https://d" })).toBe("https://d");
    expect(ebanxVoucherUrl({})).toBeUndefined();
    expect(ebanxVoucherUrl({ voucher_url: "" })).toBeUndefined();
  });

  it("refund statuses map per the RE/CO/CA table (raw codes verbatim)", () => {
    expect(EBANX_REFUND_STATUS_MAPPING.map((row) => row.providerState)).toEqual(["RE", "CO", "CA"]);
    for (const row of EBANX_REFUND_STATUS_MAPPING) {
      const envelope = ebanxRefundEnvelope(refund(row.providerState), CTX);
      expect(envelope.classification.family).toBe("refund");
      expect(envelope.classification.lifecycleStep).toBe(row.lifecycleStep);
      expect(envelope.classification.isTerminal).toBe(row.isTerminal);
      expect((envelope.state as { status: string }).status).toBe(row.providerState);
    }
    const unknown = ebanxRefundEnvelope(refund("ZZ"), CTX);
    expect(unknown.classification.isTerminal).toBe(false);
    expect(unknown.classification.lifecycleStep).toBe("ZZ");
  });

  it("payout (T-Claim) statuses map in the DISTINCT payout family with the payee VERBATIM", () => {
    const envelope = ebanxPayoutEnvelope(tClaim("pending"), CTX);
    expect(envelope.classification.family).toBe("payout");
    expect(envelope.classification.isTerminal).toBe(false);
    expect((envelope.state as { payee: unknown }).payee).toEqual(tClaim("pending").payee);
    expect(ebanxPayoutRevision(tClaim("confirmed"))).toBe("70001:confirmed:payswap-idem-sdk-1");
    const confirmed = ebanxPayoutEnvelope(tClaim("confirmed"), CTX);
    expect(confirmed.classification.isTerminal).toBe(true);
    const failed = ebanxPayoutEnvelope(tClaim("failed"), CTX);
    expect(failed.classification.isTerminal).toBe(true);
    expect(failed.failure?.providerErrorCode).toBe("payout_failed");
    const unknown = ebanxPayoutEnvelope(tClaim("new_state"), CTX);
    expect(unknown.classification.isTerminal).toBe(false);
    expect(unknown.classification.lifecycleStep).toBe("new_state");
  });

  it("balances map to validated ExternalFundsPositionObservations (never custody; honest unconverted)", () => {
    const { observations, unconverted } = ebanxBalanceObservations({
      balanceResponse: {
        status: "SUCCESS",
        balances: { BRL: "1000.50", USD: "250.00", CLP: "12345" },
      },
      accountRef: "vault:PROVIDER_EBANX_CREDENTIAL_REF",
      observedAt: T0,
    });
    expect(observations).toHaveLength(3);
    for (const observation of observations) {
      expect(() => validateExternalFundsPositionObservation(observation)).not.toThrow();
      expect(observation.location.description).toContain("never custody");
    }
    const brl = observations.find((observation) => observation.observedAmount.currency === "BRL");
    expect(brl?.observedAmount.minorUnits).toBe("100050");
    expect(unconverted).toHaveLength(0);
    const shaped = ebanxBalanceObservations({
      balanceResponse: { status: "SUCCESS", balance: { BRL: { amount: "10.00" }, AUD: "1.00" } },
      accountRef: "vault:PROVIDER_EBANX_CREDENTIAL_REF",
      observedAt: T0,
    });
    expect(shaped.observations.map((observation) => observation.observedAmount.currency)).toEqual(["BRL"]);
    expect(shaped.unconverted.map((entry) => entry.currency)).toEqual(["AUD"]);
    const arrayShaped = ebanxBalanceObservations({
      balanceResponse: { items: [{ currency: "MXN", amount: "500" }] },
      accountRef: "vault:PROVIDER_EBANX_CREDENTIAL_REF",
      observedAt: T0,
    });
    expect(arrayShaped.observations[0]?.observedAmount.minorUnits).toBe("50000");
  });
});

// ---------------------------------------------------------------------------
// 3. Webhook verification (QUERY-BACK — the documented integrity mechanism)
// ---------------------------------------------------------------------------

describe("ebanx connector — webhook verification (query-back scheme)", () => {
  const notifiedHash = "5523f8a1612a5e36e2012a8c19f1010c17d90f5e9c2f6d5c";

  it("extracts the notification reference (hash / hash_code / merchant_payment_code)", () => {
    expect(ebanxNotificationReference({ hash: notifiedHash })).toEqual({ hash: notifiedHash });
    expect(ebanxNotificationReference({ hash_code: notifiedHash })).toEqual({ hash: notifiedHash });
    expect(ebanxNotificationReference({ merchant_payment_code: "mpc-1" })).toEqual({
      merchantPaymentCode: "mpc-1",
    });
    expect(ebanxNotificationReference({ unrelated: true })).toBeUndefined();
    expect(ebanxNotificationReference(null)).toBeUndefined();
    expect(ebanxNotificationReference("not-an-object")).toBeUndefined();
  });

  it("the deterministic event id is the notification reference pair (dedupe key)", () => {
    expect(ebanxWebhookEventId({ hash: notifiedHash })).toBe(`notification:${notifiedHash}`);
    expect(ebanxWebhookEventId({ merchant_payment_code: "mpc-1" })).toBe("notification:mpc-1");
    expect(ebanxWebhookEventId({ unrelated: true })).toBeUndefined();
    expect(ebanxWebhookEventId(null)).toBeUndefined();
  });

  it("query-back verifies when the queried payment matches the notified hash", () => {
    const verification = verifyEbanxQueryBack(
      { hash: notifiedHash },
      payment("CO", { hash: notifiedHash }),
    );
    expect(verification.valid).toBe(true);
    if (verification.valid) {
      expect(verification.payment.status).toBe("CO");
    }
  });

  it("query-back verifies by merchant_payment_code when no hash was notified", () => {
    const verification = verifyEbanxQueryBack(
      { merchantPaymentCode: "payswap-idem-sdk-1" },
      payment("PE"),
    );
    expect(verification.valid).toBe(true);
  });

  it("query-back FAILS CLOSED on mismatch, missing reference, or missing query answer", () => {
    expect(
      verifyEbanxQueryBack({ hash: "aaaa" }, payment("CO", { hash: "bbbb" })),
    ).toMatchObject({ valid: false, reason: "REFERENCE_MISMATCH" });
    expect(
      verifyEbanxQueryBack({ merchantPaymentCode: "mpc-1" }, payment("CO", { merchant_payment_code: "mpc-2" })),
    ).toMatchObject({ valid: false, reason: "REFERENCE_MISMATCH" });
    expect(verifyEbanxQueryBack(undefined, payment("CO"))).toMatchObject({
      valid: false,
      reason: "NO_REFERENCE",
    });
    expect(verifyEbanxQueryBack({ hash: notifiedHash }, undefined)).toMatchObject({
      valid: false,
      reason: "QUERY_NOT_FOUND",
    });
  });

  it("the connector verifies a notification by querying the provider (the query response is the evidence)", async () => {
    const transport = new ScriptedEbanxTransport(() =>
      jsonResponse(200, { status: "SUCCESS", payment: payment("CO") }),
    );
    const { connector } = controlPlaneConnector(transport);
    const { verification, envelope } = await connector.verifyNotificationByQueryBack({
      operation: "payment_status_change",
      hash: notifiedHash,
    });
    expect(verification.valid).toBe(true);
    expect(envelope?.classification.lifecycleStep).toBe("settled_external");
    expect(envelope?.provenance.source).toBe("PROVIDER_WEBHOOK");
    // The query call carried the integration key in the body (the documented path)
    expect(transport.calls[0]?.url).toBe("https://sandbox.ebanx.com/ws/query");
    const body = JSON.parse(transport.calls[0]?.body ?? "{}") as Record<string, unknown>;
    expect(body["hash"]).toBe(notifiedHash);
    expect(body["integration_key"]).toBe(SYNTHETIC_CONTROL_PLANE_MATERIAL);
  });

  it("a notification whose query answer does NOT match is refused (never trusted on its own)", async () => {
    const transport = new ScriptedEbanxTransport(() =>
      jsonResponse(200, {
        status: "SUCCESS",
        payment: payment("CO", { hash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }),
      }),
    );
    const { connector } = controlPlaneConnector(transport);
    const { verification, envelope } = await connector.verifyNotificationByQueryBack({
      hash: notifiedHash,
    });
    expect(verification.valid).toBe(false);
    if (!verification.valid) {
      expect(verification.reason).toBe("REFERENCE_MISMATCH");
    }
    expect(envelope).toBeUndefined();
  });

  it("a notification with NO reference is refused before any provider call", async () => {
    const transport = new ScriptedEbanxTransport(() => jsonResponse(200, {}));
    const { connector } = controlPlaneConnector(transport);
    const { verification } = await connector.verifyNotificationByQueryBack({ unrelated: true });
    expect(verification.valid).toBe(false);
    if (!verification.valid) {
      expect(verification.reason).toBe("NO_REFERENCE");
    }
    expect(transport.calls).toHaveLength(0);
  });

  it("a query transport failure surfaces QUERY_ERROR (fail-closed, never a business outcome)", async () => {
    const transport = new ScriptedEbanxTransport(() => {
      throw new Error("connection reset mid-flight");
    });
    const { connector } = controlPlaneConnector(transport);
    const { verification, envelope } = await connector.verifyNotificationByQueryBack({
      hash: notifiedHash,
    });
    expect(verification.valid).toBe(false);
    if (!verification.valid) {
      expect(verification.reason).toBe("QUERY_ERROR");
    }
    expect(envelope).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4. Fail-closed credential gating (INV-NC04)
// ---------------------------------------------------------------------------

describe("ebanx connector — fail-closed credential gating", () => {
  it("no credential: availability UNKNOWN with provenance, never routable", () => {
    const transport = new ScriptedEbanxTransport(() => jsonResponse(401, { status: "ERROR" }));
    const connector = new EbanxConnector({ clock: CLOCK, http: transport.transport });
    const observation = connector.availabilityObservation({
      instanceId: "inst-rails-ebanx-1",
      observationVersion: 1,
    });
    expect(observation.availability).toBe("UNKNOWN");
    expect(observation.sourceAvailability).toBe("UNKNOWN");
    const implication = connector.railImplication(observation.availability);
    expect(implication.routable).toBe(false);
    expect(implication.reason).toContain("INV-NC04");
  });

  it("no credential: health is DEGRADED (endpoint answers, e.g. the recorded 401) or UNKNOWN (transport dead)", async () => {
    const answering = new ScriptedEbanxTransport(() => jsonResponse(401, { status: "ERROR" }));
    const degraded = await new EbanxConnector({ clock: CLOCK, http: answering.transport }).health();
    expect(degraded.status).toBe("DEGRADED");
    expect(degraded.degradedReasons[0]).toContain("credentials absent");
    expect(degraded.degradedReasons[0]).toContain("401");

    const dead = new ScriptedEbanxTransport(() => {
      throw new Error("network down");
    });
    const unknown = await new EbanxConnector({ clock: CLOCK, http: dead.transport }).health();
    expect(unknown.status).toBe("UNKNOWN");
  });

  it("no credential: effectful operations throw RailNotAuthorizedError BEFORE any provider call", async () => {
    const transport = new ScriptedEbanxTransport(() => jsonResponse(200, {}));
    const connector = new EbanxConnector({ clock: CLOCK, http: transport.transport });
    await expect(
      connector.create(
        ctx(AUTHORITY, {
          kind: "create_payment",
          name: "Synthetic Payer",
          email: "payer@synthetic.example",
          country: "br",
          paymentType: "boleto",
          amountTotal: "100.00",
          currency: "BRL",
        }),
      ),
    ).rejects.toThrow(RailNotAuthorizedError);
    await expect(
      connector.executeAction(ctx(AUTHORITY, { kind: "refund_payment", hash: "abc" })),
    ).rejects.toThrow(RailNotAuthorizedError);
    await expect(
      connector.read(ctx(AUTHORITY, { kind: "query_payment", hash: "abc" })),
    ).rejects.toThrow(RailNotAuthorizedError);
    await expect(connector.observeExternalFunds()).rejects.toThrow(RailNotAuthorizedError);
    await expect(
      connector.verifyNotificationByQueryBack({ hash: "abc" }),
    ).rejects.toThrow(RailNotAuthorizedError);
    expect(transport.calls).toHaveLength(0); // fail-closed BEFORE any provider call
  });

  it("credential surface declares the control-plane config key; resolution state is honest (never material)", () => {
    const connector = new EbanxConnector({ clock: CLOCK });
    expect(connector.credentialSurface()).toEqual([
      { envVar: "PROVIDER_EBANX_CREDENTIAL_REF", kind: "API_KEY" },
    ]);
    expect(connector.credentialResolutionState()).toEqual({
      kind: "NOT_PROVISIONED",
      configKey: "PROVIDER_EBANX_CREDENTIAL_REF",
      reason: expect.stringContaining("INV-NC04"),
    });
    const envState = envConnector(
      new ScriptedEbanxTransport(() => jsonResponse(200, {})),
    ).credentialResolutionState();
    expect(envState.kind).toBe("ENV_RESOLVED_MATERIAL");
    expect(JSON.stringify(envState)).not.toContain(SYNTHETIC_ENV_MATERIAL);
    const sealedState = controlPlaneConnector(
      new ScriptedEbanxTransport(() => jsonResponse(200, {})),
    ).connector.credentialResolutionState();
    expect(sealedState.kind).toBe("CONTROL_PLANE_SEALED");
    expect(JSON.stringify(sealedState)).not.toContain(SYNTHETIC_CONTROL_PLANE_MATERIAL);
  });

  it("control plane with an UNBOUND config key fails closed (no silent fallback)", async () => {
    const store = new FixtureVaultStore(); // nothing bound
    const broker = new CredentialBroker({ store });
    const runtimeKey = broker.registerConnectorRuntime("runtime.ebanx.test");
    const transport = new ScriptedEbanxTransport(() => jsonResponse(200, {}));
    const connector = new EbanxConnector({
      clock: CLOCK,
      http: transport.transport,
      credentials: { broker, runtimeKey },
    });
    await expect(
      connector.read(ctx(AUTHORITY, { kind: "query_payment", hash: "abc" })),
    ).rejects.toThrow(RailNotAuthorizedError);
    expect(transport.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Real request paths (scripted transport, no network)
// ---------------------------------------------------------------------------

describe("ebanx connector — provider calls (scripted transport, no network)", () => {
  it("creates a direct payment through the SEALED control-plane path with the derived merchant_payment_code", async () => {
    const transport = new ScriptedEbanxTransport(() =>
      jsonResponse(200, {
        status: "SUCCESS",
        payment: payment("PE", { payment_type: "boleto", voucher_url: "https://sandbox.ebanx.com/print/voucher/synthetic" }),
        redirect_url: "https://sandbox.ebanx.com/print/voucher/synthetic",
      }),
    );
    const { connector } = controlPlaneConnector(transport);
    const result = await connector.create(
      ctx(AUTHORITY, {
        kind: "create_payment",
        name: "Synthetic Payer",
        email: "payer@synthetic.example",
        country: "br",
        paymentType: "boleto",
        amountTotal: "100.00",
        currency: "BRL",
      }),
    );
    const call = transport.calls[0];
    expect(call?.url).toBe("https://sandbox.ebanx.com/ws/direct");
    expect(call?.method).toBe("POST");
    const body = JSON.parse(call?.body ?? "{}") as Record<string, unknown>;
    expect(body["operation"]).toBe("payment");
    expect(body["integration_key"]).toBe(SYNTHETIC_CONTROL_PLANE_MATERIAL);
    expect(body["payment"]).toMatchObject({
      name: "Synthetic Payer",
      country: "BR",
      payment_type: "boleto",
      amount_total: 100,
      currency: "BRL",
      merchant_payment_code: "payswap-idem-sdk-1",
    });
    // A pending boleto is customer-action-required with the voucher preserved
    expect(result.providerState.classification.family).toBe("customer_action_required");
    expect(result.providerState.actionRequired?.deepLink).toBe(
      "https://sandbox.ebanx.com/print/voucher/synthetic",
    );
  });

  it("queries by hash AND by merchant_payment_code (the array answer shape is handled honestly)", async () => {
    const hashTransport = new ScriptedEbanxTransport(() =>
      jsonResponse(200, { status: "SUCCESS", payment: payment("CO") }),
    );
    const { connector } = controlPlaneConnector(hashTransport);
    const result = await connector.read(
      ctx(AUTHORITY, { kind: "query_payment", hash: "5523f8a1612a5e36e2012a8c19f1010c17d90f5e9c2f6d5c" }),
    );
    expect(hashTransport.calls[0]?.url).toBe("https://sandbox.ebanx.com/ws/query");
    expect(JSON.parse(hashTransport.calls[0]?.body ?? "{}")).toMatchObject({
      hash: "5523f8a1612a5e36e2012a8c19f1010c17d90f5e9c2f6d5c",
    });
    expect(result.providerState.classification.lifecycleStep).toBe("settled_external");

    const arrayTransport = new ScriptedEbanxTransport(() =>
      jsonResponse(200, { status: "SUCCESS", payment: [payment("PE")] }),
    );
    const { connector: arrayConnector } = controlPlaneConnector(arrayTransport);
    const arrayResult = await arrayConnector.read(
      ctx(AUTHORITY, { kind: "query_payment", merchantPaymentCode: "payswap-idem-sdk-1" }),
    );
    expect(arrayResult.providerState.classification.family).toBe("async_processing");
  });

  it("an empty query answer (not found) is an honest provider error, never a fabricated payment", async () => {
    const transport = new ScriptedEbanxTransport(() =>
      jsonResponse(200, { status: "SUCCESS", payment: [] }),
    );
    const { connector } = controlPlaneConnector(transport);
    await expect(
      connector.read(ctx(AUTHORITY, { kind: "query_payment", hash: "notfound" })),
    ).rejects.toThrow(/empty payment array/);
  });

  it("refunds post to /ws/refund with the explicit partial amount when given", async () => {
    const transport = new ScriptedEbanxTransport(() =>
      jsonResponse(200, { status: "SUCCESS", refund: refund("RE") }),
    );
    const { connector } = controlPlaneConnector(transport);
    const result = await connector.executeAction(
      ctx(AUTHORITY, {
        kind: "refund_payment",
        hash: "5523f8a1612a5e36e2012a8c19f1010c17d90f5e9c2f6d5c",
        description: "synthetic partial refund",
        amount: "25.50",
      }),
    );
    expect(transport.calls[0]?.url).toBe("https://sandbox.ebanx.com/ws/refund");
    const body = JSON.parse(transport.calls[0]?.body ?? "{}") as Record<string, unknown>;
    expect(body).toMatchObject({
      hash: "5523f8a1612a5e36e2012a8c19f1010c17d90f5e9c2f6d5c",
      description: "synthetic partial refund",
      amount: 25.5,
      integration_key: SYNTHETIC_CONTROL_PLANE_MATERIAL,
    });
    expect(result.providerState.classification.family).toBe("refund");
    expect(result.providerState.classification.lifecycleStep).toBe("requested");
  });

  it("T-Claim payouts post to /ws/t-claim with the explicit payee (the DISTINCT payout family)", async () => {
    const transport = new ScriptedEbanxTransport(() =>
      jsonResponse(200, { status: "SUCCESS", payout: tClaim("pending") }),
    );
    const { connector } = controlPlaneConnector(transport);
    const result = await connector.executeAction(
      ctx(AUTHORITY, {
        kind: "create_payout",
        amount: "500.00",
        currency: "BRL",
        country: "br",
        payee: { name: "Synthetic Beneficiary", bank_details: { bank_code: "001" } },
      }),
    );
    expect(transport.calls[0]?.url).toBe("https://sandbox.ebanx.com/ws/t-claim");
    const body = JSON.parse(transport.calls[0]?.body ?? "{}") as Record<string, unknown>;
    expect(body["payout"]).toMatchObject({
      amount: 500,
      currency: "BRL",
      country: "BR",
      payee: { name: "Synthetic Beneficiary" },
      merchant_payout_code: "payswap-idem-sdk-1",
    });
    expect(result.providerState.classification.family).toBe("payout");
    expect(result.providerState.classification.isTerminal).toBe(false);
  });

  it("a duplicate merchant_payment_code is the EbanxDuplicateMerchantPaymentCodeError provider error class", async () => {
    const transport = new ScriptedEbanxTransport(() =>
      jsonResponse(200, {
        status: "ERROR",
        status_message: "Merchant payment code already used",
      }),
    );
    const { connector } = controlPlaneConnector(transport);
    await expect(
      connector.create(
        ctx(AUTHORITY, {
          kind: "create_payment",
          name: "Synthetic Payer",
          email: "payer@synthetic.example",
          country: "br",
          paymentType: "creditcard",
          amountTotal: "100.00",
          currency: "BRL",
        }),
      ),
    ).rejects.toThrow(EbanxDuplicateMerchantPaymentCodeError);
  });

  it("a generic provider ERROR surfaces as RailProviderError with the message preserved", async () => {
    const transport = new ScriptedEbanxTransport(() =>
      jsonResponse(200, { status: "ERROR", status_message: "Country not enabled for merchant" }),
    );
    const { connector } = controlPlaneConnector(transport);
    await expect(
      connector.create(
        ctx(AUTHORITY, {
          kind: "create_payment",
          name: "Synthetic Payer",
          email: "payer@synthetic.example",
          country: "br",
          paymentType: "creditcard",
          amountTotal: "100.00",
          currency: "BRL",
        }),
      ),
    ).rejects.toThrow(/Country not enabled for merchant/);
  });

  it("a mid-effect transport failure is OUTCOME_UNKNOWN — never FAILED (INV-X01)", async () => {
    const transport = new ScriptedEbanxTransport(() => {
      throw new Error("connection reset mid-flight");
    });
    const { connector } = controlPlaneConnector(transport);
    const result = await connector.create(
      ctx(AUTHORITY, {
        kind: "create_payment",
        name: "Synthetic Payer",
        email: "payer@synthetic.example",
        country: "br",
        paymentType: "creditcard",
        amountTotal: "100.00",
        currency: "BRL",
      }),
    );
    expect(result.providerState.classification.lifecycleStep).toBe("outcome_unknown");
    expect(result.providerState.failure?.ambiguity).toBe("OUTCOME_UNKNOWN");
    expect(result.providerState.classification.isTerminal).toBe(false);
  });

  it("an amount with more than two decimals is refused before any call (the provider's precision; INV-F01)", async () => {
    const transport = new ScriptedEbanxTransport(() => jsonResponse(200, {}));
    const { connector } = controlPlaneConnector(transport);
    await expect(
      connector.create(
        ctx(AUTHORITY, {
          kind: "create_payment",
          name: "Synthetic Payer",
          email: "payer@synthetic.example",
          country: "br",
          paymentType: "creditcard",
          amountTotal: "100.005",
          currency: "BRL",
        }),
      ),
    ).rejects.toThrow(/at most two decimals/);
    expect(transport.calls).toHaveLength(0);
  });

  it("update honestly refuses: direct payments are not mutable (create → voucher/redirect → query)", async () => {
    const transport = new ScriptedEbanxTransport(() => jsonResponse(200, {}));
    const { connector } = controlPlaneConnector(transport);
    await expect(connector.update(ctx(AUTHORITY, {}))).rejects.toThrow(/not mutable/);
    expect(transport.calls).toHaveLength(0);
  });

  it("health() with credentials runs the authenticated query probe (the integration key evaluates)", async () => {
    const transport = new ScriptedEbanxTransport(() =>
      jsonResponse(200, { status: "SUCCESS" }),
    );
    const { connector } = controlPlaneConnector(transport);
    const report = await connector.health();
    expect(report.status).toBe("HEALTHY");
    expect(transport.calls[0]?.url).toBe("https://sandbox.ebanx.com/ws/query");
    expect(JSON.parse(transport.calls[0]?.body ?? "{}")["integration_key"]).toBe(
      SYNTHETIC_CONTROL_PLANE_MATERIAL,
    );
  });

  it("the env fallback path sends the same real request shape", async () => {
    const transport = new ScriptedEbanxTransport(() =>
      jsonResponse(200, { status: "SUCCESS", payment: payment("CO") }),
    );
    const connector = envConnector(transport);
    const result = await connector.read(
      ctx(AUTHORITY, { kind: "query_payment", hash: "5523f8a1612a5e36e2012a8c19f1010c17d90f5e9c2f6d5c" }),
    );
    expect(JSON.parse(transport.calls[0]?.body ?? "{}")["integration_key"]).toBe(
      SYNTHETIC_ENV_MATERIAL,
    );
    expect(result.providerState.classification.lifecycleStep).toBe("settled_external");
  });

  it("reconcile re-queries by the external object id (INV-X03 — query is the authority)", async () => {
    const transport = new ScriptedEbanxTransport(() =>
      jsonResponse(200, { status: "SUCCESS", payment: payment("CO") }),
    );
    const { connector } = controlPlaneConnector(transport);
    const result = await connector.reconcile(
      ctx(AUTHORITY, { kind: "query_payment", hash: "5523f8a1612a5e36e2012a8c19f1010c17d90f5e9c2f6d5c" }),
    );
    expect(result.providerState.object.externalId).toBe(
      "5523f8a1612a5e36e2012a8c19f1010c17d90f5e9c2f6d5c",
    );
  });
});

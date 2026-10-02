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
  THUNES_API_VERSION,
  THUNES_CREDENTIAL_CONFIG_KEY,
  THUNES_DEFAULT_ENDPOINT_EVIDENCE,
  THUNES_PAYER_COVERAGE_CAPABILITY_ID,
  THUNES_QUOTE_CAPABILITY_ID,
  THUNES_TRANSACTION_CAPABILITY_ID,
  THUNES_TRANSACTION_STATUS_MAPPING,
  THUNES_UNRESOLVABLE_ENDPOINT_20261002,
  ThunesConnector,
  ThunesProductionRail,
  ThunesUnresolvableEndpointError,
  ThunesWebhookVerifier,
  createThunesWebhookIngestor,
  thunesBeneficiaryRequirements,
  thunesCapabilityDefinitions,
  thunesExternalId,
  thunesPayerEligibility,
  thunesPayerListEnvelope,
  thunesQuoteEnvelope,
  thunesRailCapabilityPack,
  thunesTransactionEnvelope,
  thunesWebhookEventEnvelope,
  thunesWebhookEventId,
  thunesWebhookEventTimestamp,
  thunesWebhookRawEvent,
  thunesWebhookSignature,
  verifyThunesWebhookDelivery,
} from "../src/thunes.js";
import type {
  ThunesPayerCoverageRecord,
  ThunesPayerProviderObject,
  ThunesQuoteProviderObject,
  ThunesTransactionProviderObject,
} from "../src/thunes.js";
import { CLOCK, ctx, makeAdapterAuthority } from "./fixtures.js";
import { ScriptedHttpTransport } from "./fixtures.js";

const AUTHORITY = makeAdapterAuthority();
const T0 = "2026-10-02T07:41:00Z";
const CTX = { observedAt: T0, provenanceSource: "PROVIDER_API" } as const;
const WEBHOOK_CTX = { observedAt: T0, provenanceSource: "PROVIDER_WEBHOOK" } as const;

// Obviously-synthetic fixture credentials (never real; the byte-scan law).
const SYNTHETIC_API_KEY = "SYNTHETIC_THUNES_APIKEY_0001_NOT_REAL";
const SYNTHETIC_SECRET_KEY = "SYNTHETIC_THUNES_SECRET_0002_NOT_REAL";
const SYNTHETIC_ENV_MATERIAL = JSON.stringify({
  apiKey: SYNTHETIC_API_KEY,
  secretKey: SYNTHETIC_SECRET_KEY,
});
const SYNTHETIC_WEBHOOK_SECRET = "whsec_SYNTHETIC_THUNES_FIXTURE_0003_NOT_REAL";

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
// 1. Vocabulary and the honest endpoint datum
// ---------------------------------------------------------------------------

describe("thunes connector vocabulary + the NXDOMAIN datum (P2-W2-002)", () => {
  it("pins the provider identity, API version and the control-plane credential key", () => {
    expect(THUNES_API_VERSION).toBe("v2");
    expect(THUNES_CREDENTIAL_CONFIG_KEY).toBe("PROVIDER_THUNES_CREDENTIAL_REF");
  });

  it("records the 2026-10-02 GLOBALLY_NXDOMAIN datum for BOTH documented API hosts (the honest evidence)", () => {
    expect(THUNES_UNRESOLVABLE_ENDPOINT_20261002.verdict).toBe("GLOBALLY_NXDOMAIN");
    expect(THUNES_UNRESOLVABLE_ENDPOINT_20261002.hosts).toHaveLength(2);
    expect(THUNES_UNRESOLVABLE_ENDPOINT_20261002.availability).toBe("UNKNOWN");
    expect(THUNES_UNRESOLVABLE_ENDPOINT_20261002.method).toContain("DNS-over-HTTPS");
    expect(THUNES_UNRESOLVABLE_ENDPOINT_20261002.companyDomain).toMatchObject({
      host: "www.thunes.com",
      resolves: true,
    });
  });

  it("the default endpoint evidence is the NXDOMAIN datum; the gate lifts ONLY on RESOLVED evidence with a confirmed host", () => {
    expect(THUNES_DEFAULT_ENDPOINT_EVIDENCE.status).toBe("GLOBALLY_NXDOMAIN");
    const connector = new ThunesConnector({ clock: CLOCK, env: {} });
    expect(connector.endpointEvidence().status).toBe("GLOBALLY_NXDOMAIN");
  });

  it("capability definitions + pack carry the quote/transaction/payer-coverage ids", () => {
    const definitions = thunesCapabilityDefinitions();
    const ids = definitions.map((d) => d.capabilityId);
    expect(ids).toContain(THUNES_QUOTE_CAPABILITY_ID);
    expect(ids).toContain(THUNES_TRANSACTION_CAPABILITY_ID);
    expect(ids).toContain(THUNES_PAYER_COVERAGE_CAPABILITY_ID);
    const pack = thunesRailCapabilityPack();
    expect(pack.capabilityRefs.length).toBe(definitions.length);
  });

  it("the rail adapter registers on the BaseRailAdapter framework", () => {
    const rail = new ThunesProductionRail();
    expect(rail.adapterId).toBe("rail.thunes");
    expect(rail.implementationId).toBe("impl.rails.thunes.v2");
  });

  it("maps every transaction status in the recorded table with the exact classification", () => {
    expect(THUNES_TRANSACTION_STATUS_MAPPING.map((r) => r.providerState)).toEqual([
      "CREATED", "IN_PROGRESS", "HELD", "CONFIRMED", "RECONCILED", "CANCELED", "FAILED", "RETURNED",
    ]);
    const byState = new Map(THUNES_TRANSACTION_STATUS_MAPPING.map((r) => [r.providerState, r]));
    expect(byState.get("HELD")?.family).toBe("customer_action_required");
    expect(byState.get("HELD")?.requiresCustomerAction).toBe(true);
    expect(byState.get("CONFIRMED")?.isTerminal).toBe(true);
    expect(byState.get("RECONCILED")?.isTerminal).toBe(true);
    expect(byState.get("CANCELED")?.isTerminal).toBe(true);
    expect(byState.get("FAILED")?.isTerminal).toBe(true);
    expect(byState.get("RETURNED")?.isTerminal).toBe(true);
    expect(byState.get("CREATED")?.isTerminal).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Payer coverage law — observed-only eligibility
// ---------------------------------------------------------------------------

describe("thunes payer coverage law (observed-only records, beneficiary preconditions)", () => {
  const observedPayer = (overrides: Partial<ThunesPayerCoverageRecord> = {}): ThunesPayerCoverageRecord =>
    ({
      payerId: "26442",
      raw: { id: 26442, name: "Synthetic Payer", country_iso_code: "GH", currency: "GHS" },
      observedAt: T0,
      source: "CONNECTED_ACCOUNT_QUERY",
      beneficiaryRequirements: [
        { payerId: "26442", fieldName: "account_number", required: true },
        { payerId: "26442", fieldName: "bank_name", required: true },
        { payerId: "26442", fieldName: "optional_note", required: false },
      ],
      ...overrides,
    }) as ThunesPayerCoverageRecord;

  it("an EMPTY observed-payers registry yields NO_CONNECTED_INSTANCE_EVIDENCE — never eligible", () => {
    const verdict = thunesPayerEligibility({
      payerId: "26442",
      observedPayers: [],
      satisfiedRequirementFields: [],
    });
    expect(verdict.eligible).toBe(false);
    expect(verdict.basis).toBe("NO_CONNECTED_INSTANCE_EVIDENCE");
    expect(verdict.reason).toContain("never routable evidence");
  });

  it("an observed payer with unsatisfied beneficiary requirements is PRECONDITIONS_UNSATISFIED", () => {
    const verdict = thunesPayerEligibility({
      payerId: "26442",
      observedPayers: [observedPayer()],
      satisfiedRequirementFields: [],
    });
    expect(verdict.basis).toBe("PRECONDITIONS_UNSATISFIED");
    expect(verdict.unsatisfied).toEqual(["account_number", "bank_name"]);
  });

  it("an observed payer with all required fields satisfied is eligible", () => {
    const verdict = thunesPayerEligibility({
      payerId: "26442",
      observedPayers: [observedPayer()],
      satisfiedRequirementFields: ["account_number", "bank_name"],
    });
    expect(verdict.eligible).toBe(true);
    expect(verdict.basis).toBe("OBSERVED_AND_PRECONDITIONS_SATISFIED");
  });

  it("beneficiary requirement extraction handles the documented field shapes verbatim", () => {
    expect(
      thunesBeneficiaryRequirements("p1", { beneficiary_required_fields: ["account_number", "mobile_number"] }).map((r) => r.fieldName),
    ).toEqual(["account_number", "mobile_number"]);
    expect(thunesBeneficiaryRequirements("p1", { fields: [{ name: "email", required: false }] })).toMatchObject([
      { payerId: "p1", fieldName: "email", required: false },
    ]);
    expect(thunesBeneficiaryRequirements("p1", "not-an-object")).toEqual([]);
  });

  it("a payer-list observation envelope is lossless", () => {
    const payers: readonly ThunesPayerProviderObject[] = [
      { id: 26442, name: "Synthetic Payer", country_iso_code: "GH" },
    ];
    const envelope = thunesPayerListEnvelope(payers, CTX);
    expect(envelope.object.objectType).toBe("payer_list");
    expect(parseProviderStateEnvelope(serializeProviderStateEnvelope(envelope))).toEqual(envelope);
  });
});

// ---------------------------------------------------------------------------
// 3. Quote/transaction lifecycle → ProviderStateEnvelope (lossless, INV-C06)
// ---------------------------------------------------------------------------

describe("thunes lifecycle → ProviderStateEnvelope (lossless, INV-C06)", () => {
  it("a quote envelope is an observation: terminal 'created', family other, RAW quote verbatim", () => {
    const quote = { id: "qt_SYNTHETIC_1", sourceAmount: 10.5, sourceCurrency: "USD", targetCurrency: "GHS" } as ThunesQuoteProviderObject;
    const envelope = thunesQuoteEnvelope(quote, CTX);
    expect(envelope.object.objectType).toBe("quote");
    expect(envelope.classification.isTerminal).toBe(true);
    expect(envelope.classification.lifecycleStep).toBe("created");
    expect((envelope.state as { id?: string }).id).toBe("qt_SYNTHETIC_1");
    expect(parseProviderStateEnvelope(serializeProviderStateEnvelope(envelope))).toEqual(envelope);
  });

  it("maps every transaction status with the exact classification and lossless state", () => {
    for (const row of THUNES_TRANSACTION_STATUS_MAPPING) {
      const envelope = thunesTransactionEnvelope(
        { id: `trx_${row.providerState}`, status: row.providerState, externalId: "payswap-x" } as ThunesTransactionProviderObject,
        CTX,
      );
      expect(envelope.classification.family).toBe(row.family);
      expect(envelope.classification.isTerminal).toBe(row.isTerminal);
      expect(envelope.classification.requiresCustomerAction).toBe(row.requiresCustomerAction);
      expect(envelope.classification.lifecycleStep).toBe(row.lifecycleStep);
    }
  });

  it("HELD is the compliance-review family with an explicit customer action", () => {
    const envelope = thunesTransactionEnvelope(
      { id: "trx_held", status: "HELD" } as ThunesTransactionProviderObject,
      CTX,
    );
    expect(envelope.classification.family).toBe("customer_action_required");
    expect(envelope.classification.requiresCustomerAction).toBe(true);
    expect(envelope.actionRequired).toBeDefined();
  });

  it("CONFIRMED and RECONCILED are terminal settled-external; the RAW transaction rides the state verbatim", () => {
    const raw = { id: "trx_ok", status: "CONFIRMED", fees: { total: 1 }, rate: 12.34 } as unknown as ThunesTransactionProviderObject;
    const envelope = thunesTransactionEnvelope(raw, CTX);
    expect(envelope.classification.isTerminal).toBe(true);
    expect(envelope.state).toEqual(raw);
  });

  it("the caller's externalId (idempotency derivation) rides the state verbatim when the provider id is absent", () => {
    const envelope = thunesTransactionEnvelope(
      { thunesTrxId: "payswap-order-9", status: "CREATED" } as ThunesTransactionProviderObject,
      CTX,
    );
    expect(envelope.object.externalId).toBe("payswap-order-9");
  });

  it("an unmapped status stays non-terminal UNKNOWN — never FAILED", () => {
    const envelope = thunesTransactionEnvelope(
      { id: "trx_new", status: "SOME_NEW_STATUS" } as ThunesTransactionProviderObject,
      CTX,
    );
    expect(envelope.classification.isTerminal).toBe(false);
    expect(envelope.classification.family).toBe("payout");
    expect(envelope.classification.lifecycleStep).toBe("SOME_NEW_STATUS");
  });
});

// ---------------------------------------------------------------------------
// 4. Webhook verification (documented HMAC pattern, synthetic keys)
// ---------------------------------------------------------------------------

describe("thunes webhook verification (documented HMAC pattern)", () => {
  const rawBody = JSON.stringify({ type: "transaction_status_changed", id: "trx_hook_1", status: "CONFIRMED" });

  it("verifies a correctly signed delivery", () => {
    const signature = thunesWebhookSignature(SYNTHETIC_WEBHOOK_SECRET, rawBody);
    expect(
      verifyThunesWebhookDelivery({ signatureHeader: signature, rawBody }, { secret: SYNTHETIC_WEBHOOK_SECRET }),
    ).toMatchObject({ valid: true });
  });

  it("rejects missing and invalid signatures with distinct reasons", () => {
    expect(
      verifyThunesWebhookDelivery({ signatureHeader: undefined, rawBody }, { secret: SYNTHETIC_WEBHOOK_SECRET }),
    ).toMatchObject({ valid: false, reason: "MISSING_SIGNATURE" });
    expect(
      verifyThunesWebhookDelivery({ signatureHeader: "deadbeef", rawBody }, { secret: SYNTHETIC_WEBHOOK_SECRET }),
    ).toMatchObject({ valid: false, reason: "SIGNATURE_INVALID" });
  });

  it("the signature is an independent HMAC-SHA256 recomputation over the RAW body", () => {
    const expected = createHmac("sha256", SYNTHETIC_WEBHOOK_SECRET).update(rawBody).digest("hex");
    expect(thunesWebhookSignature(SYNTHETIC_WEBHOOK_SECRET, rawBody)).toBe(expected);
    expect(thunesWebhookSignature(SYNTHETIC_WEBHOOK_SECRET, `${rawBody}x`)).not.toBe(expected);
  });

  it("the deterministic event id is `${type}:${id}`; timestamps extract from epoch fields", () => {
    expect(thunesWebhookEventId(JSON.parse(rawBody) as unknown)).toBe("transaction_status_changed:trx_hook_1");
    expect(thunesWebhookEventId({ type: "untyped" })).toBe("untyped:no-id");
    expect(thunesWebhookEventId(null)).toBeUndefined();
    expect(typeof thunesWebhookEventTimestamp(JSON.parse(rawBody) as unknown)).not.toBe("string");
  });

  it("the webhook event envelope maps transaction-bearing payloads to the transaction envelope", () => {
    const payload = { transaction: { id: "trx_hook_1", status: "CONFIRMED" } };
    const envelope = thunesWebhookEventEnvelope(payload, WEBHOOK_CTX);
    expect(envelope.object.objectType).toBe("transaction");
    expect(parseProviderStateEnvelope(serializeProviderStateEnvelope(envelope))).toEqual(envelope);
  });

  it("non-transaction payloads produce the generic event envelope (whole payload verbatim)", () => {
    const envelope = thunesWebhookEventEnvelope({ type: "payer_updated", note: "synthetic" }, WEBHOOK_CTX);
    expect(envelope.object.objectType).toBe("event");
    expect(envelope.classification.lifecycleStep).toBe("payer_updated");
  });

  it("the verifier + ingestor accept a signed delivery and dedupe the replay (provider, eventId)", () => {
    const ingestor = createThunesWebhookIngestor({ secret: SYNTHETIC_WEBHOOK_SECRET, clock: CLOCK });
    const payload = JSON.parse(rawBody) as unknown;
    const canonicalBody = JSON.stringify(payload);
    const signature = thunesWebhookSignature(SYNTHETIC_WEBHOOK_SECRET, canonicalBody);
    const timestampSeconds = "1764999900"; // inside CLOCK's replay window
    const first = ingestor.ingest(
      thunesWebhookRawEvent({ eventId: "transaction_status_changed:trx_hook_1", payload, signatureHeader: signature, timestampSeconds }),
    );
    expect(first.kind).not.toBe("REJECTED");
    const replay = ingestor.ingest(
      thunesWebhookRawEvent({ eventId: "transaction_status_changed:trx_hook_1", payload, signatureHeader: signature, timestampSeconds }),
    );
    expect(replay.kind).toBe("ALREADY_INGESTED");
  });

  it("the verifier rejects a signature computed over a different body", () => {
    const verifier = new ThunesWebhookVerifier(SYNTHETIC_WEBHOOK_SECRET);
    const event = thunesWebhookRawEvent({
      eventId: "evt_1",
      payload: JSON.parse(rawBody) as unknown,
      signatureHeader: thunesWebhookSignature(SYNTHETIC_WEBHOOK_SECRET, `${rawBody}x`),
      timestampSeconds: "1764999900",
    });
    expect(verifier.verify(event, JSON.stringify(JSON.parse(rawBody)))).toMatchObject({ valid: false });
  });
});

// ---------------------------------------------------------------------------
// 5. Idempotency (deterministic externalId — INV-F05)
// ---------------------------------------------------------------------------

describe("thunes idempotency (deterministic externalId, INV-F05)", () => {
  it("derives the external id deterministically from the protocol key", () => {
    expect(thunesExternalId("order-9")).toBe("payswap-order-9");
    expect(thunesExternalId("order-9")).toBe(thunesExternalId("order-9"));
    expect(() => thunesExternalId("")).toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// 6. Connector — the honest blocked gate + fail-closed credential gating
// ---------------------------------------------------------------------------

describe("thunes connector — the honest NXDOMAIN gate (fail-closed, INV-NC04)", () => {
  it("NO credential: provider-calling operations throw RailNotAuthorizedError BEFORE any provider call", async () => {
    const transport = new ScriptedHttpTransport(() => jsonResponse(200, {}));
    const connector = new ThunesConnector({ clock: CLOCK, http: transport.transport, env: {} });
    await expect(
      connector.create(ctx(AUTHORITY, { kind: "create_quote", payerId: "26442", sourceAmountMajor: "10", sourceCurrency: "USD", targetCurrency: "GHS" }, "idem-1")),
    ).rejects.toThrow(
      RailNotAuthorizedError,
    );
    await expect(connector.read(ctx(AUTHORITY, { kind: "read_transaction", transactionId: "t1" }))).rejects.toThrow(
      RailNotAuthorizedError,
    );
    await expect(connector.observePayers()).rejects.toThrow(RailNotAuthorizedError);
    expect(transport.calls).toHaveLength(0);
  });

  it("credentialResolutionState reports NOT_PROVISIONED with the config key", () => {
    const connector = new ThunesConnector({ clock: CLOCK, env: {} });
    expect(connector.credentialResolutionState()).toMatchObject({
      kind: "NOT_PROVISIONED",
      configKey: THUNES_CREDENTIAL_CONFIG_KEY,
    });
  });

  it("credential PRESENT but the endpoint evidence is the NXDOMAIN datum: operations refuse citing the datum — no simulated substitute", async () => {
    const transport = new ScriptedHttpTransport(() => jsonResponse(200, {}));
    const connector = new ThunesConnector({
      clock: CLOCK,
      http: transport.transport,
      env: { PROVIDER_THUNES_CREDENTIAL_REF: SYNTHETIC_ENV_MATERIAL },
    });
    await expect(
      connector.create(ctx(AUTHORITY, { kind: "create_quote", payerId: "26442", sourceAmountMajor: "10", sourceCurrency: "USD", targetCurrency: "GHS" }, "idem-2")),
    ).rejects.toThrow(ThunesUnresolvableEndpointError);
    await expect(connector.observePayers()).rejects.toThrow(ThunesUnresolvableEndpointError);
    expect(transport.calls).toHaveLength(0); // the gate is BEFORE the auth call itself
  });

  it("the ThunesUnresolvableEndpointError IS a RailNotAuthorizedError (the fail-closed law holds verbatim)", () => {
    const error = new ThunesUnresolvableEndpointError("synthetic refusal");
    expect(error).toBeInstanceOf(RailNotAuthorizedError);
  });

  it("immutable SDK surfaces (update/search/subscribe/disconnect) refuse with ValidationErrors", async () => {
    const connector = new ThunesConnector({ clock: CLOCK, env: {} });
    await expect(connector.update(ctx(AUTHORITY, { kind: "read_transaction", transactionId: "t" }))).rejects.toThrow(
      ValidationError,
    );
    await expect(connector.search(ctx(AUTHORITY, { kind: "search" }))).rejects.toThrow(ValidationError);
    await expect(connector.subscribe(ctx(AUTHORITY, { kind: "read_transaction", transactionId: "t" }))).rejects.toThrow(
      ValidationError,
    );
    await expect(connector.disconnect(ctx(AUTHORITY, { kind: "read_transaction", transactionId: "t" }))).rejects.toThrow(
      ValidationError,
    );
  });
});

// ---------------------------------------------------------------------------
// 7. Connector with RESOLVED endpoint evidence (synthetic credentials, offline)
// ---------------------------------------------------------------------------

describe("thunes connector — provider calls with RESOLVED evidence + synthetic credentials (offline)", () => {
  const RESOLVED_EVIDENCE = {
    status: "RESOLVED" as const,
    probedAt: T0,
    detail: "operator-confirmed current host (synthetic fixture)",
    resolvedHost: "https://synthetic-thunes-host.example",
  };

  function resolvedConnector(
    respond: (url: string, init: { method: string; body?: string }) => { status: number; bodyText: string },
  ): { connector: ThunesConnector; transport: ScriptedHttpTransport } {
    const transport = new ScriptedHttpTransport(respond);
    return {
      connector: new ThunesConnector({
        clock: CLOCK,
        http: transport.transport,
        apiBase: RESOLVED_EVIDENCE.resolvedHost,
        endpointEvidence: RESOLVED_EVIDENCE,
        env: { PROVIDER_THUNES_CREDENTIAL_REF: SYNTHETIC_ENV_MATERIAL },
      }),
      transport,
    };
  }

  it("authenticates via POST /v2/authentication/api-keys then create_quote POSTs to /v2/quotes with the external id", async () => {
    const { connector, transport } = resolvedConnector((url) => {
      if (url.endsWith("/v2/authentication/api-keys")) {
        return jsonResponse(200, { token: "SYNTHETIC_BEARER_TOKEN" });
      }
      return jsonResponse(200, { id: "qt_SYNTHETIC_1", sourceAmount: 10, sourceCurrency: "USD", targetCurrency: "GHS" });
    });
    const result = await connector.create(
      ctx(AUTHORITY, { kind: "create_quote", payerId: "26442", sourceAmountMajor: "10", sourceCurrency: "usd", targetCurrency: "ghs" }, "order-33"),
    );
    expect(transport.calls[0]?.url).toBe(`${RESOLVED_EVIDENCE.resolvedHost}/v2/authentication/api-keys`);
    expect(transport.calls[1]?.url).toBe(`${RESOLVED_EVIDENCE.resolvedHost}/v2/quotes`);
    const body = JSON.parse(transport.calls[1]?.body ?? "{}") as Record<string, unknown>;
    expect(body).toMatchObject({ payerId: "26442", sourceCurrency: "USD", targetCurrency: "GHS" });
    expect(result.providerState.object.objectType).toBe("quote");
  });

  it("create_transaction POSTs to /v2/transactions with the quote id + beneficiary + derived external id", async () => {
    const { connector, transport } = resolvedConnector((url) => {
      if (url.endsWith("/v2/authentication/api-keys")) {
        return jsonResponse(200, { token: "SYNTHETIC_BEARER_TOKEN" });
      }
      return jsonResponse(200, { id: "trx_SYNTHETIC_1", status: "CREATED", thunesTrxId: "payswap-order-34" });
    });
    const result = await connector.executeAction(
      ctx(AUTHORITY, { kind: "create_transaction", quoteId: "qt_SYNTHETIC_1", beneficiary: { account_number: "synthetic" } }, "order-34"),
    );
    expect(transport.calls[1]?.url).toBe(`${RESOLVED_EVIDENCE.resolvedHost}/v2/transactions`);
    const body = JSON.parse(transport.calls[1]?.body ?? "{}") as Record<string, unknown>;
    expect(body).toMatchObject({ quoteId: "qt_SYNTHETIC_1" });
    expect(result.providerState.classification.family).toBe("payout");
    expect(result.providerState.classification.isTerminal).toBe(false);
  });

  it("confirm_transaction POSTs to the confirm path; read_transaction GETs the transaction", async () => {
    const { connector, transport } = resolvedConnector((url) => {
      if (url.endsWith("/v2/authentication/api-keys")) {
        return jsonResponse(200, { token: "SYNTHETIC_BEARER_TOKEN" });
      }
      if (url.includes("/confirm")) {
        return jsonResponse(200, { id: "trx_C", status: "IN_PROGRESS" });
      }
      return jsonResponse(200, { id: "trx_C", status: "CONFIRMED" });
    });
    const confirmed = await connector.executeAction(
      ctx(AUTHORITY, { kind: "confirm_transaction", transactionId: "trx_C" }, "order-35"),
    );
    expect(transport.calls[1]?.url).toContain("/v2/transactions/trx_C/confirm");
    expect(confirmed.providerState.classification.isTerminal).toBe(false); // IN_PROGRESS
    const read = await connector.read(ctx(AUTHORITY, { kind: "read_transaction", transactionId: "trx_C" }, "order-36"));
    expect(transport.calls[3]?.url).toBe(`${RESOLVED_EVIDENCE.resolvedHost}/v2/transactions/trx_C`);
    expect(read.providerState.classification.isTerminal).toBe(true); // CONFIRMED
  });

  it("read_payer GETs /v2/payers/{id}; observePayers GETs /v2/payers and builds coverage records", async () => {
    const { connector, transport } = resolvedConnector((url) => {
      if (url.endsWith("/v2/authentication/api-keys")) {
        return jsonResponse(200, { token: "SYNTHETIC_BEARER_TOKEN" });
      }
      if (url.endsWith("/v2/payers")) {
        return jsonResponse(200, [{ id: 26442, name: "Synthetic Payer", beneficiary_required_fields: ["account_number"] }]);
      }
      return jsonResponse(200, { id: 26442, name: "Synthetic Payer" });
    });
    const payer = await connector.read(ctx(AUTHORITY, { kind: "read_payer", payerId: "26442" }, "order-37"));
    expect(transport.calls[1]?.url).toBe(`${RESOLVED_EVIDENCE.resolvedHost}/v2/payers/26442`);
    expect(payer.providerState.object.objectType).toBe("payer_list");
    const { records } = await connector.observePayers();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ payerId: "26442", source: "CONNECTED_ACCOUNT_QUERY" });
    expect(records[0]?.beneficiaryRequirements.map((r) => r.fieldName)).toEqual(["account_number"]);
  });

  it("a provider error answer is a RailProviderError (never a fabricated outcome)", async () => {
    const { connector } = resolvedConnector((url) => {
      if (url.endsWith("/v2/authentication/api-keys")) {
        return jsonResponse(200, { token: "SYNTHETIC_BEARER_TOKEN" });
      }
      return jsonResponse(401, { message: "unauthorized" });
    });
    await expect(connector.read(ctx(AUTHORITY, { kind: "read_transaction", transactionId: "trx_BAD" }))).rejects.toThrow(
      RailProviderError,
    );
  });

  it("a mid-effect transport failure produces an OUTCOME_UNKNOWN envelope — NEVER FAILED (INV-X01)", async () => {
    const { connector } = resolvedConnector(() => {
      throw new Error("connection reset");
    });
    const result = await connector.create(
      ctx(AUTHORITY, { kind: "create_quote", payerId: "26442", sourceAmountMajor: "10", sourceCurrency: "USD", targetCurrency: "GHS" }, "order-x01"),
    );
    expect(result.providerState.classification.lifecycleStep).toBe("outcome_unknown");
    expect(result.providerState.classification.isTerminal).toBe(false);
    expect(result.providerState.failure?.ambiguity).toBe("OUTCOME_UNKNOWN");
  });

  it("no key material ever appears in envelopes, evidence, outcomes or health", async () => {
    const { connector } = resolvedConnector((url) => {
      if (url.endsWith("/v2/authentication/api-keys")) {
        return jsonResponse(200, { token: "SYNTHETIC_BEARER_TOKEN" });
      }
      return jsonResponse(200, { id: "trx_SEC", status: "CONFIRMED" });
    });
    const read = await connector.read(ctx(AUTHORITY, { kind: "read_transaction", transactionId: "trx_SEC" }));
    const health = await connector.health();
    for (const serialized of [
      stringifySafe(read.providerState),
      stringifySafe(read.evidence),
      stringifySafe(read.outcome),
      stringifySafe(health),
      serializeProviderStateEnvelope(read.providerState),
    ]) {
      expect(serialized).not.toContain(SYNTHETIC_API_KEY);
      expect(serialized).not.toContain(SYNTHETIC_SECRET_KEY);
    }
  });

  it("the control-plane path opens the sealed bundle per call (SEALED state; material never surfaces)", async () => {
    const store = new FixtureVaultStore();
    store.bind(THUNES_CREDENTIAL_CONFIG_KEY, "vault://payswap/providers/thunes/sandbox-20261002");
    store.seal("vault://payswap/providers/thunes/sandbox-20261002", { apiKey: SYNTHETIC_API_KEY, secretKey: SYNTHETIC_SECRET_KEY });
    const broker = new CredentialBroker({ store });
    const runtimeKey = broker.registerConnectorRuntime("runtime.thunes.test");
    const transport = new ScriptedHttpTransport((url) => {
      if (url.endsWith("/v2/authentication/api-keys")) {
        return jsonResponse(200, { token: "SYNTHETIC_BEARER_TOKEN" });
      }
      return jsonResponse(200, { id: "trx_CP", status: "CONFIRMED" });
    });
    const connector = new ThunesConnector({
      clock: CLOCK,
      http: transport.transport,
      apiBase: RESOLVED_EVIDENCE.resolvedHost,
      endpointEvidence: RESOLVED_EVIDENCE,
      credentials: { broker, runtimeKey },
    });
    expect(connector.credentialResolutionState()).toMatchObject({ kind: "CONTROL_PLANE_SEALED" });
    const result = await connector.read(ctx(AUTHORITY, { kind: "read_transaction", transactionId: "trx_CP" }));
    expect(result.providerState.object.externalId).toBe("trx_CP");
    expect(stringifySafe(result)).not.toContain(SYNTHETIC_SECRET_KEY);
  });

  it("invalid SDK requests are ValidationErrors (never reach the provider)", async () => {
    const connector = new ThunesConnector({ clock: CLOCK, env: {} });
    await expect(connector.read(ctx(AUTHORITY, { kind: "nonsense" }))).rejects.toThrow(ValidationError);
    await expect(
      connector.create(ctx(AUTHORITY, { kind: "create_quote", sourceAmountMajor: "10", sourceCurrency: "USD", targetCurrency: "GHS" })),
    ).rejects.toThrow(ValidationError);
  });
});

/** A control-plane vault fixture: config key → vault ref → sealed bundle. */
class FixtureVaultStore implements VaultStore {
  readonly storeId = "vault-fixture-thunes";
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
          providerName: "thunes",
          authorizationMode: "SCOPED_API_CREDENTIAL",
          vaultReference: vaultReference(reference),
          issuedAt: "2026-10-02T07:41:00Z",
          accountRef: "thunes-sandbox-account-20261002",
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

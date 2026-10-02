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
  AIRWALLEX_API_VERSION,
  AIRWALLEX_BALANCE_OBSERVATION_CAPABILITY_ID,
  AIRWALLEX_CREDENTIAL_CONFIG_KEY,
  AIRWALLEX_DEFAULT_API_BASE_DEMO,
  AIRWALLEX_DEFAULT_API_BASE_PROD,
  AIRWALLEX_DEMO_REACHABILITY_20261002,
  AIRWALLEX_PAYMENT_INTENT_CAPABILITY_ID,
  AIRWALLEX_PAYMENT_INTENT_STATUS_MAPPING,
  AIRWALLEX_PAYOUT_CAPABILITY_ID,
  AIRWALLEX_PAYOUT_STATUS_MAPPING,
  AIRWALLEX_PROVIDER_NAME,
  AirwallexConnector,
  AirwallexDuplicateRequestIdError,
  AirwallexProductionRail,
  AirwallexWebhookVerifier,
  airwallexBalanceObservations,
  airwallexCapabilityDefinitions,
  airwallexMinorUnits,
  airwallexPaymentIntentEnvelope,
  airwallexPayoutEnvelope,
  airwallexRailCapabilityPack,
  airwallexRequestId,
  airwallexSignWebhookPayload,
  airwallexWebhookEventId,
  airwallexWebhookEventTimestamp,
  airwallexWebhookRawEvent,
  createAirwallexWebhookIngestor,
  extractAirwallexClientCredentials,
  verifyAirwallexWebhookDelivery,
} from "../src/airwallex.js";
import type {
  AirwallexBalanceItemProviderObject,
  AirwallexBeneficiaryProviderObject,
  AirwallexPaymentIntentProviderObject,
  AirwallexPayoutProviderObject,
} from "../src/airwallex.js";
import { CLOCK, ctx, makeAdapterAuthority } from "./fixtures.js";

const AUTHORITY = makeAdapterAuthority();
const T0 = "2026-10-02T12:00:00.000Z";
const CTX = { observedAt: T0, provenanceSource: "PROVIDER_API" } as const;

// ---------------------------------------------------------------------------
// Synthetic fixtures ONLY (never real key material; byte-scan safe)
// ---------------------------------------------------------------------------

const SYNTHETIC_CONTROL_PLANE_MATERIAL = Object.freeze({
  clientId: "synthetic_client_id_TEST_0001",
  clientSecret: "synthetic_client_secret_TEST_0001",
});
const SYNTHETIC_ENV_MATERIAL = JSON.stringify({
  client_id: "synthetic_client_id_TEST_0002",
  client_secret: "synthetic_client_secret_TEST_0002",
});
const SYNTHETIC_WEBHOOK_SECRET = "synthetic_airwallex_webhook_secret_0003";
const SYNTHETIC_BEARER_TOKEN = "synthetic_bearer_token_TEST_0004";

function intent(
  status: string,
  overrides: Partial<AirwallexPaymentIntentProviderObject> = {},
): AirwallexPaymentIntentProviderObject {
  return {
    id: "int_xxxxxxxxxxxxxxxx0001",
    status,
    amount: "100.00",
    currency: "USD",
    request_id: "payswap-idem-sdk-1",
    ...overrides,
  };
}

function payout(
  status: string,
  overrides: Partial<AirwallexPayoutProviderObject> = {},
): AirwallexPayoutProviderObject {
  return {
    id: "po_xxxxxxxxxxxxxxxx0001",
    status,
    amount: "50.00",
    currency: "USD",
    beneficiary_id: "bene_xxxxxxxxxxxx0001",
    payout_method: "SWIFT",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test transports (offline, deterministic; record headers for assertions)
// ---------------------------------------------------------------------------

interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

class ScriptedAirwallexTransport {
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

/** The login-then-call scripted transport (demo base, bearer flow). */
function authenticatedTransport(
  respond: (call: RecordedCall) => { status: number; bodyText: string },
): ScriptedAirwallexTransport {
  return new ScriptedAirwallexTransport((call) => {
    if (call.url.endsWith("/api/v1/authentication/login")) {
      return jsonResponse(200, { token: SYNTHETIC_BEARER_TOKEN, expires_at: "2026-12-31T00:00:00Z" });
    }
    return respond(call);
  });
}

/** A control-plane vault fixture: config key → vault ref → sealed bundle. */
class FixtureVaultStore implements VaultStore {
  readonly storeId = "vault-fixture-airwallex";
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
          providerName: "airwallex",
          authorizationMode: "SCOPED_API_CREDENTIAL",
          vaultReference: vaultReference(reference),
          issuedAt: "2026-10-02T06:37:38Z",
          accountRef: "airwallex-demo-account-20261002",
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

const VAULT_REF = "vault://payswap/providers/airwallex/test-20261002";

function controlPlaneConnector(
  transport: ScriptedAirwallexTransport,
  material: unknown = SYNTHETIC_CONTROL_PLANE_MATERIAL,
): { connector: AirwallexConnector; store: FixtureVaultStore } {
  const store = new FixtureVaultStore();
  store.bind(AIRWALLEX_CREDENTIAL_CONFIG_KEY, VAULT_REF);
  store.seal(VAULT_REF, material);
  const broker = new CredentialBroker({ store });
  const runtimeKey = broker.registerConnectorRuntime("runtime.airwallex.test");
  const connector = new AirwallexConnector({
    clock: CLOCK,
    http: transport.transport,
    credentials: { broker, runtimeKey },
  });
  return { connector, store };
}

// ---------------------------------------------------------------------------
// 1. Identity, capability vocabulary, idempotency
// ---------------------------------------------------------------------------

describe("airwallex connector vocabulary (P2-W3-002)", () => {
  it("pins the provider identity, the v1 surface and the vault-template credential key", () => {
    expect(AIRWALLEX_PROVIDER_NAME).toBe("airwallex");
    expect(AIRWALLEX_API_VERSION).toBe("v1");
    expect(AIRWALLEX_CREDENTIAL_CONFIG_KEY).toBe("PROVIDER_AIRWALLEX_CREDENTIAL_REF");
    expect(AIRWALLEX_DEFAULT_API_BASE_DEMO).toBe("https://api-demo.airwallex.com");
    expect(AIRWALLEX_DEFAULT_API_BASE_PROD).toBe("https://api.airwallex.com");
  });

  it("records the 2026-10-02 reachability datum (HTTP 403 on the demo host — reachable, auth required)", () => {
    expect(AIRWALLEX_DEMO_REACHABILITY_20261002.httpStatus).toBe(403);
    expect(AIRWALLEX_DEMO_REACHABILITY_20261002.reachable).toBe(true);
    expect(AIRWALLEX_DEMO_REACHABILITY_20261002.baseUrl).toBe(AIRWALLEX_DEFAULT_API_BASE_DEMO);
    expect(AIRWALLEX_DEMO_REACHABILITY_20261002.interpretation).toContain("INV-C01/C02");
  });

  it("capability definitions + pack use the v1.5 vocabulary (no parallel model)", () => {
    const definitions = airwallexCapabilityDefinitions();
    expect(definitions.length).toBe(3);
    for (const definition of definitions) {
      expect(definition.authorization.protocolAuthorization).toBe(true);
      expect(definition.idempotency.duplicateBehavior).toBe("PROVIDER_DEFINED");
      expect(definition.providerVocabulary.states.length).toBeGreaterThan(0);
    }
    expect(airwallexRailCapabilityPack().sourceOfTruth).toBe("EXTERNAL_AUTHORITATIVE");
    const rail = new AirwallexProductionRail();
    expect(rail.adapterId).toBe("rail.airwallex");
    expect(rail.implementationId).toBe("impl.rails.airwallex.v1");
  });

  it("pay-in and payout are DISTINCT capability families (separate ids)", () => {
    const ids = airwallexCapabilityDefinitions().map((definition) => definition.capabilityId);
    expect(ids).toContain(AIRWALLEX_PAYMENT_INTENT_CAPABILITY_ID);
    expect(ids).toContain(AIRWALLEX_PAYOUT_CAPABILITY_ID);
    expect(ids).toContain(AIRWALLEX_BALANCE_OBSERVATION_CAPABILITY_ID);
    const payout = airwallexCapabilityDefinitions().find(
      (definition) => definition.capabilityId === AIRWALLEX_PAYOUT_CAPABILITY_ID,
    );
    expect(
      payout?.providerVocabulary.states.map((state) => state.canonicalState.split(":")[0]),
    ).toEqual(expect.arrayContaining(["payout"]));
    const payIn = airwallexCapabilityDefinitions().find(
      (definition) => definition.capabilityId === AIRWALLEX_PAYMENT_INTENT_CAPABILITY_ID,
    );
    expect(
      payIn?.providerVocabulary.states.map((state) => state.canonicalState.split(":")[0]),
    ).not.toContain("payout");
  });

  it("derives request_id from the protocol idempotency key (INV-F05), deterministically", () => {
    expect(airwallexRequestId("order-9")).toBe("payswap-order-9");
    expect(airwallexRequestId("order-9")).toBe("payswap-order-9");
    expect(() => airwallexRequestId("")).toThrow();
  });

  it("extracts the client pair from every documented bundle shape (fail-closed otherwise)", () => {
    expect(extractAirwallexClientCredentials(SYNTHETIC_ENV_MATERIAL)).toEqual({
      clientId: "synthetic_client_id_TEST_0002",
      clientSecret: "synthetic_client_secret_TEST_0002",
    });
    expect(extractAirwallexClientCredentials({ clientId: "a", clientSecret: "b" })).toEqual({
      clientId: "a",
      clientSecret: "b",
    });
    expect(() => extractAirwallexClientCredentials("not-json")).toThrow();
    expect(() => extractAirwallexClientCredentials({ unrelated: true })).toThrow();
    expect(() => extractAirwallexClientCredentials({ clientId: "a" })).toThrow();
  });

  it("minor-unit conversion is exact per currency (INV-F01 — never floats)", () => {
    expect(airwallexMinorUnits("100.00", "USD")).toBe("10000");
    expect(airwallexMinorUnits("1234", "JPY")).toBe("1234"); // zero-decimal currency
    expect(() => airwallexMinorUnits("1234.56", "JPY")).toThrow(/sub-minor/);
    expect(() => airwallexMinorUnits("100.00", "XYZ")).toThrow(/unknown minor-unit exponent/);
  });
});

// ---------------------------------------------------------------------------
// 2. Status lifecycle → ProviderStateEnvelope (lossless, INV-C06)
// ---------------------------------------------------------------------------

describe("airwallex connector — intent + payout status mapping (lossless, INV-C06)", () => {
  it("the exported mapping table covers exactly the seven documented intent statuses", () => {
    expect(AIRWALLEX_PAYMENT_INTENT_STATUS_MAPPING.map((row) => row.providerState)).toEqual([
      "PENDING", "AUTHORIZED", "CAPTURED", "SETTLED", "FAILED", "CANCELLED", "EXPIRED",
    ]);
  });

  for (const row of AIRWALLEX_PAYMENT_INTENT_STATUS_MAPPING) {
    it(`maps intent '${row.providerState}' → family=${row.family} step=${row.lifecycleStep} terminal=${row.isTerminal}`, () => {
      const envelope = airwallexPaymentIntentEnvelope(intent(row.providerState), CTX);
      expect(envelope.classification.family).toBe(row.family);
      expect(envelope.classification.lifecycleStep).toBe(row.lifecycleStep);
      expect(envelope.classification.isTerminal).toBe(row.isTerminal);
      expect(envelope.classification.requiresCustomerAction).toBe(row.requiresCustomerAction);
      expect((envelope.state as { status: string }).status).toBe(row.providerState);
    });
  }

  it("CAPTURED/SETTLED are settled-EXTERNAL (terminal; the connector claims no custody)", () => {
    for (const status of ["CAPTURED", "SETTLED"]) {
      const envelope = airwallexPaymentIntentEnvelope(intent(status), CTX);
      expect(envelope.classification.lifecycleStep).toBe("settled_external");
      expect(envelope.classification.isTerminal).toBe(true);
    }
  });

  it("FAILED/CANCELLED/EXPIRED carry definitive terminal failure; the raw status stays verbatim", () => {
    for (const status of ["FAILED", "CANCELLED", "EXPIRED"]) {
      const envelope = airwallexPaymentIntentEnvelope(intent(status), CTX);
      expect(envelope.classification.isTerminal).toBe(true);
      expect(envelope.failure?.ambiguity).toBe("NONE");
      expect((envelope.state as { status: string }).status).toBe(status);
    }
  });

  it("an UNKNOWN intent status stays non-terminal other (UNKNOWN, never FAILED)", () => {
    const envelope = airwallexPaymentIntentEnvelope(intent("BRAND_NEW_STATUS"), CTX);
    expect(envelope.classification.family).toBe("other");
    expect(envelope.classification.isTerminal).toBe(false);
    expect(envelope.classification.lifecycleStep).toBe("BRAND_NEW_STATUS");
  });

  it("carries the intent id as the external id and preserves provider identity/version", () => {
    const envelope = airwallexPaymentIntentEnvelope(intent("PENDING"), CTX);
    expect(envelope.provider.name).toBe(AIRWALLEX_PROVIDER_NAME);
    expect(envelope.provider.version).toBe(AIRWALLEX_API_VERSION);
    expect(envelope.object.objectType).toBe("payment_intent");
    expect(envelope.object.externalId).toBe("int_xxxxxxxxxxxxxxxx0001");
  });

  it("intent envelopes round-trip LOSSLESSLY through serialize/parse for every status", () => {
    for (const row of AIRWALLEX_PAYMENT_INTENT_STATUS_MAPPING) {
      const envelope = airwallexPaymentIntentEnvelope(intent(row.providerState), CTX);
      expect(parseProviderStateEnvelope(serializeProviderStateEnvelope(envelope))).toEqual(envelope);
    }
  });

  it("payout statuses map in the DISTINCT payout family (raw codes verbatim)", () => {
    expect(AIRWALLEX_PAYOUT_STATUS_MAPPING.map((row) => row.providerState)).toEqual([
      "PENDING", "COMPLETED", "RECONCILED", "CANCELLED", "FAILED",
    ]);
    for (const row of AIRWALLEX_PAYOUT_STATUS_MAPPING) {
      const envelope = airwallexPayoutEnvelope(payout(row.providerState), CTX);
      expect(envelope.classification.family).toBe("payout");
      expect(envelope.classification.isTerminal).toBe(row.isTerminal);
      expect((envelope.state as { status: string }).status).toBe(row.providerState);
    }
    const failed = airwallexPayoutEnvelope(payout("FAILED"), CTX);
    expect(failed.failure?.providerErrorCode).toBe("payout_failed");
    const unknown = airwallexPayoutEnvelope(payout("NEW_PAYOUT_STATE"), CTX);
    expect(unknown.classification.isTerminal).toBe(false);
    expect(unknown.classification.lifecycleStep).toBe("NEW_PAYOUT_STATE");
    const explicit = airwallexPayoutEnvelope(payout("PENDING"), CTX);
    expect((explicit.state as { beneficiary_id: string }).beneficiary_id).toBe("bene_xxxxxxxxxxxx0001");
  });

  it("balances map to validated ExternalFundsPositionObservations (never custody)", () => {
    const items: readonly AirwallexBalanceItemProviderObject[] = [
      { currency: "USD", available_balance: "100.50", pending_balance: "0.00" },
      { currency: "JPY", available_balance: "1234" },
      { currency: "AUD", available_balance: "12.345" }, // sub-minor → honest unconverted
      { currency: "ZZZ", available_balance: "1.00" }, // unknown exponent → honest unconverted
    ];
    const { observations, unconverted } = airwallexBalanceObservations({
      items,
      accountRef: "vault:PROVIDER_AIRWALLEX_CREDENTIAL_REF",
      observedAt: T0,
    });
    expect(observations).toHaveLength(3);
    for (const observation of observations) {
      expect(() => validateExternalFundsPositionObservation(observation)).not.toThrow();
      expect(observation.location.description).toContain("never custody");
    }
    const usd = observations.find((observation) => observation.observedAmount.currency === "USD");
    expect(usd?.observedAmount.minorUnits).toBe("10050");
    expect(unconverted.map((entry) => entry.currency)).toEqual(["AUD", "ZZZ"]);
  });
});

// ---------------------------------------------------------------------------
// 3. Webhook verification (X-Signature: hex HMAC-SHA256 over the RAW body)
// ---------------------------------------------------------------------------

describe("airwallex connector — webhook verification (hex-HMAC scheme)", () => {
  const signedBody = JSON.stringify({
    id: "evt_synth0001",
    name: "payment_intent.status_changed",
    created_at: "2026-10-02T11:00:00Z",
    data: { entity: intent("PENDING") },
  });
  const validSignature = airwallexSignWebhookPayload(SYNTHETIC_WEBHOOK_SECRET, signedBody);

  it("signs with hex(HMAC-SHA256(secret, raw body)) — the documented vector shape", () => {
    expect(validSignature).toMatch(/^[0-9a-f]{64}$/);
    expect(airwallexSignWebhookPayload("other", signedBody)).not.toBe(validSignature);
  });

  it("accepts a delivery whose X-Signature equals the expected hex HMAC (constant-time)", () => {
    expect(
      verifyAirwallexWebhookDelivery(
        { signatureHeader: validSignature, rawPayload: signedBody },
        { secret: SYNTHETIC_WEBHOOK_SECRET },
      ),
    ).toEqual({ valid: true });
  });

  it("rejects a wrong signature and a missing header (fail-closed)", () => {
    expect(
      verifyAirwallexWebhookDelivery(
        { signatureHeader: "deadbeef", rawPayload: signedBody },
        { secret: SYNTHETIC_WEBHOOK_SECRET },
      ),
    ).toMatchObject({ valid: false, reason: "SIGNATURE_INVALID" });
    expect(
      verifyAirwallexWebhookDelivery(
        { signatureHeader: undefined, rawPayload: signedBody },
        { secret: SYNTHETIC_WEBHOOK_SECRET },
      ),
    ).toMatchObject({ valid: false, reason: "MISSING_SIGNATURE" });
  });

  it("a re-serialized payload changes the bytes and correctly fails (raw body required)", () => {
    const reordered = JSON.stringify({ name: "payment_intent.status_changed", id: "evt_synth0001" });
    expect(
      verifyAirwallexWebhookDelivery(
        { signatureHeader: validSignature, rawPayload: reordered },
        { secret: SYNTHETIC_WEBHOOK_SECRET },
      ),
    ).toMatchObject({ valid: false, reason: "SIGNATURE_INVALID" });
  });

  it("the AirwallexWebhookVerifier implements the adapters hook over the canonical body", () => {
    const verifier = new AirwallexWebhookVerifier(SYNTHETIC_WEBHOOK_SECRET);
    const event = airwallexWebhookRawEvent({
      eventId: "payment_intent.status_changed:evt_synth0001",
      payload: JSON.parse(signedBody),
      signatureHeader: validSignature,
      timestampSeconds: "1765000000",
    });
    expect(verifier.verify(event, signedBody)).toEqual({ valid: true });
    expect(verifier.verify(event, JSON.stringify({ different: true }))).toMatchObject({
      valid: false,
      reason: "SIGNATURE_INVALID",
    });
    expect(() => new AirwallexWebhookVerifier("")).toThrow();
  });

  it("the ingestor wires the Airwallex scheme: accept, bad-signature reject, replayed eventId dedupe", () => {
    const ingestor = createAirwallexWebhookIngestor({
      secret: SYNTHETIC_WEBHOOK_SECRET,
      clock: CLOCK,
    });
    const rawEvent = airwallexWebhookRawEvent({
      eventId: "payment_intent.status_changed:evt_synth0001",
      payload: JSON.parse(signedBody),
      signatureHeader: validSignature,
      timestampSeconds: "1765000000",
    });
    const first = ingestor.ingest(rawEvent);
    expect(first.kind).not.toBe("REJECTED");
    const replay = ingestor.ingest(rawEvent);
    expect(replay.kind).toBe("ALREADY_INGESTED");
    const badSignature = airwallexWebhookRawEvent({
      eventId: "payout.status_changed:evt_synth0002",
      payload: JSON.parse(signedBody),
      signatureHeader: "deadbeef",
      timestampSeconds: "1765000000",
    });
    expect(ingestor.ingest(badSignature).kind).toBe("REJECTED");
  });

  it("the webhook event id derives from the documented `name` field (type/event_id aliases tolerated)", () => {
    expect(airwallexWebhookEventId(JSON.parse(signedBody))).toBe(
      "payment_intent.status_changed:evt_synth0001",
    );
    expect(airwallexWebhookEventId({ type: "payout.status_changed", event_id: 42 })).toBe(
      "payout.status_changed:42",
    );
    expect(airwallexWebhookEventId({ name: "x.y" })).toBe("x.y:no-id");
    expect(airwallexWebhookEventId({ id: "evt" })).toBeUndefined();
    expect(airwallexWebhookEventId(null)).toBeUndefined();
    expect(airwallexWebhookEventTimestamp(JSON.parse(signedBody))).toBe("1790938800");
    expect(airwallexWebhookEventTimestamp({ created_at: "garbage" })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4. Fail-closed credential gating (INV-NC04)
// ---------------------------------------------------------------------------

describe("airwallex connector — fail-closed credential gating", () => {
  it("no credential: availability UNKNOWN with provenance, never routable", () => {
    const transport = new ScriptedAirwallexTransport(() => jsonResponse(403, { message: "forbidden" }));
    const connector = new AirwallexConnector({ clock: CLOCK, http: transport.transport });
    const observation = connector.availabilityObservation({
      instanceId: "inst-rails-airwallex-1",
      observationVersion: 1,
    });
    expect(observation.availability).toBe("UNKNOWN");
    expect(observation.sourceAvailability).toBe("UNKNOWN");
    const implication = connector.railImplication(observation.availability);
    expect(implication.routable).toBe(false);
    expect(implication.reason).toContain("INV-NC04");
  });

  it("no credential: health is DEGRADED (endpoint answers, e.g. the recorded 403) or UNKNOWN (transport dead)", async () => {
    const answering = new ScriptedAirwallexTransport(() => jsonResponse(403, { message: "forbidden" }));
    const degraded = await new AirwallexConnector({ clock: CLOCK, http: answering.transport }).health();
    expect(degraded.status).toBe("DEGRADED");
    expect(degraded.degradedReasons[0]).toContain("credentials absent");
    expect(degraded.degradedReasons[0]).toContain("403");

    const dead = new ScriptedAirwallexTransport(() => {
      throw new Error("network down");
    });
    const unknown = await new AirwallexConnector({ clock: CLOCK, http: dead.transport }).health();
    expect(unknown.status).toBe("UNKNOWN");
  });

  it("no credential: effectful operations throw RailNotAuthorizedError BEFORE any provider call", async () => {
    const transport = new ScriptedAirwallexTransport(() => jsonResponse(200, {}));
    const connector = new AirwallexConnector({ clock: CLOCK, http: transport.transport });
    await expect(
      connector.create(
        ctx(AUTHORITY, { kind: "create_payment_intent", amount: "100.00", currency: "USD" }),
      ),
    ).rejects.toThrow(RailNotAuthorizedError);
    await expect(
      connector.update(ctx(AUTHORITY, { kind: "confirm_intent", intentId: "int_x" })),
    ).rejects.toThrow(RailNotAuthorizedError);
    await expect(
      connector.executeAction(
        ctx(AUTHORITY, {
          kind: "create_payout",
          payoutMethod: "SWIFT",
          beneficiaryId: "bene_x",
          amount: "10.00",
          currency: "USD",
        }),
      ),
    ).rejects.toThrow(RailNotAuthorizedError);
    await expect(connector.observeExternalFunds()).rejects.toThrow(RailNotAuthorizedError);
    await expect(connector.observePaymentMethods({})).rejects.toThrow(RailNotAuthorizedError);
    expect(transport.calls).toHaveLength(0); // fail-closed BEFORE any provider call
  });

  it("credential surface declares the control-plane config key; resolution state is honest (never material)", () => {
    const connector = new AirwallexConnector({ clock: CLOCK });
    expect(connector.credentialSurface()).toEqual([
      { envVar: "PROVIDER_AIRWALLEX_CREDENTIAL_REF", kind: "API_KEY" },
    ]);
    expect(connector.credentialResolutionState()).toEqual({
      kind: "NOT_PROVISIONED",
      configKey: "PROVIDER_AIRWALLEX_CREDENTIAL_REF",
      reason: expect.stringContaining("INV-NC04"),
    });
    const sealedState = controlPlaneConnector(
      new ScriptedAirwallexTransport(() => jsonResponse(200, {})),
    ).connector.credentialResolutionState();
    expect(sealedState.kind).toBe("CONTROL_PLANE_SEALED");
    expect(JSON.stringify(sealedState)).not.toContain(SYNTHETIC_CONTROL_PLANE_MATERIAL.clientId);
    expect(JSON.stringify(sealedState)).not.toContain(SYNTHETIC_CONTROL_PLANE_MATERIAL.clientSecret);
  });

  it("control plane with an UNBOUND config key fails closed (no silent fallback)", async () => {
    const store = new FixtureVaultStore(); // nothing bound
    const broker = new CredentialBroker({ store });
    const runtimeKey = broker.registerConnectorRuntime("runtime.airwallex.test");
    const transport = new ScriptedAirwallexTransport(() => jsonResponse(200, {}));
    const connector = new AirwallexConnector({
      clock: CLOCK,
      http: transport.transport,
      credentials: { broker, runtimeKey },
    });
    await expect(
      connector.read(ctx(AUTHORITY, { kind: "read_intent", intentId: "int_x" })),
    ).rejects.toThrow(RailNotAuthorizedError);
    expect(transport.calls).toHaveLength(0);
  });

  it("a malformed sealed bundle (no client pair) refuses the call (fail-closed, no guessing)", async () => {
    const transport = new ScriptedAirwallexTransport(() => jsonResponse(200, {}));
    const { connector } = controlPlaneConnector(transport, { unrelated: true });
    await expect(
      connector.read(ctx(AUTHORITY, { kind: "read_intent", intentId: "int_x" })),
    ).rejects.toThrow(/client pair/);
    expect(transport.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Real request paths (scripted transport, no network)
// ---------------------------------------------------------------------------

describe("airwallex connector — provider calls (scripted transport, no network)", () => {
  it("logs in with Basic base64(client_id:client_secret) then creates an intent with the derived request_id", async () => {
    const transport = authenticatedTransport(() => jsonResponse(200, intent("PENDING")));
    const { connector } = controlPlaneConnector(transport);
    const result = await connector.create(
      ctx(AUTHORITY, { kind: "create_payment_intent", amount: "100.00", currency: "usd" }),
    );
    const login = transport.calls[0];
    expect(login?.url).toBe("https://api-demo.airwallex.com/api/v1/authentication/login");
    const expectedBasic = Buffer.from(
      `${SYNTHETIC_CONTROL_PLANE_MATERIAL.clientId}:${SYNTHETIC_CONTROL_PLANE_MATERIAL.clientSecret}`,
      "utf8",
    ).toString("base64");
    expect(login?.headers["Authorization"]).toBe(`Basic ${expectedBasic}`);
    const create = transport.calls[1];
    expect(create?.url).toBe("https://api-demo.airwallex.com/api/v1/payment_intents");
    expect(create?.headers["Authorization"]).toBe(`Bearer ${SYNTHETIC_BEARER_TOKEN}`);
    const body = JSON.parse(create?.body ?? "{}") as Record<string, unknown>;
    expect(body).toMatchObject({
      request_id: "payswap-idem-sdk-1",
      amount: "100.00",
      currency: "USD",
    });
    expect(result.providerState.classification.family).toBe("async_processing");
  });

  it("the bearer token is cached until the provider-declared expiry (one login per epoch)", async () => {
    const transport = authenticatedTransport(() => jsonResponse(200, intent("PENDING")));
    const { connector } = controlPlaneConnector(transport);
    await connector.read(ctx(AUTHORITY, { kind: "read_intent", intentId: "int_x" }));
    await connector.read(ctx(AUTHORITY, { kind: "read_intent", intentId: "int_y" }));
    const logins = transport.calls.filter((call) =>
      call.url.endsWith("/authentication/login"),
    );
    expect(logins).toHaveLength(1);
    expect(transport.calls[1]?.url).toBe("https://api-demo.airwallex.com/api/v1/payment_intents/int_x");
    expect(transport.calls[2]?.url).toBe("https://api-demo.airwallex.com/api/v1/payment_intents/int_y");
  });

  it("confirm and capture hit the documented intent sub-paths", async () => {
    const transport = authenticatedTransport(() => jsonResponse(200, intent("AUTHORIZED")));
    const { connector } = controlPlaneConnector(transport);
    await connector.update(ctx(AUTHORITY, { kind: "confirm_intent", intentId: "int_x" }));
    expect(transport.calls[1]?.url).toBe(
      "https://api-demo.airwallex.com/api/v1/payment_intents/int_x/confirm",
    );
    const captureTransport = authenticatedTransport(() => jsonResponse(200, intent("CAPTURED")));
    const { connector: captureConnector } = controlPlaneConnector(captureTransport);
    const result = await captureConnector.update(
      ctx(AUTHORITY, { kind: "capture_intent", intentId: "int_x", amount: "100.00", currency: "USD" }),
    );
    expect(captureTransport.calls[1]?.url).toBe(
      "https://api-demo.airwallex.com/api/v1/payment_intents/int_x/capture",
    );
    expect(result.providerState.classification.lifecycleStep).toBe("settled_external");
  });

  it("payout creation posts the DISTINCT payout family with the EXPLICIT beneficiary", async () => {
    const transport = authenticatedTransport(() => jsonResponse(200, payout("PENDING")));
    const { connector } = controlPlaneConnector(transport);
    const result = await connector.executeAction(
      ctx(AUTHORITY, {
        kind: "create_payout",
        payoutMethod: "SWIFT",
        beneficiaryId: "bene_xxxxxxxxxxxx0001",
        amount: "50.00",
        currency: "USD",
      }),
    );
    expect(transport.calls[1]?.url).toBe("https://api-demo.airwallex.com/api/v1/payouts/create");
    const body = JSON.parse(transport.calls[1]?.body ?? "{}") as Record<string, unknown>;
    expect(body).toMatchObject({
      payout_method: "SWIFT",
      beneficiary_id: "bene_xxxxxxxxxxxx0001",
      amount: "50.00",
      currency: "USD",
      request_id: "payswap-idem-sdk-1",
    });
    expect(result.providerState.classification.family).toBe("payout");
    expect(result.providerState.classification.isTerminal).toBe(false);
  });

  it("beneficiary and payout reads observe the external counterparty/state", async () => {
    const transport = authenticatedTransport(() =>
      jsonResponse(200, { id: "bene_xxxxxxxxxxxx0001", beneficiary_type: "individual" }),
    );
    const { connector } = controlPlaneConnector(transport);
    const result = await connector.executeAction(
      ctx(AUTHORITY, { kind: "read_beneficiary", beneficiaryId: "bene_xxxxxxxxxxxx0001" }),
    );
    expect(transport.calls[1]?.url).toBe(
      "https://api-demo.airwallex.com/api/v1/beneficiaries/bene_xxxxxxxxxxxx0001",
    );
    expect(result.providerState.object.objectType).toBe("beneficiary");
  });

  it("a duplicate request_id is the AirwallexDuplicateRequestIdError provider error class (never silent success)", async () => {
    const transport = authenticatedTransport(() =>
      jsonResponse(400, { code: "duplicate_request", message: "request_id is duplicate" }),
    );
    const { connector } = controlPlaneConnector(transport);
    await expect(
      connector.create(
        ctx(AUTHORITY, { kind: "create_payment_intent", amount: "100.00", currency: "USD" }),
      ),
    ).rejects.toThrow(AirwallexDuplicateRequestIdError);
  });

  it("a mid-effect transport failure is OUTCOME_UNKNOWN — never FAILED (INV-X01)", async () => {
    const transport = new ScriptedAirwallexTransport(() => {
      throw new Error("connection reset mid-flight");
    });
    const { connector } = controlPlaneConnector(transport);
    const result = await connector.create(
      ctx(AUTHORITY, { kind: "create_payment_intent", amount: "100.00", currency: "USD" }),
    );
    expect(result.providerState.classification.lifecycleStep).toBe("outcome_unknown");
    expect(result.providerState.failure?.ambiguity).toBe("OUTCOME_UNKNOWN");
    expect(result.providerState.classification.isTerminal).toBe(false);
  });

  it("observePaymentMethods queries the OBSERVED eligibility surface with context params", async () => {
    const transport = authenticatedTransport(() =>
      jsonResponse(200, { items: [{ name: "card", transaction_currency: "USD" }] }),
    );
    const { connector } = controlPlaneConnector(transport);
    const envelope = await connector.observePaymentMethods({
      transactionCurrency: "usd",
      transactionCountry: "us",
    });
    expect(transport.calls[1]?.url).toBe(
      "https://api-demo.airwallex.com/api/v1/payment_methods/current?transaction_currency=USD&transaction_country=US",
    );
    expect(envelope.classification.lifecycleStep).toBe("observed");
  });

  it("observeExternalFunds reads the balance endpoint and returns validated observations", async () => {
    const transport = authenticatedTransport(() =>
      jsonResponse(200, {
        items: [
          { currency: "USD", available_balance: "100.50", pending_balance: "1.00" },
          { currency: "JPY", available_balance: "5000" },
        ],
      }),
    );
    const { connector } = controlPlaneConnector(transport);
    const observations = await connector.observeExternalFunds();
    expect(transport.calls[1]?.url).toBe(
      "https://api-demo.airwallex.com/api/v1/accounts/current/balances",
    );
    expect(observations).toHaveLength(3);
    for (const observation of observations) {
      expect(() => validateExternalFundsPositionObservation(observation)).not.toThrow();
    }
    const usd = observations.find((observation) => observation.observedAmount.currency === "USD");
    expect(usd?.observedAmount.minorUnits).toBe("10050");
  });

  it("health() with credentials runs the authenticated login probe", async () => {
    const transport = authenticatedTransport(() => jsonResponse(200, {}));
    const { connector } = controlPlaneConnector(transport);
    const report = await connector.health();
    expect(report.status).toBe("HEALTHY");
    expect(transport.calls[0]?.url).toBe(
      "https://api-demo.airwallex.com/api/v1/authentication/login",
    );
  });

  it("an amount that is not an exact decimal string is refused before any call (INV-F01)", async () => {
    const transport = authenticatedTransport(() => jsonResponse(200, {}));
    const { connector } = controlPlaneConnector(transport);
    await expect(
      connector.create(
        ctx(AUTHORITY, { kind: "create_payment_intent", amount: "10.0.5", currency: "USD" }),
      ),
    ).rejects.toThrow(/exact non-negative decimal/);
    expect(transport.calls).toHaveLength(0);
  });
});

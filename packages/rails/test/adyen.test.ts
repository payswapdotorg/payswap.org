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
import { RailNotAuthorizedError, RailTransportError } from "../src/support.js";
import type { HttpTransport } from "../src/support.js";
import {
  ADYEN_API_VERSION,
  ADYEN_CHECKOUT_PAYMENT_CAPABILITY_ID,
  ADYEN_CREDENTIAL_CONFIG_KEY,
  ADYEN_DEFAULT_CHECKOUT_BASE_LIVE,
  ADYEN_DEFAULT_CHECKOUT_BASE_TEST,
  ADYEN_PAYOUT_OBSERVATION_CAPABILITY_ID,
  ADYEN_PAYMENT_METHODS_OBSERVATION_CAPABILITY_ID,
  ADYEN_PROVIDER_NAME,
  ADYEN_RESULT_CODE_MAPPING,
  ADYEN_TEST_REACHABILITY_20261002,
  ADYEN_WEBHOOK_EVENT_CODE_MAPPING,
  AdyenConnector,
  AdyenProductionRail,
  AdyenWebhookVerifier,
  adyenCapabilityDefinitions,
  adyenExtractHmacSignature,
  adyenIdempotencyKeyHeader,
  adyenMerchantReference,
  adyenMinorUnitsFromIntegerValue,
  adyenModificationEnvelope,
  adyenPaymentEnvelope,
  adyenPaymentMethodsEnvelope,
  adyenPayoutObservation,
  adyenPayoutStatusEnvelope,
  adyenRailCapabilityPack,
  adyenSignWebhookPayload,
  adyenWebhookEventId,
  adyenWebhookEventTimestamp,
  adyenWebhookItemEnvelope,
  adyenWebhookRawEvent,
  createAdyenWebhookIngestor,
  extractAdyenKeyMaterial,
  verifyAdyenWebhookDelivery,
} from "../src/adyen.js";
import type {
  AdyenModificationResponseProviderObject,
  AdyenNotificationItemProviderObject,
  AdyenPaymentMethodsResponseProviderObject,
  AdyenPaymentResponseProviderObject,
  AdyenPayoutProviderObject,
} from "../src/adyen.js";
import { CLOCK, ctx, makeAdapterAuthority } from "./fixtures.js";

const AUTHORITY = makeAdapterAuthority();
const T0 = "2026-10-02T12:00:00.000Z";
const CTX = { observedAt: T0, provenanceSource: "PROVIDER_API" } as const;

// ---------------------------------------------------------------------------
// Synthetic fixtures ONLY (never real key material; byte-scan safe)
// ---------------------------------------------------------------------------

const SYNTHETIC_CONTROL_PLANE_MATERIAL = "AQEyTESTtesttesttestTESTSYNTHETIC0001";
const SYNTHETIC_ENV_MATERIAL = "AQEyTESTtesttesttestTESTSYNTHETIC0002env";
const SYNTHETIC_WEBHOOK_SECRET = "SYNTHETIC-ADYEN-WEBHOOK-HMAC-SECRET-0003";

function payment(
  resultCode: string,
  overrides: Partial<AdyenPaymentResponseProviderObject> = {},
): AdyenPaymentResponseProviderObject {
  return {
    pspReference: "8836254765937172",
    resultCode,
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

class ScriptedAdyenTransport {
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
  readonly storeId = "vault-fixture-adyen";
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
          providerName: "adyen",
          authorizationMode: "SCOPED_API_CREDENTIAL",
          vaultReference: vaultReference(reference),
          issuedAt: "2026-10-02T06:37:38Z",
          accountRef: "adyen-test-account-20261002",
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

const VAULT_REF = "vault://payswap/providers/adyen/test-20261002";

function controlPlaneConnector(
  transport: ScriptedAdyenTransport,
  material: unknown = SYNTHETIC_CONTROL_PLANE_MATERIAL,
): { connector: AdyenConnector; store: FixtureVaultStore } {
  const store = new FixtureVaultStore();
  store.bind(ADYEN_CREDENTIAL_CONFIG_KEY, VAULT_REF);
  store.seal(VAULT_REF, material);
  const broker = new CredentialBroker({ store });
  const runtimeKey = broker.registerConnectorRuntime("runtime.adyen.test");
  const connector = new AdyenConnector({
    clock: CLOCK,
    http: transport.transport,
    credentials: { broker, runtimeKey },
    merchantAccount: "TestPayswapECOM",
  });
  return { connector, store };
}

function envConnector(
  transport: ScriptedAdyenTransport,
  env: NodeJS.ProcessEnv = { [ADYEN_CREDENTIAL_CONFIG_KEY]: SYNTHETIC_ENV_MATERIAL },
): AdyenConnector {
  return new AdyenConnector({
    clock: CLOCK,
    http: transport.transport,
    env,
    merchantAccount: "TestPayswapECOM",
  });
}

// ---------------------------------------------------------------------------
// 1. Identity, capability vocabulary, eligibility honesty
// ---------------------------------------------------------------------------

describe("adyen connector vocabulary (P2-W3-002)", () => {
  it("pins the provider identity, the pinned v70 checkout surface and the vault-template credential key", () => {
    expect(ADYEN_PROVIDER_NAME).toBe("adyen");
    expect(ADYEN_API_VERSION).toBe("v70");
    expect(ADYEN_CREDENTIAL_CONFIG_KEY).toBe("PROVIDER_ADYEN_CREDENTIAL_REF");
    expect(ADYEN_DEFAULT_CHECKOUT_BASE_TEST).toBe("https://checkout-test.adyen.com");
    expect(ADYEN_DEFAULT_CHECKOUT_BASE_LIVE).toBe("https://checkout-live.adyen.com");
  });

  it("records the 2026-10-02 reachability datum (HTTP 401 on the test host — reachable, API key required)", () => {
    expect(ADYEN_TEST_REACHABILITY_20261002.httpStatus).toBe(401);
    expect(ADYEN_TEST_REACHABILITY_20261002.reachable).toBe(true);
    expect(ADYEN_TEST_REACHABILITY_20261002.baseUrl).toBe(ADYEN_DEFAULT_CHECKOUT_BASE_TEST);
    expect(ADYEN_TEST_REACHABILITY_20261002.interpretation).toContain("INV-C01/C02");
  });

  it("capability definitions + pack use the v1.5 vocabulary (no parallel model)", () => {
    const definitions = adyenCapabilityDefinitions();
    expect(definitions.length).toBe(3);
    for (const definition of definitions) {
      expect(definition.authorization.protocolAuthorization).toBe(true);
      expect(definition.idempotency.duplicateBehavior).toBe("PROVIDER_DEFINED");
      expect(definition.providerVocabulary.states.length).toBeGreaterThan(0);
    }
    const pack = adyenRailCapabilityPack();
    expect(pack.sourceOfTruth).toBe("EXTERNAL_AUTHORITATIVE");
    const rail = new AdyenProductionRail();
    expect(rail.adapterId).toBe("rail.adyen");
    expect(rail.implementationId).toBe("impl.rails.adyen.v70");
  });

  it("pay-in and payout are DISTINCT capability families (separate ids; payout is observation-only)", () => {
    const ids = adyenCapabilityDefinitions().map((definition) => definition.capabilityId);
    expect(ids).toContain(ADYEN_CHECKOUT_PAYMENT_CAPABILITY_ID);
    expect(ids).toContain(ADYEN_PAYOUT_OBSERVATION_CAPABILITY_ID);
    expect(ids).toContain(ADYEN_PAYMENT_METHODS_OBSERVATION_CAPABILITY_ID);
    const payout = adyenCapabilityDefinitions().find(
      (definition) => definition.capabilityId === ADYEN_PAYOUT_OBSERVATION_CAPABILITY_ID,
    );
    expect(payout?.providerVocabulary.states.map((state) => state.canonicalState.split(":")[0])).toEqual(
      expect.arrayContaining(["payout"]),
    );
    const payIn = adyenCapabilityDefinitions().find(
      (definition) => definition.capabilityId === ADYEN_CHECKOUT_PAYMENT_CAPABILITY_ID,
    );
    expect(payIn?.providerVocabulary.states.map((state) => state.canonicalState.split(":")[0])).not.toContain(
      "payout",
    );
  });

  it("derives reference + Idempotency-Key from the protocol key (INV-F05), deterministically", () => {
    expect(adyenMerchantReference("order-9")).toBe("payswap:order-9");
    expect(adyenMerchantReference("order-9")).toBe("payswap:order-9");
    expect(adyenIdempotencyKeyHeader("order-9")).toBe("payswap-idem:order-9");
    expect(() => adyenMerchantReference("")).toThrow();
    expect(() => adyenIdempotencyKeyHeader("")).toThrow();
  });

  it("amounts are integer minor units exactly (INV-F01 — never floats, never guessed)", () => {
    expect(adyenMinorUnitsFromIntegerValue(1000, "EUR")).toBe("1000");
    expect(adyenMinorUnitsFromIntegerValue("1250", "KES")).toBe("1250");
    expect(adyenMinorUnitsFromIntegerValue(1.5, "EUR")).toBeUndefined();
    expect(adyenMinorUnitsFromIntegerValue(-1, "EUR")).toBeUndefined();
    expect(adyenMinorUnitsFromIntegerValue("12abc", "EUR")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. resultCode lifecycle → ProviderStateEnvelope (lossless, INV-C06)
// ---------------------------------------------------------------------------

describe("adyen connector — resultCode mapping (lossless, INV-C06)", () => {
  it("the exported mapping table covers exactly the ten documented resultCodes", () => {
    expect(ADYEN_RESULT_CODE_MAPPING.map((row) => row.providerState)).toEqual([
      "Authorised", "Refused", "Received", "Pending", "ConfirmationPending",
      "RedirectShopper", "ChallengeShopper", "IdentifyShopper", "PresentToShopper", "Cancelled",
    ]);
  });

  for (const row of ADYEN_RESULT_CODE_MAPPING) {
    it(`maps '${row.providerState}' → family=${row.family} step=${row.lifecycleStep} terminal=${row.isTerminal}`, () => {
      const envelope = adyenPaymentEnvelope(payment(row.providerState), CTX);
      expect(envelope.classification.family).toBe(row.family);
      expect(envelope.classification.lifecycleStep).toBe(row.lifecycleStep);
      expect(envelope.classification.isTerminal).toBe(row.isTerminal);
      expect(envelope.classification.requiresCustomerAction).toBe(row.requiresCustomerAction);
      expect((envelope.state as { resultCode: string }).resultCode).toBe(row.providerState);
    });
  }

  it("carries the pspReference as the external id and preserves provider identity/version", () => {
    const envelope = adyenPaymentEnvelope(payment("Authorised"), CTX);
    expect(envelope.provider.name).toBe(ADYEN_PROVIDER_NAME);
    expect(envelope.provider.version).toBe(ADYEN_API_VERSION);
    expect(envelope.object.objectType).toBe("payment");
    expect(envelope.object.externalId).toBe("8836254765937172");
  });

  it("Refused carries definitive failure with the provider refusalReason verbatim", () => {
    const envelope = adyenPaymentEnvelope(
      payment("Refused", { refusalReason: "REFUSED_NO_BALANCE" }),
      CTX,
    );
    expect(envelope.classification.isTerminal).toBe(true);
    expect(envelope.failure?.providerErrorCode).toBe("REFUSED_NO_BALANCE");
    expect(envelope.failure?.ambiguity).toBe("NONE");
  });

  it("action resultCodes are first-class customer-action states with the action object VERBATIM", () => {
    const action = { type: "redirect", url: "https://checkout-test.adyen.com/synth/redirect", paymentData: "Ab02b4c0!SYNTHETIC" };
    for (const resultCode of ["RedirectShopper", "ChallengeShopper", "IdentifyShopper", "PresentToShopper"]) {
      const envelope = adyenPaymentEnvelope(payment(resultCode, { action }), CTX);
      expect(envelope.classification.family).toBe("customer_action_required");
      expect(envelope.classification.requiresCustomerAction).toBe(true);
      expect(envelope.classification.isTerminal).toBe(false);
      expect((envelope.state as { action: unknown }).action).toEqual(action);
    }
    const redirect = adyenPaymentEnvelope(payment("RedirectShopper", { action }), CTX);
    expect(redirect.actionRequired?.kind).toBe("PROVIDER_CHALLENGE_REDIRECT");
    expect(redirect.actionRequired?.deepLink).toBe(action.url);
    const challenge = adyenPaymentEnvelope(
      payment("ChallengeShopper", { action: { type: "threeDS2Fingerprint" } }),
      CTX,
    );
    expect(challenge.actionRequired?.kind).toBe("PROVIDER_CHALLENGE");
  });

  it("an UNKNOWN resultCode stays non-terminal other (UNKNOWN, never FAILED)", () => {
    const envelope = adyenPaymentEnvelope(payment("BrandNewResultCode"), CTX);
    expect(envelope.classification.family).toBe("other");
    expect(envelope.classification.isTerminal).toBe(false);
    expect(envelope.classification.lifecycleStep).toBe("BrandNewResultCode");
    expect((envelope.state as { resultCode: string }).resultCode).toBe("BrandNewResultCode");
  });

  it("provider-state envelopes round-trip LOSSLESSLY through serialize/parse for every resultCode", () => {
    for (const row of ADYEN_RESULT_CODE_MAPPING) {
      const envelope = adyenPaymentEnvelope(payment(row.providerState), CTX);
      expect(parseProviderStateEnvelope(serializeProviderStateEnvelope(envelope))).toEqual(envelope);
    }
  });

  it("modifications are ASYNCHRONOUS: status 'received' is processing until webhook evidence", () => {
    const modification: AdyenModificationResponseProviderObject = {
      pspReference: "8836254765937173",
      status: "received",
    };
    const envelope = adyenModificationEnvelope(modification, CTX);
    expect(envelope.classification.family).toBe("async_processing");
    expect(envelope.classification.isTerminal).toBe(false);
    expect((envelope.state as { status: string }).status).toBe("received");
  });

  it("the paymentMethods listing is the OBSERVED eligibility envelope (never an assumption)", () => {
    const methods: AdyenPaymentMethodsResponseProviderObject = {
      paymentMethods: [
        { type: "scheme", name: "Card" },
        { type: "ideal", name: "iDEAL" },
        { type: "pix", name: "Pix" },
      ],
    };
    const envelope = adyenPaymentMethodsEnvelope(methods, CTX);
    expect(envelope.object.objectType).toBe("payment_methods_list");
    expect(envelope.classification.lifecycleStep).toBe("observed");
    expect((envelope.state as { paymentMethods: unknown[] }).paymentMethods).toHaveLength(3);
  });

  it("payout statuses map in the payout family (the observation-only family)", () => {
    const completed = adyenPayoutStatusEnvelope(
      { pspReference: "8836254765937180", status: "COMPLETED", amount: { value: 1000, currency: "EUR" } },
      CTX,
    );
    expect(completed.classification.family).toBe("payout");
    expect(completed.classification.isTerminal).toBe(true);
    const failed = adyenPayoutStatusEnvelope(
      { pspReference: "8836254765937181", status: "FAILED" },
      CTX,
    );
    expect(failed.classification.isTerminal).toBe(true);
    expect(failed.failure?.providerErrorCode).toBe("payout_failed");
    const unknown = adyenPayoutStatusEnvelope(
      { pspReference: "8836254765937182", status: "SOMETHING_NEW" },
      CTX,
    );
    expect(unknown.classification.isTerminal).toBe(false);
    expect(unknown.classification.lifecycleStep).toBe("SOMETHING_NEW");
  });

  it("a payout maps to a validated ExternalFundsPositionObservation (never custody)", () => {
    const observation = adyenPayoutObservation({
      payout: { pspReference: "8836254765937180", status: "COMPLETED", amount: { value: 1000, currency: "EUR" } },
      accountRef: "vault:PROVIDER_ADYEN_CREDENTIAL_REF",
      observedAt: T0,
    });
    expect("unconverted" in observation).toBe(false);
    expect(() => validateExternalFundsPositionObservation(observation as never)).not.toThrow();
    const malformed = adyenPayoutObservation({
      payout: { pspReference: "8836254765937183", status: "PENDING" },
      accountRef: "vault:PROVIDER_ADYEN_CREDENTIAL_REF",
      observedAt: T0,
    });
    expect(malformed).toMatchObject({ unconverted: true });
  });
});

// ---------------------------------------------------------------------------
// 3. Webhook verification (base64 HMAC-SHA256 over the RAW body)
// ---------------------------------------------------------------------------

describe("adyen connector — webhook verification (base64-HMAC scheme)", () => {
  // The signature is over the RAW delivery body as received:
  const signedBody = JSON.stringify({
    live: "false",
    notificationItems: [
      {
        NotificationRequestItem: {
          pspReference: "8836254765937172",
          eventCode: "AUTHORISATION",
          success: "true",
          eventDate: "2026-10-02T11:00:00Z",
          amount: { value: 1000, currency: "EUR" },
        },
      },
    ],
  });
  const validSignature = adyenSignWebhookPayload(SYNTHETIC_WEBHOOK_SECRET, signedBody);

  it("signs with base64(HMAC-SHA256(secret, raw body)) — the documented vector shape", () => {
    const again = adyenSignWebhookPayload(SYNTHETIC_WEBHOOK_SECRET, signedBody);
    expect(again).toBe(validSignature);
    expect(again).toMatch(/^[A-Za-z0-9+/]+={0,2}$/); // base64 alphabet
    expect(again).not.toBe(adyenSignWebhookPayload("other-secret", signedBody));
  });

  it("accepts a delivery whose hmacSignature equals the expected base64 HMAC (constant-time)", () => {
    expect(
      verifyAdyenWebhookDelivery(
        { hmacSignature: validSignature, rawPayload: signedBody },
        { secret: SYNTHETIC_WEBHOOK_SECRET },
      ),
    ).toEqual({ valid: true });
  });

  it("rejects a wrong signature and a missing signature (fail-closed)", () => {
    expect(
      verifyAdyenWebhookDelivery(
        { hmacSignature: "AAAA", rawPayload: signedBody },
        { secret: SYNTHETIC_WEBHOOK_SECRET },
      ),
    ).toMatchObject({ valid: false, reason: "HMAC_SIGNATURE_INVALID" });
    expect(
      verifyAdyenWebhookDelivery(
        { hmacSignature: undefined, rawPayload: signedBody },
        { secret: SYNTHETIC_WEBHOOK_SECRET },
      ),
    ).toMatchObject({ valid: false, reason: "MISSING_HMAC_SIGNATURE" });
  });

  it("a re-serialized payload changes the bytes and correctly fails (raw body required)", () => {
    const reordered = JSON.stringify({
      notificationItems: [
        { NotificationRequestItem: { eventCode: "AUTHORISATION", pspReference: "8836254765937172" } },
      ],
      live: "false",
    });
    expect(
      verifyAdyenWebhookDelivery(
        { hmacSignature: validSignature, rawPayload: reordered },
        { secret: SYNTHETIC_WEBHOOK_SECRET },
      ),
    ).toMatchObject({ valid: false, reason: "HMAC_SIGNATURE_INVALID" });
  });

  it("extracts the hmacSignature from the notification's additionalData (the documented location)", () => {
    const notificationBody = JSON.stringify({
      live: "false",
      notificationItems: [
        {
          NotificationRequestItem: {
            pspReference: "8836254765937172",
            eventCode: "AUTHORISATION",
            additionalData: { hmacSignature: "c3ludGhldGljLXNpZ25hdHVyZQ==" },
          },
        },
      ],
    });
    expect(adyenExtractHmacSignature(notificationBody)).toBe("c3ludGhldGljLXNpZ25hdHVyZQ==");
    expect(adyenExtractHmacSignature("not json")).toBeUndefined();
    expect(adyenExtractHmacSignature("{}")).toBeUndefined();
  });

  it("the AdyenWebhookVerifier implements the adapters hook over the canonical body", () => {
    const verifier = new AdyenWebhookVerifier(SYNTHETIC_WEBHOOK_SECRET);
    const event = adyenWebhookRawEvent({
      eventId: "AUTHORISATION:8836254765937172",
      payload: JSON.parse(signedBody),
      hmacSignature: adyenSignWebhookPayload(SYNTHETIC_WEBHOOK_SECRET, signedBody),
      timestampSeconds: "1790000000",
    });
    expect(verifier.verify(event, signedBody)).toEqual({ valid: true });
    expect(verifier.verify(event, JSON.stringify({ different: true }))).toMatchObject({
      valid: false,
      reason: "HMAC_SIGNATURE_INVALID",
    });
    expect(() => new AdyenWebhookVerifier("")).toThrow();
  });

  it("the ingestor wires the Adyen scheme: accept, bad-signature reject, replayed eventId dedupe", () => {
    const ingestor = createAdyenWebhookIngestor({
      secret: SYNTHETIC_WEBHOOK_SECRET,
      clock: CLOCK,
    });
    const rawEvent = adyenWebhookRawEvent({
      eventId: "AUTHORISATION:8836254765937172",
      payload: JSON.parse(signedBody),
      hmacSignature: adyenSignWebhookPayload(SYNTHETIC_WEBHOOK_SECRET, signedBody),
      timestampSeconds: "1765000000",
    });
    const first = ingestor.ingest(rawEvent);
    expect(first.kind).not.toBe("REJECTED");
    const replay = ingestor.ingest(rawEvent);
    expect(replay.kind).toBe("ALREADY_INGESTED");
    const badSignature = adyenWebhookRawEvent({
      eventId: "CAPTURE:8836254765937172",
      payload: JSON.parse(signedBody),
      hmacSignature: "AAAA",
      timestampSeconds: "1790000000",
    });
    expect(ingestor.ingest(badSignature).kind).toBe("REJECTED");
  });

  it("the webhook event id is derived deterministically from the notification item (dedupe key)", () => {
    expect(adyenWebhookEventId({ eventCode: "CAPTURE", pspReference: "883" })).toBe("CAPTURE:883");
    expect(adyenWebhookEventId({ eventCode: "REFUND" })).toBe("REFUND:no-psp");
    expect(adyenWebhookEventId({ pspReference: "883" })).toBeUndefined();
    expect(adyenWebhookEventId(null)).toBeUndefined();
    expect(adyenWebhookEventTimestamp({ eventDate: "2026-10-02T11:00:00Z" })).toBe("1790938800");
    expect(adyenWebhookEventTimestamp({ eventDate: "garbage" })).toBeUndefined();
  });

  it("webhook eventCodes map to families with the RAW code retained (disputes/payouts included)", () => {
    const item = (eventCode: string, success = "true"): AdyenNotificationItemProviderObject => ({
      pspReference: "8836254765937172",
      eventCode,
      success,
      eventDate: "2026-10-02T11:00:00Z",
    });
    for (const row of ADYEN_WEBHOOK_EVENT_CODE_MAPPING) {
      const envelope = adyenWebhookItemEnvelope(item(row.eventCode), CTX);
      expect(envelope.classification.family).toBe(row.family);
      expect(envelope.classification.lifecycleStep).toBe(row.lifecycleStep);
      expect((envelope.state as { eventCode: string }).eventCode).toBe(row.eventCode);
      expect(envelope.provenance.source).toBe("PROVIDER_WEBHOOK");
    }
    const chargeback = adyenWebhookItemEnvelope(item("NOTIFICATION_OF_CHARGEBACK"), CTX);
    expect(chargeback.classification.family).toBe("dispute");
    const refundFailed = adyenWebhookItemEnvelope(item("REFUND", "false"), CTX);
    expect(refundFailed.classification.isTerminal).toBe(false);
    expect(refundFailed.failure?.providerErrorCode).toBe("REFUND_FAILED");
    const unknown = adyenWebhookItemEnvelope(item("BRAND_NEW_EVENT"), CTX);
    expect(unknown.classification.family).toBe("other");
    expect(unknown.classification.isTerminal).toBe(false);
    expect((unknown.state as { eventCode: string }).eventCode).toBe("BRAND_NEW_EVENT");
  });
});

// ---------------------------------------------------------------------------
// 4. Fail-closed credential gating (INV-NC04)
// ---------------------------------------------------------------------------

describe("adyen connector — fail-closed credential gating", () => {
  it("no credential: availability UNKNOWN with provenance, never routable", () => {
    const transport = new ScriptedAdyenTransport(() => jsonResponse(401, { status: 401 }));
    const connector = new AdyenConnector({ clock: CLOCK, http: transport.transport });
    const observation = connector.availabilityObservation({
      instanceId: "inst-rails-adyen-1",
      observationVersion: 1,
    });
    expect(observation.availability).toBe("UNKNOWN");
    expect(observation.sourceAvailability).toBe("UNKNOWN");
    const implication = connector.railImplication(observation.availability);
    expect(implication.routable).toBe(false);
    expect(implication.reason).toContain("INV-NC04");
  });

  it("no credential: health is DEGRADED (endpoint answers, e.g. the recorded 401) or UNKNOWN (transport dead)", async () => {
    const answering = new ScriptedAdyenTransport(() => jsonResponse(401, { status: 401 }));
    const degraded = await new AdyenConnector({ clock: CLOCK, http: answering.transport }).health();
    expect(degraded.status).toBe("DEGRADED");
    expect(degraded.degradedReasons[0]).toContain("credentials absent");
    expect(degraded.degradedReasons[0]).toContain("INV-C01/C02");
    expect(degraded.degradedReasons[0]).toContain("401");

    const dead = new ScriptedAdyenTransport(() => {
      throw new Error("network down");
    });
    const unknown = await new AdyenConnector({ clock: CLOCK, http: dead.transport }).health();
    expect(unknown.status).toBe("UNKNOWN");
  });

  it("no credential: effectful operations throw RailNotAuthorizedError BEFORE any provider call", async () => {
    const transport = new ScriptedAdyenTransport(() => jsonResponse(200, {}));
    const connector = new AdyenConnector({ clock: CLOCK, http: transport.transport, merchantAccount: "TestPayswapECOM" });
    await expect(
      connector.create(
        ctx(AUTHORITY, {
          kind: "create_payment",
          amountMinor: "1000",
          currency: "EUR",
          paymentMethod: { type: "scheme" },
          returnUrl: "https://payswap.example/return",
        }),
      ),
    ).rejects.toThrow(RailNotAuthorizedError);
    await expect(
      connector.update(
        ctx(AUTHORITY, { kind: "submit_payment_details", details: { MD: "x", PaRes: "y" } }),
      ),
    ).rejects.toThrow(RailNotAuthorizedError);
    await expect(
      connector.executeAction(
        ctx(AUTHORITY, { kind: "capture_payment", pspReference: "883" }),
      ),
    ).rejects.toThrow(RailNotAuthorizedError);
    await expect(connector.observePaymentMethods({})).rejects.toThrow(RailNotAuthorizedError);
    expect(transport.calls).toHaveLength(0); // fail-closed BEFORE any provider call
  });

  it("credential surface declares the control-plane config key; resolution state is honest (never material)", () => {
    const connector = new AdyenConnector({ clock: CLOCK });
    expect(connector.credentialSurface()).toEqual([
      { envVar: "PROVIDER_ADYEN_CREDENTIAL_REF", kind: "API_KEY" },
    ]);
    expect(connector.credentialResolutionState()).toEqual({
      kind: "NOT_PROVISIONED",
      configKey: "PROVIDER_ADYEN_CREDENTIAL_REF",
      reason: expect.stringContaining("INV-NC04"),
    });
    const envState = envConnector(
      new ScriptedAdyenTransport(() => jsonResponse(200, {})),
    ).credentialResolutionState();
    expect(envState.kind).toBe("ENV_RESOLVED_MATERIAL");
    expect(JSON.stringify(envState)).not.toContain(SYNTHETIC_ENV_MATERIAL);
    const sealedState = controlPlaneConnector(
      new ScriptedAdyenTransport(() => jsonResponse(200, {})),
    ).connector.credentialResolutionState();
    expect(sealedState.kind).toBe("CONTROL_PLANE_SEALED");
    expect(JSON.stringify(sealedState)).not.toContain(SYNTHETIC_CONTROL_PLANE_MATERIAL);
  });

  it("control plane with an UNBOUND config key fails closed (no silent fallback)", async () => {
    const store = new FixtureVaultStore(); // nothing bound
    const broker = new CredentialBroker({ store });
    const runtimeKey = broker.registerConnectorRuntime("runtime.adyen.test");
    const transport = new ScriptedAdyenTransport(() => jsonResponse(200, {}));
    const connector = new AdyenConnector({
      clock: CLOCK,
      http: transport.transport,
      credentials: { broker, runtimeKey },
      merchantAccount: "TestPayswapECOM",
    });
    await expect(
      connector.read(ctx(AUTHORITY, { kind: "query_payment" })),
    ).rejects.toThrow();
    expect(transport.calls).toHaveLength(0);
  });

  it("the sealed bundle material shape is validated (string or {apiKey|…}; anything else refuses)", () => {
    expect(extractAdyenKeyMaterial("raw-key")).toBe("raw-key");
    expect(extractAdyenKeyMaterial({ apiKey: "bundled-key" })).toBe("bundled-key");
    expect(extractAdyenKeyMaterial({ api_key: "alt-key" })).toBe("alt-key");
    expect(() => extractAdyenKeyMaterial({ unrelated: true })).toThrow();
    expect(() => extractAdyenKeyMaterial("")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 5. Real request paths (scripted transport, no network)
// ---------------------------------------------------------------------------

describe("adyen connector — provider calls (scripted transport, no network)", () => {
  it("creates a payment through the SEALED control-plane path with X-API-Key + derived Idempotency-Key", async () => {
    const transport = new ScriptedAdyenTransport(() =>
      jsonResponse(200, { pspReference: "8836254765937172", resultCode: "Authorised" }),
    );
    const { connector } = controlPlaneConnector(transport);
    const result = await connector.create(
      ctx(AUTHORITY, {
        kind: "create_payment",
        amountMinor: "1000",
        currency: "eur",
        paymentMethod: { type: "scheme" },
        returnUrl: "https://payswap.example/return",
      }),
    );
    const call = transport.calls[0];
    expect(call?.url).toBe("https://checkout-test.adyen.com/v70/payments");
    expect(call?.method).toBe("POST");
    expect(call?.headers["X-API-Key"]).toBe(SYNTHETIC_CONTROL_PLANE_MATERIAL);
    expect(call?.headers["Idempotency-Key"]).toBe("payswap-idem:idem-sdk-1");
    const body = JSON.parse(call?.body ?? "{}") as Record<string, unknown>;
    expect(body).toMatchObject({
      merchantAccount: "TestPayswapECOM",
      amount: { value: 1000, currency: "EUR" },
      reference: "payswap:idem-sdk-1",
      paymentMethod: { type: "scheme" },
    });
    expect(result.providerState.classification.family).toBe("capture");
    expect(result.providerState.classification.lifecycleStep).toBe("authorised");
  });

  it("submits payment details through /v70/payments/details (3DS/redirect completion)", async () => {
    const transport = new ScriptedAdyenTransport(() =>
      jsonResponse(200, { pspReference: "8836254765937172", resultCode: "Authorised" }),
    );
    const { connector } = controlPlaneConnector(transport);
    await connector.update(
      ctx(AUTHORITY, { kind: "submit_payment_details", details: { MD: "x", PaRes: "y" }, paymentData: "Ab02b4c0" }),
    );
    expect(transport.calls[0]?.url).toBe("https://checkout-test.adyen.com/v70/payments/details");
  });

  it("modifications hit the documented suffixes (captures/refunds/cancels/reversals) and stay processing", async () => {
    const cases: readonly [string, string][] = [
      ["capture_payment", "captures"],
      ["refund_payment", "refunds"],
      ["cancel_payment", "cancels"],
      ["reverse_payment", "reversals"],
    ];
    for (const [kind, suffix] of cases) {
      const transport = new ScriptedAdyenTransport(() =>
        jsonResponse(200, { pspReference: "8836254765937173", status: "received" }),
      );
      const { connector } = controlPlaneConnector(transport);
      const result = await connector.executeAction(
        ctx(AUTHORITY, { kind, pspReference: "8836254765937172", amountMinor: "500", currency: "EUR" } as never),
      );
      expect(transport.calls[0]?.url).toBe(
        `https://checkout-test.adyen.com/v70/payments/8836254765937172/${suffix}`,
      );
      expect(result.providerState.classification.family).toBe("async_processing");
      expect(result.providerState.classification.isTerminal).toBe(false);
    }
  });

  it("observePaymentMethods posts the eligibility observation (OBSERVED merchant eligibility)", async () => {
    const transport = new ScriptedAdyenTransport(() =>
      jsonResponse(200, { paymentMethods: [{ type: "scheme" }, { type: "ideal" }] }),
    );
    const { connector } = controlPlaneConnector(transport);
    const envelope = await connector.observePaymentMethods({
      countryCode: "NL",
      amountMinor: "1000",
      currency: "EUR",
    });
    expect(transport.calls[0]?.url).toBe("https://checkout-test.adyen.com/v70/paymentMethods");
    const body = JSON.parse(transport.calls[0]?.body ?? "{}") as Record<string, unknown>;
    expect(body).toMatchObject({
      merchantAccount: "TestPayswapECOM",
      countryCode: "NL",
      amount: { value: 1000, currency: "EUR" },
    });
    expect(envelope.classification.lifecycleStep).toBe("observed");
  });

  it("a mid-effect transport failure is OUTCOME_UNKNOWN — never FAILED (INV-X01)", async () => {
    const transport = new ScriptedAdyenTransport(() => {
      throw new Error("connection reset mid-flight");
    });
    const { connector } = controlPlaneConnector(transport);
    const result = await connector.create(
      ctx(AUTHORITY, {
        kind: "create_payment",
        amountMinor: "1000",
        currency: "EUR",
        paymentMethod: { type: "scheme" },
        returnUrl: "https://payswap.example/return",
      }),
    );
    expect(result.providerState.classification.lifecycleStep).toBe("outcome_unknown");
    expect(result.providerState.failure?.ambiguity).toBe("OUTCOME_UNKNOWN");
    expect(result.providerState.classification.isTerminal).toBe(false);
  });

  it("a provider error preserves the provider message and status (never a business outcome)", async () => {
    const transport = new ScriptedAdyenTransport(() =>
      jsonResponse(403, { status: 403, errorCode: "901", message: "Invalid merchant account" }),
    );
    const { connector } = controlPlaneConnector(transport);
    await expect(
      connector.create(
        ctx(AUTHORITY, {
          kind: "create_payment",
          amountMinor: "1000",
          currency: "EUR",
          paymentMethod: { type: "scheme" },
          returnUrl: "https://payswap.example/return",
        }),
      ),
    ).rejects.toThrow(/Invalid merchant account/);
  });

  it("an amount that is not an exact integer minor-unit string is refused before any call (INV-F01)", async () => {
    const transport = new ScriptedAdyenTransport(() => jsonResponse(200, {}));
    const { connector } = controlPlaneConnector(transport);
    await expect(
      connector.create(
        ctx(AUTHORITY, {
          kind: "create_payment",
          amountMinor: "10.5",
          currency: "EUR",
          paymentMethod: { type: "scheme" },
          returnUrl: "https://payswap.example/return",
        }),
      ),
    ).rejects.toThrow(/INTEGER minor-unit/);
    expect(transport.calls).toHaveLength(0);
  });

  it("create without the merchantAccount configuration refuses before any provider call", async () => {
    const store = new FixtureVaultStore();
    store.bind(ADYEN_CREDENTIAL_CONFIG_KEY, VAULT_REF);
    store.seal(VAULT_REF, SYNTHETIC_CONTROL_PLANE_MATERIAL);
    const broker = new CredentialBroker({ store });
    const runtimeKey = broker.registerConnectorRuntime("runtime.adyen.test");
    const transport = new ScriptedAdyenTransport(() => jsonResponse(200, {}));
    const connector = new AdyenConnector({
      clock: CLOCK,
      http: transport.transport,
      credentials: { broker, runtimeKey },
    });
    await expect(
      connector.create(
        ctx(AUTHORITY, {
          kind: "create_payment",
          amountMinor: "1000",
          currency: "EUR",
          paymentMethod: { type: "scheme" },
          returnUrl: "https://payswap.example/return",
        }),
      ),
    ).rejects.toThrow(/merchantAccount/);
    expect(transport.calls).toHaveLength(0);
  });

  it("read/search honestly refuse: checkout v70 has no GET-payment-by-id; reconciliation is details + webhooks", async () => {
    const transport = new ScriptedAdyenTransport(() => jsonResponse(200, {}));
    const { connector } = controlPlaneConnector(transport);
    await expect(connector.read(ctx(AUTHORITY, { kind: "read_intent" }))).rejects.toThrow(
      /no GET-payment-by-pspReference/,
    );
    await expect(connector.search(ctx(AUTHORITY, {}))).rejects.toThrow(/not implemented/);
    expect(transport.calls).toHaveLength(0);
  });

  it("the env fallback path sends the same real request shape", async () => {
    const transport = new ScriptedAdyenTransport(() =>
      jsonResponse(200, { pspReference: "8836254765937172", resultCode: "Received" }),
    );
    const connector = envConnector(transport);
    const result = await connector.create(
      ctx(AUTHORITY, {
        kind: "create_payment",
        amountMinor: "1000",
        currency: "EUR",
        paymentMethod: { type: "scheme" },
        returnUrl: "https://payswap.example/return",
      }),
    );
    expect(transport.calls[0]?.headers["X-API-Key"]).toBe(SYNTHETIC_ENV_MATERIAL);
    expect(result.providerState.classification.family).toBe("async_processing");
  });

  it("health() with credentials runs the authenticated paymentMethods probe", async () => {
    const transport = new ScriptedAdyenTransport(() =>
      jsonResponse(200, { paymentMethods: [{ type: "scheme" }] }),
    );
    const { connector } = controlPlaneConnector(transport);
    const report = await connector.health();
    expect(report.status).toBe("HEALTHY");
    expect(transport.calls[0]?.url).toBe("https://checkout-test.adyen.com/v70/paymentMethods");
  });

  it("a transport failure inside health() is UNKNOWN, never a business outcome", async () => {
    const transport = new ScriptedAdyenTransport(() => {
      throw new RailTransportError("adyen provider transport unreachable");
    });
    const { connector } = controlPlaneConnector(transport);
    const report = await connector.health();
    expect(report.status).toBe("UNKNOWN");
  });
});

/**
 * @payswap/journeys — the Paystack conformance profile (P2-W2-003).
 *
 * Contract-level scenarios over Paystack's own mapping code plus SDK-level
 * probes (fail-closed authorization, mid-initialize outage, duplicate
 * reference) through the REAL PaystackConnector over scripted transports
 * with obviously-fake synthetic key material. NO live Paystack API is
 * contacted.
 */

import {
  PAYSTACK_API_VERSION,
  PAYSTACK_CREDENTIAL_CONFIG_KEY,
  PAYSTACK_PAYMENT_INIT_CAPABILITY_ID,
  PAYSTACK_PROVIDER_NAME,
  PAYSTACK_RECURRING_CHARGE_CAPABILITY_ID,
  PAYSTACK_REFUND_CAPABILITY_ID,
  PAYSTACK_BANK_ENUMERATION_CAPABILITY_ID,
  PaystackConnector,
  PaystackDuplicateReferenceError,
  createPaystackWebhookIngestor,
  paystackCapabilityDefinitions,
  paystackPaymentReference,
  paystackRefundEnvelope,
  paystackSignWebhookPayload,
  paystackTransactionEnvelope,
  paystackWebhookEventEnvelope,
  paystackWebhookEventTimestamp,
  paystackWebhookRawEvent,
} from "@payswap/rails";
import type {
  PaystackRefundProviderObject,
  PaystackTransactionProviderObject,
} from "@payswap/rails";
import { canonicalWebhookBody } from "@payswap/adapters";
import type { ProviderStateEnvelope } from "@payswap/connectors";
import { CONFORMANCE_EPOCH, CONFORMANCE_OBSERVED_AT, applicable, notSupportedByProvider } from "./model.js";
import type { ApplicabilityBasis, ConformanceScenarioId } from "./model.js";
import type { EnvelopeMapper, ProviderConformanceProfile } from "./profile.js";
import { CONFORMANCE_CLOCK, errorClassName, sdkCtx, sdkOutcomeOf, sdkProviderStateOf } from "./profile-support.js";
import { ScriptedConformanceTransport, deadTransport } from "./model.js";

const SYNTHETIC_ENV_MATERIAL = "sk_test_CONFORMANCE_SYNTHETIC_PAYSTACK_0001_NOT_REAL";
const SYNTHETIC_WEBHOOK_SECRET = "CONFORMANCE_SYNTHETIC_PAYSTACK_SECRET_0002";

const CONTEXT = {
  observedAt: CONFORMANCE_OBSERVED_AT,
  provenanceSource: "PROVIDER_API" as const,
};

function transaction(
  status: string,
  overrides: Readonly<Record<string, unknown>> = {},
): PaystackTransactionProviderObject {
  return {
    id: 3012345678,
    status,
    reference: "payswap:conformance-1",
    amount: 10000,
    currency: "GHS",
    channel: "mobile_money",
    gateway_response: "Successful",
    ...overrides,
  };
}

const paymentMapper: EnvelopeMapper<PaystackTransactionProviderObject> = {
  build: (object) =>
    paystackTransactionEnvelope(object, { ...CONTEXT, fetchId: "fetch-conformance-1" }),
  fixture: (status, overrides) => transaction(status, overrides),
};

function declaredDuplicateBehavior(): string {
  const definitions = paystackCapabilityDefinitions();
  const paymentInit = definitions.find(
    (definition) => definition.capabilityId === PAYSTACK_PAYMENT_INIT_CAPABILITY_ID,
  );
  return paymentInit?.idempotency.duplicateBehavior ?? "unknown";
}

export const paystackConformanceProfile: ProviderConformanceProfile = {
  providerName: PAYSTACK_PROVIDER_NAME,
  providerVersion: PAYSTACK_API_VERSION,
  honestyNote:
    "live-verified connector (P2-W3-001: initialize/verify lifecycle + GHS/KES bank enumerations on record)",
  applicability: buildApplicability(),
  payment: paymentMapper,
  customerAction: {
    status: "pending",
    family: "customer_action_required",
  },
  asyncStatus: "processing",
  failedStatus: "failed",
  unknownStatus: "weird_new_status",
  succeededStatus: "success",
  refund: {
    pending: { status: "pending", family: "refund" },
    completed: { status: "processed", family: "refund" },
    mapper: {
      build: (object) => paystackRefundEnvelope(object as PaystackRefundProviderObject, CONTEXT),
      fixture: (status) =>
        ({
          refund_reference: "ref_CONFORMANCE_SYNTHETIC_1",
          transaction_reference: "payswap:conformance-1",
          status,
          amount: 5000,
          currency: "GHS",
        }) as PaystackRefundProviderObject,
    },
    amountField: "amount",
    partialAmount: 5000,
  },
  duplicate: {
    derive: paystackPaymentReference,
    duplicateClass: PaystackDuplicateReferenceError,
    declaredDuplicateBehavior: declaredDuplicateBehavior(),
    sdkProbe: async () => {
      // The SAME protocol idempotency key twice: the first initialize
      // succeeds; the second is Paystack's duplicate-reference answer →
      // PaystackDuplicateReferenceError — NEVER a silent second success.
      const transport = new ScriptedConformanceTransport((call) => {
        if (call.body !== undefined && call.body.includes("reference=payswap%3Aidem-dup-1")) {
          return {
            status: 200,
            bodyText: JSON.stringify({
              status: true,
              message: "Authorization URL created",
              data: {
                authorization_url: "https://checkout.paystack.com/conformance",
                access_code: "ACC_CONFORMANCE_1",
                reference: "payswap:idem-dup-1",
              },
            }),
          };
        }
        return {
          status: 200,
          bodyText: JSON.stringify({
            status: false,
            message: "Duplicate Reference: this reference already holds a transaction",
          }),
        };
      });
      const connector = new PaystackConnector({
        clock: CONFORMANCE_CLOCK,
        http: transport.transport,
        env: { [PAYSTACK_CREDENTIAL_CONFIG_KEY]: SYNTHETIC_ENV_MATERIAL },
      });
      await connector.create(
        sdkCtx(
          { kind: "initialize_payment", amountMinor: "10000", currency: "GHS", email: "payer@synthetic.example" },
          "idem-dup-1",
        ),
      );
      try {
        await connector.create(
          sdkCtx(
            { kind: "initialize_payment", amountMinor: "999", currency: "GHS", email: "payer@synthetic.example" },
            "idem-dup-1",
          ),
        );
      } catch (error) {
        if (error instanceof PaystackDuplicateReferenceError) {
          return { errorClass: "PaystackDuplicateReferenceError" };
        }
        throw new Error(
          `expected PaystackDuplicateReferenceError on the duplicate reference, got ${errorClassName(error)}`,
        );
      }
      throw new Error("the duplicate submission SUCCEEDED silently (INV-F05 violation)");
    },
  },
  webhook: {
    syntheticSecret: SYNTHETIC_WEBHOOK_SECRET,
    makeIngestor: (secret) =>
      createPaystackWebhookIngestor({ secret, clock: CONFORMANCE_CLOCK }),
    sign: (secret, payload) => {
      const canonicalBody = canonicalWebhookBody(payload);
      const signature = paystackSignWebhookPayload(secret, canonicalBody);
      const timestamp =
        paystackWebhookEventTimestamp(payload) ?? String(Number(CONFORMANCE_EPOCH / 1000n));
      return { signature, timestamp };
    },
    rawEvent: (payload, signature, timestamp) =>
      paystackWebhookRawEvent({
        eventId: "evt_CONFORMANCE_SYNTHETIC_1",
        payload,
        signatureHeader: signature,
        timestampSeconds: timestamp,
      }),
    mapEvent: (payload) =>
      paystackWebhookEventEnvelope(payload as Record<string, unknown>, {
        observedAt: CONFORMANCE_OBSERVED_AT,
        provenanceSource: "PROVIDER_WEBHOOK",
      }),
    samplePayload: () => ({
      event: "charge.success",
      data: {
        id: 3012345678,
        status: "success",
        reference: "payswap:conformance-1",
        amount: 10000,
        currency: "GHS",
        channel: "mobile_money",
        gateway_response: "Successful",
        created_at: CONFORMANCE_OBSERVED_AT,
      },
    }),
    expectedExternalId: "payswap:conformance-1",
    expectedFamily: "other",
  },
  outageProbe: async () => {
    const connector = new PaystackConnector({
      clock: CONFORMANCE_CLOCK,
      http: deadTransport().transport,
      env: { [PAYSTACK_CREDENTIAL_CONFIG_KEY]: SYNTHETIC_ENV_MATERIAL },
    });
    const result = (await connector.create(
      sdkCtx(
        { kind: "initialize_payment", amountMinor: "10000", currency: "GHS", email: "payer@synthetic.example" },
        "idem-outage-1",
      ),
    )) as unknown;
    const outcome = sdkOutcomeOf(result);
    const providerState = sdkProviderStateOf(result) as ProviderStateEnvelope | undefined;
    return {
      kind: "OUTCOME_UNKNOWN_ENVELOPE" as const,
      outcome: outcome.outcome,
      requiresReconciliation: outcome.requiresReconciliation,
      ...(providerState !== undefined ? { envelope: providerState } : {}),
    };
  },
  sdkAuth: {
    makeBareConnector: (http) => new PaystackConnector({ clock: CONFORMANCE_CLOCK, http }),
    effectfulCalls: [
      {
        name: "initialize_payment",
        invoke: (connector) =>
          connector.create(
            sdkCtx({
              kind: "initialize_payment",
              amountMinor: "10000",
              currency: "GHS",
              email: "payer@synthetic.example",
            }),
          ),
      },
    ],
  },
  secretMaterialMarkers: [SYNTHETIC_ENV_MATERIAL, SYNTHETIC_WEBHOOK_SECRET],
};

function buildApplicability(): Readonly<Record<ConformanceScenarioId, ApplicabilityBasis>> {
  return {
    CUSTOMER_ACTION_REQUIRED: applicable(
      `${PAYSTACK_PAYMENT_INIT_CAPABILITY_ID} (pending transaction / hosted authorization URL)`,
    ),
    ASYNC_PROCESSING: applicable(
      `${PAYSTACK_PAYMENT_INIT_CAPABILITY_ID} (processing/ongoing states)`,
    ),
    CAPTURE: notSupportedByProvider(
      `Paystack has no manual-capture flow: the ${PAYSTACK_PAYMENT_INIT_CAPABILITY_ID} statuses (pending/processing/success/paid/failed/abandoned/reversed) contain no capture family — the provider settles directly on charge`,
    ),
    RECURRING_MANDATE: notSupportedByProvider(
      `Paystack recurring runs on saved-authorization charges (${PAYSTACK_RECURRING_CHARGE_CAPABILITY_ID}) with no provider mandate object; the connector mapping declares no mandate-family state`,
    ),
    REFUND: applicable(`${PAYSTACK_REFUND_CAPABILITY_ID} (refund lifecycle pending → processed)`),
    DISPUTE: notSupportedByProvider(
      `no dispute/chargeback surface in the Paystack connector vocabulary (${PAYSTACK_BANK_ENUMERATION_CAPABILITY_ID} and collection/refund capabilities only)`,
    ),
    PAYOUT: notSupportedByProvider(
      "Paystack connector is collection-focused: no payout family exists in its mapping; provider-held balances are not exposed by the connected surface",
    ),
    DUPLICATE_SUBMISSION: applicable(
      `${PAYSTACK_PAYMENT_INIT_CAPABILITY_ID} reference idempotency (the payment reference IS the key; duplicate reference class)`,
    ),
    WEBHOOK_LOSS: applicable(
      "X-Paystack-Signature webhook ingestor + verify-by-reference re-fetch (INV-X03)",
    ),
    PROVIDER_OUTAGE: applicable(
      "mid-initialize transport failure → OUTCOME_UNKNOWN (INV-X01; incident vocabulary)",
    ),
    UNKNOWN: applicable(
      `${PAYSTACK_PAYMENT_INIT_CAPABILITY_ID} (unmapped status → other/verbatim, non-terminal)`,
    ),
    PROVIDER_REVISION_CHANGE: applicable(
      "transaction revisions (provider-status-etag) through the append-only ProviderRevisionLedger (INV-C06)",
    ),
    FALLBACK_RE_AUTHORIZATION: applicable(
      "execution-plane selection ladder + coverage-gap direct-local path (capabilities vocabulary)",
    ),
  };
}

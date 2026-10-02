/**
 * @payswap/journeys — the Stripe conformance profile (P2-W2-003).
 *
 * The richest profile: every scenario runs at the CONTRACT level against
 * Stripe's own mapping code, and the SDK-level probes (fail-closed
 * authorization, mid-effect outage, duplicate submission) drive the REAL
 * StripeConnector over scripted transports with obviously-fake synthetic
 * key material. NO live Stripe API is contacted.
 */

import {
  STRIPE_API_VERSION,
  STRIPE_CREDENTIAL_CONFIG_KEY,
  STRIPE_PROVIDER_NAME,
  STRIPE_PAYMENT_INTENT_CAPABILITY_ID,
  STRIPE_REFUND_CAPABILITY_ID,
  STRIPE_DISPUTE_CAPABILITY_ID,
  STRIPE_PAYOUT_OBSERVATION_CAPABILITY_ID,
  STRIPE_SUBSCRIPTION_CAPABILITY_ID,
  StripeConnector,
  StripeIdempotencyConflictError,
  createStripeWebhookIngestor,
  stripeCapabilityDefinitions,
  stripeDisputeEnvelope,
  stripeIdempotencyKey,
  stripePaymentIntentEnvelope,
  stripePayoutEnvelope,
  stripePayoutObservations,
  stripeRefundEnvelope,
  stripeSignWebhookPayload,
  stripeSubscriptionEnvelope,
  stripeWebhookEventEnvelope,
  stripeWebhookRawEvent,
} from "@payswap/rails";
import type {
  StripeDisputeProviderObject,
  StripePaymentIntentProviderObject,
  StripePayoutProviderObject,
  StripeRefundProviderObject,
  StripeSubscriptionProviderObject,
} from "@payswap/rails";
import { canonicalWebhookBody } from "@payswap/adapters";
import type { ProviderStateEnvelope } from "@payswap/connectors";
import {
  CONFORMANCE_OBSERVED_AT,
  applicable,
} from "./model.js";
import type { ApplicabilityBasis, ConformanceScenarioId } from "./model.js";
import type { EnvelopeMapper, ProviderConformanceProfile } from "./profile.js";
import {
  CONFORMANCE_CLOCK,
  errorClassName,
  sdkCtx,
  sdkOutcomeOf,
  sdkProviderStateOf,
} from "./profile-support.js";
import { ScriptedConformanceTransport, deadTransport } from "./model.js";

const SYNTHETIC_ENV_MATERIAL = "sk_test_CONFORMANCE_SYNTHETIC_STRIPE_0001_NOT_REAL";
const SYNTHETIC_WEBHOOK_SECRET = "whsec_CONFORMANCE_SYNTHETIC_STRIPE_0002_NOT_REAL";

const CONTEXT = {
  observedAt: CONFORMANCE_OBSERVED_AT,
  provenanceSource: "PROVIDER_API" as const,
};

function intent(
  status: string,
  overrides: Readonly<Record<string, unknown>> = {},
): StripePaymentIntentProviderObject {
  return {
    id: "pi_CONFORMANCE_SYNTHETIC_1",
    status,
    amount: 100,
    currency: "eur",
    latest_charge: "ch_CONFORMANCE_SYNTHETIC_1",
    ...overrides,
  } as StripePaymentIntentProviderObject;
}

const paymentMapper: EnvelopeMapper = {
  build: (object) =>
    stripePaymentIntentEnvelope(object as StripePaymentIntentProviderObject, { ...CONTEXT, fetchId: "fetch-conformance-1" }),
  fixture: (status, overrides) => intent(status, overrides),
};

function declaredDuplicateBehavior(): string {
  const definitions = stripeCapabilityDefinitions();
  const paymentIntent = definitions.find(
    (definition) => definition.capabilityId === STRIPE_PAYMENT_INTENT_CAPABILITY_ID,
  );
  return paymentIntent?.idempotency.duplicateBehavior ?? "unknown";
}

export const stripeConformanceProfile: ProviderConformanceProfile = {
  providerName: STRIPE_PROVIDER_NAME,
  providerVersion: STRIPE_API_VERSION,
  honestyNote:
    "live-verified connector (P2-W2-001: real create+cancel PaymentIntent round-trip on record)",
  applicability: buildApplicability(),
  payment: paymentMapper,
  customerAction: {
    fixture: { status: "requires_action", family: "customer_action_required" },
  },
  asyncStatus: "processing",
  failedStatus: "canceled",
  unknownStatus: "brand_new_unmapped_status",
  succeededStatus: "succeeded",
  capture: {
    authorized: { status: "requires_capture", family: "capture" },
    captured: { status: "succeeded", family: "other" },
  },
  mandate: {
    fixture: { status: "active", family: "mandate" },
    mapper: {
      build: (object) =>
        stripeSubscriptionEnvelope(object as StripeSubscriptionProviderObject, CONTEXT),
      fixture: (status) =>
        ({
          id: "sub_CONFORMANCE_SYNTHETIC_1",
          status,
          customer: "cus_CONFORMANCE_SYNTHETIC_1",
          latest_invoice: "in_CONFORMANCE_SYNTHETIC_1",
        }) as StripeSubscriptionProviderObject,
    },
  },
  refund: {
    pending: { status: "pending", family: "refund" },
    completed: { status: "succeeded", family: "refund" },
    mapper: {
      build: (object) => stripeRefundEnvelope(object as StripeRefundProviderObject, CONTEXT),
      fixture: (status) =>
        ({
          id: "re_CONFORMANCE_SYNTHETIC_1",
          status,
          payment_intent: "pi_CONFORMANCE_SYNTHETIC_1",
          charge: "ch_CONFORMANCE_SYNTHETIC_1",
          amount: 50,
          currency: "eur",
        }) as StripeRefundProviderObject,
    },
    amountField: "amount",
    partialAmount: 50,
  },
  dispute: {
    fixture: { status: "needs_response", family: "dispute" },
    mapper: {
      build: (object) => stripeDisputeEnvelope(object as StripeDisputeProviderObject, CONTEXT),
      fixture: (status) =>
        ({
          id: "du_CONFORMANCE_SYNTHETIC_1",
          status,
          payment_intent: "pi_CONFORMANCE_SYNTHETIC_1",
          charge: "ch_CONFORMANCE_SYNTHETIC_1",
          amount: 100,
          currency: "eur",
        }) as StripeDisputeProviderObject,
    },
  },
  payout: {
    pending: { status: "pending", family: "payout" },
    completed: { status: "paid", family: "payout" },
    mapper: {
      build: (object) => stripePayoutEnvelope(object as StripePayoutProviderObject, CONTEXT),
      fixture: (status) =>
        ({
          id: "po_CONFORMANCE_SYNTHETIC_1",
          status,
          amount: 1234,
          currency: "usd",
          destination: "ba_CONFORMANCE_SYNTHETIC_1",
          arrival_date: 1_764_998_400,
        }) as StripePayoutProviderObject,
    },
    fundsObservations: () =>
      stripePayoutObservations({
        payouts: [
          {
            id: "po_CONFORMANCE_SYNTHETIC_1",
            status: "paid",
            amount: 1234,
            currency: "usd",
            destination: "ba_CONFORMANCE_SYNTHETIC_1",
            arrival_date: 1_764_998_400,
          },
        ],
        accountRef: "acct_conformance_stripe",
        observedAt: CONFORMANCE_OBSERVED_AT,
      }),
  },
  duplicate: {
    derive: stripeIdempotencyKey,
    duplicateClass: StripeIdempotencyConflictError,
    declaredDuplicateBehavior: declaredDuplicateBehavior(),
    sdkProbe: async () => {
      // The SAME protocol idempotency key twice: the first submission
      // succeeds; the second (different body, same key) is Stripe's 409
      // idempotency_error → StripeIdempotencyConflictError — NEVER a silent
      // second success.
      const transport = new ScriptedConformanceTransport((call) => {
        if (call.body === "amount=100&currency=eur") {
          return {
            status: 200,
            bodyText: JSON.stringify(intent("requires_confirmation")),
          };
        }
        return {
          status: 409,
          bodyText: JSON.stringify({
            error: {
              type: "idempotency_error",
              message:
                "Keys for idempotent requests can only be used with the same parameters they were first used with.",
            },
          }),
        };
      });
      const connector = new StripeConnector({
        clock: CONFORMANCE_CLOCK,
        http: transport.transport,
        env: { [STRIPE_CREDENTIAL_CONFIG_KEY]: SYNTHETIC_ENV_MATERIAL },
      });
      await connector.create(
        sdkCtx({ kind: "create_intent", amountMinor: "100", currency: "eur" }, "idem-conflict-1"),
      );
      try {
        await connector.create(
          sdkCtx(
            { kind: "create_intent", amountMinor: "999", currency: "eur" },
            "idem-conflict-1",
          ),
        );
      } catch (error) {
        if (error instanceof StripeIdempotencyConflictError) {
          return { errorClass: "StripeIdempotencyConflictError" };
        }
        throw new Error(
          `expected StripeIdempotencyConflictError on the duplicate key, got ${errorClassName(error)}`,
        );
      }
      throw new Error("the duplicate submission SUCCEEDED silently (INV-F05 violation)");
    },
  },
  webhook: {
    syntheticSecret: SYNTHETIC_WEBHOOK_SECRET,
    makeIngestor: (secret) =>
      createStripeWebhookIngestor({ secret, clock: CONFORMANCE_CLOCK }),
    sign: (secret, payload) => {
      const timestamp = "1766000000";
      const canonicalBody = canonicalWebhookBody(payload);
      const signature = stripeSignWebhookPayload(secret, timestamp, canonicalBody);
      return { signature, timestamp };
    },
    rawEvent: (payload, signature, timestamp) => {
      const raw = stripeWebhookRawEvent({
        eventId: "evt_CONFORMANCE_SYNTHETIC_1",
        payload,
        signatureHeader: `t=${timestamp},v1=${signature}`,
      });
      if (raw === undefined) {
        throw new Error("stripe webhook raw event construction failed");
      }
      return raw;
    },
    mapEvent: (payload) =>
      stripeWebhookEventEnvelope(payload as Record<string, unknown>, {
        observedAt: CONFORMANCE_OBSERVED_AT,
        provenanceSource: "PROVIDER_WEBHOOK",
      }),
    samplePayload: () => ({
      id: "evt_CONFORMANCE_SYNTHETIC_1",
      type: "payment_intent.succeeded",
      data: { object: intent("succeeded", { amount_received: 100 }) },
    }),
    expectedExternalId: "pi_CONFORMANCE_SYNTHETIC_1",
    expectedFamily: "other",
  },
  outageProbe: async () => {
    const connector = new StripeConnector({
      clock: CONFORMANCE_CLOCK,
      http: deadTransport().transport,
      env: { [STRIPE_CREDENTIAL_CONFIG_KEY]: SYNTHETIC_ENV_MATERIAL },
    });
    const result = (await connector.update(
      sdkCtx({ kind: "confirm_intent", intentId: "pi_CONFORMANCE_SYNTHETIC_1" }, "idem-outage-1"),
    )) as unknown;
    const outcome = sdkOutcomeOf(result);
    const providerState = sdkProviderStateOf(result) as ProviderStateEnvelope | undefined;
    return {
      kind: "OUTCOME_UNKNOWN_ENVELOPE" as const,
      ...(outcome.outcome !== undefined ? { outcome: outcome.outcome } : {}),
      ...(outcome.requiresReconciliation !== undefined
        ? { requiresReconciliation: outcome.requiresReconciliation }
        : {}),
      ...(providerState !== undefined ? { envelope: providerState } : {}),
    };
  },
  sdkAuth: {
    makeBareConnector: (http) =>
      new StripeConnector({ clock: CONFORMANCE_CLOCK, http }),
    effectfulCalls: [
      {
        name: "create_intent",
        invoke: (connector) =>
          connector.create(
            sdkCtx({ kind: "create_intent", amountMinor: "100", currency: "eur" }),
          ),
      },
    ],
  },
  secretMaterialMarkers: [SYNTHETIC_ENV_MATERIAL, SYNTHETIC_WEBHOOK_SECRET],
};

function buildApplicability(): Readonly<Record<ConformanceScenarioId, ApplicabilityBasis>> {
  return {
    CUSTOMER_ACTION_REQUIRED: applicable(
      `${STRIPE_PAYMENT_INTENT_CAPABILITY_ID} (requires_action/requires_confirmation states)`,
    ),
    ASYNC_PROCESSING: applicable(
      `${STRIPE_PAYMENT_INTENT_CAPABILITY_ID} (processing state)`,
    ),
    CAPTURE: applicable(
      `${STRIPE_PAYMENT_INTENT_CAPABILITY_ID} (requires_capture → succeeded; manual-capture flow)`,
    ),
    RECURRING_MANDATE: applicable(
      `${STRIPE_SUBSCRIPTION_CAPABILITY_ID} (subscription objects → mandate family)`,
    ),
    REFUND: applicable(`${STRIPE_REFUND_CAPABILITY_ID} (Refund lifecycle pending → succeeded)`),
    DISPUTE: applicable(
      `${STRIPE_DISPUTE_CAPABILITY_ID} (Dispute lifecycle needs_response etc.)`,
    ),
    PAYOUT: applicable(
      `${STRIPE_PAYOUT_OBSERVATION_CAPABILITY_ID} (Payout objects observed, INV-C09)`,
    ),
    DUPLICATE_SUBMISSION: applicable(
      `${STRIPE_PAYMENT_INTENT_CAPABILITY_ID} idempotency (Idempotency-Key derived from the protocol key; 409 idempotency_error class)`,
    ),
    WEBHOOK_LOSS: applicable(
      "Stripe-Signature webhook ingestor + PaymentIntent re-fetch by id (INV-X03)",
    ),
    PROVIDER_OUTAGE: applicable(
      "mid-effect transport failure → OUTCOME_UNKNOWN (INV-X01; incident vocabulary)",
    ),
    UNKNOWN: applicable(
      `${STRIPE_PAYMENT_INTENT_CAPABILITY_ID} (unmapped status → other/verbatim, non-terminal)`,
    ),
    PROVIDER_REVISION_CHANGE: applicable(
      "PaymentIntent revisions (provider-etag) through the append-only ProviderRevisionLedger (INV-C06)",
    ),
    FALLBACK_RE_AUTHORIZATION: applicable(
      "execution-plane selection ladder + coverage-gap direct-local path (capabilities vocabulary)",
    ),
  };
}

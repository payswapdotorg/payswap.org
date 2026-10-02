/**
 * @payswap/journeys — the Flutterwave conformance profile (P2-W2-003).
 *
 * Contract-level scenarios over Flutterwave's own mapping code plus SDK-level
 * probes (fail-closed authorization, mid-create outage) through the REAL
 * FlutterwaveConnector over scripted transports with obviously-fake synthetic
 * key material. NO live Flutterwave API is contacted. The verif-hash webhook
 * scheme (a secret compare over NO payload) is exercised through the
 * provider's own verifier + ingestor.
 */

import {
  FLUTTERWAVE_API_VERSION,
  FLUTTERWAVE_CREDENTIAL_CONFIG_KEY,
  FLUTTERWAVE_HOSTED_CHECKOUT_CAPABILITY_ID,
  FLUTTERWAVE_PROVIDER_NAME,
  FLUTTERWAVE_REFUND_CAPABILITY_ID,
  FLUTTERWAVE_WALLET_OBSERVATION_CAPABILITY_ID,
  FlutterwaveConnector,
  createFlutterwaveWebhookIngestor,
  flutterwaveCapabilityDefinitions,
  flutterwaveHostedCheckoutEnvelope,
  flutterwaveRefundEnvelope,
  flutterwaveTransactionEnvelope,
  flutterwaveTxRef,
  flutterwaveWebhookEventEnvelope,
  flutterwaveWebhookEventTimestamp,
  flutterwaveWebhookRawEvent,
} from "@payswap/rails";
import type {
  FlutterwaveHostedCheckoutProviderObject,
  FlutterwaveRefundProviderObject,
  FlutterwaveTransactionProviderObject,
} from "@payswap/rails";
import type { ProviderStateEnvelope } from "@payswap/connectors";
import { CONFORMANCE_EPOCH, CONFORMANCE_OBSERVED_AT, applicable, notSupportedByProvider } from "./model.js";
import type { ApplicabilityBasis, ConformanceScenarioId } from "./model.js";
import type { EnvelopeMapper, ProviderConformanceProfile } from "./profile.js";
import { CONFORMANCE_CLOCK, sdkCtx, sdkOutcomeOf, sdkProviderStateOf } from "./profile-support.js";
import { deadTransport } from "./model.js";

const SYNTHETIC_ENV_MATERIAL = "FLWSECK-TEST-CONFORMANCE-SYNTHETIC-FLW-0001-NOT-REAL";
const SYNTHETIC_VERIF_HASH = "CONFORMANCE_SYNTHETIC_FLW_VERIF_HASH_0002_NOT_REAL";

const CONTEXT = {
  observedAt: CONFORMANCE_OBSERVED_AT,
  provenanceSource: "PROVIDER_API" as const,
};

const TX_REF = "payswp-conf-1";

function transaction(
  status: string,
  overrides: Readonly<Record<string, unknown>> = {},
): FlutterwaveTransactionProviderObject {
  return {
    id: 4567890123,
    tx_ref: TX_REF,
    status,
    amount: 100,
    currency: "NGN",
    payment_type: "card",
    ...overrides,
  };
}

const paymentMapper: EnvelopeMapper<FlutterwaveTransactionProviderObject> = {
  build: (object) =>
    flutterwaveTransactionEnvelope(object, { ...CONTEXT, fetchId: "fetch-conformance-1" }),
  fixture: (status, overrides) => transaction(status, overrides),
};

const hostedCheckoutMapper: EnvelopeMapper<FlutterwaveHostedCheckoutProviderObject> = {
  build: (object) =>
    flutterwaveHostedCheckoutEnvelope(object, TX_REF, {
      ...CONTEXT,
      fetchId: "fetch-conformance-1",
    }),
  fixture: () => ({
    link: "https://checkout.flutterwave.com/conformance/synthetic",
  }),
};

function declaredDuplicateBehavior(): string {
  const definitions = flutterwaveCapabilityDefinitions();
  const hostedCheckout = definitions.find(
    (definition) => definition.capabilityId === FLUTTERWAVE_HOSTED_CHECKOUT_CAPABILITY_ID,
  );
  return hostedCheckout?.idempotency.duplicateBehavior ?? "unknown";
}

export const flutterwaveConformanceProfile: ProviderConformanceProfile = {
  providerName: FLUTTERWAVE_PROVIDER_NAME,
  providerVersion: FLUTTERWAVE_API_VERSION,
  honestyNote:
    "live-verified connector (P2-W3-001: hosted checkout + the 31-wallet observation incl. USDC on record)",
  applicability: buildApplicability(),
  payment: paymentMapper,
  customerAction: {
    fixture: {
      status: "link_generated",
      family: "customer_action_required",
    },
    mapper: hostedCheckoutMapper,
  },
  asyncStatus: "pending",
  failedStatus: "failed",
  unknownStatus: "brand_new_status",
  succeededStatus: "successful",
  refund: {
    pending: { status: "pending", family: "refund" },
    completed: { status: "completed", family: "refund" },
    mapper: {
      build: (object) =>
        flutterwaveRefundEnvelope(object as FlutterwaveRefundProviderObject, CONTEXT),
      fixture: (status) =>
        ({
          refund_id: 987654,
          transaction_id: 4567890123,
          tx_ref: TX_REF,
          status,
          amount: 40,
          currency: "NGN",
        }) as FlutterwaveRefundProviderObject,
    },
    amountField: "amount",
    partialAmount: 40,
  },
  duplicate: {
    derive: flutterwaveTxRef,
    declaredDuplicateBehavior: declaredDuplicateBehavior(),
  },
  webhook: {
    syntheticSecret: SYNTHETIC_VERIF_HASH,
    makeIngestor: (secret) =>
      createFlutterwaveWebhookIngestor({ secret, clock: CONFORMANCE_CLOCK }),
    // The verif-hash scheme signs NO payload: the signature IS the secret
    // compare (constant-time inside the provider's verifier).
    sign: (_secret, payload) => {
      const timestamp =
        flutterwaveWebhookEventTimestamp(payload) ?? String(Number(CONFORMANCE_EPOCH / 1000n));
      return { signature: SYNTHETIC_VERIF_HASH, timestamp };
    },
    rawEvent: (payload, signature, timestamp) =>
      flutterwaveWebhookRawEvent({
        eventId: "evt_CONFORMANCE_SYNTHETIC_1",
        payload,
        verifHashHeader: signature,
        timestampSeconds: timestamp,
      }),
    mapEvent: (payload) =>
      flutterwaveWebhookEventEnvelope(payload as Record<string, unknown>, {
        observedAt: CONFORMANCE_OBSERVED_AT,
        provenanceSource: "PROVIDER_WEBHOOK",
      }),
    samplePayload: () => ({
      event: "transaction.completed",
      data: {
        id: 4567890123,
        tx_ref: TX_REF,
        status: "successful",
        amount: 100,
        currency: "NGN",
        payment_type: "card",
        created_at: CONFORMANCE_OBSERVED_AT,
      },
    }),
    expectedExternalId: "4567890123",
    expectedFamily: "other",
  },
  outageProbe: async () => {
    const connector = new FlutterwaveConnector({
      clock: CONFORMANCE_CLOCK,
      http: deadTransport().transport,
      env: { [FLUTTERWAVE_CREDENTIAL_CONFIG_KEY]: SYNTHETIC_ENV_MATERIAL },
    });
    const result = (await connector.create(
      sdkCtx(
        {
          kind: "create_hosted_checkout",
          amountMajor: "100.00",
          currency: "NGN",
          customer: { email: "payer@synthetic.example" },
        },
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
    makeBareConnector: (http) => new FlutterwaveConnector({ clock: CONFORMANCE_CLOCK, http }),
    effectfulCalls: [
      {
        name: "create_hosted_checkout",
        invoke: (connector) =>
          connector.create(
            sdkCtx({
              kind: "create_hosted_checkout",
              amountMajor: "100.00",
              currency: "NGN",
              customer: { email: "payer@synthetic.example" },
            }),
          ),
      },
    ],
  },
  secretMaterialMarkers: [SYNTHETIC_ENV_MATERIAL, SYNTHETIC_VERIF_HASH],
};

function buildApplicability(): Readonly<Record<ConformanceScenarioId, ApplicabilityBasis>> {
  return {
    CUSTOMER_ACTION_REQUIRED: applicable(
      `${FLUTTERWAVE_HOSTED_CHECKOUT_CAPABILITY_ID} (the hosted-checkout link is the customer action)`,
    ),
    ASYNC_PROCESSING: applicable(
      `${FLUTTERWAVE_HOSTED_CHECKOUT_CAPABILITY_ID} (transaction pending state)`,
    ),
    CAPTURE: notSupportedByProvider(
      `Flutterwave has no manual-capture flow: the ${FLUTTERWAVE_HOSTED_CHECKOUT_CAPABILITY_ID} statuses (pending/successful/failed/reversed) contain no capture family — the provider settles directly on charge`,
    ),
    RECURRING_MANDATE: notSupportedByProvider(
      "Flutterwave tokenized charges are not exposed as provider mandate objects by the connector; no mandate-family state exists in its mapping",
    ),
    REFUND: applicable(
      `${FLUTTERWAVE_REFUND_CAPABILITY_ID} (refund lifecycle pending → completed)`,
    ),
    DISPUTE: notSupportedByProvider(
      "no dispute/chargeback surface in the Flutterwave connector vocabulary",
    ),
    PAYOUT: notSupportedByProvider(
      `no payout-execution family in the connector mapping; provider-held wallets are ${FLUTTERWAVE_WALLET_OBSERVATION_CAPABILITY_ID} (INV-C09 observation-only), distinct from pay-in`,
    ),
    DUPLICATE_SUBMISSION: applicable(
      `${FLUTTERWAVE_HOSTED_CHECKOUT_CAPABILITY_ID} tx_ref idempotency (deterministic tx_ref derivation; duplicateBehavior PROVIDER_DEFINED)`,
    ),
    WEBHOOK_LOSS: applicable(
      "verif-hash webhook ingestor + transaction re-fetch by numeric id (INV-X03)",
    ),
    PROVIDER_OUTAGE: applicable(
      "mid-create transport failure → OUTCOME_UNKNOWN (INV-X01; incident vocabulary)",
    ),
    UNKNOWN: applicable(
      `${FLUTTERWAVE_HOSTED_CHECKOUT_CAPABILITY_ID} (unmapped status → other/verbatim, non-terminal)`,
    ),
    PROVIDER_REVISION_CHANGE: applicable(
      "transaction revisions through the append-only ProviderRevisionLedger (INV-C06)",
    ),
    FALLBACK_RE_AUTHORIZATION: applicable(
      "execution-plane selection ladder + coverage-gap direct-local path (capabilities vocabulary)",
    ),
  };
}

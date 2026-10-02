import { describe, expect, it } from "vitest";
import {
  parseProviderStateEnvelope,
  serializeProviderStateEnvelope,
  validateExternalFundsPositionObservation,
  isExternalFundsPositionObservation,
} from "@payswap/connectors";
import type { ExternalFundsPositionObservation } from "@payswap/connectors";
import {
  CredentialBroker,
  SealedCredentialBundle,
  vaultReference,
} from "@payswap/adapters";
import type { ConnectorRuntimeKey, VaultStore } from "@payswap/adapters";
import {
  RailNotAuthorizedError,
  RailProviderError,
  RailTransportError,
  RAIL_CREDENTIAL_ENV_VARS,
} from "../src/support.js";
import type { HttpTransport } from "../src/support.js";
import {
  STRIPE_API_VERSION,
  STRIPE_CREDENTIAL_CONFIG_KEY,
  STRIPE_GHS_ELIGIBILITY,
  STRIPE_PAYPAL_ON_STRIPE_CAPABILITY_ID,
  STRIPE_PAYPAL_ON_STRIPE_ELIGIBILITY,
  STRIPE_PAYMENT_INTENT_STATUS_MAPPING,
  STRIPE_PROBED_ACCOUNT_SCOPE_20261002,
  StripeConnector,
  StripeIdempotencyConflictError,
  StripeIneligibleCurrencyError,
  StripeProductionRail,
  StripeWebhookVerifier,
  createStripeWebhookIngestor,
  extractStripeKeyMaterial,
  parseStripeSignatureHeader,
  stripeAccountCapabilityScope,
  stripeBalanceObservations,
  stripeBalanceTransactionEnvelope,
  stripeCapabilityDefinitions as stripeCapabilityDefinitionsForTest,
  stripeDisputeEnvelope,
  stripeIdempotencyKey,
  stripePayoutEnvelope,
  stripePayoutObservations,
  stripePaymentIntentCustomerAction,
  stripePaymentIntentEnvelope,
  stripeRefundEnvelope,
  stripeSignWebhookPayload,
  stripeSubscriptionEnvelope,
  stripeWebhookEventEnvelope,
  stripeWebhookRawEvent,
  stripeCurrencyEligibility,
  verifyStripeWebhookDelivery,
} from "../src/stripe.js";
import type {
  StripeDisputeProviderObject,
  StripePaymentIntentProviderObject,
  StripePayoutProviderObject,
  StripeRefundProviderObject,
  StripeSubscriptionProviderObject,
} from "../src/stripe.js";
import { CLOCK, ctx, makeAdapterAuthority } from "./fixtures.js";

const AUTHORITY = makeAdapterAuthority();

/** Narrowing helper for values the test knows are present. */
function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`expected ${what} to be present`);
  }
  return value;
}

/** BigInt-safe JSON serialization for secret-hygiene scans over products. */
function stringifySafe(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    typeof inner === "bigint" ? inner.toString() : inner,
  ) ?? "";
}

// ---------------------------------------------------------------------------
// Synthetic fixtures ONLY (never real key material; byte-scan safe)
// ---------------------------------------------------------------------------

const SYNTHETIC_CONTROL_PLANE_MATERIAL = "sk_test_SYNTHETIC_FIXTURE_0001_not_a_real_key";
const SYNTHETIC_ENV_MATERIAL = "sk_test_SYNTHETIC_ENV_FIXTURE_0002_not_a_real_key";
const SYNTHETIC_WEBHOOK_SECRET = "whsec_SYNTHETIC_FIXTURE_0003_not_a_real_secret";
const OBSERVED_AT = "2026-10-02T12:00:00.000Z";
const NOW_SECONDS = Number(CLOCK.now() / 1000n); // deterministic

function intent(
  status: string,
  overrides?: Partial<StripePaymentIntentProviderObject>,
): StripePaymentIntentProviderObject {
  return {
    id: "pi_3UM04TAkPdhgtN6I0CQcJZZg",
    status,
    currency: "eur",
    amount: 100,
    latest_charge: "ch_SYNTHETIC_1",
    ...overrides,
  };
}

function refund(
  status?: string,
  overrides?: Partial<StripeRefundProviderObject>,
): StripeRefundProviderObject {
  return {
    id: "re_SYNTHETIC_1",
    ...(status !== undefined ? { status } : {}),
    payment_intent: "pi_3UM04TAkPdhgtN6I0CQcJZZg",
    charge: "ch_SYNTHETIC_1",
    amount: 50,
    currency: "eur",
    ...overrides,
  };
}

function dispute(
  status?: string,
  overrides?: Partial<StripeDisputeProviderObject>,
): StripeDisputeProviderObject {
  return {
    id: "du_SYNTHETIC_1",
    ...(status !== undefined ? { status } : {}),
    payment_intent: "pi_3UM04TAkPdhgtN6I0CQcJZZg",
    charge: "ch_SYNTHETIC_1",
    amount: 100,
    currency: "eur",
    ...overrides,
  };
}

function payout(
  status?: string,
  overrides?: Partial<StripePayoutProviderObject>,
): StripePayoutProviderObject {
  return {
    id: "po_SYNTHETIC_1",
    ...(status !== undefined ? { status } : {}),
    amount: 1234,
    currency: "usd",
    destination: "ba_SYNTHETIC_1",
    arrival_date: 1_764_998_400,
    ...overrides,
  };
}

function subscription(
  status?: string,
  overrides?: Partial<StripeSubscriptionProviderObject>,
): StripeSubscriptionProviderObject {
  return {
    id: "sub_SYNTHETIC_1",
    ...(status !== undefined ? { status } : {}),
    customer: "cus_SYNTHETIC_1",
    latest_invoice: "in_SYNTHETIC_1",
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

class ScriptedStripeTransport {
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

const SUCCEEDED_INTENT = intent("succeeded", { amount_received: 100 });
const CANCELED_INTENT = intent("canceled");

/** A control-plane vault fixture: config key → vault ref → sealed bundle. */
class FixtureVaultStore implements VaultStore {
  readonly storeId = "vault-fixture-stripe";
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
          providerName: "stripe",
          authorizationMode: "SCOPED_API_CREDENTIAL",
          vaultReference: vaultReference(reference),
          issuedAt: "2026-10-02T06:37:38Z",
          accountRef: "acct_1FPs7UAkPdhgtN6I",
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

const VAULT_REF = "vault://payswap/providers/stripe/test-20261002";

function controlPlaneConnector(
  transport: ScriptedStripeTransport,
  material: unknown = SYNTHETIC_CONTROL_PLANE_MATERIAL,
): { connector: StripeConnector; broker: CredentialBroker; runtimeKey: ConnectorRuntimeKey; store: FixtureVaultStore } {
  const store = new FixtureVaultStore();
  store.bind(STRIPE_CREDENTIAL_CONFIG_KEY, VAULT_REF);
  store.seal(VAULT_REF, material);
  const broker = new CredentialBroker({ store });
  const runtimeKey = broker.registerConnectorRuntime("runtime.stripe.test");
  const connector = new StripeConnector({
    clock: CLOCK,
    http: transport.transport,
    credentials: { broker, runtimeKey },
  });
  return { connector, broker, runtimeKey, store };
}

function envConnector(
  transport: ScriptedStripeTransport,
  env: NodeJS.ProcessEnv = { [STRIPE_CREDENTIAL_CONFIG_KEY]: SYNTHETIC_ENV_MATERIAL },
): StripeConnector {
  return new StripeConnector({ clock: CLOCK, http: transport.transport, env });
}

// ---------------------------------------------------------------------------
// 1. PaymentIntent envelope mapping — EVERY status (INV-C06)
// ---------------------------------------------------------------------------

describe("stripe connector — PaymentIntent lifecycle mapping (lossless)", () => {
  const CASES: readonly {
    readonly status: string;
    readonly family: string;
    readonly lifecycleStep: string;
    readonly isTerminal: boolean;
    readonly requiresCustomerAction: boolean;
  }[] = [
    { status: "requires_payment_method", family: "other", lifecycleStep: "requires_payment_method", isTerminal: false, requiresCustomerAction: false },
    { status: "requires_confirmation", family: "customer_action_required", lifecycleStep: "requires_confirmation", isTerminal: false, requiresCustomerAction: true },
    { status: "requires_action", family: "customer_action_required", lifecycleStep: "requires_action", isTerminal: false, requiresCustomerAction: true },
    { status: "processing", family: "async_processing", lifecycleStep: "processing", isTerminal: false, requiresCustomerAction: false },
    { status: "requires_capture", family: "capture", lifecycleStep: "requires_capture", isTerminal: false, requiresCustomerAction: false },
    { status: "succeeded", family: "other", lifecycleStep: "succeeded", isTerminal: true, requiresCustomerAction: false },
    { status: "canceled", family: "other", lifecycleStep: "canceled", isTerminal: true, requiresCustomerAction: false },
  ];

  it("the exported status mapping table covers exactly the seven PaymentIntent statuses", () => {
    expect(STRIPE_PAYMENT_INTENT_STATUS_MAPPING.map((entry) => entry.providerState)).toEqual(
      CASES.map((entry) => entry.status),
    );
  });

  for (const testCase of CASES) {
    it(`maps '${testCase.status}' → family=${testCase.family} terminal=${testCase.isTerminal} customerAction=${testCase.requiresCustomerAction}`, () => {
      const envelope = stripePaymentIntentEnvelope(intent(testCase.status), {
        observedAt: OBSERVED_AT,
        provenanceSource: "PROVIDER_API",
      });
      expect(envelope.classification.family).toBe(testCase.family);
      expect(envelope.classification.lifecycleStep).toBe(testCase.lifecycleStep);
      expect(envelope.classification.isTerminal).toBe(testCase.isTerminal);
      expect(envelope.classification.requiresCustomerAction).toBe(testCase.requiresCustomerAction);
      // LOSSLESS: the raw provider object is carried verbatim (INV-C06).
      expect(envelope.state).toEqual(intent(testCase.status));
      expect(envelope.object.objectType).toBe("payment_intent");
      expect(envelope.object.externalId).toBe("pi_3UM04TAkPdhgtN6I0CQcJZZg");
      expect(envelope.provider.name).toBe("stripe");
      expect(envelope.provider.version).toBe(STRIPE_API_VERSION);
      expect(envelope.provenance.source).toBe("PROVIDER_API");
    });
  }

  it("requires_confirmation is a first-class customer action (real-connector divergence from the stripe-SHAPE rail)", () => {
    const envelope = stripePaymentIntentEnvelope(intent("requires_confirmation"), {
      observedAt: OBSERVED_AT,
      provenanceSource: "PROVIDER_API",
    });
    expect(envelope.actionRequired?.kind).toBe("CONFIRM_PAYMENT_INTENT");
    const requirement = stripePaymentIntentCustomerAction(intent("requires_confirmation"));
    expect(requirement?.family).toBe("customer_action_required");
    expect(requirement?.lifecycleStep).toBe("requires_confirmation");
    expect(requirement?.kind).toBe("CONFIRM_PAYMENT_INTENT");
  });

  it("requires_action carries the provider challenge with the redirect deep link", () => {
    const providerObject = intent("requires_action", {
      next_action: {
        type: "redirect_to_url",
        redirect_to_url: { url: "https://hooks.stripe.com/3d_secure_2/test/abc" },
      },
    });
    const envelope = stripePaymentIntentEnvelope(providerObject, {
      observedAt: OBSERVED_AT,
      provenanceSource: "PROVIDER_API",
    });
    expect(envelope.actionRequired?.kind).toBe("PROVIDER_CHALLENGE_REDIRECT");
    expect(envelope.actionRequired?.deepLink).toBe("https://hooks.stripe.com/3d_secure_2/test/abc");
    expect(stripePaymentIntentCustomerAction(providerObject)?.kind).toBe(
      "PROVIDER_CHALLENGE_REDIRECT",
    );
  });

  it("canceled carries definitive no-effect failure metadata while the raw status stays verbatim", () => {
    const envelope = stripePaymentIntentEnvelope(CANCELED_INTENT, {
      observedAt: OBSERVED_AT,
      provenanceSource: "PROVIDER_API",
    });
    expect(envelope.failure).toEqual({
      providerErrorCode: "payment_intent_canceled",
      retryable: false,
      ambiguity: "NONE",
    });
    expect((envelope.state as StripePaymentIntentProviderObject).status).toBe("canceled");
  });

  it("an UNKNOWN provider status stays verbatim under the total 'other' family — never dropped, never guessed", () => {
    const envelope = stripePaymentIntentEnvelope(intent("some_brand_new_status"), {
      observedAt: OBSERVED_AT,
      provenanceSource: "PROVIDER_API",
    });
    expect(envelope.classification.family).toBe("other");
    expect(envelope.classification.lifecycleStep).toBe("some_brand_new_status");
    expect(envelope.classification.isTerminal).toBe(false);
    expect(envelope.failure).toBeUndefined();
  });

  it("the revision tracks the intent's status and latest charge (status revision)", () => {
    const before = stripePaymentIntentEnvelope(intent("processing"), {
      observedAt: OBSERVED_AT,
      provenanceSource: "PROVIDER_API",
    });
    const after = stripePaymentIntentEnvelope(intent("succeeded"), {
      observedAt: OBSERVED_AT,
      provenanceSource: "PROVIDER_API",
    });
    const differentCharge = stripePaymentIntentEnvelope(
      intent("processing", { latest_charge: "ch_SYNTHETIC_2" }),
      { observedAt: OBSERVED_AT, provenanceSource: "PROVIDER_API" },
    );
    expect(before.revision).not.toBe(after.revision);
    expect(before.revision).not.toBe(differentCharge.revision);
    expect(before.revision).toContain("ch_SYNTHETIC_1");
  });

  it("provider-state envelopes round-trip LOSSLESSLY through serialize/parse for every status", () => {
    for (const testCase of CASES) {
      const envelope = stripePaymentIntentEnvelope(intent(testCase.status), {
        observedAt: OBSERVED_AT,
        provenanceSource: "PROVIDER_API",
        fetchId: "fetch-stripe-1",
      });
      const roundTripped = parseProviderStateEnvelope(serializeProviderStateEnvelope(envelope));
      expect(roundTripped).toEqual(envelope);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Refund / dispute / payout / subscription / balance-transaction mappings
// ---------------------------------------------------------------------------

describe("stripe connector — refund, dispute, payout, subscription mappings", () => {
  it("refunds: pending is asynchronous; succeeded/failed/canceled are terminal (failed carries definitive failure)", () => {
    const pending = stripeRefundEnvelope(refund("pending"), {
      observedAt: OBSERVED_AT,
      provenanceSource: "PROVIDER_API",
    });
    expect(pending.classification.family).toBe("refund");
    expect(pending.classification.isTerminal).toBe(false);
    const succeeded = stripeRefundEnvelope(refund("succeeded"), {
      observedAt: OBSERVED_AT,
      provenanceSource: "PROVIDER_API",
    });
    expect(succeeded.classification.isTerminal).toBe(true);
    expect(succeeded.classification.lifecycleStep).toBe("succeeded");
    const failed = stripeRefundEnvelope(refund("failed"), {
      observedAt: OBSERVED_AT,
      provenanceSource: "PROVIDER_API",
    });
    expect(failed.classification.isTerminal).toBe(true);
    expect(failed.failure).toEqual({ providerErrorCode: "refund_failed", retryable: false, ambiguity: "NONE" });
    const canceled = stripeRefundEnvelope(refund("canceled"), {
      observedAt: OBSERVED_AT,
      provenanceSource: "PROVIDER_API",
    });
    expect(canceled.classification.isTerminal).toBe(true);
    // Lossless: raw refund object verbatim, re_* external id preserved.
    expect(canceled.state).toEqual(refund("canceled"));
    expect(canceled.object.externalId).toBe("re_SYNTHETIC_1");
  });

  it("disputes: needs_response is customer-action-required in the dispute family (evidence submission)", () => {
    const needsResponse = stripeDisputeEnvelope(dispute("needs_response"), {
      observedAt: OBSERVED_AT,
      provenanceSource: "PROVIDER_API",
    });
    expect(needsResponse.classification.family).toBe("dispute");
    expect(needsResponse.classification.requiresCustomerAction).toBe(true);
    expect(needsResponse.actionRequired?.kind).toBe("DISPUTE_EVIDENCE_REQUIRED");
    const warningNeedsResponse = stripeDisputeEnvelope(dispute("warning_needs_response"), {
      observedAt: OBSERVED_AT,
      provenanceSource: "PROVIDER_API",
    });
    expect(warningNeedsResponse.classification.requiresCustomerAction).toBe(true);
    const underReview = stripeDisputeEnvelope(dispute("under_review"), {
      observedAt: OBSERVED_AT,
      provenanceSource: "PROVIDER_API",
    });
    expect(underReview.classification.isTerminal).toBe(false);
    expect(underReview.classification.requiresCustomerAction).toBe(false);
  });

  it("disputes: won/lost/charge_refunded/unresolved/warning_closed are terminal; lost carries failure", () => {
    for (const status of ["won", "lost", "charge_refunded", "unresolved", "warning_closed"]) {
      const envelope = stripeDisputeEnvelope(dispute(status), {
        observedAt: OBSERVED_AT,
        provenanceSource: "PROVIDER_API",
      });
      expect(envelope.classification.isTerminal, status).toBe(true);
    }
    const lost = stripeDisputeEnvelope(dispute("lost"), {
      observedAt: OBSERVED_AT,
      provenanceSource: "PROVIDER_API",
    });
    expect(lost.failure?.providerErrorCode).toBe("dispute_lost");
    expect(lost.failure?.ambiguity).toBe("NONE");
  });

  it("payouts: paid is terminal; pending/in_transit are in flight; failed is retryable-terminal", () => {
    const paid = stripePayoutEnvelope(payout("paid"), {
      observedAt: OBSERVED_AT,
      provenanceSource: "PROVIDER_API",
    });
    expect(paid.classification.family).toBe("payout");
    expect(paid.classification.isTerminal).toBe(true);
    const inTransit = stripePayoutEnvelope(payout("in_transit"), {
      observedAt: OBSERVED_AT,
      provenanceSource: "PROVIDER_API",
    });
    expect(inTransit.classification.isTerminal).toBe(false);
    const failed = stripePayoutEnvelope(payout("failed"), {
      observedAt: OBSERVED_AT,
      provenanceSource: "PROVIDER_API",
    });
    expect(failed.classification.isTerminal).toBe(true);
    expect(failed.failure?.retryable).toBe(true);
    expect(failed.failure?.ambiguity).toBe("NONE");
  });

  it("subscriptions: mandate-family mapping with first-class customer actions on incomplete/past_due/unpaid", () => {
    const incomplete = stripeSubscriptionEnvelope(subscription("incomplete"), {
      observedAt: OBSERVED_AT,
      provenanceSource: "PROVIDER_API",
    });
    expect(incomplete.classification.family).toBe("mandate");
    expect(incomplete.classification.requiresCustomerAction).toBe(true);
    expect(incomplete.actionRequired?.kind).toBe("MANDATE_CONFIRMATION_REQUIRED");
    for (const status of ["past_due", "unpaid"]) {
      const envelope = stripeSubscriptionEnvelope(subscription(status), {
        observedAt: OBSERVED_AT,
        provenanceSource: "PROVIDER_API",
      });
      expect(envelope.classification.requiresCustomerAction, status).toBe(true);
      expect(envelope.actionRequired?.kind).toBe("MANDATE_PAYMENT_REQUIRED");
    }
    const active = stripeSubscriptionEnvelope(subscription("active"), {
      observedAt: OBSERVED_AT,
      provenanceSource: "PROVIDER_API",
    });
    expect(active.classification.isTerminal).toBe(false);
    expect(active.classification.requiresCustomerAction).toBe(false);
    const canceledSub = stripeSubscriptionEnvelope(subscription("canceled"), {
      observedAt: OBSERVED_AT,
      provenanceSource: "PROVIDER_API",
    });
    expect(canceledSub.classification.isTerminal).toBe(true);
    const expired = stripeSubscriptionEnvelope(subscription("incomplete_expired"), {
      observedAt: OBSERVED_AT,
      provenanceSource: "PROVIDER_API",
    });
    expect(expired.classification.isTerminal).toBe(true);
  });

  it("balance transactions map to reconciliation-evidence envelopes (refund/dispute/payout families by type)", () => {
    const refundEntry = stripeBalanceTransactionEnvelope(
      { id: "txn_SYNTHETIC_1", type: "refund", amount: -50, currency: "eur", source: "re_SYNTHETIC_1" },
      { observedAt: OBSERVED_AT, provenanceSource: "PROVIDER_API" },
    );
    expect(refundEntry.classification.family).toBe("refund");
    expect(refundEntry.classification.lifecycleStep).toBe("refund");
    const disputeEntry = stripeBalanceTransactionEnvelope(
      { id: "txn_SYNTHETIC_2", type: "dispute", amount: -100, currency: "eur", source: "du_SYNTHETIC_1" },
      { observedAt: OBSERVED_AT, provenanceSource: "PROVIDER_API" },
    );
    expect(disputeEntry.classification.family).toBe("dispute");
    const chargeEntry = stripeBalanceTransactionEnvelope(
      { id: "txn_SYNTHETIC_3", type: "charge", amount: 100, currency: "eur", source: "ch_SYNTHETIC_1" },
      { observedAt: OBSERVED_AT, provenanceSource: "PROVIDER_API" },
    );
    expect(chargeEntry.classification.family).toBe("other");
  });

  it("webhook events map to the SAME lossless envelopes with PROVIDER_WEBHOOK provenance", () => {
    const event = {
      id: "evt_SYNTHETIC_1",
      type: "payment_intent.succeeded",
      data: { object: SUCCEEDED_INTENT },
    };
    const envelope = stripeWebhookEventEnvelope(event, { observedAt: OBSERVED_AT, provenanceSource: "PROVIDER_WEBHOOK" });
    expect(envelope.provenance.source).toBe("PROVIDER_WEBHOOK");
    expect(envelope.object.objectType).toBe("payment_intent");
    expect(envelope.classification.lifecycleStep).toBe("succeeded");
    expect(envelope.state).toEqual(SUCCEEDED_INTENT);
    const disputeEvent = {
      id: "evt_SYNTHETIC_2",
      type: "charge.dispute.created",
      data: { object: dispute("needs_response") },
    };
    const disputeEnvelope = stripeWebhookEventEnvelope(disputeEvent, {
      observedAt: OBSERVED_AT,
      provenanceSource: "PROVIDER_WEBHOOK",
    });
    expect(disputeEnvelope.object.objectType).toBe("dispute");
    expect(disputeEnvelope.classification.requiresCustomerAction).toBe(true);
  });

  it("unmapped webhook event types produce an event-typed envelope carrying the WHOLE event verbatim", () => {
    const event = { id: "evt_SYNTHETIC_3", type: "account.updated", data: { object: { id: "acct_1FPs7UAkPdhgtN6I" } } };
    const envelope = stripeWebhookEventEnvelope(event, { observedAt: OBSERVED_AT, provenanceSource: "PROVIDER_WEBHOOK" });
    expect(envelope.object.objectType).toBe("event");
    expect(envelope.state).toEqual(event);
    expect(envelope.classification.family).toBe("other");
  });

  it("refund/dispute/payout/subscription envelopes round-trip losslessly through serialize/parse", () => {
    const envelopes = [
      stripeRefundEnvelope(refund("succeeded"), { observedAt: OBSERVED_AT, provenanceSource: "PROVIDER_API" }),
      stripeDisputeEnvelope(dispute("under_review"), { observedAt: OBSERVED_AT, provenanceSource: "PROVIDER_API" }),
      stripePayoutEnvelope(payout("in_transit"), { observedAt: OBSERVED_AT, provenanceSource: "PROVIDER_API" }),
      stripeSubscriptionEnvelope(subscription("trialing"), { observedAt: OBSERVED_AT, provenanceSource: "PROVIDER_API" }),
      stripeWebhookEventEnvelope(
        { id: "evt_SYNTHETIC_1", type: "payment_intent.succeeded", data: { object: SUCCEEDED_INTENT } },
        { observedAt: OBSERVED_AT, provenanceSource: "PROVIDER_WEBHOOK" },
      ),
    ];
    for (const envelope of envelopes) {
      expect(parseProviderStateEnvelope(serializeProviderStateEnvelope(envelope))).toEqual(envelope);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. External funds observations (INV-C09 — observations, never custody)
// ---------------------------------------------------------------------------

describe("stripe connector — external funds observations", () => {
  it("maps /v1/balance to validated observations per (bucket, currency) with exact minor units", () => {
    const observations = stripeBalanceObservations({
      balance: {
        object: "balance",
        available: [
          { amount: 6978366, currency: "usd" },
          { amount: 14748, currency: "eur" },
        ],
        pending: [{ amount: 4200, currency: "usd" }],
      },
      accountRef: "acct_1FPs7UAkPdhgtN6I",
      observedAt: OBSERVED_AT,
    });
    expect(observations).toHaveLength(3);
    for (const observation of observations) {
      validateExternalFundsPositionObservation(observation); // throws when malformed
      expect(isExternalFundsPositionObservation(observation)).toBe(true);
      expect(observation.location.providerName).toBe("stripe");
      expect(observation.location.accountRef).toBe("acct_1FPs7UAkPdhgtN6I");
      expect(observation.provenance.source).toBe("PROVIDER_API");
      expect(observation.reconciliationState).toBe("NOT_RECONCILED");
    }
    const usdAvailable = observations.find(
      (observation) => observation.observedAmount.currency === "USD" && observation.location.instrumentRef === "balance:available",
    );
    expect(usdAvailable?.observedAmount.minorUnits).toBe("6978366"); // exact string, no float
  });

  it("observations are STRUCTURALLY not balances (nominal brand; no mutable balance shape)", () => {
    const observation = stripeBalanceObservations({
      balance: { object: "balance", available: [{ amount: 1, currency: "usd" }] },
      accountRef: "acct_1FPs7UAkPdhgtN6I",
      observedAt: OBSERVED_AT,
    })[0] as ExternalFundsPositionObservation;
    expect(observation.observationKind).toBe("ExternalFundsPositionObservation");
    const asRecord = observation as unknown as Record<string, unknown>;
    expect(asRecord["balance"]).toBeUndefined();
    expect(asRecord["availableBalance"]).toBeUndefined();
    expect(Object.keys(asRecord).sort()).toEqual(
      ["freshness", "location", "observationId", "observationKind", "observedAmount", "observedAt", "provenance", "reconciliationState"].sort(),
    );
  });

  it("maps payouts to observations with asOf from the provider arrival date", () => {
    const observations = stripePayoutObservations({
      payouts: [payout("in_transit"), { id: "po_SYNTHETIC_2", status: "paid", amount: 99, currency: "usd" }],
      accountRef: "acct_1FPs7UAkPdhgtN6I",
      observedAt: OBSERVED_AT,
    });
    expect(observations).toHaveLength(2);
    validateExternalFundsPositionObservation(observations[0] as ExternalFundsPositionObservation);
    expect((observations[0] as ExternalFundsPositionObservation).freshness.asOf).toBe(
      new Date(1_764_998_400 * 1000).toISOString(),
    );
    expect((observations[0] as ExternalFundsPositionObservation).location.instrumentRef).toBe(
      "payout:po_SYNTHETIC_1->ba_SYNTHETIC_1",
    );
    // A payout without arrival_date falls back to the observation time.
    expect((observations[1] as ExternalFundsPositionObservation).freshness.asOf).toBe(OBSERVED_AT);
  });
});

// ---------------------------------------------------------------------------
// 4. Webhook verification (Stripe-Signature; replay; dedupe)
// ---------------------------------------------------------------------------

describe("stripe connector — Stripe-Signature webhook verification", () => {
  const payload = { id: "evt_SYNTHETIC_1", type: "payment_intent.succeeded", data: { object: SUCCEEDED_INTENT } };
  const rawPayload = JSON.stringify(payload);
  const timestamp = String(NOW_SECONDS);

  function headerFor(secret: string, ts: string, body: string): string {
    return `t=${ts},v1=${stripeSignWebhookPayload(secret, ts, body)}`;
  }

  it("verifies a correctly signed delivery (HMAC-SHA256 over `${t}.${rawPayload}`)", () => {
    const verification = verifyStripeWebhookDelivery(
      { signatureHeader: headerFor(SYNTHETIC_WEBHOOK_SECRET, timestamp, rawPayload), rawPayload },
      { secret: SYNTHETIC_WEBHOOK_SECRET, nowMs: Number(CLOCK.now()) },
    );
    expect(verification).toEqual({ valid: true, timestamp });
  });

  it("rejects a bad signature", () => {
    const verification = verifyStripeWebhookDelivery(
      { signatureHeader: headerFor("whsec_WRONG_SECRET", timestamp, rawPayload), rawPayload },
      { secret: SYNTHETIC_WEBHOOK_SECRET, nowMs: Number(CLOCK.now()) },
    );
    expect(verification).toEqual({ valid: false, reason: "SIGNATURE_INVALID" });
  });

  it("rejects a stale timestamp outside the tolerance window (replay protection)", () => {
    const stale = String(NOW_SECONDS - 3600);
    const verification = verifyStripeWebhookDelivery(
      { signatureHeader: headerFor(SYNTHETIC_WEBHOOK_SECRET, stale, rawPayload), rawPayload },
      { secret: SYNTHETIC_WEBHOOK_SECRET, nowMs: Number(CLOCK.now()) },
    );
    expect(verification).toEqual({ valid: false, reason: "TIMESTAMP_OUTSIDE_TOLERANCE" });
  });

  it("rejects an unreasonably future timestamp", () => {
    const future = String(NOW_SECONDS + 600);
    const verification = verifyStripeWebhookDelivery(
      { signatureHeader: headerFor(SYNTHETIC_WEBHOOK_SECRET, future, rawPayload), rawPayload },
      { secret: SYNTHETIC_WEBHOOK_SECRET, nowMs: Number(CLOCK.now()) },
    );
    expect(verification).toEqual({ valid: false, reason: "FUTURE_TIMESTAMP" });
  });

  it("rejects malformed headers (missing t=, missing v1=, garbage)", () => {
    for (const header of ["", "v1=abc", "t=123", "garbage", "t=notanumber,v1=abc"]) {
      const verification = verifyStripeWebhookDelivery(
        { signatureHeader: header, rawPayload },
        { secret: SYNTHETIC_WEBHOOK_SECRET, nowMs: Number(CLOCK.now()) },
      );
      expect(verification, header).toEqual({ valid: false, reason: "MALFORMED_SIGNATURE_HEADER" });
    }
  });

  it("honors MULTIPLE v1 entries (webhook-secret rotation): any matching v1 is valid", () => {
    const oldSecret = "whsec_SYNTHETIC_OLD_SECRET_0004";
    const header = [
      `t=${timestamp}`,
      `v1=${stripeSignWebhookPayload(oldSecret, timestamp, rawPayload)}`,
      `v1=${stripeSignWebhookPayload(SYNTHETIC_WEBHOOK_SECRET, timestamp, rawPayload)}`,
    ].join(",");
    const verification = verifyStripeWebhookDelivery(
      { signatureHeader: header, rawPayload },
      { secret: SYNTHETIC_WEBHOOK_SECRET, nowMs: Number(CLOCK.now()) },
    );
    expect(verification.valid).toBe(true);
  });

  it("parseStripeSignatureHeader extracts t= and every v1=", () => {
    const parsed = parseStripeSignatureHeader("t=123,v1=aa,v1=bb, t=456, v1=cc");
    expect(parsed?.timestamp).toBe("123");
    expect(parsed?.signatures).toEqual(["aa", "bb", "cc"]);
  });

  it("stripeWebhookRawEvent adapts a delivery to the ingestor contract (timestamp from the header)", () => {
    const raw = stripeWebhookRawEvent({
      eventId: "evt_SYNTHETIC_1",
      payload,
      signatureHeader: headerFor(SYNTHETIC_WEBHOOK_SECRET, timestamp, rawPayload),
    });
    expect(raw?.providerName).toBe("stripe");
    expect(raw?.eventId).toBe("evt_SYNTHETIC_1");
    expect(raw?.timestamp).toBe(timestamp);
    expect(stripeWebhookRawEvent({ eventId: "evt_X", payload, signatureHeader: "garbage" })).toBeUndefined();
  });

  it("the ingestor wires the Stripe scheme: accept, bad-signature reject, stale reject, replayed eventId dedupe", () => {
    const ingestor = createStripeWebhookIngestor({
      secret: SYNTHETIC_WEBHOOK_SECRET,
      clock: CLOCK,
    });
    const canonicalBody = JSON.stringify(payload);
    const signedHeader = `t=${timestamp},v1=${stripeSignWebhookPayload(SYNTHETIC_WEBHOOK_SECRET, timestamp, canonicalBody)}`;
    const raw = stripeWebhookRawEvent({
      eventId: "evt_SYNTHETIC_1",
      payload,
      signatureHeader: signedHeader,
    });
    if (raw === undefined) {
      throw new Error("stripeWebhookRawEvent returned undefined for a signed delivery");
    }
    const accepted = ingestor.ingest(raw, {
      providerState: stripeWebhookEventEnvelope(payload, {
        observedAt: OBSERVED_AT,
        provenanceSource: "PROVIDER_WEBHOOK",
      }),
    });
    expect(accepted.kind).toBe("INGESTED");
    if (accepted.kind === "INGESTED") {
      expect(accepted.evidence.kind).toBe("WEBHOOK_EVENT");
      expect(accepted.event.providerState?.classification.lifecycleStep).toBe("succeeded");
    }

    // Replay of the SAME eventId (even with a fresh valid signature): deduped.
    const replayed = ingestor.ingest(raw);
    expect(replayed).toEqual({ kind: "ALREADY_INGESTED", providerName: "stripe", eventId: "evt_SYNTHETIC_1" });
    expect(ingestor.ingestedEvents()).toHaveLength(1);

    // Bad signature → rejected.
    const badSignature = ingestor.ingest(
      required(
        stripeWebhookRawEvent({
          eventId: "evt_SYNTHETIC_2",
          payload,
          signatureHeader: `t=${timestamp},v1=${"0".repeat(64)}`,
        }),
        "raw event",
      ),
    );
    expect(badSignature).toEqual({ kind: "REJECTED", reason: "SIGNATURE_INVALID" });

    // Stale timestamp → rejected by the replay window.
    const staleTs = String(NOW_SECONDS - 3600);
    const stale = ingestor.ingest(
      required(
        stripeWebhookRawEvent({
          eventId: "evt_SYNTHETIC_3",
          payload,
          signatureHeader: `t=${staleTs},v1=${stripeSignWebhookPayload(SYNTHETIC_WEBHOOK_SECRET, staleTs, canonicalBody)}`,
        }),
        "raw event",
      ),
    );
    expect(stale).toEqual({ kind: "REJECTED", reason: "TIMESTAMP_OUTSIDE_WINDOW" });
  });

  it("the StripeWebhookVerifier implements the adapters hook over the canonical body", () => {
    const verifier = new StripeWebhookVerifier(SYNTHETIC_WEBHOOK_SECRET);
    const canonicalBody = JSON.stringify(payload);
    const good = `t=${timestamp},v1=${stripeSignWebhookPayload(SYNTHETIC_WEBHOOK_SECRET, timestamp, canonicalBody)}`;
    expect(
      verifier.verify(
        { providerName: "stripe", eventId: "evt_X", timestamp, payload, headers: { signature: good, timestamp } },
        canonicalBody,
      ),
    ).toEqual({ valid: true });
    expect(
      verifier.verify(
        { providerName: "stripe", eventId: "evt_X", timestamp, payload, headers: { signature: `t=${timestamp},v1=deadbeef`, timestamp } },
        canonicalBody,
      ),
    ).toEqual({ valid: false, reason: "SIGNATURE_INVALID" });
  });

  it("a webhook envelope produced from a verified event round-trips losslessly", () => {
    const envelope = stripeWebhookEventEnvelope(
      { id: "evt_SYNTHETIC_1", type: "charge.dispute.created", data: { object: dispute("needs_response") } },
      { observedAt: OBSERVED_AT, provenanceSource: "PROVIDER_WEBHOOK", fetchId: "wh-1" },
    );
    expect(parseProviderStateEnvelope(serializeProviderStateEnvelope(envelope))).toEqual(envelope);
  });
});

// ---------------------------------------------------------------------------
// 5. Fail-closed credential gating (INV-NC04, INV-C01/C02)
// ---------------------------------------------------------------------------

describe("stripe connector — fail-closed credential gating", () => {
  it("no credential: availability UNKNOWN with provenance, never routable", () => {
    const transport = new ScriptedStripeTransport(() => jsonResponse(401, { error: { message: "unauthorized" } }));
    const connector = new StripeConnector({ clock: CLOCK, http: transport.transport });
    const observation = connector.availabilityObservation({
      instanceId: "inst-rails-stripe-1",
      observationVersion: 1,
    });
    expect(observation.availability).toBe("UNKNOWN");
    expect(observation.sourceAvailability).toBe("UNKNOWN");
    const implication = connector.railImplication(observation.availability);
    expect(implication.routable).toBe(false);
    expect(implication.reason).toContain("INV-NC04");
  });

  it("no credential: health is DEGRADED (endpoint answers) or UNKNOWN (transport dead), with reasons — never a business outcome", async () => {
    const answering = new ScriptedStripeTransport(() => jsonResponse(401, { error: { message: "unauthorized" } }));
    const degraded = await new StripeConnector({ clock: CLOCK, http: answering.transport }).health();
    expect(degraded.status).toBe("DEGRADED");
    expect(degraded.degradedReasons[0]).toContain("credentials absent");
    expect(degraded.degradedReasons[0]).toContain("INV-C01/C02");

    const dead = new ScriptedStripeTransport(() => {
      throw new Error("network down");
    });
    const unknown = await new StripeConnector({ clock: CLOCK, http: dead.transport }).health();
    expect(unknown.status).toBe("UNKNOWN");
  });

  it("no credential: effectful operations throw RailNotAuthorizedError BEFORE any provider call", async () => {
    const transport = new ScriptedStripeTransport(() => jsonResponse(200, {}));
    const connector = new StripeConnector({ clock: CLOCK, http: transport.transport });
    await expect(
      connector.create(ctx(AUTHORITY, { kind: "create_intent", amountMinor: "100", currency: "eur" })),
    ).rejects.toThrow(RailNotAuthorizedError);
    await expect(
      connector.update(ctx(AUTHORITY, { kind: "confirm_intent", intentId: "pi_X" })),
    ).rejects.toThrow(RailNotAuthorizedError);
    await expect(
      connector.executeAction(ctx(AUTHORITY, { kind: "cancel_intent", intentId: "pi_X" })),
    ).rejects.toThrow(RailNotAuthorizedError);
    await expect(connector.observeExternalFunds()).rejects.toThrow(RailNotAuthorizedError);
    await expect(connector.accountScope()).rejects.toThrow(RailNotAuthorizedError);
    expect(transport.calls).toHaveLength(0); // fail-closed BEFORE any provider call
  });

  it("credential surface declares the control-plane config key; RAIL_CREDENTIAL_ENV_VARS carries it", () => {
    const connector = new StripeConnector({ clock: CLOCK });
    expect(connector.credentialSurface()).toEqual([
      { envVar: "PROVIDER_STRIPE_CREDENTIAL_REF", kind: "API_KEY" },
    ]);
    expect(STRIPE_CREDENTIAL_CONFIG_KEY).toBe("PROVIDER_STRIPE_CREDENTIAL_REF");
    const declaration = RAIL_CREDENTIAL_ENV_VARS.find(
      (entry) => entry.envVar === "PROVIDER_STRIPE_CREDENTIAL_REF",
    );
    expect(declaration?.railId).toBe("rail.stripe");
    expect(declaration?.kind).toBe("API_KEY");
  });

  it("credentialResolutionState is honest about the path and NEVER carries material", () => {
    const none = new StripeConnector({ clock: CLOCK });
    expect(none.credentialResolutionState()).toEqual({
      kind: "NOT_PROVISIONED",
      configKey: "PROVIDER_STRIPE_CREDENTIAL_REF",
      reason: expect.stringContaining("INV-NC04"),
    });
    const envConnectorState = envConnector(new ScriptedStripeTransport(() => jsonResponse(200, {})))
      .credentialResolutionState();
    expect(envConnectorState.kind).toBe("ENV_RESOLVED_MATERIAL");
    expect(JSON.stringify(envConnectorState)).not.toContain(SYNTHETIC_ENV_MATERIAL);
    const controlPlaneState = controlPlaneConnector(
      new ScriptedStripeTransport(() => jsonResponse(200, {})),
    ).connector.credentialResolutionState();
    expect(controlPlaneState.kind).toBe("CONTROL_PLANE_SEALED");
    expect(JSON.stringify(controlPlaneState)).not.toContain(SYNTHETIC_CONTROL_PLANE_MATERIAL);
  });

  it("control plane with an UNBOUND config key fails closed (no silent fallback)", async () => {
    const store = new FixtureVaultStore(); // nothing bound
    const broker = new CredentialBroker({ store });
    const runtimeKey = broker.registerConnectorRuntime("runtime.stripe.test");
    const transport = new ScriptedStripeTransport(() => jsonResponse(200, {}));
    const connector = new StripeConnector({
      clock: CLOCK,
      http: transport.transport,
      credentials: { broker, runtimeKey },
    });
    await expect(
      connector.read(ctx(AUTHORITY, { kind: "read_intent", intentId: "pi_X" })),
    ).rejects.toThrow(RailNotAuthorizedError);
    expect(transport.calls).toHaveLength(0);
  });

  it("a forged connector runtime key cannot open the sealed bundle (structural opacity)", async () => {
    const store = new FixtureVaultStore();
    store.bind(STRIPE_CREDENTIAL_CONFIG_KEY, VAULT_REF);
    store.seal(VAULT_REF, SYNTHETIC_CONTROL_PLANE_MATERIAL);
    const broker = new CredentialBroker({ store });
    broker.registerConnectorRuntime("runtime.stripe.test");
    const forged = { runtimeId: "runtime.stripe.test" } as unknown as ConnectorRuntimeKey;
    const transport = new ScriptedStripeTransport(() => jsonResponse(200, SUCCEEDED_INTENT));
    const connector = new StripeConnector({
      clock: CLOCK,
      http: transport.transport,
      credentials: { broker, runtimeKey: forged },
    });
    await expect(
      connector.read(ctx(AUTHORITY, { kind: "read_intent", intentId: "pi_X" })),
    ).rejects.toThrow();
    expect(transport.calls).toHaveLength(0);
  });

  it("the sealed bundle material shape is validated (string or {secretKey|apiKey…}; anything else refuses)", () => {
    expect(extractStripeKeyMaterial("raw-key")).toBe("raw-key");
    expect(extractStripeKeyMaterial({ secretKey: "bundled-key" })).toBe("bundled-key");
    expect(extractStripeKeyMaterial({ api_key: "alt-key" })).toBe("alt-key");
    expect(() => extractStripeKeyMaterial({ unrelated: true })).toThrow();
    expect(() => extractStripeKeyMaterial("")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 6. Real request paths through the control plane + env fallback
// ---------------------------------------------------------------------------

describe("stripe connector — provider calls (scripted transport, no network)", () => {
  it("reads a PaymentIntent through the SEALED control-plane path with pinned version + bearer", async () => {
    const transport = new ScriptedStripeTransport((call) => {
      expect(call.url).toBe("https://api.stripe.com/v1/payment_intents/pi_3UM04TAkPdhgtN6I0CQcJZZg");
      return jsonResponse(200, SUCCEEDED_INTENT);
    });
    const { connector } = controlPlaneConnector(transport);
    const result = await connector.read(
      ctx(AUTHORITY, { kind: "read_intent", intentId: "pi_3UM04TAkPdhgtN6I0CQcJZZg" }, "idem-read-1"),
    );
    expect(result.providerState.classification.lifecycleStep).toBe("succeeded");
    expect(result.outcome.outcome).toBe("SUCCEEDED");
    expect(transport.calls[0]?.method).toBe("GET");
    expect(transport.calls[0]?.headers["Stripe-Version"]).toBe(STRIPE_API_VERSION);
    expect(transport.calls[0]?.headers["Authorization"]).toBe(`Bearer ${SYNTHETIC_CONTROL_PLANE_MATERIAL}`);
  });

  it("creates an intent (form-encoded, idempotency key derived from the protocol key)", async () => {
    const transport = new ScriptedStripeTransport((call) => {
      expect(call.method).toBe("POST");
      expect(call.headers["Idempotency-Key"]).toBe("payswap:idem-create-1");
      expect(call.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
      expect(call.body).toBe("amount=100&currency=eur");
      return jsonResponse(200, intent("requires_confirmation"));
    });
    const { connector } = controlPlaneConnector(transport);
    const result = await connector.create(
      ctx(AUTHORITY, { kind: "create_intent", amountMinor: "100", currency: "eur" }, "idem-create-1"),
    );
    expect(result.providerState.classification.family).toBe("customer_action_required");
    expect(result.outcome.outcome).toBe("AWAITING_CUSTOMER_ACTION");
  });

  it("creates a PayPal-on-Stripe intent via payment_method_types (a Stripe capability, distinct from PayPal Direct)", async () => {
    const transport = new ScriptedStripeTransport((call) => {
      // Form encoding percent-encodes the brackets (Stripe decodes them).
      expect(decodeURIComponent(call.body ?? "")).toContain("payment_method_types[0]=paypal");
      return jsonResponse(200, intent("requires_confirmation"));
    });
    const { connector } = controlPlaneConnector(transport);
    const result = await connector.create(
      ctx(
        AUTHORITY,
        { kind: "create_intent", amountMinor: "100", currency: "eur", paymentMethodTypes: ["paypal"] },
        "idem-paypal-1",
      ),
    );
    expect(result.providerState.provider.name).toBe("stripe");
    expect(STRIPE_PAYPAL_ON_STRIPE_CAPABILITY_ID).toBe("cap.rails.stripe.paypal_on_stripe");
    expect(STRIPE_PAYPAL_ON_STRIPE_ELIGIBILITY.eligible).toBe(true);
    expect(STRIPE_PAYPAL_ON_STRIPE_ELIGIBILITY.distinctFrom).toBe("paypal_direct");
    expect(STRIPE_PAYPAL_ON_STRIPE_ELIGIBILITY.probeExternalId).toBe("pi_3UM04TAkPdhgtN6I0CQcJZZg");
  });

  it("confirms and captures through update; capture carries amount_to_capture when given", async () => {
    const transport = new ScriptedStripeTransport((call) => {
      if (call.url.endsWith("/confirm")) {
        expect(call.body).toBe("");
        return jsonResponse(200, intent("processing"));
      }
      expect(call.url.endsWith("/capture")).toBe(true);
      expect(call.body).toBe("amount_to_capture=100");
      return jsonResponse(200, intent("succeeded"));
    });
    const { connector } = controlPlaneConnector(transport);
    const confirmed = await connector.update(
      ctx(AUTHORITY, { kind: "confirm_intent", intentId: "pi_3UM04TAkPdhgtN6I0CQcJZZg" }, "idem-confirm-1"),
    );
    expect(confirmed.providerState.classification.family).toBe("async_processing");
    expect(confirmed.outcome.outcome).toBe("ASYNC_PROCESSING");
    const captured = await connector.update(
      ctx(AUTHORITY, { kind: "capture_intent", intentId: "pi_3UM04TAkPdhgtN6I0CQcJZZg", amountMinor: "100" }, "idem-capture-1"),
    );
    expect(captured.providerState.classification.lifecycleStep).toBe("succeeded");
    expect(captured.providerState.classification.family).toBe("other");
    expect(captured.providerState.classification.isTerminal).toBe(true);
  });

  it("refuses GHS before any provider call (the negative probe datum is a non-routable eligibility fact)", async () => {
    const transport = new ScriptedStripeTransport(() => jsonResponse(200, {}));
    const { connector } = controlPlaneConnector(transport);
    await expect(
      connector.create(ctx(AUTHORITY, { kind: "create_intent", amountMinor: "100", currency: "ghs" })),
    ).rejects.toThrow(StripeIneligibleCurrencyError);
    expect(transport.calls).toHaveLength(0);
    expect(STRIPE_GHS_ELIGIBILITY.eligible).toBe(false);
    expect(STRIPE_GHS_ELIGIBILITY.providerError).toBe("Stripe accounts in FR do not support ghs");
    const eligibility = stripeCurrencyEligibility("GHS");
    expect(eligibility.basis).toBe("NEGATIVE_DATUM");
    expect(eligibility.eligible).toBe(false);
  });

  it("currency eligibility: active card capability → eligible; unobserved scope → UNKNOWN, never assumed", () => {
    const eligible = stripeCurrencyEligibility("eur");
    expect(eligible.eligible).toBe(true);
    expect(eligible.basis).toBe("ACTIVE_CAPABILITY");
    const unobserved = stripeCurrencyEligibility("eur", {
      accountId: "acct_OTHER",
      chargesEnabled: false,
      payoutsEnabled: null,
      livemode: false,
      capabilities: {},
      observedAt: OBSERVED_AT,
      provenanceSource: "OPERATOR",
    });
    expect(unobserved.basis).toBe("UNKNOWN");
    expect(unobserved.eligible).toBe(false);
    expect(unobserved.reason).toContain("never assumed");
  });

  it("reads refunds/disputes/subscriptions and reconciles by external id (INV-X03)", async () => {
    const transport = new ScriptedStripeTransport((call) => {
      if (call.url.includes("/v1/refunds/re_SYNTHETIC_1")) return jsonResponse(200, refund("succeeded"));
      if (call.url.includes("/v1/disputes/du_SYNTHETIC_1")) return jsonResponse(200, dispute("needs_response"));
      if (call.url.includes("/v1/subscriptions/sub_SYNTHETIC_1")) return jsonResponse(200, subscription("active"));
      if (call.url.includes("/v1/balance_transactions")) {
        return jsonResponse(200, {
          object: "list",
          data: [{ id: "txn_SYNTHETIC_1", type: "refund", amount: -50, currency: "eur", source: "re_SYNTHETIC_1" }],
        });
      }
      return jsonResponse(404, { error: { message: `unexpected ${call.url}` } });
    });
    const { connector } = controlPlaneConnector(transport);
    const refundResult = await connector.reconcile(
      ctx(AUTHORITY, { kind: "reconcile_refund", refundId: "re_SYNTHETIC_1" }, "idem-rec-1"),
    );
    expect(refundResult.providerState.classification.family).toBe("refund");
    const disputeResult = await connector.read(
      ctx(AUTHORITY, { kind: "read_dispute", disputeId: "du_SYNTHETIC_1" }, "idem-rec-2"),
    );
    expect(disputeResult.outcome.outcome).toBe("AWAITING_CUSTOMER_ACTION");
    const subscriptionResult = await connector.read(
      ctx(AUTHORITY, { kind: "read_subscription", subscriptionId: "sub_SYNTHETIC_1" }, "idem-rec-3"),
    );
    expect(subscriptionResult.providerState.classification.family).toBe("mandate");
    const evidence = await connector.reconcile(
      ctx(AUTHORITY, { kind: "balance_transactions", sourceId: "re_SYNTHETIC_1" }, "idem-rec-4"),
    );
    expect(evidence.providerState.object.objectType).toBe("balance_transaction_list");
    expect(evidence.providerState.classification.lifecycleStep).toBe("reconciliation_evidence");
    expect((evidence.providerState.state as { data: unknown[] }).data).toHaveLength(1);
  });

  it("observes the account scope from a live GET /v1/account (observed, not assumed)", async () => {
    const transport = new ScriptedStripeTransport((call) => {
      expect(call.url).toBe("https://api.stripe.com/v1/account");
      return jsonResponse(200, {
        id: "acct_1FPs7UAkPdhgtN6I",
        country: "FR",
        business_type: "sole_prop",
        charges_enabled: true,
        payouts_enabled: false,
        livemode: false,
        capabilities: {
          card_payments: "active",
          cartes_bancaires_payments: "pending",
          sepa_debit_payments: "inactive",
          klarna_payments: "active",
        },
      });
    });
    const { connector } = controlPlaneConnector(transport);
    const scope = await connector.accountScope();
    expect(scope.accountId).toBe("acct_1FPs7UAkPdhgtN6I");
    expect(scope.chargesEnabled).toBe(true);
    expect(scope.payoutsEnabled).toBe(false);
    expect(scope.livemode).toBe(false);
    expect(scope.capabilities["cartes_bancaires_payments"]).toBe("pending");
    expect(scope.capabilities["sepa_debit_payments"]).toBe("inactive");
    expect(scope.provenanceSource).toBe("PROVIDER_API");
  });

  it("account capability scope reduces object-shaped capability values to their status (version-tolerant)", () => {
    const scope = stripeAccountCapabilityScope(
      { id: "acct_X", capabilities: { card_payments: { status: "active" } } },
      OBSERVED_AT,
    );
    expect(scope.capabilities["card_payments"]).toBe("active");
  });

  it("the recorded probe datum matches the live-observed shape (2026-10-02)", () => {
    expect(STRIPE_PROBED_ACCOUNT_SCOPE_20261002.accountId).toBe("acct_1FPs7UAkPdhgtN6I");
    expect(STRIPE_PROBED_ACCOUNT_SCOPE_20261002.country).toBe("FR");
    expect(STRIPE_PROBED_ACCOUNT_SCOPE_20261002.capabilities["card_payments"]).toBe("active");
    expect(STRIPE_PROBED_ACCOUNT_SCOPE_20261002.capabilities["transfers"]).toBe("active");
    expect(STRIPE_PROBED_ACCOUNT_SCOPE_20261002.provenanceSource).toBe("OPERATOR");
  });

  it("observes external funds (balance) and payouts through the connector", async () => {
    const transport = new ScriptedStripeTransport((call) => {
      if (call.url.endsWith("/v1/account")) {
        return jsonResponse(200, { id: "acct_1FPs7UAkPdhgtN6I" });
      }
      if (call.url.endsWith("/v1/balance")) {
        return jsonResponse(200, {
          object: "balance",
          available: [{ amount: 14748, currency: "eur" }],
          pending: [],
        });
      }
      if (call.url.includes("/v1/payouts")) {
        return jsonResponse(200, { object: "list", data: [payout("paid")] });
      }
      return jsonResponse(404, { error: { message: "unexpected" } });
    });
    const { connector } = controlPlaneConnector(transport);
    const funds = await connector.observeExternalFunds();
    expect(funds).toHaveLength(1);
    validateExternalFundsPositionObservation(funds[0] as ExternalFundsPositionObservation);
    expect((funds[0] as ExternalFundsPositionObservation).observedAmount.minorUnits).toBe("14748");
    const payouts = await connector.observePayouts();
    expect(payouts).toHaveLength(1);
    expect((payouts[0] as ExternalFundsPositionObservation).location.instrumentRef).toContain("po_SYNTHETIC_1");
  });

  it("health with credentials runs the REAL authenticated probe (GET /v1/account) → HEALTHY", async () => {
    const transport = new ScriptedStripeTransport((call) => {
      expect(call.url).toBe("https://api.stripe.com/v1/account");
      return jsonResponse(200, { id: "acct_1FPs7UAkPdhgtN6I" });
    });
    const { connector } = controlPlaneConnector(transport);
    const report = await connector.health();
    expect(report.status).toBe("HEALTHY");
    expect(report.connectorId).toBe("connector.rails.stripe");
    expect(report.providerVersion).toBe(STRIPE_API_VERSION);
  });

  it("health with credentials but a dead transport → UNKNOWN (never a business outcome)", async () => {
    const dead = new ScriptedStripeTransport(() => {
      throw new Error("network down");
    });
    const { connector } = controlPlaneConnector(dead);
    const report = await connector.health();
    expect(report.status).toBe("UNKNOWN");
  });

  it("env-resolved material path issues the same authenticated calls", async () => {
    const transport = new ScriptedStripeTransport((call) => {
      expect(call.headers["Authorization"]).toBe(`Bearer ${SYNTHETIC_ENV_MATERIAL}`);
      return jsonResponse(200, SUCCEEDED_INTENT);
    });
    const connector = envConnector(transport);
    const result = await connector.read(
      ctx(AUTHORITY, { kind: "read_intent", intentId: "pi_3UM04TAkPdhgtN6I0CQcJZZg" }, "idem-env-1"),
    );
    expect(result.providerState.classification.lifecycleStep).toBe("succeeded");
  });

  it("cancels a subscription through DELETE /v1/subscriptions/:id", async () => {
    const transport = new ScriptedStripeTransport((call) => {
      expect(call.method).toBe("DELETE");
      expect(call.url).toBe("https://api.stripe.com/v1/subscriptions/sub_SYNTHETIC_1");
      return jsonResponse(200, subscription("canceled"));
    });
    const { connector } = controlPlaneConnector(transport);
    const result = await connector.executeAction(
      ctx(AUTHORITY, { kind: "cancel_subscription", subscriptionId: "sub_SYNTHETIC_1" }, "idem-cancel-sub-1"),
    );
    expect(result.providerState.classification.family).toBe("mandate");
    expect(result.providerState.classification.isTerminal).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. Idempotency (INV-F05)
// ---------------------------------------------------------------------------

describe("stripe connector — idempotency", () => {
  it("derives the Stripe Idempotency-Key from the protocol key (deterministic, namespaced)", () => {
    expect(stripeIdempotencyKey("idem-1")).toBe("payswap:idem-1");
    expect(stripeIdempotencyKey("idem-1")).toBe(stripeIdempotencyKey("idem-1"));
    expect(() => stripeIdempotencyKey("")).toThrow();
  });

  it("a duplicate submit with the SAME key and body returns the SAME result (Stripe replays the original)", async () => {
    let calls = 0;
    const transport = new ScriptedStripeTransport(() => {
      calls += 1;
      return jsonResponse(200, intent("requires_confirmation"));
    });
    const { connector } = controlPlaneConnector(transport);
    const first = await connector.create(
      ctx(AUTHORITY, { kind: "create_intent", amountMinor: "100", currency: "eur" }, "idem-dup-1"),
    );
    const second = await connector.create(
      ctx(AUTHORITY, { kind: "create_intent", amountMinor: "100", currency: "eur" }, "idem-dup-1"),
    );
    expect(calls).toBe(2);
    expect(second.providerState.object.externalId).toBe(first.providerState.object.externalId);
    expect(second.providerState.state).toEqual(first.providerState.state);
    expect(second.outcome).toEqual(first.outcome);
  });

  it("the same idempotency key with a DIFFERENT body is an ERROR STATE, never a silent success (409 idempotency_error)", async () => {
    const transport = new ScriptedStripeTransport((call) => {
      if (call.body === "amount=100&currency=eur") {
        return jsonResponse(200, intent("requires_confirmation"));
      }
      return jsonResponse(409, {
        error: {
          type: "idempotency_error",
          message:
            "Keys for idempotent requests can only be used with the same parameters they were first used with.",
        },
      });
    });
    const { connector } = controlPlaneConnector(transport);
    await connector.create(
      ctx(AUTHORITY, { kind: "create_intent", amountMinor: "100", currency: "eur" }, "idem-conflict-1"),
    );
    await expect(
      connector.create(
        ctx(AUTHORITY, { kind: "create_intent", amountMinor: "999", currency: "eur" }, "idem-conflict-1"),
      ),
    ).rejects.toThrow(StripeIdempotencyConflictError);
  });
});

// ---------------------------------------------------------------------------
// 8. UNKNOWN vs FAILED (INV-X01 — the adversarial cases)
// ---------------------------------------------------------------------------

describe("stripe connector — UNKNOWN never collapses to FAILED (INV-X01)", () => {
  it("network failure MID-CONFIRM → OUTCOME_UNKNOWN with requiresReconciliation, never FAILED", async () => {
    const transport = new ScriptedStripeTransport(() => {
      throw new Error("connection reset mid-confirm");
    });
    const { connector } = controlPlaneConnector(transport);
    const result = await connector.update(
      ctx(AUTHORITY, { kind: "confirm_intent", intentId: "pi_3UM04TAkPdhgtN6I0CQcJZZg" }, "idem-mid-confirm-1"),
    );
    expect(result.outcome.outcome).toBe("OUTCOME_UNKNOWN");
    if (result.outcome.outcome === "OUTCOME_UNKNOWN") {
      expect(result.outcome.requiresReconciliation).toBe(true);
    }
    expect(result.outcome.outcome).not.toBe("FAILED");
    expect(result.providerState.classification.lifecycleStep).toBe("outcome_unknown");
    expect(result.providerState.classification.isTerminal).toBe(false);
    expect(result.providerState.failure?.ambiguity).toBe("OUTCOME_UNKNOWN");
    const state = result.providerState.state as Record<string, unknown>;
    expect(state["operation"]).toBe("confirm_intent");
    expect(state["externalId"]).toBe("pi_3UM04TAkPdhgtN6I0CQcJZZg");
    expect(String(state["note"])).toContain("never coerced to FAILED");
  });

  it("the same holds for capture, cancel and refund submission (every known-object effect)", async () => {
    const transport = new ScriptedStripeTransport(() => {
      throw new Error("connection reset");
    });
    const { connector } = controlPlaneConnector(transport);
    const capture = await connector.update(
      ctx(AUTHORITY, { kind: "capture_intent", intentId: "pi_X" }, "idem-u1"),
    );
    expect(capture.outcome.outcome).toBe("OUTCOME_UNKNOWN");
    const cancel = await connector.executeAction(
      ctx(AUTHORITY, { kind: "cancel_intent", intentId: "pi_X" }, "idem-u2"),
    );
    expect(cancel.outcome.outcome).toBe("OUTCOME_UNKNOWN");
    const refundResult = await connector.executeAction(
      ctx(AUTHORITY, { kind: "create_refund", paymentIntentId: "pi_X" }, "idem-u3"),
    );
    expect(refundResult.outcome.outcome).toBe("OUTCOME_UNKNOWN");
    expect(refundResult.providerState.object.objectType).toBe("refund");
  });

  it("a READ with a dead transport propagates RailTransportError (no fabricated provider state)", async () => {
    const transport = new ScriptedStripeTransport(() => {
      throw new Error("network down");
    });
    const { connector } = controlPlaneConnector(transport);
    await expect(
      connector.read(ctx(AUTHORITY, { kind: "read_intent", intentId: "pi_X" }, "idem-r1")),
    ).rejects.toThrow(RailTransportError);
  });

  it("a 402 decline answer is a DEFINITIVE provider outcome: the returned intent maps losslessly", async () => {
    const declinedIntent = intent("requires_payment_method", {
      last_payment_error: { code: "card_declined", message: "Your card was declined." },
    });
    const transport = new ScriptedStripeTransport((call) => {
      expect(call.url.endsWith("/confirm")).toBe(true);
      return jsonResponse(402, {
        error: {
          type: "card_error",
          code: "card_declined",
          message: "Your card was declined.",
          payment_intent: declinedIntent,
        },
      });
    });
    const { connector } = controlPlaneConnector(transport);
    const result = await connector.update(
      ctx(AUTHORITY, { kind: "confirm_intent", intentId: "pi_3UM04TAkPdhgtN6I0CQcJZZg" }, "idem-decline-1"),
    );
    expect(result.providerState.classification.lifecycleStep).toBe("requires_payment_method");
    expect(result.providerState.state).toEqual(declinedIntent);
    expect(result.outcome.outcome).toBe("ASYNC_PROCESSING"); // non-terminal raw state; the decline is in the verbatim state
  });

  it("a provider 404 is RailProviderError, and a provider error answer is DEGRADED health, never a business outcome", async () => {
    const notFound = new ScriptedStripeTransport(() =>
      jsonResponse(404, { error: { message: "No such payment_intent: 'pi_MISSING'" } }),
    );
    const { connector } = controlPlaneConnector(notFound);
    await expect(
      connector.read(ctx(AUTHORITY, { kind: "read_intent", intentId: "pi_MISSING" }, "idem-nf")),
    ).rejects.toThrow(RailProviderError);
    const errored = new ScriptedStripeTransport(() =>
      jsonResponse(403, { error: { type: "invalid_request_error", message: "bad thing" } }),
    );
    const { connector: erroringConnector } = controlPlaneConnector(errored);
    const report = await erroringConnector.health();
    expect(report.status).toBe("DEGRADED");
    expect(report.degradedReasons[0]).toContain("never a business outcome");
  });

  it("the OUTCOME_UNKNOWN envelope itself round-trips losslessly (reconciliation can consume it)", async () => {
    const transport = new ScriptedStripeTransport(() => {
      throw new Error("reset");
    });
    const connector = new StripeConnector({
      clock: CLOCK,
      http: transport.transport,
      env: { PROVIDER_STRIPE_CREDENTIAL_REF: SYNTHETIC_ENV_MATERIAL },
    });
    const result = await connector.update(
      ctx(AUTHORITY, { kind: "confirm_intent", intentId: "pi_X" }, "idem-rt"),
    );
    expect(parseProviderStateEnvelope(serializeProviderStateEnvelope(result.providerState))).toEqual(
      result.providerState,
    );
  });
});

// ---------------------------------------------------------------------------
// 9. No-secret assertions (envelopes and evidence NEVER carry key material)
// ---------------------------------------------------------------------------

describe("stripe connector — secret hygiene (no key material in any product)", () => {
  it("envelopes, evidence and health reports never contain the transport credential material", async () => {
    const transport = new ScriptedStripeTransport((call) => {
      if (call.url.endsWith("/v1/account")) return jsonResponse(200, { id: "acct_1FPs7UAkPdhgtN6I" });
      if (call.url.endsWith("/v1/balance")) {
        return jsonResponse(200, { object: "balance", available: [{ amount: 1, currency: "usd" }] });
      }
      return jsonResponse(200, SUCCEEDED_INTENT);
    });
    const { connector } = controlPlaneConnector(transport);
    const read = await connector.read(
      ctx(AUTHORITY, { kind: "read_intent", intentId: "pi_3UM04TAkPdhgtN6I0CQcJZZg" }, "idem-sec-1"),
    );
    const funds = await connector.observeExternalFunds();
    const health = await connector.health();
    for (const serialized of [
      stringifySafe(read.providerState),
      stringifySafe(read.evidence),
      stringifySafe(read.outcome),
      stringifySafe(funds),
      stringifySafe(health),
      serializeProviderStateEnvelope(read.providerState),
    ]) {
      expect(serialized).not.toContain(SYNTHETIC_CONTROL_PLANE_MATERIAL);
      expect(serialized).not.toContain("sk_test_SYNTHETIC");
      expect(serialized).not.toContain("Bearer ");
    }
  });

  it("the webhook secret never appears in verification results or ingestor products", () => {
    const ingestor = createStripeWebhookIngestor({ secret: SYNTHETIC_WEBHOOK_SECRET, clock: CLOCK });
    const canonicalBody = JSON.stringify({ id: "evt_S", type: "payout.paid", data: { object: payout("paid") } });
    const ts = String(NOW_SECONDS);
    const header = `t=${ts},v1=${stripeSignWebhookPayload(SYNTHETIC_WEBHOOK_SECRET, ts, canonicalBody)}`;
    const raw = stripeWebhookRawEvent({ eventId: "evt_S", payload: JSON.parse(canonicalBody), signatureHeader: header });
    const outcome = ingestor.ingest(required(raw, "raw event"));
    const serialized = stringifySafe(outcome);
    expect(serialized).not.toContain(SYNTHETIC_WEBHOOK_SECRET);
    expect(serialized).not.toContain("whsec_");
  });
});

// ---------------------------------------------------------------------------
// 10. Adapter/pack surface + rotation
// ---------------------------------------------------------------------------

describe("stripe connector — adapter, pack and rotation surface", () => {
  it("the production rail registers on the BaseRailAdapter framework with a valid pack", () => {
    const rail = new StripeProductionRail();
    expect(rail.adapterId).toBe("rail.stripe");
    expect(rail.implementationId).toBe("impl.rails.stripe.2025-08-27.basil");
    const pack = rail.capabilityPack();
    expect(pack.packId).toBe("pack.rails.stripe");
    expect(pack.family).toBe("payments");
    expect(pack.capabilityRefs).toHaveLength(6);
    expect(rail.sourceOfTruthPolicy("payment_intent")).toBe("EXTERNAL_AUTHORITATIVE");
    expect(rail.describePreconditions("cap.rails.stripe.payment_intent").length).toBeGreaterThan(0);
  });

  it("the capability definitions validate and the paypal-on-Stripe capability is distinct from PayPal Direct", () => {
    const definitions = new Map(
      stripeCapabilityDefinitionsForTest().map((definition) => [definition.capabilityId, definition]),
    );
    expect(definitions.size).toBe(6);
    const ids = [...definitions.keys()];
    expect(ids).toContain("cap.rails.stripe.payment_intent");
    expect(ids).toContain("cap.rails.stripe.paypal_on_stripe");
    // No capability id may even mention the PayPal Direct provider.
    expect(ids.every((id) => !id.startsWith("cap.providers.paypal"))).toBe(true);
    // The connector SDK validates the pack (certification-style check).
    expect(new StripeConnector({ clock: CLOCK }).validateCapabilityPack().packId).toBe(
      "pack.rails.stripe",
    );
  });

  it("provider identity is pinned (stripe @ the pinned API version)", () => {
    const connector = new StripeConnector({ clock: CLOCK });
    const identity = connector.providerIdentity();
    expect(identity.providerName).toBe("stripe");
    expect(identity.providerVersion).toBe(STRIPE_API_VERSION);
    expect(identity.systemKind).toBe("psp");
  });

  it("rotateCredentials (control plane): baseline first, then swap-reference-then-verify", async () => {
    const transport = new ScriptedStripeTransport(() => jsonResponse(200, SUCCEEDED_INTENT));
    const { connector, store } = controlPlaneConnector(transport);
    // First use records the baseline and refuses.
    await expect(
      connector.rotateCredentials(ctx(AUTHORITY, { kind: "credential_rotation" }, "idem-rot-1")),
    ).rejects.toThrow(/baseline recorded on first use/);
    // Same reference again → refuses (no rotation without a NEW reference).
    await expect(
      connector.rotateCredentials(ctx(AUTHORITY, { kind: "credential_rotation" }, "idem-rot-2")),
    ).rejects.toThrow(/requires a NEW vault reference/);
    // Swap the vault binding to a NEW reference with new material.
    const newRef = "vault://payswap/providers/stripe/test-20261003";
    store.bind(STRIPE_CREDENTIAL_CONFIG_KEY, newRef);
    store.seal(newRef, "sk_test_SYNTHETIC_ROTATED_0005_not_a_real_key");
    const rotation = await connector.rotateCredentials(
      ctx(AUTHORITY, { kind: "credential_rotation" }, "idem-rot-3"),
    );
    expect(rotation.newCredentialRef).toBe(newRef);
    expect(rotation.evidence.kind).toBe("AUDIT_LOG");
    expect(stringifySafe(rotation)).not.toContain("sk_test_SYNTHETIC");
    // The connector immediately serves through the NEW reference.
    const result = await connector.read(
      ctx(AUTHORITY, { kind: "read_intent", intentId: "pi_3UM04TAkPdhgtN6I0CQcJZZg" }, "idem-rot-4"),
    );
    expect(transport.calls.at(-1)?.headers["Authorization"]).toBe(
      "Bearer sk_test_SYNTHETIC_ROTATED_0005_not_a_real_key",
    );
    expect(result.providerState.classification.lifecycleStep).toBe("succeeded");
  });

  it("rotateCredentials without any credential path fails closed", async () => {
    const connector = new StripeConnector({ clock: CLOCK });
    await expect(
      connector.rotateCredentials(ctx(AUTHORITY, { kind: "credential_rotation" }, "idem-rot-x")),
    ).rejects.toThrow(RailNotAuthorizedError);
  });

  it("subscribe/disconnect are lifecycle-owned surfaces (explicit refusals, no silent behavior)", async () => {
    const connector = new StripeConnector({ clock: CLOCK });
    await expect(
      connector.subscribe(ctx(AUTHORITY, { kind: "subscribe" }, "idem-s")),
    ).rejects.toThrow(/webhook ingestion framework/);
    await expect(
      connector.disconnect(ctx(AUTHORITY, { kind: "disconnect" }, "idem-d")),
    ).rejects.toThrow(/connector-registry lifecycle/);
  });
});

import { describe, expect, it } from "vitest";
import {
  parseProviderStateEnvelope,
  serializeProviderStateEnvelope,
  validateExternalFundsPositionObservation,
  authorizeTransferOut,
  activateConnectedInstance,
  TransferOutNotAuthorizedError,
} from "@payswap/connectors";
import type {
  ConnectedCapabilityInstance,
  ConnectedInstanceActivation,
  ExternalFundsPositionObservation,
} from "@payswap/connectors";
import {
  CredentialBroker,
  SealedCredentialBundle,
  vaultReference,
} from "@payswap/adapters";
import type { ConnectorRuntimeKey, VaultStore } from "@payswap/adapters";
import {
  RailNotAuthorizedError,
  RailProviderError,
  RAIL_CREDENTIAL_ENV_VARS,
} from "../src/support.js";
import type { HttpTransport } from "../src/support.js";
import { STRIPE_PAYPAL_ON_STRIPE_ELIGIBILITY } from "../src/stripe.js";
import { STRIPE_PAYPAL_ON_STRIPE_CAPABILITY_ID } from "../src/stripe.js";
import {
  PAYPAL_DIRECT_API_VERSION,
  PAYPAL_DIRECT_AUTHORIZATION_MODES,
  PAYPAL_DIRECT_CAPTURE_STATUS_MAPPING,
  PAYPAL_DIRECT_CHECKOUT_ORDER_CAPABILITY_ID,
  PAYPAL_DIRECT_CREDENTIAL_CONFIG_KEY,
  PAYPAL_DIRECT_PAYOUT_CAPABILITY_ID,
  PAYPAL_DIRECT_PAYOUT_BATCH_STATUS_MAPPING,
  PAYPAL_DIRECT_PAYOUT_ITEM_STATUS_MAPPING,
  PAYPAL_DIRECT_PROVIDER_NAME,
  PAYPAL_DIRECT_AUTHORIZATION_STATUS_MAPPING,
  PAYPAL_DIRECT_REFUND_STATUS_MAPPING,
  PAYPAL_DIRECT_ORDER_STATUS_MAPPING,
  PAYPAL_CURRENCY_MINOR_DIGITS,
  PAYPAL_WEBHOOK_EVENT_TYPE_MAPPING,
  PayPalDirectConnector,
  PayPalDirectProductionRail,
  PayPalDuplicateSubmitError,
  PayPalIdempotencyConflictError,
  PayPalPayoutDestinationError,
  PayPalWebhookVerifier,
  extractPayPalCredentialMaterial,
  minorUnitsToPayPalValue,
  paypalAuthorizationEnvelope,
  paypalCaptureEnvelope,
  paypalDirectAccountScope,
  paypalDirectCapabilityDefinitions as paypalDirectCapabilityDefinitionsForTest,
  paypalDirectCountryEligibility,
  paypalMoneyToMinorUnits,
  paypalOrderCustomerAction,
  paypalOrderEnvelope,
  paypalPayoutBatchEnvelope,
  paypalPayoutItemEnvelope,
  paypalPayoutItemObservations,
  paypalRefundEnvelope,
  paypalRequestId,
  paypalSenderBatchId,
  paypalWebhookEventEnvelope,
} from "../src/paypal-direct.js";
import type {
  PayPalAuthorizationProviderObject,
  PayPalCaptureProviderObject,
  PayPalDirectPayoutDestination,
  PayPalDirectPayoutItemInput,
  PayPalOrderProviderObject,
  PayPalPayoutBatchProviderObject,
  PayPalPayoutItemProviderObject,
  PayPalRefundProviderObject,
  PayPalTokenProviderObject,
  PayPalWebhookEventObject,
} from "../src/paypal-direct.js";
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

const SYNTHETIC_CLIENT_ID = "cid_SYNTHETIC_0001";
const SYNTHETIC_CLIENT_SECRET = "csec_SYNTHETIC_0002";
const SYNTHETIC_ENV_MATERIAL = `${SYNTHETIC_CLIENT_ID}:envsec_SYNTHETIC_0003`;
const SYNTHETIC_CONTROL_PLANE_MATERIAL = Object.freeze({
  clientId: SYNTHETIC_CLIENT_ID,
  clientSecret: SYNTHETIC_CLIENT_SECRET,
});
const SYNTHETIC_TOKEN = "tok_SYNTHETIC_0004";
const SYNTHETIC_WEBHOOK_ID = "WH-SYNTHETIC-0005";
const OBSERVED_AT = "2026-10-02T12:00:00.000Z";
const API_BASE = "https://api-m.synthetic.paypal";
const NOW_MS = Number(CLOCK.now());
const NOW_ISO = new Date(NOW_MS).toISOString();

function tokenResponse(
  overrides?: Partial<PayPalTokenProviderObject>,
): PayPalTokenProviderObject {
  return {
    access_token: SYNTHETIC_TOKEN,
    app_id: "APP-SYNTHETIC-0006",
    expires_in: 28_800,
    token_type: "Bearer",
    nonce: "nonce-synthetic",
    scope:
      "https://uri.paypal.com/services/payments/orders https://uri.paypal.com/services/payouts",
    ...overrides,
  };
}

function order(
  status: string,
  overrides?: Partial<PayPalOrderProviderObject>,
): PayPalOrderProviderObject {
  return {
    id: "ORDERID-SYNTHETIC-0001",
    status,
    intent: "CAPTURE",
    purchase_units: [
      {
        reference_id: "default",
        amount: { currency_code: "EUR", value: "10.00" },
      },
    ],
    links: [
      {
        rel: "approve",
        href: "https://www.sandbox.paypal.com/checkoutnow?token=SYNTHETIC",
      },
    ],
    create_time: "2026-10-02T11:00:00Z",
    update_time: "2026-10-02T11:05:00Z",
    ...overrides,
  };
}

function authorization(
  status: string,
  overrides?: Partial<PayPalAuthorizationProviderObject>,
): PayPalAuthorizationProviderObject {
  return {
    id: "AUTH-SYNTHETIC-0002",
    status,
    amount: { currency_code: "EUR", value: "10.00" },
    create_time: "2026-10-02T11:00:00Z",
    update_time: "2026-10-02T11:05:00Z",
    ...overrides,
  };
}

function capture(
  status: string,
  overrides?: Partial<PayPalCaptureProviderObject>,
): PayPalCaptureProviderObject {
  return {
    id: "CAP-SYNTHETIC-0003",
    status,
    amount: { currency_code: "EUR", value: "10.00" },
    final_capture: true,
    seller_payable_breakdown: {
      gross_amount: { currency_code: "EUR", value: "10.00" },
      paypal_fee: { currency_code: "EUR", value: "0.35" },
      net_amount: { currency_code: "EUR", value: "9.65" },
    },
    create_time: "2026-10-02T11:00:00Z",
    update_time: "2026-10-02T11:05:00Z",
    ...overrides,
  };
}

function refund(
  status: string,
  overrides?: Partial<PayPalRefundProviderObject>,
): PayPalRefundProviderObject {
  return {
    id: "REI-SYNTHETIC-0004",
    status,
    amount: { currency_code: "EUR", value: "5.00" },
    note_to_payer: "synthetic refund",
    seller_payable_breakdown: {
      gross_amount: { currency_code: "EUR", value: "5.00" },
      paypal_fee: { currency_code: "EUR", value: "0.10" },
      net_amount: { currency_code: "EUR", value: "4.90" },
    },
    create_time: "2026-10-02T11:10:00Z",
    update_time: "2026-10-02T11:15:00Z",
    ...overrides,
  };
}

function payoutItem(
  status: string,
  overrides?: Partial<PayPalPayoutItemProviderObject>,
): PayPalPayoutItemProviderObject {
  return {
    payout_item_id: "PAYOUTITEM-SYNTHETIC-0007",
    payout_batch_id: "PAYOUTBATCH-SYNTHETIC-0006",
    status,
    amount: { currency_code: "USD", value: "2.34" },
    payout_item_fee: { currency_code: "USD", value: "0.02" },
    recipient_type: "EMAIL",
    receiver: "recipient@synthetic.example",
    sender_item_id: "item-1",
    ...overrides,
  };
}

function payoutBatch(
  batchStatus: string,
  itemStatuses?: readonly string[],
): PayPalPayoutBatchProviderObject {
  return {
    batch_header: {
      payout_batch_id: "PAYOUTBATCH-SYNTHETIC-0006",
      batch_status: batchStatus,
      sender_batch_header: {
        sender_batch_id: "payswap-idem-payout-1",
        email_subject: "You have a payout",
      },
    },
    items: (itemStatuses ?? ["PENDING"]).map((status) => payoutItem(status)),
    links: [],
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

class ScriptedPayPalTransport {
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

function transportFailure(): { status: number; bodyText: string } {
  throw new Error("synthetic transport unreachable");
}

/** A control-plane vault fixture: config key → vault ref → sealed bundle. */
class FixtureVaultStore implements VaultStore {
  readonly storeId = "vault-fixture-paypal-direct";
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
          providerName: "paypal-direct",
          authorizationMode: "SCOPED_API_CREDENTIAL",
          vaultReference: vaultReference(reference),
          issuedAt: "2026-10-02T06:00:00Z",
          accountRef: "PAYPAL_ACCOUNT_SYNTHETIC_0008",
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

const VAULT_REF = "vault://payswap/providers/paypal-direct/test-20261002";

function controlPlaneConnector(
  transport: ScriptedPayPalTransport,
  material: unknown = SYNTHETIC_CONTROL_PLANE_MATERIAL,
): {
  connector: PayPalDirectConnector;
  broker: CredentialBroker;
  runtimeKey: ConnectorRuntimeKey;
  store: FixtureVaultStore;
} {
  const store = new FixtureVaultStore();
  store.bind(PAYPAL_DIRECT_CREDENTIAL_CONFIG_KEY, VAULT_REF);
  store.seal(VAULT_REF, material);
  const broker = new CredentialBroker({ store });
  const runtimeKey = broker.registerConnectorRuntime("runtime.paypal-direct.test");
  const connector = new PayPalDirectConnector({
    clock: CLOCK,
    apiBase: API_BASE,
    http: transport.transport,
    credentials: { broker, runtimeKey },
  });
  return { connector, broker, runtimeKey, store };
}

function envConnector(
  transport: ScriptedPayPalTransport,
  env: NodeJS.ProcessEnv = { [PAYPAL_DIRECT_CREDENTIAL_CONFIG_KEY]: SYNTHETIC_ENV_MATERIAL },
): PayPalDirectConnector {
  return new PayPalDirectConnector({
    clock: CLOCK,
    apiBase: API_BASE,
    http: transport.transport,
    env,
  });
}

/** A routes function answering the token endpoint + a JSON body per URL. */
function defaultRoutes(
  respond: (call: RecordedCall) => { status: number; bodyText: string },
): (call: RecordedCall) => { status: number; bodyText: string } {
  return (call: RecordedCall) => {
    if (call.url === `${API_BASE}/v1/oauth2/token`) {
      return jsonResponse(200, tokenResponse());
    }
    return respond(call);
  };
}

// ---------------------------------------------------------------------------
// Control-plane activation fixtures (the REAL P2-W1-001 machinery)
// ---------------------------------------------------------------------------

const NOW_MINUS_1H = new Date(NOW_MS - 3_600_000).toISOString();
const NOW_MINUS_30M = new Date(NOW_MS - 1_800_000).toISOString();
const NOW_PLUS_1H = new Date(NOW_MS + 3_600_000).toISOString();
const NOW_MINUS_2H = new Date(NOW_MS - 7_200_000).toISOString();

function payoutInstance(): ConnectedCapabilityInstance {
  const instance = {
    instanceId: "inst-paypal-direct-payouts-0001",
    capabilityId: PAYPAL_DIRECT_PAYOUT_CAPABILITY_ID,
    implementationId: "impl.rails.paypal-direct.2.0",
    providerName: PAYPAL_DIRECT_PROVIDER_NAME,
    providerVersion: PAYPAL_DIRECT_API_VERSION,
    accountRef: "PAYPAL_ACCOUNT_SYNTHETIC_0008",
    tenantRef: "tenant_SYNTHETIC_0009",
    authorization: {
      status: "ACTIVE" as const,
      grantedAt: NOW_MINUS_1H,
      authorizationRef: "authorization://paypal-direct/connection-0001",
    },
    credentialScope: {
      credentialRef: VAULT_REF,
      credentialKind: "API_KEY" as const,
    },
    geography: { countries: ["FR", "US"] },
    currencies: ["EUR", "USD"],
    permissionState: {
      granted: ["payouts:write"],
      requested: ["payouts:write"],
      missing: [],
    },
    eligibility: { eligible: true, reasons: [] },
    configuration: {},
  };
  return instance;
}

/** An ACTIVE connection WITHOUT transfer-out authority (the fail-closed default). */
function connectionOnlyActivation(): ConnectedInstanceActivation {
  return activateConnectedInstance({
    instance: payoutInstance(),
    authorizationMode: "SCOPED_API_CREDENTIAL",
    evidence: {
      authorizationState: {
        status: "ACTIVE",
        grantedAt: NOW_MINUS_1H,
        authorizationRef: "authorization://paypal-direct/connection-0001",
      },
      authorizationRef: VAULT_REF,
    },
    activatedAt: NOW_MINUS_30M,
  });
}

/** An ACTIVE connection WITH an explicit EUR/USD transfer-out grant. */
function transferOutGrantedActivation(): ConnectedInstanceActivation {
  const record = connectionOnlyActivation();
  return authorizeTransferOut(record, {
    authorizationRef: "authorization://paypal-direct/payout-consent-0001",
    authorizedAt: NOW_MINUS_1H,
    currencyScope: ["EUR", "USD"],
    maxSingleAmountMinor: 500_000,
    requiresProviderStepUp: false,
  });
}

function payoutItemInput(
  overrides?: {
    readonly currency?: string;
    readonly amountMinor?: string;
    readonly destinationKind?: string;
    readonly recipientType?: string;
    readonly receiver?: string;
    readonly destination?: unknown;
  },
): PayPalDirectPayoutItemInput {
  // An explicit `destination` key (even one holding undefined) is passed
  // through as-is; otherwise partial destination overrides default field by
  // field.
  const hasExplicitDestinationKey = overrides !== undefined && "destination" in overrides;
  const destination = hasExplicitDestinationKey
    ? (overrides?.destination as unknown as PayPalDirectPayoutDestination)
    : ({
        destinationKind: (overrides?.destinationKind ?? "EXTERNAL") as string,
        recipientType: (overrides?.recipientType ?? "EMAIL") as "EMAIL" | "PAYPAL_ID",
        receiver: overrides?.receiver ?? "recipient@synthetic.example",
      } as unknown as PayPalDirectPayoutDestination);
  return {
    amountMinor: overrides?.amountMinor ?? "234",
    currency: overrides?.currency ?? "USD",
    destination,
    senderItemId: "item-1",
  };
}

// ---------------------------------------------------------------------------
// 1. Checkout-order lifecycle mapping — EVERY status (INV-C06)
// ---------------------------------------------------------------------------

describe("paypal-direct connector — checkout-order lifecycle mapping (lossless)", () => {
  const CASES: readonly {
    readonly status: string;
    readonly family: string;
    readonly lifecycleStep: string;
    readonly isTerminal: boolean;
    readonly requiresCustomerAction: boolean;
  }[] = [
    { status: "CREATED", family: "other", lifecycleStep: "CREATED", isTerminal: false, requiresCustomerAction: false },
    { status: "SAVED", family: "other", lifecycleStep: "SAVED", isTerminal: false, requiresCustomerAction: false },
    { status: "APPROVED", family: "capture", lifecycleStep: "APPROVED", isTerminal: false, requiresCustomerAction: false },
    { status: "COMPLETED", family: "other", lifecycleStep: "COMPLETED", isTerminal: true, requiresCustomerAction: false },
    { status: "VOIDED", family: "other", lifecycleStep: "VOIDED", isTerminal: true, requiresCustomerAction: false },
    { status: "PAYER_ACTION_REQUIRED", family: "customer_action_required", lifecycleStep: "PAYER_ACTION_REQUIRED", isTerminal: false, requiresCustomerAction: true },
  ];

  it("the exported status mapping table covers exactly the six v2 order statuses", () => {
    expect(PAYPAL_DIRECT_ORDER_STATUS_MAPPING.map((entry) => entry.providerState)).toEqual(
      CASES.map((entry) => entry.status),
    );
  });

  for (const testCase of CASES) {
    it(`maps '${testCase.status}' → family=${testCase.family} terminal=${testCase.isTerminal} customerAction=${testCase.requiresCustomerAction}`, () => {
      const envelope = paypalOrderEnvelope(order(testCase.status), {
        observedAt: OBSERVED_AT,
        provenanceSource: "PROVIDER_API",
      });
      expect(envelope.classification.family).toBe(testCase.family);
      expect(envelope.classification.lifecycleStep).toBe(testCase.lifecycleStep);
      expect(envelope.classification.isTerminal).toBe(testCase.isTerminal);
      expect(envelope.classification.requiresCustomerAction).toBe(
        testCase.requiresCustomerAction,
      );
      // LOSSLESS: the raw provider object is carried verbatim (INV-C06).
      expect(envelope.state).toEqual(order(testCase.status));
      expect(envelope.object.objectType).toBe("checkout_order");
      expect(envelope.object.externalId).toBe("ORDERID-SYNTHETIC-0001");
      expect(envelope.provider.name).toBe("paypal-direct");
      expect(envelope.provider.version).toBe(PAYPAL_DIRECT_API_VERSION);
      expect(envelope.provenance.source).toBe("PROVIDER_API");
    });
  }

  it("PAYER_ACTION_REQUIRED is a first-class customer action with the provider approve link", () => {
    const providerObject = order("PAYER_ACTION_REQUIRED");
    const envelope = paypalOrderEnvelope(providerObject, {
      observedAt: OBSERVED_AT,
      provenanceSource: "PROVIDER_API",
    });
    expect(envelope.actionRequired?.kind).toBe("COMPLETE_PAYER_ACTION");
    expect(envelope.actionRequired?.deepLink).toBe(
      "https://www.sandbox.paypal.com/checkoutnow?token=SYNTHETIC",
    );
    const requirement = paypalOrderCustomerAction(providerObject);
    expect(requirement?.family).toBe("customer_action_required");
    expect(requirement?.lifecycleStep).toBe("PAYER_ACTION_REQUIRED");
    expect(requirement?.kind).toBe("COMPLETE_PAYER_ACTION");
  });

  it("an order without links produces a PAYER_ACTION_REQUIRED action without a deep link (never invented)", () => {
    const envelope = paypalOrderEnvelope(order("PAYER_ACTION_REQUIRED", { links: [] }), {
      observedAt: OBSERVED_AT,
      provenanceSource: "PROVIDER_API",
    });
    expect(envelope.actionRequired?.deepLink).toBeUndefined();
  });

  it("VOIDED carries definitive no-effect failure metadata while the raw status stays verbatim", () => {
    const envelope = paypalOrderEnvelope(order("VOIDED"), {
      observedAt: OBSERVED_AT,
      provenanceSource: "PROVIDER_API",
    });
    expect(envelope.failure).toEqual({
      providerErrorCode: "order_voided",
      retryable: false,
      ambiguity: "NONE",
    });
    expect((envelope.state as PayPalOrderProviderObject).status).toBe("VOIDED");
  });

  it("an UNKNOWN provider status stays verbatim under the total 'other' family — never dropped, never guessed", () => {
    const envelope = paypalOrderEnvelope(order("BRAND_NEW_STATUS"), {
      observedAt: OBSERVED_AT,
      provenanceSource: "PROVIDER_API",
    });
    expect(envelope.classification.family).toBe("other");
    expect(envelope.classification.lifecycleStep).toBe("BRAND_NEW_STATUS");
    expect(envelope.classification.isTerminal).toBe(false);
    expect(envelope.failure).toBeUndefined();
  });

  it("the revision tracks the order's status and update_time (status revision)", () => {
    const before = paypalOrderEnvelope(order("CREATED"), {
      observedAt: OBSERVED_AT,
      provenanceSource: "PROVIDER_API",
    });
    const after = paypalOrderEnvelope(order("COMPLETED"), {
      observedAt: OBSERVED_AT,
      provenanceSource: "PROVIDER_API",
    });
    expect(before.revision).not.toBe(after.revision);
  });

  it("the envelope round-trips losslessly through JSON (INV-C06 codec)", () => {
    const envelope = paypalOrderEnvelope(order("PAYER_ACTION_REQUIRED"), {
      observedAt: OBSERVED_AT,
      provenanceSource: "PROVIDER_WEBHOOK",
    });
    const roundTripped = parseProviderStateEnvelope(serializeProviderStateEnvelope(envelope));
    expect(roundTripped).toEqual(envelope);
  });
});

// ---------------------------------------------------------------------------
// 2. Authorization / capture / refund mappings (v2 payments)
// ---------------------------------------------------------------------------

describe("paypal-direct connector — authorization, capture and refund mappings", () => {
  it("covers every declared v2 authorization status in the mapping table", () => {
    expect(PAYPAL_DIRECT_AUTHORIZATION_STATUS_MAPPING.length).toBe(7);
    for (const entry of PAYPAL_DIRECT_AUTHORIZATION_STATUS_MAPPING) {
      const envelope = paypalAuthorizationEnvelope(authorization(entry.providerState), {
        observedAt: OBSERVED_AT,
        provenanceSource: "PROVIDER_API",
      });
      expect(envelope.classification.family).toBe(entry.family);
      expect(envelope.classification.lifecycleStep).toBe(entry.lifecycleStep);
      expect(envelope.classification.isTerminal).toBe(entry.isTerminal);
      expect(envelope.state).toEqual(authorization(entry.providerState));
    }
  });

  it("PENDING authorization is async processing; DENIED/EXPIRED/VOIDED are definitive terminal failures", () => {
    const pending = paypalAuthorizationEnvelope(authorization("PENDING"), {
      observedAt: OBSERVED_AT,
      provenanceSource: "PROVIDER_API",
    });
    expect(pending.classification.family).toBe("async_processing");
    expect(pending.classification.isTerminal).toBe(false);
    for (const status of ["DENIED", "EXPIRED", "VOIDED"]) {
      const envelope = paypalAuthorizationEnvelope(authorization(status), {
        observedAt: OBSERVED_AT,
        provenanceSource: "PROVIDER_API",
      });
      expect(envelope.classification.isTerminal).toBe(true);
      expect(required(envelope.failure, `${status} failure`).ambiguity).toBe("NONE");
      expect(required(envelope.failure, `${status} failure`).retryable).toBe(false);
    }
  });

  it("an UNKNOWN authorization status stays verbatim, non-terminal, under 'other'", () => {
    const envelope = paypalAuthorizationEnvelope(authorization("MYSTERY_STATUS"), {
      observedAt: OBSERVED_AT,
      provenanceSource: "PROVIDER_API",
    });
    expect(envelope.classification.family).toBe("other");
    expect(envelope.classification.lifecycleStep).toBe("MYSTERY_STATUS");
    expect(envelope.classification.isTerminal).toBe(false);
  });

  it("covers every declared v2 capture status in the mapping table", () => {
    expect(PAYPAL_DIRECT_CAPTURE_STATUS_MAPPING.length).toBe(6);
    for (const entry of PAYPAL_DIRECT_CAPTURE_STATUS_MAPPING) {
      const envelope = paypalCaptureEnvelope(capture(entry.providerState), {
        observedAt: OBSERVED_AT,
        provenanceSource: "PROVIDER_API",
      });
      expect(envelope.classification.family).toBe(entry.family);
      expect(envelope.classification.lifecycleStep).toBe(entry.lifecycleStep);
      expect(envelope.classification.isTerminal).toBe(entry.isTerminal);
      expect(envelope.state).toEqual(capture(entry.providerState));
    }
  });

  it("the seller-payable-breakdown reconciliation evidence rides the capture state VERBATIM", () => {
    const providerObject = capture("COMPLETED");
    const envelope = paypalCaptureEnvelope(providerObject, {
      observedAt: OBSERVED_AT,
      provenanceSource: "PROVIDER_API",
    });
    expect((envelope.state as PayPalCaptureProviderObject).seller_payable_breakdown).toEqual(
      providerObject.seller_payable_breakdown,
    );
  });

  it("REFUNDED / PARTIALLY_REFUNDED captures map to the refund family (refund-side capture state)", () => {
    const refunded = paypalCaptureEnvelope(capture("REFUNDED"), {
      observedAt: OBSERVED_AT,
      provenanceSource: "PROVIDER_API",
    });
    expect(refunded.classification.family).toBe("refund");
    expect(refunded.classification.isTerminal).toBe(true);
    const partial = paypalCaptureEnvelope(capture("PARTIALLY_REFUNDED"), {
      observedAt: OBSERVED_AT,
      provenanceSource: "PROVIDER_API",
    });
    expect(partial.classification.family).toBe("refund");
    expect(partial.classification.isTerminal).toBe(false);
  });

  it("covers every declared v2 refund status; the breakdown rides verbatim as reconciliation evidence", () => {
    expect(PAYPAL_DIRECT_REFUND_STATUS_MAPPING.length).toBe(4);
    for (const entry of PAYPAL_DIRECT_REFUND_STATUS_MAPPING) {
      const envelope = paypalRefundEnvelope(refund(entry.providerState), {
        observedAt: OBSERVED_AT,
        provenanceSource: "PROVIDER_API",
      });
      expect(envelope.classification.family).toBe("refund");
      expect(envelope.classification.lifecycleStep).toBe(entry.lifecycleStep);
      expect(envelope.classification.isTerminal).toBe(entry.isTerminal);
      expect((envelope.state as PayPalRefundProviderObject).seller_payable_breakdown).toEqual(
        refund(entry.providerState).seller_payable_breakdown,
      );
    }
    const unknownRefund = paypalRefundEnvelope(refund("ODD_REFUND_STATUS"), {
      observedAt: OBSERVED_AT,
      provenanceSource: "PROVIDER_API",
    });
    expect(unknownRefund.classification.family).toBe("refund");
    expect(unknownRefund.classification.lifecycleStep).toBe("ODD_REFUND_STATUS");
    expect(unknownRefund.classification.isTerminal).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Payout batch/item mappings (Payouts API)
// ---------------------------------------------------------------------------

describe("paypal-direct connector — payout batch/item mappings (Payouts API)", () => {
  it("covers every declared payout batch status verbatim", () => {
    expect(PAYPAL_DIRECT_PAYOUT_BATCH_STATUS_MAPPING.length).toBe(6);
    for (const entry of PAYPAL_DIRECT_PAYOUT_BATCH_STATUS_MAPPING) {
      const envelope = paypalPayoutBatchEnvelope(payoutBatch(entry.providerState), {
        observedAt: OBSERVED_AT,
        provenanceSource: "PROVIDER_API",
      });
      expect(envelope.classification.family).toBe("payout");
      expect(envelope.classification.lifecycleStep).toBe(entry.lifecycleStep);
      expect(envelope.classification.isTerminal).toBe(entry.isTerminal);
      // LOSSLESS: the whole raw batch (batch_header + items) rides the state.
      expect(envelope.state).toEqual(payoutBatch(entry.providerState));
    }
  });

  it("covers every declared payout item status verbatim", () => {
    expect(PAYPAL_DIRECT_PAYOUT_ITEM_STATUS_MAPPING.length).toBe(9);
    for (const entry of PAYPAL_DIRECT_PAYOUT_ITEM_STATUS_MAPPING) {
      const envelope = paypalPayoutItemEnvelope(payoutItem(entry.providerState), {
        observedAt: OBSERVED_AT,
        provenanceSource: "PROVIDER_API",
      });
      expect(envelope.classification.family).toBe(entry.family);
      expect(envelope.classification.lifecycleStep).toBe(entry.lifecycleStep);
      expect(envelope.classification.isTerminal).toBe(entry.isTerminal);
      expect(envelope.classification.requiresCustomerAction).toBe(
        entry.requiresCustomerAction,
      );
      expect(envelope.state).toEqual(payoutItem(entry.providerState));
    }
  });

  it("UNCLAIMED is a first-class recipient customer action (the destination is external)", () => {
    const envelope = paypalPayoutItemEnvelope(payoutItem("UNCLAIMED"), {
      observedAt: OBSERVED_AT,
      provenanceSource: "PROVIDER_API",
    });
    expect(envelope.classification.family).toBe("customer_action_required");
    expect(envelope.actionRequired?.kind).toBe("RECIPIENT_CLAIM_REQUIRED");
    expect(envelope.classification.requiresCustomerAction).toBe(true);
  });

  it("REVERSED/REFUNDED payout items map to the refund family, terminal", () => {
    for (const status of ["REVERSED", "REFUNDED"]) {
      const envelope = paypalPayoutItemEnvelope(payoutItem(status), {
        observedAt: OBSERVED_AT,
        provenanceSource: "PROVIDER_API",
      });
      expect(envelope.classification.family).toBe("refund");
      expect(envelope.classification.isTerminal).toBe(true);
    }
  });

  it("item-level fees and statuses ride the batch state VERBATIM (INV-C06)", () => {
    const batch = payoutBatch("PENDING", ["PENDING", "UNCLAIMED"]);
    const envelope = paypalPayoutBatchEnvelope(batch, {
      observedAt: OBSERVED_AT,
      provenanceSource: "PROVIDER_API",
    });
    expect((envelope.state as PayPalPayoutBatchProviderObject).items?.length).toBe(2);
    expect(
      required(
        required((envelope.state as PayPalPayoutBatchProviderObject).items, "items")[1],
        "item[1]",
      ).status,
    ).toBe("UNCLAIMED");
    expect(envelope.object.objectType).toBe("payout_batch");
    expect(envelope.object.externalId).toBe("PAYOUTBATCH-SYNTHETIC-0006");
  });

  it("an UNKNOWN payout item status stays verbatim, non-terminal, under the payout family", () => {
    const envelope = paypalPayoutItemEnvelope(payoutItem("NEW_ITEM_STATE"), {
      observedAt: OBSERVED_AT,
      provenanceSource: "PROVIDER_API",
    });
    expect(envelope.classification.family).toBe("payout");
    expect(envelope.classification.lifecycleStep).toBe("NEW_ITEM_STATE");
    expect(envelope.classification.isTerminal).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Webhook event-type mapping (INV-C06)
// ---------------------------------------------------------------------------

describe("paypal-direct connector — webhook event-type mapping", () => {
  function event(eventType: string, resource: unknown): PayPalWebhookEventObject {
    return {
      id: `WH-SYNTHETIC-EVENT-${eventType.length}`,
      event_type: eventType,
      event_version: "1.0",
      create_time: OBSERVED_AT,
      resource_type: "synthetic",
      resource,
    };
  }

  const context = { observedAt: OBSERVED_AT, provenanceSource: "PROVIDER_WEBHOOK" as const };

  it("CHECKOUT.ORDER.APPROVED maps to the checkout-order envelope (capture family)", () => {
    const envelope = paypalWebhookEventEnvelope(event("CHECKOUT.ORDER.APPROVED", order("APPROVED")), context);
    expect(envelope.object.objectType).toBe("checkout_order");
    expect(envelope.classification.family).toBe("capture");
    expect(envelope.provenance.source).toBe("PROVIDER_WEBHOOK");
  });

  it("PAYMENT.AUTHORIZATION.VOIDED maps to the authorization envelope", () => {
    const envelope = paypalWebhookEventEnvelope(
      event("PAYMENT.AUTHORIZATION.VOIDED", authorization("VOIDED")),
      context,
    );
    expect(envelope.object.objectType).toBe("authorization");
    expect(envelope.classification.isTerminal).toBe(true);
  });

  it("PAYMENT.CAPTURE.COMPLETED maps to the capture envelope; REFUNDED/REVERSED map to the refund envelope", () => {
    const completed = paypalWebhookEventEnvelope(
      event("PAYMENT.CAPTURE.COMPLETED", capture("COMPLETED")),
      context,
    );
    expect(completed.object.objectType).toBe("capture");
    expect(completed.classification.isTerminal).toBe(true);
    const refunded = paypalWebhookEventEnvelope(
      event("PAYMENT.CAPTURE.REFUNDED", refund("COMPLETED")),
      context,
    );
    expect(refunded.object.objectType).toBe("refund");
    expect(refunded.classification.family).toBe("refund");
    const reversed = paypalWebhookEventEnvelope(
      event("PAYMENT.CAPTURE.REVERSED", refund("PENDING")),
      context,
    );
    expect(reversed.object.objectType).toBe("refund");
  });

  it("CUSTOMER.DISPUTE.* maps to a dispute-family envelope with the provider dispute state verbatim", () => {
    const disputeResource = { dispute_id: "PP-DISPUTE-SYNTHETIC", status: "OPEN", amount: "10.00" };
    const envelope = paypalWebhookEventEnvelope(
      event("CUSTOMER.DISPUTE.CREATED", disputeResource),
      context,
    );
    expect(envelope.classification.family).toBe("dispute");
    expect(envelope.classification.lifecycleStep).toBe("OPEN");
    expect(envelope.classification.isTerminal).toBe(false);
    expect(envelope.state).toEqual(disputeResource);
    expect(envelope.object.externalId).toBe("PP-DISPUTE-SYNTHETIC");
  });

  it("PAYMENT.PAYOUTS.* maps to the payout item/batch envelope by resource shape", () => {
    const itemEnvelope = paypalWebhookEventEnvelope(
      event("PAYMENT.PAYOUTS.ITEM.COMPLETED", payoutItem("SUCCESS")),
      context,
    );
    expect(itemEnvelope.object.objectType).toBe("payout_item");
    expect(itemEnvelope.classification.isTerminal).toBe(true);
    const batchEnvelope = paypalWebhookEventEnvelope(
      event("PAYMENT.PAYOUTS.BATCH.COMPLETED", payoutBatch("SUCCESS")),
      context,
    );
    expect(batchEnvelope.object.objectType).toBe("payout_batch");
  });

  it("an UNKNOWN event type carries the WHOLE event verbatim under 'event' — nothing is dropped", () => {
    const unknown = event("SOME.BRAND.NEW.EVENT", { foo: "bar" });
    const envelope = paypalWebhookEventEnvelope(unknown, context);
    expect(envelope.object.objectType).toBe("event");
    expect(envelope.classification.lifecycleStep).toBe("SOME.BRAND.NEW.EVENT");
    expect(envelope.state).toEqual(unknown);
    expect(envelope.classification.isTerminal).toBe(false);
  });

  it("a mapped event type with an unrecognizable resource falls back to the verbatim event envelope", () => {
    const malformed = event("CHECKOUT.ORDER.APPROVED", "not-an-object");
    const envelope = paypalWebhookEventEnvelope(malformed, context);
    expect(envelope.object.objectType).toBe("event");
    expect(envelope.state).toEqual(malformed);
  });

  it("the routing table orders REFUNDED/REVERSED prefixes BEFORE the generic CAPTURE prefix", () => {
    const prefixes = PAYPAL_WEBHOOK_EVENT_TYPE_MAPPING.map((entry) => entry.prefix);
    expect(prefixes.indexOf("PAYMENT.CAPTURE.REFUNDED")).toBeLessThan(
      prefixes.indexOf("PAYMENT.CAPTURE."),
    );
    expect(prefixes.indexOf("PAYMENT.CAPTURE.REVERSED")).toBeLessThan(
      prefixes.indexOf("PAYMENT.CAPTURE."),
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Exact money (INV-F01)
// ---------------------------------------------------------------------------

describe("paypal-direct connector — exact money conversion (INV-F01)", () => {
  it("converts PayPal decimal strings to exact minor units for 2-digit currencies", () => {
    expect(paypalMoneyToMinorUnits({ value: "123.45", currency_code: "USD" })).toEqual({
      currency: "USD",
      minorUnits: "12345",
    });
    expect(paypalMoneyToMinorUnits({ value: "0.99", currency_code: "EUR" })).toEqual({
      currency: "EUR",
      minorUnits: "99",
    });
    expect(paypalMoneyToMinorUnits({ value: "10", currency_code: "GBP" })).toEqual({
      currency: "GBP",
      minorUnits: "1000",
    });
  });

  it("converts 0-digit (JPY) and 3-digit (KWD) currencies exactly", () => {
    expect(paypalMoneyToMinorUnits({ value: "1000", currency_code: "JPY" })).toEqual({
      currency: "JPY",
      minorUnits: "1000",
    });
    expect(paypalMoneyToMinorUnits({ value: "1.234", currency_code: "KWD" })).toEqual({
      currency: "KWD",
      minorUnits: "1234",
    });
  });

  it("converts exact minor units back to PayPal decimal strings with the currency's digits", () => {
    expect(minorUnitsToPayPalValue("12345", "USD")).toBe("123.45");
    expect(minorUnitsToPayPalValue("1000", "JPY")).toBe("1000");
    expect(minorUnitsToPayPalValue("1234", "KWD")).toBe("1.234");
    expect(minorUnitsToPayPalValue("5", "EUR")).toBe("0.05");
  });

  it("round-trips exactly in both directions (no floating point anywhere)", () => {
    for (const [value, currency] of [
      ["19.99", "USD"],
      ["3.500", "KWD"],
      ["12345", "JPY"],
      ["0.01", "EUR"],
    ] as const) {
      const minor = paypalMoneyToMinorUnits({ value, currency_code: currency });
      expect(minorUnitsToPayPalValue(minor.minorUnits, currency)).toBe(value);
    }
  });

  it("refuses a value with more fractional digits than the currency supports (never rounded)", () => {
    expect(() => paypalMoneyToMinorUnits({ value: "1.234", currency_code: "USD" })).toThrow(
      /exactly/,
    );
  });

  it("refuses uncertified currencies in BOTH directions (exactness is never guessed)", () => {
    expect(() => paypalMoneyToMinorUnits({ value: "1.00", currency_code: "XYZ" })).toThrow(
      /not certified/,
    );
    expect(() => minorUnitsToPayPalValue("100", "ZZZ")).toThrow(/not certified/);
  });

  it("refuses malformed money input", () => {
    expect(() => paypalMoneyToMinorUnits({ value: "abc", currency_code: "USD" })).toThrow();
    expect(() => paypalMoneyToMinorUnits({ value: "", currency_code: "USD" })).toThrow();
    expect(() => paypalMoneyToMinorUnits({ value: "1.00" })).toThrow();
    expect(() => minorUnitsToPayPalValue("12.5", "USD")).toThrow(/minor-units string/);
    expect(() => minorUnitsToPayPalValue("-5", "USD")).toThrow(/minor-units string/);
  });

  it("declares the JPY/KWD digit facts and the default 2-digit family in the table", () => {
    expect(PAYPAL_CURRENCY_MINOR_DIGITS["JPY"]).toBe(0);
    expect(PAYPAL_CURRENCY_MINOR_DIGITS["KWD"]).toBe(3);
    expect(PAYPAL_CURRENCY_MINOR_DIGITS["USD"]).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 6. Country eligibility FACTS (never assumed — INV-C05/INV-NC04)
// ---------------------------------------------------------------------------

describe("paypal-direct connector — country eligibility facts (facts only, none held)", () => {
  it("answers UNKNOWN for every country while no connected-instance evidence exists", () => {
    for (const country of ["US", "FR", "DE", "GH"]) {
      const verdict = paypalDirectCountryEligibility(country);
      expect(verdict.eligible).toBe(false);
      expect(verdict.basis).toBe("UNKNOWN");
      expect(verdict.reason).toContain("never assumed");
    }
  });

  it("an evidence-backed connected-instance fact makes exactly that country eligible", () => {
    const fact = {
      country: "US",
      evidenceRef: "evidence:paypal-direct-country-US-0001",
      verifiedAt: OBSERVED_AT,
    };
    expect(paypalDirectCountryEligibility("US", [fact]).eligible).toBe(true);
    expect(paypalDirectCountryEligibility("US", [fact]).basis).toBe("CONNECTED_INSTANCE_FACT");
    expect(paypalDirectCountryEligibility("US", [fact]).evidenceRef).toBe(fact.evidenceRef);
    // Every OTHER country stays UNKNOWN (a fact is not routable coverage).
    expect(paypalDirectCountryEligibility("FR", [fact]).basis).toBe("UNKNOWN");
  });

  it("a fact without an evidence reference is not a fact (fail-closed)", () => {
    const verdict = paypalDirectCountryEligibility("US", [
      { country: "US", evidenceRef: "", verifiedAt: OBSERVED_AT },
    ]);
    expect(verdict.eligible).toBe(false);
    expect(verdict.basis).toBe("UNKNOWN");
  });

  it("the connector carries ZERO country facts (phase-2: no Wave-2 credentials held)", () => {
    // The honest empty default: no probe evidence exists anywhere in this module.
    expect(paypalDirectCountryEligibility("US").basis).toBe("UNKNOWN");
  });
});

// ---------------------------------------------------------------------------
// 7. Observed account capability scope (from the OAuth2 token response)
// ---------------------------------------------------------------------------

describe("paypal-direct connector — observed account capability scope", () => {
  it("derives the OBSERVED granted scopes and app id from the token response", () => {
    const scope = paypalDirectAccountScope(tokenResponse(), OBSERVED_AT);
    expect(scope.appId).toBe("APP-SYNTHETIC-0006");
    expect(scope.observedScopes).toEqual([
      "https://uri.paypal.com/services/payments/orders",
      "https://uri.paypal.com/services/payouts",
    ]);
    expect(scope.tokenType).toBe("Bearer");
    expect(scope.expiresInSeconds).toBe(28_800);
    expect(scope.provenanceSource).toBe("PROVIDER_API");
  });

  it("an absent scope string stays an EMPTY observation, never an assumed one", () => {
    const { scope: _omitScope, ...noScope } = tokenResponse();
    const scope = paypalDirectAccountScope(noScope, OBSERVED_AT);
    expect(scope.observedScopes).toEqual([]);
  });

  it("a token response without access_token is not a scope observation (fail-closed)", () => {
    const { access_token: _omitToken, ...noToken } = tokenResponse();
    expect(() => paypalDirectAccountScope(noToken, OBSERVED_AT)).toThrow(
      /not an account-scope observation/,
    );
  });
});

// ---------------------------------------------------------------------------
// 8. External funds observations (INV-C09 — observations, NEVER custody)
// ---------------------------------------------------------------------------

describe("paypal-direct connector — payout external-funds observations (INV-C09)", () => {
  it("maps payout items to validated ExternalFundsPositionObservations ONLY", () => {
    const observations = paypalPayoutItemObservations({
      batch: payoutBatch("PENDING", ["PENDING", "SUCCESS"]),
      accountRef: "PAYPAL_ACCOUNT_SYNTHETIC_0008",
      observedAt: OBSERVED_AT,
    });
    expect(observations.length).toBe(2);
    for (const observation of observations as readonly ExternalFundsPositionObservation[]) {
      expect(() => validateExternalFundsPositionObservation(observation)).not.toThrow();
      expect(observation.observationKind).toBe("ExternalFundsPositionObservation");
      expect(observation.location.providerName).toBe("paypal-direct");
      expect(observation.location.accountRef).toBe("PAYPAL_ACCOUNT_SYNTHETIC_0008");
      expect(observation.observedAmount.currency).toBe("USD");
      expect(observation.observedAmount.minorUnits).toBe("234");
      expect(observation.provenance.source).toBe("PROVIDER_API");
      expect(observation.reconciliationState).toBe("NOT_RECONCILED");
    }
  });

  it("the observation metadata carries NO recipient address (privacy: minimum data)", () => {
    const observations = paypalPayoutItemObservations({
      batch: payoutBatch("PENDING", ["PENDING"]),
      accountRef: "PAYPAL_ACCOUNT_SYNTHETIC_0008",
      observedAt: OBSERVED_AT,
    });
    const serialized = stringifySafe(observations);
    expect(serialized.includes("recipient@synthetic.example")).toBe(false);
    expect(observations.length).toBe(1);
    expect(
      required(required(observations[0], "observation").location, "location").instrumentRef,
    ).toBe("payout-item:PAYOUTITEM-SYNTHETIC-0007");
  });

  it("an item with an uncertified currency is skipped (an unverifiable amount never becomes a balance)", () => {
    const observations = paypalPayoutItemObservations({
      batch: payoutBatch("PENDING", ["PENDING"]),
      accountRef: "PAYPAL_ACCOUNT_SYNTHETIC_0008",
      observedAt: OBSERVED_AT,
      // The item fixture currency is USD; force an uncertified one:
      ...({} as Record<string, never>),
    });
    const custom: PayPalPayoutBatchProviderObject = {
      batch_header: { payout_batch_id: "B1", batch_status: "PENDING" },
      items: [
        payoutItem("PENDING", { amount: { currency_code: "XYZ", value: "1.00" } }),
        payoutItem("PENDING"),
      ],
    };
    const filtered = paypalPayoutItemObservations({
      batch: custom,
      accountRef: "account",
      observedAt: OBSERVED_AT,
    });
    expect(filtered.length).toBe(1);
    expect(observations.length).toBe(1);
  });

  it("a batch with no items produces zero observations (never a fabricated balance)", () => {
    const observations = paypalPayoutItemObservations({
      batch: { batch_header: { payout_batch_id: "B2", batch_status: "PENDING" } },
      accountRef: "account",
      observedAt: OBSERVED_AT,
    });
    expect(observations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 9. Idempotency derivations (INV-F05)
// ---------------------------------------------------------------------------

describe("paypal-direct connector — idempotency key derivation", () => {
  it("derives the PayPal-Request-Id header deterministically from the protocol key", () => {
    expect(paypalRequestId("idem-123")).toBe("payswap:idem-123");
    expect(paypalRequestId("idem-123")).toBe(paypalRequestId("idem-123"));
    expect(() => paypalRequestId("")).toThrow(/idempotency key/);
  });

  it("derives the payout sender_batch_id deterministically, sanitized to the provider's character class", () => {
    expect(paypalSenderBatchId("idem 123/abc")).toBe("payswap-idem-123-abc");
    expect(paypalSenderBatchId("simple-key")).toBe("payswap-simple-key");
    expect(() => paypalSenderBatchId("")).toThrow(/idempotency key/);
  });
});

// ---------------------------------------------------------------------------
// 10. PayPalWebhookVerifier (the provider-side verification scheme)
// ---------------------------------------------------------------------------

describe("paypal-direct connector — PayPalWebhookVerifier (provider-side verification)", () => {
  function verifier(
    respond: (call: RecordedCall) => { status: number; bodyText: string },
    deps?: { readonly acquireToken?: () => Promise<string> },
  ): { verifier: PayPalWebhookVerifier; transport: ScriptedPayPalTransport } {
    const transport = new ScriptedPayPalTransport(respond);
    const theVerifier = new PayPalWebhookVerifier({
      http: transport.transport,
      apiBase: API_BASE,
      clock: CLOCK,
      webhookId: SYNTHETIC_WEBHOOK_ID,
      acquireToken: deps?.acquireToken ?? (async () => SYNTHETIC_TOKEN),
    });
    return { verifier: theVerifier, transport };
  }

  function delivery(overrides?: Partial<{
    authAlgo: string;
    certUrl: string;
    transmissionId: string;
    transmissionSig: string;
    transmissionTime: string;
    rawPayload: string;
  }>) {
    const payload = JSON.stringify({
      id: "WH-EVENT-SYNTHETIC-0001",
      event_type: "CHECKOUT.ORDER.APPROVED",
      resource: order("APPROVED"),
    });
    return {
      rawPayload: overrides?.rawPayload ?? payload,
      headers: {
        authAlgo: overrides?.authAlgo ?? "SHA256withRSA",
        certUrl: overrides?.certUrl ?? "https://cert.synthetic.paypal/cert",
        transmissionId: overrides?.transmissionId ?? "TRANSMISSION-SYNTHETIC-0001",
        transmissionSig: overrides?.transmissionSig ?? "SYNTHETIC_SIG",
        transmissionTime: overrides?.transmissionTime ?? NOW_ISO,
      },
    };
  }

  it("verifies a well-formed delivery the provider confirms (SUCCESS)", async () => {
    const { verifier: v } = verifier(() => jsonResponse(200, { verification_status: "SUCCESS" }));
    const result = await v.verifyDelivery(delivery());
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.verificationStatus).toBe("SUCCESS");
      expect(result.transmissionId).toBe("TRANSMISSION-SYNTHETIC-0001");
      expect(result.webhookId).toBe(SYNTHETIC_WEBHOOK_ID);
      // Event-type mapping: the verified payload maps to the order envelope.
      expect(result.providerState.object.objectType).toBe("checkout_order");
      expect(result.providerState.classification.family).toBe("capture");
      expect(result.providerState.provenance.source).toBe("PROVIDER_WEBHOOK");
      expect(result.evidence.kind).toBe("WEBHOOK_EVENT");
    }
  });

  it("sends the transmission headers + webhook id + raw event to the provider verify endpoint", async () => {
    const { verifier: v, transport } = verifier(() =>
      jsonResponse(200, { verification_status: "SUCCESS" }),
    );
    await v.verifyDelivery(delivery());
    const verifyCall = transport.calls.find((call) =>
      call.url.endsWith("/v1/notifications/verify-webhook-signature"),
    );
    expect(verifyCall).toBeDefined();
    const body = JSON.parse(required(verifyCall, "verify call").body ?? "{}") as Record<
      string,
      unknown
    >;
    expect(body.transmission_id).toBe("TRANSMISSION-SYNTHETIC-0001");
    expect(body.webhook_id).toBe(SYNTHETIC_WEBHOOK_ID);
    expect(body.webhook_event).toEqual(JSON.parse(delivery().rawPayload));
    expect(required(verifyCall, "verify call").headers.Authorization).toBe(
      `Bearer ${SYNTHETIC_TOKEN}`,
    );
  });

  it("rejects a delivery with missing transmission headers (fail-closed, no provider call)", async () => {
    const { verifier: v, transport } = verifier(() =>
      jsonResponse(200, { verification_status: "SUCCESS" }),
    );
    const base = delivery();
    const headers = { ...base.headers } as { transmissionId?: string };
    delete headers.transmissionId;
    const result = await v.verifyDelivery({ rawPayload: base.rawPayload, headers: headers as typeof base.headers });
    expect(result).toEqual({ valid: false, reason: "MISSING_TRANSMISSION_HEADERS" });
    expect(transport.calls.length).toBe(0);
    expect(headers.transmissionId).toBeUndefined();
  });

  it("rejects a stale transmission time outside the tolerance window", async () => {
    const { verifier: v, transport } = verifier(() =>
      jsonResponse(200, { verification_status: "SUCCESS" }),
    );
    const stale = new Date(NOW_MS - 3_600_000).toISOString();
    const result = await v.verifyDelivery(delivery({ transmissionTime: stale }));
    expect(result).toEqual({ valid: false, reason: "TRANSMISSION_TIME_OUTSIDE_TOLERANCE" });
    expect(transport.calls.length).toBe(0);
  });

  it("rejects an unreasonably FUTURE transmission time", async () => {
    const { verifier: v } = verifier(() => jsonResponse(200, { verification_status: "SUCCESS" }));
    const future = new Date(NOW_MS + 60_000).toISOString();
    const result = await v.verifyDelivery(delivery({ transmissionTime: future }));
    expect(result).toEqual({ valid: false, reason: "FUTURE_TRANSMISSION_TIME" });
  });

  it("rejects a malformed transmission time", async () => {
    const { verifier: v } = verifier(() => jsonResponse(200, { verification_status: "SUCCESS" }));
    const result = await v.verifyDelivery(delivery({ transmissionTime: "not-a-time" }));
    expect(result).toEqual({ valid: false, reason: "MALFORMED_TRANSMISSION_TIME" });
  });

  it("rejects a malformed event payload", async () => {
    const { verifier: v } = verifier(() => jsonResponse(200, { verification_status: "SUCCESS" }));
    const result = await v.verifyDelivery(delivery({ rawPayload: "{not json" }));
    expect(result).toEqual({ valid: false, reason: "MALFORMED_EVENT" });
  });

  it("rejects when the provider answers FAILURE (the provider is the signature authority)", async () => {
    const { verifier: v } = verifier(() => jsonResponse(200, { verification_status: "FAILURE" }));
    const result = await v.verifyDelivery(delivery());
    expect(result).toEqual({ valid: false, reason: "PROVIDER_VERIFICATION_FAILED" });
  });

  it("rejects when the provider answers an HTTP error", async () => {
    const { verifier: v } = verifier(() => jsonResponse(401, { name: "INVALID_TOKEN" }));
    const result = await v.verifyDelivery(delivery());
    expect(result).toEqual({ valid: false, reason: "PROVIDER_VERIFICATION_FAILED" });
  });

  it("rejects when the verification transport is unreachable (never truth without verification)", async () => {
    const { verifier: v } = verifier(() => transportFailure());
    const result = await v.verifyDelivery(delivery());
    expect(result).toEqual({ valid: false, reason: "PROVIDER_TRANSPORT_UNREACHABLE" });
  });

  it("rejects when the credential path itself is unavailable (fail-closed)", async () => {
    const { verifier: v } = verifier(() => jsonResponse(200, { verification_status: "SUCCESS" }), {
      acquireToken: async () => {
        throw new Error("no credential path");
      },
    });
    const result = await v.verifyDelivery(delivery());
    expect(result).toEqual({ valid: false, reason: "PROVIDER_TRANSPORT_UNREACHABLE" });
  });

  it("deduplicates a REPLAYED transmission id (same transmission, second delivery)", async () => {
    const { verifier: v } = verifier(() => jsonResponse(200, { verification_status: "SUCCESS" }));
    const first = await v.verifyDelivery(delivery());
    expect(first.valid).toBe(true);
    const replay = await v.verifyDelivery(delivery());
    expect(replay).toEqual({ valid: false, reason: "REPLAYED_TRANSMISSION" });
    expect(v.verifiedTransmissionIds()).toEqual(["TRANSMISSION-SYNTHETIC-0001"]);
  });

  it("a DIFFERENT transmission id with a fresh event is not a replay", async () => {
    const { verifier: v } = verifier(() => jsonResponse(200, { verification_status: "SUCCESS" }));
    await v.verifyDelivery(delivery());
    const second = await v.verifyDelivery(
      delivery({ transmissionId: "TRANSMISSION-SYNTHETIC-0002" }),
    );
    expect(second.valid).toBe(true);
    expect(v.verifiedTransmissionIds().length).toBe(2);
  });

  it("requires a webhook id and a token acquirer at construction", () => {
    const transport = new ScriptedPayPalTransport(() => jsonResponse(200, {}));
    expect(
      () =>
        new PayPalWebhookVerifier({
          http: transport.transport,
          apiBase: API_BASE,
          clock: CLOCK,
          webhookId: "",
          acquireToken: async () => "t",
        }),
    ).toThrow(/webhook id/);
  });
});

// ---------------------------------------------------------------------------
// 11. Global payout controls — destination law + scoped transfer-out (G9)
// ---------------------------------------------------------------------------

describe("paypal-direct connector — global payout controls (destination + transfer-out)", () => {
  function payoutTransport(
    respond?: (call: RecordedCall) => { status: number; bodyText: string },
  ): ScriptedPayPalTransport {
    const transport = new ScriptedPayPalTransport(
      defaultRoutes(
        respond ??
          (() => jsonResponse(201, payoutBatch("PENDING", ["PENDING"]))),
      ),
    );
    return transport;
  }

  it("a connection WITHOUT transfer-out authority is refused BEFORE any provider call", async () => {
    const transport = payoutTransport();
    const { connector } = controlPlaneConnector(transport);
    await expect(
      connector.submitPayout(
        ctx(AUTHORITY, { kind: "create_payout" }, "idem-payout-1"),
        { items: [payoutItemInput()], transferOut: connectionOnlyActivation() },
      ),
    ).rejects.toThrow(TransferOutNotAuthorizedError);
    // NO provider call happened (not even the token endpoint).
    expect(transport.calls.length).toBe(0);
  });

  it("the SDK create path enforces the same transfer-out law (connection ≠ debit)", async () => {
    const transport = payoutTransport();
    const { connector } = controlPlaneConnector(transport);
    await expect(
      connector.create(
        ctx(
          AUTHORITY,
          {
            kind: "create_payout",
            items: [payoutItemInput()],
            transferOut: connectionOnlyActivation(),
          },
          "idem-payout-2",
        ),
      ),
    ).rejects.toThrow(TransferOutNotAuthorizedError);
    expect(transport.calls.length).toBe(0);
  });

  it("an EXPIRED transfer-out grant is refused (the grant is a scoped, time-bounded authority)", async () => {
    const transport = payoutTransport();
    const { connector } = controlPlaneConnector(transport);
    const expired = authorizeTransferOut(connectionOnlyActivation(), {
      authorizationRef: "authorization://paypal-direct/payout-consent-expired",
      authorizedAt: NOW_MINUS_2H,
      expiresAt: NOW_MINUS_1H,
      currencyScope: ["USD"],
      requiresProviderStepUp: false,
    });
    await expect(
      connector.submitPayout(ctx(AUTHORITY, { kind: "create_payout" }, "idem-payout-3"), {
        items: [payoutItemInput()],
        transferOut: expired,
      }),
    ).rejects.toThrow(TransferOutNotAuthorizedError);
    expect(transport.calls.length).toBe(0);
  });

  it("an out-of-scope currency is refused per item BEFORE any provider call", async () => {
    const transport = payoutTransport();
    const { connector } = controlPlaneConnector(transport);
    await expect(
      connector.submitPayout(ctx(AUTHORITY, { kind: "create_payout" }, "idem-payout-4"), {
        items: [payoutItemInput({ currency: "GHS" })],
        transferOut: transferOutGrantedActivation(),
      }),
    ).rejects.toThrow(/not authorized for currency 'GHS'/);
    expect(transport.calls.length).toBe(0);
  });

  it("an item amount over the per-transfer limit is refused BEFORE any provider call", async () => {
    const transport = payoutTransport();
    const { connector } = controlPlaneConnector(transport);
    await expect(
      connector.submitPayout(ctx(AUTHORITY, { kind: "create_payout" }, "idem-payout-5"), {
        items: [payoutItemInput({ amountMinor: "500001" })],
        transferOut: transferOutGrantedActivation(),
      }),
    ).rejects.toThrow(/per-transfer limit/);
    expect(transport.calls.length).toBe(0);
  });

  it("a NON-EXTERNAL destination is a POLICY_BLOCKED refusal BEFORE the transfer-out gate", async () => {
    const transport = payoutTransport();
    const { connector } = controlPlaneConnector(transport);
    await expect(
      connector.submitPayout(ctx(AUTHORITY, { kind: "create_payout" }, "idem-payout-6"), {
        items: [payoutItemInput({ destinationKind: "INTERNAL" })],
        transferOut: transferOutGrantedActivation(),
      }),
    ).rejects.toThrow(PayPalPayoutDestinationError);
    expect(transport.calls.length).toBe(0);
  });

  it("an unsupported recipient type is a destination refusal (EMAIL/PAYPAL_ID only)", async () => {
    const transport = payoutTransport();
    const { connector } = controlPlaneConnector(transport);
    await expect(
      connector.submitPayout(ctx(AUTHORITY, { kind: "create_payout" }, "idem-payout-7"), {
        items: [payoutItemInput({ recipientType: "PHONE" })],
        transferOut: transferOutGrantedActivation(),
      }),
    ).rejects.toThrow(PayPalPayoutDestinationError);
    expect(transport.calls.length).toBe(0);
  });

  it("an empty receiver is a destination refusal (never an implicit destination)", async () => {
    const transport = payoutTransport();
    const { connector } = controlPlaneConnector(transport);
    await expect(
      connector.submitPayout(ctx(AUTHORITY, { kind: "create_payout" }, "idem-payout-8"), {
        items: [payoutItemInput({ receiver: "" })],
        transferOut: transferOutGrantedActivation(),
      }),
    ).rejects.toThrow(PayPalPayoutDestinationError);
    expect(transport.calls.length).toBe(0);
  });

  it("a missing destination object is a destination refusal", async () => {
    const transport = payoutTransport();
    const { connector } = controlPlaneConnector(transport);
    await expect(
      connector.submitPayout(ctx(AUTHORITY, { kind: "create_payout" }, "idem-payout-9"), {
        items: [payoutItemInput({ destination: undefined })],
        transferOut: transferOutGrantedActivation(),
      }),
    ).rejects.toThrow(PayPalPayoutDestinationError);
    expect(transport.calls.length).toBe(0);
  });

  it("create_payout without the transferOut activation is refused (never a default grant)", async () => {
    const transport = payoutTransport();
    const { connector } = controlPlaneConnector(transport);
    await expect(
      connector.create(
        ctx(
          AUTHORITY,
          { kind: "create_payout", items: [payoutItemInput()] },
          "idem-payout-10",
        ),
      ),
    ).rejects.toThrow(/transferOut ConnectedInstanceActivation/);
    expect(transport.calls.length).toBe(0);
  });

  it("an authorized transfer-out submits the payout with the explicit destination + derived sender_batch_id", async () => {
    const transport = payoutTransport();
    const { connector } = controlPlaneConnector(transport);
    const submission = await connector.submitPayout(
      ctx(AUTHORITY, { kind: "create_payout" }, "idem-payout-11"),
      {
        items: [payoutItemInput()],
        transferOut: transferOutGrantedActivation(),
        emailSubject: "Your payout",
      },
    );
    // The provider call carries the EXPLICIT external destination and the
    // protocol-key-derived sender_batch_id + per-item sender_item_id.
    const payoutCall = transport.calls.find((call) =>
      call.url.endsWith("/v1/payments/payouts"),
    );
    expect(payoutCall).toBeDefined();
    const body = JSON.parse(required(payoutCall, "payout call").body ?? "{}") as Record<
      string,
      unknown
    >;
    expect(body.sender_batch_header).toMatchObject({
      sender_batch_id: "payswap-idem-payout-11",
      email_subject: "Your payout",
    });
    const items = body.items as readonly Record<string, unknown>[];
    expect(items.length).toBe(1);
    expect(items[0]).toMatchObject({
      recipient_type: "EMAIL",
      receiver: "recipient@synthetic.example",
      sender_item_id: "item-1",
    });
    expect(items[0]?.amount).toEqual({ currency_code: "USD", value: "2.34" });
    expect(required(payoutCall, "payout call").headers["PayPal-Request-Id"]).toBe(
      "payswap:idem-payout-11",
    );
    // The result is the lossless payout-batch envelope + item observations.
    expect(submission.result.providerState.object.objectType).toBe("payout_batch");
    expect(submission.result.providerState.classification.family).toBe("payout");
    expect(submission.observations.length).toBe(1);
    expect(submission.observations[0]?.observedAmount).toEqual({
      currency: "USD",
      minorUnits: "234",
    });
  });

  it("a PAYPAL_ID destination rides the provider body with recipient_type PAYPAL_ID", async () => {
    const transport = payoutTransport();
    const { connector } = controlPlaneConnector(transport);
    await connector.submitPayout(ctx(AUTHORITY, { kind: "create_payout" }, "idem-payout-12"), {
      items: [
        payoutItemInput({ recipientType: "PAYPAL_ID", receiver: "PAYERID-SYNTHETIC-0009" }),
      ],
      transferOut: transferOutGrantedActivation(),
    });
    const payoutCall = required(
      transport.calls.find((call) => call.url.endsWith("/v1/payments/payouts")),
      "payout call",
    );
    const items = JSON.parse(payoutCall.body ?? "{}").items as readonly Record<
      string,
      unknown
    >[];
    expect(items[0]).toMatchObject({
      recipient_type: "PAYPAL_ID",
      receiver: "PAYERID-SYNTHETIC-0009",
    });
  });

  it("every item is checked against the grant (a mixed batch fails on the out-of-scope item)", async () => {
    const transport = payoutTransport();
    const { connector } = controlPlaneConnector(transport);
    await expect(
      connector.submitPayout(ctx(AUTHORITY, { kind: "create_payout" }, "idem-payout-13"), {
        items: [payoutItemInput(), payoutItemInput({ currency: "GHS", amountMinor: "100" })],
        transferOut: transferOutGrantedActivation(),
      }),
    ).rejects.toThrow(/not authorized for currency 'GHS'/);
    expect(transport.calls.length).toBe(0);
  });

  it("uncertified currency amounts are refused before the provider call (INV-F01 exactness)", async () => {
    const transport = payoutTransport();
    const { connector } = controlPlaneConnector(transport);
    await expect(
      connector.submitPayout(ctx(AUTHORITY, { kind: "create_payout" }, "idem-payout-14"), {
        items: [payoutItemInput({ currency: "XYZ" })],
        transferOut: transferOutGrantedActivation(),
      }),
    ).rejects.toThrow(/not certified/);
    expect(transport.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 12. Fail-closed credential gating (INV-NC04 — BEFORE any provider call)
// ---------------------------------------------------------------------------

describe("paypal-direct connector — fail-closed credential gating", () => {
  it("no credential path: effectful operations throw RailNotAuthorizedError with ZERO transport calls", async () => {
    const transport = new ScriptedPayPalTransport(() => jsonResponse(200, {}));
    const connector = new PayPalDirectConnector({ clock: CLOCK, apiBase: API_BASE, http: transport.transport });
    await expect(
      connector.create(
        ctx(AUTHORITY, { kind: "create_order", amountMinor: "1000", currency: "EUR", intent: "CAPTURE" }, "idem-1"),
      ),
    ).rejects.toThrow(RailNotAuthorizedError);
    await expect(
      connector.executeAction(
        ctx(AUTHORITY, { kind: "refund_capture", captureId: "CAP-1" }, "idem-2"),
      ),
    ).rejects.toThrow(RailNotAuthorizedError);
    await expect(
      connector.submitPayout(ctx(AUTHORITY, { kind: "create_payout" }, "idem-3"), {
        items: [payoutItemInput()],
        transferOut: transferOutGrantedActivation(),
      }),
    ).rejects.toThrow(RailNotAuthorizedError);
    expect(transport.calls.length).toBe(0);
  });

  it("no credential path: availability is UNKNOWN (INV-C01/C02) and the rail is NOT routable (INV-NC04)", () => {
    const connector = new PayPalDirectConnector({ clock: CLOCK });
    const observation = connector.availabilityObservation({
      instanceId: "inst-paypal-direct-1",
      observationVersion: 1,
    });
    expect(observation.availability).toBe("UNKNOWN");
    expect(observation.sourceAvailability).toBe("UNKNOWN");
    expect(connector.railImplication(observation.availability).routable).toBe(false);
    expect(connector.credentialResolutionState().kind).toBe("NOT_PROVISIONED");
    expect(
      (connector.credentialResolutionState() as { readonly reason: string }).reason,
    ).toContain("INV-NC04");
  });

  it("a control plane whose config key does not resolve is HONESTLY not provisioned", () => {
    const store = new FixtureVaultStore(); // nothing bound
    const broker = new CredentialBroker({ store });
    const runtimeKey = broker.registerConnectorRuntime("runtime.paypal-direct.unbound");
    const connector = new PayPalDirectConnector({
      clock: CLOCK,
      apiBase: API_BASE,
      credentials: { broker, runtimeKey },
    });
    expect(connector.credentialResolutionState().kind).toBe("NOT_PROVISIONED");
  });

  it("an unbindable control plane refuses effectful operations before any provider call", async () => {
    const transport = new ScriptedPayPalTransport(() => jsonResponse(200, {}));
    const store = new FixtureVaultStore();
    const broker = new CredentialBroker({ store });
    const runtimeKey = broker.registerConnectorRuntime("runtime.paypal-direct.unbound-2");
    const connector = new PayPalDirectConnector({
      clock: CLOCK,
      apiBase: API_BASE,
      http: transport.transport,
      credentials: { broker, runtimeKey },
    });
    await expect(
      connector.create(
        ctx(AUTHORITY, { kind: "create_order", amountMinor: "1000", currency: "EUR", intent: "CAPTURE" }, "idem-4"),
      ),
    ).rejects.toThrow(RailNotAuthorizedError);
    expect(transport.calls.length).toBe(0);
  });

  it("a sealed bundle with wrong material shape fails closed (no guessing)", async () => {
    const transport = new ScriptedPayPalTransport(() => jsonResponse(200, tokenResponse()));
    const { connector } = controlPlaneConnector(transport, { notPayPal: true });
    await expect(
      connector.create(
        ctx(AUTHORITY, { kind: "create_order", amountMinor: "1000", currency: "EUR", intent: "CAPTURE" }, "idem-5"),
      ),
    ).rejects.toThrow(/client-credentials material/);
  });

  it("health() without credentials: endpoint reachable → DEGRADED with reasons; unreachable → UNKNOWN", async () => {
    const answered = new ScriptedPayPalTransport(() => jsonResponse(401, { name: "UNAUTHORIZED" }));
    const connectorAnswered = new PayPalDirectConnector({
      clock: CLOCK,
      apiBase: API_BASE,
      http: answered.transport,
    });
    const reportAnswered = await connectorAnswered.health();
    expect(reportAnswered.status).toBe("DEGRADED");
    expect(required(reportAnswered.degradedReasons[0], "reason").includes("INV-C01/C02")).toBe(
      true,
    );
    const unreachable = new ScriptedPayPalTransport(() => transportFailure());
    const connectorUnreachable = new PayPalDirectConnector({
      clock: CLOCK,
      apiBase: API_BASE,
      http: unreachable.transport,
    });
    const reportUnreachable = await connectorUnreachable.health();
    expect(reportUnreachable.status).toBe("UNKNOWN");
  });

  it("health() with credentials: the REAL OAuth2 token acquisition → HEALTHY", async () => {
    const transport = new ScriptedPayPalTransport(
      defaultRoutes(() => jsonResponse(200, {})),
    );
    const { connector } = controlPlaneConnector(transport);
    const report = await connector.health();
    expect(report.status).toBe("HEALTHY");
    expect(report.connectorId).toBe("connector.rails.paypal-direct");
    expect(report.providerName).toBe("paypal-direct");
  });

  it("health() with credentials but a provider auth error → DEGRADED (never a business outcome)", async () => {
    const transport = new ScriptedPayPalTransport(() =>
      jsonResponse(401, { error: "invalid_client", error_description: "synthetic" }),
    );
    const { connector } = controlPlaneConnector(transport);
    const report = await connector.health();
    expect(report.status).toBe("DEGRADED");
  });
});

// ---------------------------------------------------------------------------
// 13. Provider calls (scripted transport, no network)
// ---------------------------------------------------------------------------

describe("paypal-direct connector — provider calls (scripted transport, no network)", () => {
  it("acquires the OAuth2 token ONCE (Basic client credentials) and reuses it while valid", async () => {
    const transport = new ScriptedPayPalTransport(
      defaultRoutes(() => jsonResponse(201, order("CREATED"))),
    );
    const { connector } = controlPlaneConnector(transport);
    await connector.create(
      ctx(AUTHORITY, { kind: "create_order", amountMinor: "1000", currency: "EUR", intent: "CAPTURE" }, "idem-tok-1"),
    );
    await connector.read(
      ctx(AUTHORITY, { kind: "read_order", orderId: "ORDERID-SYNTHETIC-0001" }, "idem-tok-2"),
    );
    const tokenCalls = transport.calls.filter(
      (call) => call.url === `${API_BASE}/v1/oauth2/token`,
    );
    expect(tokenCalls.length).toBe(1);
    // The token call carries the Basic client-credentials header (material
    // exists ONLY inside this provider call).
    expect(required(tokenCalls[0], "token call").headers.Authorization).toBe(
      `Basic ${Buffer.from(`${SYNTHETIC_CLIENT_ID}:${SYNTHETIC_CLIENT_SECRET}`, "utf8").toString("base64")}`,
    );
    // Subsequent provider calls carry the bearer token.
    const readCall = required(
      transport.calls.find((call) => call.url.includes("/v2/checkout/orders/")),
      "read call",
    );
    expect(readCall.headers.Authorization).toBe(`Bearer ${SYNTHETIC_TOKEN}`);
  });

  it("create_order posts the exact-minor-unit amount and maps the answer losslessly", async () => {
    const transport = new ScriptedPayPalTransport(
      defaultRoutes(() => jsonResponse(201, order("CREATED"))),
    );
    const { connector } = controlPlaneConnector(transport);
    const result = await connector.create(
      ctx(
        AUTHORITY,
        {
          kind: "create_order",
          amountMinor: "12345",
          currency: "EUR",
          intent: "AUTHORIZE",
          referenceId: "ref-1",
          description: "synthetic order",
        },
        "idem-create-1",
      ),
    );
    const createCall = required(
      transport.calls.find((call) => call.url.endsWith("/v2/checkout/orders") && call.method === "POST"),
      "create call",
    );
    const body = JSON.parse(createCall.body ?? "{}") as Record<string, unknown>;
    expect(body.intent).toBe("AUTHORIZE");
    expect(body.purchase_units).toEqual([
      {
        amount: { currency_code: "EUR", value: "123.45" },
        reference_id: "ref-1",
        description: "synthetic order",
      },
    ]);
    expect(createCall.headers["PayPal-Request-Id"]).toBe("payswap:idem-create-1");
    expect(result.providerState.object.objectType).toBe("checkout_order");
    expect(result.providerState.classification.lifecycleStep).toBe("CREATED");
    expect(result.providerState.state).toEqual(order("CREATED"));
    expect(result.evidence.kind).toBe("EXECUTION");
    expect(result.outcome.outcome).toBe("ASYNC_PROCESSING");
  });

  it("create_order with an uncertified currency is refused before any provider call", async () => {
    const transport = new ScriptedPayPalTransport(
      defaultRoutes(() => jsonResponse(201, order("CREATED"))),
    );
    const { connector } = controlPlaneConnector(transport);
    await expect(
      connector.create(
        ctx(AUTHORITY, { kind: "create_order", amountMinor: "1000", currency: "ZZZ", intent: "CAPTURE" }, "idem-create-2"),
      ),
    ).rejects.toThrow(/not certified/);
    expect(transport.calls.length).toBe(0);
  });

  it("capture_order and authorize_order POST to the documented subresources and map the answers", async () => {
    const transport = new ScriptedPayPalTransport(
      defaultRoutes((call) =>
        call.url.endsWith("/capture")
          ? jsonResponse(201, order("COMPLETED"))
          : jsonResponse(201, order("APPROVED", { intent: "AUTHORIZE" })),
      ),
    );
    const { connector } = controlPlaneConnector(transport);
    const captured = await connector.update(
      ctx(AUTHORITY, { kind: "capture_order", orderId: "ORDERID-SYNTHETIC-0001" }, "idem-cap-1"),
    );
    expect(captured.providerState.classification.isTerminal).toBe(true);
    expect((captured.providerState.state as PayPalOrderProviderObject).status).toBe("COMPLETED");
    expect(captured.outcome.outcome).toBe("SUCCEEDED");
    const authorized = await connector.update(
      ctx(AUTHORITY, { kind: "authorize_order", orderId: "ORDERID-SYNTHETIC-0001" }, "idem-auth-1"),
    );
    expect(authorized.providerState.classification.family).toBe("capture");
    expect(
      transport.calls.some((call) => call.url.endsWith("/v2/checkout/orders/ORDERID-SYNTHETIC-0001/capture")),
    ).toBe(true);
    expect(
      transport.calls.some((call) => call.url.endsWith("/v2/checkout/orders/ORDERID-SYNTHETIC-0001/authorize")),
    ).toBe(true);
  });

  it("void_authorization honors the provider's documented 204 No Content contract", async () => {
    const transport = new ScriptedPayPalTransport(
      defaultRoutes(() => ({ status: 204, bodyText: "" })),
    );
    const { connector } = controlPlaneConnector(transport);
    const voided = await connector.update(
      ctx(AUTHORITY, { kind: "void_authorization", authorizationId: "AUTH-SYNTHETIC-0002" }, "idem-void-1"),
    );
    expect(voided.providerState.classification.lifecycleStep).toBe("VOIDED");
    expect(voided.providerState.classification.isTerminal).toBe(true);
    expect(required(voided.providerState.failure, "failure").ambiguity).toBe("NONE");
    expect(voided.outcome.outcome).toBe("FAILED"); // definitive no-effect outcome
    expect((voided.providerState.state as Record<string, unknown>).httpStatus).toBe(204);
  });

  it("refund_capture posts the exact refund amount + note and maps the refund answer", async () => {
    const transport = new ScriptedPayPalTransport(
      defaultRoutes(() => jsonResponse(201, refund("COMPLETED"))),
    );
    const { connector } = controlPlaneConnector(transport);
    const result = await connector.executeAction(
      ctx(
        AUTHORITY,
        { kind: "refund_capture", captureId: "CAP-SYNTHETIC-0003", amountMinor: "500", noteToPayer: "sorry" },
        "idem-refund-1",
      ),
    );
    const refundCall = required(
      transport.calls.find((call) => call.url.endsWith("/refund")),
      "refund call",
    );
    const body = JSON.parse(refundCall.body ?? "{}") as Record<string, unknown>;
    expect(body.amount).toEqual({ value: "500" });
    expect(body.note_to_payer).toBe("sorry");
    expect(result.providerState.object.objectType).toBe("refund");
    expect(result.providerState.classification.isTerminal).toBe(true);
    expect(result.outcome.outcome).toBe("SUCCEEDED");
  });

  it("reads map every object family by external id (order/authorization/capture/refund/payout)", async () => {
    const transport = new ScriptedPayPalTransport(
      defaultRoutes((call) => {
        if (call.url.includes("/v2/payments/authorizations/")) {
          return jsonResponse(200, authorization("CREATED"));
        }
        if (call.url.includes("/v2/payments/captures/")) {
          return jsonResponse(200, capture("COMPLETED"));
        }
        if (call.url.includes("/v2/payments/refunds/")) {
          return jsonResponse(200, refund("PENDING"));
        }
        if (call.url.includes("/v1/payments/payouts-item/")) {
          return jsonResponse(200, payoutItem("UNCLAIMED"));
        }
        if (call.url.includes("/v1/payments/payouts/")) {
          return jsonResponse(200, payoutBatch("PROCESSING", ["PENDING"]));
        }
        return jsonResponse(200, order("APPROVED"));
      }),
    );
    const { connector } = controlPlaneConnector(transport);
    const readOrder = await connector.read(
      ctx(AUTHORITY, { kind: "read_order", orderId: "O1" }, "r1"),
    );
    expect(readOrder.providerState.classification.family).toBe("capture");
    const readAuthorization = await connector.read(
      ctx(AUTHORITY, { kind: "read_authorization", authorizationId: "A1" }, "r2"),
    );
    expect(readAuthorization.providerState.object.objectType).toBe("authorization");
    const readCapture = await connector.read(
      ctx(AUTHORITY, { kind: "read_capture", captureId: "C1" }, "r3"),
    );
    expect(readCapture.providerState.object.objectType).toBe("capture");
    const readRefund = await connector.read(
      ctx(AUTHORITY, { kind: "read_refund", refundId: "R1" }, "r4"),
    );
    expect(readRefund.providerState.classification.family).toBe("refund");
    const readBatch = await connector.read(
      ctx(AUTHORITY, { kind: "read_payout_batch", payoutBatchId: "B1" }, "r5"),
    );
    expect(readBatch.providerState.object.objectType).toBe("payout_batch");
    const readItem = await connector.read(
      ctx(AUTHORITY, { kind: "read_payout_item", payoutItemId: "I1" }, "r6"),
    );
    expect(readItem.providerState.classification.family).toBe("customer_action_required");
  });

  it("reconcile_* re-fetches by external id (INV-X03) and returns the same lossless mapping", async () => {
    const transport = new ScriptedPayPalTransport(
      defaultRoutes(() => jsonResponse(200, order("APPROVED"))),
    );
    const { connector } = controlPlaneConnector(transport);
    const reconciled = await connector.reconcile(
      ctx(AUTHORITY, { kind: "reconcile_order", orderId: "ORDERID-SYNTHETIC-0001" }, "rec-1"),
    );
    expect(reconciled.providerState.object.externalId).toBe("ORDERID-SYNTHETIC-0001");
    expect(
      transport.calls.some((call) => call.method === "GET" && call.url.includes("/v2/checkout/orders/ORDERID-SYNTHETIC-0001")),
    ).toBe(true);
  });

  it("the env fallback path acquires the token from the id:secret env material", async () => {
    const transport = new ScriptedPayPalTransport(
      defaultRoutes(() => jsonResponse(201, order("CREATED"))),
    );
    const connector = envConnector(transport);
    const result = await connector.create(
      ctx(AUTHORITY, { kind: "create_order", amountMinor: "1000", currency: "USD", intent: "CAPTURE" }, "idem-env-1"),
    );
    expect(result.providerState.object.objectType).toBe("checkout_order");
    expect(connector.credentialResolutionState().kind).toBe("ENV_RESOLVED_MATERIAL");
  });

  it("accountScope() observes the granted scopes through a live token acquisition", async () => {
    const transport = new ScriptedPayPalTransport(
      defaultRoutes(() => jsonResponse(200, {})),
    );
    const { connector } = controlPlaneConnector(transport);
    const scope = await connector.accountScope();
    expect(scope.appId).toBe("APP-SYNTHETIC-0006");
    expect(scope.observedScopes.length).toBe(2);
    expect(scope.provenanceSource).toBe("PROVIDER_API");
  });

  it("connector.webhookVerifier() is wired to the connector's own credential path", async () => {
    const transport = new ScriptedPayPalTransport(
      defaultRoutes(() => jsonResponse(200, { verification_status: "SUCCESS" })),
    );
    const { connector } = controlPlaneConnector(transport);
    const verifier = connector.webhookVerifier({ webhookId: SYNTHETIC_WEBHOOK_ID });
    const payload = JSON.stringify({
      id: "WH-EVENT-SYNTHETIC-0002",
      event_type: "CHECKOUT.ORDER.COMPLETED",
      resource: order("COMPLETED"),
    });
    const result = await verifier.verifyDelivery({
      rawPayload: payload,
      headers: {
        authAlgo: "SHA256withRSA",
        certUrl: "https://cert.synthetic.paypal/cert",
        transmissionId: "TRANSMISSION-SYNTHETIC-0009",
        transmissionSig: "SIG",
        transmissionTime: NOW_ISO,
      },
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.providerState.classification.isTerminal).toBe(true);
    }
    // The token was acquired through the connector (the token endpoint answered).
    expect(transport.calls.some((call) => call.url.endsWith("/v1/oauth2/token"))).toBe(true);
  });

  it("the credential surface and resolution state expose the control-plane mode", () => {
    const transport = new ScriptedPayPalTransport(
      defaultRoutes(() => jsonResponse(200, {})),
    );
    const { connector } = controlPlaneConnector(transport);
    expect(connector.credentialSurface()).toEqual([
      { envVar: "PROVIDER_PAYPAL_DIRECT_CREDENTIAL_REF", kind: "API_KEY" },
    ]);
    const resolution = connector.credentialResolutionState();
    expect(resolution.kind).toBe("CONTROL_PLANE_SEALED");
    if (resolution.kind === "CONTROL_PLANE_SEALED") {
      expect(resolution.authorizationMode).toBe("SCOPED_API_CREDENTIAL");
    }
    expect(connector.providerIdentity().providerName).toBe("paypal-direct");
    expect(connector.providerIdentity().systemKind).toBe("psp");
  });
});

// ---------------------------------------------------------------------------
// 14. Idempotency behavior (INV-F05 — duplicates are never silent success)
// ---------------------------------------------------------------------------

describe("paypal-direct connector — idempotency behavior", () => {
  it("the same protocol key with a DIFFERENT body is a local conflict (error state, no provider call)", async () => {
    const transport = new ScriptedPayPalTransport(
      defaultRoutes(() => jsonResponse(201, order("CREATED"))),
    );
    const { connector } = controlPlaneConnector(transport);
    await connector.create(
      ctx(AUTHORITY, { kind: "create_order", amountMinor: "1000", currency: "EUR", intent: "CAPTURE" }, "idem-conflict-1"),
    );
    await expect(
      connector.create(
        ctx(AUTHORITY, { kind: "create_order", amountMinor: "2000", currency: "EUR", intent: "CAPTURE" }, "idem-conflict-1"),
      ),
    ).rejects.toThrow(PayPalIdempotencyConflictError);
    // Only the FIRST submission reached the provider.
    const orderPosts = transport.calls.filter(
      (call) => call.method === "POST" && call.url.endsWith("/v2/checkout/orders"),
    );
    expect(orderPosts.length).toBe(1);
  });

  it("the same protocol key with the SAME body is resubmitted (the provider stays the authority)", async () => {
    const transport = new ScriptedPayPalTransport(
      defaultRoutes(() => jsonResponse(201, order("CREATED"))),
    );
    const { connector } = controlPlaneConnector(transport);
    await connector.create(
      ctx(AUTHORITY, { kind: "create_order", amountMinor: "1000", currency: "EUR", intent: "CAPTURE" }, "idem-same-1"),
    );
    const second = await connector.create(
      ctx(AUTHORITY, { kind: "create_order", amountMinor: "1000", currency: "EUR", intent: "CAPTURE" }, "idem-same-1"),
    );
    expect(second.providerState.object.objectType).toBe("checkout_order");
    const orderPosts = transport.calls.filter(
      (call) => call.method === "POST" && call.url.endsWith("/v2/checkout/orders"),
    );
    expect(orderPosts.length).toBe(2);
  });

  it("a provider DUPLICATE_REQUEST answer maps to the duplicate ERROR state", async () => {
    const transport = new ScriptedPayPalTransport(
      defaultRoutes(() =>
        jsonResponse(400, {
          name: "DUPLICATE_REQUEST",
          message: "synthetic duplicate",
          debug_id: "synthetic-debug",
        }),
      ),
    );
    const { connector } = controlPlaneConnector(transport);
    await expect(
      connector.create(
        ctx(AUTHORITY, { kind: "create_order", amountMinor: "1000", currency: "EUR", intent: "CAPTURE" }, "idem-dup-1"),
      ),
    ).rejects.toThrow(PayPalDuplicateSubmitError);
  });

  it("a duplicate sender_batch_id answer on payouts maps to the duplicate ERROR state", async () => {
    const transport = new ScriptedPayPalTransport(
      defaultRoutes(() =>
        jsonResponse(400, {
          name: "VALIDATION_ERROR",
          message: "duplicate sender batch id",
          debug_id: "synthetic-debug-2",
        }),
      ),
    );
    const { connector } = controlPlaneConnector(transport);
    await expect(
      connector.submitPayout(ctx(AUTHORITY, { kind: "create_payout" }, "idem-dup-2"), {
        items: [payoutItemInput()],
        transferOut: transferOutGrantedActivation(),
      }),
    ).rejects.toThrow(PayPalDuplicateSubmitError);
  });

  it("a provider error answer maps to RailProviderError with the provider name preserved", async () => {
    const transport = new ScriptedPayPalTransport(
      defaultRoutes(() =>
        jsonResponse(400, {
          name: "INVALID_REQUEST",
          message: "synthetic invalid",
          debug_id: "synthetic-debug-3",
        }),
      ),
    );
    const { connector } = controlPlaneConnector(transport);
    const promise = connector.create(
      ctx(AUTHORITY, { kind: "create_order", amountMinor: "1000", currency: "EUR", intent: "CAPTURE" }, "idem-err-1"),
    );
    await expect(promise).rejects.toThrow(RailProviderError);
    await promise.catch((error: RailProviderError) => {
      expect(error.details?.providerErrorName).toBe("INVALID_REQUEST");
    });
  });
});

// ---------------------------------------------------------------------------
// 15. UNKNOWN never collapses to FAILED (INV-X01)
// ---------------------------------------------------------------------------

describe("paypal-direct connector — UNKNOWN never collapses to FAILED (INV-X01)", () => {
  it("a transport failure mid-capture is OUTCOME_UNKNOWN (requires reconciliation)", async () => {
    const transport = new ScriptedPayPalTransport(
      defaultRoutes(() => transportFailure()),
    );
    const { connector } = controlPlaneConnector(transport);
    const result = await connector.update(
      ctx(AUTHORITY, { kind: "capture_order", orderId: "ORDERID-SYNTHETIC-0001" }, "idem-x1"),
    );
    expect(result.providerState.classification.lifecycleStep).toBe("outcome_unknown");
    expect(required(result.providerState.failure, "failure").ambiguity).toBe("OUTCOME_UNKNOWN");
    expect(required(result.providerState.failure, "failure").retryable).toBe(true);
    expect(result.outcome.outcome).toBe("OUTCOME_UNKNOWN");
    if (result.outcome.outcome === "OUTCOME_UNKNOWN") {
      expect(result.outcome.requiresReconciliation).toBe(true);
    }
  });

  it("a transport failure mid-refund is OUTCOME_UNKNOWN, never FAILED", async () => {
    const transport = new ScriptedPayPalTransport(
      defaultRoutes(() => transportFailure()),
    );
    const { connector } = controlPlaneConnector(transport);
    const result = await connector.executeAction(
      ctx(AUTHORITY, { kind: "refund_capture", captureId: "CAP-SYNTHETIC-0003" }, "idem-x2"),
    );
    expect(result.outcome.outcome).toBe("OUTCOME_UNKNOWN");
  });

  it("a transport failure mid-payout-submission is OUTCOME_UNKNOWN with ZERO fabricated observations", async () => {
    const transport = new ScriptedPayPalTransport(
      defaultRoutes(() => transportFailure()),
    );
    const { connector } = controlPlaneConnector(transport);
    const submission = await connector.submitPayout(
      ctx(AUTHORITY, { kind: "create_payout" }, "idem-x3"),
      { items: [payoutItemInput()], transferOut: transferOutGrantedActivation() },
    );
    expect(submission.result.outcome.outcome).toBe("OUTCOME_UNKNOWN");
    expect(submission.observations).toEqual([]);
  });

  it("a transport failure mid-create-order is OUTCOME_UNKNOWN (the effect MAY have landed)", async () => {
    const transport = new ScriptedPayPalTransport(
      defaultRoutes(() => transportFailure()),
    );
    const { connector } = controlPlaneConnector(transport);
    const result = await connector.create(
      ctx(AUTHORITY, { kind: "create_order", amountMinor: "1000", currency: "EUR", intent: "CAPTURE" }, "idem-x4"),
    );
    expect(result.outcome.outcome).toBe("OUTCOME_UNKNOWN");
  });
});

// ---------------------------------------------------------------------------
// 16. Secret hygiene (no credential material in ANY product)
// ---------------------------------------------------------------------------

describe("paypal-direct connector — secret hygiene (no credential material anywhere)", () => {
  it("sdk results, evidence and observations never contain the client secret, id or token", async () => {
    const transport = new ScriptedPayPalTransport(
      defaultRoutes((call) =>
        call.url.endsWith("/v1/payments/payouts")
          ? jsonResponse(201, payoutBatch("PENDING", ["PENDING", "UNCLAIMED"]))
          : jsonResponse(201, order("CREATED")),
      ),
    );
    const { connector } = controlPlaneConnector(transport);
    const orderResult = await connector.create(
      ctx(AUTHORITY, { kind: "create_order", amountMinor: "1000", currency: "EUR", intent: "CAPTURE" }, "idem-sec-1"),
    );
    const submission = await connector.submitPayout(
      ctx(AUTHORITY, { kind: "create_payout" }, "idem-sec-2"),
      { items: [payoutItemInput()], transferOut: transferOutGrantedActivation() },
    );
    const serialized =
      stringifySafe(orderResult) +
      stringifySafe(submission.result) +
      stringifySafe(submission.observations);
    expect(serialized.includes(SYNTHETIC_CLIENT_SECRET)).toBe(false);
    expect(serialized.includes(SYNTHETIC_CLIENT_ID)).toBe(false);
    expect(serialized.includes(SYNTHETIC_TOKEN)).toBe(false);
    expect(serialized.includes("clientId")).toBe(false);
    expect(serialized.includes("clientSecret")).toBe(false);
    expect(serialized.includes("access_token")).toBe(false);
  });

  it("extractPayPalCredentialMaterial refuses shapes that are not client credentials", () => {
    expect(() => extractPayPalCredentialMaterial({ apiKey: "x" })).toThrow(
      /client-credentials material/,
    );
    expect(() => extractPayPalCredentialMaterial("no-separator")).toThrow(
      /clientId:clientSecret/,
    );
    expect(() => extractPayPalCredentialMaterial(42)).toThrow();
    expect(
      extractPayPalCredentialMaterial({ client_id: "a", client_secret: "b" }),
    ).toEqual({ clientId: "a", clientSecret: "b" });
    expect(extractPayPalCredentialMaterial("id:secret")).toEqual({
      clientId: "id",
      clientSecret: "secret",
    });
  });
});

// ---------------------------------------------------------------------------
// 17. Adapter, pack, definitions and rotation surface
// ---------------------------------------------------------------------------

describe("paypal-direct connector — adapter, pack and definitions surface", () => {
  it("five canonical capability definitions validate (W2-003 vocabulary consumed)", () => {
    const definitions = paypalDirectCapabilityDefinitionsForTest();
    expect(definitions.length).toBe(5);
    const ids = definitions.map((definition) => definition.capabilityId);
    expect(new Set(ids).size).toBe(5);
    expect(ids).toContain(PAYPAL_DIRECT_CHECKOUT_ORDER_CAPABILITY_ID);
    expect(ids).toContain(PAYPAL_DIRECT_PAYOUT_CAPABILITY_ID);
  });

  it("the payout capability declares the transfer-out scopes and provider-defined duplicates", () => {
    const definitions = paypalDirectCapabilityDefinitionsForTest();
    const payout = required(
      definitions.find((definition) => definition.capabilityId === PAYPAL_DIRECT_PAYOUT_CAPABILITY_ID),
      "payout definition",
    );
    expect(payout.authorization.requiredScopes).toContain("transfer_out:execute");
    expect(payout.idempotency.duplicateBehavior).toBe("PROVIDER_DEFINED");
    expect(payout.idempotency.retryPolicy).toBe("REQUIRES_RECONCILIATION");
    expect(payout.compensation.partialExecution.granularity).toBe("LINE_ITEM");
    expect(payout.requiredCustomerActions.length).toBe(1);
  });

  it("the rail adapter serves preconditions, authorization and source-of-truth from the consumed definitions", () => {
    const rail = new PayPalDirectProductionRail();
    expect(rail.adapterId).toBe("rail.paypal-direct");
    expect(rail.implementationId).toBe("impl.rails.paypal-direct.2.0");
    expect(rail.capabilityPack().packId).toBe("pack.rails.paypal-direct");
    expect(
      rail.describePreconditions(PAYPAL_DIRECT_CHECKOUT_ORDER_CAPABILITY_ID).length,
    ).toBeGreaterThan(0);
    const payoutPreconditions = rail.describePreconditions(PAYPAL_DIRECT_PAYOUT_CAPABILITY_ID);
    expect(payoutPreconditions.some((precondition) => precondition.includes("transfer-out"))).toBe(
      true,
    );
    expect(
      rail.authorizationRequirements(PAYPAL_DIRECT_CHECKOUT_ORDER_CAPABILITY_ID)
        .protocolAuthorization,
    ).toBe(true);
    expect(rail.sourceOfTruthPolicy("checkout_order")).toBe("EXTERNAL_AUTHORITATIVE");
    expect(rail.sourceOfTruthPolicy("payout_item")).toBe("EXTERNAL_AUTHORITATIVE");
    expect(() => rail.authorizationRequirements("cap.unknown")).toThrow();
  });

  it("the pack tree carries the payouts family as an independently versioned sub-pack", () => {
    const rail = new PayPalDirectProductionRail();
    const pack = rail.capabilityPack();
    const payoutsSubPack = pack.subPacks.find((sub) => sub.family === "payouts");
    expect(payoutsSubPack).toBeDefined();
    expect(required(payoutsSubPack, "payouts sub-pack").packId).toBe(
      "pack.rails.paypal-direct.payouts",
    );
    expect(required(payoutsSubPack, "payouts sub-pack").capabilityRefs.length).toBe(1);
  });

  it("the connector declares both supported authorization modes", () => {
    expect(PAYPAL_DIRECT_AUTHORIZATION_MODES).toEqual([
      "SCOPED_API_CREDENTIAL",
      "CONNECTED_ACCOUNT",
    ]);
  });

  it("rotateCredentials (control plane): baseline-first, then swap-reference-then-verify", async () => {
    const transport = new ScriptedPayPalTransport(
      defaultRoutes(() => jsonResponse(200, {})),
    );
    const { connector, store } = controlPlaneConnector(transport);
    const rotateCtx = ctx(AUTHORITY, { kind: "credential_rotation" }, "rot-1");
    // First use records the baseline and refuses.
    await expect(connector.rotateCredentials(rotateCtx)).rejects.toThrow(/baseline recorded/);
    // Unchanged reference refuses.
    await expect(connector.rotateCredentials(rotateCtx)).rejects.toThrow(/NEW vault reference/);
    // Swap the vault binding to a fresh reference.
    const newRef = "vault://payswap/providers/paypal-direct/rotated-20261002";
    store.bind(PAYPAL_DIRECT_CREDENTIAL_CONFIG_KEY, newRef);
    store.seal(newRef, SYNTHETIC_CONTROL_PLANE_MATERIAL);
    const rotation = await connector.rotateCredentials(rotateCtx);
    expect(rotation.newCredentialRef).toBe(newRef);
    expect(rotation.evidence.kind).toBe("AUDIT_LOG");
    expect(stringifySafe(rotation).includes(SYNTHETIC_CLIENT_SECRET)).toBe(false);
  });

  it("rotateCredentials (env path): fingerprint baseline, then new material", async () => {
    const env: NodeJS.ProcessEnv = {
      [PAYPAL_DIRECT_CREDENTIAL_CONFIG_KEY]: SYNTHETIC_ENV_MATERIAL,
    };
    const transport = new ScriptedPayPalTransport(
      defaultRoutes(() => jsonResponse(200, {})),
    );
    const connector = new PayPalDirectConnector({
      clock: CLOCK,
      apiBase: API_BASE,
      http: transport.transport,
      env,
    });
    const rotateCtx = ctx(AUTHORITY, { kind: "credential_rotation" }, "rot-2");
    await expect(connector.rotateCredentials(rotateCtx)).rejects.toThrow(/baseline recorded/);
    await expect(connector.rotateCredentials(rotateCtx)).rejects.toThrow(/NEW provisioned/);
    env[PAYPAL_DIRECT_CREDENTIAL_CONFIG_KEY] = `${SYNTHETIC_CLIENT_ID}:envsec_ROTATED_0004`;
    const rotation = await connector.rotateCredentials(rotateCtx);
    expect(rotation.newCredentialRef).toBe(`env:${PAYPAL_DIRECT_CREDENTIAL_CONFIG_KEY}`);
    expect(stringifySafe(rotation).includes("envsec")).toBe(false);
  });

  it("rotateCredentials without any credential path fails closed", async () => {
    const connector = new PayPalDirectConnector({ clock: CLOCK });
    await expect(
      connector.rotateCredentials(ctx(AUTHORITY, { kind: "credential_rotation" }, "rot-3")),
    ).rejects.toThrow(RailNotAuthorizedError);
  });

  it("search/subscribe/disconnect refuse honestly (surface limits documented, not faked)", async () => {
    const transport = new ScriptedPayPalTransport(defaultRoutes(() => jsonResponse(200, {})));
    const { connector } = controlPlaneConnector(transport);
    await expect(connector.search(ctx(AUTHORITY, {}, "s1"))).rejects.toThrow(/no search\/list/);
    await expect(connector.subscribe(ctx(AUTHORITY, {}, "s2"))).rejects.toThrow(/webhook/);
    await expect(connector.disconnect(ctx(AUTHORITY, {}, "s3"))).rejects.toThrow(
      /connector-registry lifecycle/,
    );
  });
});

// ---------------------------------------------------------------------------
// 18. Independence from Stripe PayPal + shared-surface rows
// ---------------------------------------------------------------------------

describe("paypal-direct connector — independent representation from Stripe PayPal", () => {
  it("the provider identity is paypal-direct, distinct from the stripe provider", () => {
    expect(PAYPAL_DIRECT_PROVIDER_NAME).toBe("paypal-direct");
    expect(PAYPAL_DIRECT_PROVIDER_NAME).not.toBe("stripe");
    expect(PAYPAL_DIRECT_CREDENTIAL_CONFIG_KEY).toBe(
      "PROVIDER_PAYPAL_DIRECT_CREDENTIAL_REF",
    );
    expect(PAYPAL_DIRECT_CREDENTIAL_CONFIG_KEY).not.toBe("PROVIDER_STRIPE_CREDENTIAL_REF");
  });

  it("the Stripe PayPal-on-Stripe datum explicitly distinguishes PayPal Direct", () => {
    expect(STRIPE_PAYPAL_ON_STRIPE_ELIGIBILITY.distinctFrom).toBe("paypal_direct");
    expect(STRIPE_PAYPAL_ON_STRIPE_ELIGIBILITY.note).toContain("paypal-direct");
  });

  it("the capability vocabularies never overlap between the two providers", () => {
    const paypalIds = paypalDirectCapabilityDefinitionsForTest().map(
      (definition) => definition.capabilityId,
    );
    for (const id of paypalIds) {
      expect(id.startsWith("cap.rails.paypal-direct.")).toBe(true);
      expect(id).not.toBe(STRIPE_PAYPAL_ON_STRIPE_CAPABILITY_ID);
    }
  });

  it("the credential registry declares the paypal-direct control-plane row", () => {
    const row = RAIL_CREDENTIAL_ENV_VARS.find(
      (declaration) => declaration.envVar === "PROVIDER_PAYPAL_DIRECT_CREDENTIAL_REF",
    );
    expect(row).toBeDefined();
    expect(required(row, "row").railId).toBe("rail.paypal-direct");
    expect(required(row, "row").kind).toBe("OAUTH");
    expect(required(row, "row").description).toContain("CredentialBroker");
  });

  it("the registry still carries every pre-existing row (additive-only edit)", () => {
    for (const envVar of [
      "PAYSWAP_RAILS_FIAT_SECRET_REF",
      "PROVIDER_STRIPE_CREDENTIAL_REF",
      "PROVIDER_MTN_MOMO_CREDENTIAL_REF",
      "PROVIDER_FLUTTERWAVE_CREDENTIAL_REF",
      "PROVIDER_PAYSTACK_CREDENTIAL_REF",
    ]) {
      expect(RAIL_CREDENTIAL_ENV_VARS.some((declaration) => declaration.envVar === envVar)).toBe(
        true,
      );
    }
  });
});



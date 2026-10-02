import { describe, expect, it } from "vitest";
import { validateExternalFundsPositionObservation } from "@payswap/connectors";
import type { ExternalFundsPositionObservation } from "@payswap/connectors";
import { CredentialBroker, SealedCredentialBundle, vaultReference } from "@payswap/adapters";
import type { ProtocolClock, TimestampMs } from "@payswap/protocol";
import {
  StripeConnector,
  StripeWebhookVerifier,
  createStripeWebhookIngestor,
  stripeSignWebhookPayload,
  stripeWebhookEventEnvelope,
  stripeWebhookRawEvent,
  verifyStripeWebhookDelivery,
} from "../../src/stripe.js";
import { ctx as makeCtx, makeAdapterAuthority } from "../fixtures.js";

/**
 * LIVE credential-gated Stripe suite (P2-W2-001). Run explicitly:
 * `source /home/z/.secrets/env.sh && npx vitest run --config vitest.live.config.ts`
 * — NEVER part of the default deterministic battery.
 *
 * Gated on the PROVIDER_STRIPE_CREDENTIAL_REF-shaped credential surface: the
 * control-plane config key itself (when the session injects the resolved key
 * material under it) or the operator vault session variable holding the
 * Stripe secret key. Absent both → every case SKIPS cleanly (no network, no
 * credentials, no fabricated outcome). The key material is sealed into the
 * P2-W1-001 control plane (CredentialBroker + ConnectorRuntimeKey) exactly
 * as production would consume it, and NEVER appears in any assertion output,
 * log line or committed file.
 *
 * Financial-effect policy: the only effectful cases run against Stripe TEST
 * MODE (livemode: false) — a create+cancel pair that never confirms a
 * payment, so no value moves anywhere. Everything else is read-only
 * observation (account scope, balance, health).
 */

/** A live wall clock (test-file only; src stays deterministic). */
const LIVE_CLOCK: ProtocolClock = {
  now: (): TimestampMs => BigInt(Date.now()),
  monotonic: (() => {
    let last = 0n;
    return (): bigint => {
      const current = BigInt(Date.now());
      last = current > last ? current : last + 1n;
      return last;
    };
  })(),
};

/** BigInt-safe serialization for the sanitized secret scan. */
function stringifySafe(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    typeof inner === "bigint" ? inner.toString() : inner,
  ) ?? "";
}

/** Sealed key material for the live run, or undefined when not provisioned. */
function liveKeyMaterial(): string | undefined {
  const direct = process.env["PROVIDER_STRIPE_CREDENTIAL_REF"];
  if (typeof direct === "string" && direct.length > 0 && !direct.startsWith("vault://")) {
    return direct;
  }
  const session = process.env["STRIPE_SECRET_KEY"];
  return typeof session === "string" && session.length > 0 ? session : undefined;
}

/** Webhook signing secret from the vault, when the session holds it. */
function liveWebhookSecret(): string | undefined {
  const secret = process.env["STRIPE_WEBHOOK_SECRET"];
  return typeof secret === "string" && secret.length > 0 ? secret : undefined;
}

const MATERIAL = liveKeyMaterial();
const gatedIt = MATERIAL !== undefined ? it : it.skip;

function liveControlPlaneConnector(): StripeConnector {
  const reference = "vault://payswap/providers/stripe/test-20261002";
  const store = {
    storeId: "vault-live-stripe",
    bindings: new Map<string, string>([["PROVIDER_STRIPE_CREDENTIAL_REF", reference]]),
    bundles: new Map<string, SealedCredentialBundle>(),
    resolve(url: string): SealedCredentialBundle | undefined {
      return this.bundles.get(url);
    },
    referenceBoundTo(configKey: string): string | undefined {
      return this.bindings.get(configKey);
    },
  };
  store.bundles.set(
    reference,
    new SealedCredentialBundle(
      {
        providerName: "stripe",
        authorizationMode: "SCOPED_API_CREDENTIAL",
        vaultReference: vaultReference(reference),
        issuedAt: "2026-10-02T06:37:38Z",
        accountRef: "acct_1FPs7UAkPdhgtN6I",
      },
      MATERIAL,
    ),
  );
  const broker = new CredentialBroker({ store });
  const runtimeKey = broker.registerConnectorRuntime("runtime.stripe.live");
  return new StripeConnector({
    clock: LIVE_CLOCK,
    credentials: { broker, runtimeKey },
    timeoutMs: 20_000,
  });
}

// Run-scoped nonce: live tests are the explicitly non-deterministic suite; unique
// per-run idempotency keys keep Stripe's replay semantics testable WITHIN a run
// while making the create+cancel cycle repeatable ACROSS runs.
const RUN_NONCE = `p2w2-${Date.now().toString(36)}`;

const AUTHORITY = makeAdapterAuthority();

describe("stripe production connector — LIVE credential-gated probes (test mode)", () => {
  gatedIt("health(): the REAL authenticated probe (GET /v1/account) answers HEALTHY", async () => {
    const connector = liveControlPlaneConnector();
    const report = await connector.health();
    expect(report.status).toBe("HEALTHY");
    expect(report.connectorId).toBe("connector.rails.stripe");
    // SANITIZED FACT: provider version is the pinned API version.
    expect(report.providerVersion).toBe("2025-08-27.basil");
  });

  gatedIt("accountScope(): the live account capability scope is OBSERVED, not assumed", async () => {
    const connector = liveControlPlaneConnector();
    const scope = await connector.accountScope();
    // SANITIZED FACTS (no key material, no secrets):
    expect(scope.accountId).toBe("acct_1FPs7UAkPdhgtN6I");
    expect(scope.country).toBe("FR");
    expect(scope.businessType).toBe("sole_prop");
    expect(scope.chargesEnabled).toBe(true);
    expect(scope.livemode).toBe(false); // TEST MODE — no real money can move
    expect(scope.capabilities["card_payments"]).toBe("active");
    expect(scope.capabilities["transfers"]).toBe("active");
    expect(scope.capabilities["cartes_bancaires_payments"]).toBe("pending");
    expect(scope.capabilities["sepa_debit_payments"]).toBe("inactive");
    expect(scope.provenanceSource).toBe("PROVIDER_API");
  });

  gatedIt("observeExternalFunds(): /v1/balance → validated observations ONLY (never custody)", async () => {
    const connector = liveControlPlaneConnector();
    const observations = await connector.observeExternalFunds();
    expect(observations.length).toBeGreaterThan(0);
    for (const observation of observations as readonly ExternalFundsPositionObservation[]) {
      expect(() => validateExternalFundsPositionObservation(observation)).not.toThrow();
      expect(observation.location.providerName).toBe("stripe");
      expect(observation.location.accountRef).toBe("acct_1FPs7UAkPdhgtN6I");
      expect(observation.observationKind).toBe("ExternalFundsPositionObservation");
      expect(/^[A-Z]{3}$/.test(observation.observedAmount.currency)).toBe(true);
      expect(/^-?\d+$/.test(observation.observedAmount.minorUnits)).toBe(true); // exact integer minor units
    }
    // SANITIZED FACT: the funded currencies observed 2026-10-02 are present.
    const currencies = observations.map(
      (observation: ExternalFundsPositionObservation) => observation.observedAmount.currency,
    );
    expect(currencies).toContain("EUR");
    expect(currencies).toContain("USD");
  });

  gatedIt(
    "create + cancel a test PaymentIntent (100 eur): the REAL lifecycle, lossless end-to-end",
    async () => {
      const connector = liveControlPlaneConnector();
      // 1. Create (unconfirmed) — the REAL provider lifecycle, losslessly
      //    observed from the first byte of the provider's own answer.
      const created = await connector.create(
        makeCtx(AUTHORITY, { kind: "create_intent", amountMinor: "100", currency: "eur" }, `${RUN_NONCE}-create-1`),
      );
      expect(created.providerState.object.objectType).toBe("payment_intent");
      const intentId = created.providerState.object.externalId;
      expect(intentId.startsWith("pi_")).toBe(true);
      // A fresh unconfirmed intent with no payment method attached starts in
      // requires_payment_method (documented Stripe semantics) — mapped to the
      // total 'other' family, non-terminal, status VERBATIM.
      expect(created.providerState.classification.family).toBe("other");
      expect(created.providerState.classification.lifecycleStep).toBe("requires_payment_method");
      expect(created.providerState.classification.isTerminal).toBe(false);
      const createdStatus = (created.providerState.state as { status: string }).status;
      expect(createdStatus).toBe("requires_payment_method");

      // 2. Duplicate submit with the SAME idempotency key and body: Stripe
      //    replays the original — the SAME external object, never a second one.
      const replayed = await connector.create(
        makeCtx(AUTHORITY, { kind: "create_intent", amountMinor: "100", currency: "eur" }, `${RUN_NONCE}-create-1`),
      );
      expect(replayed.providerState.object.externalId).toBe(intentId);
      expect(replayed.providerState.state).toEqual(created.providerState.state);

      // 3. Reconciliation re-fetch by external id (INV-X03): the same object,
      //    losslessly observed a second time.
      const refetched = await connector.reconcile(
        makeCtx(AUTHORITY, { kind: "reconcile_intent", intentId }, `${RUN_NONCE}-read-1`),
      );
      expect(refetched.providerState.object.externalId).toBe(intentId);
      expect(refetched.providerState.classification.family).toBe("other");
      expect(refetched.providerState.classification.lifecycleStep).toBe("requires_payment_method");

      // 4. Cancel — a definitive terminal outcome with the raw status
      //    preserved verbatim. Never confirmed → no value ever moved.
      const canceled = await connector.executeAction(
        makeCtx(AUTHORITY, { kind: "cancel_intent", intentId }, `${RUN_NONCE}-cancel-1`),
      );
      expect(canceled.providerState.object.externalId).toBe(intentId);
      expect(canceled.providerState.classification.isTerminal).toBe(true);
      expect((canceled.providerState.state as { status: string }).status).toBe("canceled");
      expect(canceled.providerState.failure?.ambiguity).toBe("NONE");
      expect(canceled.outcome.outcome).toBe("FAILED"); // definitive no-effect outcome (retryable: false)
      // The revision advanced with the status change (status revision).
      expect(canceled.providerState.revision).not.toBe(created.providerState.revision);

      // SANITIZED FACTS for the record: pi_* external id + lifecycle classes.
      expect(typeof intentId).toBe("string");
    },
  );

  gatedIt("availabilityObservation with a live probe → AVAILABLE → routable (INV-NC04 satisfied)", async () => {
    const connector = liveControlPlaneConnector();
    const health = await connector.health();
    const observation = connector.availabilityObservation({
      instanceId: "inst-rails-stripe-live-1",
      observationVersion: 1,
      probe: { reachable: health.status === "HEALTHY", checkedAt: health.lastCheckedAt },
    });
    expect(observation.availability).toBe("AVAILABLE");
    expect(connector.railImplication(observation.availability).routable).toBe(true);
  });

  gatedIt(
    "webhook verification self-test with the vault secret material (scheme-level proof)",
    async () => {
      const secret = liveWebhookSecret();
      if (secret === undefined) {
        // No webhook secret material in this session: the self-test is
        // honestly absent (the registered-endpoint precondition remains
        // recorded in BLOCKED-RAILS.md).
        return;
      }
      // A locally-constructed event signed under the REAL vault secret: this
      // proves the Stripe-Signature scheme implementation handles the real
      // secret's material. It does NOT prove a live delivery — no webhook
      // endpoint is registered at Stripe yet (the honest precondition
      // recorded in BLOCKED-RAILS.md).
      const payload = {
        id: `evt_live_selftest_${LIVE_CLOCK.now()}`,
        type: "payment_intent.succeeded",
        data: { object: { id: "pi_selftest", status: "succeeded", amount: 100, currency: "eur" } },
      };
      const rawPayload = JSON.stringify(payload);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const header = `t=${timestamp},v1=${stripeSignWebhookPayload(secret, timestamp, rawPayload)}`;
      expect(
        verifyStripeWebhookDelivery(
          { signatureHeader: header, rawPayload },
          { secret, nowMs: Date.now() },
        ),
      ).toEqual({ valid: true, timestamp });
      // Byte-level tampering is rejected.
      expect(
        verifyStripeWebhookDelivery(
          { signatureHeader: header, rawPayload: `${rawPayload} ` },
          { secret, nowMs: Date.now() },
        ),
      ).toEqual({ valid: false, reason: "SIGNATURE_INVALID" });
      // The ingestor accepts and dedupes on the provider event id.
      const ingestor = createStripeWebhookIngestor({ secret, clock: LIVE_CLOCK });
      const raw = stripeWebhookRawEvent({ eventId: payload.id, payload, signatureHeader: header });
      if (raw === undefined) {
        throw new Error("stripeWebhookRawEvent returned undefined for the self-test delivery");
      }
      const envelope = stripeWebhookEventEnvelope(payload, {
        observedAt: new Date().toISOString(),
        provenanceSource: "PROVIDER_WEBHOOK",
      });
      const first = ingestor.ingest(raw, { providerState: envelope });
      expect(first.kind).toBe("INGESTED");
      expect(ingestor.ingest(raw)).toEqual({
        kind: "ALREADY_INGESTED",
        providerName: "stripe",
        eventId: payload.id,
      });
      // The adapters-hook verifier agrees.
      expect(
        new StripeWebhookVerifier(secret).verify(raw, rawPayload),
      ).toEqual({ valid: true });
      // SANITIZED: the secret never appears in any product.
      expect(stringifySafe(first).includes("whsec_")).toBe(false);
    },
  );

  it("skips cleanly when the credential surface is not provisioned (no network, no outcome)", () => {
    if (MATERIAL !== undefined) {
      return;
    }
    const connector = new StripeConnector({ clock: LIVE_CLOCK }); // no credential path
    const observation = connector.availabilityObservation({
      instanceId: "inst-rails-stripe-live-skip",
      observationVersion: 1,
    });
    expect(observation.availability).toBe("UNKNOWN"); // INV-C01/C02
    expect(connector.railImplication(observation.availability).routable).toBe(false); // INV-NC04
  });
});

import { describe, expect, it } from "vitest";
import { CredentialBroker, SealedCredentialBundle, vaultReference } from "@payswap/adapters";
import type { ProtocolClock, TimestampMs } from "@payswap/protocol";
import { PayPalDirectConnector } from "../../src/paypal-direct.js";
import { ctx as makeCtx, makeAdapterAuthority } from "../fixtures.js";

/**
 * LIVE credential-gated PayPal Direct suite (P2-W1-002). Run explicitly:
 * `source /home/z/.secrets/env.sh && npx vitest run --config vitest.live.config.ts`
 * — NEVER part of the default deterministic battery.
 *
 * Gated on the PROVIDER_PAYPAL_DIRECT_CREDENTIAL_REF-shaped credential
 * surface: the control-plane config key itself (when the session injects
 * the resolved "clientId:clientSecret" material under it) or the operator
 * session variables holding the PayPal REST app credentials. Absent all →
 * every case SKIPS cleanly (no network, no credentials, no fabricated
 * outcome). Per the phase-2 fail-closed law, NO PayPal credential is
 * currently held ("no Wave-2 credentials held") — this suite documents the
 * lift path and proves the skip-clean behavior until one is provisioned.
 * The material is sealed into the P2-W1-001 control plane (CredentialBroker
 * + ConnectorRuntimeKey) exactly as production would consume it, and NEVER
 * appears in any assertion output, log line or committed file.
 *
 * Financial-effect policy: the only effectful case runs against the
 * provider's sandbox environment on a checkout order that is NEVER approved
 * — no payer interacts with it, so no value moves anywhere. Everything else
 * is read-only observation (token/account scope, health, availability).
 * Payout submission is deliberately NOT exercised live: it is
 * transfer-out-scoped and this session holds no live transfer-out grant
 * (connection scope alone never authorizes debit — the P2-W1-001
 * control-plane gate refuses before any provider call).
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

/** The live API base (sandbox by default — the connector's default base is live). */
function liveApiBase(): string {
  return process.env["PAYPAL_API_BASE"] ?? "https://api-m.sandbox.paypal.com";
}

/**
 * Sealed client-credentials material for the live run, or undefined when
 * not provisioned. Accepted shapes: the "clientId:clientSecret" pair under
 * the control-plane config key, or PAYPAL_CLIENT_ID + PAYPAL_CLIENT_SECRET.
 */
function liveCredentialMaterial(): string | undefined {
  const direct = process.env["PROVIDER_PAYPAL_DIRECT_CREDENTIAL_REF"];
  if (typeof direct === "string" && direct.length > 0 && !direct.startsWith("vault://")) {
    return direct;
  }
  const clientId = process.env["PAYPAL_CLIENT_ID"];
  const clientSecret = process.env["PAYPAL_CLIENT_SECRET"];
  if (
    typeof clientId === "string" &&
    clientId.length > 0 &&
    typeof clientSecret === "string" &&
    clientSecret.length > 0
  ) {
    return `${clientId}:${clientSecret}`;
  }
  return undefined;
}

const MATERIAL = liveCredentialMaterial();
const gatedIt = MATERIAL !== undefined ? it : it.skip;

function liveControlPlaneConnector(): PayPalDirectConnector {
  const reference = "vault://payswap/providers/paypal-direct/test-20261002";
  const store = {
    storeId: "vault-live-paypal-direct",
    bindings: new Map<string, string>([["PROVIDER_PAYPAL_DIRECT_CREDENTIAL_REF", reference]]),
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
        providerName: "paypal-direct",
        authorizationMode: "SCOPED_API_CREDENTIAL",
        vaultReference: vaultReference(reference),
        issuedAt: "2026-10-02T06:00:00Z",
      },
      MATERIAL,
    ),
  );
  const broker = new CredentialBroker({ store });
  const runtimeKey = broker.registerConnectorRuntime("runtime.paypal-direct.live");
  return new PayPalDirectConnector({
    clock: LIVE_CLOCK,
    apiBase: liveApiBase(),
    credentials: { broker, runtimeKey },
    timeoutMs: 20_000,
  });
}

// Run-scoped nonce: live tests are the explicitly non-deterministic suite.
const RUN_NONCE = `p2w1002-${Date.now().toString(36)}`;

const AUTHORITY = makeAdapterAuthority();

describe("paypal-direct production connector — LIVE credential-gated probes (fail-closed: no credential held)", () => {
  gatedIt("health(): the REAL OAuth2 client-credentials token acquisition answers HEALTHY", async () => {
    const connector = liveControlPlaneConnector();
    const report = await connector.health();
    expect(report.status).toBe("HEALTHY");
    expect(report.connectorId).toBe("connector.rails.paypal-direct");
    expect(report.providerName).toBe("paypal-direct");
    // SANITIZED FACT: provider version is the pinned REST surface version.
    expect(report.providerVersion).toBe("2.0");
  });

  gatedIt("accountScope(): the granted OAuth scopes are OBSERVED, not assumed", async () => {
    const connector = liveControlPlaneConnector();
    const scope = await connector.accountScope();
    // SANITIZED FACTS (no key material, no secrets): the token response's
    // app id and the ACTUAL granted scope string, observed verbatim.
    expect(scope.appId.startsWith("APP-")).toBe(true);
    expect(scope.observedScopes.length).toBeGreaterThan(0);
    expect(scope.tokenType).toBe("Bearer");
    expect(scope.expiresInSeconds).toBeGreaterThan(0);
    expect(scope.provenanceSource).toBe("PROVIDER_API");
  });

  gatedIt(
    "create + read a test checkout order (never approved): the REAL lifecycle, lossless end-to-end",
    async () => {
      const connector = liveControlPlaneConnector();
      // 1. Create (never confirmed/approved — no payer interacts with it) —
      //    the REAL provider lifecycle, losslessly observed from the
      //    provider's own answer.
      const created = await connector.create(
        makeCtx(
          AUTHORITY,
          { kind: "create_order", amountMinor: "100", currency: "EUR", intent: "CAPTURE" },
          `${RUN_NONCE}-create-1`,
        ),
      );
      expect(created.providerState.object.objectType).toBe("checkout_order");
      const orderId = created.providerState.object.externalId;
      expect(typeof orderId === "string" && orderId.length > 0).toBe(true);
      // A freshly created order the payer never touched is CREATED —
      // mapped to the total 'other' family, non-terminal, status VERBATIM.
      expect(created.providerState.classification.family).toBe("other");
      expect(created.providerState.classification.lifecycleStep).toBe("CREATED");
      expect(created.providerState.classification.isTerminal).toBe(false);
      const createdStatus = (created.providerState.state as { status?: string }).status;
      expect(createdStatus).toBe("CREATED");

      // 2. Reconciliation re-fetch by external id (INV-X03): the same
      //    object, losslessly observed a second time.
      const refetched = await connector.reconcile(
        makeCtx(AUTHORITY, { kind: "reconcile_order", orderId }, `${RUN_NONCE}-read-1`),
      );
      expect(refetched.providerState.object.externalId).toBe(orderId);
      expect(refetched.providerState.classification.lifecycleStep).toBe("CREATED");
      // SANITIZED FACT for the record: external id + lifecycle class.
      expect(typeof orderId).toBe("string");
    },
  );

  gatedIt("availabilityObservation with a live probe → AVAILABLE → routable (INV-NC04 satisfied)", async () => {
    const connector = liveControlPlaneConnector();
    const health = await connector.health();
    const observation = connector.availabilityObservation({
      instanceId: "inst-paypal-direct-live-1",
      observationVersion: 1,
      probe: { reachable: health.status === "HEALTHY", checkedAt: health.lastCheckedAt },
    });
    expect(observation.availability).toBe("AVAILABLE");
    expect(connector.railImplication(observation.availability).routable).toBe(true);
  });

  gatedIt(
    "a read of an unknown external object id is the provider's honest error (never a fabricated state)",
    async () => {
      const connector = liveControlPlaneConnector();
      // Payout submission is deliberately NOT exercised live (transfer-out
      // is separately scoped and this session holds no live grant). This
      // read-only probe proves the failure path stays honest: an unknown
      // payout-item id is the provider's own error, never a made-up state.
      await expect(
        connector.read(
          makeCtx(
            AUTHORITY,
            { kind: "read_payout_item", payoutItemId: `NONEXISTENT-${RUN_NONCE}` },
            `${RUN_NONCE}-payout-1`,
          ),
        ),
      ).rejects.toThrow();
    },
  );

  it("skips cleanly when the credential surface is not provisioned (no network, no outcome)", () => {
    if (MATERIAL !== undefined) {
      return;
    }
    const connector = new PayPalDirectConnector({ clock: LIVE_CLOCK }); // no credential path
    const observation = connector.availabilityObservation({
      instanceId: "inst-paypal-direct-live-skip",
      observationVersion: 1,
    });
    expect(observation.availability).toBe("UNKNOWN"); // INV-C01/C02
    expect(connector.railImplication(observation.availability).routable).toBe(false); // INV-NC04
    expect(connector.credentialResolutionState().kind).toBe("NOT_PROVISIONED");
  });

  it("the live suite gates on the PAYPAL_DIRECT credential surface and discloses the lift path", () => {
    // Honest disclosure: this run holds NO PayPal credential (phase-2
    // fail-closed law), so the gated cases above skip. The lift path is
    // BLOCKED-RAILS.md §6: provision PROVIDER_PAYPAL_DIRECT_CREDENTIAL_REF
    // through the vault, then re-run this suite.
    if (MATERIAL === undefined) {
      expect(liveCredentialMaterial()).toBeUndefined();
    } else {
      expect(typeof MATERIAL).toBe("string");
    }
  });
});

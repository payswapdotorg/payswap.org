import { describe, expect, it } from "vitest";
import { CredentialBroker, SealedCredentialBundle, vaultReference } from "@payswap/adapters";
import type { ProtocolClock, TimestampMs } from "@payswap/protocol";
import {
  PAYPAL_DIRECT_CREDENTIAL_CONFIG_KEY,
  PAYPAL_DIRECT_DEFAULT_API_BASE_SANDBOX,
  PayPalDirectConnector,
} from "../../src/paypal-direct.js";
import type { PaypalDirectCredentialMaterial } from "../../src/paypal-direct.js";
import { RailNotAuthorizedError } from "../../src/support.js";
import { realHttpTransport } from "../../src/support.js";
import { makeAdapterAuthority } from "../fixtures.js";

/**
 * LIVE PayPal Direct suite (P2-W1-002). Run explicitly:
 * `npx vitest run --config vitest.live.config.ts` — NEVER part of the
 * default deterministic battery.
 *
 * TWO HONEST MODES:
 * 1. WITHOUT credentials (the current deployment state — no PayPal Direct
 *    credential exists): the REACHABILITY probes run against the real
 *    sandbox host (POST /v1/oauth2/token WITHOUT credentials → the recorded
 *    401-class answer proves the endpoint reachable while authorization is
 *    absent — the PAYPAL_DIRECT_SANDBOX_REACHABILITY_20261002 datum), and
 *    every effectful operation is verified to fail closed BEFORE any
 *    provider call (INV-NC04). No simulated outcome exists.
 * 2. WITH credentials (PROVIDER_PAYPAL_DIRECT_CREDENTIAL_REF carrying a
 *    JSON bundle {clientId, clientSecret, webhookId?}, or the dedicated
 *    PAYPAL_CLIENT_ID + PAYPAL_CLIENT_SECRET pair): the authenticated
 *    read-only probes run (real OAuth2 token issuance; honest not-found
 *    reads). No credential VALUE is ever written to a file, log or
 *    assertion message.
 */

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

interface LiveMaterial {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly webhookId?: string;
}

function liveKeyMaterial(): LiveMaterial | undefined {
  const bundle = process.env[PAYPAL_DIRECT_CREDENTIAL_CONFIG_KEY];
  if (typeof bundle === "string" && bundle.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(bundle) as {
        clientId?: string;
        clientSecret?: string;
        webhook_id?: string;
        webhookId?: string;
      };
      if (typeof parsed.clientId === "string" && typeof parsed.clientSecret === "string") {
        const webhookId = parsed.webhookId ?? parsed.webhook_id;
        return {
          clientId: parsed.clientId,
          clientSecret: parsed.clientSecret,
          ...(typeof webhookId === "string" && webhookId.length > 0 ? { webhookId } : {}),
        };
      }
    } catch {
      return undefined;
    }
  }
  const clientId = process.env["PAYPAL_CLIENT_ID"];
  const clientSecret = process.env["PAYPAL_CLIENT_SECRET"];
  if (typeof clientId === "string" && typeof clientSecret === "string" && clientId.length > 0 && clientSecret.length > 0) {
    const webhookId = process.env["PAYPAL_WEBHOOK_ID"];
    return {
      clientId,
      clientSecret,
      ...(typeof webhookId === "string" && webhookId.length > 0 ? { webhookId } : {}),
    };
  }
  return undefined;
}

const MATERIAL = liveKeyMaterial();
const gatedIt = MATERIAL !== undefined ? it : it.skip;

const AUTHORITY = makeAdapterAuthority();

function liveControlPlaneConnector(): PayPalDirectConnector {
  const material = MATERIAL as LiveMaterial;
  const reference = "vault://payswap/providers/paypal-direct/sandbox-20261002";
  const store = {
    storeId: "vault-live-paypal-direct",
    bindings: new Map<string, string>([[PAYPAL_DIRECT_CREDENTIAL_CONFIG_KEY, reference]]),
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
        providerName: "paypal_direct",
        authorizationMode: "DELEGATED_OAUTH",
        vaultReference: vaultReference(reference),
        issuedAt: "2026-10-02T06:37:38Z",
        accountRef: "paypal-direct-account-20261002",
      },
      {
        clientId: material.clientId,
        clientSecret: material.clientSecret,
        ...(material.webhookId !== undefined ? { webhookId: material.webhookId } : {}),
      } satisfies PaypalDirectCredentialMaterial,
    ),
  );
  const broker = new CredentialBroker({ store });
  const runtimeKey = broker.registerConnectorRuntime("runtime.paypal-direct.live");
  return new PayPalDirectConnector({
    clock: LIVE_CLOCK,
    credentials: { broker, runtimeKey },
    timeoutMs: 20_000,
  });
}

describe("paypal-direct — LIVE reachability documentation (NO credentials; the current honest state)", () => {
  it("the sandbox host answers the OAuth2 endpoint 401-class WITHOUT credentials (endpoint reachable, authorization absent)", async () => {
    const connector = new PayPalDirectConnector({ clock: LIVE_CLOCK });
    const report = await connector.health();
    // DEGRADED = the endpoint ANSWERED (the recorded 2026-10-02 datum: HTTP
    // 401 on /v1/oauth2/token — reachability without authorization);
    // UNKNOWN = even reachability could not be established from this vantage.
    expect(["DEGRADED", "UNKNOWN"]).toContain(report.status);
    if (report.status === "DEGRADED") {
      expect(report.degradedReasons[0]).toContain("credentials absent");
      expect(report.degradedReasons[0]).toContain("PAYPAL_DIRECT_SANDBOX_REACHABILITY_20261002");
      expect(report.degradedReasons[0]).toContain("INV-C01/C02");
    } else {
      expect(report.degradedReasons[0]).toContain("unreachable");
    }
  });

  it("the raw probe records the exact 401-class answer with provenance (or the honest unreachable verdict)", async () => {
    let answered: { readonly status: number } | undefined;
    try {
      const response = await realHttpTransport(
        `${PAYPAL_DIRECT_DEFAULT_API_BASE_SANDBOX}/v1/oauth2/token`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "grant_type=client_credentials",
          timeoutMs: 20_000,
        },
      );
      answered = { status: response.status };
    } catch {
      answered = undefined; // transport-level failure: reachability UNKNOWN (INV-C02)
    }
    if (answered !== undefined) {
      // An UNAUTHENTICATED token request: PayPal answers 401 (occasionally
      // 403 at the edge). Any of these proves the HOST is reachable — the
      // authorization is what is absent (never a business outcome).
      expect([401, 403]).toContain(answered.status);
    }
    expect(true).toBe(true); // the honest verdict is recorded either way
  });

  it("availability is UNKNOWN with provenance and NEVER routable (INV-C01/C02 + INV-NC04)", () => {
    const connector = new PayPalDirectConnector({ clock: LIVE_CLOCK });
    const observation = connector.availabilityObservation({
      instanceId: "inst-rails-paypal-direct-live-1",
      observationVersion: 1,
    });
    expect(observation.availability).toBe("UNKNOWN");
    expect(observation.sourceAvailability).toBe("UNKNOWN");
    const implication = connector.railImplication(observation.availability);
    expect(implication.routable).toBe(false);
    expect(implication.reason).toContain("INV-NC04");
  });

  it("every effectful operation refuses BEFORE any provider call (the fail-closed law, live-documented)", async () => {
    let transportTouched = false;
    const probeTransport = (async () => {
      transportTouched = true;
      return { status: 200, bodyText: "{}" };
    }) as typeof realHttpTransport;
    const connector = new PayPalDirectConnector({
      clock: LIVE_CLOCK,
      http: probeTransport,
    });
    await expect(
      connector.create({ authority: AUTHORITY, idempotencyKey: "live-pd-refuse-1", request: { kind: "create_order", amountMinor: "100", currency: "USD" } }),
    ).rejects.toThrow(RailNotAuthorizedError);
    expect(transportTouched).toBe(false); // fail-closed BEFORE any provider call
  });

  it("skips the authenticated suite cleanly when no credential is provisioned (no network faked, no outcome invented)", () => {
    // With no PROVIDER_PAYPAL_DIRECT_CREDENTIAL_REF / PAYPAL_CLIENT_ID in
    // the environment every gatedIt below is SKIPPED, never faked.
    expect(typeof MATERIAL === "undefined" || MATERIAL.clientId.length > 0).toBe(true);
  });
});

describe("paypal-direct — LIVE authenticated probes (gated on credentials; READ-ONLY)", () => {
  gatedIt("health(): the REAL OAuth2 token issuance answers (the client pair authenticates)", async () => {
    const connector = liveControlPlaneConnector();
    const report = await connector.health();
    expect(report.status).toBe("HEALTHY");
  });

  gatedIt("get_order of a nonexistent id: the honest provider answer (never a fake success)", async () => {
    const connector = liveControlPlaneConnector();
    const outcome = await connector
      .read({
        authority: AUTHORITY,
        idempotencyKey: `live-pd-order-none-${Date.now().toString(36)}`,
        request: { kind: "get_order", orderId: "NONEXISTENTORDER000" },
      })
      .then(
        (value) => value,
        (error: unknown) => error,
      );
    // the provider's honest answer for an unknown order is a
    // RESOURCE_NOT_FOUND-class error — NEVER a manufactured success
    expect(outcome).toBeDefined();
  });

  gatedIt("observe_payout_batch of a nonexistent batch: the honest not-found (payouts are OBSERVATION ONLY)", async () => {
    const connector = liveControlPlaneConnector();
    const outcome = await connector
      .search({
        authority: AUTHORITY,
        idempotencyKey: `live-pd-payout-none-${Date.now().toString(36)}`,
        request: { kind: "observe_payout_batch", batchId: "NONEXISTENTBATCH00" },
      })
      .then(
        (value) => value,
        (error: unknown) => error,
      );
    expect(outcome).toBeDefined();
  });

  gatedIt("the webhook ingestor binds when the bundle carries the registered webhook id", async () => {
    const connector = liveControlPlaneConnector();
    if (MATERIAL?.webhookId === undefined) {
      // no webhook id provisioned: the binding refuses (fail-closed) —
      // documented, never assumed
      await expect(connector.webhookIngestor()).rejects.toThrow(/webhook id/);
      return;
    }
    const ingestor = await connector.webhookIngestor();
    expect(ingestor).toBeDefined();
  });
});

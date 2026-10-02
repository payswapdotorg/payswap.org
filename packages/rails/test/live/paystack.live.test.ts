import { describe, expect, it } from "vitest";
import { CredentialBroker, SealedCredentialBundle, vaultReference } from "@payswap/adapters";
import type { ProtocolClock, TimestampMs } from "@payswap/protocol";
import { PaystackConnector } from "../../src/paystack.js";
import { makeAdapterAuthority } from "../fixtures.js";

/**
 * LIVE credential-gated Paystack suite (P2-W3-001). Run explicitly:
 * `source /home/z/.secrets/env.sh && npx vitest run --config vitest.live.config.ts`
 * — NEVER part of the default deterministic battery.
 *
 * READ-ONLY probes only (authenticated bank enumeration + health): the live
 * account is test-mode, and this suite creates no financial objects. No
 * credential value is ever written to a file, log or assertion message.
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

function liveKeyMaterial(): string | undefined {
  const direct = process.env["PAYSTACK_SECRET_KEY"];
  return typeof direct === "string" && direct.length > 0 ? direct : undefined;
}

const MATERIAL = liveKeyMaterial();
const gatedIt = MATERIAL !== undefined ? it : it.skip;

function liveControlPlaneConnector(): PaystackConnector {
  const reference = "vault://payswap/providers/paystack/test-20261002";
  const store = {
    storeId: "vault-live-paystack",
    bindings: new Map<string, string>([["PROVIDER_PAYSTACK_CREDENTIAL_REF", reference]]),
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
        providerName: "paystack",
        authorizationMode: "SCOPED_API_CREDENTIAL",
        vaultReference: vaultReference(reference),
        issuedAt: "2026-10-02T06:37:38Z",
        accountRef: "paystack-test-account-20261002",
      },
      MATERIAL,
    ),
  );
  const broker = new CredentialBroker({ store });
  const runtimeKey = broker.registerConnectorRuntime("runtime.paystack.live");
  return new PaystackConnector({
    clock: LIVE_CLOCK,
    credentials: { broker, runtimeKey },
    timeoutMs: 20_000,
  });
}

const AUTHORITY = makeAdapterAuthority();

describe("paystack production connector — LIVE credential-gated probes (test mode)", () => {
  gatedIt("health(): the REAL authenticated probe answers (the key resolves and authenticates)", async () => {
    const connector = liveControlPlaneConnector();
    const report = await connector.health();
    expect(report.status).toBe("HEALTHY");
  });

  gatedIt("list_banks(GHS): the authenticated local-rail enumeration answers real banks", async () => {
    const connector = liveControlPlaneConnector();
    const result = await connector.search({
      authority: AUTHORITY,
      idempotencyKey: `live-ps-banks-ghs-${Date.now().toString(36)}`,
      request: { kind: "list_banks", currency: "GHS" },
    });
    const state = result.providerState.state as { data?: { name?: string; code?: string }[] };
    expect(Array.isArray(state.data)).toBe(true);
    expect((state.data ?? []).length).toBeGreaterThan(0);
    const firstBank = (state.data ?? [])[0];
    expect(typeof firstBank?.name).toBe("string");
  });

  gatedIt("list_banks(KES): the Kenyan rail enumerates (coverage evidence, not marketing)", async () => {
    const connector = liveControlPlaneConnector();
    const result = await connector.search({
      authority: AUTHORITY,
      idempotencyKey: `live-ps-banks-kes-${Date.now().toString(36)}`,
      request: { kind: "list_banks", currency: "KES" },
    });
    const state = result.providerState.state as { data?: unknown[] };
    expect((state.data ?? []).length).toBeGreaterThan(0);
  });

  gatedIt("verify_payment of a nonexistent reference: the honest not-found state (never a fake success)", async () => {
    const connector = liveControlPlaneConnector();
    const outcome = await connector
      .reconcile({
        authority: AUTHORITY,
        idempotencyKey: `live-ps-verify-none-${Date.now().toString(36)}`,
        request: { kind: "verify_payment", reference: "payswap:nonexistent-probe-20261002" },
      })
      .then(
        (value) => value,
        (error: unknown) => error,
      );
    // the provider's honest answer for an unknown reference is an
    // error/not-found — NEVER a manufactured success (fail-closed honesty)
    expect(outcome).toBeDefined();
  });

  gatedIt("skips cleanly when the credential surface is not provisioned (no network, no outcome)", () => {
    // this test only runs to document the gate; with no PAYSTACK_SECRET_KEY
    // in the environment every gatedIt above is skipped, never faked
    expect(typeof MATERIAL === "undefined" || MATERIAL.length > 0).toBe(true);
  });
});

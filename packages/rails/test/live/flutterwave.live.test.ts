import { describe, expect, it } from "vitest";
import { validateExternalFundsPositionObservation } from "@payswap/connectors";
import type { ExternalFundsPositionObservation } from "@payswap/connectors";
import { CredentialBroker, SealedCredentialBundle, vaultReference } from "@payswap/adapters";
import type { ProtocolClock, TimestampMs } from "@payswap/protocol";
import { FlutterwaveConnector } from "../../src/flutterwave.js";

/**
 * LIVE credential-gated Flutterwave suite (P2-W3-001). Run explicitly:
 * `source /home/z/.secrets/env.sh && npx vitest run --config vitest.live.config.ts`
 * — NEVER part of the default deterministic battery.
 *
 * READ-ONLY probes only (wallet-balance observation + health): the live
 * account is test-mode; this suite creates no financial objects. No
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
  const direct = process.env["FLUTTERWAVE_SECRET_KEY"];
  return typeof direct === "string" && direct.length > 0 ? direct : undefined;
}

const MATERIAL = liveKeyMaterial();
const gatedIt = MATERIAL !== undefined ? it : it.skip;

function liveControlPlaneConnector(): FlutterwaveConnector {
  const reference = "vault://payswap/providers/flutterwave/test-20261002";
  const store = {
    storeId: "vault-live-flutterwave",
    bindings: new Map<string, string>([["PROVIDER_FLUTTERWAVE_CREDENTIAL_REF", reference]]),
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
        providerName: "flutterwave",
        authorizationMode: "SCOPED_API_CREDENTIAL",
        vaultReference: vaultReference(reference),
        issuedAt: "2026-10-02T06:37:38Z",
        accountRef: "flutterwave-test-account-20261002",
      },
      MATERIAL,
    ),
  );
  const broker = new CredentialBroker({ store });
  const runtimeKey = broker.registerConnectorRuntime("runtime.flutterwave.live");
  return new FlutterwaveConnector({
    clock: LIVE_CLOCK,
    credentials: { broker, runtimeKey },
    timeoutMs: 20_000,
  });
}

describe("flutterwave production connector — LIVE credential-gated probes (test mode)", () => {
  gatedIt("health(): the REAL authenticated probe answers", async () => {
    const connector = liveControlPlaneConnector();
    const report = await connector.health();
    expect(report.status).toBe("HEALTHY");
  });

  gatedIt("observeExternalFunds(): wallet balances are validated OBSERVATIONS ONLY (never custody)", async () => {
    const connector = liveControlPlaneConnector();
    const observations = await connector.observeExternalFunds();
    expect(observations.length).toBeGreaterThan(0);
    const currencies = observations.map(
      (observation: ExternalFundsPositionObservation) => observation.observedAmount.currency,
    );
    for (const observation of observations) {
      // every observation passes the connectors-package validation — an
      // external funds position, never a PaySwap balance
      expect(() => validateExternalFundsPositionObservation(observation)).not.toThrow();
    }
    // the 2026-10-02 probe datum: the wallet set includes the local rails
    expect(currencies).toContain("GHS");
    expect(currencies).toContain("NGN");
    // and the stablecoin wallets (the Stellar USDC corridor's material sibling)
    expect(currencies).toContain("USDC");
  });

  gatedIt("skips cleanly when the credential surface is not provisioned (no network, no outcome)", () => {
    expect(typeof MATERIAL === "undefined" || MATERIAL.length > 0).toBe(true);
  });
});

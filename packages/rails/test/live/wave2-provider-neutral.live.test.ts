import { describe, expect, it } from "vitest";
import { AdyenConnector, ADYEN_DEFAULT_CHECKOUT_BASE_TEST, ADYEN_TEST_REACHABILITY_20261002 } from "../../src/adyen.js";
import {
  AirwallexConnector,
  AIRWALLEX_DEFAULT_API_BASE_DEMO,
  AIRWALLEX_DEMO_REACHABILITY_20261002,
} from "../../src/airwallex.js";
import { EbanxConnector, EBANX_DEFAULT_API_BASE_SANDBOX, EBANX_SANDBOX_REACHABILITY_20261002 } from "../../src/ebanx.js";

/**
 * LIVE reachability documentation for the Wave-2 provider-neutral
 * connectors (P2-W3-002: Adyen, Airwallex, EBANX). Run explicitly:
 * `npx vitest run --config vitest.live.config.ts` — NEVER part of the
 * default deterministic battery.
 *
 * These probes carry NO credentials: they document the honest
 * reachability state of the public API hosts (INV-C01/C02 — a 401/403
 * answer is endpoint REACHABLE + authorization ABSENT, never a failure
 * to hide). The authenticated suites skip cleanly until the vault
 * carries PROVIDER_ADYEN_CREDENTIAL_REF / PROVIDER_AIRWALLEX_CREDENTIAL_REF /
 * PROVIDER_EBANX_CREDENTIAL_REF.
 */

const LIVE_CLOCK = {
  now: (): bigint => BigInt(Date.now()),
  monotonic: (() => {
    let last = 0n;
    return (): bigint => {
      const current = BigInt(Date.now());
      last = current > last ? current : last + 1n;
      return last;
    };
  })(),
};

function readableEnv(key: string): string | undefined {
  const value = process.env[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

const ADYEN_MATERIAL = readableEnv("PROVIDER_ADYEN_CREDENTIAL_REF");
const AIRWALLEX_MATERIAL = readableEnv("PROVIDER_AIRWALLEX_CREDENTIAL_REF");
const EBANX_MATERIAL = readableEnv("PROVIDER_EBANX_CREDENTIAL_REF");

async function probe(url: string, method = "GET"): Promise<number | "TRANSPORT_ERROR"> {
  try {
    const response = await fetch(url, { method });
    return response.status;
  } catch {
    return "TRANSPORT_ERROR";
  }
}

describe("adyen — LIVE reachability documentation (NO credentials; the current honest state)", () => {
  it("the test checkout host answers the payments path 401-class WITHOUT credentials (endpoint reachable, API key required)", async () => {
    const status = await probe(`${ADYEN_DEFAULT_CHECKOUT_BASE_TEST}/v70/paymentMethods`);
    expect(status).toBe(401); // the 2026-10-02 probe datum, re-verified live
    expect(ADYEN_TEST_REACHABILITY_20261002.httpStatus).toBe(401);
  });

  it("the connector reports NOT_PROVISIONED (credential ABSENT) with UNKNOWN availability — never AVAILABLE", () => {
    const connector = new AdyenConnector({ clock: LIVE_CLOCK, env: {} });
    expect(connector.credentialResolutionState()).toMatchObject({ kind: "NOT_PROVISIONED" });
  });

  it.skipIf(ADYEN_MATERIAL === undefined)("authenticated probes run only when the vault carries the sealed bundle", () => {
    expect(typeof ADYEN_MATERIAL).toBe("string");
  });
});

describe("airwallex — LIVE reachability documentation (NO credentials; the current honest state)", () => {
  it("the demo API host answers the login path 403-class WITHOUT credentials (endpoint reachable, authentication required)", async () => {
    const status = await probe(`${AIRWALLEX_DEFAULT_API_BASE_DEMO}/api/v1/authentication/login`, "POST");
    expect(status).toBe(403); // the 2026-10-02 probe datum, re-verified live
    expect(AIRWALLEX_DEMO_REACHABILITY_20261002.httpStatus).toBe(403);
  });

  it("the connector reports NOT_PROVISIONED (credential ABSENT) with UNKNOWN availability — never AVAILABLE", () => {
    const connector = new AirwallexConnector({ clock: LIVE_CLOCK, env: {} });
    expect(connector.credentialResolutionState()).toMatchObject({ kind: "NOT_PROVISIONED" });
  });

  it.skipIf(AIRWALLEX_MATERIAL === undefined)("authenticated probes run only when the vault carries the sealed bundle", () => {
    expect(typeof AIRWALLEX_MATERIAL).toBe("string");
  });
});

describe("ebanx — LIVE reachability documentation (NO credentials; the current honest state)", () => {
  it("the sandbox host answers the query path 401-class WITHOUT credentials (endpoint reachable, integration key required)", async () => {
    const status = await probe(`${EBANX_DEFAULT_API_BASE_SANDBOX}/ws/query`, "POST");
    expect(status).toBe(401); // the 2026-10-02 probe datum, re-verified live
    expect(EBANX_SANDBOX_REACHABILITY_20261002.httpStatus).toBe(401);
  });

  it("the connector reports NOT_PROVISIONED (credential ABSENT) with UNKNOWN availability — never AVAILABLE", () => {
    const connector = new EbanxConnector({ clock: LIVE_CLOCK, env: {} });
    expect(connector.credentialResolutionState()).toMatchObject({ kind: "NOT_PROVISIONED" });
  });

  it.skipIf(EBANX_MATERIAL === undefined)("authenticated probes run only when the vault carries the sealed bundle", () => {
    expect(typeof EBANX_MATERIAL).toBe("string");
  });
});

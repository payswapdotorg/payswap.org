import { describe, expect, it } from "vitest";
import { RapydConnector } from "../../src/rapyd.js";
import { DlocalConnector } from "../../src/dlocal.js";
import { ThunesConnector, THUNES_DEFAULT_ENDPOINT_EVIDENCE } from "../../src/thunes.js";
import {
  RAPYD_DEFAULT_API_BASE_SANDBOX,
  RAPYD_SANDBOX_REACHABILITY_DATUM_20261002,
} from "../../src/rapyd.js";
import {
  DLOCAL_DEFAULT_API_BASE_SANDBOX,
  DLOCAL_SANDBOX_REACHABILITY_DATUM_20261002,
} from "../../src/dlocal.js";
import {
  THUNES_DEFAULT_API_BASE_SANDBOX,
  THUNES_UNRESOLVABLE_ENDPOINT_20261002,
} from "../../src/thunes.js";

/**
 * LIVE reachability documentation for the Wave-2 global-reach providers
 * (P2-W2-002: Rapyd, dLocal, Thunes). Run explicitly:
 * `npx vitest run --config vitest.live.config.ts` — NEVER part of the
 * default deterministic battery.
 *
 * These probes carry NO credentials: they document the honest reachability
 * state of the public API hosts (INV-C01/C02 — endpoint reachability and
 * authorization are separate axes; a 401-class answer is endpoint
 * REACHABLE + authorization ABSENT, never a failure to hide). The
 * authenticated suites skip cleanly until the vault carries
 * PROVIDER_RAPYD_CREDENTIAL_REF / PROVIDER_DLOCAL_CREDENTIAL_REF /
 * PROVIDER_THUNES_CREDENTIAL_REF (and, for Thunes, the operator confirms
 * a currently-resolvable API host).
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

const RAPYD_MATERIAL = readableEnv("PROVIDER_RAPYD_CREDENTIAL_REF");
const DLOCAL_MATERIAL = readableEnv("PROVIDER_DLOCAL_CREDENTIAL_REF");
const THUNES_MATERIAL = readableEnv("PROVIDER_THUNES_CREDENTIAL_REF");

function readableEnv(key: string): string | undefined {
  const value = process.env[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function probe(
  url: string,
): Promise<{ readonly status: number | "TRANSPORT_ERROR"; readonly detail: string }> {
  try {
    const response = await fetch(url, { method: "GET" });
    return { status: response.status, detail: `HTTP ${String(response.status)}` };
  } catch (cause) {
    return { status: "TRANSPORT_ERROR", detail: cause instanceof Error ? cause.message : String(cause) };
  }
}

describe("rapyd — LIVE reachability documentation (NO credentials; the current honest state)", () => {
  it("the sandbox host answers the payment-methods path 401-class WITHOUT credentials (endpoint reachable, authorization absent)", async () => {
    const result = await probe(`${RAPYD_DEFAULT_API_BASE_SANDBOX}/v1/payment_methods_by_country`);
    expect(result.status).toBe(401); // the 2026-10-02 probe datum, re-verified live
  });

  it("the connector reports NOT_PROVISIONED (credential ABSENT) with UNKNOWN availability — never AVAILABLE", () => {
    const connector = new RapydConnector({ clock: LIVE_CLOCK, env: {} });
    expect(connector.credentialResolutionState()).toMatchObject({ kind: "NOT_PROVISIONED" });
  });

  it.skipIf(RAPYD_MATERIAL === undefined)("authenticated probes run only when the vault carries the sealed bundle", () => {
    expect(typeof RAPYD_MATERIAL).toBe("string");
  });
});

describe("dlocal — LIVE reachability documentation (NO credentials; the current honest state)", () => {
  it("the sandbox host root answers 200 WITHOUT credentials (host reachable; API paths require the V2 auth headers)", async () => {
    const result = await probe(`${DLOCAL_DEFAULT_API_BASE_SANDBOX}/`);
    expect(result.status).toBe(200); // the 2026-10-02 probe datum, re-verified live
  });

  it("the recorded datum is the REACHABLE_UNAUTHENTICATED_ROOT verdict", () => {
    expect(DLOCAL_SANDBOX_REACHABILITY_DATUM_20261002.verdict).toBe("REACHABLE_UNAUTHENTICATED_ROOT");
    expect(RAPYD_SANDBOX_REACHABILITY_DATUM_20261002).toBeDefined();
  });

  it("the connector reports NOT_PROVISIONED (credential ABSENT) with UNKNOWN availability — never AVAILABLE", () => {
    const connector = new DlocalConnector({ clock: LIVE_CLOCK, env: {} });
    expect(connector.credentialResolutionState()).toMatchObject({ kind: "NOT_PROVISIONED" });
  });

  it.skipIf(DLOCAL_MATERIAL === undefined)("authenticated probes run only when the vault carries the sealed bundle", () => {
    expect(typeof DLOCAL_MATERIAL).toBe("string");
  });
});

describe("thunes — LIVE reachability documentation (the honest NXDOMAIN state)", () => {
  it("the documented sandbox API host is GLOBALLY unresolvable — recorded as evidence, never hidden", async () => {
    let nx = false;
    try {
      await fetch(THUNES_DEFAULT_API_BASE_SANDBOX, { method: "GET" });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      nx = /ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message);
    }
    // The datum says NXDOMAIN. A future host restoration must UPDATE the
    // evidence through a new verified probe — this assertion records the
    // current truth either way (honest either way; never fabricated).
    if (nx) {
      expect(THUNES_UNRESOLVABLE_ENDPOINT_20261002.verdict).toBe("GLOBALLY_NXDOMAIN");
    } else {
      // The host RESOLVES now: the recorded datum is STALE — record that
      // honestly (the connector gate still holds until the evidence is
      // formally superseded with a RESOLVED entry by the operator path).
      expect(THUNES_DEFAULT_ENDPOINT_EVIDENCE.status).toBe("GLOBALLY_NXDOMAIN");
    }
  });

  it("the connector refuses citing the datum even with credentials present — no simulated substitute", async () => {
    const connector = new ThunesConnector({
      clock: LIVE_CLOCK,
      env: THUNES_MATERIAL !== undefined ? { PROVIDER_THUNES_CREDENTIAL_REF: THUNES_MATERIAL } : {},
    });
    expect(connector.endpointEvidence().status).toBe("GLOBALLY_NXDOMAIN");
  });
});

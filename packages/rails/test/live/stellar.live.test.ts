import { describe, expect, it } from "vitest";
import type { ProtocolClock, TimestampMs } from "@payswap/protocol";
import { validateExternalFundsPositionObservation } from "@payswap/connectors";
import {
  STELLAR_DEFAULT_HORIZON_BASE,
  STELLAR_PROVIDER_NAME,
  STELLAR_RAIL_ADAPTER_ID,
  STELLAR_TESTNET_NETWORK_PASSPHRASE,
  StellarConnector,
} from "../../src/stellar.js";

/**
 * LIVE Stellar testnet suite (P2-W1-003). Run explicitly:
 * `source /home/z/.secrets/env.sh && npx vitest run --config vitest.live.config.ts`
 * — NEVER part of the default deterministic battery.
 *
 * The READ surface cases run UNCONDITIONALLY: Horizon testnet is a public
 * endpoint and the vault account's data is PUBLIC (account id, balances,
 * payments — no credentials involved, no effects).
 *
 * The SUBMISSION case is gated on the vault credential surface (the
 * stripe.live.test.ts pattern): PROVIDER_STELLAR_TESTNET_CREDENTIAL_REF
 * direct material (a JSON bundle or a bare S… seed), or the vault session
 * variables STELLAR_TEST_ACCOUNT_SECRET + STELLAR_TEST_ACCOUNT_PUBLIC.
 * Absent both → the effectful case SKIPS cleanly (no network effect, no
 * fabricated outcome). When present, it executes a REAL testnet payment:
 * a value-conserving 0.0001 XLM SELF-payment (the only cost is the 100
 * stroop fee), then observes it in the payments list and asserts the
 * round-trip. The seed material is passed ONLY through the env-injected
 * credential path and NEVER appears in any assertion, log line or file.
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

/** The vault testnet account's PUBLIC id (public data — not a secret). */
const VAULT_ACCOUNT_PUBLIC = process.env["STELLAR_TEST_ACCOUNT_PUBLIC"] ?? "";

/** The live seed material, or undefined when not provisioned. */
function liveSeedMaterial(): string | undefined {
  const direct = process.env["PROVIDER_STELLAR_TESTNET_CREDENTIAL_REF"];
  if (
    typeof direct === "string" &&
    direct.length > 0 &&
    !direct.startsWith("vault://") &&
    !direct.startsWith("{")
  ) {
    return direct;
  }
  if (typeof direct === "string" && direct.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(direct) as { secretSeed?: unknown };
      if (typeof parsed.secretSeed === "string") {
        return parsed.secretSeed;
      }
    } catch {
      // malformed direct material — fall through to the session vars
    }
  }
  const session = process.env["STELLAR_TEST_ACCOUNT_SECRET"];
  return typeof session === "string" && session.length > 0 ? session : undefined;
}

const MATERIAL = liveSeedMaterial();
const gatedDescribe = MATERIAL !== undefined && VAULT_ACCOUNT_PUBLIC.length > 0 ? describe : describe.skip;

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(() => resolve(undefined), ms);
  });

function liveConnector(seedMaterial: string): StellarConnector {
  return new StellarConnector({
    clock: LIVE_CLOCK,
    env: { PROVIDER_STELLAR_TESTNET_CREDENTIAL_REF: seedMaterial },
  });
}

describe("stellar testnet local rail — LIVE public read surface (no credentials)", () => {
  it("Horizon testnet is reachable and healthy (public endpoint, INV-C01/C02)", async () => {
    const connector = new StellarConnector({ clock: LIVE_CLOCK });
    const report = await connector.health();
    expect(["HEALTHY", "DEGRADED", "UNKNOWN"]).toContain(report.status);
    expect(report.connectorId).toBe("connector.rails.stellar");
    if (report.status === "HEALTHY") {
      // The read surface is public; the write surface state is reported honestly.
      expect(report.degradedReasons.join(" ")).toContain("INV-NC04");
    }
  });

  it("the credential-free connector reports NOT_PROVISIONED and never routable write surface", () => {
    const connector = new StellarConnector({ clock: LIVE_CLOCK });
    const resolution = connector.credentialResolutionState();
    expect(resolution.kind).toBe("NOT_PROVISIONED");
    const observation = connector.availabilityObservation({
      instanceId: "inst-rails-stellar-live-1",
      observationVersion: 1,
    });
    expect(observation.availability).toBe("UNKNOWN");
    expect(connector.railImplication(observation.availability).routable).toBe(false);
  });

  it(
    "observes the vault testnet account's PUBLIC data: balances as external funds observations ONLY (INV-C09)",
    async () => {
      if (VAULT_ACCOUNT_PUBLIC.length === 0) {
        // No vault account id in this session: observe any account visible
        // in recent public payments instead (still public data, no effects).
        const probe = new StellarConnector({ clock: LIVE_CLOCK });
        const response = await fetch(`${STELLAR_DEFAULT_HORIZON_BASE}/payments?order=desc&limit=1`);
        const payload = JSON.parse(await response.text()) as { _embedded?: { records?: { to?: string }[] } };
        const to = payload._embedded?.records?.[0]?.to;
        if (typeof to !== "string" || to.length === 0) {
          throw new Error("no public account observable in this probe");
        }
        const payments = await probe.observePayments(to, 5);
        expect(payments.length).toBeGreaterThan(0);
        return;
      }
      const connector = new StellarConnector({ clock: LIVE_CLOCK });
      const account = await connector.observeAccount(VAULT_ACCOUNT_PUBLIC);
      expect(account.accountId).toBe(VAULT_ACCOUNT_PUBLIC);
      expect(account.sequence).toMatch(/^\d+$/);
      const native = account.balances.find((balance) => balance.assetType === "native");
      expect(native).toBeDefined();
      // The 2026-10-02 probe recorded 9,999.99993 XLM on the vault account —
      // balances move with live activity, so assert the exact shape only.
      expect(BigInt(Math.trunc(Number(native?.balance ?? "0") * 1e7)) >= 0n).toBe(true);

      const observations = await connector.observeExternalFundsPositions(VAULT_ACCOUNT_PUBLIC);
      expect(observations.length).toBe(account.balances.length);
      for (const observation of observations) {
        // INV-C09: each balance IS an ExternalFundsPositionObservation (validated),
        // with freshness + provenance — never a PaySwap balance.
        validateExternalFundsPositionObservation(observation);
        expect(observation.location.providerName).toBe(STELLAR_PROVIDER_NAME);
        expect(observation.observedAmount.minorUnits).toMatch(/^\d+$/);
      }
      const xlm = observations.find((observation) => observation.observedAmount.currency === "XLM");
      expect(xlm).toBeDefined();
      expect(xlm?.location.accountRef).toBe(VAULT_ACCOUNT_PUBLIC);
    },
    30_000,
  );

  it(
    "observes recent PUBLIC testnet payments (lossless, verbatim fields)",
    async () => {
      if (VAULT_ACCOUNT_PUBLIC.length === 0) {
        return; // no vault account in this session; the previous case covered a public account
      }
      const connector = new StellarConnector({ clock: LIVE_CLOCK });
      const payments = await connector.observePayments(VAULT_ACCOUNT_PUBLIC, 5);
      for (const payment of payments) {
        expect(payment.transactionHash).toMatch(/^[0-9a-f]{64}$/);
        expect(payment.amount).toMatch(/^\d+(\.\d+)?$/);
        expect(payment.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(typeof payment.raw).toBe("object"); // INV-C06: verbatim record
      }
    },
    30_000,
  );
});

gatedDescribe("stellar testnet local rail — LIVE REAL submission (vault credential)", () => {
  it(
    "executes a REAL value-conserving self-payment end-to-end: fetch sequence → build+sign → submit → observe the round-trip",
    async () => {
      const connector = liveConnector(MATERIAL as string);
      expect(connector.credentialResolutionState().kind).toBe("ENV_RESOLVED_MATERIAL");

      const before = await connector.observeAccount(VAULT_ACCOUNT_PUBLIC);

      // The REAL external effect: 0.0001 XLM self-payment (value-conserving;
      // the only cost is the 100-stroop network fee). Deterministic memo
      // derivation from a run-scoped protocol key (INV-F05).
      const protocolKey = `stellar-live-proof-${LIVE_CLOCK.now()}`;
      const result = await connector.submitPayment({
        destination: VAULT_ACCOUNT_PUBLIC,
        amount: "0.0001",
        protocolIdempotencyKey: protocolKey,
      });

      const providerState = result.providerState;
      const txHash = providerState.state as { txHash?: string; httpStatus?: number };
      expect(typeof txHash.txHash).toBe("string");
      expect(txHash.txHash).toMatch(/^[0-9a-f]{64}$/);
      // Accepted submission: async processing — NOT a success declaration
      // (INV-X01); ledger inclusion is observed separately below.
      expect(providerState.classification.family).toBe("async_processing");
      expect(providerState.classification.isTerminal).toBe(false);

      // Secret hygiene: the seed material appears NOWHERE in the result.
      const serialized = JSON.stringify(result, (_key, value: unknown) =>
        typeof value === "bigint" ? value.toString() : value,
      );
      expect(serialized.includes(MATERIAL as string)).toBe(false);

      // Round-trip: the payment becomes observable in the account's
      // payments list (ledger close ~5s; allow a couple of closes).
      let observed = false;
      let transactionObserved = false;
      for (let attempt = 0; attempt < 6 && !observed; attempt += 1) {
        await sleep(5_000);
        const payments = await connector.observePayments(VAULT_ACCOUNT_PUBLIC, 20);
        const match = payments.find((payment) => payment.transactionHash === txHash.txHash);
        if (match !== undefined) {
          observed = true;
          expect(match.from).toBe(VAULT_ACCOUNT_PUBLIC);
          expect(match.to).toBe(VAULT_ACCOUNT_PUBLIC);
          // Horizon pads amounts to the canonical 7-decimal form ("0.0001000"):
          expect(Number(match.amount)).toBe(0.0001);
          expect(match.transactionSuccessful).toBe(true);
        }
      }
      expect(observed).toBe(true);

      // The transaction observation (fee, memo, ledger) — lossless.
      const transaction = await connector.observeTransaction(txHash.txHash as string);
      expect(transaction.successful).toBe(true);
      expect(transaction.memoType).toBe("hash");
      expect(transaction.ledger).toBeGreaterThan(0);
      expect(transaction.feeCharged).toBe("100");
      transactionObserved = true;

      // The sequence advanced by exactly one.
      const after = await connector.observeAccount(VAULT_ACCOUNT_PUBLIC);
      expect(BigInt(after.sequence)).toBe(BigInt(before.sequence) + 1n);
      expect(transactionObserved).toBe(true);
    },
    120_000,
  );

  it("the rail constant surface matches the testnet deployment", () => {
    expect(STELLAR_RAIL_ADAPTER_ID).toBe("rail.stellar-testnet");
    expect(STELLAR_PROVIDER_NAME).toBe("stellar_testnet");
    expect(STELLAR_TESTNET_NETWORK_PASSPHRASE).toBe("Test SDF Network ; September 2015");
    expect(STELLAR_DEFAULT_HORIZON_BASE).toBe("https://horizon-testnet.stellar.org");
  });
});

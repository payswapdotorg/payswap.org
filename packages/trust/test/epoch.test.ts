import { describe, expect, it } from "vitest";
import {
  EpochLedger,
  NonMonotonicEpochError,
  StaleEpochError,
  checkEpoch,
} from "../src/index.js";
import type { Principal } from "../src/index.js";

/**
 * INV-A02: expired/revoked security epochs cannot authorize sensitive actions.
 * INV-S02: the security epoch is checked on every sensitive delegated action.
 */

const T0 = 1_000_000;

const user: Principal = { kind: "user", id: "owner-1", securityEpoch: 0n };
const agent: Principal = {
  kind: "agent",
  agentKeyFingerprint: "agent-key-1",
  ownerRef: "user:owner-1",
  bodyRef: "body:payer@1",
  packageVersionRef: "pkg:payer@1",
  authorityEnvelope: [],
  securityEpoch: 1n,
};
const service: Principal = { kind: "service", id: "scheduler", scope: "scheduling" };

describe("EpochLedger", () => {
  it("starts at the implicit epoch 0 and the first raise moves to 1", () => {
    const ledger = new EpochLedger();
    expect(ledger.currentEpoch("user:owner-1")).toBeUndefined();
    const raised = ledger.raiseEpoch("user:owner-1", "beneficiary change signal", T0);
    expect(raised.value).toBe(1n);
    expect(ledger.currentEpoch("user:owner-1")?.value).toBe(1n);
  });

  it("raiseEpoch is monotonic: values strictly increase per principal", () => {
    const ledger = new EpochLedger();
    ledger.raiseEpoch("user:owner-1", "first", T0);
    ledger.raiseEpoch("user:owner-1", "second", T0 + 1000);
    const third = ledger.raiseEpoch("user:owner-1", "third", T0 + 2000);
    expect(third.value).toBe(3n);
  });

  it("rejects a raise whose timestamp moves backwards", () => {
    const ledger = new EpochLedger();
    ledger.raiseEpoch("user:owner-1", "first", T0 + 2000);
    expect(() => ledger.raiseEpoch("user:owner-1", "clock skew", T0 + 1000)).toThrow(
      NonMonotonicEpochError,
    );
  });

  it("keeps principals independent", () => {
    const ledger = new EpochLedger();
    ledger.raiseEpoch("user:owner-1", "user signal", T0);
    expect(ledger.currentEpoch("user:owner-2")).toBeUndefined();
  });

  it("history is append-only and ordered (AGENTS.md rule 8)", () => {
    const ledger = new EpochLedger();
    ledger.raiseEpoch("user:owner-1", "first", T0);
    ledger.raiseEpoch("agent:agent-key-1", "agent anomaly", T0 + 500);
    ledger.raiseEpoch("user:owner-1", "second", T0 + 1000);
    expect(ledger.history().map((entry) => [entry.principalRef, entry.value])).toEqual([
      ["user:owner-1", 1n],
      ["agent:agent-key-1", 1n],
      ["user:owner-1", 2n],
    ]);
  });
});

describe("checkEpoch", () => {
  it("passes a current credential", () => {
    const ledger = new EpochLedger();
    ledger.raiseEpoch("user:owner-1", "raise", T0);
    expect(() =>
      checkEpoch({ kind: "user", id: "owner-1", securityEpoch: 1n }, ledger),
    ).not.toThrow();
  });

  it("throws StaleEpochError for a credential behind the current epoch", () => {
    const ledger = new EpochLedger();
    ledger.raiseEpoch("user:owner-1", "raise", T0);
    try {
      checkEpoch(user, ledger);
      expect.unreachable("must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(StaleEpochError);
      const stale = error as StaleEpochError;
      expect(stale.principalRef).toBe("user:owner-1");
      expect(stale.credentialEpoch).toBe(0n);
      expect(stale.currentEpoch).toBe(1n);
      expect(stale.message).toContain("Stale security epoch");
      expect(stale.message).toContain("user:owner-1");
    }
  });

  it("guards agent principals too", () => {
    const ledger = new EpochLedger();
    ledger.raiseEpoch("agent:agent-key-1", "package anomaly", T0);
    ledger.raiseEpoch("agent:agent-key-1", "repeat", T0 + 1);
    try {
      checkEpoch(agent, ledger); // credential epoch 1 < current 2
      expect.unreachable("must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(StaleEpochError);
      expect((error as StaleEpochError).currentEpoch).toBe(2n);
    }
  });

  it("service principals carry no delegable credential epoch", () => {
    const ledger = new EpochLedger();
    expect(() => checkEpoch(service, ledger)).not.toThrow();
  });
});

import { describe, expect, it } from "vitest";
import { EpochLedger, principalRef } from "@payswap/trust";
import type { AgentPrincipal } from "@payswap/trust";
import {
  AuthorizationExpiredError,
  NonMonotonicSecurityEpochError,
  SecurityEpochAuthority,
  StaleAuthorizationEpochError,
  checkDelegatedSensitiveAction,
  checkSensitiveActionAuthorization,
  evaluateSensitiveActionAuthorization,
  isSensitiveActionClass,
} from "../src/index.js";

/**
 * INV-S02 — security epoch is checked on every sensitive delegated action.
 * INV-A02 — expired/revoked epochs cannot authorize sensitive actions.
 */

function authorization(overrides?: Partial<{
  issuedAtEpoch: bigint;
  expiresAt: number;
  actionClass: "money_movement";
  principalRef: string;
}>): {
  authorizationRef: string;
  principalRef: string;
  actionClass: "money_movement";
  issuedAtEpoch: bigint;
  expiresAt: number;
} {
  return {
    authorizationRef: "auth:transfer-1",
    principalRef: "user:alice",
    actionClass: "money_movement",
    issuedAtEpoch: 0n,
    expiresAt: 10_000,
    ...overrides,
  };
}

describe("network security epoch authority", () => {
  it("starts at genesis epoch 0 and only advances monotonically", () => {
    const epochs = new SecurityEpochAuthority();
    expect(epochs.currentEpoch().value).toBe(0n);
    expect(epochs.history()).toHaveLength(1);

    const first = epochs.advance({ reason: "advisory adv-1", at: 100, advisoryRef: "adv-1" });
    expect(first.value).toBe(1n);
    expect(first.advisoryRef).toBe("adv-1");

    const second = epochs.advance({ reason: "incident response", at: 200 });
    expect(second.value).toBe(2n);
    expect(second.advisoryRef).toBeUndefined();
    expect(epochs.currentEpoch().value).toBe(2n);
    expect(epochs.history().map((epoch) => epoch.value)).toEqual([0n, 1n, 2n]);
  });

  it("rejects non-monotonic advances", () => {
    const epochs = new SecurityEpochAuthority();
    epochs.advance({ reason: "first", at: 100 });
    expect(() => epochs.advance({ reason: "backwards", at: 50 })).toThrow(
      NonMonotonicSecurityEpochError,
    );
    expect(() => epochs.advance({ reason: "", at: 200 })).toThrow();
  });
});

describe("INV-S02: epoch check on sensitive delegated actions", () => {
  it("allows a current-epoch, unexpired authorization", () => {
    const epochs = new SecurityEpochAuthority();
    expect(() =>
      checkSensitiveActionAuthorization(authorization(), epochs, 1_000),
    ).not.toThrow();
  });

  it("rejects a sensitive action when the epoch bumped past issuance (INV-A02)", () => {
    const epochs = new SecurityEpochAuthority();
    // The authorization was issued at epoch 0 and is still within its
    // temporal validity — but the immune system advanced the network epoch.
    epochs.advance({ reason: "coordinated abuse response", at: 100 });
    expect(() =>
      checkSensitiveActionAuthorization(authorization(), epochs, 1_000),
    ).toThrow(StaleAuthorizationEpochError);
  });

  it("an epoch-bump invalidates EVERY stale authorization at once", () => {
    const epochs = new SecurityEpochAuthority();
    epochs.advance({ reason: "step 1", at: 100 });
    const fresh = authorization({ issuedAtEpoch: 1n });
    // Fresh (epoch-1) authorization still works at network epoch 1.
    expect(() =>
      checkSensitiveActionAuthorization(fresh, epochs, 1_000),
    ).not.toThrow();
    // Another bump: now even the epoch-1 authorization is dead.
    epochs.advance({ reason: "step 2", at: 200 });
    expect(() =>
      checkSensitiveActionAuthorization(fresh, epochs, 1_000),
    ).toThrow(StaleAuthorizationEpochError);
  });

  it("rejects expired authorizations deterministically (expiry is time-input based)", () => {
    const epochs = new SecurityEpochAuthority();
    const shortLived = authorization({ expiresAt: 500 });
    expect(() =>
      checkSensitiveActionAuthorization(shortLived, epochs, 400),
    ).not.toThrow();
    expect(() =>
      checkSensitiveActionAuthorization(shortLived, epochs, 501),
    ).toThrow(AuthorizationExpiredError);
  });

  it("carries structured error data and a non-throwing evaluation twin", () => {
    const epochs = new SecurityEpochAuthority();
    epochs.advance({ reason: "bump", at: 10 });
    let error: StaleAuthorizationEpochError | undefined;
    try {
      checkSensitiveActionAuthorization(authorization(), epochs, 1_000);
    } catch (thrown) {
      if (thrown instanceof StaleAuthorizationEpochError) {
        error = thrown;
      }
    }
    expect(error?.issuedAtEpoch).toBe(0n);
    expect(error?.currentEpoch).toBe(1n);
    expect(error?.authorizationRef).toBe("auth:transfer-1");

    const evaluation = evaluateSensitiveActionAuthorization(
      authorization(),
      epochs,
      1_000,
    );
    expect(evaluation.allowed).toBe(false);
    expect(evaluation.reason).toBe("stale_security_epoch");
    expect(evaluation.currentEpoch).toBe(1n);
  });

  it("sensitive action classes are the conservative set", () => {
    expect(isSensitiveActionClass("money_movement")).toBe(true);
    expect(isSensitiveActionClass("beneficiary_change")).toBe(true);
    expect(isSensitiveActionClass("rails.execute")).toBe(false);
  });
});

describe("INV-A02: revoked per-principal credential epochs cannot authorize", () => {
  const agentPrincipal: AgentPrincipal = {
    kind: "agent",
    agentKeyFingerprint: "sha256:agent-key-1",
    ownerRef: "user:alice",
    bodyRef: "body:fraud-screener",
    packageVersionRef: "pkg:fraud-screener@2",
    authorityEnvelope: [{ mandateId: "mandate:1", version: 1 }],
    securityEpoch: 1n,
  };

  function credentialLedger(): EpochLedger {
    const ledger = new EpochLedger();
    ledger.raiseEpoch(principalRef(agentPrincipal), "initial credential", 0);
    return ledger;
  }

  it("passes when the network epoch AND the credential epoch are current", () => {
    const epochs = new SecurityEpochAuthority();
    const ledger = credentialLedger(); // agent credential epoch = 1
    const auth = authorization({
      principalRef: principalRef(agentPrincipal),
      issuedAtEpoch: 0n,
    });
    expect(() =>
      checkDelegatedSensitiveAction(agentPrincipal, auth, epochs, 1_000, ledger),
    ).not.toThrow();
  });

  it("rejects when the principal's credential epoch was revoked (trust ledger ahead)", () => {
    const epochs = new SecurityEpochAuthority();
    const ledger = credentialLedger();
    // Revocation: the principal's credential epoch is raised past the
    // credential the agent presents (securityEpoch: 1).
    ledger.raiseEpoch(principalRef(agentPrincipal), "key compromise", 100);
    const auth = authorization({
      principalRef: principalRef(agentPrincipal),
      issuedAtEpoch: 0n,
    });
    expect(() =>
      checkDelegatedSensitiveAction(agentPrincipal, auth, epochs, 1_000, ledger),
    ).toThrow(/Stale security epoch/);
  });

  it("rejects when the network epoch advanced past the authorization (advisory path)", () => {
    const epochs = new SecurityEpochAuthority();
    const ledger = credentialLedger();
    epochs.advance({ reason: "advisory adv-9", at: 50, advisoryRef: "adv-9" });
    const auth = authorization({
      principalRef: principalRef(agentPrincipal),
      issuedAtEpoch: 0n,
    });
    expect(() =>
      checkDelegatedSensitiveAction(agentPrincipal, auth, epochs, 1_000, ledger),
    ).toThrow(StaleAuthorizationEpochError);
  });

  it("rejects an authorization delegated to a different principal", () => {
    const epochs = new SecurityEpochAuthority();
    const auth = authorization({ principalRef: "user:bob" });
    expect(() =>
      checkDelegatedSensitiveAction(agentPrincipal, auth, epochs, 1_000),
    ).toThrow(/not to the acting principal/);
  });
});

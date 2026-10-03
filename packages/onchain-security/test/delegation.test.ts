import { describe, expect, it } from "vitest";
import type { Mandate } from "@payswap/trust";
import {
  DelegationAttenuationError,
  SigningDelegationError,
  SigningDelegationRegistry,
  delegationCoversWrite,
} from "../src/index.js";
import type { IssueSigningDelegationParams, SigningDelegationScope } from "../src/index.js";
import { prepareWrite } from "../src/index.js";
import { CHAIN, NOW, USC_ASSET, MERCHANT, PAYER, ROUTER, MALICIOUS_SPENDER, baseWriteRequest } from "./helpers.js";

/**
 * P4-W1-002 acceptance: delegation attenuation + revocation + expiry
 * negatives (AGENTS.md rule 9; INV-A01, INV-SC03).
 */

const GRANT_AT = NOW;
const EXPIRES_AT = NOW + 60_000;

function parentMandate(overrides?: Partial<Mandate>): Mandate {
  return {
    id: "mandate-1",
    version: 1,
    grantor: "user:alice",
    grantee: "agent:agent-key-1",
    actions: ["onchain.transfer", "onchain.swap"],
    resources: [{ type: "onchain_write" }],
    rails: [CHAIN, "polygon:mainnet"],
    currencies: ["USC"],
    beneficiaries: [MERCHANT],
    limits: { perTransactionAmount: { currency: "USC", minorUnits: "5000000" } },
    expiresAt: NOW + 120_000,
    proofRequirements: [],
    ...overrides,
  };
}

function delegationParams(
  scope: SigningDelegationScope,
  overrides?: Partial<IssueSigningDelegationParams>,
): IssueSigningDelegationParams {
  return {
    delegationId: "del-1",
    parentMandate: parentMandate(),
    granteeRef: "session-key:fingerprint-1",
    method: "session_key",
    scope,
    grantedAt: GRANT_AT,
    expiresAt: EXPIRES_AT,
    conditions: ["checkout session"],
    decisionRef: "decision-1",
    ...overrides,
  };
}

describe("attenuation (INV-A01: child ⊂ parent)", () => {
  it("derives a valid scoped delegation from a parent mandate", () => {
    const registry = new SigningDelegationRegistry();
    const delegation = registry.issue(
      delegationParams({
        actions: ["onchain.transfer"],
        chains: [CHAIN],
        assets: [USC_ASSET],
        destinations: [MERCHANT],
        spenders: [ROUTER],
        maxPerTransactionAmount: { currency: "USC", minorUnits: "1000000" },
      }),
    );
    expect(delegation.id).toBe("del-1");
    expect(delegation.method).toBe("session_key");
    expect(registry.status("del-1", NOW + 1)).toBe("ACTIVE");
  });

  it("rejects an action pattern outside the parent mandate", () => {
    const registry = new SigningDelegationRegistry();
    expect(() =>
      registry.issue(delegationParams({ actions: ["onchain.*"] })),
    ).toThrow(DelegationAttenuationError);
  });

  it("rejects a chain not permitted by the parent rails", () => {
    const registry = new SigningDelegationRegistry();
    expect(() =>
      registry.issue(
        delegationParams({ chains: ["solana:mainnet"] }),
      ),
    ).toThrow(DelegationAttenuationError);
  });

  it("rejects an asset whose symbol is not a parent-mandate currency", () => {
    const registry = new SigningDelegationRegistry();
    expect(() =>
      registry.issue(
        delegationParams({ assets: [{ chain: CHAIN, assetId: "native", symbol: "ETH" }] }),
      ),
    ).toThrow(DelegationAttenuationError);
  });

  it("rejects a destination outside the parent beneficiaries", () => {
    const registry = new SigningDelegationRegistry();
    expect(() =>
      registry.issue(delegationParams({ destinations: [MALICIOUS_SPENDER] })),
    ).toThrow(DelegationAttenuationError);
  });

  it("rejects a per-transaction cap exceeding the parent limit", () => {
    const registry = new SigningDelegationRegistry();
    expect(() =>
      registry.issue(
        delegationParams({ maxPerTransactionAmount: { currency: "USC", minorUnits: "9000000" } }),
      ),
    ).toThrow(DelegationAttenuationError);
  });

  it("rejects a cap currency mismatch with the parent limit", () => {
    const registry = new SigningDelegationRegistry();
    expect(() =>
      registry.issue(
        delegationParams({ maxPerTransactionAmount: { currency: "ETH", minorUnits: "1" } }),
      ),
    ).toThrow(DelegationAttenuationError);
  });

  it("rejects an expiry that outlives the parent mandate", () => {
    const registry = new SigningDelegationRegistry();
    expect(() =>
      registry.issue(delegationParams({}, { expiresAt: parentMandate().expiresAt + 1 })),
    ).toThrow(DelegationAttenuationError);
  });

  it("rejects an expiry at or before issuance (expiring instrument law)", () => {
    const registry = new SigningDelegationRegistry();
    expect(() => registry.issue(delegationParams({}, { expiresAt: GRANT_AT }))).toThrow(
      SigningDelegationError,
    );
  });

  it("spenders are a NEW restricted dimension: any list is a pure narrowing", () => {
    const registry = new SigningDelegationRegistry();
    // The parent mandate has no spender dimension, so introducing one can
    // never widen anything:
    const delegation = registry.issue(delegationParams({ spenders: [ROUTER] }));
    expect(delegation.scope.spenders).toEqual([ROUTER]);
  });
});

describe("revocation (immediate, monotonic, append-only)", () => {
  it("an ACTIVE delegation covers the write; a revoked one does not", () => {
    const registry = new SigningDelegationRegistry();
    registry.issue(
      delegationParams({
        actions: ["onchain.transfer"],
        chains: [CHAIN],
        destinations: [MERCHANT],
        maxPerTransactionAmount: { currency: "USC", minorUnits: "2000000" },
      }),
    );
    const write = prepareWrite(baseWriteRequest(), NOW);
    const delegation = registry.lookup("del-1");
    expect(delegation).toBeDefined();
    if (delegation !== undefined) {
      expect(delegationCoversWrite(delegation, write)).toBe(true);
    }

    registry.revoke("del-1", NOW + 10, "session key compromise suspected");
    expect(registry.status("del-1", NOW + 10)).toBe("REVOKED");
    expect(registry.status("del-1", NOW + 9)).toBe("ACTIVE"); // deterministic instant semantics
  });

  it("revocation cannot be reversed or repeated", () => {
    const registry = new SigningDelegationRegistry();
    registry.issue(delegationParams({}));
    registry.revoke("del-1", NOW + 10, "first");
    expect(() => registry.revoke("del-1", NOW + 20, "second")).toThrow(SigningDelegationError);
    expect(registry.revocations()).toHaveLength(1);
  });

  it("revocation cannot be backdated before issuance", () => {
    const registry = new SigningDelegationRegistry();
    registry.issue(delegationParams({}));
    expect(() => registry.revoke("del-1", GRANT_AT - 1, "backdate attempt")).toThrow(
      SigningDelegationError,
    );
  });

  it("revoking an unknown delegation fails", () => {
    const registry = new SigningDelegationRegistry();
    expect(() => registry.revoke("del-x", NOW, "unknown")).toThrow(SigningDelegationError);
  });
});

describe("expiry (fail closed)", () => {
  it("status is EXPIRED at and after the expiry instant", () => {
    const registry = new SigningDelegationRegistry();
    registry.issue(delegationParams({}));
    expect(registry.status("del-1", EXPIRES_AT - 1)).toBe("ACTIVE");
    expect(registry.status("del-1", EXPIRES_AT)).toBe("EXPIRED");
    expect(registry.status("del-1", EXPIRES_AT + 1)).toBe("EXPIRED");
  });

  it("REVOKED takes precedence over EXPIRED (strongest death wins)", () => {
    const registry = new SigningDelegationRegistry();
    registry.issue(delegationParams({}));
    registry.revoke("del-1", NOW + 10, "compromise");
    expect(registry.status("del-1", EXPIRES_AT + 1)).toBe("REVOKED");
  });

  it("an unknown delegation id is UNKNOWN — never authority (fail closed)", () => {
    const registry = new SigningDelegationRegistry();
    expect(registry.status("del-forged", NOW)).toBe("UNKNOWN");
  });
});

describe("scope coverage (fail closed per dimension)", () => {
  it("rejects a write whose action is outside the delegation", () => {
    const registry = new SigningDelegationRegistry();
    const delegation = registry.issue(delegationParams({ actions: ["onchain.swap"] }));
    const write = prepareWrite(baseWriteRequest(), NOW); // action: onchain.transfer
    expect(delegationCoversWrite(delegation, write)).toBe(false);
  });

  it("rejects a write on an uncovered chain", () => {
    const registry = new SigningDelegationRegistry();
    const delegation = registry.issue(delegationParams({ chains: ["polygon:mainnet"] }));
    const write = prepareWrite(baseWriteRequest(), NOW); // chain: ethereum:mainnet
    expect(delegationCoversWrite(delegation, write)).toBe(false);
  });

  it("rejects a write to an uncovered destination", () => {
    const registry = new SigningDelegationRegistry();
    const delegation = registry.issue(delegationParams({ destinations: [MERCHANT] }));
    const write = prepareWrite(
      { ...baseWriteRequest(), transfer: { ...baseWriteRequest().transfer!, to: MALICIOUS_SPENDER } },
      NOW,
    );
    expect(delegationCoversWrite(delegation, write)).toBe(false);
  });

  it("rejects a transfer above the delegation's per-transaction cap", () => {
    const registry = new SigningDelegationRegistry();
    const delegation = registry.issue(
      delegationParams({ maxPerTransactionAmount: { currency: "USC", minorUnits: "500000" } }),
    );
    const write = prepareWrite(baseWriteRequest(), NOW); // 1000000 minor units
    expect(delegationCoversWrite(delegation, write)).toBe(false);
  });

  it("rejects an approval to a spender outside the delegation's spender list", () => {
    const registry = new SigningDelegationRegistry();
    const delegation = registry.issue(delegationParams({ spenders: [ROUTER] }));
    const write = prepareWrite(
      {
        ...baseWriteRequest(),
        approvals: [{ asset: USC_ASSET, owner: PAYER, spender: MALICIOUS_SPENDER, amount: { currency: "USC", minorUnits: "1000" }, unlimited: false }],
      },
      NOW,
    );
    expect(delegationCoversWrite(delegation, write)).toBe(false);
  });
});

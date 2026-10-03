import { describe, expect, it } from "vitest";
import { ValidationError } from "@payswap/protocol";
import {
  validateSignerHandle,
  WALLET_CUSTODY_MODELS,
  validateWalletCapabilityDeclaration,
  validateSignerCapabilityDeclaration,
  validateSmartAccountCapabilityDeclaration,
} from "../src/wallet.js";
import { signerHandle } from "./fixtures.js";

describe("signer handles (opaque references — NEVER key material)", () => {
  it("validates a canonical opaque signer handle", () => {
    const handle = validateSignerHandle(signerHandle());
    expect(handle.handleId).toBe("signer.handle.001");
    expect(handle.custodyModel).toBe("NON_CUSTODIAL_EXTERNAL");
    expect(handle.permissionEnvelopeRef).toBe("envelope:signer:001");
  });

  it("REJECTS a handle id that IS raw 32-byte key material (with 0x prefix)", () => {
    expect(() =>
      validateSignerHandle({ ...signerHandle(), handleId: "0x" + "4c0883a69102937d".repeat(4) }),
    ).toThrow(/key material/);
  });

  it("REJECTS a handle id that IS raw 32-byte key material (bare hex)", () => {
    expect(() =>
      validateSignerHandle({ ...signerHandle(), handleId: "4c0883a69102937d".repeat(4) }),
    ).toThrow(/key material/);
  });

  it("rejects malformed handles (whitespace, missing instance linkage, unknown custody model)", () => {
    expect(() => validateSignerHandle({ ...signerHandle(), handleId: "has whitespace" })).toThrow(
      /whitespace/,
    );
    expect(() =>
      validateSignerHandle({ ...signerHandle(), capabilityInstanceId: "" }),
    ).toThrow(/capabilityInstanceId/);
    expect(() =>
      validateSignerHandle({ ...signerHandle(), custodyModel: "THE_KEYS_ARE_MINE" }),
    ).toThrow(/custodyModel/);
  });

  it("the custody model vocabulary declares WHO controls keys — no field ever carries the material", () => {
    expect(WALLET_CUSTODY_MODELS).toContain("NON_CUSTODIAL_EXTERNAL");
    expect(WALLET_CUSTODY_MODELS).toContain("SMART_ACCOUNT");
    expect(WALLET_CUSTODY_MODELS).toContain("HARDWARE");
  });
});

describe("wallet / signer / smart-account capability declarations", () => {
  it("validates a canonical wallet capability declaration", () => {
    const declaration = validateWalletCapabilityDeclaration({
      capabilityKind: "wallet",
      custodyModel: "NON_CUSTODIAL_EXTERNAL",
      supportedFamilies: ["EVM", "SOLANA"],
      supportedOperations: ["onchain.transfer", "onchain.approval"],
    });
    expect(declaration.supportedFamilies).toContain("SOLANA");
  });

  it("rejects an empty supported-operations scope (the scope is always explicit)", () => {
    expect(() =>
      validateWalletCapabilityDeclaration({
        capabilityKind: "wallet",
        custodyModel: "NON_CUSTODIAL_EXTERNAL",
        supportedFamilies: ["EVM"],
        supportedOperations: [],
      }),
    ).toThrow(/supportedOperations/);
  });

  it("validates a canonical signer capability declaration", () => {
    const declaration = validateSignerCapabilityDeclaration({
      capabilityKind: "signer",
      custodyModel: "HARDWARE",
      signableOperations: ["onchain.transfer"],
      requiresUserPresence: true,
      supportsSessionKeys: false,
    });
    expect(declaration.requiresUserPresence).toBe(true);
  });

  it("rejects a signer declaration with an unknown operation in its allowlist", () => {
    expect(() =>
      validateSignerCapabilityDeclaration({
        capabilityKind: "signer",
        custodyModel: "HARDWARE",
        signableOperations: ["onchain.everything"],
        requiresUserPresence: true,
        supportsSessionKeys: false,
      }),
    ).toThrow(ValidationError);
  });

  it("validates a canonical smart-account declaration (permission envelope mandatory)", () => {
    const declaration = validateSmartAccountCapabilityDeclaration({
      capabilityKind: "smart_account",
      permissionEnvelopeRequired: true,
      supportsSessionKeys: true,
      supportsSpendingPolicies: true,
      supportsBatchExecution: true,
      supportsGasSponsorship: false,
      recoveryModel: "declared: social recovery quorum",
    });
    expect(declaration.supportsSessionKeys).toBe(true);
  });

  it("INV-SC03: an UNBOUNDED smart-account declaration is rejected", () => {
    expect(() =>
      validateSmartAccountCapabilityDeclaration({
        capabilityKind: "smart_account",
        permissionEnvelopeRequired: false,
        supportsSessionKeys: true,
        supportsSpendingPolicies: false,
        supportsBatchExecution: false,
        supportsGasSponsorship: false,
        recoveryModel: "declared",
      }),
    ).toThrow(/permissionEnvelopeRequired must be true/);
  });
});

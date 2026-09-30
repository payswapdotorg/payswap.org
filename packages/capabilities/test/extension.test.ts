import { describe, expect, it } from "vitest";
import {
  EXTENSION_PERMISSIONS,
  ExtensionManifestValidationError,
  TOKEN_FAMILIES,
  isExtensionPermission,
  isTokenFamily,
  validateExtensionManifest,
} from "../src/index.js";
import type { ExtensionManifest, ExtensionPermission, TokenFamily } from "../src/index.js";
import type { Equal, Expect } from "./type-utils.js";

/**
 * FROZEN-ARCHITECTURE §13/§24 + INV-C04: extensions use typed protocol
 * artifacts/tokens and never hold direct ledger authority. The permission
 * vocabulary has NO ledger-write and NO rail-execute member, and the runtime
 * validator rejects unknown permission strings.
 */

const validManifest: ExtensionManifest = {
  id: "ext:smart-routing",
  version: "1.2.0",
  name: "Smart Routing Proposal Extension",
  consumedTokenFamilies: ["Intent", "Quote", "Capability"],
  emittedTokenFamilies: ["Execution"],
  permissions: ["read_tokens", "emit_tokens", "observe_capabilities", "propose_actions"],
};

describe("extension permission vocabulary (INV-C04)", () => {
  it("contains no ledger-write or rail-execute member", () => {
    expect((EXTENSION_PERMISSIONS as readonly string[]).includes("ledger-write")).toBe(false);
    expect((EXTENSION_PERMISSIONS as readonly string[]).includes("rail-execute")).toBe(false);
    expect((EXTENSION_PERMISSIONS as readonly string[]).includes("ledger_write")).toBe(false);
    expect((EXTENSION_PERMISSIONS as readonly string[]).includes("execute_rail")).toBe(false);
    for (const permission of EXTENSION_PERMISSIONS) {
      expect(permission).not.toMatch(/ledger/i);
      expect(permission).not.toMatch(/write/i);
      expect(permission).not.toMatch(/rail/i);
      expect(permission).not.toMatch(/execut/i);
    }
  });

  it("isExtensionPermission rejects forbidden and unknown strings", () => {
    expect(isExtensionPermission("ledger-write")).toBe(false);
    expect(isExtensionPermission("rail-execute")).toBe(false);
    expect(isExtensionPermission("write_ledger")).toBe(false);
    expect(isExtensionPermission("root")).toBe(false);
    expect(isExtensionPermission("")).toBe(false);
    expect(isExtensionPermission(42)).toBe(false);
    expect(isExtensionPermission("propose_actions")).toBe(true);
  });
});

describe("validateExtensionManifest", () => {
  it("accepts a well-formed manifest", () => {
    const manifest = validateExtensionManifest(validManifest);
    expect(manifest.id).toBe("ext:smart-routing");
    expect(manifest.permissions).toContain("propose_actions");
    expect(manifest.emittedTokenFamilies).toEqual(["Execution"]);
  });

  it("rejects a manifest requesting 'ledger-write' (unknown permission)", () => {
    try {
      validateExtensionManifest({
        ...validManifest,
        permissions: ["read_tokens", "ledger-write"],
      });
      expect.unreachable("must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ExtensionManifestValidationError);
      const validation = error as ExtensionManifestValidationError;
      expect(validation.errors.some((message) => message.includes("ledger-write"))).toBe(true);
      expect(validation.message).toContain("unknown permission");
    }
  });

  it("rejects a manifest requesting 'rail-execute'", () => {
    expect(() =>
      validateExtensionManifest({ ...validManifest, permissions: ["rail-execute"] }),
    ).toThrow(/rail-execute/);
  });

  it("rejects unknown token families", () => {
    expect(() =>
      validateExtensionManifest({
        ...validManifest,
        consumedTokenFamilies: ["Intent", "LedgerWrite"],
      }),
    ).toThrow(/unknown token family 'LedgerWrite'/);
    expect(isTokenFamily("Settlement")).toBe(true);
    expect(isTokenFamily("Money")).toBe(false);
  });

  it("rejects inconsistent permission/family declarations", () => {
    expect(() =>
      validateExtensionManifest({
        ...validManifest,
        permissions: ["emit_tokens"],
        emittedTokenFamilies: [],
      }),
    ).toThrow(/requires at least one emitted token family/);
  });

  it("rejects structurally invalid manifests", () => {
    expect(() => validateExtensionManifest(null)).toThrow(ExtensionManifestValidationError);
    expect(() => validateExtensionManifest("nope")).toThrow(ExtensionManifestValidationError);
    expect(() =>
      validateExtensionManifest({ ...validManifest, id: "" }),
    ).toThrow(/id must be a non-empty string/);
  });
});

// Type-level guarantees (enforced by `tsc --noEmit`):

// The permission union is exactly the five permitted members — no ledger/rail authority.
type _assertPermissions = Expect<
  Equal<
    ExtensionPermission,
    | "read_tokens"
    | "emit_tokens"
    | "observe_capabilities"
    | "propose_actions"
    | "request_approval"
  >
>;

// The token family union covers exactly the §24 families.
type _assertFamilies = Expect<
  Equal<
    TokenFamily,
    | "Intent"
    | "Capability"
    | "Authorization"
    | "Identity_Evidence"
    | "Quote"
    | "Liquidity"
    | "Credit"
    | "Execution"
    | "Settlement"
    | "Netting"
    | "Dispute_Recourse"
    | "Expert"
    | "Policy"
    | "Participation_Incentive"
  >
>;

// The runtime arrays are in lockstep with the unions.
type _assertArrayMatchesUnion = Expect<Equal<(typeof EXTENSION_PERMISSIONS)[number], ExtensionPermission>>;
type _assertFamiliesMatchUnion = Expect<Equal<(typeof TOKEN_FAMILIES)[number], TokenFamily>>;

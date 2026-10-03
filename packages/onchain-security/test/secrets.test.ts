import { describe, expect, expectTypeOf, it } from "vitest";
import {
  FORBIDDEN_SECRET_KEY_EXACT,
  FORBIDDEN_SECRET_KEY_SUBSTRINGS,
  SecretShapeError,
  assertNoSecretMaterial,
  isMnemonicShape,
  isRawKeyShape,
  scanForSecretMaterial,
} from "../src/index.js";
import type { FindForbiddenSecretKeys } from "../src/index.js";

/**
 * AGENTS.md rule 25 / INV-R02 — no raw private key, seed phrase, wallet
 * password, provider secret, cookie or MFA material may enter agent
 * context or ordinary artifacts.
 *
 * SECURITY LAW of this work order: where a credential SHAPE must be tested,
 * fixtures are assembled at RUNTIME from fragments so no realistic fake
 * secret is ever committed as a literal.
 */

/** Runtime assembly of a raw-32-byte-key-shaped fixture (never a literal). */
function rawKeyShapedFixture(): string {
  return `0x${"c0de".repeat(16)}`; // 0x + 64 hex chars — the key SHAPE only
}

function hex64NoPrefixFixture(): string {
  return "cafe".repeat(16);
}

/** Runtime assembly of a BIP-39-shaped fixture (12 lowercase words). */
function mnemonicShapedFixture(): string {
  const words = ["abandon", "cabbage", "danger", "eager", "fabric", "galaxy"];
  return [...words, ...words].join(" ");
}

/** EVM transaction-hash-shaped fixture (derived public identifier). */
function txHashShapedFixture(): string {
  return `0x${"ab12".repeat(16)}`;
}

describe("value shape detectors (structure only)", () => {
  it("detects the raw 32-byte key shape with and without 0x prefix", () => {
    expect(isRawKeyShape(rawKeyShapedFixture())).toBe(true);
    expect(isRawKeyShape(hex64NoPrefixFixture())).toBe(true);
  });

  it("does not flag digests, addresses, calldata or non-hex values", () => {
    expect(isRawKeyShape("fnv1a64:0123456789abcdef")).toBe(false);
    expect(isRawKeyShape("0xAb12Cd34")).toBe(false);
    expect(isRawKeyShape("ethereum:mainnet")).toBe(false);
    expect(isRawKeyShape("12345")).toBe(false);
    expect(isRawKeyShape("")).toBe(false);
  });

  it("detects the 12/24-word mnemonic shape", () => {
    expect(isMnemonicShape(mnemonicShapedFixture())).toBe(true);
    const twentyFour = [...new Array(24)].map(() => "zoo").join(" ");
    expect(isMnemonicShape(twentyFour)).toBe(true);
  });

  it("does not flag ordinary prose, ids or shorter word lists", () => {
    expect(isMnemonicShape("transfer 100 USDC to merchant")).toBe(false);
    expect(isMnemonicShape("a b c d e f g h i j k")).toBe(false); // 11 words
    expect(isMnemonicShape("onchain write request")).toBe(false);
    // Mixed case or digits disqualify the mnemonic shape.
    expect(isMnemonicShape(mnemonicShapedFixture().toUpperCase())).toBe(false);
  });
});

describe("deep runtime scan", () => {
  it("accepts clean agent-facing payloads", () => {
    const clean = {
      writeId: "write-1",
      chain: "ethereum:mainnet",
      asset: { chain: "ethereum:mainnet", assetId: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC" },
      amount: { currency: "USDC", minorUnits: "1000000" },
      destination: "0x1111111111111111111111111111111111111111",
      routeHash: "fnv1a64:0123456789abcdef",
    };
    expect(scanForSecretMaterial(clean)).toEqual([]);
    expect(() => assertNoSecretMaterial(clean, "clean-request")).not.toThrow();
  });

  it("rejects a forbidden key at the top level regardless of value", () => {
    const payload: Record<string, unknown> = { writeId: "write-1" };
    // Assemble the forbidden FIELD NAME at runtime from fragments.
    const forbiddenField = ["private", "Key"].join("");
    payload[forbiddenField] = "REDACTED";
    const violations = scanForSecretMaterial(payload);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.kind).toBe("forbidden_key");
    expect(() => assertNoSecretMaterial(payload, "request")).toThrow(SecretShapeError);
  });

  it("rejects forbidden keys under normalization variants (snake/kebab/case)", () => {
    for (const variant of [
      ["wallet", "_pass", "word"].join(""),
      ["SEED", "_PHRASE"].join(""),
      ["api", "-secret"].join(""),
      ["Mnemonic"].join(""),
      ["recovery", "_phrase"].join(""),
      ["provider", "Secret"].join(""),
      ["session", "Cookie"].join(""),
      ["MFA", "Code"].join(""),
    ]) {
      const payload: Record<string, unknown> = { [variant]: "x" };
      expect(scanForSecretMaterial(payload), `field '${variant}' must be forbidden`).toHaveLength(1);
    }
  });

  it("rejects the exact stem 'seed' but not unrelated compound words", () => {
    expect(scanForSecretMaterial({ seed: "x" })).toHaveLength(1);
    expect(scanForSecretMaterial({ seedingRound: "round-1" })).toEqual([]);
  });

  it("rejects secret-shaped values smuggled under neutral field names", () => {
    const payload = {
      note: rawKeyShapedFixture(),
      comment: mnemonicShapedFixture(),
    };
    const violations = scanForSecretMaterial(payload);
    expect(violations).toHaveLength(2);
    expect(violations.every((v) => v.kind === "secret_shaped_value")).toBe(true);
  });

  it("exempts derived public identifiers (hash/digest/signature/fingerprint) from the value scan", () => {
    const payload = {
      routeHash: txHashShapedFixture(),
      calldataDigest: txHashShapedFixture(),
      artifactSignature: `0x${"ff".repeat(65)}`,
      agentKeyFingerprint: hex64NoPrefixFixture(),
      calldata: `0x${"aa".repeat(64)}`,
    };
    expect(scanForSecretMaterial(payload)).toEqual([]);
  });

  it("scans nested objects and arrays and reports dotted paths", () => {
    const payload = {
      writeId: "write-1",
      legs: [
        { note: "leg-0 ok" },
        { extra: { memo: rawKeyShapedFixture() } },
      ],
    };
    const violations = scanForSecretMaterial(payload);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.path).toBe("$.legs[1].extra.memo");
    expect(violations[0]?.kind).toBe("secret_shaped_value");
  });

  it("cuts cycles and bounds depth without throwing", () => {
    const cyclic: Record<string, unknown> = { writeId: "write-1" };
    cyclic["self"] = cyclic;
    expect(scanForSecretMaterial(cyclic)).toEqual([]);
    let deep: Record<string, unknown> = { leaf: "safe" };
    for (let i = 0; i < 40; i += 1) {
      deep = { child: deep };
    }
    expect(scanForSecretMaterial(deep)).toEqual([]);
  });

  it("SecretShapeError carries every violation and a readable message", () => {
    const payload = {
      [`${"private"}${"Key"}`]: "REDACTED",
      note: rawKeyShapedFixture(),
    };
    let error: SecretShapeError | undefined;
    try {
      assertNoSecretMaterial(payload, "authorization-request");
    } catch (thrown) {
      if (thrown instanceof SecretShapeError) {
        error = thrown;
      }
    }
    expect(error).toBeDefined();
    expect(error?.violations).toHaveLength(2);
    expect(error?.message).toContain("authorization-request");
    expect(error?.message).toContain("forbidden_key");
  });
});

describe("type-level forbidden-key detection (compile-time twin)", () => {
  it("resolves to never for clean contract shapes", () => {
    type CleanContract = {
      readonly writeId: string;
      readonly asset: { readonly chain: string; readonly assetId: string; readonly symbol: string };
      readonly signature: string;
      readonly routeHash: string;
    };
    expectTypeOf<FindForbiddenSecretKeys<CleanContract>>().toBeNever();
  });

  it("surfaces forbidden keys at any nesting depth (including arrays)", () => {
    type SmuggledTop = { readonly writeId: string; readonly privateKey: string };
    expectTypeOf<FindForbiddenSecretKeys<SmuggledTop>>().not.toBeNever();

    type SmuggledNested = {
      readonly legs: readonly {
        readonly memo: string;
        readonly wallet_password: string;
      }[];
    };
    expectTypeOf<FindForbiddenSecretKeys<SmuggledNested>>().not.toBeNever();

    type SmuggledDeep = {
      readonly security: { readonly mfa: { readonly totp: string } };
    };
    expectTypeOf<FindForbiddenSecretKeys<SmuggledDeep>>().not.toBeNever();
  });

  it("the vocabularies are non-empty and normalized", () => {
    expect(FORBIDDEN_SECRET_KEY_SUBSTRINGS.length).toBeGreaterThan(10);
    expect(FORBIDDEN_SECRET_KEY_EXACT).toEqual(["seed"]);
    for (const fragment of FORBIDDEN_SECRET_KEY_SUBSTRINGS) {
      expect(fragment).toBe(fragment.toLowerCase());
      expect(fragment).not.toMatch(/[_-]/);
    }
  });
});

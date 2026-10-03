import { describe, expect, it } from "vitest";
import { PACKAGE_NAME, contentDigest } from "../src/index.js";

describe("smoke", () => {
  it("exports the package name", () => {
    expect(PACKAGE_NAME).toBe("@payswap/onchain-security");
  });

  it("content digest is deterministic and structure-sensitive", () => {
    const a = { chain: "ethereum:mainnet", amount: 1n };
    const b = { amount: 1n, chain: "ethereum:mainnet" };
    expect(contentDigest(a)).toBe(contentDigest(b)); // key order irrelevant
    expect(contentDigest({ ...a, amount: 2n })).not.toBe(contentDigest(a));
    expect(contentDigest(a)).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
  });
});

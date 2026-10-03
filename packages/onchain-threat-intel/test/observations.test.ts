import { describe, expect, it } from "vitest";
import { recordObservationBundle } from "../src/index.js";
import type { OnchainThreatObservationBundle } from "../src/index.js";
import { SecretShapeError } from "@payswap/onchain-security";
import {
  CHAIN,
  USC_ASSET,
  benignBundle,
  benignBundleInput,
} from "./helpers.js";

describe("observation bundle recording", () => {
  it("records, freezes and content-addresses a benign bundle", () => {
    const bundle = benignBundle();
    expect(bundle.bundleId).toBe("bundle-1");
    expect(bundle.bundleDigest.startsWith("fnv1a64:")).toBe(true);
    expect(Object.isFrozen(bundle)).toBe(true);
  });

  it("the digest binds the content (any field change → different digest)", () => {
    const a = recordObservationBundle(benignBundleInput());
    const b = recordObservationBundle({
      ...benignBundleInput(),
      observedAt: benignBundleInput().observedAt + 1,
    });
    expect(a.bundleDigest).not.toBe(b.bundleDigest);
  });

  it("deterministic: same input → same digest", () => {
    const a = recordObservationBundle(benignBundleInput());
    const b = recordObservationBundle(benignBundleInput());
    expect(a.bundleDigest).toBe(b.bundleDigest);
  });

  it("rejects duplicate observation ids (fail closed)", () => {
    const input = benignBundleInput();
    const duplicated = {
      ...input,
      oracles: [
        ...(input.oracles ?? []),
        { ...(input.oracles ?? [])[0]! },
      ],
    };
    expect(() => recordObservationBundle(duplicated)).toThrow(/duplicate observationId/);
  });

  it("rejects malformed oracle prices (never floating point)", () => {
    const input = benignBundleInput();
    const bad = {
      ...input,
      oracles: [
        {
          observationId: "oracle:bad",
          oracleId: "oracle:bad",
          pair: "USC/USD",
          observedPrice: "0.99",
          priceUpdatedAt: NOW,
          feedAgeMs: 0,
        },
      ],
    };
    expect(() => recordObservationBundle(bad)).toThrow(/canonical rational/);
  });

  it("rejects finality where safeBlock exceeds headBlock", () => {
    const input = benignBundleInput();
    const bad = {
      ...input,
      finality: {
        observationId: "finality:bad",
        chain: CHAIN,
        headBlock: 100,
        safeBlock: 200,
        observedAt: 1_000_000,
      },
    };
    expect(() => recordObservationBundle(bad)).toThrow(/cannot exceed headBlock/);
  });

  it("requires quoteObservedAt exactly when a quote is supplied", () => {
    const input = benignBundleInput();
    const bad = {
      ...input,
      quoteSlippage: {
        protection: "DECLARED_LIMIT" as const,
        worstCaseOutput: { currency: "USC", minorUnits: "990000" },
        limitBasisPoints: 100,
      },
    };
    expect(() => recordObservationBundle(bad)).toThrow(/quoteObservedAt/);
  });

  it("SECRET SCAN: key material cannot transit the agent-facing bundle (rule 25)", () => {
    const input = benignBundleInput();
    // Assemble a key-shaped value at RUNTIME from fragments (no realistic
    // secret literal ever appears in source).
    const rawKeyShape = `0x${"ab".repeat(32)}`;
    const bad = {
      ...input,
      addresses: [
        ...(input.addresses ?? []),
        {
          observationId: "address:leak",
          address: rawKeyShape,
          chainsActiveOn: [CHAIN],
          observedAt: 1_000_000,
        },
      ],
    };
    expect(() => recordObservationBundle(bad)).toThrow(SecretShapeError);
  });

  it("SECRET SCAN: forbidden key names are rejected", () => {
    const input = benignBundleInput();
    const bad = {
      ...input,
      // The forbidden key name itself is the violation — the kernel scan
      // rejects it before any field-level validation runs.
      privateKey: rawKeyShapeFromFragments(),
    };
    expect(() => recordObservationBundle(bad)).toThrow(SecretShapeError);
  });
});

function rawKeyShapeFromFragments(): string {
  return `0x${"cd".repeat(32)}`;
}

const NOW = 1_000_000;

describe("bundle typing surface", () => {
  it("optional sections are absent intelligence (not clean bills)", () => {
    const minimal: OnchainThreatObservationBundle = recordObservationBundle({
      bundleId: "bundle-min",
      observer: "observer:x",
      observedAt: 1,
    });
    expect(minimal.spenders).toBeUndefined();
    expect(minimal.tokens).toBeUndefined();
    expect(minimal.finality).toBeUndefined();
  });
});

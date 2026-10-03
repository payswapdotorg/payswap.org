import { describe, expect, it } from "vitest";
import { ValidationError } from "@payswap/protocol";
import {
  canonicalAssetRef,
  validateAssetDefinition,
  validateAssetObservation,
  validateAssetAmount,
  parseAssetAmountMinorUnits,
  ASSET_OBSERVATION_KIND,
  MAX_ASSET_MINOR_UNIT_DIGITS,
} from "../src/asset.js";
import { etherAssetDefinition, etherAssetObservation, ETHEREUM_CHAIN_KEY } from "./fixtures.js";

describe("asset definitions (descriptive catalogue; deterministic identity)", () => {
  it("validates a canonical native-asset definition", () => {
    const asset = validateAssetDefinition(etherAssetDefinition());
    expect(asset.assetId).toBe(canonicalAssetRef(ETHEREUM_CHAIN_KEY, "ETH"));
    expect(asset.assetClass).toBe("NATIVE");
    expect(asset.minorUnitDigits).toBe(18);
  });

  it("enforces the deterministic asset identity: assetId === <chainKey>/asset:<symbol>", () => {
    const tampered = {
      ...etherAssetDefinition(),
      assetId: "somewhere/asset:ETH",
    };
    expect(() => validateAssetDefinition(tampered)).toThrow(/asset identity is deterministic/);
  });

  it("rejects a catalogue entry without provenance (anonymous claims are rejected)", () => {
    const anonymous = { ...etherAssetDefinition(), provenance: undefined };
    expect(() => validateAssetDefinition(anonymous)).toThrow(/provenance/);
  });

  it("rejects a minor-unit scale beyond the exact-integer bound", () => {
    const tooPrecise = { ...etherAssetDefinition(), minorUnitDigits: MAX_ASSET_MINOR_UNIT_DIGITS + 1 };
    expect(() => validateAssetDefinition(tooPrecise)).toThrow(/minorUnitDigits/);
  });

  it("rejects an invalid asset class and symbol", () => {
    expect(() =>
      validateAssetDefinition({ ...etherAssetDefinition(), assetClass: "MEMECOIN" }),
    ).toThrow(/assetClass/);
    expect(() =>
      validateAssetDefinition({ ...etherAssetDefinition(), symbol: "not a symbol!" }),
    ).toThrow(/symbol/);
  });

  it("a declared peg is a claim, never an assumption — malformed claims are rejected", () => {
    expect(() =>
      validateAssetDefinition({
        ...etherAssetDefinition(),
        declaredPeg: { pegKind: "DEFINITELY_PEGGED", declaredBy: "someone" },
      }),
    ).toThrow(/declaredPeg/);
  });
});

describe("exact asset amounts (INV-F01: no floating-point money)", () => {
  it("accepts exact non-negative integer minor units", () => {
    expect(() => validateAssetAmount({ assetId: "a", minorUnits: "0" })).not.toThrow();
    expect(() => validateAssetAmount({ assetId: "a", minorUnits: "123456789012345678" })).not.toThrow();
    expect(parseAssetAmountMinorUnits({ assetId: "a", minorUnits: "123456789012345678" })).toBe(
      123456789012345678n,
    );
  });

  it("rejects floating-point and malformed shapes", () => {
    for (const minorUnits of ["1.5", "1e7", "0x10", "-1", "007", "", "1 ", "12,5"]) {
      expect(() => validateAssetAmount({ assetId: "a", minorUnits })).toThrow(
        /minorUnits must be a non-negative integer decimal string/,
      );
    }
  });
});

describe("asset observations (external state — NEVER custody, NEVER a balance)", () => {
  it("validates a canonical observation with freshness, provenance and observer identity", () => {
    const observation = validateAssetObservation(etherAssetObservation());
    expect(observation.observationKind).toBe(ASSET_OBSERVATION_KIND);
    expect(observation.freshness.maxAgeSeconds).toBe(180);
    expect(observation.observer.observerId).toBe("observer:chain-node-001");
  });

  it("MANDATORY freshness: an observation without freshness is not evidence of anything", () => {
    const stale = { ...etherAssetObservation(), freshness: undefined };
    expect(() => validateAssetObservation(stale)).toThrow(/freshness is MANDATORY/);
  });

  it("MANDATORY provenance: an observation without provenance is rejected", () => {
    const anonymous = { ...etherAssetObservation(), provenance: undefined };
    expect(() => validateAssetObservation(anonymous)).toThrow(/provenance is MANDATORY/);
  });

  it("MANDATORY observer identity: an observation without an observer is rejected", () => {
    const unobserved = { ...etherAssetObservation(), observer: undefined };
    expect(() => validateAssetObservation(unobserved)).toThrow(/observer identity is MANDATORY/);
  });

  it("the nominal observation brand separates observations from ledger/balance types", () => {
    const unbranded = { ...etherAssetObservation(), observationKind: "Balance" };
    expect(() => validateAssetObservation(unbranded)).toThrow(/observationKind/);
  });

  it("location chainKey must match the observation chainKey", () => {
    const mismatched = {
      ...etherAssetObservation(),
      location: { ...etherAssetObservation().location, chainKey: "solana:mainnet-beta" },
    };
    expect(() => validateAssetObservation(mismatched)).toThrow(/location.chainKey must match/);
  });

  it("the observed amount is denominated in the observed asset", () => {
    const crossAsset = {
      ...etherAssetObservation(),
      observedAmount: { currency: "ethereum:mainnet/asset:USDC", minorUnits: "100" },
    };
    expect(() => validateAssetObservation(crossAsset)).toThrow(
      /observedAmount.currency must equal the observed assetId/,
    );
  });

  it("floating-point observed amounts are rejected (INV-F01)", () => {
    const floatAmount = {
      ...etherAssetObservation(),
      observedAmount: { currency: etherAssetObservation().assetId, minorUnits: "1.5" },
    };
    expect(() => validateAssetObservation(floatAmount)).toThrow(/observedAmount/);
  });

  it("an observation carries NO mutable balance-shaped field and no custody claim path", () => {
    const observation = etherAssetObservation();
    const keys = Object.keys(observation).sort();
    expect(keys).toEqual(
      [
        "assetId",
        "chainKey",
        "freshness",
        "location",
        "observedAmount",
        "observationId",
        "observationKind",
        "observedAt",
        "observer",
        "provenance",
      ].sort(),
    );
  });
});

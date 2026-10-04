import { describe, expect, it } from "vitest";
import { ValidationError } from "@payswap/protocol";
import { mapToRailOperation, validateAssetObservation, validateOnchainExecutionObservation } from "@payswap/onchain-domain";
import {
  assertNoSecretMaterial,
  prepareWrite,
  recordSimulation,
} from "@payswap/onchain-security";
import { InvalidWriteError } from "@payswap/onchain-security";
import {
  DiscoveryExecutionRejectedError,
  assertDiscoveryTier,
  discoveryPermitsExecution,
  discoverOpportunity,
  isDiscoveryTieredValue,
  rejectDiscoveryForExecution,
} from "../src/index.js";
import * as opportunityExports from "../src/index.js";
import {
  CHAIN,
  NOW,
  discoveryCatalog,
  healthyLiquidityObservation,
} from "./fixtures.js";

/**
 * P4-W3-002 hard requirement 1 (the agent-cannot-execute law):
 * discovery/recommendation is NEVER authorization. Opportunities carry NO
 * authority to execute; the existing authorization path (the W1-002 kernel:
 * prepare → simulate → policy → authorize → pre-broadcast recheck) is the
 * ONLY route to execution.
 *
 * Every proof below drives the REAL merged-kernel validators — no
 * lookalikes, no re-implementations:
 * - the kernel's prepare stage REJECTS opportunities as write requests;
 * - the kernel's observation validators REJECT opportunities as balances or
 *   execution observations;
 * - the settlement mapping REJECTS opportunities as settlement inputs;
 * - this package's export surface owns NO execution machinery;
 * - the structural discovery tier rejects every value at the execution gate.
 */
describe("P4-W3-002 the agent-cannot-execute law (discovery is never authorization)", () => {
  // -----------------------------------------------------------------------
  // The structural tier gate
  // -----------------------------------------------------------------------

  it("discoveryPermitsExecution() is false, always (a first-class law, not a comment)", () => {
    expect(discoveryPermitsExecution()).toBe(false);
    expect(discoveryPermitsExecution()).toBe(false);
    expect(discoveryPermitsExecution()).not.toBe(true);
  });

  it("rejectDiscoveryForExecution throws for EVERY catalog opportunity (all families)", () => {
    for (const entry of discoveryCatalog()) {
      const opportunity = discoverOpportunity(entry.input, NOW);
      expect(() => rejectDiscoveryForExecution(opportunity), entry.label).toThrow(
        DiscoveryExecutionRejectedError,
      );
      expect(() => rejectDiscoveryForExecution(opportunity), entry.label).toThrow(
        /never authorization/,
      );
    }
  });

  it("rejectDiscoveryForExecution throws even for non-tiered values and null (the gate passes nothing)", () => {
    expect(() => rejectDiscoveryForExecution({ some: "value" })).toThrow(
      DiscoveryExecutionRejectedError,
    );
    expect(() => rejectDiscoveryForExecution(null)).toThrow(DiscoveryExecutionRejectedError);
    expect(() => rejectDiscoveryForExecution("opportunity")).toThrow(
      DiscoveryExecutionRejectedError,
    );
  });

  it("every catalog opportunity carries the discovery tier (branded + re-derivable)", () => {
    for (const entry of discoveryCatalog()) {
      const opportunity = discoverOpportunity(entry.input, NOW);
      expect(isDiscoveryTieredValue(opportunity), entry.label).toBe(true);
      expect(() => assertDiscoveryTier(opportunity), entry.label).not.toThrow();
    }
  });

  it("the tier assertion rejects forgeries (fail closed, never guessed)", () => {
    expect(() => assertDiscoveryTier(null)).toThrow(ValidationError);
    expect(() => assertDiscoveryTier({})).toThrow(ValidationError);
    expect(() => assertDiscoveryTier({ discoveryTier: "PRODUCTION_AUTHORIZATION" })).toThrow(
      ValidationError,
    );
    expect(isDiscoveryTieredValue({ discoveryTier: "PRODUCTION_AUTHORIZATION" })).toBe(false);
    expect(isDiscoveryTieredValue("not an object")).toBe(false);
  });

  // -----------------------------------------------------------------------
  // The REAL kernel rejects opportunities at every entry point
  // -----------------------------------------------------------------------

  it("the REAL kernel prepare stage REJECTS an opportunity as a write request (every family)", () => {
    for (const entry of discoveryCatalog()) {
      const opportunity = discoverOpportunity(entry.input, NOW);
      expect(
        () => prepareWrite(opportunity as unknown as never, NOW),
        entry.label,
      ).toThrow(InvalidWriteError);
    }
  });

  it("the kernel prepare stage names the missing canonical write fields (fail-closed detail)", () => {
    const opportunity = discoverOpportunity(healthyLiquidityObservation(), NOW);
    expect(() => prepareWrite(opportunity as unknown as never, NOW)).toThrow(/writeId/);
  });

  it("the kernel prepare stage also rejects the JSON round-trip of an opportunity (no hidden closure authority)", () => {
    const opportunity = discoverOpportunity(healthyLiquidityObservation(), NOW);
    const roundTripped = JSON.parse(JSON.stringify(opportunity)) as unknown;
    expect(() => prepareWrite(roundTripped as never, NOW)).toThrow(InvalidWriteError);
  });

  it("the REAL kernel asset-observation validator REJECTS an opportunity (an opportunity is not a balance observation)", () => {
    for (const entry of discoveryCatalog()) {
      const opportunity = discoverOpportunity(entry.input, NOW);
      expect(
        () => validateAssetObservation(opportunity as unknown as never),
        entry.label,
      ).toThrow(ValidationError);
    }
  });

  it("the REAL kernel simulation recorder REJECTS an opportunity (not a kernel simulation)", () => {
    const opportunity = discoverOpportunity(healthyLiquidityObservation(), NOW);
    expect(() => recordSimulation(opportunity as unknown as never)).toThrow();
  });

  it("the REAL kernel execution-observation validator REJECTS an opportunity", () => {
    const opportunity = discoverOpportunity(healthyLiquidityObservation(), NOW);
    expect(() =>
      validateOnchainExecutionObservation(opportunity as unknown as never),
    ).toThrow();
  });

  it("the REAL settlement mapping REJECTS an opportunity (no rail operation, no settlement)", () => {
    const opportunity = discoverOpportunity(healthyLiquidityObservation(), NOW);
    expect(() =>
      mapToRailOperation({
        observation: opportunity as unknown as never,
        settlementInstructionId: "instr:forbidden",
        settlementAttemptId: "attempt:forbidden",
      }),
    ).toThrow();
  });

  it("the REAL kernel secret scanner accepts every opportunity (agent-facing artifacts are secret-free)", () => {
    for (const entry of discoveryCatalog()) {
      const opportunity = discoverOpportunity(entry.input, NOW);
      expect(
        () => assertNoSecretMaterial(opportunity, entry.label),
        entry.label,
      ).not.toThrow();
    }
  });

  // -----------------------------------------------------------------------
  // The authorization path EXISTS and stays separate (the ONLY route)
  // -----------------------------------------------------------------------

  it("the kernel prepare stage ACCEPTS a canonical write request — the one real route an opportunity does not carry", () => {
    // The W1-002 kernel path (prepare → simulate → policy → authorize →
    // pre-broadcast recheck) is the ONLY route to execution. A canonical
    // OnchainWriteRequest passes the REAL prepare stage — while an
    // opportunity, which carries none of these canonical fields, never
    // does. The contrast IS the law.
    const canonicalWriteRequest = {
      writeId: "write:contrast:001",
      action: "onchain.transfer",
      chain: CHAIN,
      transfer: {
        asset: {
          chain: CHAIN,
          assetId: "0xaaaa111111111111111111111111111111111111",
          symbol: "USC",
        },
        amount: { currency: "USC", minorUnits: "1000000" },
        from: "0x1111111111111111111111111111111111111111",
        to: "0x2222222222222222222222222222222222222222",
      },
      approvals: [],
      route: { routeId: "route:contrast:001", routeHash: "0x" + "ab".repeat(32) },
      expiry: NOW + 60_000,
      requestedBy: "principal:contrast",
    };
    const prepared = prepareWrite(canonicalWriteRequest, NOW);
    expect(prepared.writeId).toBe("write:contrast:001");
    expect(prepared.writeDigest.length).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // The package surface owns NO execution machinery
  // -----------------------------------------------------------------------

  it("the package export surface owns NO execution-verb machinery (prepare/execute/sign/broadcast/authorize/submit/transfer/approve/send)", () => {
    const forbiddenPrefixes: readonly string[] = [
      "prepare",
      "execute",
      "sign",
      "broadcast",
      "authorize",
      "submit",
      "transfer",
      "approve",
      "send",
    ];
    const offenders: string[] = [];
    for (const [exportName, exportValue] of Object.entries(opportunityExports)) {
      const lowerName = exportName.toLowerCase();
      if (
        (typeof exportValue === "function" || typeof exportValue === "object") &&
        forbiddenPrefixes.some((prefix) => lowerName.startsWith(prefix))
      ) {
        offenders.push(exportName);
      }
    }
    expect(offenders).toEqual([]);
    expect(Object.keys(opportunityExports).length).toBeGreaterThan(20);
  });

  it("opportunities are PURE DATA: JSON round-trips preserve every field (no closures, no authority)", () => {
    const opportunity = discoverOpportunity(healthyLiquidityObservation(), NOW);
    const roundTripped = JSON.parse(JSON.stringify(opportunity)) as typeof opportunity;
    expect(roundTripped).toEqual(opportunity);
    // And the pure-data copy still carries the tier and fails the gate.
    expect(isDiscoveryTieredValue(roundTripped)).toBe(true);
    expect(() => rejectDiscoveryForExecution(roundTripped)).toThrow(
      DiscoveryExecutionRejectedError,
    );
  });

  it("opportunities carry NO authorization-shaped field anywhere (deep key scan)", () => {
    const forbiddenFieldNames: readonly RegExp[] = [
      /^authorization$/i,
      /^authority$/i,
      /^credential/i,
      /^signature$/i,
      /^signed/i,
      /^permission/i,
      /^mandate$/i,
      /^secret/i,
      /^privateKey$/i,
      /^seedPhrase$/i,
      /^password$/i,
      /^apiKey$/i,
    ];
    function scanKeys(value: unknown, path: string, offenders: string[]): void {
      if (value === null || typeof value !== "object") {
        return;
      }
      for (const key of Object.keys(value as Record<string, unknown>)) {
        if (forbiddenFieldNames.some((pattern) => pattern.test(key))) {
          offenders.push(`${path}.${key}`);
        }
        scanKeys((value as Record<string, unknown>)[key], `${path}.${key}`, offenders);
      }
    }
    for (const entry of discoveryCatalog()) {
      const opportunity = discoverOpportunity(entry.input, NOW);
      const offenders: string[] = [];
      scanKeys(opportunity, entry.label, offenders);
      expect(offenders, entry.label).toEqual([]);
    }
  });
});

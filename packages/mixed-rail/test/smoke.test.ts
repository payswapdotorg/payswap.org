import { describe, expect, it } from "vitest";
import {
  LAB_EXECUTION_TIER,
  ONCHAIN_LANE_FAULT_KINDS,
  PACKAGE_NAME,
  assertLabExecutionTier,
  buildOnchainLaneEvidence,
  discoverOnchainLane,
  engineFromVenuePacks,
  executeOnchainLane,
  isLabTieredValue,
  labTierPermitsFinancialSettlement,
  laneEvidenceDigest,
  protocolInstanceForPack,
  rejectLabTierForFinancialSettlement,
} from "../src/index.js";
import { OnchainLaneDiscoveryError } from "../src/index.js";
import { LabTierSettlementRejectedError } from "../src/index.js";

/**
 * Smoke: the package's public surface is present and coherent.
 */
describe("@payswap/mixed-rail smoke", () => {
  it("exports the package identity", () => {
    expect(PACKAGE_NAME).toBe("@payswap/mixed-rail");
  });

  it("exports the tier law surface", () => {
    expect(LAB_EXECUTION_TIER).toBe("LAB_SIMULATION_NON_PRODUCTION");
    expect(labTierPermitsFinancialSettlement()).toBe(false);
    expect(typeof isLabTieredValue).toBe("function");
    expect(typeof assertLabExecutionTier).toBe("function");
    expect(typeof rejectLabTierForFinancialSettlement).toBe("function");
    expect(() => rejectLabTierForFinancialSettlement({})).toThrow(
      LabTierSettlementRejectedError,
    );
  });

  it("exports the lane machinery surface", () => {
    expect(typeof discoverOnchainLane).toBe("function");
    expect(typeof engineFromVenuePacks).toBe("function");
    expect(typeof protocolInstanceForPack).toBe("function");
    expect(typeof executeOnchainLane).toBe("function");
    expect(typeof buildOnchainLaneEvidence).toBe("function");
    expect(typeof laneEvidenceDigest).toBe("function");
    expect(() => new OnchainLaneDiscoveryError("x")).not.toThrow();
  });

  it("exports the fault vocabulary (closed, UNKNOWN included)", () => {
    expect(ONCHAIN_LANE_FAULT_KINDS).toEqual([
      "PROTOCOL_FAILURE",
      "UNFINALIZED_BROADCAST",
      "OUTCOME_UNKNOWN",
    ]);
  });
});

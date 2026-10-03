import { describe, expect, it } from "vitest";
import {
  ADAPTER_LIFECYCLE_STAGES,
  PACKAGE_NAME,
  RAIL_ENVIRONMENT_CLASSES,
  adapterObservationPermitsFinalityDeclaration,
  adapterSettlementEnvelope,
  assertEndpointProviderDiversity,
  classifyChainEnvironment,
  validateFamilySemanticsProfile,
} from "../src/index.js";

/** Smoke: the neutral SDK core surface exports the frozen contract. */
describe("package surface", () => {
  it("exports the frozen lifecycle vocabulary (nine stages)", () => {
    expect(PACKAGE_NAME).toBe("@payswap/onchain-adapters");
    expect(ADAPTER_LIFECYCLE_STAGES).toHaveLength(9);
    expect(ADAPTER_LIFECYCLE_STAGES).toContain("observe");
    expect(ADAPTER_LIFECYCLE_STAGES).toContain("finality");
    expect(ADAPTER_LIFECYCLE_STAGES).toContain("reconcile");
  });

  it("exports the structural environment vocabulary", () => {
    expect(RAIL_ENVIRONMENT_CLASSES).toContain("PRODUCTION");
    expect(RAIL_ENVIRONMENT_CLASSES).toContain("TESTNET");
    expect(classifyChainEnvironment("ethereum:mainnet")).toBe("PRODUCTION");
  });

  it("exports the transport ports and the endpoint diversity law", () => {
    expect(typeof assertEndpointProviderDiversity).toBe("function");
  });

  it("exports the settlement gate with the protocol-owned finality law", () => {
    expect(adapterObservationPermitsFinalityDeclaration()).toBe(false);
    expect(typeof adapterSettlementEnvelope).toBe("function");
  });

  it("exports the semantics validator", () => {
    expect(typeof validateFamilySemanticsProfile).toBe("function");
  });
});

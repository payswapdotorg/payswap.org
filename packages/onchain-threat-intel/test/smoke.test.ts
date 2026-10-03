import { describe, expect, it } from "vitest";
import { prepareWrite } from "@payswap/onchain-security";
import {
  PACKAGE_NAME,
  AdversarialTransactionAgent,
  evaluateThreatPolicy,
} from "../src/index.js";
import { AGENT_REF, NOW, baseThreatPolicy, baseWriteRequest, benignBundle } from "./helpers.js";

describe("smoke", () => {
  it("the package identifies itself", () => {
    expect(PACKAGE_NAME).toBe("@payswap/onchain-threat-intel");
  });

  it("a minimal end-to-end analysis run works", () => {
    const agent = new AdversarialTransactionAgent(AGENT_REF);
    const write = prepareWrite(baseWriteRequest(), NOW);
    const assessment = agent.analyze({
      write,
      policy: baseThreatPolicy(),
      bundle: benignBundle(),
      at: NOW,
    });
    const evaluation = evaluateThreatPolicy(assessment.signals, baseThreatPolicy());
    expect(evaluation.verdict).toBe("ALLOW");
    expect(assessment.agentRecommendation).toBe("ALLOW");
  });
});

import { describe, expect, it } from "vitest";
import * as bestExecution from "../src/index.js";

/** Smoke: the package surface (all exports present and callable). */
describe("@payswap/best-execution smoke", () => {
  it("declares its package name", () => {
    expect(bestExecution.PACKAGE_NAME).toBe("@payswap/best-execution");
  });

  it("exports the core vocabulary", () => {
    expect(typeof bestExecution.BestExecutionEngine).toBe("function");
    expect(typeof bestExecution.RouteExecutionRecord).toBe("function");
    expect(typeof bestExecution.evaluateNetOutcome).toBe("function");
    expect(typeof bestExecution.rankCandidates).toBe("function");
    expect(typeof bestExecution.checkSelectedRouteValidity).toBe("function");
    expect(typeof bestExecution.validateBestExecutionPolicy).toBe("function");
    expect(typeof bestExecution.validateVenueQuote).toBe("function");
    expect(typeof bestExecution.validateSwapRequest).toBe("function");
    expect(typeof bestExecution.isQuoteStale).toBe("function");
  });

  it("the error taxonomy is exported", () => {
    expect(typeof bestExecution.VenueRegistryError).toBe("function");
    expect(typeof bestExecution.ExecutionTransitionError).toBe("function");
    expect(typeof bestExecution.RouteInvalidatedError).toBe("function");
  });
});

import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "../src/index.js";
import { compileBase, route1Intent, route2Intent, route3Intent, route4Intent } from "./fixtures.js";

describe("@payswap/route-compiler smoke", () => {
  it("exposes the package name", () => {
    expect(PACKAGE_NAME).toBe("@payswap/route-compiler");
  });

  it("compiles route 1 (crypto→DEX→stable→off-ramp→bank) through the real kernels", () => {
    const result = compileBase(route1Intent());
    expect(result.status).toBe("ROUTES_COMPILED");
    for (const plan of result.plans) {
      console.log(
        `[route-1] plan ${plan.shapeId}: status=${plan.candidateStatus} legs=[${plan.legs
          .map((leg) => leg.legKind)
          .join(" -> ")}] ineligible=${plan.ineligibilityReasons.length}`,
      );
    }
    for (const exclusion of result.exclusions) {
      console.log(`[route-1] excluded ${exclusion.shapeId}: ${exclusion.reasons.join(" | ")}`);
    }
  });

  it("compiles route 2 (fiat→PSP→stablecoin→chain→recipient)", () => {
    const result = compileBase(route2Intent());
    for (const plan of result.plans) {
      console.log(
        `[route-2] plan ${plan.shapeId}: status=${plan.candidateStatus} legs=[${plan.legs
          .map((leg) => leg.legKind)
          .join(" -> ")}]`,
      );
    }
    for (const exclusion of result.exclusions) {
      console.log(`[route-2] excluded ${exclusion.shapeId}: ${exclusion.reasons.join(" | ")}`);
    }
  });

  it("compiles route 3 (chainA→DEX→bridge→chainB)", () => {
    const result = compileBase(route3Intent());
    for (const plan of result.plans) {
      console.log(
        `[route-3] plan ${plan.shapeId}: status=${plan.candidateStatus} legs=[${plan.legs
          .map((leg) => leg.legKind)
          .join(" -> ")}]`,
      );
    }
    for (const exclusion of result.exclusions) {
      console.log(`[route-3] excluded ${exclusion.shapeId}: ${exclusion.reasons.join(" | ")}`);
    }
  });

  it("compiles route 4 (eligible crypto→native Stripe settlement + Mode B)", () => {
    const result = compileBase(route4Intent());
    for (const plan of result.plans) {
      console.log(
        `[route-4] plan ${plan.shapeId}: status=${plan.candidateStatus} legs=[${plan.legs
          .map((leg) => leg.legKind)
          .join(" -> ")}]`,
      );
    }
    for (const exclusion of result.exclusions) {
      console.log(`[route-4] excluded ${exclusion.shapeId}: ${exclusion.reasons.join(" | ")}`);
    }
  });
});

import { describe, expect, it } from "vitest";
import {
  PACKAGE_LIFECYCLE,
  PackageLifecycleError,
  canTransitionPackage,
  transitionPackage,
} from "../src/index.js";
import type { AgentPackage } from "../src/index.js";

/**
 * FROZEN-ARCHITECTURE §13 lifecycle:
 * DRAFT → STATIC_ANALYSIS → BENCHMARKED → SECURITY_REVIEW → CERTIFIED →
 * AVAILABLE → SUSPENDED → RETIRED. Skipping states is rejected; AVAILABLE↔
 * SUSPENDED is allowed in both directions; RETIRED is terminal.
 */

function makePackage(): AgentPackage {
  return {
    id: "pkg:payer-agent",
    version: 1,
    bodies: [{ id: "body:payer", version: 1 }],
    organizationTemplates: [{ templateId: "org:payops", version: 1 }],
    requiredExtensions: [{ extensionId: "ext:fx-quotes", version: "1.0.0" }],
    securityEpochRequirements: { requireCurrentEpoch: true },
    runtimeRequirements: { minRuntimeContractVersion: 1, requiredOperations: ["execute", "checkpoint"] },
    modelCompatibility: { interfaceVersion: 1 },
    evaluationSuiteRef: "evalsuite:payer@sha256:abc",
    provenance: { source: "https://github.com/payswapdotorg/payswap.org", contentHash: "fnv1a64:00ff", createdAt: 1_000_000 },
    lifecycle: "DRAFT",
  };
}

describe("AgentPackage lifecycle", () => {
  it("walks the full valid path step by step to RETIRED", () => {
    let pkg = makePackage();
    const seen: string[] = [pkg.lifecycle];
    for (const next of PACKAGE_LIFECYCLE.slice(1)) {
      pkg = transitionPackage(pkg, next);
      seen.push(pkg.lifecycle);
    }
    expect(seen).toEqual([...PACKAGE_LIFECYCLE]);
  });

  it("rejects skipping states", () => {
    expect(() => transitionPackage(makePackage(), "BENCHMARKED")).toThrow(PackageLifecycleError);
    expect(() => transitionPackage(makePackage(), "AVAILABLE")).toThrow(/skipping|allowed targets/i);
    // SUSPENDED -> AVAILABLE (backwards) is allowed, so AVAILABLE -> RETIRED is the skip case
    const suspended = [ "STATIC_ANALYSIS", "BENCHMARKED", "SECURITY_REVIEW", "CERTIFIED", "AVAILABLE", "SUSPENDED" ].reduce(
      (pkg, next) => transitionPackage(pkg, next as AgentPackage["lifecycle"]),
      makePackage(),
    );
    // SUSPENDED -> RETIRED is legal (single step)
    expect(() => transitionPackage(suspended, "RETIRED")).not.toThrow();
  });

  it("rejects AVAILABLE -> RETIRED (must pass through SUSPENDED)", () => {
    const available = ["STATIC_ANALYSIS", "BENCHMARKED", "SECURITY_REVIEW", "CERTIFIED", "AVAILABLE"].reduce(
      (pkg, next) => transitionPackage(pkg, next as AgentPackage["lifecycle"]),
      makePackage(),
    );
    expect(() => transitionPackage(available, "RETIRED")).toThrow(PackageLifecycleError);
  });

  it("allows the AVAILABLE <-> SUSPENDED toggle in both directions", () => {
    const available = ["STATIC_ANALYSIS", "BENCHMARKED", "SECURITY_REVIEW", "CERTIFIED", "AVAILABLE"].reduce(
      (pkg, next) => transitionPackage(pkg, next as AgentPackage["lifecycle"]),
      makePackage(),
    );
    const suspended = transitionPackage(available, "SUSPENDED");
    expect(suspended.lifecycle).toBe("SUSPENDED");
    const restored = transitionPackage(suspended, "AVAILABLE");
    expect(restored.lifecycle).toBe("AVAILABLE");
  });

  it("RETIRED is terminal: every transition out of it is rejected", () => {
    const retired = [...PACKAGE_LIFECYCLE.slice(1)].reduce(
      (pkg, next) => transitionPackage(pkg, next as AgentPackage["lifecycle"]),
      makePackage(),
    );
    expect(retired.lifecycle).toBe("RETIRED");
    for (const target of PACKAGE_LIFECYCLE) {
      if (target === "RETIRED") {
        continue;
      }
      expect(() => transitionPackage(retired, target)).toThrow(PackageLifecycleError);
    }
    expect(() => transitionPackage(retired, "RETIRED")).toThrow(/terminal/i);
  });

  it("transitionPackage is immutable: it returns a new package", () => {
    const draft = makePackage();
    const analyzed = transitionPackage(draft, "STATIC_ANALYSIS");
    expect(draft.lifecycle).toBe("DRAFT");
    expect(analyzed.lifecycle).toBe("STATIC_ANALYSIS");
    expect(analyzed).not.toBe(draft);
  });

  it("canTransitionPackage mirrors transitionPackage exactly", () => {
    expect(canTransitionPackage("DRAFT", "STATIC_ANALYSIS")).toBe(true);
    expect(canTransitionPackage("DRAFT", "CERTIFIED")).toBe(false);
    expect(canTransitionPackage("AVAILABLE", "SUSPENDED")).toBe(true);
    expect(canTransitionPackage("SUSPENDED", "AVAILABLE")).toBe(true);
    expect(canTransitionPackage("RETIRED", "DRAFT")).toBe(false);
  });
});

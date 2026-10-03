import { describe, expect, it } from "vitest";
import { evaluateOnchainWriteGates, prepareWrite } from "@payswap/onchain-security";
import type { GateDecision } from "@payswap/onchain-security";
import {
  AgentVerdictOverrideForbiddenError,
  THREAT_VERDICTS,
  attachThreatAssessment,
  attemptAgentVerdictOverride,
  composeThreatVerdict,
  resolveOnchainSecurityDecision,
  threatSignalsToAgentFlags,
} from "../src/index.js";
import type { ThreatRecommendation } from "../src/index.js";
import { AdversarialTransactionAgent } from "../src/index.js";
import {
  AGENT_REF,
  MALICIOUS_SPENDER,
  NOW,
  ROUTER,
  baseKernelPolicy,
  baseSecurityState,
  baseThreatPolicy,
  baseWriteRequest,
  benignBundle,
  canonicalApproval,
  consistentSimulation,
} from "./helpers.js";

/**
 * THE NO-DOWNGRADE SEAM (task packet hard requirement 2; AGENTS.md rule
 * 27): "the W1-002 kernel law (security_agent_cannot_override_block)
 * extends to the adversarial agent: an agent BLOCK stays BLOCK; an agent
 * ALLOW can still be overridden to BLOCK by deterministic policy. Tests
 * must attack exactly this seam."
 *
 * The full cartesian product of (agent recommendation × policy verdict)
 * and (kernel decision × threat verdict) is swept. A downgrade anywhere
 * fails the suite.
 */

describe("composeThreatVerdict — the full lattice sweep (agent × policy)", () => {
  const RECOMMENDATIONS: readonly ThreatRecommendation[] = [
    "ALLOW",
    "ALLOW_WITH_CONSTRAINTS",
    "REQUIRE_CONFIRMATION",
    "BLOCK",
  ];

  it("AGENT BLOCK stays BLOCK against EVERY policy verdict (no downgrade, ever)", () => {
    for (const policyVerdict of THREAT_VERDICTS) {
      expect(composeThreatVerdict("BLOCK", policyVerdict)).toBe("BLOCK");
    }
  });

  it("POLICY BLOCK overrides EVERY non-BLOCK agent recommendation (policy is authoritative)", () => {
    for (const agentRec of RECOMMENDATIONS.filter((r) => r !== "BLOCK")) {
      expect(composeThreatVerdict(agentRec, "BLOCK")).toBe("BLOCK");
    }
  });

  it("the full cartesian product is the lattice join (no cell can downgrade either side)", () => {
    const rank = (v: string) =>
      v === "BLOCK" ? 3 : v === "REQUIRE_CONFIRMATION" ? 2 : v === "ALLOW_WITH_CONSTRAINTS" ? 1 : 0;
    for (const agentRec of RECOMMENDATIONS) {
      for (const policyVerdict of THREAT_VERDICTS) {
        const composed = composeThreatVerdict(agentRec, policyVerdict);
        // The composed verdict is at least as restrictive as BOTH inputs.
        expect(rank(composed)).toBeGreaterThanOrEqual(rank(agentRec));
        expect(rank(composed)).toBeGreaterThanOrEqual(rank(policyVerdict));
        // And it is exactly the stricter of the two (deterministic join).
        expect(rank(composed)).toBe(Math.max(rank(agentRec), rank(policyVerdict)));
      }
    }
  });

  it("agent ALLOW + policy REQUIRE_CONFIRMATION → REQUIRE_CONFIRMATION (agent cannot soften)", () => {
    expect(composeThreatVerdict("ALLOW", "REQUIRE_CONFIRMATION")).toBe(
      "REQUIRE_CONFIRMATION",
    );
    expect(composeThreatVerdict("ALLOW_WITH_CONSTRAINTS", "ALLOW")).toBe(
      "ALLOW_WITH_CONSTRAINTS",
    );
  });
});

describe("attemptAgentVerdictOverride — the rejection is the contract", () => {
  it("ALWAYS throws, for every verdict value (mirrors the kernel attemptAgentOverride)", () => {
    for (const verdict of THREAT_VERDICTS) {
      expect(() => attemptAgentVerdictOverride(verdict, AGENT_REF)).toThrow(
        AgentVerdictOverrideForbiddenError,
      );
    }
  });

  it("the error carries the attempted verdict and the claiming agent", () => {
    try {
      attemptAgentVerdictOverride("BLOCK", "agent:malicious-9");
      expect.unreachable("must throw");
    } catch (error) {
      const forbidden = error as AgentVerdictOverrideForbiddenError;
      expect(forbidden.attemptedVerdict).toBe("BLOCK");
      expect(forbidden.message).toContain("agent:malicious-9");
      expect(forbidden.message).toContain("rule 27");
    }
  });
});

describe("resolveOnchainSecurityDecision — kernel × threat composition", () => {
  const ROUTE_X = "fnv1a64:0000000000000099";

  function kernelDecisionOf(decision: GateDecision["decision"]): GateDecision {
    // Build REAL kernel decisions for all three values (ALLOW via the
    // healthy write, BLOCK via a forbidden spender, UNKNOWN via an
    // uncertified route under escalate policy).
    if (decision === "BLOCK") {
      const write = prepareWrite(
        baseWriteRequest({
          approvals: [canonicalApproval({ spender: MALICIOUS_SPENDER })],
        }),
        NOW,
      );
      return evaluateOnchainWriteGates({
        write,
        policy: baseKernelPolicy(),
        securityState: baseSecurityState(),
        at: NOW,
      });
    }
    if (decision === "UNKNOWN") {
      const write = prepareWrite(
        baseWriteRequest({
          route: { routeId: "route-2", routeHash: "fnv1a64:0000000000000002" },
        }),
        NOW,
      );
      return evaluateOnchainWriteGates({
        write,
        policy: baseKernelPolicy({ unknownRoutePolicy: "escalate", knownRoutes: [ROUTE_X] }),
        securityState: baseSecurityState(),
        at: NOW,
      });
    }
    const write = prepareWrite(baseWriteRequest(), NOW);
    return evaluateOnchainWriteGates({
      write,
      simulation: consistentSimulation(write.writeId),
      policy: baseKernelPolicy(),
      securityState: baseSecurityState(),
      at: NOW,
    });
  }

  it("kernel BLOCK is TERMINAL against every threat verdict", () => {
    for (const threatVerdict of THREAT_VERDICTS) {
      const resolution = resolveOnchainSecurityDecision({
        kernelDecision: kernelDecisionOf("BLOCK"),
        threatVerdict,
      });
      expect(resolution.decision).toBe("BLOCK");
      expect(resolution.basis.join(" ")).toContain("kernel:BLOCK:terminal");
    }
  });

  it("threat BLOCK binds even when the kernel said ALLOW (the adversarial extension)", () => {
    for (const threatVerdict of THREAT_VERDICTS.filter((v) => v !== "BLOCK")) {
      expect(
        resolveOnchainSecurityDecision({
          kernelDecision: kernelDecisionOf("ALLOW"),
          threatVerdict,
        }).decision,
      ).toBe(threatVerdict);
    }
    const resolution = resolveOnchainSecurityDecision({
      kernelDecision: kernelDecisionOf("ALLOW"),
      threatVerdict: "BLOCK",
    });
    expect(resolution.decision).toBe("BLOCK");
    expect(resolution.basis.join(" ")).toContain("threat:BLOCK:binding");
  });

  it("kernel UNKNOWN is NEVER agent-allowed: the floor is REQUIRE_CONFIRMATION (INV-X01)", () => {
    for (const threatVerdict of THREAT_VERDICTS) {
      const resolution = resolveOnchainSecurityDecision({
        kernelDecision: kernelDecisionOf("UNKNOWN"),
        threatVerdict,
      });
      const rank =
        resolution.decision === "BLOCK"
          ? 3
          : resolution.decision === "REQUIRE_CONFIRMATION"
            ? 2
            : resolution.decision === "ALLOW_WITH_CONSTRAINTS"
              ? 1
              : 0;
      expect(rank).toBeGreaterThanOrEqual(2);
    }
    expect(
      resolveOnchainSecurityDecision({
        kernelDecision: kernelDecisionOf("UNKNOWN"),
        threatVerdict: "ALLOW",
      }).decision,
    ).toBe("REQUIRE_CONFIRMATION");
  });

  it("kernel ALLOW + threat ALLOW stays ALLOW (no false positives)", () => {
    expect(
      resolveOnchainSecurityDecision({
        kernelDecision: kernelDecisionOf("ALLOW"),
        threatVerdict: "ALLOW",
      }).decision,
    ).toBe("ALLOW");
  });

  it("the full kernel × threat sweep: every cell is at least as restrictive as both inputs", () => {
    const rank = (v: string) =>
      v === "BLOCK" ? 3 : v === "REQUIRE_CONFIRMATION" ? 2 : v === "ALLOW_WITH_CONSTRAINTS" ? 1 : 0;
    const kernelRank: Record<GateDecision["decision"], number> = {
      BLOCK: 3,
      UNKNOWN: 2, // treated as at-least-REQUIRE_CONFIRMATION
      ALLOW: 0,
    };
    for (const kernel of ["ALLOW", "BLOCK", "UNKNOWN"] as const) {
      for (const threat of THREAT_VERDICTS) {
        const resolution = resolveOnchainSecurityDecision({
          kernelDecision: kernelDecisionOf(kernel),
          threatVerdict: threat,
        });
        expect(rank(resolution.decision)).toBeGreaterThanOrEqual(kernelRank[kernel]);
        expect(rank(resolution.decision)).toBeGreaterThanOrEqual(rank(threat));
      }
    }
  });
});

describe("the kernel flag channel (advisory only, never mutation)", () => {
  const agent = new AdversarialTransactionAgent(AGENT_REF);
  const write = prepareWrite(
    baseWriteRequest({
      approvals: [canonicalApproval({ spender: MALICIOUS_SPENDER })],
    }),
    NOW,
  );
  const assessment = agent.analyze({
    write,
    policy: baseThreatPolicy(),
    bundle: benignBundle(),
    at: NOW,
  });

  it("every signal projects onto a kernel flag that LINKS its evidence", () => {
    const flags = threatSignalsToAgentFlags(assessment);
    expect(flags.length).toBe(assessment.signals.length);
    for (const flag of flags) {
      expect(flag.flaggedBy).toBe(AGENT_REF);
      expect(flag.flagId.startsWith("flag:")).toBe(true);
      expect(flag.note).toContain("evidence=(obs:");
      expect(flag.note).toContain("digest:");
    }
  });

  it("attachThreatAssessment records flags and NEVER mutates the decision", () => {
    const kernelDecision = evaluateOnchainWriteGates({
      write,
      policy: baseKernelPolicy(),
      securityState: baseSecurityState(),
      at: NOW,
    });
    expect(kernelDecision.decision).toBe("BLOCK");
    const evaluation = { decision: kernelDecision, flags: [] as never[] };
    const flagged = attachThreatAssessment(evaluation, assessment);
    expect(flagged.decision).toBe(kernelDecision); // the SAME object
    expect(flagged.flags.length).toBe(assessment.signals.length);
    expect(evaluation.flags.length).toBe(0); // input untouched
  });

  it("an ALLOW decision stays ALLOW with flags attached (advisory channel only)", () => {
    const healthyWrite = prepareWrite(baseWriteRequest(), NOW);
    const healthyKernel = evaluateOnchainWriteGates({
      write: healthyWrite,
      simulation: consistentSimulation(healthyWrite.writeId),
      policy: baseKernelPolicy(),
      securityState: baseSecurityState(),
      at: NOW,
    });
    // A hypothetical low-severity assessment (hand-built): flags attach to
    // an ALLOW decision without changing it.
    const lowAssessment = agent.analyze({
      write: healthyWrite,
      policy: baseThreatPolicy({ allowedSpenders: [ROUTER, MALICIOUS_SPENDER] }),
      bundle: benignBundle(),
      at: NOW,
    });
    const evaluation = { decision: healthyKernel, flags: [] as never[] };
    const flagged = attachThreatAssessment(evaluation, lowAssessment);
    expect(flagged.decision.decision).toBe("ALLOW");
    expect(flagged.flags.length).toBe(lowAssessment.signals.length);
  });
});

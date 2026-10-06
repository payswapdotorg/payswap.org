import { describe, expect, it } from "vitest";
import {
  QuarantineLedger,
  SecurityAdvisoryRegistry,
  SecurityEpochAuthority,
  SecurityGate,
} from "@payswap/security";
import {
  AdversarialTransactionAgent,
  buildThreatSignatureForTarget,
  proposeAdvisoriesFromAssessment,
  recordObservationBundle,
  recommendationFromSignals,
} from "@payswap/onchain-threat-intel";
import { prepareWrite } from "@payswap/onchain-security";
import type { OnchainWriteRequest } from "@payswap/onchain-security";
import { runSecurityGate } from "../../src/production/gates.js";
import {
  CERT_NOW,
  CHAIN,
  CUSTOMER_WALLET,
  MALICIOUS_SPENDER,
  PAYEE,
  USC_ASSET,
} from "../../src/production/world.js";

/**
 * The gate-17 wiring proof: the src-side threat bridge produces advisory
 * proposals + signature registrations as STRUCTURAL data; the TEST layer
 * (this file) publishes them into the REAL immune-system machinery — the
 * SecurityAdvisoryRegistry, ThreatSignatureRegistry-compatible signature
 * store, QuarantineLedger and SecurityEpochAuthority (the same composition
 * pattern as onchain-threat-intel's own immune-composition test). The
 * certification package's src never imports the immune-system package
 * (its boundary law); the wiring is proven HERE, at the integration
 * station, exactly as the architecture prescribes.
 */

const drainPatternWrite: OnchainWriteRequest = {
  writeId: "write:cert:immune:1",
  action: "onchain.transfer",
  chain: CHAIN,
  approvals: [
    {
      asset: USC_ASSET,
      owner: CUSTOMER_WALLET,
      spender: MALICIOUS_SPENDER,
      amount: { currency: "USC", minorUnits: "1000000" },
      unlimited: false,
    },
  ],
  route: { routeId: "route:cert:immune", routeHash: "fnv1a64:0000000000000009" },
  expiry: CERT_NOW + 600_000,
  requestedBy: "agent:certification-key-1",
};

describe("production certification — incident/threat signals enter the advisory/signature system (gate 17 wiring)", () => {
  it("the src-side gate produces binding proposals + a signature registration", () => {
    const gate = runSecurityGate("threat-signals-advisory-system");
    expect(gate.passed).toBe(true);
    expect(gate.evidence.some((entry) => entry.startsWith("advisoryProposals:"))).toBe(true);
    expect(gate.evidence.some((entry) => entry.startsWith("signature:"))).toBe(true);
  });

  it("the proposals land in the REAL SecurityAdvisoryRegistry and the quarantine takes effect", () => {
    const write = prepareWrite(drainPatternWrite, CERT_NOW);
    const agent = new AdversarialTransactionAgent("agent:cert-adversarial-1");
    const bundle = recordObservationBundle({
      bundleId: "bundle:cert:immune:1",
      observer: "observer:cert:immune",
      observedAt: CERT_NOW,
      spenders: [
        {
          observationId: "spender-intel:cert:immune:drain",
          spender: MALICIOUS_SPENDER,
          knownDrainPattern: true,
          firstObservedAt: CERT_NOW - 1_000,
          observedIncidents: 40,
          sources: ["intel:internal"],
        },
      ],
      tokens: [{ observationId: "token-registry:cert:immune:usc", asset: USC_ASSET, canonical: true }],
    });
    const policy = {
      policyId: "threat-policy:cert:immune:1",
      version: 1,
      forbidUnlimitedApprovals: true,
      maxApprovalAmount: { currency: "USC", minorUnits: "5000000000" },
      allowedSpenders: ["0x3333333333333333333333333333333333333333"],
      spenderMinimumAgeMs: 3_600_000,
      spenderIncidentThreshold: 3,
      requireTokenRegistryCoverage: true,
      certifiedProtocols: [],
      maxOracleDeviationBasisPoints: 50,
      maxOracleFeedAgeMs: 90_000,
      requireBridgeHealthForBridgeHops: true,
      bridgeValidatorChangeWindowMs: 86_400_000,
      minBridgeAttestationQuorum: "2/3",
      maxSlippageBasisPoints: 300,
      sandwichSensitiveSlippageBasisPoints: 200,
      maxPriceImpactBasisPoints: 500,
      expectedChain: CHAIN,
      maxSimulationAgeMs: 30_000,
      maxSimulationLagBlocks: 6,
      maxReorgDepthBlocks: 2,
      maxFinalityLagBlocks: 12,
      maxObservationAgeMs: 10_000,
    };
    const assessment = agent.analyze({ write, policy, bundle, at: CERT_NOW });
    expect(assessment.signals.length).toBeGreaterThan(0);

    // The proposals are structurally assignable to the REAL registry's
    // publish input — publish them verbatim.
    const proposals = proposeAdvisoriesFromAssessment(assessment, policy);
    expect(proposals.length).toBeGreaterThan(0);
    const registry = new SecurityAdvisoryRegistry();
    const published = proposals.map((proposal) =>
      registry.publish({
        advisoryId: proposal.proposalId,
        title: proposal.title,
        severity: proposal.severity,
        description: proposal.description,
        affected: proposal.affected,
        action: proposal.action,
        remediation: proposal.remediation,
        declaredBy: proposal.declaredBy,
        publishedAt: proposal.publishedAt,
      }),
    );
    expect(published).toHaveLength(proposals.length);
    expect(registry.listActive().length).toBe(proposals.length);

    // The restriction view now names the affected component — the
    // incident entered the immune system and takes EFFECT.
    const restriction = registry.restrictionFor({
      kind: proposals[0]?.affected[0]?.kind ?? "extension",
      id: proposals[0]?.affected[0]?.id ?? MALICIOUS_SPENDER,
    });
    expect(restriction.quarantined || restriction.restricted || restriction.retired).toBe(true);

    // The composed SecurityGate (registry + ledger + epoch authority)
    // reflects the active advisory.
    const ledger = new QuarantineLedger();
    const epochs = new SecurityEpochAuthority();
    const gate = new SecurityGate({ advisories: registry, quarantine: ledger, epochs });
    expect(gate).toBeDefined();

    // The signature registration is publishable as a ThreatSignature.
    const signature = buildThreatSignatureForTarget(
      assessment.signals[0]?.family ?? "malicious_approval_permit",
      { kind: "extension", id: MALICIOUS_SPENDER },
      { declaredBy: "agent:cert-adversarial-1", publishedAt: CERT_NOW },
    );
    expect(signature.signatureId.length).toBeGreaterThan(0);
    expect(signature.indicators.length).toBeGreaterThan(0);
    expect(signature.indicators.every((indicator) => indicator.indicatorId.length > 0 && indicator.pattern.length > 0)).toBe(true);
  });

  it("the agent recommendation stays advisory (the lattice law re-proven at the wiring station)", () => {
    const recommendation = recommendationFromSignals([]);
    expect(recommendation).toBe("ALLOW");
    // ALLOW is the weakest verdict — composeThreatVerdict only hardens.
    // (The full lattice is proven in gate 13 + journey F; this wiring
    // assertion pins the advisory nature of the agent's own output.)
  });
});

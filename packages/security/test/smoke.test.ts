import { describe, expect, it } from "vitest";
import {
  PACKAGE_NAME,
  SecurityAdvisoryRegistry,
  SecurityEpochAuthority,
  QuarantineLedger,
  SecurityGate,
  ThreatSignatureRegistry,
  CapabilityCaseLedger,
  ExpertResolutionLedger,
  ExpertTaskBoard,
} from "@payswap/security";

/**
 * Smoke: the composed immune system end-to-end — signature → case →
 * advisory → enforcement (quarantine + epoch) → expert dispatch → versioned
 * resolution → evidence artifact.
 */

describe("@payswap/security smoke", () => {
  it("exports the package name", () => {
    expect(PACKAGE_NAME).toBe("@payswap/security");
  });

  it("the full immune-response journey is deterministic and composes", () => {
    // 1. A threat signature detects a vulnerable extension.
    const signatures = new ThreatSignatureRegistry();
    signatures.register({
      signatureId: "sig-1",
      kind: "vulnerable_extension",
      title: "Token sink in fx-router",
      description: "Emits Authorization tokens to an unaffiliated sink",
      affected: { kind: "extension", id: "ext:fx-router" },
      indicators: [{ indicatorId: "ind-1", kind: "token_family", pattern: "Authorization" }],
      declaredBy: "coordinator-disclosure",
      publishedAt: 100,
    });
    const matched = signatures.matchObservation({
      component: { kind: "extension", id: "ext:fx-router", version: "1.0.0" },
      tokenFamily: "Authorization",
    });
    expect(matched.map((signature) => signature.signatureId)).toEqual(["sig-1"]);

    // 2. A capability case records the incident (INV-S04).
    const cases = new CapabilityCaseLedger();
    const record = cases.open({
      caseId: "case-1",
      kind: "incident",
      title: "Authorization tokens leaving the boundary",
      component: { kind: "extension", id: "ext:fx-router", version: "1.0.0" },
      signal: {
        signalKind: "package_behavior",
        observedAt: 150,
        detail: "Authorization token emitted to external sink",
        sourceRef: "runtime:token-monitor",
      },
      evidence: [
        { evidenceId: "ev-1", artifactRef: "artifact:trace-1", contentDigest: "fnv1a64:a" },
      ],
      matchedSignatureRefs: ["sig-1"],
      openedAt: 200,
    });

    // 3. An advisory restricts + quarantines the component globally.
    const advisories = new SecurityAdvisoryRegistry();
    const advisory = advisories.publish({
      advisoryId: "adv-1",
      title: "Token exfiltration in fx-router",
      severity: "critical",
      description: "d",
      affected: [
        { kind: "extension", id: "ext:fx-router" },
        { kind: "agent_key", id: "sha256:agent-key-1" },
      ],
      action: "quarantine",
      remediation: { summary: "Revoke and replace", workarounds: [] },
      declaredBy: "security-coordinator",
      publishedAt: 300,
    });

    // 4. The gate enforces it: quarantine + (opt-in) epoch advance.
    const gate = new SecurityGate({
      advisories,
      quarantine: new QuarantineLedger(),
      epochs: new SecurityEpochAuthority(),
    });
    const enforcement = gate.enforceAdvisory(advisory, { advanceEpoch: true });
    expect(enforcement.quarantinedComponents).toHaveLength(2);
    expect(gate.epochs.currentEpoch().value).toBe(1n);

    // 5. A cached AVAILABLE cannot bypass the quarantine (INV-S03) and a
    //    stale epoch-scoped authorization is dead (INV-S02/A02).
    expect(
      gate.authorizeCapabilityUse({
        capabilityId: "cap:fx-route",
        sourceId: "source:alpha",
        effectiveAvailability: "AVAILABLE",
        providedBy: [{ kind: "extension", id: "ext:fx-router" }],
      }).decision,
    ).toBe("REJECT");
    expect(() =>
      gate.checkSensitiveAction({
        authorization: {
          authorizationRef: "auth:1",
          principalRef: "user:alice",
          agentRef: "sha256:agent-key-1",
          actionClass: "money_movement",
          issuedAtEpoch: 0n,
          expiresAt: 1_000_000,
        },
        at: 400,
      }),
    ).toThrow();

    // 6. The escalated case is dispatched to a qualified expert and the
    //    resolution is versioned evidence (INV-L04).
    const board = new ExpertTaskBoard();
    cases.escalate({ caseId: record.caseId, at: 350 });
    const task = board.dispatch({
      taskId: "task-1",
      case: cases.byId("case-1")!,
      requirements: [{ skillId: "security-forensics", minLevel: "expert" }],
      experts: [
        {
          expertId: "expert:1",
          displayName: "E",
          qualifications: [
            {
              skillId: "security-forensics",
              level: "expert",
              qualificationEvidence: {
                evidenceId: "qev",
                artifactRef: "artifact:cert",
                contentDigest: "fnv1a64:b",
              },
            },
          ],
          jurisdictions: [],
          active: true,
        },
      ],
      at: 400,
    });
    const resolutions = new ExpertResolutionLedger();
    resolutions.recordResolution({
      task,
      expertId: "expert:1",
      findings: ["confirmed exfiltration"],
      recommendation: "retire the extension line",
      evidence: record.evidence,
      resolvedAt: 500,
    });
    expect(resolutions.currentForTask("task-1")?.version).toBe(1);
    // Learning feed captured the whole incident history.
    expect(cases.learningFeed().length).toBeGreaterThanOrEqual(2);
  });
});

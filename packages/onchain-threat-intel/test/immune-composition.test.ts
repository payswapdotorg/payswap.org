import { describe, expect, it } from "vitest";
import { evaluateOnchainWriteGates, prepareWrite } from "@payswap/onchain-security";
// REAL immune-system machinery (the W1-002 composition-test pattern: this
// package's src composes through pure-data projections; the wiring layer —
// and this test — drives the REAL SecurityAdvisoryRegistry /
// ThreatSignatureRegistry / SecurityGate / QuarantineLedger /
// SecurityEpochAuthority machines).
import {
  QuarantineLedger,
  SecurityAdvisoryRegistry,
  SecurityEpochAuthority,
  SecurityGate,
  ThreatSignatureRegistry,
} from "@payswap/security";
import type { OnchainSecurityState } from "@payswap/onchain-security";
import {
  AdversarialTransactionAgent,
  buildThreatSignatureForTarget,
  evidenceRefsFromAssessment,
  familySignalClass,
  proposeAdvisoriesFromAssessment,
  advisoryActionForDrivingSignal,
  evaluateThreatPolicy,
  composeThreatVerdict,
  resolveOnchainSecurityDecision,
} from "../src/index.js";
import {
  AGENT_REF,
  CHAIN,
  MALICIOUS_SPENDER,
  NOW,
  ROUTER,
  baseKernelPolicy,
  baseSecurityState,
  baseThreatPolicy,
  baseWriteRequest,
  benignBundleInput,
  canonicalApproval,
} from "./helpers.js";
import { recordObservationBundle } from "../src/index.js";

/**
 * P4-W3-003 hard requirement 3: "quarantine/restrict/retire flows
 * integrate with SecurityAdvisory/ThreatSignature/SecurityEpoch — the
 * existing immune-system machinery ... real composition, no shadow
 * models (the W1-002 composition-test pattern is the precedent)."
 *
 * The full integration loop, with the REAL machines:
 *
 *   detection → threat signals (evidence chains) →
 *   (a) signature registration in the REAL ThreatSignatureRegistry and
 *       observation matching;
 *   (b) advisory proposal → REAL publication → REAL SecurityGate
 *       enforcement → REAL QuarantineLedger + SecurityEpoch advance;
 *   (c) the projected OnchainSecurityState (the W1-002 wiring projection)
 *       feeds the KERNEL gates → subsequent writes to the quarantined
 *       spender BLOCK (INV-S03: cached state can never bypass);
 *   (d) restriction (INV-S01) and retirement flows;
 *   (e) quarantine RELEASE through explicit remediation + advisory closure
 *       — after which the block lifts (reversibility law).
 */

function composeSecurityState(input: {
  readonly epochAuthority: SecurityEpochAuthority;
  readonly advisories: SecurityAdvisoryRegistry;
  readonly quarantine: QuarantineLedger;
  readonly at: number;
}): OnchainSecurityState {
  // The W1-002 wiring projection (security-composition.test.ts precedent).
  const active = input.advisories.listActive();
  const restrictedComponents: string[] = [];
  const quarantinedComponents: string[] = [];
  for (const advisory of active) {
    for (const affected of advisory.affected) {
      const key = `${affected.kind}:${affected.id}`;
      const restriction = input.advisories.restrictionFor({
        kind: affected.kind,
        id: affected.id,
      });
      if (restriction.quarantined) {
        quarantinedComponents.push(key);
      } else if (restriction.restricted) {
        restrictedComponents.push(key);
      }
    }
  }
  for (const record of input.quarantine.list()) {
    if (record.status === "active") {
      quarantinedComponents.push(`${record.component.kind}:${record.component.id}`);
    }
  }
  return {
    observedAt: input.at,
    networkEpoch: input.epochAuthority.currentEpoch().value,
    quarantinedComponents: [...new Set(quarantinedComponents)],
    restrictedComponents: [...new Set(restrictedComponents)],
    activeAdvisoryRefs: active.map((advisory) => advisory.advisoryId),
  };
}

const agent = new AdversarialTransactionAgent(AGENT_REF);

function drainAttackWorld() {
  const bundle = recordObservationBundle({
    ...benignBundleInput(),
    spenders: [
      {
        observationId: "spender-intel:drainer",
        spender: MALICIOUS_SPENDER,
        knownDrainPattern: true,
        observedIncidents: 9,
        firstObservedAt: NOW - 86_400_000,
      },
    ],
  });
  const write = prepareWrite(
    baseWriteRequest({
      approvals: [canonicalApproval({ spender: MALICIOUS_SPENDER })],
    }),
    NOW,
  );
  const assessment = agent.analyze({
    write,
    policy: baseThreatPolicy(),
    bundle,
    at: NOW,
  });
  return { write, assessment, bundle };
}

describe("threat signature registration in the REAL ThreatSignatureRegistry", () => {
  it("a family signature for the malicious spender registers and MATCHES the observation", () => {
    const registry = new ThreatSignatureRegistry();
    const registration = buildThreatSignatureForTarget(
      "malicious_approval_permit",
      { kind: "extension", id: MALICIOUS_SPENDER },
      { declaredBy: AGENT_REF, publishedAt: NOW, actionPattern: "onchain.approval.*" },
    );
    const signature = registry.register(registration);
    expect(signature.indicators.length).toBe(2);
    expect(signature.provenance.contentHash.startsWith("fnv1a64:")).toBe(true);

    // The observation the immune system sees for this component carries
    // the family signal class — the registry matches it.
    const matched = registry.matchObservation({
      component: { kind: "extension", id: MALICIOUS_SPENDER },
      signalClass: familySignalClass("malicious_approval_permit"),
    });
    expect(matched.map((s) => s.signatureId)).toContain(signature.signatureId);

    // And does NOT match a different component or class.
    expect(
      registry.matchObservation({
        component: { kind: "extension", id: ROUTER },
        signalClass: familySignalClass("malicious_approval_permit"),
      }),
    ).toEqual([]);
    expect(
      registry.matchObservation({
        component: { kind: "extension", id: MALICIOUS_SPENDER },
        signalClass: familySignalClass("oracle_manipulation"),
      }),
    ).toEqual([]);
  });
});

describe("the full quarantine flow through the REAL immune system", () => {
  it("detection → advisory → enforceAdvisory → quarantine + epoch advance → kernel BLOCK of subsequent writes (INV-S02/S03)", () => {
    const advisories = new SecurityAdvisoryRegistry();
    const quarantine = new QuarantineLedger();
    const epochAuthority = new SecurityEpochAuthority();
    const gate = new SecurityGate({ advisories, quarantine, epochs: epochAuthority });

    const { write, assessment } = drainAttackWorld();
    expect(assessment.signals.length).toBeGreaterThan(0);

    // The threat policy + composition confirm the BLOCK-grade verdict.
    const evaluation = evaluateThreatPolicy(assessment.signals, baseThreatPolicy());
    const composed = composeThreatVerdict(assessment.agentRecommendation, evaluation.verdict);
    expect(composed).toBe("BLOCK");

    // Propose the advisory from the assessment (evidence bound).
    const proposals = proposeAdvisoriesFromAssessment(assessment, baseThreatPolicy());
    expect(proposals.length).toBeGreaterThan(0);
    const proposal = proposals[0]!;
    expect(proposal.action).toBe("quarantine"); // critical driver
    expect(proposal.evidence.length).toBeGreaterThan(0);

    // PUBLISH into the REAL registry (the wiring-layer step).
    const advisory = advisories.publish({
      advisoryId: `adv-${proposal.proposalId}`,
      title: proposal.title,
      severity: proposal.severity,
      description: proposal.description,
      affected: proposal.affected,
      action: proposal.action,
      remediation: proposal.remediation,
      declaredBy: proposal.declaredBy,
      publishedAt: proposal.publishedAt,
    });
    expect(advisory.status).toBe("active");

    // ENFORCE through the REAL gate: quarantine + epoch advance.
    const enforcement = gate.enforceAdvisory(advisory, { advanceEpoch: true });
    expect(enforcement.quarantinedComponents.length).toBeGreaterThan(0);
    expect(enforcement.epochAdvanced).toBe(true);
    expect(epochAuthority.currentEpoch().value).toBe(1n);
    expect(epochAuthority.currentEpoch().advisoryRef).toBe(advisory.advisoryId);
    expect(quarantine.isQuarantined({ kind: "extension", id: MALICIOUS_SPENDER })).toBe(true);

    // The projected security state (W1-002 wiring projection) now BLOCKS
    // a subsequent write referencing the quarantined spender — even with
    // the kernel policy allowlisting it (INV-S03: no cached view bypasses).
    const state = composeSecurityState({ epochAuthority, advisories, quarantine, at: NOW });
    expect(state.quarantinedComponents).toContain(`extension:${MALICIOUS_SPENDER}`);
    const nextWrite = prepareWrite(
      baseWriteRequest({
        writeId: "write-2",
        approvals: [canonicalApproval({ spender: MALICIOUS_SPENDER })],
      }),
      NOW,
    );
    const decision = evaluateOnchainWriteGates({
      write: nextWrite,
      policy: baseKernelPolicy({ allowedSpenders: [ROUTER, MALICIOUS_SPENDER] }),
      securityState: state,
      at: NOW,
    });
    expect(decision.decision).toBe("BLOCK");
    if (decision.decision === "BLOCK") {
      expect(
        decision.reasons.some((r) => r.code === "component_quarantined_or_restricted"),
      ).toBe(true);
      expect(decision.evidenceRefs).toContain(`advisory:${advisory.advisoryId}`);
    }

    // The composed resolution for the ORIGINAL write is BLOCK too (the
    // kernel BLOCK is terminal; the threat verdict was already BLOCK).
    const resolution = resolveOnchainSecurityDecision({
      kernelDecision: evaluateOnchainWriteGates({
        write,
        policy: baseKernelPolicy(),
        securityState: state,
        at: NOW,
      }),
      threatVerdict: composed,
    });
    expect(resolution.decision).toBe("BLOCK");
  });

  it("quarantine RELEASE requires verified remediation + advisory closure — then the block lifts", () => {
    const advisories = new SecurityAdvisoryRegistry();
    const quarantine = new QuarantineLedger();
    const epochAuthority = new SecurityEpochAuthority();
    const gate = new SecurityGate({ advisories, quarantine, epochs: epochAuthority });

    const { assessment } = drainAttackWorld();
    const proposal = proposeAdvisoriesFromAssessment(assessment, baseThreatPolicy())[0]!;
    const advisory = advisories.publish({
      advisoryId: `adv-${proposal.proposalId}`,
      title: proposal.title,
      severity: proposal.severity,
      description: proposal.description,
      affected: proposal.affected,
      action: proposal.action,
      remediation: proposal.remediation,
      declaredBy: proposal.declaredBy,
      publishedAt: proposal.publishedAt,
    });
    const enforcement = gate.enforceAdvisory(advisory);
    expect(enforcement.epochAdvanced).toBe(false);

    // Release BEFORE closure + remediation is rejected (fail closed).
    const record = quarantine.list()[0]!;
    expect(() =>
      quarantine.release({
        quarantineId: record.quarantineId,
        remediation: { releaseNote: "attempted early release", evidence: [] },
        advisories,
        at: NOW + 1,
      }),
    ).toThrow(/explicit remediation evidence/);

    // The honest release path: verified remediation + closure + the
    // assessment's evidence refs as remediation evidence.
    advisories.close({
      advisoryId: advisory.advisoryId,
      closedAt: NOW + 10_000,
      closureNote: "spender rotated and verified clean onchain",
      remediationVerified: true,
    });
    const evidence = evidenceRefsFromAssessment(assessment);
    const released = quarantine.release({
      quarantineId: record.quarantineId,
      remediation: {
        releaseNote: "drain pattern remediated; spender re-verified",
        evidence,
      },
      advisories,
      at: NOW + 10_000,
    });
    expect(released.status).toBe("released");

    // The projected state no longer blocks the write (INV-S03 projection
    // follows the REAL ledger semantics: only ACTIVE quarantines block).
    const state = composeSecurityState({ epochAuthority, advisories, quarantine, at: NOW + 20_000 });
    expect(state.quarantinedComponents).toEqual([]);
    const nextWrite = prepareWrite(
      baseWriteRequest({
        writeId: "write-after-release",
        approvals: [canonicalApproval({ spender: MALICIOUS_SPENDER })],
      }),
      NOW + 20_000,
    );
    const decision = evaluateOnchainWriteGates({
      write: nextWrite,
      policy: baseKernelPolicy({
        allowedSpenders: [ROUTER, MALICIOUS_SPENDER],
        allowedDestinations: ["0x2222222222222222222222222222222222222222"],
      }),
      securityState: state,
      at: NOW + 20_000,
    });
    expect(decision.decision).toBe("ALLOW");
  });
});

describe("restrict (INV-S01) and retire flows", () => {
  it("a RESTRICT-grade proposal (high driver) restricts globally without quarantine", () => {
    const advisories = new SecurityAdvisoryRegistry();
    const quarantine = new QuarantineLedger();
    const epochAuthority = new SecurityEpochAuthority();

    // A high-severity-only world: incident-heavy but not drain-pattern.
    const bundle = recordObservationBundle({
      ...benignBundleInput(),
      spenders: [
        {
          observationId: "spender-intel:incidents",
          spender: MALICIOUS_SPENDER,
          knownDrainPattern: false,
          firstObservedAt: NOW - 86_400_000,
          observedIncidents: 5,
        },
      ],
    });
    const write = prepareWrite(
      baseWriteRequest({
        approvals: [canonicalApproval({ spender: MALICIOUS_SPENDER })],
      }),
      NOW,
    );
    const assessment = agent.analyze({
      write,
      policy: baseThreatPolicy(),
      bundle,
      at: NOW,
    });
    const proposals = proposeAdvisoriesFromAssessment(assessment, baseThreatPolicy());
    const proposal = proposals.find((p) => p.severity === "high")!;
    expect(proposal.action).toBe("restrict");
    expect(advisoryActionForDrivingSignal("unexpected_spender", "high", baseThreatPolicy()))
      .toBe("restrict");

    const advisory = advisories.publish({
      advisoryId: `adv-${proposal.proposalId}`,
      title: proposal.title,
      severity: proposal.severity,
      description: proposal.description,
      affected: proposal.affected,
      action: proposal.action,
      remediation: proposal.remediation,
      declaredBy: proposal.declaredBy,
      publishedAt: proposal.publishedAt,
    });

    // The global restriction view (INV-S01): restricted from EVERY vantage.
    const restriction = advisories.restrictionFor({
      kind: "extension",
      id: MALICIOUS_SPENDER,
    });
    expect(restriction.restricted).toBe(true);
    expect(restriction.quarantined).toBe(false);
    expect(restriction.advisoryRefs).toContain(advisory.advisoryId);

    // The kernel blocks subsequent writes through the projection.
    const state = composeSecurityState({ epochAuthority, advisories, quarantine, at: NOW });
    expect(state.restrictedComponents).toContain(`extension:${MALICIOUS_SPENDER}`);
    const decision = evaluateOnchainWriteGates({
      write: prepareWrite(
        baseWriteRequest({
          writeId: "write-restricted",
          approvals: [canonicalApproval({ spender: MALICIOUS_SPENDER })],
        }),
        NOW,
      ),
      policy: baseKernelPolicy({ allowedSpenders: [ROUTER, MALICIOUS_SPENDER] }),
      securityState: state,
      at: NOW,
    });
    expect(decision.decision).toBe("BLOCK");
  });

  it("RETIRE flows only with the explicit policy opt-in, for retire-eligible families", () => {
    // Without the opt-in: critical impersonation → quarantine (not retire).
    expect(
      advisoryActionForDrivingSignal("token_impersonation", "critical", baseThreatPolicy()),
    ).toBe("quarantine");
    // With the opt-in: retire.
    expect(
      advisoryActionForDrivingSignal(
        "token_impersonation",
        "critical",
        baseThreatPolicy({ retireCompromisedContracts: true }),
      ),
    ).toBe("retire");
    // Non-eligible families never retire, even critical + opt-in.
    expect(
      advisoryActionForDrivingSignal(
        "malicious_approval_permit",
        "critical",
        baseThreatPolicy({ retireCompromisedContracts: true }),
      ),
    ).toBe("quarantine");

    // The retire enforcement: advisory action retire → restriction view
    // marks retired, and the kernel blocks with the retire marker.
    const advisories = new SecurityAdvisoryRegistry();
    const quarantine = new QuarantineLedger();
    const epochAuthority = new SecurityEpochAuthority();

    const fakeTokenBundle = recordObservationBundle({
      ...benignBundleInput(),
      tokens: [
        {
          observationId: "token-registry:fake",
          asset: { chain: CHAIN, assetId: "0xbbbb999999999999999999999999999999999999", symbol: "USC" },
          canonical: false,
          impersonatesAssetId: "0xaaaa111111111111111111111111111111111111",
        },
      ],
    });
    const write = prepareWrite(
      baseWriteRequest({
        transfer: {
          asset: { chain: CHAIN, assetId: "0xbbbb999999999999999999999999999999999999", symbol: "USC" },
          amount: { currency: "USC", minorUnits: "1000000" },
          from: "0x1111111111111111111111111111111111111111",
          to: "0x2222222222222222222222222222222222222222",
        },
      }),
      NOW,
    );
    const assessment = agent.analyze({
      write,
      policy: baseThreatPolicy({ retireCompromisedContracts: true }),
      bundle: fakeTokenBundle,
      at: NOW,
    });
    const proposals = proposeAdvisoriesFromAssessment(
      assessment,
      baseThreatPolicy({ retireCompromisedContracts: true }),
    );
    const retireProposal = proposals.find((p) => p.action === "retire");
    expect(retireProposal).toBeDefined();

    const advisory = advisories.publish({
      advisoryId: `adv-${retireProposal!.proposalId}`,
      title: retireProposal!.title,
      severity: retireProposal!.severity,
      description: retireProposal!.description,
      affected: retireProposal!.affected,
      action: retireProposal!.action,
      remediation: retireProposal!.remediation,
      declaredBy: retireProposal!.declaredBy,
      publishedAt: retireProposal!.publishedAt,
    });
    const restriction = advisories.restrictionFor({
      kind: "extension",
      id: retireProposal!.affected[0]!.id,
    });
    expect(restriction.retired).toBe(true);
    expect(restriction.quarantined).toBe(true); // retire ≥ quarantine
    expect(restriction.advisoryRefs).toContain(advisory.advisoryId);
  });
});

describe("epoch composition (INV-S02)", () => {
  it("an advisory-driven epoch advance is recorded with the advisory provenance and reaches the projected state", () => {
    const advisories = new SecurityAdvisoryRegistry();
    const quarantine = new QuarantineLedger();
    const epochAuthority = new SecurityEpochAuthority();
    const gate = new SecurityGate({ advisories, quarantine, epochs: epochAuthority });

    const { assessment } = drainAttackWorld();
    const proposal = proposeAdvisoriesFromAssessment(assessment, baseThreatPolicy())[0]!;
    const advisory = advisories.publish({
      advisoryId: `adv-${proposal.proposalId}`,
      title: proposal.title,
      severity: proposal.severity,
      description: proposal.description,
      affected: proposal.affected,
      action: proposal.action,
      remediation: proposal.remediation,
      declaredBy: proposal.declaredBy,
      publishedAt: proposal.publishedAt,
    });
    gate.enforceAdvisory(advisory, { advanceEpoch: true });

    const history = epochAuthority.history();
    expect(history.length).toBe(2); // genesis + one advance
    expect(history[1]!.advisoryRef).toBe(advisory.advisoryId);

    const state = composeSecurityState({ epochAuthority, advisories, quarantine, at: NOW });
    expect(state.networkEpoch).toBe(1n);
    expect(state.activeAdvisoryRefs).toContain(advisory.advisoryId);

    // A subsequent assessment (analyzed after the advance) pins the new
    // epoch in its evidence refs through the security state it consumed.
    const laterWrite = prepareWrite(
      baseWriteRequest({ writeId: "write-post-epoch" }),
      NOW + 1_000,
    );
    const laterAssessment = agent.analyze({
      write: laterWrite,
      policy: baseThreatPolicy(),
      bundle: recordObservationBundle({ ...benignBundleInput(), bundleId: "bundle-post-epoch", observedAt: NOW + 1_000 }),
      at: NOW + 1_000,
    });
    expect(laterAssessment.signals).toEqual([]);
    // The kernel gates see the advanced epoch through the projection:
    const decision = evaluateOnchainWriteGates({
      write: laterWrite,
      policy: baseKernelPolicy(),
      securityState: state,
      at: NOW + 1_000,
    });
    expect(decision.decision).toBe("ALLOW"); // clean state at the new epoch
  });
});

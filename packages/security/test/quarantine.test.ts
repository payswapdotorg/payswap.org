import { describe, expect, it } from "vitest";
import { CapabilityGraphStore } from "@payswap/capabilities";
import type { Capability } from "@payswap/capabilities";
import { transitionPackage } from "@payswap/agents";
import type { AgentPackage } from "@payswap/agents";
import type { AffectedComponentRef } from "../src/index.js";
import {
  QuarantineError,
  QuarantineLedger,
  RestrictedComponentError,
  SecurityAdvisoryRegistry,
  SecurityEpochAuthority,
  SecurityGate,
  StaleAuthorizationEpochError,
  authorizeCapabilityUse,
} from "../src/index.js";

/**
 * INV-S03 — quarantined components cannot regain access through cached
 * capability state. Release only through explicit remediation + advisory
 * closure. INV-C03 discipline — quarantine history preservation.
 */

function capability(id: string): Capability {
  return {
    id,
    capabilityClass: "verification",
    conditions: [],
    cost: [],
    risk: { riskClass: "verification", severity: "low", mitigations: [] },
    provenance: {
      declaredBy: "source:provider-alpha",
      artifactRef: `artifact:${id}`,
      contentHash: `hash:${id}`,
    },
    economicAccountability: {
      accountablePartyRef: "party:ops",
      ledgerAccountRef: "account:ops",
      recoursePolicyRef: "policy:standard",
    },
    proofRequirements: [],
  };
}

function enforcementFixture() {
  const advisories = new SecurityAdvisoryRegistry();
  const quarantine = new QuarantineLedger();
  const epochs = new SecurityEpochAuthority();
  return { advisories, quarantine, epochs };
}

function publishQuarantineAdvisory(
  advisories: SecurityAdvisoryRegistry,
  advisoryId = "adv-quarantine-1",
  component: AffectedComponentRef = { kind: "capability", id: "cap:kyc-verify" },
) {
  return advisories.publish({
    advisoryId,
    title: "Malicious verification capability",
    severity: "critical",
    description: "Fabricates KYC verification outcomes",
    affected: [component],
    action: "quarantine",
    remediation: {
      summary: "Replace with verified build",
      patchedVersion: "2.1.0",
      workarounds: [],
    },
    declaredBy: "security-coordinator",
    publishedAt: 500,
  });
}

describe("INV-S03: quarantined component cannot bypass via cached capability state", () => {
  it("a cached AVAILABLE capability state is rejected while quarantine is active", () => {
    const { advisories, quarantine } = enforcementFixture();
    const advisory = publishQuarantineAdvisory(advisories);

    // BEFORE: the capability is cached as AVAILABLE in the network graph
    // (this entry was registered before any advisory existed).
    const graph = new CapabilityGraphStore();
    graph.register({
      capability: capability("cap:kyc-verify"),
      sourceId: "source:provider-alpha",
      capabilityState: "AVAILABLE",
      sourceAvailability: "REACHABLE",
    });
    const cachedEntry = graph.entries[0]!;
    expect(cachedEntry.capabilityState).toBe("AVAILABLE");

    // The immune system quarantines the capability (advisory enforcement).
    quarantine.quarantine({
      component: { kind: "capability", id: "cap:kyc-verify" },
      reason: advisory.title,
      advisoryRefs: [advisory.advisoryId],
      at: advisory.provenance.publishedAt,
    });
    expect(quarantine.isQuarantined({ kind: "capability", id: "cap:kyc-verify" })).toBe(true);

    // THE BYPASS ATTEMPT: present the cached view — still AVAILABLE — and
    // ask for access. The gate consults the quarantine ledger FIRST.
    const decision = authorizeCapabilityUse(
      {
        capabilityId: "cap:kyc-verify",
        sourceId: "source:provider-alpha",
        effectiveAvailability: "AVAILABLE",
      },
      { advisories, quarantine },
    );
    expect(decision.decision).toBe("REJECT");
    if (decision.decision === "REJECT") {
      expect(decision.reason).toBe("quarantined");
      expect(decision.componentKey).toBe("capability:cap:kyc-verify");
      expect(decision.quarantineIds).toHaveLength(1);
    }

    // Same result through a DIFFERENT cached view/source: the cache is not
    // an authority no matter which source produced it.
    const otherSource = authorizeCapabilityUse(
      {
        capabilityId: "cap:kyc-verify",
        sourceId: "source:marketplace-beta",
        effectiveAvailability: "AVAILABLE",
      },
      { advisories, quarantine },
    );
    expect(otherSource.decision).toBe("REJECT");
  });

  it("quarantining the PROVIDER blocks the capability even though the capability itself is clean", () => {
    const { advisories, quarantine } = enforcementFixture();
    const advisory = publishQuarantineAdvisory(
      advisories,
      "adv-quarantine-provider",
      { kind: "extension", id: "ext:kyc-bundle" },
    );
    quarantine.quarantine({
      component: { kind: "extension", id: "ext:kyc-bundle" },
      reason: advisory.title,
      advisoryRefs: [advisory.advisoryId],
      at: advisory.provenance.publishedAt,
    });
    const decision = authorizeCapabilityUse(
      {
        capabilityId: "cap:kyc-verify",
        sourceId: "source:provider-alpha",
        effectiveAvailability: "AVAILABLE",
        providedBy: [{ kind: "extension", id: "ext:kyc-bundle" }],
      },
      { advisories, quarantine },
    );
    expect(decision.decision).toBe("REJECT");
    if (decision.decision === "REJECT") {
      expect(decision.reason).toBe("quarantined_provider");
    }
  });

  it("an unrestricted, unquarantined capability is allowed", () => {
    const { advisories, quarantine } = enforcementFixture();
    const decision = authorizeCapabilityUse(
      {
        capabilityId: "cap:kyc-verify",
        sourceId: "source:provider-alpha",
        effectiveAvailability: "AVAILABLE",
      },
      { advisories, quarantine },
    );
    expect(decision.decision).toBe("ALLOW");
  });

  it("advisory-level restriction (without a quarantine record) also rejects", () => {
    const { advisories, quarantine } = enforcementFixture();
    advisories.publish({
      advisoryId: "adv-restrict-only",
      title: "Suspicious capability",
      severity: "medium",
      description: "d",
      affected: [{ kind: "capability", id: "cap:kyc-verify" }],
      action: "restrict",
      remediation: { summary: "s", workarounds: [] },
      declaredBy: "c",
      publishedAt: 1,
    });
    const decision = authorizeCapabilityUse(
      {
        capabilityId: "cap:kyc-verify",
        sourceId: "source:provider-alpha",
        effectiveAvailability: "AVAILABLE",
      },
      { advisories, quarantine },
    );
    expect(decision.decision).toBe("REJECT");
    if (decision.decision === "REJECT") {
      expect(decision.reason).toBe("restricted");
    }
  });
});

describe("quarantine release: explicit remediation + advisory closure only", () => {
  it("refuses release while the driving advisory is still active", () => {
    const { advisories, quarantine } = enforcementFixture();
    const advisory = publishQuarantineAdvisory(advisories);
    const record = quarantine.quarantine({
      component: { kind: "capability", id: "cap:kyc-verify" },
      reason: advisory.title,
      advisoryRefs: [advisory.advisoryId],
      at: advisory.provenance.publishedAt,
    });
    expect(() =>
      quarantine.release({
        quarantineId: record.quarantineId,
        remediation: {
          releaseNote: "patched",
          evidence: [
            { evidenceId: "ev-1", artifactRef: "artifact:patch", contentDigest: "fnv1a64:x" },
          ],
        },
        advisories,
        at: 900,
      }),
    ).toThrow(/advisories remain active/);
  });

  it("refuses release without explicit remediation evidence, even after closure", () => {
    const { advisories, quarantine } = enforcementFixture();
    const advisory = publishQuarantineAdvisory(advisories);
    const record = quarantine.quarantine({
      component: { kind: "capability", id: "cap:kyc-verify" },
      reason: advisory.title,
      advisoryRefs: [advisory.advisoryId],
      at: advisory.provenance.publishedAt,
    });
    advisories.close({
      advisoryId: advisory.advisoryId,
      closedAt: 800,
      closureNote: "patch verified",
      remediationVerified: true,
    });
    expect(() =>
      quarantine.release({
        quarantineId: record.quarantineId,
        remediation: { releaseNote: "patched", evidence: [] },
        advisories,
        at: 900,
      }),
    ).toThrow(/explicit remediation evidence/);
  });

  it("releases after advisory closure + remediation evidence; access is restored", () => {
    const { advisories, quarantine } = enforcementFixture();
    const advisory = publishQuarantineAdvisory(advisories);
    const record = quarantine.quarantine({
      component: { kind: "capability", id: "cap:kyc-verify" },
      reason: advisory.title,
      advisoryRefs: [advisory.advisoryId],
      at: advisory.provenance.publishedAt,
    });
    advisories.close({
      advisoryId: advisory.advisoryId,
      closedAt: 800,
      closureNote: "patch verified network-wide",
      remediationVerified: true,
    });
    const released = quarantine.release({
      quarantineId: record.quarantineId,
      remediation: {
        releaseNote: "upgraded to 2.1.0 and re-verified",
        evidence: [
          { evidenceId: "ev-1", artifactRef: "artifact:patch-report", contentDigest: "fnv1a64:abc" },
          { evidenceId: "ev-2", artifactRef: "artifact:retest", contentDigest: "fnv1a64:def" },
        ],
      },
      advisories,
      at: 900,
    });
    expect(released.status).toBe("released");
    expect(quarantine.isQuarantined({ kind: "capability", id: "cap:kyc-verify" })).toBe(false);

    const decision = authorizeCapabilityUse(
      {
        capabilityId: "cap:kyc-verify",
        sourceId: "source:provider-alpha",
        effectiveAvailability: "AVAILABLE",
      },
      { advisories, quarantine },
    );
    expect(decision.decision).toBe("ALLOW");
  });

  it("double release and double quarantine are rejected", () => {
    const { advisories, quarantine } = enforcementFixture();
    const advisory = publishQuarantineAdvisory(advisories);
    quarantine.quarantine({
      component: { kind: "capability", id: "cap:kyc-verify" },
      reason: advisory.title,
      advisoryRefs: [advisory.advisoryId],
      at: 500,
    });
    expect(() =>
      quarantine.quarantine({
        component: { kind: "capability", id: "cap:kyc-verify" },
        reason: "again",
        advisoryRefs: [],
        at: 600,
      }),
    ).toThrow(/already quarantined/);
    advisories.close({
      advisoryId: advisory.advisoryId,
      closedAt: 800,
      closureNote: "ok",
      remediationVerified: true,
    });
    const record = quarantine.recordsFor({ kind: "capability", id: "cap:kyc-verify" })[0]!;
    quarantine.release({
      quarantineId: record.quarantineId,
      remediation: {
        releaseNote: "ok",
        evidence: [{ evidenceId: "ev", artifactRef: "a", contentDigest: "d" }],
      },
      advisories,
      at: 900,
    });
    expect(() =>
      quarantine.release({
        quarantineId: record.quarantineId,
        remediation: {
          releaseNote: "again",
          evidence: [{ evidenceId: "ev", artifactRef: "a", contentDigest: "d" }],
        },
        advisories,
        at: 950,
      }),
    ).toThrow(QuarantineError);
  });
});

describe("INV-C03 discipline: quarantine history preservation", () => {
  it("release appends events; the quarantined history is never rewritten", () => {
    const { advisories, quarantine } = enforcementFixture();
    const advisory = publishQuarantineAdvisory(advisories);
    const record = quarantine.quarantine({
      component: { kind: "capability", id: "cap:kyc-verify" },
      reason: advisory.title,
      advisoryRefs: [advisory.advisoryId],
      at: 500,
    });
    advisories.close({
      advisoryId: advisory.advisoryId,
      closedAt: 800,
      closureNote: "closed",
      remediationVerified: true,
    });
    const released = quarantine.release({
      quarantineId: record.quarantineId,
      remediation: {
        releaseNote: "remediated",
        evidence: [{ evidenceId: "ev", artifactRef: "a", contentDigest: "d" }],
      },
      advisories,
      at: 900,
    });

    // The event history preserves the full lifecycle: quarantined then
    // released — the quarantine event is still there, unchanged.
    const events = quarantine.history();
    expect(events.map((event) => event.eventType)).toEqual(["quarantined", "released"]);
    expect(events[0]?.eventType === "quarantined" && events[0].record.quarantinedAt).toBe(500);
    // The record keeps the original quarantine facts alongside the release.
    expect(released.quarantinedAt).toBe(500);
    expect(released.reason).toBe(advisory.title);
    expect(released.advisoryRefs).toEqual([advisory.advisoryId]);
    expect(released.remediationEvidence).toHaveLength(1);
    // Full history remains queryable.
    expect(quarantine.recordsFor({ kind: "capability", id: "cap:kyc-verify" })).toHaveLength(1);
  });

  it("RETIREMENT of the component cannot rewrite the in-flight security history", () => {
    // The vulnerable component is a real @payswap/agents AgentPackage that
    // walks its own lifecycle to RETIRED (the terminal state). INV-C03:
    // retirement cannot rewrite in-flight history — the advisory events and
    // quarantine records gathered before retirement stay intact and
    // queryable afterwards.
    const { advisories, quarantine } = enforcementFixture();
    const pkg: AgentPackage = {
      id: "pkg:exfil-agent",
      version: 1,
      bodies: [],
      organizationTemplates: [],
      requiredExtensions: [],
      securityEpochRequirements: { requireCurrentEpoch: true },
      runtimeRequirements: { minRuntimeContractVersion: 1, requiredOperations: [] },
      modelCompatibility: { interfaceVersion: 1 },
      evaluationSuiteRef: "suite:default",
      provenance: {
        source: "marketplace",
        contentHash: "hash:pkg-exfil",
        createdAt: 0,
      },
      lifecycle: "AVAILABLE",
    };
    const advisory = publishQuarantineAdvisory(
      advisories,
      "adv-pkg-quarantine",
      { kind: "agent_package", id: pkg.id },
    );
    const record = quarantine.quarantine({
      component: { kind: "agent_package", id: pkg.id },
      reason: advisory.title,
      advisoryRefs: [advisory.advisoryId],
      at: 500,
    });
    const historyBefore = quarantine.history().map((event) => event.eventType);
    const advisoryHistoryBefore = advisories.history().map((event) => event.eventType);

    // The package is suspended and retired through its own lifecycle
    // (agents package.ts: AVAILABLE → SUSPENDED → RETIRED, RETIRED terminal).
    const suspended = transitionPackage(pkg, "SUSPENDED");
    const retired = transitionPackage(suspended, "RETIRED");
    expect(retired.lifecycle).toBe("RETIRED");

    // Retirement did not touch the immune-system history: the same events,
    // the same record, still queryable, still active (a retired component
    // stays quarantined — release still requires closure + remediation).
    expect(quarantine.history().map((event) => event.eventType)).toEqual(historyBefore);
    expect(advisories.history().map((event) => event.eventType)).toEqual(advisoryHistoryBefore);
    expect(quarantine.recordsFor({ kind: "agent_package", id: pkg.id })).toEqual([record]);
    expect(quarantine.isQuarantined({ kind: "agent_package", id: pkg.id })).toBe(true);
    expect(() =>
      quarantine.release({
        quarantineId: record.quarantineId,
        remediation: {
          releaseNote: "retired, not remediated",
          evidence: [{ evidenceId: "ev", artifactRef: "a", contentDigest: "d" }],
        },
        advisories,
        at: 900,
      }),
    ).toThrow(/advisories remain active/);
  });
});

describe("SecurityGate: composed enforcement", () => {
  it("enforceAdvisory quarantines affected components and (opt-in) advances the epoch", () => {
    const fixture = enforcementFixture();
    const gate = new SecurityGate(fixture);
    const advisory = publishQuarantineAdvisory(fixture.advisories);

    const enforcement = gate.enforceAdvisory(advisory, { advanceEpoch: true });
    expect(enforcement.quarantinedComponents).toEqual([
      { kind: "capability", id: "cap:kyc-verify" },
    ]);
    expect(enforcement.epochAdvanced).toBe(true);
    expect(fixture.epochs.currentEpoch().value).toBe(1n);
    expect(fixture.epochs.currentEpoch().advisoryRef).toBe(advisory.advisoryId);

    // The epoch bump killed every epoch-0 authorization network-wide, and
    // the gate's capability check rejects the quarantined capability.
    expect(() =>
      gate.checkSensitiveAction({
        authorization: {
          authorizationRef: "auth:old",
          principalRef: "user:alice",
          actionClass: "money_movement",
          issuedAtEpoch: 0n,
          expiresAt: 10_000,
        },
        at: 600,
      }),
    ).toThrow(StaleAuthorizationEpochError);
    const decision = gate.authorizeCapabilityUse({
      capabilityId: "cap:kyc-verify",
      sourceId: "source:provider-alpha",
      effectiveAvailability: "AVAILABLE",
    });
    expect(decision.decision).toBe("REJECT");

    // Idempotent re-enforcement: no duplicate quarantine, no second record.
    gate.enforceAdvisory(advisory);
    expect(quarantineRecords(fixture.quarantine)).toHaveLength(1);
  });

  it("a vulnerable AGENT is restricted out of sensitive actions (via agentRef)", () => {
    const fixture = enforcementFixture();
    const gate = new SecurityGate(fixture);
    gate.advisories.publish({
      advisoryId: "adv-agent",
      title: "Compromised agent key",
      severity: "critical",
      description: "d",
      affected: [{ kind: "agent_key", id: "sha256:agent-key-1" }],
      action: "restrict",
      remediation: { summary: "s", workarounds: [] },
      declaredBy: "c",
      publishedAt: 10,
    });
    expect(() =>
      gate.checkSensitiveAction({
        authorization: {
          authorizationRef: "auth:agent-1",
          principalRef: "user:alice",
          agentRef: "sha256:agent-key-1",
          actionClass: "beneficiary_change",
          issuedAtEpoch: 0n,
          expiresAt: 10_000,
        },
        at: 100,
      }),
    ).toThrow(RestrictedComponentError);
  });

  it("a vulnerable PACKAGE through which the action routes is restricted (viaComponents)", () => {
    const fixture = enforcementFixture();
    const gate = new SecurityGate(fixture);
    gate.advisories.publish({
      advisoryId: "adv-pkg",
      title: "Exfiltration package",
      severity: "high",
      description: "d",
      affected: [
        {
          kind: "agent_package",
          id: "pkg:exfil-agent",
          versionRange: { minVersion: "1.0.0", maxVersion: "1.9.9" },
        },
      ],
      action: "restrict",
      remediation: { summary: "s", workarounds: [] },
      declaredBy: "c",
      publishedAt: 10,
    });
    expect(() =>
      gate.checkSensitiveAction({
        authorization: {
          authorizationRef: "auth:routed-1",
          principalRef: "user:alice",
          actionClass: "money_movement",
          issuedAtEpoch: 0n,
          expiresAt: 10_000,
        },
        at: 100,
        viaComponents: [{ kind: "agent_package", id: "pkg:exfil-agent" }],
      }),
    ).toThrow(RestrictedComponentError);
  });

  it("clean components pass the full sensitive-action gate", () => {
    const fixture = enforcementFixture();
    const gate = new SecurityGate(fixture);
    expect(() =>
      gate.checkSensitiveAction({
        authorization: {
          authorizationRef: "auth:clean-1",
          principalRef: "user:alice",
          agentRef: "sha256:agent-key-clean",
          actionClass: "money_movement",
          issuedAtEpoch: 0n,
          expiresAt: 10_000,
        },
        at: 100,
      }),
    ).not.toThrow();
  });
});

function quarantineRecords(ledger: QuarantineLedger) {
  return ledger.list();
}

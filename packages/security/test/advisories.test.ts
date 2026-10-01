import { describe, expect, it } from "vitest";
import { CapabilityGraphStore } from "@payswap/capabilities";
import type { Capability } from "@payswap/capabilities";
import {
  SecurityAdvisoryRegistry,
  advisoryAffects,
} from "../src/index.js";

/**
 * INV-S01 — security advisories can restrict affected components GLOBALLY.
 * The restriction view is scope-free: the same component identity is
 * restricted identically no matter which source, graph or view presents it.
 */

function capability(id: string, declaredBy: string): Capability {
  return {
    id,
    capabilityClass: "fx",
    conditions: [],
    cost: [],
    risk: { riskClass: "fx", severity: "low", mitigations: [] },
    provenance: { declaredBy, artifactRef: `artifact:${id}`, contentHash: `hash:${id}` },
    economicAccountability: {
      accountablePartyRef: "party:treasury",
      ledgerAccountRef: "account:ops",
      recoursePolicyRef: "policy:standard",
    },
    proofRequirements: [],
  };
}

const vulnerableExtension = { kind: "extension", id: "ext:fx-router" } as const;
const vulnerablePackage = {
  kind: "agent_package",
  id: "pkg:exfil-agent",
  version: "1.4.2",
} as const;

function registryWithAdvisory(): SecurityAdvisoryRegistry {
  const advisories = new SecurityAdvisoryRegistry();
  advisories.publish({
    advisoryId: "adv-2026-001",
    title: "Token exfiltration in fx-router extension and exfil-agent package",
    severity: "high",
    description: "Emits Authorization tokens to an unaffiliated sink",
    affected: [
      { kind: "extension", id: "ext:fx-router" },
      { kind: "agent_package", id: "pkg:exfil-agent", versionRange: { minVersion: "1.0.0", maxVersion: "1.9.9" } },
    ],
    action: "restrict",
    remediation: {
      summary: "Upgrade to the patched build",
      patchedVersion: "1.10.0",
      workarounds: ["disable token emission for the extension"],
    },
    declaredBy: "security-coordinator",
    publishedAt: 500,
  });
  return advisories;
}

describe("advisory publication", () => {
  it("publishes with computed provenance and active status", () => {
    const advisories = registryWithAdvisory();
    const advisory = advisories.byId("adv-2026-001");
    expect(advisory).toBeDefined();
    expect(advisory?.status).toBe("active");
    expect(advisory?.provenance.contentHash).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
    expect(advisory?.remediation.patchedVersion).toBe("1.10.0");
    expect(advisories.listActive()).toHaveLength(1);
  });

  it("rejects empty affected sets and duplicate ids", () => {
    const advisories = new SecurityAdvisoryRegistry();
    expect(() =>
      advisories.publish({
        advisoryId: "adv-empty",
        title: "t",
        severity: "low",
        description: "d",
        affected: [],
        action: "restrict",
        remediation: { summary: "s", workarounds: [] },
        declaredBy: "x",
        publishedAt: 1,
      }),
    ).toThrow(/at least one component/);
    const published = advisories.publish({
      advisoryId: "adv-dup",
      title: "t",
      severity: "low",
      description: "d",
      affected: [{ kind: "extension", id: "ext:x" }],
      action: "restrict",
      remediation: { summary: "s", workarounds: [] },
      declaredBy: "x",
      publishedAt: 1,
    });
    expect(published.advisoryId).toBe("adv-dup");
    expect(() =>
      advisories.publish({
        advisoryId: "adv-dup",
        title: "t",
        severity: "low",
        description: "d",
        affected: [{ kind: "extension", id: "ext:x" }],
        action: "restrict",
        remediation: { summary: "s", workarounds: [] },
        declaredBy: "x",
        publishedAt: 2,
      }),
    ).toThrow(/already exists/);
  });
});

describe("advisoryAffects (version-scoped, fail-closed)", () => {
  const advisories = registryWithAdvisory();
  const advisory = advisories.byId("adv-2026-001")!;

  it("affects the in-range package version", () => {
    expect(advisoryAffects(advisory, vulnerablePackage)).toBe(true);
  });

  it("does not affect the patched version", () => {
    expect(
      advisoryAffects(advisory, { kind: "agent_package", id: "pkg:exfil-agent", version: "1.10.0" }),
    ).toBe(false);
  });

  it("treats an unknown version as affected (fail closed)", () => {
    expect(advisoryAffects(advisory, { kind: "agent_package", id: "pkg:exfil-agent" })).toBe(true);
  });

  it("unscoped components match every version", () => {
    expect(advisoryAffects(advisory, { kind: "extension", id: "ext:fx-router", version: "9.9.9" })).toBe(true);
  });
});

describe("INV-S01: global restriction across the network model", () => {
  it("restricts the vulnerable extension and package everywhere, whatever graph/source presents them", () => {
    const advisories = registryWithAdvisory();

    // The network model: one capability graph, the SAME extension-backed
    // capability registered by TWO different sources (a provider and a
    // marketplace), plus the vulnerable package — the usual "restricted in
    // one view but not another" attack surface.
    const graph = new CapabilityGraphStore();
    graph.register({
      capability: capability("cap:fx-route-a", "source:provider-alpha"),
      sourceId: "source:provider-alpha",
      capabilityState: "AVAILABLE",
      sourceAvailability: "REACHABLE",
    });
    graph.register({
      capability: capability("cap:fx-route-b", "source:marketplace-beta"),
      sourceId: "source:marketplace-beta",
      capabilityState: "AVAILABLE",
      sourceAvailability: "REACHABLE",
    });

    // The restriction view is computed from the identity — never from the
    // graph, the source or any tenant/principal scope. Every presentation of
    // the vulnerable identities is restricted.
    for (const source of ["source:provider-alpha", "source:marketplace-beta"]) {
      const entry = graph.entries.find((e) => e.sourceId === source);
      expect(entry).toBeDefined();
      expect(advisories.isRestricted(vulnerableExtension)).toBe(true);
      expect(advisories.isRestricted(vulnerablePackage)).toBe(true);
    }

    // The graph itself still reports the capabilities as AVAILABLE — that is
    // the CACHED capability state the immune system overrides (INV-S03 is
    // proven in quarantine.test.ts; here the point is that the advisory
    // restriction ignores the graph view entirely).
    expect(graph.entries.map((e) => e.capabilityState)).toEqual(["AVAILABLE", "AVAILABLE"]);

    // Unaffected components stay unrestricted — globally too.
    expect(advisories.isRestricted({ kind: "extension", id: "ext:other", version: "1.0.0" })).toBe(false);
    expect(advisories.isRestricted({ kind: "agent_package", id: "pkg:clean", version: "1.4.2" })).toBe(false);
  });

  it("escalation ladder: retire > quarantine > restrict; most severe advisory first", () => {
    const advisories = new SecurityAdvisoryRegistry();
    advisories.publish({
      advisoryId: "adv-restrict",
      title: "t",
      severity: "medium",
      description: "d",
      affected: [{ kind: "capability", id: "cap:x" }],
      action: "restrict",
      remediation: { summary: "s", workarounds: [] },
      declaredBy: "c",
      publishedAt: 1,
    });
    let restriction = advisories.restrictionFor({ kind: "capability", id: "cap:x" });
    expect(restriction.restricted).toBe(true);
    expect(restriction.quarantined).toBe(false);
    expect(restriction.retired).toBe(false);
    expect(restriction.advisoryRefs).toEqual(["adv-restrict"]);

    advisories.publish({
      advisoryId: "adv-critical-retire",
      title: "t",
      severity: "critical",
      description: "d",
      affected: [{ kind: "capability", id: "cap:x" }],
      action: "retire",
      remediation: { summary: "s", workarounds: [] },
      declaredBy: "c",
      publishedAt: 2,
    });
    restriction = advisories.restrictionFor({ kind: "capability", id: "cap:x" });
    expect(restriction.quarantined).toBe(true); // retire is at least quarantine
    expect(restriction.retired).toBe(true);
    expect(restriction.advisoryRefs[0]).toBe("adv-critical-retire"); // most severe first
    expect(advisories.activeRestrictedKeys()).toContain("capability:cap:x");
  });
});

describe("advisory closure (precondition for quarantine release)", () => {
  it("closes only with verified remediation; history stays append-only", () => {
    const advisories = registryWithAdvisory();
    expect(() =>
      advisories.close({
        advisoryId: "adv-2026-001",
        closedAt: 600,
        closureNote: "patch deployed",
        remediationVerified: false,
      }),
    ).toThrow(/verified remediation/);

    const closed = advisories.close({
      advisoryId: "adv-2026-001",
      closedAt: 600,
      closureNote: "patch deployed network-wide",
      remediationVerified: true,
    });
    expect(closed.status).toBe("closed");
    expect(advisories.listActive()).toHaveLength(0);
    // Closed advisories no longer restrict (release path opens).
    expect(advisories.isRestricted(vulnerableExtension)).toBe(false);

    // History preserved: the published event is still there.
    const eventTypes = advisories.history().map((event) => event.eventType);
    expect(eventTypes).toEqual(["published", "closed"]);
    expect(() =>
      advisories.close({
        advisoryId: "adv-2026-001",
        closedAt: 700,
        closureNote: "again",
        remediationVerified: true,
      }),
    ).toThrow(/already closed/);
  });
});

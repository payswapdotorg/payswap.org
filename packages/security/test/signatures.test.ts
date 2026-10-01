import { describe, expect, it } from "vitest";
import {
  ThreatSignatureRegistry,
  compareVersions,
  componentKey,
  componentRef,
  matchesActionPattern,
  signatureMatchesIdentity,
  signatureMatchesObservation,
  versionInRange,
} from "../src/index.js";

/**
 * Threat signatures (W2-005): matchable patterns scoped to vulnerable
 * package/agent/extension identities + affected-version ranges, registry
 * with provenance.
 */

const pkgVuln = {
  signatureId: "sig-pkg-001",
  kind: "vulnerable_package" as const,
  title: "Path traversal in packager",
  description: "Agent package exfiltrates tokens via crafted path",
  affected: {
    kind: "agent_package" as const,
    id: "pkg:exfil-agent",
    versionRange: { minVersion: "1.0.0", maxVersion: "1.9.9" },
  },
  indicators: [
    {
      indicatorId: "ind-1",
      kind: "action_pattern" as const,
      pattern: "files.read.*",
    },
  ],
  declaredBy: "coordinator-disclosure-2026-09",
  publishedAt: 100,
};

describe("version ranges", () => {
  it("compares numeric dotted versions totally and deterministically", () => {
    expect(compareVersions("1.2.0", "1.2.0")).toBe(0);
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("1.2.0", "1.2.1")).toBe(-1);
    expect(compareVersions("1.10.0", "1.9.0")).toBe(1);
    expect(compareVersions("2.0.0", "1.999.999")).toBe(1);
    expect(compareVersions("0.0.1", "0.0.2")).toBe(-1);
  });

  it("rejects non-numeric versions", () => {
    expect(() => compareVersions("1.x.0", "1.0.0")).toThrow();
    expect(() => compareVersions("", "1.0.0")).toThrow();
  });

  it("range matching is inclusive on both bounds", () => {
    const range = { minVersion: "1.2.0", maxVersion: "2.0.0" };
    expect(versionInRange("1.1.9", range)).toBe(false);
    expect(versionInRange("1.2.0", range)).toBe(true);
    expect(versionInRange("1.5.0", range)).toBe(true);
    expect(versionInRange("2.0.0", range)).toBe(true);
    expect(versionInRange("2.0.1", range)).toBe(false);
  });
});

describe("component identity model", () => {
  it("kind + id form the deterministic component key", () => {
    expect(componentKey({ kind: "extension", id: "ext:fx-router" })).toBe(
      "extension:ext:fx-router",
    );
    expect(componentRef({ kind: "capability", id: "cap-1", version: "2.0.0" })).toEqual({
      kind: "capability",
      id: "cap-1",
    });
  });
});

describe("action patterns", () => {
  it("matches exact ids, prefix wildcards and the global wildcard", () => {
    expect(matchesActionPattern("payments.initiate", "payments.initiate")).toBe(true);
    expect(matchesActionPattern("payments.initiate", "payments.cancel")).toBe(false);
    expect(matchesActionPattern("payments.*", "payments.initiate")).toBe(true);
    expect(matchesActionPattern("payments.*", "settlement.net")).toBe(false);
    expect(matchesActionPattern("*", "anything")).toBe(true);
    expect(matchesActionPattern("", "anything")).toBe(false);
  });
});

describe("signature matching", () => {
  const registry = new ThreatSignatureRegistry();
  const signature = registry.register(pkgVuln);

  it("registers with computed provenance content hash", () => {
    expect(signature.provenance.source).toBe("coordinator-disclosure-2026-09");
    expect(signature.provenance.contentHash).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
    expect(signature.indicators).toHaveLength(1);
  });

  it("matches identity in range; no match outside range, other kind or other id", () => {
    expect(
      signatureMatchesIdentity(signature, {
        kind: "agent_package",
        id: "pkg:exfil-agent",
        version: "1.4.2",
      }),
    ).toBe(true);
    expect(
      signatureMatchesIdentity(signature, {
        kind: "agent_package",
        id: "pkg:exfil-agent",
        version: "2.0.0",
      }),
    ).toBe(false);
    expect(
      signatureMatchesIdentity(signature, {
        kind: "extension",
        id: "pkg:exfil-agent",
        version: "1.4.2",
      }),
    ).toBe(false);
    expect(
      signatureMatchesIdentity(signature, {
        kind: "agent_package",
        id: "pkg:other-agent",
        version: "1.4.2",
      }),
    ).toBe(false);
    // Detection is evidence-generating: an unknown version produces no match.
    expect(
      signatureMatchesIdentity(signature, {
        kind: "agent_package",
        id: "pkg:exfil-agent",
      }),
    ).toBe(false);
  });

  it("matches observations only when identity AND an indicator match", () => {
    expect(
      signatureMatchesObservation(signature, {
        component: { kind: "agent_package", id: "pkg:exfil-agent", version: "1.4.2" },
        action: "files.read.workspace",
      }),
    ).toBe(true);
    expect(
      signatureMatchesObservation(signature, {
        component: { kind: "agent_package", id: "pkg:exfil-agent", version: "1.4.2" },
        action: "payments.initiate",
      }),
    ).toBe(false);
    expect(
      signatureMatchesObservation(signature, {
        component: { kind: "agent_package", id: "pkg:exfil-agent", version: "2.0.0" },
        action: "files.read.workspace",
      }),
    ).toBe(false);
  });

  it("registry queries are deterministic and ordered by registration", () => {
    const second = registry.register({
      ...pkgVuln,
      signatureId: "sig-pkg-002",
      affected: { kind: "extension", id: "ext:fx-router" },
      indicators: [
        { indicatorId: "ind-2", kind: "token_family", pattern: "Execution" },
      ],
    });
    const identity = {
      kind: "agent_package",
      id: "pkg:exfil-agent",
      version: "1.4.2",
    } as const;
    expect(registry.matchIdentity(identity).map((s) => s.signatureId)).toEqual([
      "sig-pkg-001",
    ]);
    expect(
      registry.matchIdentity({ kind: "extension", id: "ext:fx-router" }),
    ).toHaveLength(1);
    expect(
      registry
        .matchObservation({
          component: { kind: "extension", id: "ext:fx-router" },
          tokenFamily: "Execution",
        })
        .map((s) => s.signatureId),
    ).toEqual([second.signatureId]);
    expect(registry.list()).toHaveLength(2);
  });

  it("rejects duplicate ids and malformed input", () => {
    expect(() => registry.register(pkgVuln)).toThrow(/already registered/);
    expect(() =>
      registry.register({
        ...pkgVuln,
        signatureId: "sig-bad-kind",
        affected: { kind: "rail" as never, id: "x" },
      }),
    ).toThrow(/unknown affected component kind/);
    expect(() =>
      registry.register({
        ...pkgVuln,
        signatureId: "sig-bad-range",
        affected: {
          kind: "agent_package",
          id: "pkg:x",
          versionRange: { minVersion: "one" },
        },
      }),
    ).toThrow(/invalid version/);
  });
});

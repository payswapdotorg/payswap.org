import { describe, expect, it } from "vitest";
import {
  SecurityAdvisoryRegistry,
  SecurityEpochAuthority,
  SecurityGate,
  QuarantineLedger,
} from "@payswap/security";
import {
  runSecurityReview,
  verifyRemediationPackage,
} from "@payswap/certification";
import type {
  RemediationPackage,
  SecurityReviewSubject,
  StructuralImmuneState,
} from "@payswap/certification";

/**
 * Security review gates (W2-006 acceptance: security failures halt
 * promotion; the gate consumes the REAL immune-system objects — advisory
 * registry, quarantine ledger, epoch authority and the composed gate —
 * through the structural views; INV-S01..S03, INV-A02).
 */

interface ImmuneFixture {
  readonly advisories: SecurityAdvisoryRegistry;
  readonly quarantine: QuarantineLedger;
  readonly epochs: SecurityEpochAuthority;
  readonly gate: SecurityGate;
}

function immuneFixture(): ImmuneFixture {
  const advisories = new SecurityAdvisoryRegistry();
  const quarantine = new QuarantineLedger();
  const epochs = new SecurityEpochAuthority();
  const gate = new SecurityGate({ advisories, quarantine, epochs });
  return { advisories, quarantine, epochs, gate };
}

function publishAdvisory(
  fixture: ImmuneFixture,
  input: {
    advisoryId: string;
    action: "restrict" | "quarantine" | "retire";
    kind?: string;
    id?: string;
    publishedAt?: number;
  },
) {
  return fixture.advisories.publish({
    advisoryId: input.advisoryId,
    title: `Advisory ${input.advisoryId}`,
    severity: "high",
    description: "deterministic fixture advisory",
    affected: [
      {
        kind: (input.kind ?? "agent_package") as "agent_package",
        id: input.id ?? "pkg:routing",
        versionRange: { maxVersion: "2.0.0" },
      },
    ],
    action: input.action,
    remediation: {
      summary: "Upgrade to the patched version.",
      patchedVersion: "2.0.1",
      workarounds: [],
    },
    declaredBy: "security-team",
    publishedAt: input.publishedAt ?? 1_000,
  });
}

function subjectFixture(
  overrides: Partial<SecurityReviewSubject> = {},
): SecurityReviewSubject {
  return {
    componentKind: "strategy",
    subjectId: "cand-1",
    version: "1",
    screenedComponents: [
      { kind: "agent_package", id: "pkg:routing", version: "1.9.0" },
      { kind: "extension", id: "ext:fx-router" },
    ],
    authorizationIssuedAtEpoch: 0n,
    ...overrides,
  };
}

describe("the security review gate over the REAL immune-system objects", () => {
  it("passes a clean subject at the current epoch", () => {
    const fixture = immuneFixture();
    const outcome = runSecurityReview({
      subject: subjectFixture(),
      immune: fixture.gate, // the real composed gate object, structurally consumed
    });
    expect(outcome.passed).toBe(true);
    if (outcome.passed) {
      expect(outcome.screened).toBe(2);
      expect(outcome.currentEpoch).toBe(0n);
    }
    expect(outcome.reviewDigest.length).toBeGreaterThan(0);
  });

  it("an active restrict advisory fails the review globally (INV-S01)", () => {
    const fixture = immuneFixture();
    publishAdvisory(fixture, { advisoryId: "PSA-001", action: "restrict" });
    const outcome = runSecurityReview({
      subject: subjectFixture(),
      immune: fixture.gate,
    });
    expect(outcome.passed).toBe(false);
    if (!outcome.passed) {
      const restricted = outcome.failures.filter(
        (failure) => failure.failure === "component_restricted",
      );
      expect(restricted).toHaveLength(1);
      expect(restricted[0]?.advisoryRefs).toContain("PSA-001");
    }
  });

  it("an enforced quarantine advisory fails the review on both axes (INV-S01/S03)", () => {
    const fixture = immuneFixture();
    const advisory = publishAdvisory(fixture, {
      advisoryId: "PSA-002",
      action: "quarantine",
    });
    fixture.gate.enforceAdvisory(advisory, { advanceEpoch: true });
    const outcome = runSecurityReview({
      subject: subjectFixture({ authorizationIssuedAtEpoch: 1n }),
      immune: fixture.gate,
    });
    expect(outcome.passed).toBe(false);
    if (!outcome.passed) {
      const quarantined = outcome.failures.filter(
        (failure) => failure.failure === "component_quarantined",
      );
      expect(quarantined).toHaveLength(1);
      expect(quarantined[0]?.quarantineIds.length).toBe(1);
      expect(quarantined[0]?.advisoryRefs).toContain("PSA-002");
    }
  });

  it("a quarantine-action advisory blocks even without a ledger record (defense in depth)", () => {
    const fixture = immuneFixture();
    // Published but never enforced into the quarantine ledger.
    publishAdvisory(fixture, { advisoryId: "PSA-003", action: "quarantine" });
    const outcome = runSecurityReview({
      subject: subjectFixture(),
      immune: fixture.gate,
    });
    expect(outcome.passed).toBe(false);
    if (!outcome.passed) {
      expect(
        outcome.failures.some(
          (failure) =>
            failure.failure === "active_advisory_affects_subject" &&
            failure.advisoryId === "PSA-003",
        ),
      ).toBe(true);
    }
  });

  it("a retire advisory retires the component out of certification (INV-S01)", () => {
    const fixture = immuneFixture();
    publishAdvisory(fixture, { advisoryId: "PSA-004", action: "retire" });
    const outcome = runSecurityReview({
      subject: subjectFixture(),
      immune: fixture.gate,
    });
    expect(outcome.passed).toBe(false);
    if (!outcome.passed) {
      expect(
        outcome.failures.some((failure) => failure.failure === "component_retired"),
      ).toBe(true);
    }
  });

  it("an epoch advance makes stale authorizations fail the review (INV-S02/A02)", () => {
    const fixture = immuneFixture();
    fixture.epochs.advance({ reason: "incident response", at: 2_000 });
    const outcome = runSecurityReview({
      subject: subjectFixture({ authorizationIssuedAtEpoch: 0n }),
      immune: fixture.gate,
    });
    expect(outcome.passed).toBe(false);
    if (!outcome.passed) {
      const stale = outcome.failures.find(
        (failure) => failure.failure === "stale_authorization_epoch",
      );
      expect(stale).toBeDefined();
      if (stale?.failure === "stale_authorization_epoch") {
        expect(stale.issuedAtEpoch).toBe(0n);
        expect(stale.currentEpoch).toBe(1n);
      }
    }
    // A re-issued authorization at the current epoch passes again.
    const fresh = runSecurityReview({
      subject: subjectFixture({ authorizationIssuedAtEpoch: 1n }),
      immune: fixture.gate,
    });
    expect(fresh.passed).toBe(true);
  });

  it("quarantined components cannot pass through a cached-availability path (INV-S03)", () => {
    const fixture = immuneFixture();
    const advisory = publishAdvisory(fixture, {
      advisoryId: "PSA-005",
      action: "quarantine",
      kind: "capability",
      id: "cap:wire-transfer",
    });
    fixture.gate.enforceAdvisory(advisory);
    const outcome = runSecurityReview({
      subject: subjectFixture({
        screenedComponents: [{ kind: "capability", id: "cap:wire-transfer" }],
        authorizationIssuedAtEpoch: 0n,
      }),
      immune: fixture.gate,
    });
    expect(outcome.passed).toBe(false);
    // Deterministic re-run: identical inputs → identical outcome.
    const again = runSecurityReview({
      subject: subjectFixture({
        screenedComponents: [{ kind: "capability", id: "cap:wire-transfer" }],
        authorizationIssuedAtEpoch: 0n,
      }),
      immune: fixture.gate,
    });
    expect(again.reviewDigest).toBe(outcome.reviewDigest);
  });

  it("malformed subjects are rejected fail-closed", () => {
    const fixture = immuneFixture();
    expect(() =>
      runSecurityReview({
        subject: subjectFixture({ screenedComponents: [] }),
        immune: fixture.gate,
      }),
    ).toThrow(/at least one component/);
    expect(() =>
      runSecurityReview({
        subject: subjectFixture({ subjectId: "" }),
        immune: fixture.gate,
      }),
    ).toThrow(/subjectId/);
  });
});

describe("remediation evidence (the only path back after a halt)", () => {
  it("rejects remediation while the driving advisory is still active", () => {
    const fixture = immuneFixture();
    const advisory = publishAdvisory(fixture, {
      advisoryId: "PSA-100",
      action: "quarantine",
    });
    fixture.gate.enforceAdvisory(advisory);
    const remediation: RemediationPackage = {
      haltedOrderRef: "halt:prod-order-1",
      closedAdvisoryRefs: ["PSA-100"],
      evidence: [
        {
          evidenceId: "ev-remediation-1",
          artifactRef: "artifacts/patch-report",
          contentDigest: "digest-remediation-1",
        },
      ],
    };
    const violations = verifyRemediationPackage({
      remediation,
      immune: fixture.gate,
    });
    expect(violations.join(" ")).toContain("still active");

    // Close the advisory with verified remediation → the package validates.
    fixture.advisories.close({
      advisoryId: "PSA-100",
      closedAt: 3_000,
      closureNote: "patched everywhere",
      remediationVerified: true,
    });
    expect(
      verifyRemediationPackage({ remediation, immune: fixture.gate }),
    ).toEqual([]);
  });

  it("rejects empty remediation evidence and unknown advisories (fail closed)", () => {
    const fixture = immuneFixture();
    const violations = verifyRemediationPackage({
      remediation: {
        haltedOrderRef: "halt:prod-order-2",
        closedAdvisoryRefs: [],
        evidence: [],
      },
      immune: fixture.gate,
    });
    expect(violations.length).toBeGreaterThanOrEqual(2);

    const unknown = verifyRemediationPackage({
      remediation: {
        haltedOrderRef: "halt:prod-order-2",
        closedAdvisoryRefs: ["PSA-DOES-NOT-EXIST"],
        evidence: [
          {
            evidenceId: "ev-1",
            artifactRef: "artifacts/x",
            contentDigest: "digest-x",
          },
        ],
      },
      immune: fixture.gate,
    });
    expect(unknown.join(" ")).toContain("unknown advisory");
  });
});

describe("structural consumption of the immune-system state", () => {
  it("the real registry, ledger and epoch authority are assignable to the structural views", () => {
    const fixture = immuneFixture();
    // Type-level proof at compile time; runtime proof here: the composed
    // gate object IS the immune state the review consumes.
    const immune: StructuralImmuneState = fixture.gate;
    expect(immune.advisories.listActive()).toEqual([]);
    expect(immune.epochs.currentEpoch().value).toBe(0n);
    expect(immune.quarantine.isQuarantined({ kind: "agent_package", id: "x" })).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import { JOURNEYS } from "@payswap/journeys";
import { PAYMENT_JOURNEY_STATES } from "@payswap/ux";

import {
  BROWSER_JOURNEY_CONTRACTS,
  BROWSER_VERIFICATION_CHECKS,
  CERTIFICATION_JOURNEY_CONTRACTS,
  UX_PAYMENT_JOURNEY_CONTRACTS,
  checkBrowserJourneyContracts,
  recordBrowserVerificationRun,
  type BrowserJourneyContract,
} from "../src/browser-verification.js";

// ---------------------------------------------------------------------------
// Journey contract completeness (W3-007 acceptance)
// ---------------------------------------------------------------------------

describe("browser journey contract completeness", () => {
  it("the default contract set passes the deterministic checker", () => {
    const report = checkBrowserJourneyContracts();
    expect(report.passed).toBe(true);
    expect(report.violations).toEqual([]);
  });

  it("covers EVERY ux payment journey", () => {
    const contracted = new Set(
      UX_PAYMENT_JOURNEY_CONTRACTS.map((contract) => contract.journeyId),
    );
    for (const spec of PAYMENT_JOURNEY_STATES) {
      expect(contracted.has(spec.journeyId)).toBe(true);
    }
    expect(UX_PAYMENT_JOURNEY_CONTRACTS).toHaveLength(
      PAYMENT_JOURNEY_STATES.length,
    );
  });

  it("covers EVERY W1-007 certification journey", () => {
    const contracted = new Set(
      CERTIFICATION_JOURNEY_CONTRACTS.map((contract) => contract.journeyId),
    );
    for (const journey of JOURNEYS) {
      expect(contracted.has(journey.journeyId)).toBe(true);
    }
    expect(CERTIFICATION_JOURNEY_CONTRACTS).toHaveLength(JOURNEYS.length);
  });

  it("every contract declares exactly the six required checks", () => {
    for (const contract of BROWSER_JOURNEY_CONTRACTS) {
      expect([...BROWSER_VERIFICATION_CHECKS].sort()).toEqual(
        [...contract.requiredChecks].sort(),
      );
    }
  });

  it("every contract declares at least one key interaction", () => {
    for (const contract of BROWSER_JOURNEY_CONTRACTS) {
      expect(contract.keyInteractions.length).toBeGreaterThan(0);
      for (const interaction of contract.keyInteractions) {
        expect(interaction.correlatedProtocolId).toBeTruthy();
      }
    }
  });

  it("UX key interactions reference states that exist in the journey state table", () => {
    for (const contract of UX_PAYMENT_JOURNEY_CONTRACTS) {
      const spec = PAYMENT_JOURNEY_STATES.find(
        (candidate) => candidate.journeyId === contract.journeyId,
      );
      expect(spec).toBeDefined();
      const states = new Set(spec!.states.map((state) => state.stateName));
      for (const interaction of contract.keyInteractions) {
        expect(states.has(interaction.expectedJourneyState)).toBe(true);
      }
    }
  });

  it("the checker DETECTS a contract with an unknown expected state", () => {
    const broken: BrowserJourneyContract = {
      journeyId: "choose-or-delegate-payment",
      title: "broken",
      source: "UX_PAYMENT_JOURNEY",
      surface: "Payments",
      requiredChecks: [...BROWSER_VERIFICATION_CHECKS],
      keyInteractions: [
        {
          interactionId: "nonexistent",
          description: "references a state that does not exist",
          expectedJourneyState: "NO_SUCH_STATE",
          correlatedProtocolId: "attemptId",
        },
      ],
      unknownHandling: {
        applies: false,
        notApplicableReason: "n/a",
      },
      screenshotArtifact: {
        evidenceId: "screenshot:broken",
        strength: "BROWSER_UNAUTHENTICATED_PROVENANCE",
      },
    };
    const report = checkBrowserJourneyContracts([broken]);
    expect(report.passed).toBe(false);
    expect(
      report.violations.some(
        (violation) => violation.check === "key-interactions",
      ),
    ).toBe(true);
  });

  it("the checker DETECTS a missing required check", () => {
    const [first, ...rest] = BROWSER_VERIFICATION_CHECKS;
    const broken: BrowserJourneyContract = {
      journeyId: "p2p",
      title: "broken",
      source: "W1_007_CERTIFICATION_JOURNEY",
      surface: "Payments",
      requiredChecks: rest,
      keyInteractions: [
        {
          interactionId: "complete-p2p-transfer",
          description: "drive",
          expectedJourneyState: "FULFILLED",
          correlatedProtocolId: "settlementId",
        },
      ],
      unknownHandling: {
        applies: false,
        notApplicableReason: "n/a",
      },
      screenshotArtifact: {
        evidenceId: "screenshot:p2p",
        strength: "BROWSER_UNAUTHENTICATED_PROVENANCE",
      },
    };
    expect(first).toBeDefined();
    const report = checkBrowserJourneyContracts([broken]);
    expect(report.passed).toBe(false);
    expect(
      report.violations.some(
        (violation) =>
          violation.check === "required-checks" &&
          violation.detail.includes(first as string),
      ),
    ).toBe(true);
  });

  it("the checker DETECTS an over-strong screenshot provenance (INV-E04)", () => {
    const broken: BrowserJourneyContract = {
      journeyId: "p2p",
      title: "broken",
      source: "W1_007_CERTIFICATION_JOURNEY",
      surface: "Payments",
      requiredChecks: [...BROWSER_VERIFICATION_CHECKS],
      keyInteractions: [
        {
          interactionId: "complete-p2p-transfer",
          description: "drive",
          expectedJourneyState: "FULFILLED",
          correlatedProtocolId: "settlementId",
        },
      ],
      unknownHandling: {
        applies: false,
        notApplicableReason: "n/a",
      },
      screenshotArtifact: {
        evidenceId: "screenshot:p2p",
        strength: "AUTHENTICATED" as "BROWSER_UNAUTHENTICATED_PROVENANCE",
      },
    };
    const report = checkBrowserJourneyContracts([broken]);
    expect(report.passed).toBe(false);
    expect(
      report.violations.some(
        (violation) => violation.check === "evidence-strength",
      ),
    ).toBe(true);
  });

  it("UNKNOWN-relevant journeys render reconciling with the reconciliation path surfaced (INV-X01)", () => {
    const unknownJourneys = BROWSER_JOURNEY_CONTRACTS.filter(
      (contract) => contract.unknownHandling.applies,
    );
    expect(unknownJourneys.length).toBeGreaterThanOrEqual(2);
    for (const contract of unknownJourneys) {
      if (contract.unknownHandling.applies) {
        expect(contract.unknownHandling.rendersAs).toBe("reconciling");
        expect(contract.unknownHandling.reconciliationPathSurfaced).toBe(true);
      }
    }
    const ids = unknownJourneys.map((contract) => contract.journeyId);
    expect(ids).toContain("initiate-refund-or-dispute");
    expect(ids).toContain("record-off-network-payment");
  });
});

// ---------------------------------------------------------------------------
// Verification runs (deployment-gate artifacts)
// ---------------------------------------------------------------------------

describe("browser verification run recording", () => {
  it("assembles a passing report when every check passes with evidence", () => {
    const report = recordBrowserVerificationRun([
      {
        journeyId: "choose-or-delegate-payment",
        checks: BROWSER_VERIFICATION_CHECKS.map((check) => ({
          check,
          passed: true,
          evidenceRef: `evidence:${check}`,
        })),
      },
    ]);
    expect(report.passed).toBe(true);
    expect(report.workOrder).toBe("W3-007");
    expect(report.digest).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
  });

  it("fails the report when any check fails", () => {
    const report = recordBrowserVerificationRun([
      {
        journeyId: "p2p",
        checks: BROWSER_VERIFICATION_CHECKS.map((check) => ({
          check,
          passed: check !== "console-error-check",
          evidenceRef: `evidence:${check}`,
        })),
      },
    ]);
    expect(report.passed).toBe(false);
    expect(report.runs[0]?.passed).toBe(false);
  });

  it("fills missing checks as failures (no silent gaps)", () => {
    const report = recordBrowserVerificationRun([
      {
        journeyId: "p2p",
        checks: [
          { check: "desktop-verification", passed: true, evidenceRef: "e" },
        ],
      },
    ]);
    expect(report.passed).toBe(false);
    const failing = report.runs[0]?.checks.filter((result) => !result.passed);
    expect(failing?.map((result) => result.check)).toEqual(
      expect.arrayContaining(["responsive-mobile-verification", "screenshot-artifact"]),
    );
    expect(failing?.every((result) => result.evidenceRef === "missing")).toBe(true);
  });
});

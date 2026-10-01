import { describe, expect, it } from "vitest";
import { USD, fromMinorUnits } from "@payswap/protocol";
import { checkSensitiveActionAuthorization, SecurityEpochAuthority } from "@payswap/security";
import { ACCEPTANCE_AXES } from "../src/harness.js";
import { journeyPassed } from "../src/harness.js";
import { runP2PJourney } from "../src/journeys/p2p.js";

describe("Journey: P2P transfer (W1-007)", () => {
  const outcome = runP2PJourney();

  it("passes every acceptance axis", () => {
    expect(journeyPassed(outcome.journey)).toBe(true);
    for (const assertion of outcome.journey.assertions) {
      expect({ axis: assertion.axis, passed: assertion.passed, summary: assertion.summary })
        .toEqual({ axis: assertion.axis, passed: true, summary: assertion.summary });
    }
  });

  it("asserts the five journey axes (the suite-level baseline axis is certified by the PSP journey)", () => {
    const axes = new Set(outcome.journey.assertions.map((a) => a.axis));
    expect([...axes].sort()).toEqual(
      [...ACCEPTANCE_AXES.filter((axis) => axis !== "PASS_THROUGH_NATIVE_BASELINE")].sort(),
    );
  });

  it("evidences obligations -> netting -> settlement -> finality", () => {
    const { chain } = outcome.details;
    expect(chain.obligations).toHaveLength(2);
    expect(chain.positions).toHaveLength(1);
    expect(chain.settlements).toHaveLength(1);
    expect(chain.positions[0]?.derivation.gross).toHaveLength(2);
    expect(chain.settlements[0]?.finality.state).toBe("FINAL");
    expect(chain.settlements[0]?.certificate.evidenceChain).toHaveLength(3);
    expect(chain.settlements[0]?.instruction.fromNetPosition.derivation.gross).toHaveLength(2);
  });

  it("nets the reciprocal gross flows exactly (INV-F07)", () => {
    expect(outcome.details.netObligationMinorUnits).toBe(7_000n);
    expect(outcome.details.grossActivities).toBe(2);
  });

  it("reconciles accounting to zero with the exact fee (INV-F01/F03)", () => {
    expect(outcome.details.feeMinorUnits).toBe(50n);
    expect(outcome.details.aliceBalanceAfter).toEqual(fromMinorUnits(USD, 92_950n));
    expect(outcome.details.bobBalanceAfter).toEqual(fromMinorUnits(USD, 7_000n));
  });

  it("requires approvals and proofs (INV-A01/A03/E01/E03/S02)", () => {
    expect(outcome.details.mandateAllowed).toBe(true);
    expect(outcome.details.childGrantAllowed).toBe(true);
    expect(outcome.details.wideningRejected).toBe(true);
    expect(outcome.details.approvalArtifactValid).toBe(true);
    expect(outcome.details.tamperedApprovalRejected).toBe(true);
    expect(outcome.details.epochCheckPassed).toBe(true);
    expect(outcome.details.proposalIsAdvisory).toBe(true);
  });

  it("enforces atomic reservations (INV-F04)", () => {
    expect(outcome.details.overReservationRejected).toBe(true);
    expect(outcome.details.reservationCaptured).toBe(true);
  });

  it("composes the security plane: epoch-scoped sensitive-action authorization (INV-S02)", () => {
    // The security immune system is composed HERE (test layer) per the
    // repo-wide isolation boundary; the journey's trust-plane epoch checks
    // (INV-A02) are asserted above.
    const now = 1_765_000_000_000;
    const epochs = new SecurityEpochAuthority();
    checkSensitiveActionAuthorization(
      {
        authorizationRef: "authz:p2p:transfer-1",
        principalRef: "user:alice",
        actionClass: "money_movement",
        issuedAtEpoch: epochs.currentEpoch().value,
        expiresAt: now + 3_600_000,
      },
      epochs,
      now,
    );
    expect(() =>
      checkSensitiveActionAuthorization(
        {
          authorizationRef: "authz:p2p:transfer-1",
          principalRef: "user:alice",
          actionClass: "money_movement",
          issuedAtEpoch: 0n,
          expiresAt: now + 3_600_000,
        },
        epochs,
        now,
      ),
    ).not.toThrow();
    epochs.advance({ reason: "credential rotation", at: now + 1 });
    expect(() =>
      checkSensitiveActionAuthorization(
        {
          authorizationRef: "authz:p2p:transfer-1",
          principalRef: "user:alice",
          actionClass: "money_movement",
          issuedAtEpoch: 0n,
          expiresAt: now + 3_600_000,
        },
        epochs,
        now + 2,
      ),
    ).toThrow(/stale/i);
  });
});

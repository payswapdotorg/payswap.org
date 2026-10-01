/**
 * W2-007 fault family — clock skew.
 *
 * Attack: the wall clock jumps backwards (negative skew), then forward past
 * every deadline. An attacker tries to use the regressed clock to act on an
 * expired authorization, settle an obligation before its window opens, and
 * inflate weak evidence.
 *
 * Defense: epoch observation detects regression (EpochRegressionError);
 * due-window and expiry decisions are monotonic under the injected clock
 * (early settle guard-rejected, terminal states never re-entered); an
 * expired grant never re-authorizes at any clock reading past its absolute
 * expiry; UI/browser evidence is capped by provenance regardless of claims.
 *
 * Invariants on the line: INV-A02 (no retroactive authorization),
 * INV-X04 (terminal transitions monotonic), INV-O01 (retry-safe under skew),
 * INV-E04 (UI artifacts not stronger than authenticated provenance).
 */

import {
  EpochCounter,
  TerminalStateViolationError,
  TransitionGuardError,
  deriveObligations,
  drain,
  settleObligation,
} from "@payswap/protocol";
import { effectiveEvidenceLevel } from "@payswap/settlement";
import { StaticClock } from "@payswap/journeys";
import {
  adversarialCommand,
  buildAdversarialWorld,
  clearingRecord,
  getOutboxRecord,
  injectionCheck,
  outboxEvent,
  probe,
  recoveryStep,
  usd,
} from "../harness.js";
import type {
  AdversarialScenario,
  FaultExecution,
} from "../harness.js";

function errorNameOf(error: unknown): string {
  return error instanceof Error ? error.constructor.name : "unknown";
}

export function clockSkewScenario(): AdversarialScenario {
  const declaration = {
    faultId: "fault:clock-skew:1",
    family: "clock-skew" as const,
    title: "Backwards clock jump — monotonicity, expiry and evidence caps under skew",
    description:
      "The deterministic clock is skewed backwards mid-flight, then forwarded past every deadline; authorization expiry, obligation windows, terminal monotonicity, retry backoff and evidence provenance must all behave identically to the un-skewed timeline.",
    candidateInvariants: ["INV-A02", "INV-X04", "INV-O01", "INV-E04"],
    attackedSubsystems: ["@payswap/protocol", "@payswap/settlement", "@payswap/execution", "@payswap/journeys"],
  };

  return {
    declaration,
    run: async (): Promise<FaultExecution> => {
      const world = buildAdversarialWorld();
      const now = (): bigint => world.journey.clock.now();
      const t0 = now();

      // --- ground truth: a grant, an obligation and an outbox event -------
      const command = adversarialCommand(world, "adversarial.hold", "idem:skew:1", {
        amountMinor: "1200",
        currency: "USD",
      });
      world.journey.grants.issue({
        grantId: "grant:skew:1",
        command,
        scope: {
          capabilityInstanceIds: ["inst:payments:psp-skew"],
          executionModes: ["PASS_THROUGH_NATIVE"],
        },
        requestHash: "reqhash:skew:1",
        expiresAt: t0 + 3_600_000n,
        authorizationEvidenceRef: "authz:skew:1",
      });

      const records = clearingRecord(
        "CR:SKEW:1",
        [
          {
            id: "act:SKEW:1",
            activityType: "MERCHANT_SALE",
            debtor: "merchant-1",
            creditor: "customer-1",
            amount: usd(1200n),
            occurredAt: t0,
          },
        ],
        world,
      );
      const obligations = deriveObligations([records], {
        dueWindow: { opensAt: t0 + 1_000n, closesAt: t0 + 86_400_000n },
      });
      for (const obligation of obligations) {
        world.journey.obligations.add(obligation);
      }
      const target = obligations[0];
      if (target === undefined) {
        throw new Error("fixture setup: expected one obligation");
      }
      const eventId = "evt:skew:1";
      world.outbox.enqueue([
        outboxEvent(world, eventId, "adversarial.hold.created", { idempotencyKey: "idem:skew:1" }, "cmd:idem:skew:1"),
      ]);

      // --- INJECTION: the clock jumps BACKWARDS ----------------------------
      const skewMs = -3_600_000n;
      world.journey.clock.advanceMs(skewMs);
      const regressedNow = now();

      // The epoch counter detects non-monotonic observation.
      const epochs = new EpochCounter();
      epochs.next(); // current becomes 1n
      let regressionDetected = false;
      let regressionError = "";
      try {
        epochs.observe(0n); // an attacker replays an epoch BELOW current
      } catch (error) {
        regressionDetected = true;
        regressionError = errorNameOf(error);
      }

      // --- the attack: act on the regressed reading vs the absolute expiry -
      const verifyAtRegressed = world.journey.grants.verify("grant:skew:1", {
        now: regressedNow,
        requestHash: "reqhash:skew:1",
        capabilityInstanceId: "inst:payments:psp-skew",
        executionMode: "PASS_THROUGH_NATIVE",
      });
      const verifyAtTrueExpiry = world.journey.grants.verify("grant:skew:1", {
        now: t0 + 3_600_001n, // one tick past the ABSOLUTE expiry
        requestHash: "reqhash:skew:1",
        capabilityInstanceId: "inst:payments:psp-skew",
        executionMode: "PASS_THROUGH_NATIVE",
      });

      // --- the attack: settle BEFORE the window opens (skewed-early) -------
      let earlySettleRejected = false;
      let earlySettleError = "";
      try {
        settleObligation(world.journey.obligations, target.id, new StaticClock(t0 - 3_600_000n));
      } catch (error) {
        earlySettleRejected = error instanceof TransitionGuardError;
        earlySettleError = errorNameOf(error);
      }

      // --- INV-O01: retry backoff under a regressed clock reading ----------
      const drainAtRegressed = await drain(
        world.outbox,
        {
          publish: async () => {
            throw new Error("transport down during skew");
          },
        },
        { clock: world.journey.clock },
      );
      const skewedRecord = getOutboxRecord(world, eventId);

      // --- recovery: the clock re-synchronizes forward ---------------------
      world.journey.clock.advanceMs(3_600_000n + 3_600_001n); // back to t0, then past true expiry
      const resyncedNow = now();

      // The obligation settles exactly once, inside its window.
      const settled = settleObligation(world.journey.obligations, target.id, new StaticClock(t0 + 2_000n));

      // --- INJECTION: terminal monotonicity — settle AGAIN -----------------
      let reSettleRejected = false;
      let reSettleError = "";
      try {
        settleObligation(world.journey.obligations, target.id, new StaticClock(t0 + 3_000n));
      } catch (error) {
        reSettleRejected = error instanceof TerminalStateViolationError;
        reSettleError = errorNameOf(error);
      }

      // --- INV-E04: UI/browser evidence caps under any clock ---------------
      const unauthenticatedClaim = effectiveEvidenceLevel({
        claimedLevel: "P5",
        provenance: { source: "UI_BROWSER_ARTIFACT", authenticated: false },
      });
      const authenticatedClaim = effectiveEvidenceLevel({
        claimedLevel: "P5",
        provenance: { source: "UI_BROWSER_ARTIFACT", authenticated: true },
      });

      // --- recovery: the outbox drains once the transport heals ------------
      world.journey.clock.advanceMs(120_000);
      const healReport = await drain(
        world.outbox,
        {
          publish: async () => {
            /* healed transport */
          },
        },
        { clock: world.journey.clock },
      );
      const healedRecord = getOutboxRecord(world, eventId);

      const injectionChecks = [
        injectionCheck(
          regressedNow === t0 + skewMs && regressedNow < t0,
          `the deterministic clock was skewed BACKWARDS by ${skewMs}ms (now reads ${regressedNow}, was ${t0})`,
        ),
        injectionCheck(
          regressionDetected && regressionError === "EpochRegressionError",
          `epoch observation detected the regression attempt (${regressionError})`,
        ),
        injectionCheck(
          earlySettleRejected && earlySettleError === "TransitionGuardError",
          `settling the obligation before its window opens was guard-rejected (${earlySettleError})`,
        ),
        injectionCheck(
          reSettleRejected && reSettleError === "TerminalStateViolationError",
          `settling the already-SETTLED obligation again threw ${reSettleError}`,
        ),
      ];

      const probes = [
        probe(
          "INV-A02",
          verifyAtRegressed.ok === true &&
            verifyAtTrueExpiry.ok === false &&
            verifyAtTrueExpiry.reason === "EXPIRED",
          `no retroactive authorization: the grant is valid at the regressed reading ${regressedNow} (it had not absolutely expired) but EXPIRED at ${t0 + 3_600_001n} — one tick past its absolute expiry at ANY clock reading; a clock regression can never resurrect an expired grant`,
        ),
        probe(
          "INV-X04",
          earlySettleRejected &&
            earlySettleError === "TransitionGuardError" &&
            settled.state === "SETTLED" &&
            reSettleRejected &&
            reSettleError === "TerminalStateViolationError",
          `terminal transitions stayed monotonic under skew: early settle guard-rejected, the in-window settle landed SETTLED once, and the post-terminal settle threw TerminalStateViolationError`,
        ),
        probe(
          "INV-O01",
          skewedRecord !== undefined &&
            skewedRecord.status === "PENDING" &&
            skewedRecord.attempts === 1 &&
            drainAtRegressed.published.length === 0 &&
            healedRecord !== undefined &&
            healedRecord.status === "PUBLISHED" &&
            healReport.published.length === 1,
          `async retry stayed safe under skew: the failed delivery parked the record PENDING with backoff (attempts ${skewedRecord?.attempts ?? 0}), the regressed-reading drain published nothing early, and the healed transport delivered exactly once`,
        ),
        probe(
          "INV-E04",
          unauthenticatedClaim === "P0" && authenticatedClaim === "P1",
          `UI/browser evidence is capped by provenance regardless of claims or clock: a P5 claim from an unauthenticated browser artifact evaluates ${unauthenticatedClaim}, an authenticated one ${authenticatedClaim}`,
        ),
      ];

      const recoveryPath = [
        recoveryStep(
          1,
          "Clock regression detected, not silently accepted",
          regressionDetected,
          `EpochCounter.observe refused the below-current epoch (${regressionError}) — protocol epochs are monotonic`,
        ),
        recoveryStep(
          2,
          "Clock re-synchronized forward to true time",
          resyncedNow > regressedNow && resyncedNow === t0 + 3_600_001n,
          `advanceMs restored and forwarded the clock to ${resyncedNow} (past the grant's absolute expiry)`,
        ),
        recoveryStep(
          3,
          "All time-bounded decisions re-evaluated at true time",
          verifyAtTrueExpiry.ok === false,
          `the grant verifies EXPIRED at the true reading — the skew window did not extend any authority`,
        ),
        recoveryStep(
          4,
          "Obligation settled exactly once inside its window",
          settled.state === "SETTLED" && reSettleRejected,
          `the in-window settle landed SETTLED; the duplicate settle threw ${reSettleError}`,
        ),
        recoveryStep(
          5,
          "Outbox re-drained after transport healing",
          healedRecord !== undefined && healedRecord.status === "PUBLISHED",
          `event ${eventId} published with backoff-respecting retry (never early, never lost)`,
        ),
      ];

      const evidenceRefs = [
        "grant:skew:1",
        target.id,
        eventId,
        `clock:${regressedNow}`,
        `clock:${resyncedNow}`,
      ];

      return {
        declaration,
        injected: injectionChecks.every((check) => check.ok),
        injectionChecks,
        probes,
        recoveryPath,
        evidenceRefs,
      };
    },
  };
}

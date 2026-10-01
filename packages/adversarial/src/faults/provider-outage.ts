/**
 * W2-007 fault family — provider outage.
 *
 * Attack: a rail provider goes down while a settlement's external write is
 * in flight. The outbox transport is also down (the committed mutation
 * cannot be published).
 *
 * Defense: the incident recorder evidences the outage window; the external
 * write during the window surfaces as UNKNOWN (never FAILED, never a
 * fabricated business outcome); blind retries are refused; the case is
 * resolved ONLY through reconciliation after recovery probes evidence the
 * rail is healthy again; finality is declared over the reconciled
 * instruction. The frozen W2-006 replay-fault contract is verified over a
 * REAL Lab replay.
 *
 * Invariants on the line: INV-X01, INV-X02, INV-X03, INV-S04, INV-O02.
 */

import { declareFault, verifyFaultContract } from "@payswap/certification";
import type { StructuralReplayResult } from "@payswap/certification";
import { asSettlementAttemptId, defineProofPolicy, deriveSettlementInstruction } from "@payswap/settlement";
import { settleObligation } from "@payswap/protocol";
import { StaticClock } from "@payswap/journeys";
import type { Obligation } from "@payswap/protocol";
import {
  ADVERSARIAL_PRINCIPAL,
  beginAdversarialChain,
  buildAdversarialWorld,
  clearingRecord,
  drainOutbox,
  getOutboxRecord,
  injectionCheck,
  LosingPublisher,
  outboxEvent,
  probe,
  recoveryStep,
  RecordingPublisher,
  usd,
} from "../harness.js";
import type {
  AdversarialScenario,
  FaultExecution,
} from "../harness.js";

const RAIL = "rail:psp-outage";

export interface ProviderOutageOptions {
  /**
   * A REAL Lab replay (runReplay over recorded facts with an in-flight
   * external write under outage) flowing through the structural view —
   * composed at the test layer (the Lab package is test-layer-only).
   */
  readonly replay: StructuralReplayResult;
}

export function providerOutageScenario(options: ProviderOutageOptions): AdversarialScenario {
  const declaration = {
    faultId: "fault:provider-outage:1",
    family: "provider-outage" as const,
    title: "Rail provider outage during an in-flight external write",
    description:
      "A provider outage window covers the moment of an in-flight settlement write; the write surfaces as UNKNOWN requiring reconciliation (never FAILED), blind retries are refused, recovery probes evidence the rail's return, the reconciliation case resolves with evidence, finality is declared over the reconciled instruction, and the frozen W2-006 replay-fault contract is verified over a real Lab replay.",
    candidateInvariants: ["INV-X01", "INV-X02", "INV-X03", "INV-S04", "INV-O02"],
    attackedSubsystems: ["@payswap/rails", "@payswap/settlement", "@payswap/protocol", "@payswap/certification"],
  };

  return {
    declaration,
    run: async (): Promise<FaultExecution> => {
      const world = buildAdversarialWorld();
      const now = (): bigint => world.journey.clock.now();

      // --- ground truth: an in-flight settlement ---------------------------
      const chain = beginAdversarialChain({
        world,
        sequence: "provider-outage",
        clearingRecords: [
          clearingRecord("CR:OUTAGE:1", [
            {
              id: "act:OUTAGE:1",
              activityType: "MERCHANT_SALE",
              debtor: "merchant-1",
              creditor: "customer-1",
              amount: usd(7700n),
            },
          ], world),
        ],
        dueWindow: { opensAt: now() + 1n, closesAt: now() + 86_400_000n },
        rail: RAIL,
        settlementDestinationId: "dest:merchant-1",
        authorizationRefs: ["authz:outage:1"],
      });

      // --- INJECTION: the provider outage begins ---------------------------
      world.incidents.beginOutage({
        railId: RAIL,
        startedAt: now(),
        evidenceRef: "status-page:inc-77:start",
        now: now(),
        note: "provider status page: elevated error rates",
      });
      const outageOpen = world.incidents.isOpen(RAIL, now() + 1n);

      // The outbox transport is down too: the committed mutation's event
      // cannot be published and must not be silently lost (INV-O02).
      const eventId = `evt:${chain.attemptId}`;
      world.outbox.enqueue([
        outboxEvent(world, eventId, "settlement.attempt.started", {
          attemptId: chain.attemptId,
          rail: RAIL,
        }, chain.attemptId),
      ]);
      const losingPublisher = new LosingPublisher();
      await drainOutbox(world, losingPublisher);
      const recordDuringOutage = getOutboxRecord(world, eventId);

      // --- the external write lands INSIDE the outage window ---------------
      const effectAt = now() + 1n;
      const classification = world.incidents.classifyExternalEffect({ railId: RAIL, effectAt });
      world.journey.settlementAttempts.recordExternalOutcome(
        chain.attemptId,
        "OUTCOME_UNKNOWN",
        [`ev:outage:ambiguity:${chain.attemptId}`],
        effectAt,
      );
      const attempt = world.journey.settlementAttempts.attempt(chain.attemptId);

      // --- INJECTION: the blind retry is attempted -------------------------
      let blindRetryRejected = false;
      let blindRetryError = "";
      try {
        world.journey.settlementAttempts.requestRetry(chain.attemptId, "sa:outage:blind-retry", now());
      } catch (error) {
        blindRetryRejected = true;
        blindRetryError = error instanceof Error ? error.constructor.name : "unknown";
      }

      // --- a case without recorded outage evidence is refused --------------
      let evidencelessCaseRefused = false;
      let evidencelessCaseError = "";
      try {
        world.incidents.openOutageEffectCase(world.journey.reconciliation, {
          caseId: "case:outage:evidenceless",
          attemptId: asSettlementAttemptId(chain.attemptId),
          railId: RAIL,
          effectAt: now() - 10_000n, // BEFORE the outage window
          now: now(),
        });
      } catch (error) {
        evidencelessCaseRefused = true;
        evidencelessCaseError = error instanceof Error ? error.message : "unknown";
      }

      // --- recovery: outage ends, recovery probes evidence the return -----
      const endedAt = now() + 2_000n;
      world.incidents.endOutage({
        railId: RAIL,
        endedAt,
        evidenceRef: "status-page:inc-77:resolved",
        now: endedAt,
        note: "provider reports full recovery",
      });
      const failedProbe = world.incidents.recordRecoveryProbe({
        railId: RAIL,
        probedAt: endedAt + 1n,
        reachable: false,
        evidenceRef: "probe:rail:1",
        now: endedAt + 1n,
        note: "first probe still failing",
      });
      const healthyProbe = await world.incidents.probeRailRecovery({
        railId: RAIL,
        evidenceRef: "probe:rail:2",
        now: endedAt + 2n,
        probe: async () => ({ status: "HEALTHY" }),
      });

      // --- recovery: the reconciliation case resolves with evidence --------
      const openedCase = world.incidents.openOutageEffectCase(world.journey.reconciliation, {
        caseId: "case:outage:1",
        attemptId: asSettlementAttemptId(chain.attemptId),
        railId: RAIL,
        effectAt,
        now: endedAt + 3n,
      });
      const resolution = world.journey.reconciliation.resolveCase({
        caseId: "case:outage:1",
        outcome: "CONFIRMED_SUCCEEDED",
        resolvedBy: { ...ADVERSARIAL_PRINCIPAL },
        evidenceIds: [`ev:outage:refetch:${chain.attemptId}`],
        now: endedAt + 4n,
        note: "provider object re-fetched after recovery probes evidenced the rail's return",
      });
      const resolvedAttempt = world.journey.settlementAttempts.attempt(chain.attemptId);

      // --- recovery: finality + certificate over the reconciled instruction
      const instruction = deriveSettlementInstruction({
        protocolInstruction: chain.instruction,
        remittance: [],
        settlementDestinationId: "dest:merchant-1",
        authorizationRefs: ["authz:outage:1"],
        issuedAt: now(),
      });
      const authNode = world.journey.evidence.record({
        nodeId: "outage:auth:0",
        kind: "AUTHORIZATION",
        actionRef: instruction.id,
        claimedLevel: "P2",
        provenance: { source: "OPERATOR", operatorRef: "payswap:protocol:authorization" },
        payload: "authorization-refs:authz:outage:1",
        links: [],
        recordedAt: now(),
      });
      const execNode = world.journey.evidence.record({
        nodeId: "outage:exec:0",
        kind: "EXECUTION",
        actionRef: chain.attemptId,
        claimedLevel: "P2",
        provenance: { source: "AUTHENTICATED_PROVIDER", providerName: "psp-outage" },
        payload: "provider-op:outage",
        links: ["outage:auth:0"],
        recordedAt: now(),
      });
      const outcomeNode = world.journey.evidence.record({
        nodeId: "outage:outcome:0",
        kind: "OUTCOME",
        actionRef: chain.attemptId,
        claimedLevel: "P3",
        provenance: { source: "INDEPENDENT_OBSERVER", observerRef: `rail-statement:${RAIL}` },
        payload: "destination-observation:USD:7700",
        links: ["outage:exec:0"],
        recordedAt: now(),
      });
      const finality = world.journey.finality.declareFinality({
        finalityId: "fin:outage:1",
        instruction,
        authorization: { nettingSet: chain.nettingSet, obligations: chain.obligations },
        policy: defineProofPolicy({
          policyId: "pp:outage",
          currency: instruction.amount.currency,
          baselineLevel: "P1",
          highRiskThresholdMinorUnits: 50_000n,
          highRiskLevel: "P3",
          railMinimums: {},
          counterpartyRiskMinimums: {},
        }),
        proofContext: { direction: "SETTLE", amount: instruction.amount },
        evidence: [authNode, execNode, outcomeNode],
        now: now(),
      });
      const certificate = world.journey.certificates.issue({
        certificateId: "cert:outage:1",
        finalityId: finality.finalityId,
        instruction,
        evidenceChain: ["outage:auth:0", "outage:exec:0", "outage:outcome:0"],
        reconciliationRefs: ["case:outage:1"],
        now: now(),
      });

      // --- recovery: the outbox re-drains once the transport heals ---------
      world.journey.clock.advanceMs(120_000);
      const workingPublisher = new RecordingPublisher();
      await drainOutbox(world, workingPublisher);
      const recordAfterRecovery = getOutboxRecord(world, eventId);

      // --- the frozen W2-006 replay-fault contract over a REAL lab replay --
      const fault = declareFault({
        faultId: "fault:provider-outage:w2-006",
        faultKind: "PROVIDER_OUTAGE",
        targetKind: "rail",
        targetId: RAIL,
        atStep: 0,
        notes: "in-flight external write under outage → UNKNOWN requiring reconciliation",
      });
      const w2_006 = verifyFaultContract({ fault, replay: options.replay });

      // --- INV-S04 evidence: the outage window carries its evidence --------
      const windows = world.incidents.outageWindows(RAIL);
      const outageWindow = windows[0];
      const incidentRecords = world.incidents.records();

      const injectionChecks = [
        injectionCheck(
          outageOpen && classification.outcome === "OUTCOME_UNKNOWN",
          `the outage window was OPEN and classifyExternalEffect returned ${classification.outcome} (requiresReconciliation=${String(classification.outcome === "OUTCOME_UNKNOWN" ? classification.requiresReconciliation : false)}, reason ${classification.outcome === "OUTCOME_UNKNOWN" ? classification.reason : "n/a"})`,
        ),
        injectionCheck(
          attempt !== undefined && attempt.state === "OUTCOME_UNKNOWN",
          `the in-flight write inside the window surfaced as ${attempt?.state ?? "absent"} — no fabricated business outcome`,
        ),
        injectionCheck(
          blindRetryRejected && blindRetryError === "SettlementRetryForbiddenError",
          `the blind retry threw ${blindRetryError}`,
        ),
        injectionCheck(
          evidencelessCaseRefused && /without recorded outage evidence/.test(evidencelessCaseError),
          `an outage-effect case without a covering recorded window was refused: ${evidencelessCaseError}`,
        ),
        injectionCheck(
          w2_006.passed && w2_006.violations.length === 0,
          `the frozen W2-006 PROVIDER_OUTAGE contract verified over the real Lab replay (${w2_006.verdictDigest})`,
        ),
      ];

      const probes = [
        probe(
          "INV-X01",
          attempt !== undefined &&
            attempt.state === "OUTCOME_UNKNOWN" &&
            classification.outcome === "OUTCOME_UNKNOWN" &&
            (classification.outcome === "OUTCOME_UNKNOWN" ? classification.requiresReconciliation : false) === true,
          `the outage-time write was never mapped to FAILED: the attempt is ${attempt?.state ?? "absent"} and the incident classification is OUTCOME_UNKNOWN/requiresReconciliation`,
        ),
        probe(
          "INV-X02",
          blindRetryRejected && blindRetryError === "SettlementRetryForbiddenError",
          `the UNKNOWN write could not be blindly retried (${blindRetryError})`,
        ),
        probe(
          "INV-X03",
          openedCase.caseId === "case:outage:1" &&
            resolution.outcome === "CONFIRMED_SUCCEEDED" &&
            resolvedAttempt !== undefined &&
            resolvedAttempt.state === "SUCCEEDED" &&
            finality.state === "FINAL" &&
            finality.reconciliationRefs.includes("case:outage:1") &&
            certificate.reconciliationRefs.includes("case:outage:1"),
          `the attempt left UNKNOWN only through reconciliation case case:outage:1 (CONFIRMED_SUCCEEDED with re-fetch evidence); finality ${finality.state} and certificate ${certificate.certificateId} reference the RESOLVED case`,
        ),
        probe(
          "INV-S04",
          outageWindow !== undefined &&
            outageWindow.evidenceRefs.length === 2 &&
            outageWindow.evidenceRefs[0] === "status-page:inc-77:start" &&
            outageWindow.evidenceRefs[1] === "status-page:inc-77:resolved" &&
            failedProbe.kind === "RECOVERY_PROBE" &&
            healthyProbe.reachable === true &&
            incidentRecords.length >= 4,
          `the incident fed evidence: the outage window carries [${outageWindow?.evidenceRefs.join(", ") ?? "none"}], ${incidentRecords.length} append-only incident records exist (OUTAGE_BEGUN, OUTAGE_ENDED and RECOVERY_PROBEs), and recovery was probed (a failing probe recorded first, then a HEALTHY probe observed reachable)`,
        ),
        probe(
          "INV-O02",
            recordDuringOutage !== undefined &&
            recordDuringOutage.status === "PENDING" &&
            losingPublisher.lost.length === 1 &&
            recordAfterRecovery !== undefined &&
            recordAfterRecovery.status === "PUBLISHED" &&
            workingPublisher.delivered.length === 1,
          `the committed mutation's event ${eventId} was never silently lost: PENDING during the outage (transport lost it once) and PUBLISHED with exactly one delivery after recovery`,
        ),
      ];

      const recoveryPath = [
        recoveryStep(
          1,
          "Outage window opened with evidence",
          outageWindow !== undefined && outageWindow.evidenceRefs.length >= 1,
          `OUTAGE_BEGUN recorded with status-page evidence`,
        ),
        recoveryStep(
          2,
          "In-flight write surfaced as UNKNOWN requiring reconciliation",
          attempt !== undefined && attempt.state === "OUTCOME_UNKNOWN",
          `the attempt recorded OUTCOME_UNKNOWN with the outage ambiguity as evidence`,
        ),
        recoveryStep(
          3,
          "Blind retry refused",
          blindRetryRejected,
          `requestRetry threw ${blindRetryError}`,
        ),
        recoveryStep(
          4,
          "Outage ended; recovery probed before resuming",
          healthyProbe.reachable === true && failedProbe.kind === "RECOVERY_PROBE",
          `a failing probe was recorded first, then a HEALTHY probe evidenced the rail's return (recovery is never assumed)`,
        ),
        recoveryStep(
          5,
          "Reconciliation case resolved with re-fetch evidence",
          resolution.outcome === "CONFIRMED_SUCCEEDED" &&
            resolvedAttempt !== undefined &&
            resolvedAttempt.state === "SUCCEEDED",
          `case case:outage:1 resolved CONFIRMED_SUCCEEDED over the recovery probes + re-fetch`,
        ),
        recoveryStep(
          6,
          "Finality declared and certificate issued over the reconciled instruction",
          finality.state === "FINAL" &&
            certificate.reconciliationRefs.includes("case:outage:1") &&
            chain.obligations.every((obligation) => settleObligationInWindow(world, obligation) === "SETTLED"),
          `finality ${finality.finalityId} FINAL with proof ${finality.proof.required}/${finality.proof.achieved}; certificate ${certificate.certificateId} issued; obligations settled in-window`,
        ),
        recoveryStep(
          7,
          "Outbox re-drained exactly once after transport recovery",
          recordAfterRecovery !== undefined &&
            recordAfterRecovery.status === "PUBLISHED" &&
            workingPublisher.delivered.length === 1,
          `event ${eventId} PUBLISHED with one delivery`,
        ),
      ];

      const evidenceRefs = [
        chain.attemptId,
        eventId,
        "status-page:inc-77:start",
        "status-page:inc-77:resolved",
        "probe:rail:1",
        "probe:rail:2",
        "case:outage:1",
        finality.finalityId,
        certificate.certificateId,
        w2_006.verdictDigest,
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

/** Settle an obligation inside its window and return the live state. */
function settleObligationInWindow(
  world: ReturnType<typeof buildAdversarialWorld>,
  obligation: Obligation,
): string {
  const settled = settleObligation(
    world.journey.obligations,
    obligation.id,
    new StaticClock(obligation.dueWindow.opensAt),
  );
  return settled.state;
}

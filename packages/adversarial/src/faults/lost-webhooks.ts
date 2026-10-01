/**
 * W2-007 fault family — lost webhooks.
 *
 * Attack: the provider webhook that would carry a settlement's terminal
 * outcome is lost in transit (the transport throws), so the committed
 * mutation's outbox event cannot be published and the external outcome is
 * ambiguous. The system must not silently lose anything: the event stays
 * PENDING, the attempt lands in OUTCOME_UNKNOWN, and the exact recovery is
 * a re-fetch of the provider object by external id/revision followed by a
 * reconciliation resolution and a successful re-drain.
 *
 * Invariants on the line: INV-X03 (reconciliation is authoritative for
 * ambiguous external effects), INV-O02 (no silent outbox loss), INV-E05
 * (evidence history immutable), INV-C06 (lossless provider state),
 * INV-E02 (execution evidence for external effects).
 */

import { ProviderRevisionConflictError, asSettlementAttemptId } from "@payswap/settlement";
import {
  createProviderStateEnvelope,
  serializeProviderStateEnvelope,
  parseProviderStateEnvelope,
} from "@payswap/connectors";
import type { ProviderStateEnvelope } from "@payswap/connectors";
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

function envelope(
  world: ReturnType<typeof buildAdversarialWorld>,
  externalId: string,
  revision: string,
  state: Record<string, unknown>,
  terminal: boolean,
): ProviderStateEnvelope {
  return createProviderStateEnvelope({
    provider: { name: "psp-adversarial", version: "1.0.0" },
    object: { objectType: "payment_intent", externalId },
    revision,
    state,
    classification: {
      family: "other",
      lifecycleStep: terminal ? "succeeded" : "processing",
      isTerminal: terminal,
      requiresCustomerAction: false,
    },
    history: [],
    privacy: { dataClassification: "PARTNER", constraints: [], shareableFields: ["state"] },
    timestamps: { observedAt: new Date(Number(world.journey.clock.now())).toISOString() },
    provenance: { source: "PROVIDER_API", fetchId: `fetch_${externalId}_${revision}` },
  });
}

export function lostWebhooksScenario(): AdversarialScenario {
  const declaration = {
    faultId: "fault:lost-webhooks:1",
    family: "lost-webhooks" as const,
    title: "Lost provider webhook recovered by external-object re-fetch and reconciliation",
    description:
      "The terminal-outcome webhook for an in-flight settlement is lost in transit; the outbox event stays PENDING (no silent loss), the attempt surfaces OUTCOME_UNKNOWN, and a re-fetch of the provider object by external id/revision resolves the ambiguity with evidence before finality.",
    candidateInvariants: ["INV-X03", "INV-O02", "INV-E05", "INV-C06", "INV-E02"],
    attackedSubsystems: ["@payswap/protocol", "@payswap/settlement", "@payswap/connectors", "@payswap/journeys"],
  };

  return {
    declaration,
    run: async (): Promise<FaultExecution> => {
      const world = buildAdversarialWorld();
      const now = (): bigint => world.journey.clock.now();

      // --- ground truth: an in-flight settlement over the real chain -------
      const chain = beginAdversarialChain({
        world,
        sequence: "lost-webhooks",
        clearingRecords: [
          clearingRecord("CR:LW:1", [
            {
              id: "act:LW:1",
              activityType: "MERCHANT_SALE",
              debtor: "merchant-1",
              creditor: "customer-1",
              amount: usd(4200n),
            },
          ], world),
        ],
        dueWindow: { opensAt: now() + 1n, closesAt: now() + 86_400_000n },
        rail: "rail:psp-adversarial",
        settlementDestinationId: "dest:merchant-1",
        authorizationRefs: ["authz:lost-webhooks:1"],
      });
      const externalId = `pi_lw_${chain.attemptId}`;

      // --- INJECTION: the committed mutation's event + the lost webhook ----
      const eventId = `evt:${chain.attemptId}`;
      world.outbox.enqueue([
        outboxEvent(world, eventId, "settlement.attempt.started", {
          attemptId: chain.attemptId,
          externalId,
        }, chain.attemptId),
      ]);
      const losingPublisher = new LosingPublisher();
      const lossReport = await drainOutbox(world, losingPublisher);
      const recordAfterLoss = getOutboxRecord(world, eventId);

      // The webhook carrying the outcome never arrives → the attempt cannot
      // record a terminal outcome; it surfaces the ambiguity truthfully.
      world.journey.settlementAttempts.recordExternalOutcome(
        chain.attemptId,
        "OUTCOME_UNKNOWN",
        [`ev:webhook-loss:${chain.attemptId}`],
        now(),
      );
      const attempt = world.journey.settlementAttempts.attempt(chain.attemptId);

      // --- recovery: re-fetch by external object id/revision (INV-X03) -----
      const revisionOne = envelope(world, externalId, "1", { status: "processing" }, false);
      world.journey.providerRevisions.append(revisionOne, now());
      world.journey.clock.advanceMs(1_000);
      const revisionTwo = envelope(world, externalId, "2", { status: "succeeded" }, true);
      const refetchEntry = world.journey.providerRevisions.append(revisionTwo, now());
      const latest = world.journey.providerRevisions.latest("psp-adversarial", "payment_intent", externalId);

      // --- recovery: reconciliation resolves with re-fetch evidence --------
      const openedCase = world.journey.reconciliation.openCase({
        caseId: "case:lw:1",
        subject: { kind: "SETTLEMENT_ATTEMPT", attemptId: asSettlementAttemptId(chain.attemptId) },
        reason: "EXTERNAL_AMBIGUITY",
        now: now(),
      });
      const resolution = world.journey.reconciliation.resolveCase({
        caseId: "case:lw:1",
        outcome: "CONFIRMED_SUCCEEDED",
        resolvedBy: { ...ADVERSARIAL_PRINCIPAL },
        evidenceIds: [`ev:refetch:${externalId}@2`],
        now: now(),
        note: "provider object re-fetched by external id/revision; terminal state observed",
      });
      const resolvedAttempt = world.journey.settlementAttempts.attempt(chain.attemptId);
      const liveCase = world.journey.reconciliation.case("case:lw:1");

      // --- recovery: the outbox re-drains with a working transport ---------
      world.journey.clock.advanceMs(120_000);
      const workingPublisher = new RecordingPublisher();
      await drainOutbox(world, workingPublisher);
      const recordAfterRecovery = getOutboxRecord(world, eventId);

      // --- INV-E05 probe input: revision history immutability --------------
      let divergentRefetchRejected = false;
      let divergentError = "";
      try {
        world.journey.providerRevisions.append(
          envelope(world, externalId, "2", { status: "succeeded", tampered: true }, true),
          now(),
        );
      } catch (error) {
        divergentRefetchRejected = true;
        divergentError = error instanceof Error ? error.constructor.name : "unknown";
      }
      const historyLen = world.journey.providerRevisions.history(
        "psp-adversarial",
        "payment_intent",
        externalId,
      ).length;

      const injectionChecks = [
        injectionCheck(
          losingPublisher.lost.length === 1 && losingPublisher.lost[0] === eventId &&
            recordAfterLoss !== undefined && recordAfterLoss.status === "PENDING",
          `the webhook transport genuinely LOST event ${eventId} (publisher threw) and the outbox record stayed ${recordAfterLoss?.status ?? "absent"} with ${recordAfterLoss?.attempts ?? 0} failed attempt(s) — nothing was silently dropped`,
        ),
        injectionCheck(
          attempt !== undefined && attempt.state === "OUTCOME_UNKNOWN",
          `with the outcome webhook lost, the settlement attempt surfaced ${attempt?.state ?? "absent"} (never a fabricated SUCCEEDED/FAILED)`,
        ),
        injectionCheck(
          lossReport.published.length === 0,
          `the loss drain published ${lossReport.published.length} event(s) — the committed mutation did not reach the outside world through the broken transport`,
        ),
      ];

      const serialized = serializeProviderStateEnvelope(revisionTwo);
      const roundTripIdentical =
        serializeProviderStateEnvelope(parseProviderStateEnvelope(serialized)) === serialized;

      const probes = [
        probe(
          "INV-X03",
          liveCase !== undefined &&
            liveCase.status === "RESOLVED" &&
            resolution.outcome === "CONFIRMED_SUCCEEDED" &&
            resolvedAttempt !== undefined &&
            resolvedAttempt.state === "SUCCEEDED" &&
            resolvedAttempt.resolution !== undefined &&
            resolvedAttempt.resolution.caseId === "case:lw:1",
          `the attempt left OUTCOME_UNKNOWN ONLY through reconciliation case case:lw:1 resolved CONFIRMED_SUCCEEDED with re-fetch evidence (resolution stamped on the attempt)`,
        ),
        probe(
          "INV-O02",
          recordAfterRecovery !== undefined &&
            recordAfterRecovery.status === "PUBLISHED" &&
            workingPublisher.delivered.length === 1 &&
            workingPublisher.delivered[0] === eventId,
          `after the transport healed, exactly one re-drain published event ${eventId} (${workingPublisher.delivered.length} delivery, no duplication, no loss)`,
        ),
        probe(
          "INV-E05",
          divergentRefetchRejected &&
            divergentError === "ProviderRevisionConflictError" &&
            historyLen === 2,
          `the re-fetch history is append-only: ${historyLen} revision(s) recorded and a divergent re-record of ${externalId}@2 threw ${divergentError}`,
        ),
        probe(
          "INV-C06",
          roundTripIdentical &&
            refetchEntry.envelope.object.externalId === externalId &&
            refetchEntry.revision === "2" &&
            latest !== undefined &&
            latest.revision === "2",
          `the re-fetched provider state ${externalId}@2 round-trips losslessly through serialize/parse and the revision ledger's latest is @${latest?.revision ?? "absent"}`,
        ),
        probe(
          "INV-E02",
          resolution.evidenceIds.length > 0 &&
            (resolvedAttempt?.evidenceIds.length ?? 0) > 0,
          `the resolution carried ${resolution.evidenceIds.length} evidence ref(s) and the resolved attempt retains ${resolvedAttempt?.evidenceIds.length ?? 0} evidence id(s)`,
        ),
      ];

      const recoveryPath = [
        recoveryStep(
          1,
          "Webhook loss detected without state fabrication",
          attempt !== undefined && attempt.state === "OUTCOME_UNKNOWN" &&
            recordAfterLoss !== undefined && recordAfterLoss.status === "PENDING",
          `attempt ${chain.attemptId} recorded OUTCOME_UNKNOWN with the loss observation as evidence; outbox event ${eventId} PENDING`,
        ),
        recoveryStep(
          2,
          "Provider object re-fetched by external id/revision",
          latest !== undefined && latest.revision === "2" && latest.envelope.classification.isTerminal,
          `re-fetch of ${externalId} advanced the revision ledger @1 (processing) → @2 (terminal succeeded)`,
        ),
        recoveryStep(
          3,
          "Reconciliation case opened for the ambiguous effect",
          openedCase.caseId === "case:lw:1" && openedCase.subject.kind === "SETTLEMENT_ATTEMPT",
          `case case:lw:1 opened with reason EXTERNAL_AMBIGUITY over subject SETTLEMENT_ATTEMPT ${chain.attemptId}`,
        ),
        recoveryStep(
          4,
          "Case resolved with re-fetch evidence",
          resolution.outcome === "CONFIRMED_SUCCEEDED" &&
            resolvedAttempt !== undefined &&
            resolvedAttempt.state === "SUCCEEDED",
          `resolved CONFIRMED_SUCCEEDED on evidence [${resolution.evidenceIds.join(", ")}]; the attempt is SUCCEEDED`,
        ),
        recoveryStep(
          5,
          "Outbox re-drained exactly once after transport recovery",
          recordAfterRecovery !== undefined &&
            recordAfterRecovery.status === "PUBLISHED" &&
            workingPublisher.delivered.length === 1,
          `event ${eventId} is PUBLISHED with exactly ${workingPublisher.delivered.length} successful delivery`,
        ),
      ];

      const evidenceRefs = [
        chain.attemptId,
        eventId,
        `${externalId}@1`,
        `${externalId}@2`,
        "case:lw:1",
        chain.instruction.id,
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

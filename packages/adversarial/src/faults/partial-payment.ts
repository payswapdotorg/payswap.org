/**
 * W2-007 fault family — partial-payment edges.
 *
 * Attack: a rail executes only PART of a payment (the provider reports a
 * partial capture), and the attacker tries to over-reserve the payer's
 * funds while the partial state is open.
 *
 * Defense: the partial effect surfaces as PARTIALLY_EXECUTED (never silently
 * SUCCEEDED); reservations can never exceed authorized available value
 * (INV-F04); netting preserves the gross obligations behind every net
 * position (INV-F07); every journal posting balances exactly (INV-F03);
 * the partial provider state is preserved losslessly (INV-C06).
 *
 * Recovery: the partial execution completes with evidence (COMPLETE →
 * SUCCEEDED) and the settlement instruction settles the full net position
 * with its gross derivation retained.
 */

import {
  InsufficientAvailableFundsError,
  USD,
  fromMinorUnits,
  accountId,
  asClearingRecordId,
  asNettingSetId,
  asObligationId,
  asPartyId,
  grossFlowBetween,
  netPositions,
  reserve,
} from "@payswap/protocol";
import type { NettingSet, Obligation } from "@payswap/protocol";
import {
  createProviderStateEnvelope,
  serializeProviderStateEnvelope,
  parseProviderStateEnvelope,
} from "@payswap/connectors";
import type { ProviderStateEnvelope } from "@payswap/connectors";
import type { ProviderExecutionEvidenceDraft } from "@payswap/execution";
import {
  ADVERSARIAL_PRINCIPAL,
  buildAdversarialWorld,
  fundAccount,
  injectionCheck,
  journalIntegrity,
  postEntry,
  probe,
  recoveryStep,
  usd,
} from "../harness.js";
import type {
  AdversarialScenario,
  FaultExecution,
} from "../harness.js";

function partialEnvelope(
  capturedMinor: string,
  terminal: boolean,
  recordedAt: bigint,
): ProviderStateEnvelope {
  return createProviderStateEnvelope({
    provider: { name: "psp-partial", version: "3.1.4" },
    object: { objectType: "payment_intent", externalId: "pi_partial_1" },
    revision: terminal ? "4" : "3",
    state: {
      authorizedMinor: "7000",
      capturedMinor,
      status: terminal ? "succeeded" : "partially_captured",
    },
    classification: {
      family: "capture",
      lifecycleStep: terminal ? "succeeded" : "partially_captured",
      isTerminal: terminal,
      requiresCustomerAction: false,
    },
    history: [],
    privacy: { dataClassification: "PARTNER", constraints: [], shareableFields: ["state"] },
    timestamps: { observedAt: new Date(Number(recordedAt)).toISOString() },
    provenance: { source: "PROVIDER_API", fetchId: "fetch_pi_partial_1" },
  });
}

export function partialPaymentScenario(): AdversarialScenario {
  const declaration = {
    faultId: "fault:partial-payment:1",
    family: "partial-payment" as const,
    title: "Partial rail execution — partial capture, over-reservation and gross preservation",
    description:
      "A rail captures only 4000 of an authorized 7000 minor units; the attempt must surface PARTIALLY_EXECUTED (never silently SUCCEEDED), an interleaved over-reservation must be refused without side effects, the net position must retain its gross derivation, and the completion must land with evidence on a balanced journal.",
    candidateInvariants: ["INV-F07", "INV-F04", "INV-F03", "INV-C06"],
    attackedSubsystems: ["@payswap/execution", "@payswap/protocol", "@payswap/connectors", "@payswap/journeys"],
  };

  return {
    declaration,
    run: (): FaultExecution => {
      const world = buildAdversarialWorld();
      const now = (): bigint => world.journey.clock.now();
      const ledger = world.journey.attempts;

      // --- ground truth: a funded payer ------------------------------------
      const payer = accountId("ASSET", "adv.payer.usd");
      fundAccount(world, payer, usd(10_000n));

      // --- an in-flight execution attempt on a real rail step --------------
      const begin = ledger.begin({
        attemptId: "att:partial:1",
        planId: "plan:partial",
        stepId: "step:capture",
        executionMode: "PASS_THROUGH_NATIVE",
        capabilityInstanceId: "inst:payments:psp-partial",
        capabilityId: "cap:payments",
        retryPolicy: "REQUIRES_RECONCILIATION",
        cancellation: "BEFORE_EXECUTION",
        compensation: {
          compensable: true,
          compensationCapabilityId: "cap:refund",
          cancellation: "BEFORE_EXECUTION",
          partialExecution: { possible: true, granularity: "STAGED", onPartial: "DISCLOSED" },
        },
        idempotencyKey: "idem:partial:1",
        principal: { ...ADVERSARIAL_PRINCIPAL },
        now: now(),
      });
      if (begin.kind !== "BEGIN") {
        throw new Error("fixture setup: first attempt must BEGIN");
      }
      ledger.advance("att:partial:1", "START", { now: now() });

      // --- INJECTION: the rail captures only PART of the authorized amount -
      const partialState = partialEnvelope("4000", false, now());
      const partialEvidence: ProviderExecutionEvidenceDraft = {
        evidenceId: "ev:partial:capture",
        kind: "EXECUTION",
        evidenceRef: "provider-op:pi_partial_1:3",
        providerState: partialState,
        recordedAt: now(),
      };
      const partial = ledger.advance("att:partial:1", "PARTIAL_EFFECT", {
        now: now(),
        evidence: [partialEvidence],
        providerState: partialState,
      });

      // --- INJECTION: over-reservation while the partial state is open -----
      const first = reserve(world.journey.reservationState, { accountId: payer, amount: usd(8_000n) });
      let overReservationRejected = false;
      let overReservationError = "";
      let reservationsAfterOver = 0;
      try {
        reserve(world.journey.reservationState, { accountId: payer, amount: usd(3_000n) });
      } catch (error) {
        overReservationRejected = error instanceof InsufficientAvailableFundsError;
        overReservationError = error instanceof Error ? error.constructor.name : "unknown";
        reservationsAfterOver = world.journey.reservationState.reservations.all.length;
      }

      // --- INV-F07: netting preserves gross --------------------------------
      // Two obligations on the same pair: A→B 7000 and B→A 3000.
      const obligations: readonly Obligation[] = [
        {
          id: asObligationId("OBL:PARTIAL:A:B:USD"),
          debtor: asPartyId("party-a"),
          creditor: asPartyId("party-b"),
          amount: usd(7000n),
          dueWindow: { opensAt: now() + 1n, closesAt: now() + 86_400_000n },
          state: "PENDING",
          derivedFrom: asClearingRecordId("CR:PARTIAL:1"),
        },
        {
          id: asObligationId("OBL:PARTIAL:B:A:USD"),
          debtor: asPartyId("party-b"),
          creditor: asPartyId("party-a"),
          amount: usd(3000n),
          dueWindow: { opensAt: now() + 1n, closesAt: now() + 86_400_000n },
          state: "PENDING",
          derivedFrom: asClearingRecordId("CR:PARTIAL:2"),
        },
      ];
      const nettingSet: NettingSet = {
        id: asNettingSetId("NS:PARTIAL"),
        obligations: obligations.map((obligation) => obligation.id),
        window: { opensAt: now(), closesAt: now() + 86_400_000n },
        createdAt: now(),
      };
      const positions = netPositions(nettingSet, obligations);
      const position = positions[0];
      const gross = grossFlowBetween(obligations, asPartyId("party-a"), asPartyId("party-b"), USD);

      // --- the partial capture posts a balanced journal entry --------------
      const pool = accountId("ASSET", "pool.usd");
      postEntry(
        world,
        [
          { accountId: payer, amount: fromMinorUnits(USD, -4000n) },
          { accountId: pool, amount: usd(4000n) },
        ],
        "partial capture 4000 of authorized 7000 (disclosed partial execution)",
        "partial:att:partial:1",
      );

      // --- recovery: the completion lands with evidence --------------------
      const completionState = partialEnvelope("7000", true, now());
      const completed = ledger.advance("att:partial:1", "COMPLETE", {
        now: now(),
        evidence: [
          {
            evidenceId: "ev:partial:complete",
            kind: "EXECUTION",
            evidenceRef: "provider-op:pi_partial_1:4",
            providerState: completionState,
            recordedAt: now(),
          },
        ],
        providerState: completionState,
      });

      const integrity = journalIntegrity(world);

      const injectionChecks = [
        injectionCheck(
          partial.state === "PARTIALLY_EXECUTED",
          `the provider's partial capture (4000 of 7000 authorized minor units) surfaced as ${partial.state} — never silently SUCCEEDED`,
        ),
        injectionCheck(
          overReservationRejected && overReservationError === "InsufficientAvailableFundsError",
          `the interleaved over-reservation (8000 held + 3000 requested > 10000 available) was refused with ${overReservationError}`,
        ),
        injectionCheck(
          completed.state === "SUCCEEDED",
          `the completion (full 7000 captured) landed ${completed.state} with execution evidence`,
        ),
      ];

      const serialized = serializeProviderStateEnvelope(partialState);
      const roundTripIdentical =
        serializeProviderStateEnvelope(parseProviderStateEnvelope(serialized)) === serialized;

      const probes = [
        probe(
          "INV-F07",
          position !== undefined &&
            position.netAmount.value === 4000n &&
            position.derivation.gross.length === 2 &&
            gross.owedByA.value === 7000n &&
            gross.owedByB.value === 3000n &&
            gross.net.value === 10_000n,
          `netting preserved gross: the net position A>B 4000 retains ${position?.derivation.gross.length ?? 0} gross snapshot(s) and grossFlowBetween confirms 7000 owed by A + 3000 owed by B (10000 total gross flow) against a net position of 4000`,
        ),
        probe(
          "INV-F04",
          overReservationRejected &&
            overReservationError === "InsufficientAvailableFundsError" &&
            reservationsAfterOver === 1 &&
            first.state === "PENDING",
          `reservations never exceeded authorized available value: the over-reservation was refused with ${overReservationError} and no side effects (${reservationsAfterOver} reservation(s) booked, the first still ${first.state})`,
        ),
        probe(
          "INV-F03",
          integrity.allBalanced && integrity.trialBalanceZero && integrity.entryCount >= 2,
          `all ${integrity.entryCount} journal entries balance exactly and the trial balance per currency sums to zero (the partial capture posted a balanced 4000/4000 entry)`,
        ),
        probe(
          "INV-C06",
          roundTripIdentical &&
            completed.providerState !== undefined &&
            (completed.providerState.state as { capturedMinor?: string }).capturedMinor === "7000",
          `the partial provider state (authorizedMinor 7000 / capturedMinor 4000) is preserved losslessly and the completed attempt carries the terminal state with capturedMinor 7000`,
        ),
      ];

      const recoveryPath = [
        recoveryStep(
          1,
          "Partial effect surfaced as PARTIALLY_EXECUTED (disclosed)",
          partial.state === "PARTIALLY_EXECUTED",
          `attempt att:partial:1 recorded PARTIAL_EFFECT with the provider's partial-capture envelope as evidence`,
        ),
        recoveryStep(
          2,
          "Over-reservation refused without side effects",
          overReservationRejected && reservationsAfterOver === 1,
          `the payer's authorized available value (10000 minor units) bounded all reservations (${overReservationError})`,
        ),
        recoveryStep(
          3,
          "Partial amount posted through the balanced journal",
          integrity.allBalanced,
          `a balanced 4000/4000 entry disclosed the partial movement (memo carries the partial semantics)`,
        ),
        recoveryStep(
          4,
          "Completion landed with evidence",
          completed.state === "SUCCEEDED",
          `the terminal provider state (capturedMinor 7000) completed the attempt → SUCCEEDED with execution evidence`,
        ),
        recoveryStep(
          5,
          "Net position retains its gross derivation",
          position !== undefined && position.derivation.gross.length === 2,
          `the settlement instruction for A>B 4000 will carry both gross obligation snapshots (INV-F07)`,
        ),
      ];

      const evidenceRefs = [
        "att:partial:1",
        "pi_partial_1@3",
        "pi_partial_1@4",
        "OBL:PARTIAL:A:B:USD",
        "OBL:PARTIAL:B:A:USD",
        first.id,
        ...world.journey.journal.entries.map((entry) => entry.entryId),
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

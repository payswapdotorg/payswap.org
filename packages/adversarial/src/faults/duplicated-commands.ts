/**
 * W2-007 fault family — duplicated commands.
 *
 * Attack: the same financial command is replayed verbatim (same command
 * type, principal and idempotency key, fresh command id), and a MUTATED
 * variant tries to re-bind the same key to a different payload.
 *
 * Invariants on the line: INV-F05 (one idempotency key → one authoritative
 * result), INV-F03 (journal not double-posted), INV-O01 (async commands are
 * retry-safe), INV-E05 (historical evidence immutable).
 */

import { JournalEntryIdConflictError, accountId, fromMinorUnits } from "@payswap/protocol";
import type { CommandEnvelope } from "@payswap/protocol";
import {
  ADVERSARIAL_PRINCIPAL,
  adversarialCommand,
  buildAdversarialWorld,
  getOutboxRecord,
  injectionCheck,
  outboxEvent,
  postEntry,
  probe,
  recoveryStep,
  usd,
} from "../harness.js";
import type {
  AdversarialScenario,
  FaultExecution,
} from "../harness.js";

/** Deterministic payload hash for the command (the registrar stores it as commandHash). */
function commandHashOf(payload: Readonly<Record<string, unknown>>): string {
  const keys = Object.keys(payload).sort();
  const rendered = keys.map((key) => `${key}=${String(payload[key])}`).join("|");
  let hash = 0xcbf29ce4n;
  for (let i = 0; i < rendered.length; i += 1) {
    hash ^= BigInt(rendered.charCodeAt(i) & 0xff);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return `cmdhash:${hash.toString(16).padStart(16, "0")}`;
}

/** Execute a first-seen command against the real journal + outbox (the authoritative path). */
function executeTransfer(
  world: ReturnType<typeof buildAdversarialWorld>,
  command: CommandEnvelope<unknown>,
  resultHash: string,
): { postedEntries: number; eventId: string } {
  const scope = {
    commandType: command.commandType,
    principal: { ...ADVERSARIAL_PRINCIPAL },
    key: command.idempotencyKey,
  };
  const begin = world.registrar.begin(scope, commandHashOf(command.payload as Record<string, unknown>));
  if (begin.kind !== "BEGIN") {
    throw new Error("fixture setup: first execution must BEGIN");
  }
  const payer = accountId("ASSET", "adv.payer.usd");
  const pool = accountId("ASSET", "pool.usd");
  const amount = usd(2500n);
  postEntry(
    world,
    [
      { accountId: payer, amount: fromMinorUnits(amount.currency, -amount.value) },
      { accountId: pool, amount },
    ],
    `adversarial transfer for ${command.idempotencyKey}`,
    `cmd:${command.idempotencyKey}`,
  );
  const eventId = `evt:${command.idempotencyKey}`;
  world.outbox.enqueue([outboxEvent(world, eventId, "adversarial.transfer.completed", {
    idempotencyKey: command.idempotencyKey,
    resultHash,
  }, `cmd:${command.idempotencyKey}`)]);
  world.registrar.complete(scope, resultHash);
  return { postedEntries: world.journey.journal.entries.length, eventId };
}

export function duplicatedCommandsScenario(): AdversarialScenario {
  const declaration = {
    faultId: "fault:duplicated-commands:1",
    family: "duplicated-commands" as const,
    title: "Duplicate command replay against the idempotency registrar, journal and outbox",
    description:
      "A settled transfer command is replayed verbatim (fresh command id, same idempotency scope) and then mutated under the same key; the registrar, journal, attempt ledgers and outbox must keep exactly one authoritative result.",
    candidateInvariants: ["INV-F05", "INV-F03", "INV-O01", "INV-E05"],
    attackedSubsystems: ["@payswap/protocol", "@payswap/execution", "@payswap/settlement", "@payswap/journeys"],
  };

  return {
    declaration,
    run: (): FaultExecution => {
      const world = buildAdversarialWorld();
      const scope = (key: string) => ({
        commandType: "adversarial.transfer",
        principal: { ...ADVERSARIAL_PRINCIPAL },
        key,
      });
      const RESULT_HASH = "result:transfer-1:ok";

      // --- ground truth: the first, authoritative execution -----------------
      const original = adversarialCommand(
        world,
        "adversarial.transfer",
        "idem:dup:1",
        { amountMinor: "2500", currency: "USD" },
      );
      const first = executeTransfer(world, original, RESULT_HASH);
      const journalAfterFirst = world.journey.journal.entries.length;

      // --- INJECTION: verbatim replay (fresh command id, same scope+hash) ---
      const replay = adversarialCommand(
        world,
        "adversarial.transfer",
        "idem:dup:1",
        { amountMinor: "2500", currency: "USD" },
      );
      const replayOutcome = world.registrar.begin(
        scope("idem:dup:1"),
        commandHashOf(replay.payload as Record<string, unknown>),
      );
      const journalAfterReplay = world.journey.journal.entries.length;

      // --- INJECTION: mutated replay (same key, different command) ----------
      const mutatedOutcome = world.registrar.begin(
        scope("idem:dup:1"),
        commandHashOf({ amountMinor: "999999", currency: "USD" }),
      );

      // --- INJECTION: attempt-ledger replay under the same idempotency key -
      const settlementBegin = world.journey.settlementAttempts.begin({
        attemptId: "sa:dup:original",
        instructionId: "si:dup:1",
        rail: "rail:test",
        idempotencyKey: "idem:settle:dup",
        principal: { ...ADVERSARIAL_PRINCIPAL },
        now: world.journey.clock.now(),
      });
      world.journey.settlementAttempts.start("sa:dup:original", world.journey.clock.now());
      const settlementReplay = world.journey.settlementAttempts.begin({
        attemptId: "sa:dup:replayed",
        instructionId: "si:dup:1",
        rail: "rail:test",
        idempotencyKey: "idem:settle:dup",
        principal: { ...ADVERSARIAL_PRINCIPAL },
        now: world.journey.clock.now(),
      });

      // --- INV-E05 injection: attempt to rewrite the posted journal entry ---
      let entryRewriteRejected = false;
      let entryRewriteError = "";
      const posted = world.journey.journal.entries[0];
      if (posted !== undefined) {
        try {
          world.journey.journal.append(posted);
        } catch (error) {
          entryRewriteRejected = true;
          entryRewriteError = error instanceof Error ? error.constructor.name : "unknown";
        }
      }

      const injectionChecks = [
        injectionCheck(
          replayOutcome.kind === "REPLAY" &&
            replayOutcome.record.status === "COMPLETED" &&
            replayOutcome.record.resultHash === RESULT_HASH,
          `verbatim replay (fresh command id ${replay.id} ≠ original ${original.id}, same scope+hash) returned REPLAY of the authoritative COMPLETED record with resultHash ${RESULT_HASH}`,
        ),
        injectionCheck(
          mutatedOutcome.kind === "CONFLICT",
          `mutated replay under the same key returned CONFLICT (key re-binding to a different command refused)`,
        ),
        injectionCheck(
          settlementReplay.kind === "REPLAY" &&
            settlementReplay.attempt.attemptId === "sa:dup:original",
          `settlement attempt replay under the same idempotency key returned the ORIGINAL attempt ${settlementReplay.attempt.attemptId} (attemptId sa:dup:replayed was not created as authoritative)`,
        ),
        injectionCheck(
          settlementBegin.kind === "BEGIN" && entryRewriteRejected && entryRewriteError === "JournalEntryIdConflictError",
          `re-appending the already-posted journal entry threw ${entryRewriteError}`,
        ),
      ];

      // --- probes: every candidate invariant, recomputed from live state ----
      const outboxRecords = world.outbox.records;
      const eventRecord = getOutboxRecord(world, first.eventId);
      let outboxReenqueueSafe = false;
      try {
        world.outbox.enqueue([
          outboxEvent(world, first.eventId, "adversarial.transfer.completed", {
            idempotencyKey: "idem:dup:1",
            resultHash: RESULT_HASH,
          }, "cmd:idem:dup:1"),
        ]);
        outboxReenqueueSafe = world.outbox.records.length === outboxRecords.length;
      } catch {
        outboxReenqueueSafe = false;
      }
      const correlationPostings = world.journey.journal.entries.filter(
        (entry) => entry.source?.correlationId === "cmd:idem:dup:1",
      ).length;

      const probes = [
        probe(
          "INV-F05",
          replayOutcome.kind === "REPLAY" &&
            replayOutcome.record.resultHash === RESULT_HASH &&
            settlementReplay.kind === "REPLAY" &&
            settlementReplay.attempt.attemptId === "sa:dup:original" &&
            mutatedOutcome.kind === "CONFLICT",
          `one idempotency key → one authoritative result: the registrar replayed resultHash ${RESULT_HASH}, the settlement ledger replayed attempt sa:dup:original, and the mutated re-binding was refused with CONFLICT`,
        ),
        probe(
          "INV-F03",
          journalAfterReplay === journalAfterFirst &&
            correlationPostings === 1 &&
            world.journey.journal.entries.every((entry) => {
              let sum = 0n;
              for (const line of entry.lines) {
                sum += line.amount.value;
              }
              return sum === 0n;
            }),
          `the replay did NOT double-post: ${journalAfterReplay} entries (unchanged), exactly ${correlationPostings} posting(s) carry correlationId cmd:idem:dup:1, and every entry still balances to 0`,
        ),
        probe(
          "INV-O01",
          outboxReenqueueSafe && eventRecord !== undefined && eventRecord.status === "PENDING",
          `the committed mutation's outbox event ${first.eventId} survived the replay path (status ${eventRecord?.status ?? "absent"}) and an identical re-enqueue is a no-op (${world.outbox.records.length} record(s), no conflict thrown) — async commands are retry-safe`,
        ),
        probe(
          "INV-E05",
          entryRewriteRejected && entryRewriteError === "JournalEntryIdConflictError",
          `the posted journal entry could not be rewritten: re-append threw JournalEntryIdConflictError (historical evidence is immutable)`,
        ),
      ];

      // --- the exact recovery / reconciliation path -------------------------
      const recoveryPath = [
        recoveryStep(
          1,
          "Replay classified as REPLAY of the authoritative result",
          replayOutcome.kind === "REPLAY" && replayOutcome.record.resultHash === RESULT_HASH,
          `the replaying caller received the stored resultHash ${RESULT_HASH} and did NOT re-execute the transfer`,
        ),
        recoveryStep(
          2,
          "Mutated re-binding refused with CONFLICT",
          mutatedOutcome.kind === "CONFLICT",
          "a caller that mutated the command under the same key must issue a NEW idempotency key; the original result stays authoritative",
        ),
        recoveryStep(
          3,
          "Settlement attempt replay returns the original attempt",
          settlementReplay.kind === "REPLAY" && settlementReplay.attempt.attemptId === "sa:dup:original",
          `attempt sa:dup:replayed was never recorded as authoritative; state continues from sa:dup:original (${settlementReplay.attempt.state})`,
        ),
        recoveryStep(
          4,
          "Journal and outbox unchanged by the replay",
          journalAfterReplay === journalAfterFirst && outboxReenqueueSafe,
          `journal holds ${journalAfterReplay} entries and the outbox holds ${world.outbox.records.length} record(s) — exactly the pre-replay state`,
        ),
        recoveryStep(
          5,
          "Historical evidence rewrite rejected",
          entryRewriteRejected,
          `re-appending the posted entry threw ${entryRewriteError}; the append-only journal preserves the original posting`,
        ),
      ];

      const evidenceRefs = [
        original.id,
        replay.id,
        "idem:dup:1",
        "sa:dup:original",
        first.eventId,
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

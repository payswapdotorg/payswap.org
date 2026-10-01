import { describe, expect, it } from "vitest";
import { USD, TerminalStateViolationError, fromMinorUnits } from "@payswap/protocol";
import {
  SettlementAttemptConflictError,
  SettlementAttemptLedger,
  SettlementEvidenceRequiredError,
  SettlementRetryForbiddenError,
  asSettlementAttemptId,
  deriveSettlementInstruction,
  remittanceDocumentRefs,
  settlementResultHash,
} from "../src/instructions.js";
import type { SettlementInstruction } from "../src/instructions.js";
import {
  NOW,
  PRINCIPAL,
  makeProtocolInstructions,
  makeRemittance,
  makeSettlementInstruction,
} from "./fixtures.js";

describe("Settlement instructions (W1-004)", () => {
  it("derives from protocol netting output preserving remittance references end-to-end", () => {
    const instruction = makeSettlementInstruction();
    const protocolInstruction = makeProtocolInstructions()[0];
    if (protocolInstruction === undefined) throw new Error("fixture setup failed");

    // The protocol derivation is consumed verbatim (INV-F07).
    expect(instruction.id).toBe(protocolInstruction.id);
    expect(instruction.setId).toBe(protocolInstruction.setId);
    expect(instruction.debtor).toBe("party_a");
    expect(instruction.creditor).toBe("party_b");
    expect(instruction.amount.value).toBe(90_000n);
    expect(instruction.fromNetPosition).toEqual(protocolInstruction.fromNetPosition);

    // Remittance references are preserved end-to-end, verbatim.
    const remittance = makeRemittance();
    expect(instruction.remittance).toEqual(remittance.allocations);
    expect(instruction.remittanceInfo).toBe(remittance.remittanceInfo);
    expect(remittanceDocumentRefs(instruction)).toEqual([
      { documentKind: "INVOICE", documentId: "doc-100" },
      { documentKind: "ORDER", documentId: "doc-200" },
    ]);
    expect(instruction.settlementDestinationId).toBe("dest_bank_1");
    expect(instruction.authorizationRefs).toEqual(["approval:art-1"]);
  });

  it("rejects instructions without authorization lineage (INV-E01)", () => {
    const protocolInstruction = makeProtocolInstructions()[0];
    if (protocolInstruction === undefined) throw new Error("fixture setup failed");
    expect(() =>
      deriveSettlementInstruction({
        protocolInstruction,
        remittance: [],
        settlementDestinationId: "dest_bank_1",
        authorizationRefs: [],
        issuedAt: NOW,
      }),
    ).toThrow(/INV-E01/);
    expect(() =>
      deriveSettlementInstruction({
        protocolInstruction,
        remittance: [],
        settlementDestinationId: "",
        authorizationRefs: ["approval:art-1"],
        issuedAt: NOW,
      }),
    ).toThrow(/settlementDestinationId/);
  });

  it("rejects remittance allocations in the wrong currency or duplicated documents", () => {
    const protocolInstruction = makeProtocolInstructions()[0];
    if (protocolInstruction === undefined) throw new Error("fixture setup failed");
    const foreign = fromMinorUnits(USD, 10n);
    expect(() =>
      deriveSettlementInstruction({
        protocolInstruction: {
          ...protocolInstruction,
          amount: fromMinorUnits(USD, 90_000n),
        },
        remittance: [
          { documentKind: "INVOICE", documentId: "doc-100", allocatedAmount: foreign },
        ],
        settlementDestinationId: "dest_bank_1",
        authorizationRefs: ["approval:art-1"],
        issuedAt: NOW,
      }),
    ).not.toThrow();
    // EUR allocation under a USD instruction is rejected (no silent FX).
    expect(() =>
      deriveSettlementInstruction({
        protocolInstruction,
        remittance: [
          // Cast: simulating an unvalidated foreign-currency allocation.
          {
            documentKind: "INVOICE",
            documentId: "doc-100",
            allocatedAmount: { currency: "EUR", value: 10n } as never,
          },
        ],
        settlementDestinationId: "dest_bank_1",
        authorizationRefs: ["approval:art-1"],
        issuedAt: NOW,
      }),
    ).toThrow(/instruction currency/);
    expect(() =>
      deriveSettlementInstruction({
        protocolInstruction,
        remittance: [
          { documentKind: "INVOICE", documentId: "doc-100", allocatedAmount: foreign },
          { documentKind: "INVOICE", documentId: "doc-100", allocatedAmount: foreign },
        ],
        settlementDestinationId: "dest_bank_1",
        authorizationRefs: ["approval:art-1"],
        issuedAt: NOW,
      }),
    ).toThrow(/at most once/);
  });
});

describe("Settlement attempts (W1-004)", () => {
  function freshLedger(): { ledger: SettlementAttemptLedger; instruction: SettlementInstruction } {
    return { ledger: new SettlementAttemptLedger(), instruction: makeSettlementInstruction() };
  }

  function startedAttempt(
    ledger: SettlementAttemptLedger,
    instruction: SettlementInstruction,
    attemptId = "att_1",
    key = "idem-1",
  ) {
    const outcome = ledger.begin({
      attemptId,
      instructionId: instruction.id,
      rail: "INSTANT_PAYMENT_RAIL",
      idempotencyKey: key,
      principal: PRINCIPAL,
      now: NOW,
    });
    if (outcome.kind !== "BEGIN") throw new Error("fixture setup failed");
    return ledger.start(attemptId, NOW + 1n);
  }

  it("INV-F05: one idempotency key maps to one authoritative attempt", () => {
    const { ledger, instruction } = freshLedger();
    const attempt = startedAttempt(ledger, instruction);
    expect(attempt.state).toBe("IN_FLIGHT");

    // A second begin under the SAME key + SAME command REPLAYS the attempt.
    const replay = ledger.begin({
      attemptId: "att_2",
      instructionId: instruction.id,
      rail: "INSTANT_PAYMENT_RAIL",
      idempotencyKey: "idem-1",
      principal: PRINCIPAL,
      now: NOW + 2n,
    });
    expect(replay.kind).toBe("REPLAY");
    if (replay.kind === "REPLAY") {
      expect(replay.attempt.attemptId).toBe("att_1");
    }

    // A different command under the same key CONFLICTS.
    expect(() =>
      ledger.begin({
        attemptId: "att_3",
        instructionId: "SI:other",
        rail: "INSTANT_PAYMENT_RAIL",
        idempotencyKey: "idem-1",
        principal: PRINCIPAL,
        now: NOW + 3n,
      }),
    ).toThrow(SettlementAttemptConflictError);
  });

  it("INV-E02: recording an external outcome requires linked evidence", () => {
    const { ledger, instruction } = freshLedger();
    startedAttempt(ledger, instruction);
    expect(() =>
      ledger.recordExternalOutcome("att_1", "SUCCEEDED", [], NOW + 2n),
    ).toThrow(SettlementEvidenceRequiredError);
    expect(() =>
      ledger.recordExternalOutcome("att_1", "OUTCOME_UNKNOWN", [], NOW + 2n),
    ).toThrow(SettlementEvidenceRequiredError);
  });

  it("INV-X01: an ambiguous provider state records OUTCOME_UNKNOWN, never FAILED", () => {
    const { ledger, instruction } = freshLedger();
    startedAttempt(ledger, instruction);
    const ambiguous = ledger.recordExternalOutcome("att_1", "OUTCOME_UNKNOWN", ["ev_amb"], NOW + 2n);
    expect(ambiguous.state).toBe("OUTCOME_UNKNOWN");
    expect(ambiguous.state).not.toBe("FAILED");
  });

  it("INV-X02: an UNKNOWN external write is never blindly retried", () => {
    const { ledger, instruction } = freshLedger();
    startedAttempt(ledger, instruction);
    ledger.recordExternalOutcome("att_1", "OUTCOME_UNKNOWN", ["ev_amb"], NOW + 2n);
    expect(() => ledger.requestRetry("att_1", "att_retry", NOW + 3n)).toThrow(
      SettlementRetryForbiddenError,
    );
    expect(() => ledger.requestRetry("att_1", "att_retry", NOW + 3n)).toThrow(/INV-X02/);
  });

  it("INV-X03: a direct outcome write out of ambiguity is refused", () => {
    const { ledger, instruction } = freshLedger();
    startedAttempt(ledger, instruction);
    ledger.recordExternalOutcome("att_1", "OUTCOME_UNKNOWN", ["ev_amb"], NOW + 2n);
    expect(() =>
      ledger.recordExternalOutcome("att_1", "SUCCEEDED", ["ev_direct"], NOW + 3n),
    ).toThrow(/INV-X03/);
  });

  it("INV-O01: a definitively FAILED attempt retries safely under the same key", () => {
    const { ledger, instruction } = freshLedger();
    startedAttempt(ledger, instruction);
    const failed = ledger.recordExternalOutcome("att_1", "FAILED", ["ev_fail"], NOW + 2n);
    expect(failed.state).toBe("FAILED");

    const retry = ledger.requestRetry("att_1", "att_retry", NOW + 3n);
    expect(retry.attemptId).toBe(asSettlementAttemptId("att_retry"));
    expect(retry.state).toBe("PENDING");
    expect(retry.idempotencyKey).toBe("idem-1");

    // The FAILED record stays FAILED — history is append-only (INV-X04).
    expect(ledger.attempt("att_1")?.state).toBe("FAILED");
    // Retried attempts still carry evidence requirements (INV-E02).
    ledger.start("att_retry", NOW + 4n);
    const succeeded = ledger.recordExternalOutcome("att_retry", "SUCCEEDED", ["ev_ok"], NOW + 5n);
    expect(succeeded.state).toBe("SUCCEEDED");

    // Now the scope is COMPLETED: a new begin under the key replays.
    const replay = ledger.begin({
      attemptId: "att_3",
      instructionId: instruction.id,
      rail: "INSTANT_PAYMENT_RAIL",
      idempotencyKey: "idem-1",
      principal: PRINCIPAL,
      now: NOW + 6n,
    });
    expect(replay.kind).toBe("REPLAY");
    if (replay.kind === "REPLAY") {
      expect(replay.attempt.attemptId).toBe("att_retry");
      expect(settlementResultHash(replay.attempt)).toBe(
        settlementResultHash(ledger.attempt("att_retry") as never),
      );
    }

    // Non-FAILED, non-UNKNOWN attempts cannot be retried either.
    expect(() => ledger.requestRetry("att_retry", "att_4", NOW + 7n)).toThrow(
      SettlementRetryForbiddenError,
    );
  });

  it("INV-X04: terminal attempts are monotonic — no second outcome, no un-declaration", () => {
    const { ledger, instruction } = freshLedger();
    startedAttempt(ledger, instruction);
    ledger.recordExternalOutcome("att_1", "SUCCEEDED", ["ev_ok"], NOW + 2n);
    expect(() =>
      ledger.recordExternalOutcome("att_1", "FAILED", ["ev_late"], NOW + 3n),
    ).toThrow(TerminalStateViolationError);
    expect(() => ledger.start("att_1", NOW + 3n)).toThrow(TerminalStateViolationError);
  });

  it("records history and evidence linkage on every transition (INV-E02)", () => {
    const { ledger, instruction } = freshLedger();
    startedAttempt(ledger, instruction);
    const attempt = ledger.recordExternalOutcome("att_1", "SUCCEEDED", ["ev_ok"], NOW + 2n);
    expect(attempt.evidenceIds).toEqual(["ev_ok"]);
    expect(attempt.history.length).toBe(2);
    expect(attempt.history[1]?.evidenceIds).toEqual(["ev_ok"]);
    const withMore = ledger.attachEvidence("att_1", ["ev_webhook", "ev_ok"], NOW + 3n);
    expect(withMore.evidenceIds).toEqual(["ev_ok", "ev_webhook"]);
  });
});

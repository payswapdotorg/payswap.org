import { describe, expect, it } from "vitest";
import { USD, fromMinorUnits } from "@payswap/protocol";
import {
  FinalityAuthority,
  FinalityInsufficientProofError,
  FinalityNotProtocolAuthorizedError,
  FinalityPreconditionsUnmetError,
  FinalityRecordConflictError,
  finalityStateMachine,
  verifyProtocolAuthorization,
} from "../src/finality.js";
import { SettlementAttemptLedger } from "../src/instructions.js";
import type { SettlementInstruction } from "../src/instructions.js";
import { EvidenceGraph } from "../src/evidence-graph.js";
import type { EvidenceNode, EvidenceNodeDraft } from "../src/evidence-graph.js";
import { SettlementReconciliationAuthority } from "../src/reconciliation.js";
import { proofSatisfaction } from "../src/proof-policies.js";
import type { ProofPolicy } from "../src/proof-policies.js";
import { asSettlementAttemptId } from "../src/instructions.js";
import {
  NOW,
  PRINCIPAL,
  makeAuthorizationProof,
  makeProofPolicy,
  makeSettlementInstruction,
} from "./fixtures.js";
import type { ProtocolAuthorizationProof } from "../src/finality.js";

interface Scenario {
  readonly ledger: SettlementAttemptLedger;
  readonly reconciliation: SettlementReconciliationAuthority;
  readonly finality: FinalityAuthority;
  readonly evidence: EvidenceGraph;
  readonly instruction: SettlementInstruction;
  readonly authorization: ProtocolAuthorizationProof;
  readonly policy: ProofPolicy;
  readonly evidenceNodes: readonly EvidenceNode[];
}

function buildScenario(options?: { readonly ambiguity?: boolean }): Scenario {
  const instruction = makeSettlementInstruction();
  const authorization = makeAuthorizationProof();
  const policy = makeProofPolicy();
  const evidence = new EvidenceGraph();
  const drafts: EvidenceNodeDraft[] = [
    {
      nodeId: "ev_auth",
      kind: "AUTHORIZATION",
      actionRef: instruction.id,
      claimedLevel: "P2",
      provenance: { source: "AUTHENTICATED_PROVIDER", providerName: "test-psp" },
      payload: "approval-artifact:art-1",
      links: [],
      recordedAt: NOW,
    },
    {
      nodeId: "ev_exec",
      kind: "EXECUTION",
      actionRef: "att_1",
      claimedLevel: "P2",
      provenance: { source: "AUTHENTICATED_PROVIDER", providerName: "test-psp" },
      payload: "provider-op:op-1",
      links: ["ev_auth"],
      recordedAt: NOW + 1n,
    },
    {
      nodeId: "ev_outcome",
      kind: "OUTCOME",
      actionRef: "att_1",
      claimedLevel: "P3",
      provenance: { source: "INDEPENDENT_OBSERVER", observerRef: "bank-statement:line-7" },
      payload: "destination-observation:credit-90000",
      links: ["ev_exec"],
      recordedAt: NOW + 2n,
    },
  ];
  const evidenceNodes = drafts.map((draft) => evidence.record(draft));

  const ledger = new SettlementAttemptLedger();
  const outcome = ledger.begin({
    attemptId: "att_1",
    instructionId: instruction.id,
    rail: "INSTANT_PAYMENT_RAIL",
    idempotencyKey: "idem-1",
    principal: PRINCIPAL,
    now: NOW,
  });
  if (outcome.kind !== "BEGIN") throw new Error("fixture setup failed");
  ledger.start("att_1", NOW + 1n);
  if (options?.ambiguity === true) {
    ledger.recordExternalOutcome("att_1", "OUTCOME_UNKNOWN", ["ev_amb"], NOW + 2n);
  } else {
    ledger.recordExternalOutcome("att_1", "SUCCEEDED", ["ev_exec", "ev_outcome"], NOW + 2n);
  }
  const reconciliation = new SettlementReconciliationAuthority(ledger);
  const finality = new FinalityAuthority(ledger, reconciliation);
  return {
    ledger,
    reconciliation,
    finality,
    evidence,
    instruction,
    authorization,
    policy,
    evidenceNodes,
  };
}

describe("Finality (W1-004)", () => {
  it("declares FINAL for a protocol-authorized, fully-reconciled, proof-satisfied instruction", () => {
    const scenario = buildScenario();
    const record = scenario.finality.declareFinality({
      finalityId: "fin_1",
      instruction: scenario.instruction,
      authorization: scenario.authorization,
      policy: scenario.policy,
      proofContext: { direction: "SETTLE", amount: scenario.instruction.amount },
      evidence: scenario.evidenceNodes,
      now: NOW + 10n,
    });
    expect(record.state).toBe("FINAL");
    expect(record.instructionId).toBe(scenario.instruction.id);
    expect(record.amount.value).toBe(90_000n);
    expect(record.proof).toEqual({ required: "P3", achieved: "P3" });
    expect(record.declaredAt).toBe(NOW + 10n);
    expect(record.history.length).toBe(1);
    expect(record.history[0]?.on).toBe("FINALIZE");
  });

  it("INV-F06: finality is protocol-owned — tampered and hand-minted instructions are rejected", () => {
    const scenario = buildScenario();

    // A tampered amount (900.01 USD) matches no protocol derivation.
    const tampered: SettlementInstruction = Object.freeze({
      ...scenario.instruction,
      amount: fromMinorUnits(USD, scenario.instruction.amount.value + 1n),
    });
    expect(verifyProtocolAuthorization(tampered, scenario.authorization).authorized).toBe(false);
    expect(() =>
      scenario.finality.declareFinality({
        finalityId: "fin_tampered",
        instruction: tampered,
        authorization: scenario.authorization,
        policy: scenario.policy,
        proofContext: { direction: "SETTLE", amount: tampered.amount },
        evidence: scenario.evidenceNodes,
        now: NOW + 10n,
      }),
    ).toThrow(FinalityNotProtocolAuthorizedError);

    // A hand-minted instruction (unknown netting set) is equally unauthorized.
    const handMinted: SettlementInstruction = Object.freeze({
      ...scenario.instruction,
      setId: "NS-FAKE" as never,
    });
    expect(verifyProtocolAuthorization(handMinted, scenario.authorization).authorized).toBe(false);
    expect(() =>
      scenario.finality.declareFinality({
        finalityId: "fin_hand_minted",
        instruction: handMinted,
        authorization: scenario.authorization,
        policy: scenario.policy,
        proofContext: { direction: "SETTLE", amount: handMinted.amount },
        evidence: scenario.evidenceNodes,
        now: NOW + 10n,
      }),
    ).toThrow(/INV-F06/);

    // The honest instruction verifies against the protocol derivation.
    expect(verifyProtocolAuthorization(scenario.instruction, scenario.authorization).authorized).toBe(true);
  });

  it("INV-E03: low-proof paths cannot finalize high-risk settlements", () => {
    const scenario = buildScenario();
    // 900.00 USD ≥ the 500.00 USD high-risk threshold → P3 required.
    // Present only the P2 provider-signed evidence (drop the P3 destination observation).
    const lowProof = scenario.evidenceNodes.filter((node) => node.claimedLevel !== "P3");
    expect(lowProof.length).toBe(2);
    expect(() =>
      scenario.finality.declareFinality({
        finalityId: "fin_low_proof",
        instruction: scenario.instruction,
        authorization: scenario.authorization,
        policy: scenario.policy,
        proofContext: { direction: "SETTLE", amount: scenario.instruction.amount },
        evidence: lowProof,
        now: NOW + 10n,
      }),
    ).toThrow(FinalityInsufficientProofError);

    // A P5-claiming unauthenticated screenshot is capped at P0 (INV-E04) and
    // is equally insufficient.
    const screenshot: EvidenceNode = Object.freeze({
      nodeId: "ev_screenshot",
      kind: "OUTCOME",
      actionRef: "att_1",
      claimedLevel: "P5",
      provenance: { source: "UI_BROWSER_ARTIFACT" as const, authenticated: false },
      payloadHash: "evh:screenshot",
      links: [],
      recordedAt: NOW,
    });
    expect(() =>
      scenario.finality.declareFinality({
        finalityId: "fin_screenshot",
        instruction: scenario.instruction,
        authorization: scenario.authorization,
        policy: scenario.policy,
        proofContext: { direction: "SETTLE", amount: scenario.instruction.amount },
        evidence: [...lowProof, screenshot],
        now: NOW + 10n,
      }),
    ).toThrow(FinalityInsufficientProofError);

    // A LOW-RISK amount (100.00 USD, P1 required) IS satisfiable with P2
    // evidence — the policy is risk-driven, not blanket-maximal.
    expect(
      proofSatisfaction(
        scenario.policy,
        { direction: "SETTLE", amount: fromMinorUnits(USD, 10_000n) },
        lowProof,
      ).satisfied,
    ).toBe(true);
  });

  it("INV-X03: ambiguity blocks finality until reconciled", () => {
    const scenario = buildScenario({ ambiguity: true });
    expect(() =>
      scenario.finality.declareFinality({
        finalityId: "fin_amb",
        instruction: scenario.instruction,
        authorization: scenario.authorization,
        policy: scenario.policy,
        proofContext: { direction: "SETTLE", amount: scenario.instruction.amount },
        evidence: scenario.evidenceNodes,
        now: NOW + 10n,
      }),
    ).toThrow(FinalityPreconditionsUnmetError);

    // Resolution through the reconciliation authority unlocks finality.
    scenario.reconciliation.openCase({
      caseId: "case_amb",
      subject: { kind: "SETTLEMENT_ATTEMPT", attemptId: asSettlementAttemptId("att_1") },
      reason: "EXTERNAL_AMBIGUITY",
      now: NOW + 11n,
    });
    scenario.reconciliation.resolveCase({
      caseId: "case_amb",
      outcome: "CONFIRMED_SUCCEEDED",
      resolvedBy: PRINCIPAL,
      evidenceIds: ["ev_resolved"],
      now: NOW + 12n,
    });
    const record = scenario.finality.declareFinality({
      finalityId: "fin_amb_resolved",
      instruction: scenario.instruction,
      authorization: scenario.authorization,
      policy: scenario.policy,
      proofContext: { direction: "SETTLE", amount: scenario.instruction.amount },
      evidence: scenario.evidenceNodes,
      now: NOW + 13n,
    });
    expect(record.state).toBe("FINAL");
    // The resolved case is carried on the finality record.
    expect(record.reconciliationRefs).toContain("case_amb");
  });

  it("INV-X03: an OPEN reconciliation case blocks finality even without ambiguity", () => {
    const scenario = buildScenario();
    scenario.reconciliation.openCase({
      caseId: "case_open",
      subject: { kind: "OFF_NETWORK_RECORD", recordId: "OFF-9" },
      reason: "OFF_NETWORK_RECORD_AMBIGUITY",
      instructionRef: scenario.instruction.id,
      now: NOW + 5n,
    });
    expect(() =>
      scenario.finality.declareFinality({
        finalityId: "fin_blocked",
        instruction: scenario.instruction,
        authorization: scenario.authorization,
        policy: scenario.policy,
        proofContext: { direction: "SETTLE", amount: scenario.instruction.amount },
        evidence: scenario.evidenceNodes,
        now: NOW + 10n,
      }),
    ).toThrow(/fully reconciled/);
    // The typed failure list names the OPEN case (INV-X03 details).
    try {
      scenario.finality.declareFinality({
        finalityId: "fin_blocked_probe",
        instruction: scenario.instruction,
        authorization: scenario.authorization,
        policy: scenario.policy,
        proofContext: { direction: "SETTLE", amount: scenario.instruction.amount },
        evidence: scenario.evidenceNodes,
        now: NOW + 10n,
      });
      throw new Error("finality should have been blocked");
    } catch (error) {
      expect(error).toBeInstanceOf(FinalityPreconditionsUnmetError);
      const failures = (error as FinalityPreconditionsUnmetError).details?.failures;
      expect(JSON.stringify(failures)).toContain("OPEN_RECONCILIATION_CASES");
    }
  });

  it("finality is declared once per instruction; ids are never reused", () => {
    const scenario = buildScenario();
    scenario.finality.declareFinality({
      finalityId: "fin_1",
      instruction: scenario.instruction,
      authorization: scenario.authorization,
      policy: scenario.policy,
      proofContext: { direction: "SETTLE", amount: scenario.instruction.amount },
      evidence: scenario.evidenceNodes,
      now: NOW + 10n,
    });
    expect(() =>
      scenario.finality.declareFinality({
        finalityId: "fin_2",
        instruction: scenario.instruction,
        authorization: scenario.authorization,
        policy: scenario.policy,
        proofContext: { direction: "SETTLE", amount: scenario.instruction.amount },
        evidence: scenario.evidenceNodes,
        now: NOW + 20n,
      }),
    ).toThrow(FinalityRecordConflictError);
  });

  it("INV-X04: FINAL is monotonic; reversal is the only explicit recovery and requires a compensating obligation", () => {
    // The machine itself enforces the discipline.
    expect(() => finalityStateMachine.transition("FINAL", "FINALIZE")).toThrow();
    expect(() => finalityStateMachine.transition("PROVISIONAL", "REVERSE")).toThrow();
    expect(() => finalityStateMachine.transition("REVERSED", "REVERSE")).toThrow();
    const recovery = finalityStateMachine.transition("FINAL", "REVERSE");
    expect(recovery.viaRecovery).toBe(true);
    expect(recovery.to).toBe("REVERSED");

    const scenario = buildScenario();
    const record = scenario.finality.declareFinality({
      finalityId: "fin_1",
      instruction: scenario.instruction,
      authorization: scenario.authorization,
      policy: scenario.policy,
      proofContext: { direction: "SETTLE", amount: scenario.instruction.amount },
      evidence: scenario.evidenceNodes,
      now: NOW + 10n,
    });

    // A reversal without a compensating obligation is refused.
    expect(() =>
      scenario.finality.reverse("fin_1", { compensatingObligationRef: "", now: NOW + 20n }),
    ).toThrow(/compensating obligation/);

    // The explicit recovery records the compensating obligation and keeps history.
    const reversed = scenario.finality.reverse("fin_1", {
      compensatingObligationRef: "OBL:ADJ-REFUND-1",
      now: NOW + 20n,
    });
    expect(reversed.state).toBe("REVERSED");
    expect(reversed.compensatingObligationRef).toBe("OBL:ADJ-REFUND-1");
    expect(reversed.reversedAt).toBe(NOW + 20n);
    expect(reversed.history.length).toBe(2);
    expect(reversed.history[0]?.to).toBe("FINAL");
    expect(reversed.history[1]?.viaRecovery).toBe(true);

    // REVERSED is terminal — no further movement.
    expect(() =>
      scenario.finality.reverse("fin_1", { compensatingObligationRef: "OBL:ADJ-2", now: NOW + 30n }),
    ).toThrow();

    // Finality records are frozen — in-place mutation throws.
    expect(() => {
      (reversed as { state: string }).state = "FINAL";
    }).toThrow(TypeError);
  });
});

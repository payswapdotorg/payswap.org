import { describe, expect, it } from "vitest";
import { USD, fromMinorUnits } from "@payswap/protocol";
import { isPaySwapExecutedSettlement, recordOffNetworkPayment } from "@payswap/payment";
import {
  CertificateConflictError,
  CertificateIssuanceError,
  SettlementCertificateAuthority,
  certificateDocumentRefs,
} from "../src/certificates.js";
import { FinalityAuthority } from "../src/finality.js";
import { asSettlementInstructionId } from "@payswap/protocol";
import { SettlementAttemptLedger, asSettlementAttemptId, deriveSettlementInstruction } from "../src/instructions.js";
import type { SettlementInstruction } from "../src/instructions.js";
import { EvidenceGraph } from "../src/evidence-graph.js";
import type { EvidenceNodeDraft } from "../src/evidence-graph.js";
import { SettlementReconciliationAuthority } from "../src/reconciliation.js";
import { makeProofPolicy } from "./fixtures.js";
import {
  NOW,
  PRINCIPAL,
  makeAuthorizationProof,
  makeProtocolInstructions,
  makeRemittance,
  makeSettlementInstruction,
} from "./fixtures.js";

interface CertificateScenario {
  readonly certificates: SettlementCertificateAuthority;
  readonly finality: FinalityAuthority;
  readonly evidence: EvidenceGraph;
  readonly reconciliation: SettlementReconciliationAuthority;
  readonly instruction: SettlementInstruction;
  readonly evidenceIds: readonly string[];
  readonly finalityId: string;
  readonly otherInstruction: SettlementInstruction;
}

function buildScenario(options?: { readonly ambiguity?: boolean }): CertificateScenario {
  const instruction = makeSettlementInstruction();
  const authorization = makeAuthorizationProof();

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

  if (options?.ambiguity === true) {
    reconciliation.openCase({
      caseId: "case_amb",
      subject: { kind: "SETTLEMENT_ATTEMPT", attemptId: asSettlementAttemptId("att_1") },
      reason: "EXTERNAL_AMBIGUITY",
      now: NOW + 3n,
    });
    reconciliation.resolveCase({
      caseId: "case_amb",
      outcome: "CONFIRMED_SUCCEEDED",
      resolvedBy: PRINCIPAL,
      evidenceIds: ["ev_resolved"],
      now: NOW + 4n,
    });
  }

  finality.declareFinality({
    finalityId: "fin_1",
    instruction,
    authorization,
    policy: makeProofPolicy(),
    proofContext: { direction: "SETTLE", amount: instruction.amount },
    evidence: evidenceNodes,
    now: NOW + 10n,
  });

  // A second, DIFFERENT settlement instruction (different protocol id + remittance).
  const protocolInstruction = makeProtocolInstructions()[0];
  if (protocolInstruction === undefined) throw new Error("fixture setup failed");
  const otherRemittance = makeRemittance();
  const otherInstruction = deriveSettlementInstruction({
    protocolInstruction: {
      ...protocolInstruction,
      id: asSettlementInstructionId("SI:NS-2:party_a>party_b:USD"),
    },
    remittance: [
      otherRemittance.allocations[0] as never,
    ],
    settlementDestinationId: "dest_bank_2",
    authorizationRefs: ["approval:art-2"],
    issuedAt: NOW,
  });

  const certificates = new SettlementCertificateAuthority(finality, evidence, reconciliation, ledger);
  return {
    certificates,
    finality,
    evidence,
    reconciliation,
    instruction,
    evidenceIds: drafts.map((draft) => draft.nodeId),
    finalityId: "fin_1",
    otherInstruction,
  };
}

describe("Settlement certificates (W1-004)", () => {
  it("issues only for protocol-authorized, fully-reconciled, proof-satisfied instructions", () => {
    const scenario = buildScenario({ ambiguity: true });
    const certificate = scenario.certificates.issue({
      certificateId: "cert_1",
      finalityId: scenario.finalityId,
      instruction: scenario.instruction,
      evidenceChain: scenario.evidenceIds,
      reconciliationRefs: ["case_amb"],
      now: NOW + 20n,
    });
    expect(certificate.certificateId).toBe("cert_1");
    expect(certificate.instructionId).toBe(scenario.instruction.id);
    expect(certificate.finalityId).toBe("fin_1");
    expect(certificate.amount.value).toBe(90_000n);
    expect(certificate.evidenceChain).toEqual(["ev_auth", "ev_exec", "ev_outcome"]);
    expect(certificate.reconciliationRefs).toEqual(["case_amb"]);
    expect(certificate.canonical).toMatch(/^settlement-certificate\|/);

    // Remittance references are preserved END-TO-END (payment → instruction → certificate).
    const remittance = makeRemittance();
    expect(certificate.remittance).toEqual(remittance.allocations);
    expect(certificateDocumentRefs(certificate)).toEqual([
      { documentKind: "INVOICE", documentId: "doc-100" },
      { documentKind: "ORDER", documentId: "doc-200" },
    ]);

    // Idempotent re-issue of identical content returns the same certificate.
    const replay = scenario.certificates.issue({
      certificateId: "cert_1",
      finalityId: scenario.finalityId,
      instruction: scenario.instruction,
      evidenceChain: scenario.evidenceIds,
      reconciliationRefs: ["case_amb"],
      now: NOW + 20n,
    });
    expect(replay.canonical).toBe(certificate.canonical);

    // Conflicting content under a recorded id is rejected (immutable).
    expect(() =>
      scenario.certificates.issue({
        certificateId: "cert_1",
        finalityId: scenario.finalityId,
        instruction: scenario.instruction,
        evidenceChain: ["ev_auth"],
        reconciliationRefs: ["case_amb"],
        now: NOW + 20n,
      }),
    ).toThrow(CertificateConflictError);
  });

  it("INV-F06: certificates only issue from protocol-authorized instructions", () => {
    const scenario = buildScenario();

    // A certificate naming a DIFFERENT instruction than the finality record.
    expect(() =>
      scenario.certificates.issue({
        certificateId: "cert_mismatch",
        finalityId: scenario.finalityId,
        instruction: scenario.otherInstruction,
        evidenceChain: scenario.evidenceIds,
        reconciliationRefs: [],
        now: NOW + 20n,
      }),
    ).toThrow(CertificateIssuanceError);
    expect(() =>
      scenario.certificates.issue({
        certificateId: "cert_mismatch",
        finalityId: scenario.finalityId,
        instruction: scenario.otherInstruction,
        evidenceChain: scenario.evidenceIds,
        reconciliationRefs: [],
        now: NOW + 20n,
      }),
    ).toThrow(/INSTRUCTION_MISMATCH|different instruction/);

    // An unknown finality record (a forged record cannot be smuggled in —
    // issuance looks the record up inside the authority).
    expect(() =>
      scenario.certificates.issue({
        certificateId: "cert_forged",
        finalityId: "fin_forged",
        instruction: scenario.instruction,
        evidenceChain: scenario.evidenceIds,
        reconciliationRefs: [],
        now: NOW + 20n,
      }),
    ).toThrow(/FINALITY_UNKNOWN|no finality record/);

    // A REVERSED finality record cannot certify.
    scenario.finality.reverse("fin_1", {
      compensatingObligationRef: "OBL:ADJ-REFUND-1",
      now: NOW + 15n,
    });
    expect(() =>
      scenario.certificates.issue({
        certificateId: "cert_reversed",
        finalityId: scenario.finalityId,
        instruction: scenario.instruction,
        evidenceChain: scenario.evidenceIds,
        reconciliationRefs: [],
        now: NOW + 20n,
      }),
    ).toThrow(/FINALITY_NOT_FINAL|not FINAL/);
  });

  it("INV-E01/E02: the evidence chain must be linked to this instruction's actions", () => {
    const scenario = buildScenario();

    // An evidence node belonging to ANOTHER instruction's action.
    scenario.evidence.record({
      nodeId: "ev_foreign",
      kind: "EXECUTION",
      actionRef: "att_other_instruction",
      claimedLevel: "P5",
      provenance: { source: "PROTOCOL_LEDGER" },
      payload: "foreign",
      links: [],
      recordedAt: NOW + 12n,
    });
    expect(() =>
      scenario.certificates.issue({
        certificateId: "cert_foreign",
        finalityId: scenario.finalityId,
        instruction: scenario.instruction,
        evidenceChain: ["ev_foreign"],
        reconciliationRefs: [],
        now: NOW + 20n,
      }),
    ).toThrow(/EVIDENCE_NOT_LINKED|not linked/);

    // An unknown evidence node id.
    expect(() =>
      scenario.certificates.issue({
        certificateId: "cert_missing",
        finalityId: scenario.finalityId,
        instruction: scenario.instruction,
        evidenceChain: ["ev_nonexistent"],
        reconciliationRefs: [],
        now: NOW + 20n,
      }),
    ).toThrow(/EVIDENCE_NODE_UNKNOWN|does not exist/);
  });

  it("INV-X03: unresolved or OPEN reconciliation references block issuance", () => {
    const scenario = buildScenario();

    // Reference to an unknown case.
    expect(() =>
      scenario.certificates.issue({
        certificateId: "cert_unknown_case",
        finalityId: scenario.finalityId,
        instruction: scenario.instruction,
        evidenceChain: scenario.evidenceIds,
        reconciliationRefs: ["case_nonexistent"],
        now: NOW + 20n,
      }),
    ).toThrow(/RECONCILIATION_CASE_UNKNOWN|unknown reconciliation case/);

    // Reference to an OPEN case tied to the instruction.
    scenario.reconciliation.openCase({
      caseId: "case_still_open",
      subject: { kind: "EXTERNAL_FUNDS_OBSERVATION", observationId: "obs_9" },
      reason: "EXTERNAL_FUNDS_DISCREPANCY",
      instructionRef: scenario.instruction.id,
      now: NOW + 12n,
    });
    expect(() =>
      scenario.certificates.issue({
        certificateId: "cert_open_case",
        finalityId: scenario.finalityId,
        instruction: scenario.instruction,
        evidenceChain: scenario.evidenceIds,
        reconciliationRefs: [],
        now: NOW + 20n,
      }),
    ).toThrow(/RECONCILIATION_STILL_OPEN|OPEN reconciliation cases/);
  });

  it("recurring mandate renewal reconciliation: only RESOLVED renewal cases certify", () => {
    const scenario = buildScenario();

    // An OPEN renewal case blocks the certificate that references it.
    scenario.reconciliation.openCase({
      caseId: "case_renewal_open",
      subject: { kind: "RECURRING_MANDATE_RENEWAL", mandateId: "MAN-2", renewalRef: "MAN-2:RENEWAL-1" },
      reason: "MANDATE_RENEWAL_AMBIGUITY",
      now: NOW + 12n,
    });
    expect(() =>
      scenario.certificates.issue({
        certificateId: "cert_renewal",
        finalityId: scenario.finalityId,
        instruction: scenario.instruction,
        evidenceChain: scenario.evidenceIds,
        reconciliationRefs: [],
        recurringRenewalReconciliation: "case_renewal_open",
        now: NOW + 20n,
      }),
    ).toThrow(/must be a RESOLVED RECURRING_MANDATE_RENEWAL/);

    // A resolved renewal case is accepted and carried on the certificate.
    scenario.reconciliation.resolveCase({
      caseId: "case_renewal_open",
      outcome: "MATCHED",
      resolvedBy: PRINCIPAL,
      evidenceIds: ["ev_renewal_1"],
      now: NOW + 13n,
    });
    const certificate = scenario.certificates.issue({
      certificateId: "cert_renewal",
      finalityId: scenario.finalityId,
      instruction: scenario.instruction,
      evidenceChain: scenario.evidenceIds,
      reconciliationRefs: [],
      recurringRenewalReconciliation: "case_renewal_open",
      now: NOW + 20n,
    });
    expect(certificate.recurringRenewalReconciliation).toBe("case_renewal_open");

    // A case of the WRONG subject kind is rejected.
    expect(() =>
      scenario.certificates.issue({
        certificateId: "cert_renewal_wrong",
        finalityId: scenario.finalityId,
        instruction: scenario.instruction,
        evidenceChain: scenario.evidenceIds,
        reconciliationRefs: [],
        recurringRenewalReconciliation: "case_amb",
        now: NOW + 20n,
      }),
    ).toThrow(/RECURRING_MANDATE_RENEWAL/);
  });

  it("off-network record reconciliation: resolved OFF_NETWORK cases certify; records never claim PaySwap execution", () => {
    const scenario = buildScenario();

    // An off-network record with evidence, reconciled through a case.
    const record = recordOffNetworkPayment({
      id: "OFF-1",
      source: "CHECK",
      reporter: "merchant_staff_1",
      amount: fromMinorUnits(USD, 90_000n),
      externalRef: "check-1234",
      evidence: [{ kind: "check_image", reference: "img-1", recordedAt: NOW }],
      reconciliationState: "UNRECONCILED",
      businessDocumentRefs: [{ documentKind: "INVOICE", documentId: "doc-100" }],
      recordedAt: NOW,
    });
    scenario.reconciliation.openCase({
      caseId: "case_off",
      subject: { kind: "OFF_NETWORK_RECORD", recordId: record.id },
      reason: "OFF_NETWORK_RECORD_AMBIGUITY",
      now: NOW + 12n,
    });
    // An OPEN off-network case referenced by the certificate is rejected.
    expect(() =>
      scenario.certificates.issue({
        certificateId: "cert_off",
        finalityId: scenario.finalityId,
        instruction: scenario.instruction,
        evidenceChain: scenario.evidenceIds,
        reconciliationRefs: [],
        offNetworkReconciliations: ["case_off"],
        now: NOW + 20n,
      }),
    ).toThrow(/RESOLVED OFF_NETWORK_RECORD/);

    scenario.reconciliation.resolveCase({
      caseId: "case_off",
      outcome: "MATCHED",
      resolvedBy: PRINCIPAL,
      evidenceIds: ["ev_off_1"],
      now: NOW + 13n,
    });
    const certificate = scenario.certificates.issue({
      certificateId: "cert_off",
      finalityId: scenario.finalityId,
      instruction: scenario.instruction,
      evidenceChain: scenario.evidenceIds,
      reconciliationRefs: [],
      offNetworkReconciliations: ["case_off"],
      now: NOW + 20n,
    });
    expect(certificate.offNetworkReconciliations).toEqual(["case_off"]);
    // The certificate itself certifies the PaySwap-executed instruction; the
    // off-network record stays external evidence, never PaySwap execution.
    expect(record.orchestratedBy).toBe("EXTERNAL_PARTY");
  });

  it("certificate records are frozen — in-place mutation throws", () => {
    const scenario = buildScenario();
    const certificate = scenario.certificates.issue({
      certificateId: "cert_freeze",
      finalityId: scenario.finalityId,
      instruction: scenario.instruction,
      evidenceChain: scenario.evidenceIds,
      reconciliationRefs: [],
      now: NOW + 20n,
    });
    expect(() => {
      (certificate as { canonical: string }).canonical = "tampered";
    }).toThrow(TypeError);
    expect(scenario.certificates.certificate("cert_freeze")?.canonical).toBe(certificate.canonical);
  });
});

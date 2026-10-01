import { describe, expect, it } from "vitest";
import {
  EvidenceGraph,
  ProviderRevisionConflictError,
  ProviderRevisionLedger,
  SettlementAttemptLedger,
  SettlementReconciliationAuthority,
  asSettlementAttemptId,
} from "@payswap/settlement";
import { asSettlementInstructionId } from "@payswap/protocol";
import { fiatPaymentIntentEnvelope } from "../src/fiat.js";
import { mobileMoneyEnvelope } from "../src/mobile-money.js";
import { ethereumTransactionEnvelope } from "../src/crypto.js";
import {
  mergeProviderRevision,
  openWebhookLossCase,
  recoverWebhookLoss,
  recordProviderEvidence,
  sdkObjectFetcher,
} from "../src/reconciliation-connectors.js";
import { RailTransportError } from "../src/support.js";
import type { SdkCallResult } from "@payswap/adapters";
import { CLOCK, makeAdapterAuthority } from "./fixtures.js";

const AUTHORITY = makeAdapterAuthority();
const NOW = CLOCK.now();
const PRINCIPAL = { principalType: "user", principalId: "user_1" };

function succeededFiatResult(): SdkCallResult {
  const envelope = fiatPaymentIntentEnvelope({
    intent: { id: "pi_test_9", status: "succeeded", currency: "USD", amount: 5000 },
    revision: "pi_test_9",
    observedAt: "2026-10-01T00:00:00.000Z",
  });
  return {
    providerState: envelope,
    outcome: { outcome: "SUCCEEDED" },
    evidence: {
      evidenceId: "ev-refetch-1",
      kind: "EXECUTION",
      evidenceRef: "payment_intent:pi_test_9",
      providerState: envelope,
      recordedAt: NOW,
    },
  };
}

function ambiguousReorgResult(): SdkCallResult {
  const envelope = ethereumTransactionEnvelope(
    {
      txHash: "0x" + "cc".repeat(32),
      status: "REORG_UNKNOWN",
      confirmations: 0n,
      finalityCandidate: false,
      reorgDetected: true,
    },
    "2026-10-01T00:00:00.000Z",
    12n,
  );
  return {
    providerState: envelope,
    outcome: { outcome: "OUTCOME_UNKNOWN", requiresReconciliation: true },
    evidence: {
      evidenceId: "ev-refetch-reorg-1",
      kind: "STATE_OBSERVATION",
      evidenceRef: "transaction:0xcccc",
      providerState: envelope,
      recordedAt: NOW,
    },
  };
}

function pendingMomoResult(): SdkCallResult {
  const envelope = mobileMoneyEnvelope({
    objectType: "request_to_pay",
    externalId: "ref-9",
    rawState: { referenceId: "ref-9", status: "PENDING" },
    status: "PENDING",
    revision: "PENDING",
    observedAt: "2026-10-01T00:00:00.000Z",
  });
  return {
    providerState: envelope,
    outcome: { outcome: "AWAITING_CUSTOMER_ACTION" },
    evidence: {
      evidenceId: "ev-refetch-momo-1",
      kind: "EXECUTION",
      evidenceRef: "request_to_pay:ref-9",
      providerState: envelope,
      recordedAt: NOW,
    },
  };
}

interface Harness {
  readonly attemptLedger: SettlementAttemptLedger;
  readonly reconciliationAuthority: SettlementReconciliationAuthority;
  readonly revisionLedger: ProviderRevisionLedger;
  readonly evidenceGraph: EvidenceGraph;
}

/** A settlement attempt recorded OUTCOME_UNKNOWN (the webhook was lost). */
function harnessWithUnknownAttempt(rail: string): Harness & { readonly attemptId: ReturnType<typeof asSettlementAttemptId> } {
  const attemptLedger = new SettlementAttemptLedger();
  const reconciliationAuthority = new SettlementReconciliationAuthority(attemptLedger);
  const attemptId = asSettlementAttemptId("settle-att-rec-1");
  attemptLedger.begin({
    attemptId,
    instructionId: asSettlementInstructionId("settle-instr-rec-1"),
    rail,
    idempotencyKey: "idem-rec-1",
    principal: PRINCIPAL,
    now: NOW,
  });
  attemptLedger.start(attemptId, NOW);
  // The ambiguity observation itself is evidence (INV-E02).
  attemptLedger.recordExternalOutcome(attemptId, "OUTCOME_UNKNOWN", ["ev-webhook-loss-1"], NOW);
  return {
    attemptLedger,
    reconciliationAuthority,
    revisionLedger: new ProviderRevisionLedger(),
    evidenceGraph: new EvidenceGraph(),
    attemptId,
  };
}

describe("webhook-loss recovery (INV-X03 — reconciliation as authority)", () => {
  it("recovers a lost webhook by re-fetching and resolves the case with evidence", async () => {
    const h = harnessWithUnknownAttempt("rail.fiat.stripe-shape");
    const opened = openWebhookLossCase(h.reconciliationAuthority, {
      caseId: "case-wl-1",
      attemptId: h.attemptId,
      now: NOW,
    });
    expect(opened.status).toBe("OPEN");

    const result = await recoverWebhookLoss(
      {
        fetcher: async () => succeededFiatResult(),
        revisionLedger: h.revisionLedger,
        reconciliationAuthority: h.reconciliationAuthority,
        evidenceGraph: h.evidenceGraph,
      },
      {
        caseId: "case-wl-1",
        attemptId: h.attemptId,
        externalObjectType: "payment_intent",
        externalId: "pi_test_9",
        resolvedBy: PRINCIPAL,
        now: NOW,
        idempotencyKey: "idem-refetch-1",
      },
    );
    expect(result.status).toEqual({ kind: "RESOLVED", outcome: "CONFIRMED_SUCCEEDED" });
    // The attempt left OUTCOME_UNKNOWN ONLY through the reconciliation
    // resolution (INV-X03) — now terminal.
    expect(h.attemptLedger.attempt(h.attemptId)?.state).toBe("SUCCEEDED");
    expect(h.reconciliationAuthority.case("case-wl-1")?.status).toBe("RESOLVED");
    // The resolution carries the re-fetch evidence ids (INV-E02).
    expect(result.evidenceIds).toEqual(["ev-refetch-1"]);
    expect(h.evidenceGraph.node("ev-refetch-1")?.kind).toBe("EXECUTION");
    expect(h.evidenceGraph.node("ev-refetch-1")?.provenance).toEqual({
      source: "AUTHENTICATED_PROVIDER",
      providerName: "stripe-shape",
    });
    // The observed revision was appended (INV-C06).
    expect(h.revisionLedger.allEntries().length).toBe(1);
  });

  it("is idempotent: a second recovery reports ALREADY_RESOLVED without re-fetching", async () => {
    const h = harnessWithUnknownAttempt("rail.fiat.stripe-shape");
    openWebhookLossCase(h.reconciliationAuthority, {
      caseId: "case-wl-2",
      attemptId: h.attemptId,
      now: NOW,
    });
    const deps = {
      fetcher: async () => succeededFiatResult(),
      revisionLedger: h.revisionLedger,
      reconciliationAuthority: h.reconciliationAuthority,
      evidenceGraph: h.evidenceGraph,
    };
    const first = await recoverWebhookLoss(deps, {
      caseId: "case-wl-2",
      attemptId: h.attemptId,
      externalObjectType: "payment_intent",
      externalId: "pi_test_9",
      resolvedBy: PRINCIPAL,
      now: NOW,
      idempotencyKey: "idem-refetch-2",
    });
    expect(first.status.kind).toBe("RESOLVED");
    let fetchCount = 0;
    const countingDeps = {
      ...deps,
      fetcher: async () => {
        fetchCount += 1;
        return succeededFiatResult();
      },
    };
    const second = await recoverWebhookLoss(countingDeps, {
      caseId: "case-wl-2",
      attemptId: h.attemptId,
      externalObjectType: "payment_intent",
      externalId: "pi_test_9",
      resolvedBy: PRINCIPAL,
      now: NOW,
      idempotencyKey: "idem-refetch-2b",
    });
    expect(second.status).toEqual({ kind: "ALREADY_RESOLVED" });
    expect(fetchCount).toBe(0);
    // Resolutions are immutable (INV-E05): one entry, one resolution.
    expect(h.revisionLedger.allEntries().length).toBe(1);
  });

  it("keeps the case OPEN when the recovered state is still ambiguous (INV-X01)", async () => {
    const h = harnessWithUnknownAttempt("rail.crypto.ethereum_json_rpc");
    openWebhookLossCase(h.reconciliationAuthority, {
      caseId: "case-wl-3",
      attemptId: h.attemptId,
      now: NOW,
    });
    const result = await recoverWebhookLoss(
      {
        fetcher: async () => ambiguousReorgResult(),
        revisionLedger: h.revisionLedger,
        reconciliationAuthority: h.reconciliationAuthority,
        evidenceGraph: h.evidenceGraph,
      },
      {
        caseId: "case-wl-3",
        attemptId: h.attemptId,
        externalObjectType: "transaction",
        externalId: "0xcccc",
        resolvedBy: PRINCIPAL,
        now: NOW,
        idempotencyKey: "idem-refetch-3",
      },
    );
    expect(result.status).toEqual({ kind: "STILL_OPEN", reason: "OUTCOME_STILL_UNKNOWN" });
    expect(h.reconciliationAuthority.case("case-wl-3")?.status).toBe("OPEN");
    expect(h.attemptLedger.attempt(h.attemptId)?.state).toBe("OUTCOME_UNKNOWN");
  });

  it("keeps the case OPEN when the recovered state awaits customer action (INV-C06 semantics respected)", async () => {
    const h = harnessWithUnknownAttempt("rail.mobile_money.mtn_momo");
    openWebhookLossCase(h.reconciliationAuthority, {
      caseId: "case-wl-4",
      attemptId: h.attemptId,
      now: NOW,
    });
    const result = await recoverWebhookLoss(
      {
        fetcher: async () => pendingMomoResult(),
        revisionLedger: h.revisionLedger,
        reconciliationAuthority: h.reconciliationAuthority,
        evidenceGraph: h.evidenceGraph,
      },
      {
        caseId: "case-wl-4",
        attemptId: h.attemptId,
        externalObjectType: "request_to_pay",
        externalId: "ref-9",
        resolvedBy: PRINCIPAL,
        now: NOW,
        idempotencyKey: "idem-refetch-4",
      },
    );
    expect(result.status).toEqual({ kind: "STILL_OPEN", reason: "AWAITING_CUSTOMER_ACTION" });
    expect(h.reconciliationAuthority.case("case-wl-4")?.status).toBe("OPEN");
  });

  it("keeps the case OPEN with NO fabricated evidence when the rail is unreachable", async () => {
    const h = harnessWithUnknownAttempt("rail.fiat.stripe-shape");
    openWebhookLossCase(h.reconciliationAuthority, {
      caseId: "case-wl-5",
      attemptId: h.attemptId,
      now: NOW,
    });
    const result = await recoverWebhookLoss(
      {
        fetcher: async () => {
          throw new RailTransportError("rail unreachable");
        },
        revisionLedger: h.revisionLedger,
        reconciliationAuthority: h.reconciliationAuthority,
        evidenceGraph: h.evidenceGraph,
      },
      {
        caseId: "case-wl-5",
        attemptId: h.attemptId,
        externalObjectType: "payment_intent",
        externalId: "pi_test_9",
        resolvedBy: PRINCIPAL,
        now: NOW,
        idempotencyKey: "idem-refetch-5",
      },
    );
    expect(result.status).toEqual({ kind: "STILL_OPEN", reason: "RAIL_UNREACHABLE" });
    expect(result.evidenceIds).toEqual([]);
    expect(h.revisionLedger.allEntries().length).toBe(0);
    expect(h.reconciliationAuthority.case("case-wl-5")?.status).toBe("OPEN");
    expect(h.attemptLedger.attempt(h.attemptId)?.state).toBe("OUTCOME_UNKNOWN");
  });

  it("resolves a DEFINITIVE provider failure as CONFIRMED_FAILED", async () => {
    const h = harnessWithUnknownAttempt("rail.mobile_money.mtn_momo");
    openWebhookLossCase(h.reconciliationAuthority, {
      caseId: "case-wl-6",
      attemptId: h.attemptId,
      now: NOW,
    });
    const envelope = mobileMoneyEnvelope({
      objectType: "request_to_pay",
      externalId: "ref-10",
      rawState: { referenceId: "ref-10", status: "FAILED" },
      status: "FAILED",
      revision: "FAILED",
      observedAt: "2026-10-01T00:00:00.000Z",
      failureReason: { code: "PAYER_NOT_FOUND", message: "payer could not be reached" },
    });
    const result = await recoverWebhookLoss(
      {
        fetcher: async () => ({
          providerState: envelope,
          outcome: { outcome: "FAILED", retryable: true },
          evidence: {
            evidenceId: "ev-refetch-6",
            kind: "EXECUTION",
            evidenceRef: "request_to_pay:ref-10",
            providerState: envelope,
            recordedAt: NOW,
          },
        }),
        revisionLedger: h.revisionLedger,
        reconciliationAuthority: h.reconciliationAuthority,
        evidenceGraph: h.evidenceGraph,
      },
      {
        caseId: "case-wl-6",
        attemptId: h.attemptId,
        externalObjectType: "request_to_pay",
        externalId: "ref-10",
        resolvedBy: PRINCIPAL,
        now: NOW,
        idempotencyKey: "idem-refetch-6",
      },
    );
    expect(result.status).toEqual({ kind: "RESOLVED", outcome: "CONFIRMED_FAILED" });
    expect(h.attemptLedger.attempt(h.attemptId)?.state).toBe("FAILED");
  });
});

describe("provider-revision append-only merge (INV-C06)", () => {
  it("re-appends the identical revision idempotently", () => {
    const ledger = new ProviderRevisionLedger();
    const result = succeededFiatResult();
    const first = mergeProviderRevision(ledger, result.providerState, NOW);
    const second = mergeProviderRevision(ledger, result.providerState, NOW + 1n);
    expect(second).toBe(first);
    expect(ledger.allEntries().length).toBe(1);
  });

  it("REJECTS a divergent re-record of the same revision (canonical history is never overwritten)", () => {
    const ledger = new ProviderRevisionLedger();
    const a = succeededFiatResult().providerState;
    const b = fiatPaymentIntentEnvelope({
      intent: { id: "pi_test_9", status: "succeeded", currency: "EUR", amount: 5000 },
      revision: a.revision,
      observedAt: "2026-10-01T00:00:00.000Z",
    });
    mergeProviderRevision(ledger, a, NOW);
    expect(() => mergeProviderRevision(ledger, b, NOW + 1n)).toThrow(ProviderRevisionConflictError);
  });

  it("appends NEW revisions of the same object in observation order", () => {
    const ledger = new ProviderRevisionLedger();
    const pending = mobileMoneyEnvelope({
      objectType: "request_to_pay",
      externalId: "ref-11",
      rawState: { referenceId: "ref-11", status: "PENDING" },
      status: "PENDING",
      revision: "PENDING",
      observedAt: "2026-10-01T00:00:00.000Z",
    });
    const succeeded = mobileMoneyEnvelope({
      objectType: "request_to_pay",
      externalId: "ref-11",
      rawState: { referenceId: "ref-11", status: "SUCCESSFUL" },
      status: "SUCCESSFUL",
      revision: "SUCCESSFUL",
      observedAt: "2026-10-01T00:05:00.000Z",
    });
    mergeProviderRevision(ledger, pending, NOW);
    mergeProviderRevision(ledger, succeeded, NOW + 1n);
    const history = ledger.history("mtn-momo", "request_to_pay", "ref-11");
    expect(history.length).toBe(2);
    expect(history[0]?.revision).toBe("PENDING");
    expect(history[1]?.revision).toBe("SUCCESSFUL");
  });
});

describe("evidence recording + fetcher wiring", () => {
  it("records provider evidence with AUTHENTICATED_PROVIDER provenance and P2 claims", () => {
    const graph = new EvidenceGraph();
    const result = succeededFiatResult();
    recordProviderEvidence(graph, {
      draft: result.evidence,
      actionRef: "settle-att-rec-1",
      providerName: result.providerState.provider.name,
    });
    const node = graph.node("ev-refetch-1");
    expect(node?.claimedLevel).toBe("P2");
    expect(node?.actionRef).toBe("settle-att-rec-1");
    expect(node?.provenance.source).toBe("AUTHENTICATED_PROVIDER");
  });

  it("builds a fetcher over an SDK read surface with an explicit request mapping", async () => {
    let seen: { authority: unknown; idempotencyKey: string; request: unknown } | undefined;
    const fetcher = sdkObjectFetcher(
      async (callCtx) => {
        seen = callCtx;
        return succeededFiatResult();
      },
      AUTHORITY,
      (type, id) => ({ kind: "read_intent", intentId: id, objectType: type }),
    );
    const result = await fetcher({
      externalObjectType: "payment_intent",
      externalId: "pi_test_9",
      idempotencyKey: "idem-fetch-1",
    });
    expect(result.outcome).toEqual({ outcome: "SUCCEEDED" });
    expect(seen?.idempotencyKey).toBe("idem-fetch-1");
    expect(seen?.request).toEqual({
      kind: "read_intent",
      intentId: "pi_test_9",
      objectType: "payment_intent",
    });
  });
});

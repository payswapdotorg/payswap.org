/**
 * Reconciliation connectors — webhook-loss recovery over the settlement
 * plane's reconciliation authority (W1-005; FROZEN-ARCHITECTURE §22).
 *
 * INV-X03 (reconciliation-as-authority): when a provider webhook is lost,
 * the attempt's outcome is UNKNOWN and ONLY a settlement reconciliation
 * case — resolved with linked provider evidence — may turn it definitive.
 * This connector implements exactly that loop:
 *
 * 1. re-fetch the provider state by EXTERNAL OBJECT ID + REVISION through
 *    the rail's read surface (the provider remains the source of truth for
 *    its own objects — EXTERNAL_AUTHORITATIVE);
 * 2. append the observed envelope to the append-only ProviderRevisionLedger
 *    (INV-C06: identical re-record is an idempotent replay; a divergent
 *    re-record of the same revision is a conflict, never an overwrite);
 * 3. record the provider evidence into the EvidenceGraph (INV-E02) with
 *    AUTHENTICATED_PROVIDER provenance;
 * 4. classify through `settlementOutcomeFromProviderState` and, ONLY for a
 *    definitive SUCCEEDED/FAILED, resolve the case (CONFIRMED_*). An
 *    OUTCOME_UNKNOWN or non-recordable state (customer action pending /
 *    async processing) leaves the case OPEN — never fabricated, never
 *    retried blindly (INV-X01/INV-X02);
 * 5. an unreachable rail leaves the case OPEN with an UNREACHABLE status —
 *    the connector NEVER fabricates a business outcome for an outage.
 */

import { ValidationError } from "@payswap/protocol";
import type { PrincipalRef, TimestampMs } from "@payswap/protocol";
import { ProviderRevisionLedger, SettlementReconciliationAuthority } from "@payswap/settlement";
import type {
  ProviderRevisionEntry,
  ReconciliationCaseId,
  SettlementAttemptId,
  SettlementReconciliationCase,
} from "@payswap/settlement";
import { EvidenceGraph } from "@payswap/settlement";
import type { EvidenceNodeKind, EvidenceProvenance } from "@payswap/settlement";
import { settlementOutcomeFromProviderState } from "@payswap/settlement";
import type { SdkCallContext, SdkCallResult } from "@payswap/adapters";
import type { AdapterExecutionAuthority, ProviderExecutionEvidenceDraft } from "@payswap/execution";
import { RailProviderError, RailTransportError } from "./support.js";

// ---------------------------------------------------------------------------
// The rail read surface the connectors consume
// ---------------------------------------------------------------------------

/** Re-fetches one external object's current provider state by id (INV-X03). */
export type ExternalObjectFetcher = (input: {
  readonly externalObjectType: string;
  readonly externalId: string;
  readonly idempotencyKey: string;
}) => Promise<SdkCallResult>;

/** The dependencies the webhook-loss recovery connector runs on. */
export interface WebhookLossRecoveryDeps {
  readonly fetcher: ExternalObjectFetcher;
  readonly revisionLedger: ProviderRevisionLedger;
  readonly reconciliationAuthority: SettlementReconciliationAuthority;
  readonly evidenceGraph: EvidenceGraph;
}

export interface RecoverWebhookLossInput {
  readonly caseId: string;
  readonly attemptId: SettlementAttemptId;
  readonly externalObjectType: string;
  readonly externalId: string;
  readonly resolvedBy: PrincipalRef;
  readonly now: TimestampMs;
  readonly idempotencyKey: string;
}

export type WebhookLossRecoveryStatus =
  | { readonly kind: "RESOLVED"; readonly outcome: "CONFIRMED_SUCCEEDED" | "CONFIRMED_FAILED" }
  | { readonly kind: "ALREADY_RESOLVED" }
  | {
      readonly kind: "STILL_OPEN";
      readonly reason:
        | "OUTCOME_STILL_UNKNOWN"
        | "AWAITING_CUSTOMER_ACTION"
        | "ASYNC_PROCESSING"
        | "RAIL_UNREACHABLE"
        | "RAIL_ERROR";
    };

export interface RecoverWebhookLossResult {
  readonly caseId: ReconciliationCaseId;
  readonly status: WebhookLossRecoveryStatus;
  /** Provider evidence node ids backing the (attempted) resolution (INV-E02). */
  readonly evidenceIds: readonly string[];
  /** The append-only revision entry for the re-fetched state (idempotent). */
  readonly revision?: ProviderRevisionEntry;
}

// ---------------------------------------------------------------------------
// Case opening (wrapper over the settlement reconciliation authority)
// ---------------------------------------------------------------------------

/**
 * Opens the settlement reconciliation case for a webhook-loss scenario: the
 * attempt MUST already be OUTCOME_UNKNOWN (the ambiguity the case exists
 * for — INV-X03). Reason: EXTERNAL_AMBIGUITY (the webhook never arrived).
 */
export function openWebhookLossCase(
  authority: SettlementReconciliationAuthority,
  input: {
    readonly caseId: string;
    readonly attemptId: SettlementAttemptId;
    readonly now: TimestampMs;
  },
): SettlementReconciliationCase {
  return authority.openCase({
    caseId: input.caseId,
    subject: { kind: "SETTLEMENT_ATTEMPT", attemptId: input.attemptId },
    reason: "EXTERNAL_AMBIGUITY",
    now: input.now,
  });
}

// ---------------------------------------------------------------------------
// Provider-revision append-only merge (INV-C06)
// ---------------------------------------------------------------------------

/**
 * Appends one observed provider state to the append-only revision ledger.
 * Idempotent re-ingestion: re-appending the byte-identical envelope for the
 * same (provider, object, revision) REPLAYS the existing entry; a divergent
 * re-record of the same revision throws `ProviderRevisionConflictError` —
 * canonical history is never overwritten (INV-C06).
 */
export function mergeProviderRevision(
  ledger: ProviderRevisionLedger,
  providerState: SdkCallResult["providerState"],
  now: TimestampMs,
): ProviderRevisionEntry {
  return ledger.append(providerState, now);
}

// ---------------------------------------------------------------------------
// Evidence recording (INV-E02 — authenticated provider provenance)
// ---------------------------------------------------------------------------

/** Maps a provider evidence draft kind onto an evidence-graph node kind. */
function evidenceNodeKind(draft: ProviderExecutionEvidenceDraft): EvidenceNodeKind {
  switch (draft.kind) {
    case "EXECUTION":
      return "EXECUTION";
    case "STATE_OBSERVATION":
      return "OUTCOME";
    case "RECEIPT":
      return "RECEIPT";
    default:
      return "EXECUTION";
  }
}

/**
 * Records one provider evidence draft into the evidence graph, linked to
 * the consequential action (the attempt). The provenance is
 * AUTHENTICATED_PROVIDER — the provider API is the source (INV-E04 caps
 * what a node may claim; we claim P2 for provider-authenticated execution
 * observations, never proof-level strength).
 */
export function recordProviderEvidence(
  evidenceGraph: EvidenceGraph,
  input: {
    readonly draft: ProviderExecutionEvidenceDraft;
    readonly actionRef: string;
    readonly providerName: string;
    readonly links?: readonly string[];
  },
): void {
  const provenance: EvidenceProvenance = {
    source: "AUTHENTICATED_PROVIDER",
    providerName: input.providerName,
  };
  evidenceGraph.record({
    nodeId: input.draft.evidenceId,
    kind: evidenceNodeKind(input.draft),
    actionRef: input.actionRef,
    claimedLevel: "P2",
    provenance,
    payload: JSON.stringify({
      evidenceRef: input.draft.evidenceRef,
      recordedAt: input.draft.recordedAt.toString(),
      providerState: input.draft.providerState,
    }),
    links: input.links ?? [],
    recordedAt: input.draft.recordedAt,
  });
}

// ---------------------------------------------------------------------------
// The webhook-loss recovery connector (INV-X03)
// ---------------------------------------------------------------------------

/**
 * Recovers one webhook-loss case: re-fetch → append-only merge → evidence →
 * authoritative resolution ONLY when the recovered provider state is
 * definitive. Everything else leaves the case OPEN (never fabricated).
 */
export async function recoverWebhookLoss(
  deps: WebhookLossRecoveryDeps,
  input: RecoverWebhookLossInput,
): Promise<RecoverWebhookLossResult> {
  if (input === null || typeof input !== "object") {
    throw new ValidationError("recovery input must be an object");
  }
  const existingCase = deps.reconciliationAuthority.case(input.caseId);
  if (existingCase === undefined) {
    throw new ValidationError(
      `reconciliation case '${input.caseId}' does not exist — open it first (openWebhookLossCase)`,
    );
  }
  if (existingCase.status === "RESOLVED") {
    // Idempotent re-ingestion after resolution: the immutable resolution
    // stands (INV-E05); we report ALREADY_RESOLVED without re-fetching.
    return {
      caseId: existingCase.caseId,
      status: { kind: "ALREADY_RESOLVED" },
      evidenceIds: existingCase.resolution?.evidenceIds ?? [],
    };
  }

  let result: SdkCallResult;
  try {
    result = await deps.fetcher({
      externalObjectType: input.externalObjectType,
      externalId: input.externalId,
      idempotencyKey: input.idempotencyKey,
    });
  } catch (error) {
    if (error instanceof RailTransportError) {
      // The rail is unreachable: NO provider state was observed, NO
      // evidence exists, the case stays OPEN — an outage NEVER fabricates a
      // business outcome (INV-X03; see incidents.ts for outage evidence).
      return {
        caseId: existingCase.caseId,
        status: { kind: "STILL_OPEN", reason: "RAIL_UNREACHABLE" },
        evidenceIds: [],
      };
    }
    if (error instanceof RailProviderError) {
      // The provider answered with an error we cannot classify as a
      // business outcome: still no provider state, still OPEN (INV-X03).
      return {
        caseId: existingCase.caseId,
        status: { kind: "STILL_OPEN", reason: "RAIL_ERROR" },
        evidenceIds: [],
      };
    }
    throw error;
  }

  // Append-only merge of the observed revision (idempotent; INV-C06).
  const revision = mergeProviderRevision(deps.revisionLedger, result.providerState, input.now);

  // Evidence lineage (INV-E02): the re-fetched state is provider evidence
  // linked to the ambiguous attempt.
  recordProviderEvidence(deps.evidenceGraph, {
    draft: result.evidence,
    actionRef: input.attemptId,
    providerName: result.providerState.provider.name,
  });
  const evidenceIds = [result.evidence.evidenceId];

  const classification = settlementOutcomeFromProviderState(result.providerState);
  if (!classification.recordable) {
    return {
      caseId: existingCase.caseId,
      status: {
        kind: "STILL_OPEN",
        reason:
          classification.reason === "AWAITING_CUSTOMER_ACTION"
            ? "AWAITING_CUSTOMER_ACTION"
            : "ASYNC_PROCESSING",
      },
      evidenceIds,
      revision,
    };
  }
  if (classification.outcome === "OUTCOME_UNKNOWN") {
    // INV-X01: ambiguity is ambiguity — the case stays OPEN.
    return {
      caseId: existingCase.caseId,
      status: { kind: "STILL_OPEN", reason: "OUTCOME_STILL_UNKNOWN" },
      evidenceIds,
      revision,
    };
  }

  const outcome =
    classification.outcome === "SUCCEEDED" ? "CONFIRMED_SUCCEEDED" : "CONFIRMED_FAILED";
  deps.reconciliationAuthority.resolveCase({
    caseId: input.caseId,
    outcome,
    resolvedBy: input.resolvedBy,
    evidenceIds,
    now: input.now,
    note: `webhook-loss recovery: re-fetched ${input.externalObjectType}/${input.externalId} at revision ${revision.revision}`,
  });
  return {
    caseId: existingCase.caseId,
    status: { kind: "RESOLVED", outcome },
    evidenceIds,
    revision,
  };
}

// ---------------------------------------------------------------------------
// Rail fetcher adapters (explicit per-rail request mapping)
// ---------------------------------------------------------------------------

/**
 * Builds an ExternalObjectFetcher over any ConnectorSDK read surface plus an
 * explicit request mapping — the provider-neutral request shape stays a
 * rail concern, never a connector concern (AGENTS.md rule 17). The
 * authority is the operator-held adapter execution authority (INV-C04).
 */
export function sdkObjectFetcher(
  read: (ctx: SdkCallContext) => Promise<SdkCallResult>,
  authority: AdapterExecutionAuthority,
  requestFor: (externalObjectType: string, externalId: string) => unknown,
): ExternalObjectFetcher {
  return async (input) =>
    read({
      authority,
      idempotencyKey: input.idempotencyKey,
      request: requestFor(input.externalObjectType, input.externalId),
    });
}

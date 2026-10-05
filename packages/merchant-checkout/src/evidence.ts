/**
 * @payswap/merchant-checkout — journey evidence records (P4-W2-003 §3.10).
 *
 * One evidence record per journey stage (merchant onboarding → acceptance
 * activation → checkout → wallet authorization (kernel walk) → lifecycle →
 * webhook updates → settlement), each carrying its references, lineage and
 * evidence digests. Records are DETERMINISTIC and REGENERABLE: the same
 * pinned fixtures always produce the same records (verified byte-identical
 * across regenerations by the evidence-files test, mirroring W4-001's
 * evidence/route-journeys.json pattern).
 *
 * Law marker (recorded in the file, asserted by the test):
 * `FIXTURE_PROVEN_TRUSTED_SURFACE_SIGNING_ONLY` — the wallet payment
 * composes the REAL W1-002 kernel, whose terminal state is
 * BROADCAST_HANDOFF: the kernel never broadcasts, and the signed
 * authorization artifact is minted ONLY by the injected trusted approval
 * surface. No artifact of this package signs, broadcasts or moves value.
 */

import { ValidationError } from "@payswap/protocol";
import { assertNoSecretMaterial, contentDigest } from "@payswap/onchain-security";
import type { PipelineEvidenceEntry } from "@payswap/onchain-security";
import type { MerchantProfile } from "./onboarding.js";
import type { CryptoAcceptanceActivation } from "./acceptance.js";
import type { CheckoutFlow } from "./checkout.js";
import type { WalletAuthorizationLineage } from "./payment.js";
import type { CheckoutPaymentAttempt } from "./lifecycle.js";
import type { WebhookInbox } from "./webhooks.js";
import type { RefundRecord } from "./refunds.js";
import type { MerchantSettlementRecord } from "./settlement.js";

/** The law marker carried by every evidence file of this package. */
export const MERCHANT_CHECKOUT_EVIDENCE_LAW =
  "FIXTURE_PROVEN_TRUSTED_SURFACE_SIGNING_ONLY" as const;

/** The journey stages, in flow order. */
export const MERCHANT_CHECKOUT_JOURNEY_STAGES = [
  "MERCHANT_ONBOARDING",
  "ACCEPTANCE_ACTIVATION",
  "CHECKOUT_SESSION",
  "WALLET_AUTHORIZATION",
  "PAYMENT_LIFECYCLE",
  "WEBHOOK_UPDATES",
  "REFUND",
  "SETTLEMENT",
] as const;

export type MerchantCheckoutJourneyStage =
  (typeof MERCHANT_CHECKOUT_JOURNEY_STAGES)[number];

/** The per-stage reference bundle (only the ids/refs — records stay in state). */
export interface JourneyStageRefs {
  readonly stage: MerchantCheckoutJourneyStage;
  readonly refs: readonly string[];
  /** Evidence lineage references (ids of evidence records backing the stage). */
  readonly evidenceRefs: readonly string[];
  /** Optional kernel pipeline evidence log (the wallet-authorization stage). */
  readonly pipelineEvidence?: readonly PipelineEvidenceEntry[];
}

/** One journey evidence record. */
export interface MerchantCheckoutJourneyRecord {
  readonly journeyId: string;
  readonly stage: MerchantCheckoutJourneyStage;
  readonly refs: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly pipelineEvidence?: readonly PipelineEvidenceEntry[];
  /** contentDigest over the canonical record projection. */
  readonly digest: string;
}

/** The evidence file shape. */
export interface MerchantCheckoutJourneyEvidenceFile {
  readonly lawMarker: typeof MERCHANT_CHECKOUT_EVIDENCE_LAW;
  readonly packageName: string;
  readonly journeyId: string;
  readonly stages: readonly MerchantCheckoutJourneyRecord[];
}

/** The pinned record types per stage (for building records from real state). */
export interface JourneyEvidenceInputs {
  readonly journeyId: string;
  readonly profile: MerchantProfile;
  readonly activation: CryptoAcceptanceActivation;
  readonly flow: CheckoutFlow;
  readonly authorization: WalletAuthorizationLineage;
  readonly pipelineEvidence: readonly PipelineEvidenceEntry[];
  readonly attempt: CheckoutPaymentAttempt;
  readonly inbox: WebhookInbox;
  readonly refund: RefundRecord;
  readonly settlement: MerchantSettlementRecord;
}

/** Deterministic digest of one journey record (the kernel's own digest). */
export function journeyRecordDigest(
  record: Omit<MerchantCheckoutJourneyRecord, "digest">,
): string {
  return contentDigest({
    journeyId: record.journeyId,
    stage: record.stage,
    refs: [...record.refs],
    evidenceRefs: [...record.evidenceRefs],
    pipelineEvidence:
      record.pipelineEvidence !== undefined ? [...record.pipelineEvidence] : undefined,
  });
}

function requireStageRefs(stageRefs: readonly JourneyStageRefs[]): void {
  if (!Array.isArray(stageRefs) || stageRefs.length === 0) {
    throw new ValidationError(
      "journey evidence requires at least one stage record (one per stage, in flow order)",
    );
  }
  const seen = new Set<string>();
  for (const stage of stageRefs) {
    if (stage === null || typeof stage !== "object" || typeof stage.stage !== "string") {
      throw new ValidationError("each stage record must be a JourneyStageRefs");
    }
    if (seen.has(stage.stage)) {
      throw new ValidationError("journey stages must not repeat", { stage: stage.stage });
    }
    seen.add(stage.stage);
    if (
      !Array.isArray(stage.refs) ||
      stage.refs.length === 0 ||
      !stage.refs.every((ref: string) => typeof ref === "string" && ref.length > 0)
    ) {
      throw new ValidationError(
        `the ${stage.stage} stage requires non-empty refs (lineage)`,
      );
    }
    if (
      !Array.isArray(stage.evidenceRefs) ||
      stage.evidenceRefs.length === 0 ||
      !stage.evidenceRefs.every((ref: string) => typeof ref === "string" && ref.length > 0)
    ) {
      throw new ValidationError(
        `the ${stage.stage} stage requires non-empty evidence refs (INV-E01/E02)`,
      );
    }
  }
}

/**
 * Build the journey evidence records — one per stage, in flow order, each
 * digest-stable. Deterministic pure function of the stage inputs.
 */
export function buildJourneyEvidence(
  journeyId: string,
  stageRefs: readonly JourneyStageRefs[],
): readonly MerchantCheckoutJourneyRecord[] {
  if (typeof journeyId !== "string" || journeyId.length === 0) {
    throw new ValidationError("a journey requires a journeyId");
  }
  requireStageRefs(stageRefs);
  const records = stageRefs.map((stage) => {
    const base: Omit<MerchantCheckoutJourneyRecord, "digest"> = {
      journeyId,
      stage: stage.stage,
      refs: Object.freeze([...stage.refs]),
      evidenceRefs: Object.freeze([...stage.evidenceRefs]),
      ...(stage.pipelineEvidence !== undefined
        ? { pipelineEvidence: Object.freeze([...stage.pipelineEvidence]) }
        : {}),
    };
    const record: MerchantCheckoutJourneyRecord = Object.freeze({
      ...base,
      digest: journeyRecordDigest(base),
    });
    assertNoSecretMaterial(record, "journey evidence record");
    return record;
  });
  return Object.freeze(records);
}

/**
 * Derive the per-stage refs from the REAL journey state (the pinned
 * records). The wallet-authorization stage carries the kernel pipeline's
 * append-only evidence log verbatim (the kernel walk).
 */
export function journeyStagesFromState(
  inputs: JourneyEvidenceInputs,
): readonly JourneyStageRefs[] {
  if (inputs === null || typeof inputs !== "object") {
    throw new ValidationError("journeyStagesFromState requires the journey inputs");
  }
  const stages: JourneyStageRefs[] = [
    {
      stage: "MERCHANT_ONBOARDING",
      refs: [`merchant:${inputs.profile.id}`, `state:${inputs.profile.state}`],
      evidenceRefs: [
        `onboarding:${inputs.profile.id}`,
        ...(inputs.profile.verificationRef !== undefined
          ? [inputs.profile.verificationRef]
          : []),
        ...(inputs.profile.settlementDestination !== undefined
          ? [`destination:${inputs.profile.settlementDestination.id}`]
          : []),
      ],
    },
    {
      stage: "ACCEPTANCE_ACTIVATION",
      refs: [`activation:${inputs.activation.id}`, `policy:${inputs.activation.policy.id}`],
      evidenceRefs: [
        `activation:${inputs.activation.id}`,
        `composed-policy:${inputs.activation.policy.id}`,
        `base-policy:${inputs.activation.policy.basePolicyId}`,
      ],
    },
    {
      stage: "CHECKOUT_SESSION",
      refs: [
        `flow:${inputs.flow.id}`,
        `intent:${inputs.flow.intent.id}`,
        `session:${inputs.flow.session.id}`,
        `options:${inputs.flow.options.length}`,
      ],
      evidenceRefs: [
        `session:${inputs.flow.session.id}`,
        `intent:${inputs.flow.intent.id}`,
        ...inputs.flow.options.map((option) => `option:${option.optionId}`),
      ],
    },
    {
      stage: "WALLET_AUTHORIZATION",
      refs: [
        `authorization:${inputs.authorization.authorizationRequestHash}`,
        `write:${inputs.authorization.writeDigest}`,
        `signing-request:${inputs.authorization.signingRequestId}`,
        `submission:${inputs.authorization.externalSubmissionRef}`,
      ],
      evidenceRefs: [...inputs.authorization.evidenceRefs],
      pipelineEvidence: Object.freeze([...inputs.pipelineEvidence]),
    },
    {
      stage: "PAYMENT_LIFECYCLE",
      refs: [
        `attempt:${inputs.attempt.attempt.id}`,
        `intent:${inputs.attempt.attempt.intentId}`,
        `state:${inputs.attempt.attempt.state}`,
        `authorization:${inputs.attempt.authorization.authorizationRequestHash}`,
      ],
      evidenceRefs: [...inputs.attempt.attempt.evidenceIds],
    },
    {
      stage: "WEBHOOK_UPDATES",
      refs: [
        `applied:${inputs.inbox.appliedEventIds.length}`,
        `rejected:${inputs.inbox.rejections.length}`,
        `duplicates:${inputs.inbox.duplicates.length}`,
      ],
      evidenceRefs: [
        ...inputs.inbox.appliedEventIds.map((id) => `webhook:${id}`),
        ...inputs.inbox.rejections.map((entry) => `webhook-rejected:${entry.eventId}`),
      ],
    },
    {
      stage: "REFUND",
      refs: [
        `refund:${inputs.refund.id}`,
        `original-attempt:${inputs.refund.originalAttemptId}`,
        `state:${inputs.refund.state}`,
      ],
      evidenceRefs: [...inputs.refund.evidenceIds],
    },
    {
      stage: "SETTLEMENT",
      refs: [
        `settlement:${inputs.settlement.settlementId}`,
        `attempt:${inputs.settlement.attemptId}`,
        `route-family:${inputs.settlement.routeFamily}`,
        `settlement-mode:${inputs.settlement.settlementMode}`,
      ],
      evidenceRefs: [...inputs.settlement.evidenceIds],
    },
  ];
  return Object.freeze(stages);
}

/** Build the full evidence file from the journey state. */
export function buildJourneyEvidenceFile(
  inputs: JourneyEvidenceInputs,
): MerchantCheckoutJourneyEvidenceFile {
  const stages = buildJourneyEvidence(
    inputs.journeyId,
    journeyStagesFromState(inputs),
  );
  const file: MerchantCheckoutJourneyEvidenceFile = Object.freeze({
    lawMarker: MERCHANT_CHECKOUT_EVIDENCE_LAW,
    packageName: "@payswap/merchant-checkout",
    journeyId: inputs.journeyId,
    stages,
  });
  return file;
}

/** Re-digest every record of a file (verification twin of the builder). */
export function verifyJourneyEvidenceFile(
  file: MerchantCheckoutJourneyEvidenceFile,
): boolean {
  if (file === null || typeof file !== "object") {
    throw new ValidationError("verifyJourneyEvidenceFile requires an evidence file");
  }
  if (file.lawMarker !== MERCHANT_CHECKOUT_EVIDENCE_LAW) {
    return false;
  }
  if (file.packageName !== "@payswap/merchant-checkout") {
    return false;
  }
  return file.stages.every((record) => record.digest === journeyRecordDigest(record));
}

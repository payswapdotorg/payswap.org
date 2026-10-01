/**
 * Shared deterministic fixtures for @payswap/settlement tests. All shapes are
 * CONSUMED from the canonical packages: @payswap/protocol (netting/obligation
 * derivation, kernel), @payswap/payment (remittance, recurring, off-network),
 * @payswap/connectors (provider state envelopes), @payswap/execution
 * (provider outcome classification). Nothing here redefines vocabulary.
 */
import {
  USD,
  asClearingRecordId,
  asFulfillmentActivityId,
  asNettingSetId,
  asObligationId,
  asPartyId,
  deriveObligations,
  fromMinorUnits,
  netPositions,
  settlementInstructions,
} from "@payswap/protocol";
import type {
  ClearingRecord,
  NettingSet,
  Obligation,
  SettlementInstruction as ProtocolSettlementInstruction,
  TimestampMs,
} from "@payswap/protocol";
import { allocateRemittance, defineMandate } from "@payswap/payment";
import type { DocumentAllocation, RecurringMandate, RemittanceAllocation } from "@payswap/payment";
import { createProviderStateEnvelope } from "@payswap/connectors";
import type {
  ProviderActionRequired,
  ProviderFailureMetadata,
  ProviderStateEnvelope,
  ProviderStateFamily,
} from "@payswap/connectors";
import { defineProofPolicy } from "../src/proof-policies.js";
import type { ProofLevel, ProofPolicy } from "../src/proof-policies.js";
import { deriveSettlementInstruction } from "../src/instructions.js";
import type { SettlementInstruction } from "../src/instructions.js";
import type { ProtocolAuthorizationProof } from "../src/finality.js";

export const PRINCIPAL = Object.freeze({
  principalType: "user",
  principalId: "user_1",
});

export const AGENT = Object.freeze({
  principalType: "agent",
  principalId: "agent_1",
});

export const NOW: TimestampMs = 1_700_000_000_000n;
export const DUE_WINDOW = Object.freeze({ opensAt: NOW, closesAt: NOW + 1_000_000n });

/** A single-activity clearing record: party_a owes party_b 900.00 USD. */
export function makeClearingRecord(): ClearingRecord {
  return {
    id: asClearingRecordId("CR-1"),
    activities: [
      Object.freeze({
        id: asFulfillmentActivityId("FA-1"),
        activityType: "INVOICE_PAYMENT",
        debtor: asPartyId("party_a"),
        creditor: asPartyId("party_b"),
        amount: fromMinorUnits(USD, 90_000n),
        occurredAt: NOW,
      }),
    ],
    netted: false,
  };
}

/** The PENDING obligations derived from the clearing record. */
export function makeObligations(): readonly Obligation[] {
  return deriveObligations([makeClearingRecord()], { dueWindow: DUE_WINDOW });
}

/** The netting set over those obligations. */
export function makeNettingSet(): NettingSet {
  const obligations = makeObligations();
  return {
    id: asNettingSetId("NS-1"),
    obligations: obligations.map((obligation) => asObligationId(obligation.id)),
    window: DUE_WINDOW,
    createdAt: NOW,
  };
}

/** The protocol-derived settlement instructions (exactly one here). */
export function makeProtocolInstructions(): readonly ProtocolSettlementInstruction[] {
  return settlementInstructions(netPositions(makeNettingSet(), makeObligations()));
}

/** The payment-plane remittance allocation for the underlying payment. */
export function makeRemittance(): RemittanceAllocation {
  return allocateRemittance({
    id: "RA-1",
    paymentRef: "PAY-1",
    method: "pm_mobile_money",
    paymentAmount: fromMinorUnits(USD, 90_000n),
    allocations: [
      Object.freeze({
        documentKind: "INVOICE",
        documentId: "doc-100",
        allocatedAmount: fromMinorUnits(USD, 40_000n),
      }),
      Object.freeze({
        documentKind: "ORDER",
        documentId: "doc-200",
        allocatedAmount: fromMinorUnits(USD, 50_000n),
      }),
    ] satisfies readonly DocumentAllocation[],
    remittanceInfo: "invoice doc-100 + order doc-200",
  });
}

/** The settlement instruction derived from the protocol instruction + remittance. */
export function makeSettlementInstruction(): SettlementInstruction {
  const protocolInstruction = makeProtocolInstructions()[0];
  if (protocolInstruction === undefined) {
    throw new Error("fixture setup failed: no protocol settlement instruction derived");
  }
  const remittance = makeRemittance();
  return deriveSettlementInstruction({
    protocolInstruction,
    remittance: remittance.allocations,
    ...(remittance.remittanceInfo !== undefined
      ? { remittanceInfo: remittance.remittanceInfo }
      : {}),
    settlementDestinationId: "dest_bank_1",
    authorizationRefs: ["approval:art-1"],
    issuedAt: NOW,
  });
}

/** The protocol authorization proof: netting set + PENDING obligations. */
export function makeAuthorizationProof(): ProtocolAuthorizationProof {
  return {
    nettingSet: makeNettingSet(),
    obligations: makeObligations(),
  };
}

/** A risk-driven proof policy: baseline P1, >= 500.00 USD → P3, off-network checks → P4. */
export function makeProofPolicy(): ProofPolicy {
  return defineProofPolicy({
    policyId: "pp-settlement-1",
    currency: USD,
    baselineLevel: "P1",
    highRiskThresholdMinorUnits: 50_000n,
    highRiskLevel: "P3",
    railMinimums: { OFF_NETWORK_CHECK: "P4" },
    counterpartyRiskMinimums: { UNVERIFIED: "P3" },
  });
}

/** A lossless provider state envelope (INV-C06 shape), like W3-003 fixtures. */
export function makeEnvelope(overrides?: {
  readonly family?: ProviderStateFamily;
  readonly lifecycleStep?: string;
  readonly isTerminal?: boolean;
  readonly requiresCustomerAction?: boolean;
  readonly state?: unknown;
  readonly failure?: ProviderFailureMetadata;
  readonly actionRequired?: ProviderActionRequired;
  readonly externalId?: string;
  readonly revision?: string;
}): ProviderStateEnvelope {
  const input = overrides ?? {};
  return createProviderStateEnvelope({
    provider: { name: "test-psp", version: "1.0.0" },
    object: { objectType: "payment", externalId: input.externalId ?? "pay_ext_1" },
    revision: input.revision ?? "rev_1",
    state: input.state ?? { providerNativeStatus: "processing", nested: { detail: true } },
    classification: {
      family: input.family ?? "capture",
      lifecycleStep: input.lifecycleStep ?? "pending_capture",
      isTerminal: input.isTerminal ?? false,
      requiresCustomerAction: input.requiresCustomerAction ?? false,
    },
    history: [],
    ...(input.actionRequired !== undefined ? { actionRequired: input.actionRequired } : {}),
    ...(input.failure !== undefined ? { failure: input.failure } : {}),
    privacy: { dataClassification: "PARTNER", constraints: [], shareableFields: ["state"] },
    timestamps: { observedAt: "2026-01-01T00:00:00.000Z" },
    provenance: { source: "PROVIDER_API", fetchId: "fetch_1" },
  });
}

/** An external funds position observation (INV-C09 shape). */
export function makeExternalFundsObservation(overrides?: {
  readonly asOf?: string;
  readonly maxAgeSeconds?: number;
  readonly minorUnits?: string;
  readonly observationId?: string;
  readonly provenanceProvider?: string;
  readonly locationProvider?: string;
  readonly omitProvenance?: boolean;
}): Record<string, unknown> {
  const input = overrides ?? {};
  const observation: Record<string, unknown> = {
    observationKind: "ExternalFundsPositionObservation",
    observationId: input.observationId ?? "obs_1",
    observedAt: "2026-01-01T00:00:00.000Z",
    freshness: {
      asOf: input.asOf ?? "2026-01-01T00:00:00.000Z",
      maxAgeSeconds: input.maxAgeSeconds ?? 60,
    },
    location: {
      providerName: input.locationProvider ?? "test-psp",
      accountRef: "acct_merchant_1",
    },
    observedAmount: { currency: "USD", minorUnits: input.minorUnits ?? "90000" },
  };
  if (!input.omitProvenance) {
    observation.provenance = {
      providerName: input.provenanceProvider ?? "test-psp",
      source: "PROVIDER_API",
      capturedAt: "2026-01-01T00:00:00.000Z",
    };
  }
  return observation;
}

/** A recurring mandate pair for renewal reconciliation. */
export function makeMandates(): {
  readonly previous: RecurringMandate;
  readonly renewed: RecurringMandate;
} {
  const previous = defineMandate({
    id: "MAN-1",
    payer: "payer_1",
    payee: "payee_1",
    method: "pm_mobile_money",
    schedule: { intervalMs: 2_592_000_000n, maxCharges: 12n },
    maxAmountPerCharge: { currency: "USD", value: 10_000n },
    scope: "subscription:basic",
    validFrom: NOW,
    expiresAt: NOW + 31_536_000_000n,
  });
  const renewed = defineMandate({
    id: "MAN-2",
    payer: "payer_1",
    payee: "payee_1",
    method: "pm_mobile_money",
    schedule: { intervalMs: 2_592_000_000n, maxCharges: 12n },
    maxAmountPerCharge: { currency: "USD", value: 10_000n },
    scope: "subscription:basic",
    validFrom: NOW + 31_536_000_000n,
    expiresAt: NOW + 63_072_000_000n,
  });
  return { previous, renewed };
}

/** A claimed level helper for compact evidence construction in tests. */
export function level(claimed: ProofLevel): ProofLevel {
  return claimed;
}

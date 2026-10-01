/**
 * Journey 12 — provider external-funds position observation (W1-007).
 *
 * Freshness/provenance-checked, never custody (INV-C09), reconciled with
 * canonical state without lossy mapping. The observation is produced by the
 * REAL Ethereum JSON-RPC rail adapter (`@payswap/rails`), exercised offline
 * through an injected deterministic transport — no network (live endpoints
 * are NOT part of this suite). The settled canonical amount is reconciled
 * against the observed external position; a settlement reconciliation case
 * (EXTERNAL_FUNDS_OBSERVATION) is opened and RESOLVED, then referenced by
 * the settlement certificate; nothing about the observed balance is ever
 * booked as PaySwap custody.
 */

import {
  accountId,
  currencyCode,
  fromMinorUnits,
  registerCurrency,
} from "@payswap/protocol";
import type { AccountId, Money, TimestampMs } from "@payswap/protocol";
import type { JsonRpcResponse, JsonRpcTransport } from "@payswap/rails";
import { EthereumRailClient } from "@payswap/rails";
import { isFreshAt, validateExternalFundsPositionObservation } from "@payswap/connectors";
import type { ExternalFundsPositionObservation } from "@payswap/connectors";
import { reconcileExternalFundsObservation } from "@payswap/settlement";
import type { ExternalFundsReconciliationResult } from "@payswap/settlement";
import {
  JOURNEY_PRINCIPAL,
  assembleJourneyOutcome,
  buildWorld,
  checkAccountingReconciles,
  checkApprovalsAndProofs,
  checkEvidencedChain,
  checkFeesFxIncentivesExact,
  checkLosslessStateReconciliation,
  clearingRecord,
  postEntry,
  providerEnvelope,
  registerRailFixture,
  runSettlementChain,
} from "../harness.js";
import type {
  AxisAssertion,
  InvariantProof,
  JourneyOutcome,
  SettlementChainOutcome,
} from "../harness.js";

export interface ExternalFundsJourneyDetails {
  readonly observationId: string;
  readonly observedCurrency: string;
  readonly observedMinorUnits: string;
  readonly maxAgeSeconds: number;
  readonly provenanceSource: string;
  readonly freshAtReferenceTime: boolean;
  readonly reconciliationOutcome: string;
  readonly custodyBooking: string;
  readonly staleOutcome: string;
  readonly discrepancyOutcome: string;
  readonly caseStatus: string;
  readonly certificateReconciliationRefs: readonly string[];
  readonly externalAddressNeverBooked: boolean;
  readonly chain: SettlementChainOutcome;
}

export interface ExternalFundsJourneyOutcome {
  readonly journey: JourneyOutcome;
  readonly details: ExternalFundsJourneyDetails;
}

const PAYER_POSITION: AccountId = accountId("ASSET", "position.payer.eth");
const MERCHANT_POSITION: AccountId = accountId("ASSET", "position.merchant.eth");
const MERCHANT_ADDRESS = "0x0000000000000000000000000000000000000102";
const ONE_ETH = 1_000_000_000_000_000_000n;
const HEAD_BLOCK = 20_000n;
const BLOCK_TIMESTAMP_SECONDS = 1_765_000_000n;

/** Run the external-funds observation journey deterministically (offline). */
export async function runExternalFundsJourney(): Promise<ExternalFundsJourneyOutcome> {
  // ETH minor units are tracked as exact integers (wei); the registry caps
  // declared display digits at 8, which does not affect exact integer values.
  registerCurrency("ETH", 8);
  const ETH = currencyCode("ETH");
  const world = buildWorld({
    openingBalances: [{ account: PAYER_POSITION, amount: fromMinorUnits(ETH, 2n * ONE_ETH) }],
  });
  const now: TimestampMs = world.clock.now();

  registerRailFixture(world, {
    providerName: "psp-onchain-bridge",
    capabilityId: "cap.onchain.bridge_payout",
    currencies: ["ETH"],
  });

  // ---- The REAL Ethereum rail adapter with an injected deterministic
  // transport: eth_getBalance + eth_getBlockByNumber only. No network.
  const transport: JsonRpcTransport = async (method) => {
    const ok = (result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id: 1, result });
    switch (method) {
      case "eth_getBalance":
        return ok(`0x${ONE_ETH.toString(16)}`);
      case "eth_getBlockByNumber":
        return ok({
          number: `0x${HEAD_BLOCK.toString(16)}`,
          timestamp: `0x${BLOCK_TIMESTAMP_SECONDS.toString(16)}`,
        });
      default:
        return {
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32601, message: `method not scripted: ${method}` },
        };
    }
  };
  const client = new EthereumRailClient({ clock: world.clock, transport });
  const referenceTime = new Date(Number(BLOCK_TIMESTAMP_SECONDS) * 1000).toISOString();

  // ---- Observe the external funds position: freshness + provenance, never custody.
  const observation: ExternalFundsPositionObservation =
    await client.observeExternalFundsPosition(MERCHANT_ADDRESS);
  validateExternalFundsPositionObservation(observation);
  const fresh = isFreshAt(observation, referenceTime);

  // ---- The canonical settlement: 1 ETH payer -> on-chain merchant.
  const amount = fromMinorUnits(ETH, ONE_ETH);
  const chain = runSettlementChain({
    world,
    sequence: "externalfunds",
    clearingRecords: [
      clearingRecord("CR:extfunds:1", [
        {
          id: "FA:extfunds:1",
          activityType: "ONCHAIN_PAYMENT",
          debtor: "user:payer-onchain",
          creditor: "merchant:onchain-1",
          amount,
          occurredAt: now,
        },
      ], world),
    ],
    dueWindow: { opensAt: now, closesAt: now + 1_000_000n },
    authorizationRefs: ["approval:extfunds:1", "grant:extfunds:execution"],
    instructions: [
      { settlementDestinationId: `onchain:${MERCHANT_ADDRESS}`, rail: "ETHEREUM_JSON_RPC", providerName: "psp-onchain-bridge" },
    ],
  });

  // ---- Reconciliation with canonical state — lossless, observation-only.
  const reconciled: ExternalFundsReconciliationResult = reconcileExternalFundsObservation({
    observation,
    expectedMinorUnits: ONE_ETH.toString(),
    referenceTime,
  });
  const stale: ExternalFundsReconciliationResult = reconcileExternalFundsObservation({
    observation,
    expectedMinorUnits: ONE_ETH.toString(),
    referenceTime: new Date((Number(BLOCK_TIMESTAMP_SECONDS) + 10_000) * 1000).toISOString(),
  });
  const discrepancy: ExternalFundsReconciliationResult = reconcileExternalFundsObservation({
    observation,
    expectedMinorUnits: (ONE_ETH + 1n).toString(),
    referenceTime,
  });

  // ---- A settlement reconciliation case for the observation, RESOLVED and
  // referenced by the certificate.
  const observationEvidence = world.evidence.record({
    nodeId: "extfunds:observation-evidence",
    kind: "OUTCOME",
    actionRef: "sa:externalfunds:0",
    claimedLevel: "P2",
    provenance: { source: "AUTHENTICATED_PROVIDER", providerName: "psp-onchain-bridge" },
    payload: `external-funds:${observation.location.accountRef}:${observation.observedAmount.minorUnits}`,
    links: [],
    recordedAt: world.clock.now(),
  });
  const observationCase = world.reconciliation.openCase({
    caseId: "case:extfunds:1",
    subject: { kind: "EXTERNAL_FUNDS_OBSERVATION", observationId: observation.observationId },
    reason: "EXTERNAL_FUNDS_DISCREPANCY",
    now: world.clock.now(),
  });
  world.reconciliation.resolveCase({
    caseId: observationCase.caseId,
    outcome: reconciled.outcome === "MATCHED" ? "MATCHED" : "DISCREPANCY_RECORDED",
    resolvedBy: JOURNEY_PRINCIPAL,
    evidenceIds: [observationEvidence.nodeId],
    now: world.clock.now(),
    note: "observed external position matched the canonical settlement amount",
  });
  const resolvedObservationCase = world.reconciliation.case(observationCase.caseId);

  // Re-issue the certificate so it references the RESOLVED observation case.
  const settlement = chain.settlements[0];
  if (settlement === undefined) {
    throw new Error("external-funds journey: no settlement produced");
  }
  const certifiedWithCase = world.certificates.issue({
    certificateId: "cert:externalfunds:observed",
    finalityId: settlement.finality.finalityId,
    instruction: settlement.instruction,
    evidenceChain: [...settlement.certificate.evidenceChain, observationEvidence.nodeId],
    reconciliationRefs: [observationCase.caseId],
    now: world.clock.now(),
  });

  // ---- Accounting: protocol-side obligation discharge booking only. The
  // observed external balance is NEVER booked as an account balance.
  postEntry(
    world,
    [
      { accountId: PAYER_POSITION, amount: fromMinorUnits(ETH, -ONE_ETH) },
      { accountId: MERCHANT_POSITION, amount: fromMinorUnits(ETH, ONE_ETH) },
    ],
    "on-chain settlement discharge (protocol-side record; external funds are an observation, never custody)",
    "extfunds:settlement",
  );

  const envelope = providerEnvelope(
    {
      providerName: "psp-onchain-bridge",
      externalId: "onchain_payout_1",
      revision: "rev_1",
      family: "payout",
      lifecycleStep: "observed",
      isTerminal: true,
      requiresCustomerAction: false,
      state: {
        providerNativeStatus: "observed_onchain",
        observationId: observation.observationId,
        externalAddress: MERCHANT_ADDRESS,
      },
    },
    world,
  );
  const bookedAccounts = new Set<string>();
  for (const entry of world.journal.entries) {
    for (const line of entry.lines) {
      bookedAccounts.add(line.accountId);
    }
  }
  const externalAddressNeverBooked = ![...bookedAccounts].some((account) =>
    account.includes(MERCHANT_ADDRESS),
  );

  const assertions: readonly AxisAssertion[] = [
    checkEvidencedChain(world, chain),
    checkAccountingReconciles(world, [
      { account: PAYER_POSITION, amount: fromMinorUnits(ETH, ONE_ETH) },
      { account: MERCHANT_POSITION, amount: fromMinorUnits(ETH, ONE_ETH) },
    ]),
    checkFeesFxIncentivesExact([
      { label: "canonical settlement equals 1 ETH exactly", expected: amount, actual: chain.settlements[0]?.instruction.amount ?? fromMinorUnits(ETH, 0n) },
      { label: "observed external amount equals canonical amount (string-exact)", expected: fromMinorUnits(ETH, ONE_ETH), actual: fromMinorUnits(ETH, BigInt(observation.observedAmount.minorUnits)) },
    ]),
    checkApprovalsAndProofs({
      authorizationEvidenceRefs: ["approval:extfunds:1", "grant:extfunds:execution"],
      finalities: chain.settlements.map((s) => s.finality),
      evidenceLineageHasAuthorization: world.evidence
        .lineageForAction(chain.settlements[0]?.instruction.id ?? "")
        .authorization.length > 0,
    }),
    checkLosslessStateReconciliation(world, {
      envelopes: [envelope],
      canonicalMatches: [
        {
          description: `observation reconciled with canonical state as ${reconciled.outcome} with custodyBooking ${reconciled.custodyBooking} (INV-C09 — never custody)`,
          ok: reconciled.outcome === "MATCHED" && reconciled.custodyBooking === "NONE",
        },
        {
          description: "a stale observation is NOT usable for reconciliation (freshness enforced)",
          ok: stale.outcome === "STALE_NOT_USABLE" && stale.custodyBooking === "NONE",
        },
        {
          description: "an amount mismatch is recorded as a DISCREPANCY, never silently corrected",
          ok: discrepancy.outcome === "DISCREPANCY" && discrepancy.custodyBooking === "NONE",
        },
        {
          description: "the observation case is RESOLVED and referenced by the settlement certificate",
          ok:
            (resolvedObservationCase?.status ?? "OPEN") === "RESOLVED" &&
            certifiedWithCase.reconciliationRefs.includes(observationCase.caseId),
        },
        {
          description: "the external address is never a journal account (no custody booking)",
          ok: externalAddressNeverBooked,
        },
        {
          description: "canonical settlement state SETTLED matches the observed external position",
          ok: chain.obligations.every((o) => world.obligations.get(o.id)?.state === "SETTLED"),
        },
      ],
      evidenceLinked: certifiedWithCase.evidenceChain.length === 4,
    }),
  ];

  const invariants: readonly InvariantProof[] = [
    { id: "INV-C09", proof: `the ExternalFundsPositionObservation (${observation.observedAmount.minorUnits} wei at ${observation.location.accountRef}) reconciled as ${reconciled.outcome} with custodyBooking ${reconciled.custodyBooking} — an observation of external state, never PaySwap custody` },
    { id: "INV-C06", proof: "the on-chain payout provider state carries the observation id and external address verbatim" },
    { id: "INV-F01", proof: "the canonical 1 ETH amount and the observed minor units are exact integers with no lossy mapping" },
    { id: "INV-F03", proof: "the protocol-side discharge entry balances; the ETH trial balance sums to zero" },
    { id: "INV-X03", proof: `the observation discrepancy case ${observationCase.caseId} was resolved by reconciliation evidence, then referenced by the certificate` },
    { id: "INV-F06", proof: "finality declared by the protocol for the on-chain settlement" },
  ];

  const journey = assembleJourneyOutcome(
    "external-funds",
    "External-funds position observation",
    invariants,
    assertions,
    [...chain.evidenceNodeIds, observationEvidence.nodeId],
  );
  return {
    journey,
    details: {
      observationId: observation.observationId,
      observedCurrency: observation.observedAmount.currency,
      observedMinorUnits: observation.observedAmount.minorUnits,
      maxAgeSeconds: observation.freshness.maxAgeSeconds,
      provenanceSource: observation.provenance.source,
      freshAtReferenceTime: fresh,
      reconciliationOutcome: reconciled.outcome,
      custodyBooking: reconciled.custodyBooking,
      staleOutcome: stale.outcome,
      discrepancyOutcome: discrepancy.outcome,
      caseStatus: resolvedObservationCase?.status ?? observationCase.status,
      certificateReconciliationRefs: certifiedWithCase.reconciliationRefs,
      externalAddressNeverBooked,
      chain,
    },
  };
}

export const externalFundsJourney = {
  journeyId: "external-funds",
  title: "External-funds position observation",
  description:
    "provider external-funds position observation: freshness/provenance-checked, never custody (INV-C09), reconciled with canonical state without lossy mapping",
  run: (): Promise<JourneyOutcome> =>
    runExternalFundsJourney().then((outcome) => outcome.journey),
} as const;

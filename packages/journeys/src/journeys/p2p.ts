/**
 * Journey 1 — P2P transfer (W1-007).
 *
 * obligation -> reservation -> clearing -> settlement -> finality, fully
 * evidenced; accounting reconciles to zero. Composes the trust plane (mandate,
 * attenuated child grant, signed approval artifact, epoch check), the agents
 * plane (an advisory money-movement proposal that structurally cannot be a
 * protocol command), the protocol kernel (journal, atomic reservations,
 * obligation derivation, netting with gross preservation) and the
 * execution/settlement planes.
 */

import {
  USD,
  asCommandId,
  fromMinorUnits,
  accountId,
  activateReservation,
  availableFunds,
  captureReservation,
  projectBalances,
  reserve,
} from "@payswap/protocol";
import type { AccountId, Money, Reservation } from "@payswap/protocol";
import {
  EpochLedger,
  attenuateGrant,
  checkEpoch,
  evaluate,
  issueGrant,
  verifyApprovalArtifact,
} from "@payswap/trust";
import type {
  Mandate,
  PermissionGrant,
  Principal,
  SignedApprovalArtifact,
} from "@payswap/trust";
import { makeProposal, possess } from "@payswap/agents";
import { asMerchantSettlementDestinationId } from "@payswap/payment";
import { defineExecutionPlan } from "@payswap/execution";
import type { ExecutionPlan } from "@payswap/execution";
import {
  JOURNEY_EPOCH,
  JOURNEY_PRINCIPAL,
} from "../harness.js";
import type {
  AxisAssertion,
  InvariantProof,
  JourneyOutcome,
  JourneyWorld,
  SettlementChainOutcome,
} from "../harness.js";
import {
  assembleJourneyOutcome,
  buildWorld,
  checkAccountingReconciles,
  checkApprovalsAndProofs,
  checkEvidencedChain,
  checkFeesFxIncentivesExact,
  checkLosslessStateReconciliation,
  clearingRecord,
  executionEvidenceDraft,
  journeyCommand,
  party,
  postEntry,
  providerEnvelope,
  registerRailFixture,
  runSettlementChain,
} from "../harness.js";
export interface P2PJourneyDetails {
  readonly grossActivities: number;
  readonly netObligationMinorUnits: bigint;
  readonly feeMinorUnits: bigint;
  readonly aliceBalanceAfter: Money;
  readonly bobBalanceAfter: Money;
  readonly mandateAllowed: boolean;
  readonly childGrantAllowed: boolean;
  readonly wideningRejected: boolean;
  readonly approvalArtifactValid: boolean;
  readonly tamperedApprovalRejected: boolean;
  readonly epochCheckPassed: boolean;
  readonly raisedEpochDenies: boolean;
  readonly staleEpochDenies: boolean;
  readonly proposalIsAdvisory: boolean;
  readonly overReservationRejected: boolean;
  readonly reservationCaptured: boolean;
  readonly chain: SettlementChainOutcome;
  readonly plan: ExecutionPlan;
}

export interface P2PJourneyOutcome {
  readonly journey: JourneyOutcome;
  readonly details: P2PJourneyDetails;
}

const ALICE_WALLET: AccountId = accountId("ASSET", "wallet.alice");
const BOB_WALLET: AccountId = accountId("ASSET", "wallet.bob");
const FEE_INCOME: AccountId = accountId("INCOME", "fees.p2p");

/** Run the P2P transfer journey deterministically. */
export function runP2PJourney(): P2PJourneyOutcome {
  const world = buildWorld({
    openingBalances: [{ account: ALICE_WALLET, amount: fromMinorUnits(USD, 100_000n) }],
  });
  const now = Number(world.clock.now());

  // ---- Trust plane: user mandate -> grant -> ALLOW, attenuated child grant.
  const alicePrincipal: Principal = {
    kind: "user",
    id: "alice",
    securityEpoch: 0n,
  };
  const mandate: Mandate = {
    id: "mandate:p2p-alice",
    version: 1,
    grantor: "user:alice",
    grantee: "user:alice",
    actions: ["payments.initiate", "payments.status.read"],
    resources: [{ type: "payment_intent" }],
    limits: {
      perTransactionAmount: { currency: "USD", minorUnits: "10000" },
    },
    expiresAt: now + 86_400_000,
    proofRequirements: [],
  };
  const payerAgentPrincipal: Principal = {
    kind: "agent",
    agentKeyFingerprint: "agent-key-p2p",
    ownerRef: "user:alice",
    bodyRef: "body:payer@1",
    packageVersionRef: "pkg:payer@1",
    authorityEnvelope: [{ mandateId: mandate.id, version: mandate.version }],
    securityEpoch: 0n,
  };
  const grant = issueGrant(mandate, { grantId: "grant:p2p-alice", issuedAt: now - 1_000 });
  const requestHash = "reqhash:p2p:transfer-1";
  const decision = evaluate(
    {
      principal: alicePrincipal,
      action: "payments.initiate",
      resource: { type: "payment_intent", resourceId: "pi:p2p-1" },
      context: { amount: { currency: "USD", minorUnits: "7000" } },
      requestHash,
      requestedAt: now,
    },
    [grant],
    { ledger: new EpochLedger() },
  );
  const mandateAllowed = decision.decision === "ALLOW";

  // INV-A01: child authority is attenuated — narrowing is allowed, widening is not.
  const childGrant: PermissionGrant = attenuateGrant(
    grant,
    {
      mandateId: "mandate:p2p-alice-child",
      version: 1,
      grantee: "agent:agent-key-p2p",
      actions: ["payments.status.read"],
      expiresAt: now + 43_200_000,
    },
    { grantId: "grant:p2p-alice-child", issuedAt: now },
  );
  let wideningRejected = false;
  try {
    attenuateGrant(
      grant,
      {
        mandateId: "mandate:p2p-alice-wide",
        version: 1,
        grantee: "agent:agent-key-p2p",
        actions: ["payments.*"],
        expiresAt: now + 172_800_000,
      },
      { grantId: "grant:p2p-alice-wide", issuedAt: now },
    );
  } catch {
    wideningRejected = true;
  }

  // INV-A03: a signed approval artifact that identifies principal, agent,
  // scope, expiry and request hash verifies; a tampered hash is rejected.
  const artifact: SignedApprovalArtifact = {
    principal: "user:alice",
    agentRef: "agent:agent-key-p2p",
    scope: {
      actions: ["payments.initiate"],
      resources: [{ type: "payment_intent", resourceId: "pi:p2p-1" }],
      maxAmount: { currency: "USD", minorUnits: "7000" },
    },
    expiry: now + 3_600_000,
    requestHash,
    signature: "sig:p2p:approval-1",
    issuedAt: now,
  };
  const approvalVerification = verifyApprovalArtifact(
    artifact,
    {
      principal: payerAgentPrincipal,
      action: "payments.initiate",
      resource: { type: "payment_intent", resourceId: "pi:p2p-1" },
      context: { amount: { currency: "USD", minorUnits: "7000" } },
      requestHash,
      requestedAt: now,
    },
    now,
  );
  const approvalArtifactValid = approvalVerification.valid;
  const tamperedVerification = verifyApprovalArtifact(
    { ...artifact, requestHash: "reqhash:p2p:tampered" },
    {
      principal: alicePrincipal,
      action: "payments.initiate",
      resource: { type: "payment_intent", resourceId: "pi:p2p-1" },
      context: { amount: { currency: "USD", minorUnits: "7000" } },
      requestHash,
      requestedAt: now,
    },
    now,
  );
  const tamperedApprovalRejected = !tamperedVerification.valid;

  // INV-A02/S02 (trust plane): a credential at the current epoch authorizes;
  // a RAISED epoch immediately denies the stale credential.
  const epochLedger = new EpochLedger();
  let epochCheckPassed = true;
  try {
    checkEpoch(alicePrincipal, epochLedger);
  } catch {
    epochCheckPassed = false;
  }
  const raisedEpoch = epochLedger.raiseEpoch("user:alice", "credential rotation after suspected compromise", now + 1);
  let raisedEpochDenies = false;
  try {
    checkEpoch({ ...alicePrincipal, securityEpoch: 0n }, epochLedger);
  } catch {
    raisedEpochDenies = true;
  }
  const staleDecision = evaluate(
    {
      principal: { ...alicePrincipal, securityEpoch: 0n },
      action: "payments.initiate",
      resource: { type: "payment_intent", resourceId: "pi:p2p-1" },
      context: { amount: { currency: "USD", minorUnits: "7000" } },
      requestHash,
      requestedAt: now + 2,
    },
    [grant],
    { ledger: epochLedger },
  );
  const staleEpochDenies = staleDecision.decision === "DENY" && staleDecision.reason === "stale_security_epoch";

  // ---- Agents plane: an advisory proposal (INV-G03 — structurally not a command).
  const body = {
    id: "body:payer@1",
    version: 1,
    declaredInterfaces: {
      inputs: [{ name: "intent", artifactType: "Intent" }],
      outputs: [{ name: "proposal", artifactType: "Execution" }],
    },
    capabilityDescriptors: [{ name: "route-selection", summary: "Proposes P2P transfers" }],
    constraints: [{ kind: "safety" as const, description: "Proposals never carry protocol authority" }],
  };
  const agentInstance = possess(
    body,
    { provider: "openai", modelId: "gpt-5.1", bindingVersion: 1 },
    {
      instanceId: "instance-p2p-payer",
      principal: { agentKeyFingerprint: "agent-key-p2p", ownerRef: "user:alice" },
    },
  );
  const proposal = makeProposal({
    proposalId: "proposal:p2p-1",
    proposingInstance: agentInstance.id,
    proposalType: "money_movement",
    payload: { corridor: "p2p:usd", amountMinorUnits: "7000" },
    rationale: "net transfer after reciprocal flows",
    evidenceRefs: ["quote:p2p:transfer-1"],
    expiresAt: now + 60_000,
  });
  const proposalIsAdvisory =
    proposal.proposalType === "money_movement" &&
    !("idempotencyKey" in proposal.payload) &&
    !("authorization" in proposal.payload);

  // ---- Protocol kernel: atomic reservation on the sender wallet (INV-F04).
  const hold: Reservation = reserve(world.reservationState, {
    accountId: ALICE_WALLET,
    amount: fromMinorUnits(USD, 10_000n),
    refs: { correlationId: "p2p:reservation-1" },
  });
  activateReservation(world.reservationState, hold.id);
  let overReservationRejected = false;
  try {
    reserve(world.reservationState, {
      accountId: ALICE_WALLET,
      amount: fromMinorUnits(USD, 500_000n),
      refs: { correlationId: "p2p:reservation-over" },
    });
  } catch {
    overReservationRejected = true;
  }
  captureReservation(world.reservationState, hold.id);
  const reservationCaptured =
    world.reservationState.reservations.get(hold.id)?.state === "CAPTURED" &&
    availableFunds(world.reservationState, ALICE_WALLET).available.value === 100_000n;

  // ---- Execution plane: a composed plan through a real connected instance.
  const rail = registerRailFixture(world, {
    providerName: "psp-protocol-internal",
    capabilityId: "cap.p2p.transfer",
  });
  const command = journeyCommand(world, "execution.executePlan", "idem:p2p:plan", {
    planId: "plan:p2p:1",
  });
  const scopedGrant = world.grants.issue({
    grantId: "grant:p2p:execution",
    command,
    scope: {
      capabilityInstanceIds: [rail.instance.instanceId],
      executionModes: ["COMPOSED_PAYSWAP"],
    },
    requestHash,
    expiresAt: world.clock.now() + 3_600_000n,
    authorizationEvidenceRef: `approval:${artifact.signature}`,
  });
  const grantVerification = world.grants.verify("grant:p2p:execution", {
    now: world.clock.now(),
    requestHash,
    capabilityInstanceId: rail.instance.instanceId,
    executionMode: "COMPOSED_PAYSWAP",
  });
  const plan: ExecutionPlan = defineExecutionPlan({
    planId: "plan:p2p:1",
    executionMode: "COMPOSED_PAYSWAP",
    modeDetail: { kind: "COMPOSED_PAYSWAP", composedWith: ["cap.p2p.transfer"] },
    steps: [
      {
        stepId: "step:p2p:transfer",
        order: 1,
        role: "transfer",
        capability: rail.definition,
        instance: rail.instance,
        providerRequest: { amountMinorUnits: "7000", currency: "USD" },
      },
    ],
    settlementDestination: {
      id: asMerchantSettlementDestinationId("dest:p2p:bob"),
      kind: "BANK_ACCOUNT",
      currency: USD,
      externalRef: "bank://bob",
      provenance: { source: "journey", reference: "p2p-1", recordedAt: JOURNEY_EPOCH },
    },
    remittance: [],
    protocolAuthorization: {
      commandId: asCommandId(command.id),
      principal: JOURNEY_PRINCIPAL,
      authorizationEvidenceRef: `approval:${artifact.signature}`,
    },
    executionGrantId: scopedGrant.grantId,
  });
  const envelope = providerEnvelope(
    {
      providerName: "psp-protocol-internal",
      externalId: "pi_p2p_1",
      revision: "rev_1",
      family: "payout",
      lifecycleStep: "settled",
      isTerminal: true,
      requiresCustomerAction: false,
      state: { providerNativeStatus: "succeeded", transferId: "tr_p2p_1" },
    },
    world,
  );
  const begin = world.attempts.begin({
    attemptId: "xatt:p2p:1",
    planId: plan.planId,
    stepId: "step:p2p:transfer",
    executionMode: "COMPOSED_PAYSWAP",
    capabilityInstanceId: rail.instance.instanceId,
    capabilityId: rail.definition.capabilityId,
    retryPolicy: rail.definition.idempotency.retryPolicy,
    cancellation: rail.definition.compensation.cancellation,
    compensation: rail.definition.compensation,
    idempotencyKey: "idem:p2p:attempt",
    principal: JOURNEY_PRINCIPAL,
    now: world.clock.now(),
  });
  if (begin.kind !== "BEGIN") {
    throw new Error("p2p journey: execution attempt was a replay");
  }
  world.attempts.advance("xatt:p2p:1", "START", { now: world.clock.now() });
  world.attempts.advance("xatt:p2p:1", "CONFIRM_SUCCEEDED", {
    now: world.clock.now(),
    evidence: [executionEvidenceDraft("p2p", 1, envelope, world)],
  });

  // ---- Clearing -> obligations -> netting -> settlement -> finality.
  const dueWindow = { opensAt: world.clock.now(), closesAt: world.clock.now() + 1_000_000n };
  const chain = runSettlementChain({
    world,
    sequence: "p2p",
    clearingRecords: [
      clearingRecord("CR:p2p:1", [
        {
          id: "FA:p2p:a2b",
          activityType: "P2P_TRANSFER",
          debtor: "user:alice",
          creditor: "user:bob",
          amount: fromMinorUnits(USD, 10_000n),
          occurredAt: world.clock.now(),
        },
      ], world),
      clearingRecord("CR:p2p:2", [
        {
          id: "FA:p2p:b2a",
          activityType: "P2P_TRANSFER",
          debtor: "user:bob",
          creditor: "user:alice",
          amount: fromMinorUnits(USD, 3_000n),
          occurredAt: world.clock.now(),
        },
      ], world),
    ],
    dueWindow,
    authorizationRefs: [`approval:${artifact.signature}`, "grant:p2p:execution"],
    instructions: [
      {
        settlementDestinationId: "dest:p2p:bob",
        rail: "PROTOCOL_INTERNAL",
        providerName: "psp-protocol-internal",
      },
    ],
  });

  // ---- Accounting: settlement movement + exact P2P fee (INV-F01/F03).
  const net = chain.positions[0]?.netAmount ?? fromMinorUnits(USD, 0n);
  postEntry(
    world,
    [
      { accountId: ALICE_WALLET, amount: fromMinorUnits(USD, -net.value) },
      { accountId: BOB_WALLET, amount: net },
    ],
    "p2p net settlement movement",
    "p2p:settlement",
  );
  const fee = fromMinorUnits(USD, 50n);
  postEntry(
    world,
    [
      { accountId: ALICE_WALLET, amount: fromMinorUnits(USD, -50n) },
      { accountId: FEE_INCOME, amount: fee },
    ],
    "p2p transfer fee",
    "p2p:fee",
  );

  // ---- Acceptance axes.
  const aliceBalanceAfter = balanceOf(world, ALICE_WALLET);
  const bobBalanceAfter = balanceOf(world, BOB_WALLET);
  const assertions: readonly AxisAssertion[] = [
    checkEvidencedChain(world, chain),
    checkAccountingReconciles(world, [
      { account: ALICE_WALLET, amount: fromMinorUnits(USD, 92_950n) },
      { account: BOB_WALLET, amount: fromMinorUnits(USD, 7_000n) },
      { account: FEE_INCOME, amount: fee },
    ]),
    checkFeesFxIncentivesExact([
      { label: "P2P fee", expected: fromMinorUnits(USD, 50n), actual: fee },
      { label: "net obligation", expected: fromMinorUnits(USD, 7_000n), actual: net },
    ]),
    checkApprovalsAndProofs({
      authorizationEvidenceRefs: [`approval:${artifact.signature}`, "grant:p2p:execution"],
      grantVerified: { grantId: "grant:p2p:execution", ok: grantVerification.ok },
      approvalArtifactValid: { artifactRef: artifact.signature, valid: approvalArtifactValid && tamperedApprovalRejected },
      securityEpochValid: { authorizationRef: "credential:user:alice", valid: epochCheckPassed && raisedEpochDenies && staleEpochDenies },
      finalities: chain.settlements.map((s) => s.finality),
      evidenceLineageHasAuthorization: world.evidence
        .lineageForAction(chain.settlements[0]?.instruction.id ?? "")
        .authorization.every((node) => node.kind === "AUTHORIZATION"),
    }),
    checkLosslessStateReconciliation(world, {
      envelopes: [envelope],
      canonicalMatches: chain.obligations.map((obligation) => ({
        description: `provider evidence 'succeeded' reconciles with canonical obligation state ${world.obligations.get(obligation.id)?.state ?? "MISSING"} for ${obligation.id}`,
        ok: world.obligations.get(obligation.id)?.state === "SETTLED",
      })),
      evidenceLinked: chain.settlements.every((s) => s.certificate.evidenceChain.length === 3),
    }),
  ];

  const invariants: readonly InvariantProof[] = [
    { id: "INV-F01", proof: "all money is exact bigint minor units; the 70.00 USD net and 0.50 USD fee reconcile exactly" },
    { id: "INV-F03", proof: `every one of the ${world.journal.entries.length} journal entries balances and the USD trial balance sums to zero` },
    { id: "INV-F04", proof: `the 100.00 USD reservation could not exceed available funds (over-reservation rejected: ${overReservationRejected})` },
    { id: "INV-F07", proof: `netting kept both gross snapshots and derived the single 70.00 USD net obligation` },
    { id: "INV-A01", proof: `child grant narrowed actions and expiry; widening threw AttenuationViolationError (${wideningRejected})` },
    { id: "INV-A03", proof: `the signed approval artifact verified; the tampered request hash was rejected (${tamperedApprovalRejected})` },
    { id: "INV-S02", proof: `the credential passed the current epoch check; after epoch ${raisedEpoch.value} was raised, the stale credential was denied (${raisedEpochDenies}) and evaluate() denied with stale_security_epoch (${staleEpochDenies})` },
    { id: "INV-G03", proof: `the agent's money_movement proposal is advisory and structurally carries no protocol command fields` },
    { id: "INV-E01", proof: `authorization evidence exists for every consequential action (approval artifact + scoped grant refs)` },
    { id: "INV-E02", proof: `the CONFIRM_SUCCEEDED transition attached provider execution evidence with a lossless envelope` },
    { id: "INV-E03", proof: `finality was declared only with the policy-required proof level achieved` },
    { id: "INV-F06", proof: "finality was declared by the protocol FinalityAuthority against the protocol-derived instruction" },
    { id: "INV-C06", proof: "the provider state envelope round-trips losslessly and is preserved verbatim" },
  ];

  const journey = assembleJourneyOutcome(
    "p2p",
    "P2P transfer",
    invariants,
    assertions,
    chain.evidenceNodeIds,
  );
  return {
    journey,
    details: {
      grossActivities: 2,
      netObligationMinorUnits: net.value,
      feeMinorUnits: fee.value,
      aliceBalanceAfter,
      bobBalanceAfter,
      mandateAllowed,
      childGrantAllowed: childGrant.grantId === "grant:p2p-alice-child",
      wideningRejected,
      approvalArtifactValid,
      tamperedApprovalRejected,
      epochCheckPassed,
      raisedEpochDenies,
      staleEpochDenies,
      proposalIsAdvisory,
      overReservationRejected,
      reservationCaptured,
      chain,
      plan,
    },
  };
}

function balanceOf(world: JourneyWorld, account: AccountId): Money {
  return projectBalances(world.journal, account).get(account) ?? fromMinorUnits(USD, 0n);
}

export const p2pJourney = {
  journeyId: "p2p",
  title: "P2P transfer",
  description:
    "obligation -> reservation -> clearing -> settlement -> finality, fully evidenced; accounting reconciles to zero",
  run: (): JourneyOutcome => runP2PJourney().journey,
} as const;

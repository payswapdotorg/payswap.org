/**
 * Journey A — Simple wallet payment (§35).
 *
 * User: "Pay $20."
 * PaySwap: selects eligible route → security analysis → wallet
 * authorization (explicit signing at the trusted surface) → blockchain
 * handoff → finality → receipt.
 *
 * Real composition:
 * - the W4-001 route compiler selects the eligible route (the
 *   onchain-direct-transfer shape over a same-chain ONCHAIN_WALLET →
 *   ONCHAIN_RECIPIENT intent) with its kernel-prepared leg;
 * - the W1-002 kernel pipeline walks the SAME write (bound by writeDigest
 *   equality — asserted, never assumed): simulate → gates → diff →
 *   authorization request → explicit signing at the injected trusted
 *   surface → pre-broadcast recheck → broadcast handoff at the injected
 *   signer adapter;
 * - the submission seam records the BroadcastHandoffReceipt; the W4-001
 *   walk observes the chain outcome with a finality CANDIDATE (rule 29:
 *   submitted ≠ final) and produces the route-journey evidence receipt.
 */

import type { MoneyMovementIntent } from "@payswap/route-compiler";
import {
  walkRoutePlan,
  buildRouteJourneyEvidence,
  routeJourneyEvidenceDigest,
} from "@payswap/route-compiler";
import { canonicalAssetRef } from "@payswap/onchain-domain";
import { OnchainWritePipeline } from "@payswap/onchain-security";
import {
  assertionFromChecks,
  assembleJourneyOutcome,
  journeyRequires,
  requirePresent,
  stage,
  type ProductionJourney,
} from "../contract.js";
import {
  CERT_EPOCH_ISO,
  CERT_FINALITY_MODES,
  CERT_NOW,
  CERT_SIGNER_ADAPTER,
  CERT_SERVICE_PRINCIPAL,
  CHAIN,
  CUSTOMER_APPROVER_REF,
  CUSTOMER_WALLET,
  PAYEE,
  USC_ASSET,
  certApprovalSurface,
  certSecurityPolicy,
  certSecurityState,
  compileCertRoute,
  recheckObservationFor,
  requestFromPrepared,
  submitAtTrustedSurface,
  transferSimulation,
} from "../world.js";

/** "Pay $20" — $20.00 in the USC stablecoin fixture (6 decimals). */
export const JOURNEY_A_AMOUNT_MINOR = "20000000" as const;

function payTwentyIntent(): MoneyMovementIntent {
  return {
    intentId: "intent:cert:a:pay-20",
    principalRef: CUSTOMER_APPROVER_REF,
    origin: {
      kind: "ONCHAIN_WALLET",
      chainKey: CHAIN,
      accountRef: CUSTOMER_WALLET,
      assetId: canonicalAssetRef(CHAIN, "USC"),
      symbol: "USC",
    },
    destination: {
      kind: "ONCHAIN_RECIPIENT",
      chainKey: CHAIN,
      accountRef: PAYEE,
      assetId: canonicalAssetRef(CHAIN, "USC"),
      symbol: "USC",
    },
    originAmount: { currency: "USC", minorUnits: JOURNEY_A_AMOUNT_MINOR },
    arrivalCurrency: "USC",
    maxSettlementMs: 600_000,
    maxRouteHops: 6,
    intentAuthorizationRef: "authz:cert:intent:a",
    declaredAt: CERT_NOW - 60_000,
    expiresAt: CERT_NOW + 3_600_000,
  };
}

export const journeyA: ProductionJourney = {
  journeyId: "journey:a-simple-wallet-payment",
  letter: "A",
  title: "Simple wallet payment — \u201cPay $20\u201d",
  spec: "docs/UNIVERSAL-MONEY-HANDOFF-FULL-2026-10-02.md §35 Journey A",
  run: (): ReturnType<typeof assembleJourneyOutcome> => {
    // ------------------------------------------------------------------
    // 1. Eligible route selection (the REAL compiler)
    // ------------------------------------------------------------------
    const compilation = compileCertRoute(payTwentyIntent());
    journeyRequires(
      compilation.status === "ROUTES_COMPILED",
      `the compiler must compile the pay-$20 intent (got ${compilation.status})`,
    );
    const plan = requirePresent(
      compilation.plans.find((entry) => entry.shapeId === "onchain-direct-transfer"),
      "the onchain-direct-transfer shape must compile",
    );
    const leg = plan.legs[0];
    journeyRequires(
      leg !== undefined && leg.legKind === "ONCHAIN_TRANSFER",
      "the direct-transfer plan must carry the ONCHAIN_TRANSFER leg",
    );
    const legWrite = requirePresent(
      leg?.legKind === "ONCHAIN_TRANSFER" ? leg.write : undefined,
      "the transfer leg must carry the kernel-prepared write",
    );

    // ------------------------------------------------------------------
    // 2. Security analysis + 3. wallet authorization (the REAL kernel)
    // ------------------------------------------------------------------
    const pipeline = new OnchainWritePipeline({
      request: requestFromPrepared(legWrite),
      policy: certSecurityPolicy(),
      at: CERT_NOW,
    });
    const simulation = pipeline.simulate(
      transferSimulation(pipeline.prepared.writeId, {
        asset: USC_ASSET,
        minorUnits: JOURNEY_A_AMOUNT_MINOR,
        from: CUSTOMER_WALLET,
        to: PAYEE,
      }),
      CERT_NOW,
    );
    const gateDecision = pipeline.runGates(certSecurityState(), CERT_NOW);
    journeyRequires(
      gateDecision.decision === "ALLOW",
      `the gates must ALLOW the pay-$20 write (got ${gateDecision.decision})`,
    );
    const diff = pipeline.buildExpectedDiff(CERT_NOW);
    const authorizationRequest = pipeline.buildAuthorizationRequest({
      requestId: "authreq:cert:a",
      principal: CERT_SERVICE_PRINCIPAL,
      requestedAt: CERT_NOW,
    });
    const artifact = pipeline.authorize({
      surface: certApprovalSurface(),
      approverRef: CUSTOMER_APPROVER_REF,
      securityState: certSecurityState(),
      expiresAt: CERT_NOW + 600_000,
      at: CERT_NOW + 1,
    });
    const recheck = pipeline.recheck(
      recheckObservationFor(pipeline.prepared, certSecurityState({ observedAt: CERT_NOW + 2 }), CERT_NOW + 2),
      CERT_NOW + 2,
    );
    journeyRequires(recheck.outcome === "RECHECK_OK", "the pre-broadcast recheck must pass on unchanged state");

    // ------------------------------------------------------------------
    // 4. Blockchain handoff (the injected signer adapter — the only seam)
    // ------------------------------------------------------------------
    const signingRequest = pipeline.handoffForBroadcast({
      requestId: "signreq:cert:a",
      adapter: CERT_SIGNER_ADAPTER,
      at: CERT_NOW + 3,
    });
    const handoffReceipt = submitAtTrustedSurface(signingRequest, "tx:cert:a:1", CERT_NOW + 3_000);

    // ------------------------------------------------------------------
    // 5. Finality + 6. receipt (the REAL walk + evidence builder)
    // ------------------------------------------------------------------
    const walk = walkRoutePlan({
      plan,
      at: CERT_NOW + 4,
      observedAtIso: CERT_EPOCH_ISO,
      onchainFinalityModels: CERT_FINALITY_MODES,
    });
    const evidence = buildRouteJourneyEvidence(plan, walk);

    const stages = [
      stage(
        "ROUTE_SELECTION",
        "the W4-001 compiler selected the eligible onchain-direct-transfer route for the pay-$20 intent",
        [
          `plan:${plan.planId}`,
          `shape:${plan.shapeId}`,
          `candidateStatus:${plan.candidateStatus}`,
          `writeDigest:${legWrite.writeDigest}`,
        ],
        [`compilation:${compilation.compilationDigest}`],
      ),
      stage(
        "SECURITY_ANALYSIS",
        "the W1-002 deterministic gates ALLOWed the prepared write after a SUCCEEDED simulation observation",
        [
          `pipeline:${pipeline.prepared.writeDigest}`,
          `simulation:${simulation.simulationId}:${simulation.status}`,
          `gate:${gateDecision.decision}`,
        ],
        [`simulation:${simulation.simulationId}`, ...gateDecision.evidenceRefs],
      ),
      stage(
        "WALLET_AUTHORIZATION",
        "explicit signing at the injected trusted surface minted the authorization artifact bound to the human-readable expected-state diff",
        [
          `authorizationRequest:${authorizationRequest.requestHash}`,
          `artifact:${artifact.signature.slice(0, 16)}`,
          `approver:${artifact.principal}`,
          `diff:${diff.diffDigest}`,
          `pipelineState:AUTHORIZED`,
        ],
        [`evidence:authorization:${authorizationRequest.requestHash}`],
      ),
      stage(
        "BLOCKCHAIN_HANDOFF",
        "the kernel handed the signing request to the signer adapter at its terminal BROADCAST_HANDOFF state; the submission seam recorded the receipt",
        [
          `pipelineState:${pipeline.state}`,
          `signingRequest:${signingRequest.requestId}`,
          `externalRef:${handoffReceipt.externalRef}`,
        ],
        [...handoffReceipt.evidenceRefs],
      ),
      stage(
        "FINALITY",
        "the walk observed the chain outcome as CONFIRMED with a finality CANDIDATE (submitted is not final — rule 29)",
        [
          `walk:${walk.status}`,
          ...walk.legExecutions.map((entry) => `${entry.legKind}:${entry.status}`),
        ],
        [...walk.evidenceRefs],
      ),
      stage(
        "RECEIPT",
        "the route-journey evidence receipt was built over the plan and the walk (content-addressed)",
        [`evidence:${evidence.journeyId}`, `digest:${routeJourneyEvidenceDigest(evidence)}`],
        evidence.evidenceRefs,
      ),
    ];

    const onchainLeg = walk.legExecutions.find((entry) => entry.legKind === "ONCHAIN_TRANSFER");
    const assertions = [
      assertionFromChecks(
        "a:route-selected",
        [
          { check: "exactly the onchain-direct-transfer shape compiled", passed: compilation.plans.length === 1 && plan.shapeId === "onchain-direct-transfer" },
          { check: "no silent exclusions", passed: compilation.exclusions.length === 0 },
          { check: "plan is an executable candidate", passed: plan.candidateStatus === "EXECUTABLE_CANDIDATE" },
        ],
        [`compilation:${compilation.compilationDigest}`],
      ),
      assertionFromChecks(
        "a:kernel-binding",
        [
          { check: "the pipeline's prepared write digest equals the compiled leg's write digest (same write, not a re-implementation)", passed: pipeline.prepared.writeDigest === legWrite.writeDigest },
          { check: "the write is the $20 transfer to the payee", passed: pipeline.prepared.transfer?.to === PAYEE && pipeline.prepared.transfer.amount.minorUnits === JOURNEY_A_AMOUNT_MINOR },
        ],
        [`write:${pipeline.prepared.writeDigest}`],
      ),
      assertionFromChecks(
        "a:security-analysis",
        [
          { check: "gates ALLOW", passed: gateDecision.decision === "ALLOW" },
          { check: "simulation SUCCEEDED with exact $20 debit on the customer wallet", passed: simulation.status === "SUCCEEDED" && simulation.balanceDeltas.some((delta) => delta.holder === CUSTOMER_WALLET && delta.direction === "debit" && delta.amount.minorUnits === JOURNEY_A_AMOUNT_MINOR) },
          { check: "expected-state diff carries balance entries for both sides", passed: diff.entries.filter((entry) => entry.kind === "balance").length >= 2 },
        ],
        [...gateDecision.evidenceRefs],
      ),
      assertionFromChecks(
        "a:explicit-authorization",
        [
          { check: "authorization request exists and is hash-bound to the write + diff + gate decision", passed: authorizationRequest.write.writeDigest === pipeline.prepared.writeDigest && authorizationRequest.expectedDiff.diffDigest === diff.diffDigest },
          { check: "the artifact was minted by the trusted surface (explicit signing — not a chat message)", passed: artifact.principal === CUSTOMER_APPROVER_REF && artifact.signature.startsWith("sig:") },
          { check: "the approver is the customer while the request was raised by the service agent (no self-approval)", passed: artifact.principal === CUSTOMER_APPROVER_REF && authorizationRequest.principal.kind === "agent" },
        ],
        [`evidence:authorization:${authorizationRequest.requestHash}`],
      ),
      assertionFromChecks(
        "a:pre-broadcast-recheck",
        [{ check: "recheck RECHECK_OK immediately before handoff", passed: recheck.outcome === "RECHECK_OK" }],
        [...recheck.evidenceRefs],
      ),
      assertionFromChecks(
        "a:finality-and-receipt",
        [
          { check: "walk completed all legs observed", passed: walk.status === "ROUTE_COMPLETED_ALL_LEGS_OBSERVED" },
          { check: "the transfer leg observed a finality CANDIDATE (never declared final by the rail alone)", passed: onchainLeg?.status === "OBSERVED_FINALITY_CANDIDATE" },
          { check: "the onchain observation is CONFIRMED with a finality candidate and no reorg", passed: onchainLeg?.onchain?.observation.outcome === "CONFIRMED" && onchainLeg?.onchain?.observation.finalityCandidate?.candidateOnly === true && onchainLeg?.onchain?.observation.finalityCandidate?.reorgDetected === false },
          { check: "every definitive walk state carries evidence", passed: walk.legExecutions.every((entry) => entry.evidenceRefs.length > 0) },
        ],
        [...walk.evidenceRefs, ...evidence.evidenceRefs],
      ),
    ];

    return assembleJourneyOutcome({ journey: journeyA, stages, assertions });
  },
};

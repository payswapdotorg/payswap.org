/**
 * Journey C — Crypto-to-fiat (§35).
 *
 * User: "Cash out 1,000 USDC."
 * PaySwap: finds eligible conversion/off-ramp → executes → fiat
 * settlement → reconciliation.
 *
 * Real composition:
 * - the W4-001 route compiler finds the eligible conversion/off-ramp for
 *   a stablecoin origin (the provider-native off-ramp shape: ONCHAIN
 *   transfer to the off-ramp deposit → OFF_RAMP payout through the REAL
 *   six-check payout gate over a scoped transfer-out authorization →
 *   BANK settlement at the merchant bank destination) and honestly
 *   EXCLUDES the degenerate DEX-hop shape (a swap between identical
 *   assets is not a route);
 * - the kernel pipeline authorizes the deposit-transfer leg (explicit
 *   signing, recheck, handoff — same doctrine as Journey A);
 * - the walk executes all legs (onchain observation + payout observation
 *   + bank settlement result) and the reconciliation contract is proven
 *   on the faulted twin: a FIAT_OUTCOME_UNKNOWN payout leg yields
 *   ROUTE_REQUIRES_RECONCILIATION with blindRetryForbidden and the
 *   settlement reconciliation authority as the ONLY resolver.
 */

import type { MoneyMovementIntent, RouteLegFault } from "@payswap/route-compiler";
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
  MERCHANT_BANK_IBAN,
  OFFRAMP_DEPOSIT_ADDRESS,
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

/** "Cash out 1,000 USDC" — 1_000.00 USC (10^9 minor). */
export const JOURNEY_C_INPUT_MINOR = "1000000000" as const;

function cashOutIntent(): MoneyMovementIntent {
  return {
    intentId: "intent:cert:c:cash-out-1000",
    principalRef: CUSTOMER_APPROVER_REF,
    origin: {
      kind: "ONCHAIN_WALLET",
      chainKey: CHAIN,
      accountRef: CUSTOMER_WALLET,
      assetId: canonicalAssetRef(CHAIN, "USC"),
      symbol: "USC",
    },
    destination: {
      kind: "BANK_ACCOUNT",
      externalRef: MERCHANT_BANK_IBAN,
      currency: "EUR",
    },
    originAmount: { currency: "USC", minorUnits: JOURNEY_C_INPUT_MINOR },
    arrivalCurrency: "EUR",
    maxSettlementMs: 600_000,
    maxRouteHops: 6,
    intentAuthorizationRef: "authz:cert:intent:c",
    declaredAt: CERT_NOW - 60_000,
    expiresAt: CERT_NOW + 3_600_000,
  };
}

export const journeyC: ProductionJourney = {
  journeyId: "journey:c-crypto-to-fiat",
  letter: "C",
  title: "Crypto-to-fiat — \u201cCash out 1,000 USDC\u201d",
  spec: "docs/UNIVERSAL-MONEY-HANDOFF-FULL-2026-10-02.md §35 Journey C",
  run: (): ReturnType<typeof assembleJourneyOutcome> => {
    // ------------------------------------------------------------------
    // 1. Eligible conversion/off-ramp (the REAL compiler)
    // ------------------------------------------------------------------
    const compilation = compileCertRoute(cashOutIntent());
    journeyRequires(
      compilation.status === "ROUTES_COMPILED",
      `the compiler must compile the cash-out intent (got ${compilation.status})`,
    );
    const plan = requirePresent(
      compilation.plans.find((entry) => entry.shapeId === "provider-native-offramp"),
      "the provider-native off-ramp shape must compile",
    );
    const transferLeg = requirePresent(
      plan.legs.find((entry) => entry.legKind === "ONCHAIN_TRANSFER"),
      "the off-ramp plan must carry the deposit-transfer leg",
    );
    const payoutLeg = requirePresent(
      plan.legs.find((entry) => entry.legKind === "OFF_RAMP_PAYOUT"),
      "the off-ramp plan must carry the payout leg",
    );
    const bankLeg = requirePresent(
      plan.legs.find((entry) => entry.legKind === "BANK_SETTLEMENT"),
      "the off-ramp plan must carry the bank settlement leg",
    );
    const transferWrite = requirePresent(
      transferLeg.legKind === "ONCHAIN_TRANSFER" ? transferLeg.write : undefined,
      "the deposit-transfer leg must carry the kernel-prepared write",
    );

    // ------------------------------------------------------------------
    // 2. Execution authorization for the deposit-transfer leg
    // ------------------------------------------------------------------
    const pipeline = new OnchainWritePipeline({
      request: requestFromPrepared(transferWrite),
      policy: certSecurityPolicy(),
      at: CERT_NOW,
    });
    pipeline.simulate(
      transferSimulation(pipeline.prepared.writeId, {
        asset: USC_ASSET,
        minorUnits: JOURNEY_C_INPUT_MINOR,
        from: CUSTOMER_WALLET,
        to: OFFRAMP_DEPOSIT_ADDRESS,
      }),
      CERT_NOW,
    );
    const gateDecision = pipeline.runGates(certSecurityState(), CERT_NOW);
    journeyRequires(gateDecision.decision === "ALLOW", `the deposit-transfer gates must ALLOW (got ${gateDecision.decision})`);
    pipeline.buildExpectedDiff(CERT_NOW);
    const authorizationRequest = pipeline.buildAuthorizationRequest({
      requestId: "authreq:cert:c",
      principal: CERT_SERVICE_PRINCIPAL,
      requestedAt: CERT_NOW,
    });
    pipeline.authorize({
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
    journeyRequires(recheck.outcome === "RECHECK_OK", "the deposit-transfer recheck must pass");
    const signingRequest = pipeline.handoffForBroadcast({
      requestId: "signreq:cert:c",
      adapter: CERT_SIGNER_ADAPTER,
      at: CERT_NOW + 3,
    });
    const handoffReceipt = submitAtTrustedSurface(signingRequest, "tx:cert:c:1", CERT_NOW + 3_000);

    // ------------------------------------------------------------------
    // 3. Fiat settlement (the walk executes every leg)
    // ------------------------------------------------------------------
    const walk = walkRoutePlan({
      plan,
      at: CERT_NOW + 4,
      observedAtIso: CERT_EPOCH_ISO,
      onchainFinalityModels: CERT_FINALITY_MODES,
    });
    const evidence = buildRouteJourneyEvidence(plan, walk);

    // ------------------------------------------------------------------
    // 4. Reconciliation (the faulted twin — payout OUTCOME_UNKNOWN)
    // ------------------------------------------------------------------
    const payoutFault: RouteLegFault = {
      kind: "FIAT_OUTCOME_UNKNOWN",
      reason: "the off-ramp provider returned an ambiguous payout state at the observation instant (certification fault injection)",
    };
    const faultedWalk = walkRoutePlan({
      plan,
      at: CERT_NOW + 4,
      observedAtIso: CERT_EPOCH_ISO,
      onchainFinalityModels: CERT_FINALITY_MODES,
      faults: { [payoutLeg.legId]: payoutFault },
    });

    const payoutExecution = walk.legExecutions.find((entry) => entry.legKind === "OFF_RAMP_PAYOUT");
    const bankExecution = walk.legExecutions.find((entry) => entry.legKind === "BANK_SETTLEMENT");
    const conversionGrounded = plan?.legs.every(
      (leg) => leg.plannedAmount.basis !== "UNKNOWN",
    );

    const stages = [
      stage(
        "CONVERSION_OFFRAMP_DISCOVERY",
        "the compiler found the eligible provider-native off-ramp and honestly excluded the degenerate DEX-hop shape",
        [
          `plan:${plan!.planId}`,
          `shape:${plan!.shapeId}`,
          `legs:${plan!.legs.map((leg) => leg.legKind).join(">")}`,
          ...compilation.exclusions.map((entry) => `excluded:${entry.shapeId}`),
        ],
        [`compilation:${compilation.compilationDigest}`],
      ),
      stage(
        "EXECUTION_AUTHORIZATION",
        "the deposit-transfer leg was authorized through the kernel pipeline with explicit signing and a passing recheck",
        [
          `write:${pipeline.prepared.writeDigest}`,
          `authorizationRequest:${authorizationRequest.requestHash}`,
          `externalRef:${handoffReceipt.externalRef}`,
        ],
        [...handoffReceipt.evidenceRefs],
      ),
      stage(
        "FIAT_SETTLEMENT",
        "the walk executed the payout leg through the real payout gate and settled to the bank destination",
        [
          `walk:${walk.status}`,
          ...walk.legExecutions.map((entry) => `${entry.legKind}:${entry.status}`),
          `payoutObservation:${payoutExecution?.payoutObservation?.status ?? "none"}`,
        ],
        [...walk.evidenceRefs],
      ),
      stage(
        "RECONCILIATION",
        "the faulted twin (payout OUTCOME_UNKNOWN) stopped at ROUTE_REQUIRES_RECONCILIATION with blind retry forbidden and the settlement reconciliation authority as the only resolver",
        [
          `faultedWalk:${faultedWalk.status}`,
          `blindRetryForbidden:${faultedWalk.reconciliation?.blindRetryForbidden ?? false}`,
          `resolver:${faultedWalk.reconciliation?.resolver ?? "none"}`,
          `custodyAtStop:${faultedWalk.custodyAtStop?.party.kind ?? "none"}:${faultedWalk.custodyAtStop?.assetRef ?? ""}`,
        ],
        [...(faultedWalk.reconciliation?.reasons ?? [])],
      ),
      stage(
        "RECEIPT",
        "the route-journey evidence receipt was built over the happy-path plan and walk",
        [`evidence:${evidence.journeyId}`, `digest:${routeJourneyEvidenceDigest(evidence)}`],
        evidence.evidenceRefs,
      ),
    ];

    const assertions = [
      assertionFromChecks(
        "c:eligible-offramp-found",
        [
          { check: "the provider-native off-ramp compiled as a candidate (the incumbent baseline — INV-C08, never ranked away)", passed: plan.candidateStatus === "PROVIDER_NATIVE_BASELINE" || plan.candidateStatus === "EXECUTABLE_CANDIDATE" },
          { check: "every planned leg amount is grounded (no invented FX — exact conversion rules)", passed: conversionGrounded === true },
          { check: "the degenerate DEX-hop shape was excluded with a typed reason, not silently dropped", passed: compilation.exclusions.some((entry) => entry.shapeId === "mixed-dex-offramp" && entry.reasons.length > 0) },
        ],
        [`compilation:${compilation.compilationDigest}`],
      ),
      assertionFromChecks(
        "c:deposit-transfer-authorized",
        [
          { check: "the deposit goes to the off-ramp's declared deposit address", passed: pipeline.prepared.transfer?.to === OFFRAMP_DEPOSIT_ADDRESS },
          { check: "the deposit amount is exactly 1,000.00 USC", passed: pipeline.prepared.transfer?.amount.minorUnits === JOURNEY_C_INPUT_MINOR },
          { check: "explicit signing + passing recheck before handoff", passed: recheck.outcome === "RECHECK_OK" && pipeline.state === "BROADCAST_HANDOFF" },
        ],
        [`evidence:authorization:${authorizationRequest.requestHash}`],
      ),
      assertionFromChecks(
        "c:fiat-settlement-executed",
        [
          { check: "the walk completed all legs observed", passed: walk.status === "ROUTE_COMPLETED_ALL_LEGS_OBSERVED" },
          { check: "the payout leg was observed (the real payout gate ran)", passed: payoutExecution?.payoutObservation !== undefined && payoutExecution.payoutObservation.status === "paid" },
          { check: "the bank settlement leg was observed", passed: bankExecution?.status !== undefined },
          { check: "every executed leg carries evidence", passed: walk.legExecutions.every((entry) => entry.evidenceRefs.length > 0) },
        ],
        [...walk.evidenceRefs],
      ),
      assertionFromChecks(
        "c:reconciliation-only-exit",
        [
          { check: "the faulted walk stopped at ROUTE_REQUIRES_RECONCILIATION (never fabricated success)", passed: faultedWalk.status === "ROUTE_REQUIRES_RECONCILIATION" },
          { check: "blind retry is forbidden (INV-X02)", passed: faultedWalk.reconciliation?.blindRetryForbidden === true },
          { check: "the ONLY resolver is the settlement reconciliation authority (INV-X03)", passed: faultedWalk.reconciliation?.resolver === "SETTLEMENT_RECONCILIATION_AUTHORITY" },
          { check: "the custody at stop names where the value honestly sits", passed: faultedWalk.custodyAtStop !== undefined },
        ],
        [...(faultedWalk.reconciliation?.reasons ?? [])],
      ),
    ];

    return assembleJourneyOutcome({ journey: journeyC, stages, assertions });
  },
};

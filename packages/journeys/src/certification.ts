/**
 * @payswap/journeys — the journey certification report (W1-007).
 *
 * Runs every journey in the suite, collects the per-journey pass/fail with
 * the acceptance-axis assertions, certifies the PASS_THROUGH_NATIVE baseline
 * (W1-007 acceptance), verifies complete axis coverage, and produces the
 * overall suite verdict with evidence references for every claim.
 */

import { contentDigest } from "@payswap/certification";
import type { JourneyDefinition, JourneyOutcome } from "./harness.js";
import { ACCEPTANCE_AXES, journeyPassed } from "./harness.js";
import type { AcceptanceAxis, AxisAssertion, InvariantProof } from "./harness.js";
import { JOURNEY_EPOCH } from "./harness.js";
import type { TimestampMs } from "@payswap/protocol";
import { p2pJourney } from "./journeys/p2p.js";
import { merchantCheckoutJourney } from "./journeys/merchant-checkout.js";
import { crossBorderJourney } from "./journeys/cross-border.js";
import { payrollBatchJourney } from "./journeys/payroll-batch.js";
import { creditJourney } from "./journeys/credit.js";
import { incentiveLiquidityJourney } from "./journeys/incentive-liquidity.js";
import { pspIncumbentJourney } from "./journeys/psp-incumbent.js";
import { customerActionJourney } from "./journeys/customer-action.js";
import { recurringMandateJourney } from "./journeys/recurring-mandate.js";
import { refundDisputeJourney } from "./journeys/refund-dispute.js";
import { multiProviderFallbackJourney } from "./journeys/multi-provider-fallback.js";
import { externalFundsJourney } from "./journeys/external-funds.js";

/** The 12 W1-007 economic journeys, in work-order order. */
export const JOURNEYS: readonly JourneyDefinition[] = [
  p2pJourney,
  merchantCheckoutJourney,
  crossBorderJourney,
  payrollBatchJourney,
  creditJourney,
  incentiveLiquidityJourney,
  pspIncumbentJourney,
  customerActionJourney,
  recurringMandateJourney,
  refundDisputeJourney,
  multiProviderFallbackJourney,
  externalFundsJourney,
];

export interface JourneyCertification {
  readonly journeyId: string;
  readonly title: string;
  readonly passed: boolean;
  readonly assertions: readonly AxisAssertion[];
  readonly invariantsExercised: readonly InvariantProof[];
  readonly evidenceRefs: readonly string[];
}

export interface AxisCoverage {
  readonly axis: AcceptanceAxis;
  readonly assertedByJourneys: readonly string[];
  readonly passed: boolean;
}

export interface JourneyCertificationReport {
  readonly suiteId: "payswap.journey-certification";
  readonly workOrder: "W1-007";
  readonly generatedAt: TimestampMs;
  readonly certifications: readonly JourneyCertification[];
  readonly axisCoverage: readonly AxisCoverage[];
  readonly passThroughNativeBaselineCertified: boolean;
  readonly overallPassed: boolean;
  readonly journeyCount: number;
  readonly digest: string;
}

function certifyOne(outcome: JourneyOutcome): JourneyCertification {
  return {
    journeyId: outcome.journeyId,
    title: outcome.title,
    passed: journeyPassed(outcome),
    assertions: outcome.assertions,
    invariantsExercised: outcome.invariantsExercised,
    evidenceRefs: outcome.evidenceRefs,
  };
}

/** Run the full certification suite and produce the report. */
export async function certifyAllJourneys(
  journeys: readonly JourneyDefinition[] = JOURNEYS,
): Promise<JourneyCertificationReport> {
  const certifications: JourneyCertification[] = [];
  for (const journey of journeys) {
    const outcome = await journey.run();
    certifications.push(certifyOne(outcome));
  }
  const axisCoverage: AxisCoverage[] = ACCEPTANCE_AXES.map((axis) => {
    const asserting = certifications.filter((certification) =>
      certification.assertions.some((assertion) => assertion.axis === axis),
    );
    return {
      axis,
      assertedByJourneys: asserting.map((certification) => certification.journeyId),
      passed: asserting.length > 0 && asserting.every((certification) => certification.passed),
    };
  });
  const baselineCertified =
    axisCoverage.find((coverage) => coverage.axis === "PASS_THROUGH_NATIVE_BASELINE")?.passed === true;
  const overallPassed =
    certifications.length === journeys.length &&
    certifications.every((certification) => certification.passed) &&
    axisCoverage.every((coverage) => coverage.passed);
  const report: Omit<JourneyCertificationReport, "digest"> = {
    suiteId: "payswap.journey-certification",
    workOrder: "W1-007",
    generatedAt: JOURNEY_EPOCH,
    certifications,
    axisCoverage,
    passThroughNativeBaselineCertified: baselineCertified,
    overallPassed,
    journeyCount: certifications.length,
  };
  return {
    ...report,
    digest: contentDigest(report),
  };
}

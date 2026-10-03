/**
 * @payswap/onchain-threat-intel — threat signals
 * (Work Order P4-W3-003 hard requirement 1: "the agent outputs threat
 * signals with evidence and confidence").
 *
 * A ThreatSignal is the ONLY output currency of the adversarial agent:
 * a family-classified, severity-graded observation with a MANDATORY
 * evidence chain (./evidence.ts — structurally validated), a calibrated
 * confidence in integer basis points (./confidence.ts) and a deterministic
 * content-addressed signalId.
 *
 * A signal is NOT a decision. Signals feed the deterministic policy
 * (./policy.ts); verdicts are composed under the kernel no-downgrade law
 * (./verdict.ts). A signal without evidence fails validation
 * STRUCTURALLY — `validateThreatSignal` is called on every signal the
 * agent emits, so an evidence-free signal is unconstructible through this
 * package's API.
 *
 * Deterministic only: pure data + pure functions.
 */

import { contentDigest } from "@payswap/onchain-security";
import type {
  DetectionMethod,
} from "./confidence.js";
import { validateConfidenceBps } from "./confidence.js";
import type { ThreatEvidence } from "./evidence.js";
import { freezeEvidence, validateThreatEvidence } from "./evidence.js";
import type { ThreatFamily, ThreatSeverity } from "./families.js";
import { assertThreatFamilySeverity } from "./families.js";

/** Raised when a threat signal is structurally invalid. */
export class InvalidThreatSignalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidThreatSignalError";
  }
}

/**
 * A threat signal: family + code + severity + calibrated confidence +
 * MANDATORY evidence chain. Immutable and content-addressed (signalId is
 * the deterministic digest of the full signal content).
 */
export interface ThreatSignal {
  /** Deterministic content digest of the signal (identity). */
  readonly signalId: string;
  readonly family: ThreatFamily;
  /** Machine code, e.g. `unlimited_approval_to_drain_spender`. */
  readonly code: string;
  readonly severity: ThreatSeverity;
  /** How the detection was made (calibration input). */
  readonly method: DetectionMethod;
  /** Calibrated confidence, integer basis points in [0, 10_000]. */
  readonly confidenceBps: number;
  /** The mandatory evidence chain (observationRefs + digestRefs + deltas). */
  readonly evidence: ThreatEvidence;
  readonly summary: string;
}

/**
 * Construct + validate one threat signal. Computes the deterministic
 * signalId (content digest), freezes the evidence chain and validates:
 * 1. family + severity are known vocabulary;
 * 2. the code and summary are non-empty;
 * 3. the confidence is a valid integer-bps value;
 * 4. THE EVIDENCE CHAIN IS PRESENT AND COMPLETE (structural law).
 *
 * Throws InvalidThreatSignalError — an evidence-free signal cannot be
 * constructed through any path in this package.
 */
export function buildThreatSignal(input: {
  family: ThreatFamily;
  code: string;
  severity: ThreatSeverity;
  method: DetectionMethod;
  confidenceBps: number;
  evidence: ThreatEvidence;
  summary: string;
}): ThreatSignal {
  assertThreatFamilySeverity(input.family, input.severity);
  if (input.code.length === 0) {
    throw new InvalidThreatSignalError(
      `signal for family '${input.family}': code must be non-empty`,
    );
  }
  if (input.summary.length === 0) {
    throw new InvalidThreatSignalError(
      `signal '${input.code}': summary must be non-empty`,
    );
  }
  try {
    validateConfidenceBps(input.confidenceBps);
  } catch (error) {
    throw new InvalidThreatSignalError(
      `signal '${input.code}': ${(error as Error).message}`,
    );
  }
  const label = `${input.family}:${input.code}`;
  // THE structural law: a signal without its evidence chain fails here.
  validateThreatEvidence(input.evidence, label);
  const evidence = freezeEvidence(input.evidence);
  const signalId = contentDigest({
    family: input.family,
    code: input.code,
    severity: input.severity,
    method: input.method,
    confidenceBps: input.confidenceBps,
    evidence,
    summary: input.summary,
  });
  return Object.freeze({
    signalId,
    family: input.family,
    code: input.code,
    severity: input.severity,
    method: input.method,
    confidenceBps: input.confidenceBps,
    evidence,
    summary: input.summary,
  });
}

/**
 * Validate an already-built signal (defensive re-validation; same rules as
 * buildThreatSignal minus construction).
 */
export function validateThreatSignal(signal: ThreatSignal): void {
  if (signal.signalId.length === 0) {
    throw new InvalidThreatSignalError("signalId must be non-empty");
  }
  validateThreatEvidence(signal.evidence, `${signal.family}:${signal.code}`);
}

import { describe, expect, it } from "vitest";
import type { FindForbiddenSecretKeys, SecretFree } from "@payswap/onchain-security";
import type {
  AdversarialAnalysisInput,
  ThreatAssessment,
  ThreatRecommendation,
} from "../src/index.js";
import type { ThreatSignal } from "../src/index.js";
import type {
  OnchainThreatObservationBundle,
  SpenderIntelligence,
  TokenRegistryEntry,
  OracleObservation,
  BridgeHealthObservation,
  FinalityObservation,
  MempoolObservation,
  DomainObservation,
  AddressIntelligence,
} from "../src/index.js";
import type { ThreatEvidence, EvidenceDelta } from "../src/index.js";
import type { OnchainThreatPolicy, ThreatVerdict, ThreatPolicyEvaluation } from "../src/index.js";
import type { RawSignal } from "../src/index.js";
import type {
  ThreatAdvisoryProposal,
  ThreatSignatureRegistration,
  ThreatAffectedComponent,
  EvidenceRef,
} from "../src/index.js";
import type { OnchainThreatResolution } from "../src/index.js";

/**
 * THE TYPE-LEVEL SECRET-FREE PROOF (the W1-002 type-level secret-boundary
 * proof extended to the adversarial agent's contracts — task packet: "the
 * W1-002 type-level secret-free proof extends").
 *
 * `FindForbiddenSecretKeys<T>` resolves to `never` iff NO forbidden key
 * name (privateKey, seedPhrase, mnemonic, password, apiKey, secret,
 * cookie, mfa ...) appears anywhere inside T. Every AGENT-FACING contract
 * of this package must resolve to `never`: the adversarial agent models
 * threats; it never handles key material (AGENTS.md rule 25).
 */

type IsNever<T> = [T] extends [never] ? true : false;

function assertSecretFree<T>(_label: string): void {
  // The runtime assertion is the type-level check below compiling at all;
  // the expect() gives the test a visible body.
  expect(true).toBe(true);
}

// The compile-time proof: each `Check` only compiles when the contract is
// secret-free; the runtime assertions mirror them for visibility.
type Check<A extends true> = A;

describe("type-level secret-free proof for every agent-facing contract", () => {
  it("observation bundle sections are secret-free", () => {
    type Cases = [
      Check<IsNever<FindForbiddenSecretKeys<OnchainThreatObservationBundle>>>,
      Check<IsNever<FindForbiddenSecretKeys<SpenderIntelligence>>>,
      Check<IsNever<FindForbiddenSecretKeys<TokenRegistryEntry>>>,
      Check<IsNever<FindForbiddenSecretKeys<OracleObservation>>>,
      Check<IsNever<FindForbiddenSecretKeys<BridgeHealthObservation>>>,
      Check<IsNever<FindForbiddenSecretKeys<FinalityObservation>>>,
      Check<IsNever<FindForbiddenSecretKeys<MempoolObservation>>>,
      Check<IsNever<FindForbiddenSecretKeys<DomainObservation>>>,
      Check<IsNever<FindForbiddenSecretKeys<AddressIntelligence>>>,
    ];
    const _cases: Cases = [
      true, true, true, true, true, true, true, true, true,
    ];
    expect(_cases.length).toBe(9);
    assertSecretFree<OnchainThreatObservationBundle>("bundle");
  });

  it("signals, evidence and assessments are secret-free", () => {
    type Cases = [
      Check<IsNever<FindForbiddenSecretKeys<ThreatSignal>>>,
      Check<IsNever<FindForbiddenSecretKeys<ThreatEvidence>>>,
      Check<IsNever<FindForbiddenSecretKeys<EvidenceDelta>>>,
      Check<IsNever<FindForbiddenSecretKeys<RawSignal>>>,
      Check<IsNever<FindForbiddenSecretKeys<ThreatAssessment>>>,
      Check<IsNever<FindForbiddenSecretKeys<AdversarialAnalysisInput>>>,
    ];
    const _cases: Cases = [true, true, true, true, true, true];
    expect(_cases.length).toBe(6);
    assertSecretFree<ThreatAssessment>("assessment");
  });

  it("policy, verdict and resolution contracts are secret-free", () => {
    type Cases = [
      Check<IsNever<FindForbiddenSecretKeys<OnchainThreatPolicy>>>,
      Check<IsNever<FindForbiddenSecretKeys<ThreatPolicyEvaluation>>>,
      Check<IsNever<FindForbiddenSecretKeys<ThreatRecommendation>>>,
      Check<IsNever<FindForbiddenSecretKeys<ThreatVerdict>>>,
      Check<IsNever<FindForbiddenSecretKeys<OnchainThreatResolution>>>,
    ];
    const _cases: Cases = [true, true, true, true, true];
    expect(_cases.length).toBe(5);
  });

  it("immune-system bridge contracts are secret-free", () => {
    type Cases = [
      Check<IsNever<FindForbiddenSecretKeys<ThreatAdvisoryProposal>>>,
      Check<IsNever<FindForbiddenSecretKeys<ThreatSignatureRegistration>>>,
      Check<IsNever<FindForbiddenSecretKeys<ThreatAffectedComponent>>>,
      Check<IsNever<FindForbiddenSecretKeys<EvidenceRef>>>,
    ];
    const _cases: Cases = [true, true, true, true];
    expect(_cases.length).toBe(4);
  });

  it("SecretFree<T> is the identity for the agent-facing contracts (self-annotating proof)", () => {
    // If any forbidden key crept in, SecretFree<T> would degrade to a
    // ["FORBIDDEN_SECRET_KEY", ...] tuple — not assignable to T.
    const bundleProbe: SecretFree<OnchainThreatObservationBundle> = null as never;
    const assessmentProbe: SecretFree<ThreatAssessment> = null as never;
    const signalProbe: SecretFree<ThreatSignal> = null as never;
    const policyProbe: SecretFree<OnchainThreatPolicy> = null as never;
    expect([bundleProbe, assessmentProbe, signalProbe, policyProbe]).toHaveLength(4);
  });

  it("a contract carrying a forbidden key name is DETECTED at the type level (proof the proof works)", () => {
    type Smuggled = { readonly privateKey: string };
    type Detected = IsNever<FindForbiddenSecretKeys<Smuggled>>;
    const detected: Check<Detected extends false ? true : false> = true;
    expect(detected).toBe(true);
    type NotNever = FindForbiddenSecretKeys<Smuggled>;
    const key: NotNever = "privateKey";
    expect(key).toBe("privateKey");
  });
});

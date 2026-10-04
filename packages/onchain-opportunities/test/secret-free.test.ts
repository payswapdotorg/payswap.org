import { describe, expect, it } from "vitest";
import type { FindForbiddenSecretKeys, SecretFree } from "@payswap/onchain-security";
import type {
  FinancialOpportunity,
  ResolvedOpportunity,
  OpportunityObservationInput,
  DiscoveryPolicyEvaluation,
  OpportunityFamilyCapability,
  ArbitrageLeg,
  ExpectedReturnEstimate,
} from "../src/index.js";

/**
 * THE TYPE-LEVEL SECRET-FREE PROOF (the W1-002 type-level secret-boundary
 * proof extended to this package's agent-facing contracts — AGENTS.md rule
 * 25: raw private keys, seed phrases, wallet/provider secrets, cookies and
 * MFA material never enter agent/model context).
 *
 * `FindForbiddenSecretKeys<T>` resolves to `never` iff NO forbidden key name
 * appears anywhere inside T. Every agent-facing contract of this package
 * must resolve to `never`: discovery surfaces observations and estimates,
 * never key material.
 */

type IsNever<T> = [T] extends [never] ? true : false;

function assertSecretFree<T>(_label: string): void {
  expect(true).toBe(true);
}

type Check<A extends true> = A;

describe("type-level secret-free proof for every agent-facing contract", () => {
  it("the FinancialOpportunity and its first-class field types are secret-free", () => {
    type Cases = [
      Check<IsNever<FindForbiddenSecretKeys<FinancialOpportunity>>>,
      Check<IsNever<FindForbiddenSecretKeys<ExpectedReturnEstimate>>>,
      Check<IsNever<FindForbiddenSecretKeys<ArbitrageLeg>>>,
    ];
    const _cases: Cases = [true, true, true];
    expect(_cases.length).toBe(3);
    assertSecretFree<FinancialOpportunity>("opportunity");
  });

  it("the observation input, policy evaluation and resolution contracts are secret-free", () => {
    type Cases = [
      Check<IsNever<FindForbiddenSecretKeys<OpportunityObservationInput>>>,
      Check<IsNever<FindForbiddenSecretKeys<DiscoveryPolicyEvaluation>>>,
      Check<IsNever<FindForbiddenSecretKeys<ResolvedOpportunity>>>,
    ];
    const _cases: Cases = [true, true, true];
    expect(_cases.length).toBe(3);
  });

  it("the Lab capability registration contract is secret-free", () => {
    type Cases = [
      Check<IsNever<FindForbiddenSecretKeys<OpportunityFamilyCapability>>>,
    ];
    const _cases: Cases = [true];
    expect(_cases.length).toBe(1);
  });

  it("SecretFree<T> is the identity for the agent-facing contracts (self-annotating proof)", () => {
    const opportunityProbe: SecretFree<FinancialOpportunity> = null as never;
    const inputProbe: SecretFree<OpportunityObservationInput> = null as never;
    const capabilityProbe: SecretFree<OpportunityFamilyCapability> = null as never;
    expect([opportunityProbe, inputProbe, capabilityProbe]).toHaveLength(3);
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

import { describe, expect, it } from "vitest";
import { isFundingSourceClass } from "../src/index.js";
import type {
  AcceptanceCapability,
  Capability,
  CapabilityClass,
} from "../src/index.js";
import type { Equal, Expect } from "./type-utils.js";

/**
 * FROZEN-ARCHITECTURE §11: AcceptanceCapability is first-class so merchant
 * acceptance is distinct from funding source. Capabilities carry conditions,
 * cost, risk, provenance, economic accountability and proof metadata.
 */

const capability: Capability = {
  id: "cap:sepa-credit-transfer",
  capabilityClass: "rail_movement",
  conditions: [
    { kind: "jurisdiction", description: "SEPA zone only", hardConstraint: true },
    { kind: "eligibility", description: "Account verified", hardConstraint: true },
  ],
  cost: [
    { componentId: "fixed", kind: "fixed_fee", amount: { currency: "EUR", minorUnits: "5" } },
    { componentId: "variable", kind: "variable_fee_bps", bps: 8n },
  ],
  risk: { riskClass: "settlement", severity: "low", mitigations: ["reconciliation"] },
  provenance: { declaredBy: "provider:bank-a", artifactRef: "provider:bank-a/sepa@2", contentHash: "fnv1a64:00ff" },
  economicAccountability: {
    accountablePartyRef: "provider:bank-a",
    ledgerAccountRef: "ledger:fees/bank-a",
    recoursePolicyRef: "policy:recourse/sepa",
  },
  proofRequirements: [{ proofLevel: "P2", scope: "settlement" }],
  bondCollateralRecourse: {
    bondAmount: { currency: "EUR", minorUnits: "1000000" },
    collateralType: "cash-bond",
    recourseMechanism: "dispute/claim",
  },
};

const acceptance: AcceptanceCapability = {
  ...capability,
  id: "cap:merchant-123-acceptance",
  capabilityClass: "merchant_acceptance",
  acceptedPaymentMethods: ["bank_transfer", "instant_payment"],
  acceptedCurrencies: ["EUR"],
  acceptedCountries: ["DE", "FR"],
  terms: {
    supportsRecurring: true,
    supportsPartialPayments: false,
    supportsRefunds: true,
    recoursePolicyRef: "policy:recourse/merchant-123",
  },
  settlementDestinationRef: "destination:merchant-123/iban",
};

describe("Capability metadata (§11)", () => {
  it("carries conditions, cost, risk, provenance, accountability, proof and bond metadata", () => {
    expect(capability.conditions.some((condition) => condition.hardConstraint)).toBe(true);
    expect(capability.cost[1]?.bps).toBe(8n);
    expect(capability.proofRequirements[0]?.proofLevel).toBe("P2");
    expect(capability.economicAccountability.accountablePartyRef).toBe("provider:bank-a");
    expect(capability.bondCollateralRecourse?.bondAmount.minorUnits).toBe("1000000");
  });
});

describe("AcceptanceCapability is first-class and NOT a funding source (§11)", () => {
  it("is a Capability (shared metadata shape) with a fixed merchant_acceptance class", () => {
    const asCapability: Capability = acceptance;
    expect(asCapability.capabilityClass).toBe("merchant_acceptance");
    expect(acceptance.acceptedCurrencies).toEqual(["EUR"]);
    expect(acceptance.terms.supportsRecurring).toBe(true);
  });

  it("merchant acceptance is not a funding-source class", () => {
    expect(isFundingSourceClass("merchant_acceptance")).toBe(false);
    expect(isFundingSourceClass("liquidity")).toBe(true);
    expect(isFundingSourceClass("credit")).toBe(true);
    expect(isFundingSourceClass("lending")).toBe(true);
    expect(isFundingSourceClass("rail_movement")).toBe(false);
  });

  it("funding classes and the acceptance class are disjoint sets", () => {
    const funding: readonly CapabilityClass[] = ["liquidity", "credit", "lending"];
    expect(funding).not.toContain("merchant_acceptance");
  });
});

// Type-level guarantees (enforced by `tsc --noEmit`):

// AcceptanceCapability satisfies the base Capability contract.
type _acceptanceIsCapability = AcceptanceCapability extends Capability ? true : false;
type _assert1 = Expect<Equal<_acceptanceIsCapability, true>>;

// Its class literal is pinned to merchant_acceptance — never a funding class.
type _acceptanceClass = AcceptanceCapability["capabilityClass"];
type _assert2 = Expect<Equal<_acceptanceClass, "merchant_acceptance">>;

// A funding-source class is a CapabilityClass, but merchant_acceptance is not one.
type _fundingClasses = Extract<CapabilityClass, "liquidity" | "credit" | "lending">;
type _assert3 = Expect<Equal<_fundingClasses, "liquidity" | "credit" | "lending">>;
type _acceptanceNotFunding = "merchant_acceptance" extends _fundingClasses ? true : false;
type _assert4 = Expect<Equal<_acceptanceNotFunding, false>>;

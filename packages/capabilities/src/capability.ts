/**
 * Capability contracts (FROZEN-ARCHITECTURE §11).
 *
 * Capabilities are the universal ecosystem unit. Every capability declares
 * conditions, cost, risk, provenance, economic accountability, proof
 * requirements and bond/collateral/recourse where relevant.
 * AcceptanceCapability is first-class so merchant acceptance is distinct from
 * funding source (§11).
 */

import type { AmountSpec, ProofLevel, ProofRequirement } from "@payswap/trust";
import { PROOF_LEVELS } from "@payswap/trust";

/**
 * Capability classes (FROZEN-ARCHITECTURE §11).
 * W2-003 owns the canonical connector capability vocabulary on top of these.
 */
export const CAPABILITY_CLASSES = [
  "rail_movement",
  "liquidity",
  "fx",
  "credit",
  "lending",
  "merchant_acceptance",
  "identity_kyc_aml",
  "expert_resolution",
  "agent_behavior",
  "software_extension",
  "developer_service",
  "verification",
  "data_oracle",
] as const;

export type CapabilityClass = (typeof CAPABILITY_CLASSES)[number];

/** Classes that fund a payment. Merchant acceptance is deliberately absent. */
export type FundingSourceClass = "liquidity" | "credit" | "lending";

export function isFundingSourceClass(cls: CapabilityClass): cls is FundingSourceClass {
  return cls === "liquidity" || cls === "credit" || cls === "lending";
}

/**
 * Exact monetary amount (INV-F01).
 *
 * W2-002 CONSOLIDATION: the local duplicate was removed; AmountSpec is the
 * canonical @payswap/trust wire format (backed by the @payswap/protocol money
 * primitive). The re-export preserves the Stage-0 export surface.
 */
export type { AmountSpec };

/**
 * Proof levels (FROZEN-ARCHITECTURE §16).
 *
 * W2-002 CONSOLIDATION: canonical PROOF_LEVELS/ProofLevel/ProofRequirement are
 * owned by @payswap/trust; re-exported here to preserve the Stage-0 surface.
 */
export { PROOF_LEVELS };
export type { ProofLevel, ProofRequirement };

/** Hard constraints run before soft optimization (AGENTS.md rule 14). */
export interface CapabilityCondition {
  readonly kind: "precondition" | "eligibility" | "jurisdiction" | "compliance";
  readonly description: string;
  readonly hardConstraint: boolean;
}

export interface CostComponent {
  readonly componentId: string;
  readonly kind: "fixed_fee" | "per_use_fee" | "variable_fee_bps";
  readonly amount?: AmountSpec;
  readonly bps?: bigint;
}

export interface RiskDescriptor {
  readonly riskClass: string;
  readonly severity: "low" | "medium" | "high";
  readonly mitigations: readonly string[];
}

export interface ProvenanceDescriptor {
  readonly declaredBy: string;
  readonly artifactRef: string;
  readonly contentHash: string;
}

/** Economic accountability metadata (W2-001 acceptance: must be available). */
export interface EconomicAccountability {
  readonly accountablePartyRef: string;
  readonly ledgerAccountRef: string;
  readonly recoursePolicyRef: string;
}

export interface BondCollateralRecourse {
  readonly bondAmount: AmountSpec;
  readonly collateralType: string;
  readonly recourseMechanism: string;
}

/** The universal ecosystem unit (§11). */
export interface Capability {
  readonly id: string;
  readonly capabilityClass: CapabilityClass;
  readonly conditions: readonly CapabilityCondition[];
  readonly cost: readonly CostComponent[];
  readonly risk: RiskDescriptor;
  readonly provenance: ProvenanceDescriptor;
  readonly economicAccountability: EconomicAccountability;
  readonly proofRequirements: readonly ProofRequirement[];
  readonly bondCollateralRecourse?: BondCollateralRecourse;
}

/** Terms under which a merchant accepts payments (§6A acceptance semantics). */
export interface AcceptanceTerms {
  readonly supportsRecurring: boolean;
  readonly supportsPartialPayments: boolean;
  readonly supportsRefunds: boolean;
  readonly recoursePolicyRef: string;
}

/**
 * AcceptanceCapability — first-class and distinct from any funding source
 * (§11: "merchant acceptance is distinct from funding source"). It extends the
 * base Capability metadata shape but fixes the class to 'merchant_acceptance'
 * and adds acceptance-specific terms. Funding is expressed by separate
 * capabilities of class liquidity/credit/lending — never by acceptance.
 */
export interface AcceptanceCapability extends Capability {
  readonly capabilityClass: "merchant_acceptance";
  readonly acceptedPaymentMethods: readonly string[];
  readonly acceptedCurrencies: readonly string[];
  readonly acceptedCountries: readonly string[];
  readonly terms: AcceptanceTerms;
  readonly settlementDestinationRef?: string;
}

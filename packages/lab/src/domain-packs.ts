/**
 * Lab Domain Packs and searchable building blocks (W2-004;
 * FROZEN-ARCHITECTURE §19; LAB.md "Domain Pack").
 *
 * A Domain Pack declares: domain, scenario types, hard constraints,
 * objectives, observables, action space, failure taxonomy, policy set,
 * evaluation suite and provenance requirements (LAB.md).
 *
 * The building-block index treats — as FIRST-CLASS SEARCHABLE BLOCKS —
 * certified smart-contract capabilities, ServiceAccessCapabilities, PSP
 * connector capabilities and participation mechanisms. Indexing is
 * DISCOVERY ONLY: a block in this index is a proposal ingredient, never
 * execution authority (INV-G03 discipline; AGENTS.md rule 5).
 *
 * Provider-backed executable selection happens in search.ts and is grounded
 * in ConnectedCapabilityInstance + CapabilityObservation — never in
 * catalogue definitions alone (INV-C05). This module indexes the static
 * vocabulary; search.ts indexes the live, account-scoped truth.
 */

import { isSearchableByLab } from "@payswap/capabilities";
import type {
  CertificationRecord,
  CapabilityClass,
  ServiceAccessCapability,
  SmartContractExtension,
} from "@payswap/capabilities";
import type { CapabilityDefinition } from "@payswap/connectors";
import type { HardConstraintId, ObjectiveId } from "./evaluator.js";
import { isHardConstraintId, isObjectiveId } from "./evaluator.js";

// ---------------------------------------------------------------------------
// Domain Pack (LAB.md "Domain Pack" — all ten declaration dimensions)
// ---------------------------------------------------------------------------

export const LAB_SCENARIO_TYPE_IDS = [
  "NORMAL_DEMAND",
  "LIQUIDITY_SHORTAGE",
  "PROVIDER_OUTAGE",
  "FX_VOLATILITY",
  "DELAYED_WRITE",
  "APPROVAL_DELAY",
  "FRAUD",
  "COLLUSION",
  "MALICIOUS_AGENT",
  "INCENTIVE_GAMING",
  "PARTIAL_PAYMENT",
  "CONGESTION",
  "ADVERSARIAL_MODEL_BEHAVIOR",
] as const;
export type LabScenarioTypeId = (typeof LAB_SCENARIO_TYPE_IDS)[number];

export function isLabScenarioTypeId(
  value: unknown,
): value is LabScenarioTypeId {
  return (
    typeof value === "string" &&
    (LAB_SCENARIO_TYPE_IDS as readonly unknown[]).includes(value)
  );
}

/** One dimension of the pack's action space. */
export interface ActionDimension {
  readonly dimensionId: string;
  readonly description: string;
  readonly domain: readonly string[];
}

/** Reference to an evaluation suite (the baseline suite lives in scenarios.ts). */
export interface EvaluationSuiteRef {
  readonly suiteId: string;
  readonly version: string;
}

/** Provenance requirement for evidence used inside this domain. */
export interface ProvenanceRequirement {
  readonly requirementId: string;
  readonly description: string;
  /** Canonical evidence kinds consolidated by @payswap/capabilities. */
  readonly acceptedEvidenceKinds: readonly string[];
}

export interface DomainPack {
  readonly packId: string;
  readonly version: string;
  readonly domain: string;
  readonly scenarioTypes: readonly LabScenarioTypeId[];
  readonly hardConstraints: readonly HardConstraintId[];
  readonly objectives: readonly ObjectiveId[];
  readonly observables: readonly string[];
  readonly actionSpace: readonly ActionDimension[];
  readonly failureTaxonomy: readonly string[];
  readonly policySet: readonly string[];
  readonly evaluationSuite: EvaluationSuiteRef;
  readonly provenanceRequirements: readonly ProvenanceRequirement[];
}

/** Raised when a Domain Pack declaration is incomplete or inconsistent. */
export class DomainPackValidationError extends Error {
  readonly errors: readonly string[];

  constructor(errors: readonly string[]) {
    super(`Invalid domain pack: ${errors.join("; ")}`);
    this.name = "DomainPackValidationError";
    this.errors = errors;
  }
}

export function validateDomainPack(candidate: DomainPack): void {
  const errors: string[] = [];
  if (candidate.packId.length === 0) {
    errors.push("packId must not be empty");
  }
  if (!/^\d+\.\d+\.\d+$/.test(candidate.version)) {
    errors.push(`version '${candidate.version}' must be semver-like`);
  }
  if (candidate.domain.length === 0) {
    errors.push("domain must not be empty");
  }
  if (candidate.scenarioTypes.length === 0) {
    errors.push("scenarioTypes must not be empty");
  }
  for (const scenarioType of candidate.scenarioTypes) {
    if (!isLabScenarioTypeId(scenarioType)) {
      errors.push(`unknown scenario type '${String(scenarioType)}'`);
    }
  }
  if (candidate.hardConstraints.length === 0) {
    errors.push("a domain pack must declare at least one hard constraint");
  }
  for (const constraint of candidate.hardConstraints) {
    if (!isHardConstraintId(constraint)) {
      errors.push(`unknown hard constraint '${String(constraint)}'`);
    }
  }
  for (const objective of candidate.objectives) {
    if (!isObjectiveId(objective)) {
      errors.push(`unknown objective '${String(objective)}'`);
    }
  }
  if (candidate.evaluationSuite.suiteId.length === 0) {
    errors.push("evaluationSuite.suiteId must not be empty");
  }
  if (errors.length > 0) {
    throw new DomainPackValidationError(errors);
  }
}

/** In-memory Domain Pack registry (deterministic registration order). */
export class DomainPackRegistry {
  private readonly packs = new Map<string, DomainPack>();

  register(pack: DomainPack): DomainPack {
    validateDomainPack(pack);
    if (this.packs.has(pack.packId)) {
      throw new DomainPackValidationError([
        `pack '${pack.packId}' is already registered`,
      ]);
    }
    this.packs.set(pack.packId, pack);
    return pack;
  }

  get(packId: string): DomainPack | undefined {
    return this.packs.get(packId);
  }

  /** Deterministic listing: registration order. */
  list(): readonly DomainPack[] {
    return [...this.packs.values()];
  }
}

// ---------------------------------------------------------------------------
// Searchable building blocks (LAB.md Lab responsibilities; FROZEN §11/§288)
// ---------------------------------------------------------------------------

export const LAB_BUILDING_BLOCK_KINDS = [
  "CERTIFIED_SMART_CONTRACT",
  "SERVICE_ACCESS",
  "CONNECTOR_CAPABILITY",
  "PARTICIPATION_MECHANISM",
] as const;
export type LabBuildingBlockKind = (typeof LAB_BUILDING_BLOCK_KINDS)[number];

/** A certified smart-contract capability as a searchable block. */
export interface CertifiedSmartContractBlock {
  readonly blockKind: "CERTIFIED_SMART_CONTRACT";
  readonly blockId: string;
  readonly version: string;
  readonly capabilityClass: CapabilityClass;
  /** The declared smart-contract extension (INV-SC01 shape). */
  readonly extension: SmartContractExtension;
  /** The certification record that made this block searchable. */
  readonly certification: CertificationRecord;
}

/** A ServiceAccessCapability as a searchable block (W2-003). */
export interface ServiceAccessBlock {
  readonly blockKind: "SERVICE_ACCESS";
  readonly blockId: string;
  readonly version: string;
  readonly capability: ServiceAccessCapability;
}

/**
 * A PSP connector capability DEFINITION as a searchable block. This is the
 * static vocabulary; executable selection additionally requires a
 * ConnectedCapabilityInstance + CapabilityObservation (INV-C05) — see
 * search.ts.
 */
export interface ConnectorCapabilityBlock {
  readonly blockKind: "CONNECTOR_CAPABILITY";
  readonly blockId: string;
  readonly version: string;
  readonly definition: CapabilityDefinition;
  readonly certification: CertificationRecord;
}

/**
 * A participation mechanism (incentive design) as a searchable block.
 * Participation programs are versioned artifacts (INV-P07); the Lab treats
 * them as discoverable building blocks for mechanism search.
 */
export interface ParticipationMechanismBlock {
  readonly blockKind: "PARTICIPATION_MECHANISM";
  readonly blockId: string;
  readonly version: string;
  readonly description: string;
  /** e.g. 'rewards', 'reputation-projection', 'expert-matching'. */
  readonly incentiveKinds: readonly string[];
  /** Versioned reward-model reference (INV-P03 reproducibility). */
  readonly rewardModelRef: string;
}

export type LabBuildingBlock =
  | CertifiedSmartContractBlock
  | ServiceAccessBlock
  | ConnectorCapabilityBlock
  | ParticipationMechanismBlock;

/** Why a block registration was refused. */
export type BlockRegistrationRejection =
  | "SMART_CONTRACT_NOT_SEARCHABLE"
  | "CERTIFICATION_NOT_ACTIVE"
  | "CERTIFICATION_SUBJECT_MISMATCH"
  | "DUPLICATE_BLOCK_ID";

export type BlockRegistrationResult =
  | { readonly status: "REGISTERED"; readonly block: LabBuildingBlock }
  | { readonly status: "REJECTED"; readonly reason: BlockRegistrationRejection; readonly detail: string };

/** Raised when a query uses an unknown block kind. */
export class LabBuildingBlockIndexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LabBuildingBlockIndexError";
  }
}

/**
 * The Lab's searchable building-block index. Deterministic: registration
 * order is preserved; queries return blocks in registration order.
 */
export class LabBuildingBlockIndex {
  private readonly blocks = new Map<string, LabBuildingBlock>();

  /**
   * Registers a certified smart-contract block. Searchability is gated by
   * the carrying capability's CERTIFIED status AND the extension's declared
   * flag (isSearchableByLab, FROZEN §288: "becomes searchable by the Lab
   * after certification"). A searchability flag is discovery, never
   * execution authority.
   */
  registerCertifiedSmartContract(input: {
    blockId: string;
    version: string;
    capabilityClass: CapabilityClass;
    extension: SmartContractExtension;
    certification: CertificationRecord;
  }): BlockRegistrationResult {
    if (this.blocks.has(input.blockId)) {
      return {
        status: "REJECTED",
        reason: "DUPLICATE_BLOCK_ID",
        detail: `block '${input.blockId}' already registered`,
      };
    }
    if (input.certification.subject.subjectId !== input.blockId) {
      return {
        status: "REJECTED",
        reason: "CERTIFICATION_SUBJECT_MISMATCH",
        detail: `certification subject '${input.certification.subject.subjectId}' does not match block '${input.blockId}'`,
      };
    }
    if (input.certification.status !== "CERTIFIED") {
      return {
        status: "REJECTED",
        reason: "CERTIFICATION_NOT_ACTIVE",
        detail: `certification status is '${input.certification.status}', not CERTIFIED`,
      };
    }
    if (!isSearchableByLab(input.extension, input.certification.status)) {
      return {
        status: "REJECTED",
        reason: "SMART_CONTRACT_NOT_SEARCHABLE",
        detail:
          "extension did not declare searchableByLabAfterCertification (or is not CERTIFIED)",
      };
    }
    const block: CertifiedSmartContractBlock = {
      blockKind: "CERTIFIED_SMART_CONTRACT",
      blockId: input.blockId,
      version: input.version,
      capabilityClass: input.capabilityClass,
      extension: input.extension,
      certification: input.certification,
    };
    this.blocks.set(input.blockId, block);
    return { status: "REGISTERED", block };
  }

  /** Registers a ServiceAccessCapability block. */
  registerServiceAccess(input: {
    blockId: string;
    version: string;
    capability: ServiceAccessCapability;
  }): BlockRegistrationResult {
    if (this.blocks.has(input.blockId)) {
      return {
        status: "REJECTED",
        reason: "DUPLICATE_BLOCK_ID",
        detail: `block '${input.blockId}' already registered`,
      };
    }
    if (input.capability.id !== input.blockId) {
      return {
        status: "REJECTED",
        reason: "CERTIFICATION_SUBJECT_MISMATCH",
        detail: `capability id '${input.capability.id}' does not match block '${input.blockId}'`,
      };
    }
    const block: ServiceAccessBlock = {
      blockKind: "SERVICE_ACCESS",
      blockId: input.blockId,
      version: input.version,
      capability: input.capability,
    };
    this.blocks.set(input.blockId, block);
    return { status: "REGISTERED", block };
  }

  /**
   * Registers a connector capability DEFINITION block (static vocabulary).
   * Executable grounding (instance + observation) is enforced by search.ts.
   */
  registerConnectorCapability(input: {
    definition: CapabilityDefinition;
    certification: CertificationRecord;
  }): BlockRegistrationResult {
    const blockId = input.definition.capabilityId;
    if (this.blocks.has(blockId)) {
      return {
        status: "REJECTED",
        reason: "DUPLICATE_BLOCK_ID",
        detail: `block '${blockId}' already registered`,
      };
    }
    if (input.certification.status !== "CERTIFIED") {
      return {
        status: "REJECTED",
        reason: "CERTIFICATION_NOT_ACTIVE",
        detail: `certification status is '${input.certification.status}', not CERTIFIED`,
      };
    }
    if (
      input.certification.subject.subjectId !== blockId ||
      input.certification.subject.version !== input.definition.capabilityVersion
    ) {
      return {
        status: "REJECTED",
        reason: "CERTIFICATION_SUBJECT_MISMATCH",
        detail: `certification subject '${input.certification.subject.subjectId}@${input.certification.subject.version}' does not match definition '${blockId}@${input.definition.capabilityVersion}'`,
      };
    }
    const block: ConnectorCapabilityBlock = {
      blockKind: "CONNECTOR_CAPABILITY",
      blockId,
      version: input.definition.capabilityVersion,
      definition: input.definition,
      certification: input.certification,
    };
    this.blocks.set(blockId, block);
    return { status: "REGISTERED", block };
  }

  /** Registers a participation mechanism block. */
  registerParticipationMechanism(input: {
    blockId: string;
    version: string;
    description: string;
    incentiveKinds: readonly string[];
    rewardModelRef: string;
  }): BlockRegistrationResult {
    if (this.blocks.has(input.blockId)) {
      return {
        status: "REJECTED",
        reason: "DUPLICATE_BLOCK_ID",
        detail: `block '${input.blockId}' already registered`,
      };
    }
    const block: ParticipationMechanismBlock = {
      blockKind: "PARTICIPATION_MECHANISM",
      blockId: input.blockId,
      version: input.version,
      description: input.description,
      incentiveKinds: [...input.incentiveKinds],
      rewardModelRef: input.rewardModelRef,
    };
    this.blocks.set(input.blockId, block);
    return { status: "REGISTERED", block };
  }

  get(blockId: string): LabBuildingBlock | undefined {
    return this.blocks.get(blockId);
  }

  /** Deterministic listing (registration order), optionally by kind. */
  query(filter?: {
    blockKind?: LabBuildingBlockKind;
    capabilityClass?: CapabilityClass;
  }): readonly LabBuildingBlock[] {
    const all = [...this.blocks.values()];
    return all.filter((block) => {
      if (filter?.blockKind !== undefined && block.blockKind !== filter.blockKind) {
        return false;
      }
      if (filter?.capabilityClass !== undefined) {
        if (
          block.blockKind === "CERTIFIED_SMART_CONTRACT" &&
          block.capabilityClass !== filter.capabilityClass
        ) {
          return false;
        }
        if (
          block.blockKind === "SERVICE_ACCESS" &&
          block.capability.capabilityClass !== filter.capabilityClass
        ) {
          return false;
        }
      }
      return true;
    });
  }
}

// ---------------------------------------------------------------------------
// The canonical payment-routing Domain Pack used by the baseline suite
// ---------------------------------------------------------------------------

export const BASELINE_SUITE_ID = "lab.baseline-suite";
export const BASELINE_SUITE_VERSION = "1.0.0";

/**
 * The canonical payment-routing Domain Pack. Hard constraints
 * (AUTHORIZATION/COMPLIANCE/PRIVACY/DEADLINE/EXPLICIT_CREDIT) are evaluated
 * BEFORE the optimization objectives (AGENTS.md rule 14); objectives follow
 * LAB.md "Evaluation" (total cost, economic compression, resilience,
 * latency, liquidity, counterparty exposure, operational complexity).
 */
export const PAYMENT_ROUTING_DOMAIN_PACK: DomainPack = {
  packId: "lab.domain-pack.payment-routing",
  version: "1.0.0",
  domain: "payment-routing",
  scenarioTypes: [...LAB_SCENARIO_TYPE_IDS],
  hardConstraints: [
    "AUTHORIZATION",
    "COMPLIANCE",
    "PRIVACY",
    "DEADLINE",
    "EXPLICIT_CREDIT",
  ],
  objectives: [
    "TOTAL_COST",
    "ECONOMIC_COMPRESSION",
    "RESILIENCE",
    "LATENCY",
    "LIQUIDITY_LOCKED",
    "COUNTERPARTY_EXPOSURE",
    "OPERATIONAL_COMPLEXITY",
  ],
  observables: [
    "externalValueMovedMinor",
    "nettedInternallyMinor",
    "hops",
    "liquidityLockedMinor",
    "feesMinor",
    "fxSpreadPaidMinor",
    "totalLatencyMs",
    "degradedRouteExposureMinor",
    "creditExposureMinor",
    "unknownOutcomes",
    "adversarialSettled",
    "authorizationBypassEvents",
    "privacyViolations",
  ],
  actionSpace: [
    {
      dimensionId: "route-preference",
      description: "ordered preference over payment rails",
      domain: ["rail-a", "rail-b", "rail-c", "rail-d"],
    },
    {
      dimensionId: "netting",
      description: "co-directional batching within the delay window",
      domain: ["enabled", "disabled"],
    },
    {
      dimensionId: "network-credit",
      description: "explicit network credit for liquidity gaps (INV-F08)",
      domain: ["enabled", "disabled"],
    },
    {
      dimensionId: "delay-tolerance",
      description: "steps a demand may be deferred for batching",
      domain: ["0", "1", "2", "3"],
    },
    {
      dimensionId: "adversarial-screening",
      description: "fraud/collusion/malicious/gaming screening",
      domain: ["enabled", "disabled"],
    },
    {
      dimensionId: "privacy-bound",
      description: "minimum-context routing (INV-R02)",
      domain: ["bounded", "unbounded"],
    },
  ],
  failureTaxonomy: [
    "FAILED_NO_VIABLE_ROUTE",
    "UNKNOWN_REQUIRES_RECONCILIATION",
    "USER_ACTION_REQUIRED",
    "BLOCKED_FRAUD",
    "EXPIRED",
    "HARD_CONSTRAINT_VIOLATION",
  ],
  policySet: [
    "policy:protocol-authorization-required",
    "policy:adversarial-screening-required",
    "policy:privacy-minimum-context",
    "policy:credit-must-be-explicit",
  ],
  evaluationSuite: {
    suiteId: BASELINE_SUITE_ID,
    version: BASELINE_SUITE_VERSION,
  },
  provenanceRequirements: [
    {
      requirementId: "simulation-seed-provenance",
      description: "every simulation result records its seed and program version",
      acceptedEvidenceKinds: ["TEST_RUN", "REPLAY"],
    },
    {
      requirementId: "promotion-evidence-provenance",
      description: "replay, counterfactual and robustness evidence are content-hashed",
      acceptedEvidenceKinds: ["REPLAY", "PROOF", "ATTESTATION"],
    },
    {
      requirementId: "connector-executable-grounding",
      description:
        "provider-backed selection is grounded in ConnectedCapabilityInstance + CapabilityObservation (INV-C05)",
      acceptedEvidenceKinds: ["ATTESTATION"],
    },
  ],
};

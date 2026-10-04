/**
 * The opportunity-discovery Lab composition harness (Work Order P4-W3-002
 * hard requirement 4).
 *
 * TEST-LAYER BY LAW (repository-wide INV-L01 discipline): no other
 * package's src/** imports the Lab runtime. This harness is the test-layer
 * driver for opportunity discovery, following the P4-W3-001 mixed-rail
 * harness pattern:
 * - the six opportunity families register as SEARCHABLE CAPABILITIES by
 *   compiling the pure-data family descriptors (src/lab-registration.ts)
 *   into REAL CapabilityDefinition shapes in the Lab search index;
 * - the Lab's own executable-block law (INV-C05) applies UNCHANGED: an
 *   opportunity family is a catalogue entry with NO connected instance, so
 *   it can never produce an executable block — discovery results are
 *   searchable but never executable;
 * - an opportunity-discovery search plug-in registers behind the Lab's
 *   replaceable plug-in registry and emits candidates ONLY when grounded
 *   in executable blocks (never from opportunity catalogue entries);
 * - a Lab candidate organization composed over discovery results carries
 *   the OPPORTUNITY_DISCOVERY_NON_PRODUCTION_CONSTRAINT as a domain hard
 *   constraint (the never-production-execution law extended to discovery
 *   results) and the structural discovery tier gate rejects it for
 *   execution.
 *
 * Nothing here re-implements a kernel or Lab surface: the REAL Lab search
 * index, search plug-in registry and proposal-only composer are driven
 * as-is.
 */

import type { VersionedRef, AgentBody, AgentPrincipalRef } from "@payswap/agents";
import type {
  CapabilityDefinition,
  CapabilityObservation,
  ConnectedCapabilityInstance,
} from "@payswap/connectors";
import { observeCapability } from "@payswap/connectors";
import {
  buildLabSearchIndex,
  composeCandidateOrganization,
  selectExecutableBlocks,
} from "@payswap/lab";
import type {
  DomainPack,
  LabSearchIndex,
  LabSearchInput,
  LabSearchPlugin,
  SearchedCandidate,
  SimulatedWorld,
} from "@payswap/lab";
import {
  OPPORTUNITY_DISCOVERY_NON_PRODUCTION_CONSTRAINT,
  opportunityFamilyCapabilities,
} from "../src/index.js";
import type { FinancialOpportunity } from "../src/index.js";

// ---------------------------------------------------------------------------
// Agent fixtures (candidate composition inputs — obviously synthetic)
// ---------------------------------------------------------------------------

export const CANDIDATE_BODY_REF: VersionedRef<AgentBody> = {
  id: "body.opportunity-discovery-agent",
  version: 1,
};

export const CANDIDATE_PRINCIPAL: AgentPrincipalRef = {
  agentKeyFingerprint: "sha256:labopportunityfingerprint",
  ownerRef: "owner-1",
};

// ---------------------------------------------------------------------------
// The opportunity-discovery domain pack (the Lab's Domain Pack dimensions)
// ---------------------------------------------------------------------------

export const OPPORTUNITY_DISCOVERY_DOMAIN_PACK: DomainPack = {
  packId: "lab.domain-pack.opportunity-discovery",
  version: "1.0.0",
  domain: "opportunity-discovery",
  scenarioTypes: ["NORMAL_DEMAND", "PROVIDER_OUTAGE", "FX_VOLATILITY", "CONGESTION"],
  hardConstraints: ["AUTHORIZATION", "COMPLIANCE", "PRIVACY", "EXPLICIT_CREDIT"],
  objectives: ["TOTAL_COST", "RESILIENCE", "OPERATIONAL_COMPLEXITY"],
  observables: [
    "externalValueMovedMinor",
    "feesMinor",
    "unknownOutcomes",
    "staleOpportunityObservations",
    "ineligibleOpportunitiesSurfaced",
  ],
  actionSpace: [
    {
      dimensionId: "family-scope",
      description: "which opportunity families the discovery survey covers",
      domain: ["liquidity", "lending", "staking", "incentives", "arbitrage", "other"],
    },
    {
      dimensionId: "adversarial-screening",
      description: "fraud/manipulation/honeypot screening of discovery results",
      domain: ["enabled", "disabled"],
    },
  ],
  failureTaxonomy: [
    "STALE_OBSERVATION",
    "SUSPECT_RETURN_OUTSIDE_PLAUSIBLE_BAND",
    "EXIT_PATH_SUSPECT_HONEYPOT",
    "WITHDRAWAL_LIQUIDITY_VANISHED",
    "HARD_CONSTRAINT_VIOLATION",
  ],
  policySet: [
    "policy:discovery-never-authorization",
    "policy:no-guaranteed-returns-language",
    "policy:lab-simulation-never-production",
  ],
  evaluationSuite: {
    suiteId: "lab.opportunity-discovery-suite",
    version: "1.0.0",
  },
  provenanceRequirements: [
    {
      requirementId: "opportunity-observation-law",
      description:
        "every discovery result carries evidence freshness, venue/adapter/observer provenance and a non-empty evidence chain (the onchain-domain observation law)",
      acceptedEvidenceKinds: ["ATTESTATION", "TEST_RUN"],
    },
    {
      requirementId: "discovery-never-authorization-provenance",
      description:
        "every Lab-side composition of discovery results carries the non-production constraint and the structural discovery tier",
      acceptedEvidenceKinds: ["TEST_RUN"],
    },
  ],
};

// ---------------------------------------------------------------------------
// Family capability registration (searchable capabilities, INV-C05)
// ---------------------------------------------------------------------------

/**
 * Compiles the six family capability descriptors into REAL
 * CapabilityDefinition shapes (kind SEARCH — a discovery capability, never
 * a write capability). Mirrors the canonical definition fixture shape the
 * Lab search index consumes.
 */
export function opportunityFamilyCapabilityDefinitions(): readonly CapabilityDefinition[] {
  return opportunityFamilyCapabilities().map((descriptor) => {
    const definition: CapabilityDefinition = {
      capabilityId: descriptor.capabilityId,
      capabilityVersion: "1.0.0",
      summary: descriptor.summary,
      kind: "SEARCH",
      requiredPermissions: ["opportunities:read"],
      executionModes: ["PASS_THROUGH_NATIVE", "COMPOSED_PAYSWAP", "OPTIMIZED_MULTI_PROVIDER"],
      semantics: {
        operation: "opportunities.observe",
        stateMachine: { documentRef: "sm:opportunities", version: "1.0.0" },
        description: "observe financial opportunities from adapter-sourced evidence chains",
      },
      preconditions: ["fresh adapter observations with verified evidence chains"],
      authorization: {
        protocolAuthorization: true,
        requiredScopes: ["opportunities:read"],
        customerConsent: "IMPLICIT",
      },
      sideEffects: [],
      idempotency: {
        idempotent: true,
        keyScope: "REQUEST",
        duplicateBehavior: "RETURNED_SAME_RESULT",
        retryPolicy: "SAFE_TO_RETRY",
      },
      compensation: {
        compensable: false,
        cancellation: "BEFORE_EXECUTION",
        partialExecution: {
          possible: false,
          granularity: "LINE_ITEM",
          onPartial: "DISCLOSED",
        },
      },
      requiredCustomerActions: [],
      providerVocabulary: {
        actions: [{ action: "observe", description: "observe an opportunity family" }],
        states: [],
      },
      externalObjects: [
        { objectType: "opportunity_observation", idFormat: "obs:[a-z0-9:-]+", revisioned: false },
      ],
      evidence: {
        produced: ["STATE_OBSERVATION"],
        required: ["AUTHORIZATION"],
      },
      economics: {
        feeModel: "NONE",
        limits: [
          {
            dimension: "COUNT",
            description: "read-only discovery surface (no execution limits — discovery is never execution)",
          },
        ],
        settlementImplications: "none — discovery is never settlement",
      },
      constraints: [],
    };
    return Object.freeze(definition);
  });
}

/**
 * The Lab search index holding the six family capability definitions and
 * NOTHING else: no connected instances, no observations. This is the
 * registration surface — searchable catalogue entries, exactly the shape
 * INV-C05 treats as never-executable.
 */
export function opportunityDiscoverySearchIndex(): LabSearchIndex {
  return buildLabSearchIndex({
    definitions: [...opportunityFamilyCapabilityDefinitions()],
  });
}

// ---------------------------------------------------------------------------
// The opportunity-discovery search plug-in (behind the Lab registry)
// ---------------------------------------------------------------------------

/**
 * Creates the opportunity-discovery search plug-in: it emits a discovery
 * survey candidate ONLY when the input carries executable blocks (INV-C05:
 * candidates are grounded in connected instances + current observations,
 * never in opportunity catalogue entries). With only opportunity family
 * definitions registered, it honestly emits NOTHING.
 */
export function createOpportunityDiscoverySearchPlugin(
  discovered?: readonly FinancialOpportunity[],
): LabSearchPlugin {
  return {
    pluginId: "opportunity-discovery",
    description:
      "opportunity family discovery survey: emits a survey candidate only when grounded in executable blocks (INV-C05) — never from opportunity catalogue entries",
    search(input: LabSearchInput): readonly SearchedCandidate[] {
      if (input.executableBlocks.length === 0) {
        // Honest empty state: no executable grounding, no candidates.
        return [];
      }
      const survey: SearchedCandidate = {
        candidateId: "search.opportunity-discovery:family-survey",
        origin: "opportunity-discovery",
        executionMode: "COMPOSED_PAYSWAP",
        program: {
          programId: "search.opportunity-discovery.family-survey",
          programVersion: "1.0.0",
          routePreference: [],
          useNetting: false,
          useNetworkCredit: false,
          delayToleranceSteps: 0,
          fraudScreening: true,
          privacyBounded: true,
          authorizationMode: "PROTOCOL_AUTHORIZED",
        },
        instanceRefs: input.executableBlocks.map((block) => block.instance.instanceId),
        isIncumbentBaseline: false,
      };
      return Object.freeze([
        survey,
        ...(discovered ?? []).map((opportunity) =>
          discoveryEvidenceCandidate(opportunity, input),
        ),
      ]);
    },
  };
}

/**
 * One Lab-side evidence candidate per discovered opportunity: pure data
 * referencing the family capability id — grounded in the executable blocks
 * the survey depends on (never a claim to execute the opportunity).
 */
function discoveryEvidenceCandidate(
  opportunity: FinancialOpportunity,
  input: LabSearchInput,
): SearchedCandidate {
  return {
    candidateId: `search.opportunity-discovery:evidence:${opportunity.opportunityId}`,
    origin: "opportunity-discovery",
    executionMode: "COMPOSED_PAYSWAP",
    program: {
      programId: `search.opportunity-discovery.evidence.${opportunity.family}`,
      programVersion: "1.0.0",
      routePreference: [],
      useNetting: false,
      useNetworkCredit: false,
      delayToleranceSteps: 0,
      fraudScreening: true,
      privacyBounded: true,
      authorizationMode: "PROTOCOL_AUTHORIZED",
    },
    instanceRefs: input.executableBlocks.map((block) => block.instance.instanceId),
    isIncumbentBaseline: false,
  };
}

// ---------------------------------------------------------------------------
// Lab candidate composition over discovery results
// ---------------------------------------------------------------------------

/**
 * Composes a candidate organization whose building blocks are the six
 * opportunity family capability ids. The organization DRAFT is composed by
 * the Lab's own proposal-only composer with the non-production constraint
 * as the FIRST domain hard constraint (the never-production-execution law
 * extended to discovery results).
 */
export function composeDiscoveryCandidate(input: {
  readonly candidateId: string;
  readonly title: string;
  readonly discovered: readonly FinancialOpportunity[];
}): { readonly organization: ReturnType<typeof composeCandidateOrganization> } {
  const buildingBlocks = Object.freeze(
    input.discovered.map((opportunity) => ({
      blockKind: "CONNECTOR_CAPABILITY" as const,
      blockId: `opportunity-capability:${opportunity.family}`,
      version: "1.0.0",
    })),
  );
  const organization = composeCandidateOrganization({
    candidateId: input.candidateId,
    domainPackId: OPPORTUNITY_DISCOVERY_DOMAIN_PACK.packId,
    body: CANDIDATE_BODY_REF,
    principal: CANDIDATE_PRINCIPAL,
    domainHardConstraints: [
      OPPORTUNITY_DISCOVERY_NON_PRODUCTION_CONSTRAINT,
      "policy:discovery-never-authorization",
      "policy:no-guaranteed-returns-language",
    ],
    buildingBlocks,
    evaluationSuiteRef: OPPORTUNITY_DISCOVERY_DOMAIN_PACK.evaluationSuite.suiteId,
  });
  return { organization };
}

// ---------------------------------------------------------------------------
// A minimal Lab world + one REAL executable block (the INV-C05 contrast)
// ---------------------------------------------------------------------------

/** A minimal simulated world (one rail) for the plug-in grounding contrast. */
export function discoveryWorld(): SimulatedWorld {
  return {
    worldId: "opportunity-discovery:world-1",
    baseCurrency: "USD",
    stepLatencyMs: 1000,
    rails: [
      {
        railId: "rail-discovery-a",
        currency: "USD",
        latencyMs: 500,
        fixedFeeMinor: 30n,
        variableFeeBps: 10n,
      },
    ],
    pools: [{ poolId: "pool-discovery-a", railId: "rail-discovery-a", availableMinor: 1_000_000n }],
  };
}

/** A real connected instance + observation for one non-opportunity capability. */
function groundedNonOpportunityCapability(): {
  readonly definition: CapabilityDefinition;
  readonly instance: ConnectedCapabilityInstance;
  readonly observation: CapabilityObservation;
} {
  const definition: CapabilityDefinition = {
    capabilityId: "psp.discovery-feed",
    capabilityVersion: "1.0.0",
    summary: "provider discovery feed read capability",
    kind: "READ",
    requiredPermissions: ["opportunities:read"],
    executionModes: ["PASS_THROUGH_NATIVE"],
    semantics: {
      operation: "opportunities.read_feed",
      stateMachine: { documentRef: "sm:opportunities", version: "1.0.0" },
      description: "read a provider discovery feed",
    },
    preconditions: ["connected account ACTIVE"],
    authorization: {
      protocolAuthorization: true,
      requiredScopes: ["opportunities:read"],
      customerConsent: "IMPLICIT",
    },
    sideEffects: [],
    idempotency: {
      idempotent: true,
      keyScope: "REQUEST",
      duplicateBehavior: "RETURNED_SAME_RESULT",
      retryPolicy: "SAFE_TO_RETRY",
    },
    compensation: {
      compensable: false,
      cancellation: "BEFORE_EXECUTION",
      partialExecution: { possible: false, granularity: "LINE_ITEM", onPartial: "DISCLOSED" },
    },
    requiredCustomerActions: [],
    providerVocabulary: {
      actions: [{ action: "read", description: "read the discovery feed" }],
      states: [],
    },
    externalObjects: [],
    evidence: { produced: ["STATE_OBSERVATION"], required: ["AUTHORIZATION"] },
    economics: {
      feeModel: "NONE",
      limits: [
        { dimension: "COUNT", description: "read-only feed (no execution limits)" },
      ],
      settlementImplications: "none",
    },
    constraints: [],
  };
  const instance: ConnectedCapabilityInstance = {
    instanceId: "instance:discovery-feed:1",
    capabilityId: definition.capabilityId,
    implementationId: `${definition.capabilityId}:impl:1`,
    providerName: "psp-mock",
    providerVersion: "2024-01",
    accountRef: "acct-discovery-1",
    tenantRef: "tenant-discovery-1",
    authorization: {
      status: "ACTIVE",
      grantedAt: "2026-01-01T00:00:00Z",
    },
    credentialScope: {
      credentialRef: "cred-discovery-1",
      credentialKind: "API_KEY",
    },
    geography: { countries: ["US"] },
    currencies: ["USD"],
    permissionState: {
      granted: ["opportunities:read"],
      requested: ["opportunities:read"],
      missing: [],
    },
    eligibility: { eligible: true, reasons: [] },
    configuration: { simulatedRailId: "rail-discovery-a" },
  };
  const observation = observeCapability({
    instanceId: instance.instanceId,
    observedAt: "2026-10-01T00:00:00Z",
    observationVersion: 1,
    capabilityState: "AVAILABLE",
    sourceAvailability: "REACHABLE",
    eligibility: "ELIGIBLE",
    health: { status: "HEALTHY", lastCheckedAt: "2026-10-01T00:00:00Z" },
    provenance: {
      providerName: "psp-mock",
      source: "PROVIDER_API",
      capturedAt: "2026-10-01T00:00:00Z",
    },
  });
  return { definition, instance, observation };
}

/**
 * The INV-C05 contrast index: the six opportunity family definitions PLUS
 * one REAL grounded (definition + instance + observation) capability. The
 * Lab search will return the opportunity families as REJECTED
 * CATALOGUE_ENTRY_ONLY and exactly one executable block — never an
 * opportunity-family block.
 */
export function contrastSearchIndex(): LabSearchIndex {
  const grounded = groundedNonOpportunityCapability();
  return buildLabSearchIndex({
    definitions: [...opportunityFamilyCapabilityDefinitions(), grounded.definition],
    instances: [grounded.instance],
    observations: [grounded.observation],
  });
}

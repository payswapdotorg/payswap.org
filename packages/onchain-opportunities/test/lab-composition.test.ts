import { describe, expect, it } from "vitest";
import {
  LAB_PROPOSAL_ONLY_CONSTRAINT,
  registerSearchPlugin,
  runSearchPlugin,
  selectExecutableBlocks,
} from "@payswap/lab";
import {
  DiscoveryExecutionRejectedError,
  OPPORTUNITY_DISCOVERY_NON_PRODUCTION_CONSTRAINT,
  opportunityFamilyCapabilities,
  opportunityFamilyCapabilityId,
  rejectDiscoveryForExecution,
  validateOpportunityFamilyCapability,
} from "../src/index.js";
import { discoverOpportunity } from "../src/index.js";
import {
  NOW,
  discoveryCatalog,
  healthyLiquidityObservation,
} from "./fixtures.js";
import {
  OPPORTUNITY_DISCOVERY_DOMAIN_PACK,
  composeDiscoveryCandidate,
  contrastSearchIndex,
  createOpportunityDiscoverySearchPlugin,
  discoveryWorld,
  opportunityDiscoverySearchIndex,
} from "./opportunity-lab-harness.js";

/**
 * P4-W3-002 hard requirement 4 (the Lab composition): opportunities are
 * searchable by the Lab — the P4-W3-001 Organization/Strategy/Capability
 * search surfaces compose with opportunity family registration — and the
 * Lab's never-production-execution law extends to discovery results.
 *
 * All proofs drive the REAL Lab model from the test layer (INV-L01):
 * - the six families register as searchable capability definitions;
 * - the Lab's own search (INV-C05) returns every family as REJECTED
 *   CATALOGUE_ENTRY_ONLY — a catalogue entry can never yield an executable
 *   block, so discovery results are searchable but NEVER executable;
 * - the opportunity-discovery plug-in emits nothing unless grounded in
 *   executable blocks;
 * - a Lab candidate composed over discovery results carries the
 *   non-production constraint (and the Lab's own proposal-only constraint)
 *   and is rejected by the discovery execution gate.
 */
describe("P4-W3-002 the Lab composition (searchable, never executable)", () => {
  it("the six families register as searchable capabilities with deterministic capability ids", () => {
    const capabilities = opportunityFamilyCapabilities();
    expect(capabilities).toHaveLength(6);
    for (const capability of capabilities) {
      expect(capability.capabilityId).toBe(opportunityFamilyCapabilityId(capability.family));
      expect(capability.discoveryAuthority).toBe("NONE");
      expect(() => validateOpportunityFamilyCapability(capability)).not.toThrow();
    }
    expect(capabilities.map((capability) => capability.family)).toEqual([
      "liquidity",
      "lending",
      "staking",
      "incentives",
      "arbitrage",
      "other",
    ]);
  });

  it("the family descriptors are searchable text surfaces free of guarantee vocabulary", () => {
    for (const capability of opportunityFamilyCapabilities()) {
      expect(capability.summary.length).toBeGreaterThan(0);
      expect(capability.summary).not.toMatch(/guarantee/i);
      expect(capability.summary).not.toMatch(/risk[-\s]?free/i);
      expect(capability.summary).not.toMatch(/assured/i);
      for (const term of capability.searchableTerms) {
        expect(term.length).toBeGreaterThan(0);
      }
    }
  });

  it("the capability validator fails closed on a forged authority claim", () => {
    const [first] = opportunityFamilyCapabilities();
    if (first === undefined) {
      throw new Error("fixture family capability missing");
    }
    const forged = { ...first, discoveryAuthority: "EXECUTE" };
    expect(() => validateOpportunityFamilyCapability(forged)).toThrow(/discoveryAuthority/);
    const nonDeterministicId = {
      ...first,
      capabilityId: "opportunity-capability:some-other-family",
    };
    expect(() => validateOpportunityFamilyCapability(nonDeterministicId)).toThrow(/deterministic/);
  });

  it("the Lab search index registers all six family definitions (searchable by domain query)", () => {
    const index = opportunityDiscoverySearchIndex();
    expect(index.definitions).toHaveLength(6);
    expect(index.instances).toEqual([]);
    expect(index.observations).toEqual([]);
    const { selections, executable } = selectExecutableBlocks(index, {
      domain: "opportunity-discovery",
    });
    expect(executable).toEqual([]);
    expect(selections).toHaveLength(6);
  });

  it("INV-C05: every opportunity family is REJECTED CATALOGUE_ENTRY_ONLY — never an executable block", () => {
    const index = opportunityDiscoverySearchIndex();
    const { selections } = selectExecutableBlocks(index, {
      domain: "opportunity-discovery",
    });
    for (const selection of selections) {
      expect(selection.status).toBe("REJECTED");
      if (selection.status === "REJECTED") {
        expect(selection.reason).toBe("CATALOGUE_ENTRY_ONLY");
        expect(selection.detail).toMatch(/INV-C05/);
      }
    }
  });

  it("the contrast index: ONLY the grounded non-opportunity capability yields an executable block", () => {
    const index = contrastSearchIndex();
    const { selections, executable } = selectExecutableBlocks(index, {
      domain: "opportunity-discovery",
    });
    // Six opportunity families rejected + one grounded capability executable.
    const rejected = selections.filter((selection) => selection.status === "REJECTED");
    expect(rejected).toHaveLength(6);
    expect(executable).toHaveLength(1);
    expect(executable[0]?.definition.capabilityId).toBe("psp.discovery-feed");
    for (const block of executable) {
      expect(block.definition.capabilityId).not.toMatch(/^opportunity-capability:/);
    }
  });

  it("the opportunity-discovery search plug-in emits NOTHING when only opportunity entries exist (honest empty state)", () => {
    const plugin = createOpportunityDiscoverySearchPlugin();
    registerSearchPlugin(plugin);
    const index = opportunityDiscoverySearchIndex();
    const { executable } = selectExecutableBlocks(index, {
      domain: "opportunity-discovery",
    });
    expect(executable).toEqual([]);
    const candidates = runSearchPlugin("opportunity-discovery", {
      world: discoveryWorld(),
      executableBlocks: [...executable],
      query: { domain: "opportunity-discovery" },
    });
    expect(candidates).toEqual([]);
  });

  it("the plug-in emits survey candidates ONLY when grounded in executable blocks (INV-C05)", () => {
    const plugin = createOpportunityDiscoverySearchPlugin();
    registerSearchPlugin(plugin);
    const index = contrastSearchIndex();
    const { executable } = selectExecutableBlocks(index, {
      domain: "opportunity-discovery",
    });
    expect(executable.length).toBe(1);
    const candidates = runSearchPlugin("opportunity-discovery", {
      world: discoveryWorld(),
      executableBlocks: [...executable],
      query: { domain: "opportunity-discovery" },
    });
    expect(candidates.length).toBe(1);
    expect(candidates[0]?.candidateId).toBe("search.opportunity-discovery:family-survey");
    expect(candidates[0]?.instanceRefs).toEqual(["instance:discovery-feed:1"]);
  });

  it("the plug-in's evidence candidates reference ONLY executable instance ids (never opportunity ids)", () => {
    const discovered = discoveryCatalog()
      .filter((entry) => entry.label.includes("healthy-1"))
      .map((entry) => discoverOpportunity(entry.input, NOW));
    const plugin = createOpportunityDiscoverySearchPlugin(discovered);
    registerSearchPlugin(plugin);
    const index = contrastSearchIndex();
    const { executable } = selectExecutableBlocks(index, {
      domain: "opportunity-discovery",
    });
    const candidates = runSearchPlugin("opportunity-discovery", {
      world: discoveryWorld(),
      executableBlocks: [...executable],
      query: { domain: "opportunity-discovery" },
    });
    // One survey + six family evidence candidates, all grounded ONLY in the
    // executable instance ids.
    expect(candidates).toHaveLength(7);
    for (const candidate of candidates) {
      expect(candidate.instanceRefs).toEqual(["instance:discovery-feed:1"]);
      expect(candidate.isIncumbentBaseline).toBe(false);
    }
  });

  it("a Lab candidate composed over discovery results carries the non-production + proposal-only constraints", () => {
    const discovered = [discoverOpportunity(healthyLiquidityObservation(), NOW)];
    const { organization } = composeDiscoveryCandidate({
      candidateId: "opportunity-discovery:candidate-1",
      title: "family survey candidate",
      discovered,
    });
    // The Lab's own proposal-only law (INV-G03: composition is a proposal,
    // never a grant)…
    expect(organization.safetyPolicy.hardConstraints).toContain(
      LAB_PROPOSAL_ONLY_CONSTRAINT,
    );
    // …extended by the discovery non-production law.
    expect(organization.safetyPolicy.hardConstraints).toContain(
      OPPORTUNITY_DISCOVERY_NON_PRODUCTION_CONSTRAINT,
    );
    expect(organization.safetyPolicy.hardConstraints).toContain(
      "policy:discovery-never-authorization",
    );
    expect(organization.safetyPolicy.hardConstraints).toContain(
      "policy:no-guaranteed-returns-language",
    );
    // No budgets, no delegation edges — a proposal carries no authority.
    expect(organization.budgets).toEqual([]);
    expect(organization.delegationEdges).toEqual([]);
    // The building blocks are the family capability registrations.
    expect(organization.bodies).toHaveLength(1);
  });

  it("the composed candidate's building blocks are family capability registrations (searchable surface)", () => {
    const discovered = discoveryCatalog()
      .filter((entry) => entry.label.includes("healthy-1"))
      .map((entry) => discoverOpportunity(entry.input, NOW));
    const { organization } = composeDiscoveryCandidate({
      candidateId: "opportunity-discovery:candidate-2",
      title: "six-family survey candidate",
      discovered,
    });
    // One agent instance composed from the candidate body.
    expect(organization.instances).toHaveLength(1);
  });

  it("the discovery execution gate REJECTS the composed Lab candidate (never-production extends to discovery)", () => {
    const discovered = [discoverOpportunity(healthyLiquidityObservation(), NOW)];
    const { organization } = composeDiscoveryCandidate({
      candidateId: "opportunity-discovery:candidate-3",
      title: "gate rejection candidate",
      discovered,
    });
    expect(() => rejectDiscoveryForExecution(organization)).toThrow(
      DiscoveryExecutionRejectedError,
    );
    expect(() => rejectDiscoveryForExecution(discovered[0])).toThrow(
      DiscoveryExecutionRejectedError,
    );
  });

  it("the domain pack declares the discovery-never-authorization policy set", () => {
    expect(OPPORTUNITY_DISCOVERY_DOMAIN_PACK.policySet).toContain(
      "policy:discovery-never-authorization",
    );
    expect(OPPORTUNITY_DISCOVERY_DOMAIN_PACK.policySet).toContain(
      "policy:no-guaranteed-returns-language",
    );
    expect(OPPORTUNITY_DISCOVERY_DOMAIN_PACK.failureTaxonomy).toContain(
      "STALE_OBSERVATION",
    );
    expect(OPPORTUNITY_DISCOVERY_DOMAIN_PACK.provenanceRequirements[0]?.requirementId).toBe(
      "opportunity-observation-law",
    );
  });
});

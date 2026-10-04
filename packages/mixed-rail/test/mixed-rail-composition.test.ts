import { describe, expect, it } from "vitest";
import {
  CANDIDATE_BODY_REF,
  CANDIDATE_PRINCIPAL,
  fiatExecutableBlocks,
  fiatScenario,
  fiatWorld,
  provedSimLane,
} from "./fixtures.js";
import {
  MIXED_RAIL_DOMAIN_PACK,
  MIXED_RAIL_NON_PRODUCTION_CONSTRAINT,
  buildMixedRailCandidate,
  classifyMixedRailComposition,
  createMixedRailSearchPlugin,
} from "./mixed-rail-lab-harness.js";
import {
  CandidateRegistry,
  DomainPackRegistry,
  LAB_PROPOSAL_ONLY_CONSTRAINT,
  registerSearchPlugin,
  runSearchPlugin,
  validateDomainPack,
} from "@payswap/lab";
import { onchainRailId, protocolCapabilityId } from "@payswap/onchain-domain";

/**
 * P4-W3-001: candidate organizations are PROVEN for all three composition
 * classes — fiat-only, onchain, mixed — through the Lab's own model:
 * the organization DRAFT is composed by the Lab's proposal-only composer,
 * the candidate is accepted by the REAL Lab candidate registry, the domain
 * pack registers through the REAL domain-pack registry, and the search
 * participates behind the Lab's REAL replaceable plug-in registry.
 */
describe("P4-W3-001 mixed-rail candidate organizations (the three classes)", () => {
  const fiatBlocks = fiatExecutableBlocks();
  const onchainLane = provedSimLane();

  it("proves a FIAT_ONLY candidate organization from executable fiat blocks", () => {
    const candidate = buildMixedRailCandidate({
      candidateId: "mixed-rail:fiat-only-1",
      title: "fiat-only candidate",
      domainPackId: MIXED_RAIL_DOMAIN_PACK.packId,
      executionMode: "PASS_THROUGH_NATIVE",
      fiatBlocks,
      onchainLanes: [],
      body: CANDIDATE_BODY_REF,
      principal: CANDIDATE_PRINCIPAL,
    });
    expect(candidate.compositionClass).toBe("FIAT_ONLY");
    expect(candidate.lanes.map((lane) => lane.laneKind)).toEqual(["FIAT", "FIAT"]);
    // Building blocks are the deterministic fiat connector capability ids.
    expect(candidate.buildingBlocks).toEqual([
      { blockKind: "CONNECTOR_CAPABILITY", blockId: "psp.native-routing", version: "1.0.0" },
      { blockKind: "CONNECTOR_CAPABILITY", blockId: "psp.payouts", version: "1.0.0" },
    ]);
    expect(candidate.program.routePreference).toEqual(["rail-a", "rail-b"]);
  });

  it("proves an ONCHAIN_ONLY candidate organization from kernel-proved lanes", () => {
    const candidate = buildMixedRailCandidate({
      candidateId: "mixed-rail:onchain-only-1",
      title: "onchain candidate",
      domainPackId: MIXED_RAIL_DOMAIN_PACK.packId,
      executionMode: "COMPOSED_PAYSWAP",
      fiatBlocks: [],
      onchainLanes: [onchainLane],
      body: CANDIDATE_BODY_REF,
      principal: CANDIDATE_PRINCIPAL,
    });
    expect(candidate.compositionClass).toBe("ONCHAIN_ONLY");
    // The building block is the DETERMINISTIC protocol capability id — the
    // canonical onchain-domain vocabulary, never a local id scheme.
    expect(candidate.buildingBlocks).toEqual([
      {
        blockKind: "CERTIFIED_SMART_CONTRACT",
        blockId: protocolCapabilityId("lab-sim-dex", "ethereum:mainnet"),
        version: "1.0.0",
      },
    ]);
    // The route preference references the canonical onchain rail id.
    expect(candidate.program.routePreference).toEqual([onchainRailId("ethereum:mainnet")]);
  });

  it("proves a MIXED candidate organization composing both sides", () => {
    const candidate = buildMixedRailCandidate({
      candidateId: "mixed-rail:mixed-1",
      title: "mixed candidate",
      domainPackId: MIXED_RAIL_DOMAIN_PACK.packId,
      executionMode: "OPTIMIZED_MULTI_PROVIDER",
      fiatBlocks,
      onchainLanes: [onchainLane],
      body: CANDIDATE_BODY_REF,
      principal: CANDIDATE_PRINCIPAL,
    });
    expect(candidate.compositionClass).toBe("MIXED");
    expect(candidate.program.routePreference).toEqual([
      "rail-a",
      "rail-b",
      onchainRailId("ethereum:mainnet"),
    ]);
    // Mixed building blocks compose BOTH block kinds.
    expect(candidate.buildingBlocks.map((block) => block.blockKind)).toEqual([
      "CONNECTOR_CAPABILITY",
      "CONNECTOR_CAPABILITY",
      "CERTIFIED_SMART_CONTRACT",
    ]);
  });

  it("classification is structural and fail-closed (empty lanes are rejected)", () => {
    expect(classifyMixedRailComposition([{ laneKind: "ONCHAIN", lane: onchainLane }])).toBe(
      "ONCHAIN_ONLY",
    );
    expect(
      classifyMixedRailComposition([{ laneKind: "FIAT", block: fiatBlocks[0]!, simulatedRailId: "rail-a" }]),
    ).toBe("FIAT_ONLY");
    expect(() => classifyMixedRailComposition([])).toThrow();
  });

  it("an empty composition is never fabricated (neither side present)", () => {
    expect(() =>
      buildMixedRailCandidate({
        candidateId: "mixed-rail:empty-1",
        title: "empty",
        domainPackId: MIXED_RAIL_DOMAIN_PACK.packId,
        executionMode: "COMPOSED_PAYSWAP",
        fiatBlocks: [],
        onchainLanes: [],
        body: CANDIDATE_BODY_REF,
        principal: CANDIDATE_PRINCIPAL,
      }),
    ).toThrow(/at least one lane/);
  });

  it("a fiat block without a simulated-rail binding is rejected (the Lab-only convention)", () => {
    const unbound = {
      ...fiatBlocks[0]!,
      instance: { ...fiatBlocks[0]!.instance, configuration: {} },
    };
    expect(() =>
      buildMixedRailCandidate({
        candidateId: "mixed-rail:unbound-1",
        title: "unbound",
        domainPackId: MIXED_RAIL_DOMAIN_PACK.packId,
        executionMode: "COMPOSED_PAYSWAP",
        fiatBlocks: [unbound],
        onchainLanes: [],
        body: CANDIDATE_BODY_REF,
        principal: CANDIDATE_PRINCIPAL,
      }),
    ).toThrow(/simulatedRailId/);
  });
});

describe("P4-W3-001 Lab-native integration (registry, domain pack, proposal-only law)", () => {
  const fiatBlocks = fiatExecutableBlocks();
  const onchainLane = provedSimLane();

  it("the REAL Lab candidate registry accepts the mixed candidate (all classes)", () => {
    const registry = new CandidateRegistry();
    const compositionInput = {
      domainPackId: MIXED_RAIL_DOMAIN_PACK.packId,
      body: CANDIDATE_BODY_REF,
      principal: CANDIDATE_PRINCIPAL,
      domainHardConstraints: [MIXED_RAIL_NON_PRODUCTION_CONSTRAINT],
      evaluationSuiteRef: "lab.mixed-rail-suite",
    } as const;

    const fiatCandidate = buildMixedRailCandidate({
      ...compositionInput,
      candidateId: "mixed-rail:registry:fiat",
      title: "registry fiat",
      executionMode: "PASS_THROUGH_NATIVE",
      fiatBlocks,
      onchainLanes: [],
    });
    const registeredFiat = registry.createDraft({
      candidateId: fiatCandidate.candidateId,
      title: fiatCandidate.title,
      domainPackId: fiatCandidate.domainPackId,
      origin: fiatCandidate.origin,
      executionMode: fiatCandidate.executionMode,
      program: fiatCandidate.program,
      buildingBlocks: fiatCandidate.buildingBlocks,
      body: CANDIDATE_BODY_REF,
      principal: CANDIDATE_PRINCIPAL,
      domainHardConstraints: [MIXED_RAIL_NON_PRODUCTION_CONSTRAINT],
      evaluationSuiteRef: "lab.mixed-rail-suite",
    });
    expect(registeredFiat.stage).toBe("DRAFT");
    // INV-G03: the composed organization is authority-free.
    expect(registeredFiat.organization.budgets).toEqual([]);
    expect(registeredFiat.organization.delegationEdges).toEqual([]);
    expect(registeredFiat.organization.safetyPolicy.hardConstraints[0]).toBe(
      LAB_PROPOSAL_ONLY_CONSTRAINT,
    );

    const onchainCandidate = buildMixedRailCandidate({
      ...compositionInput,
      candidateId: "mixed-rail:registry:onchain",
      title: "registry onchain",
      executionMode: "COMPOSED_PAYSWAP",
      fiatBlocks: [],
      onchainLanes: [onchainLane],
    });
    const registeredOnchain = registry.createDraft({
      candidateId: onchainCandidate.candidateId,
      title: onchainCandidate.title,
      domainPackId: onchainCandidate.domainPackId,
      origin: onchainCandidate.origin,
      executionMode: onchainCandidate.executionMode,
      program: onchainCandidate.program,
      buildingBlocks: onchainCandidate.buildingBlocks,
      body: CANDIDATE_BODY_REF,
      principal: CANDIDATE_PRINCIPAL,
      domainHardConstraints: [MIXED_RAIL_NON_PRODUCTION_CONSTRAINT],
      evaluationSuiteRef: "lab.mixed-rail-suite",
    });
    expect(registeredOnchain.stage).toBe("DRAFT");

    const mixedCandidate = buildMixedRailCandidate({
      ...compositionInput,
      candidateId: "mixed-rail:registry:mixed",
      title: "registry mixed",
      executionMode: "OPTIMIZED_MULTI_PROVIDER",
      fiatBlocks,
      onchainLanes: [onchainLane],
    });
    const registeredMixed = registry.createDraft({
      candidateId: mixedCandidate.candidateId,
      title: mixedCandidate.title,
      domainPackId: mixedCandidate.domainPackId,
      origin: mixedCandidate.origin,
      executionMode: mixedCandidate.executionMode,
      program: mixedCandidate.program,
      buildingBlocks: mixedCandidate.buildingBlocks,
      body: CANDIDATE_BODY_REF,
      principal: CANDIDATE_PRINCIPAL,
      domainHardConstraints: [MIXED_RAIL_NON_PRODUCTION_CONSTRAINT],
      evaluationSuiteRef: "lab.mixed-rail-suite",
    });
    expect(registry.get(registeredMixed.candidateId)?.candidateId).toBe(
      "mixed-rail:registry:mixed",
    );
    expect(registry.list().length).toBe(3);
  });

  it("the mixed-rail domain pack registers through the REAL domain-pack registry", () => {
    expect(() => validateDomainPack(MIXED_RAIL_DOMAIN_PACK)).not.toThrow();
    const registry = new DomainPackRegistry();
    const registered = registry.register(MIXED_RAIL_DOMAIN_PACK);
    expect(registry.get(registered.packId)?.domain).toBe("mixed-rail-execution");
  });

  it("the mixed candidate's organization carries the non-production constraint first", () => {
    const candidate = buildMixedRailCandidate({
      candidateId: "mixed-rail:constraint-1",
      title: "constraint",
      domainPackId: MIXED_RAIL_DOMAIN_PACK.packId,
      executionMode: "COMPOSED_PAYSWAP",
      fiatBlocks,
      onchainLanes: [onchainLane],
      body: CANDIDATE_BODY_REF,
      principal: CANDIDATE_PRINCIPAL,
    });
    expect(candidate.labCandidate.organization.safetyPolicy.hardConstraints).toContain(
      MIXED_RAIL_NON_PRODUCTION_CONSTRAINT,
    );
    expect(candidate.labCandidate.evidence).toEqual([]);
    expect(candidate.labCandidate.stage).toBe("DRAFT");
  });
});

describe("P4-W3-001 search participation (the Lab's replaceable plug-in registry)", () => {
  const fiatBlocks = fiatExecutableBlocks();

  it("the mixed-rail plug-in registers and runs behind the REAL Lab search registry", () => {
    const onchainLane = provedSimLane({ nativeBaseline: true });
    const plugin = createMixedRailSearchPlugin([onchainLane]);
    registerSearchPlugin(plugin);
    const candidates = runSearchPlugin("mixed-rail", {
      world: fiatWorld(),
      executableBlocks: fiatBlocks,
      query: { domain: "payment-routing", currency: "EUR" },
    });
    const ids = candidates.map((candidate) => candidate.candidateId);
    expect(ids).toContain("search.mixed-rail:incumbent-native");
    expect(ids).toContain("search.mixed-rail:onchain-only");
    expect(ids).toContain("search.mixed-rail:fiat-only");
    expect(ids).toContain("search.mixed-rail:mixed");

    // The mixed candidate composes BOTH sides' instance refs and rails.
    const mixed = candidates.find(
      (candidate) => candidate.candidateId === "search.mixed-rail:mixed",
    );
    expect(mixed?.instanceRefs).toContain("instance:native-routing:1");
    expect(mixed?.instanceRefs).toContain(onchainLane.instance.instanceId);
    expect(mixed?.program.routePreference).toEqual([
      "rail-a",
      "rail-b",
      onchainRailId("ethereum:mainnet"),
    ]);

    // The incumbent is the provider-native baseline on EITHER side (INV-C08:
    // incumbents compete; composition is never structurally preferred).
    const incumbent = candidates.find(
      (candidate) => candidate.candidateId === "search.mixed-rail:incumbent-native",
    );
    expect(incumbent?.isIncumbentBaseline).toBe(true);
    expect(incumbent?.executionMode).toBe("PASS_THROUGH_NATIVE");
  });

  it("the incumbent can be the FIAT native baseline when the venue is not native", () => {
    const onchainLane = provedSimLane({ nativeBaseline: false });
    const plugin = createMixedRailSearchPlugin([onchainLane]);
    registerSearchPlugin(plugin);
    const candidates = runSearchPlugin("mixed-rail", {
      world: fiatWorld(),
      executableBlocks: fiatBlocks,
      query: { domain: "payment-routing", currency: "EUR" },
    });
    const incumbent = candidates.find(
      (candidate) => candidate.candidateId === "search.mixed-rail:incumbent-native",
    );
    // The fiat incumbent (psp.native-routing, rail-a) wins the incumbent slot.
    expect(incumbent?.instanceRefs).toEqual(["instance:native-routing:1"]);
    expect(incumbent?.program.routePreference).toEqual(["rail-a"]);
  });

  it("no executable grounding on either side yields NO candidates (never fabricated)", () => {
    const plugin = createMixedRailSearchPlugin([]);
    registerSearchPlugin(plugin);
    const candidates = runSearchPlugin("mixed-rail", {
      world: fiatWorld(),
      executableBlocks: [],
      query: { domain: "payment-routing", currency: "EUR" },
    });
    expect(candidates).toEqual([]);
  });
});

describe("P4-W3-001 candidate evidence maturation through the REAL registry", () => {
  it("a mixed candidate matures DRAFT → BENCHMARKED → VALIDATED with kernel evidence", () => {
    const registry = new CandidateRegistry();
    const candidate = buildMixedRailCandidate({
      candidateId: "mixed-rail:maturation-1",
      title: "maturation",
      domainPackId: MIXED_RAIL_DOMAIN_PACK.packId,
      executionMode: "OPTIMIZED_MULTI_PROVIDER",
      fiatBlocks: fiatExecutableBlocks(),
      onchainLanes: [provedSimLane()],
      body: CANDIDATE_BODY_REF,
      principal: CANDIDATE_PRINCIPAL,
    });
    const registered = registry.createDraft({
      candidateId: candidate.candidateId,
      title: candidate.title,
      domainPackId: candidate.domainPackId,
      origin: candidate.origin,
      executionMode: candidate.executionMode,
      program: candidate.program,
      buildingBlocks: candidate.buildingBlocks,
      body: CANDIDATE_BODY_REF,
      principal: CANDIDATE_PRINCIPAL,
      domainHardConstraints: [MIXED_RAIL_NON_PRODUCTION_CONSTRAINT],
      evaluationSuiteRef: "lab.mixed-rail-suite",
    });
    expect(registered.stage).toBe("DRAFT");

    const benchmarked = registry.attachEvidence({
      candidateId: candidate.candidateId,
      evidence: [
        {
          evidenceId: "ev-baseline-1",
          kind: "BASELINE_SUITE_EVALUATION",
          artifactRef: "artifacts/mixed-rail/baseline-1",
          contentDigest: "digest-baseline-1",
        },
      ],
    });
    expect(benchmarked.stage).toBe("BENCHMARKED");

    const validated = registry.attachEvidence({
      candidateId: candidate.candidateId,
      evidence: [
        {
          evidenceId: "ev-replay-1",
          kind: "REPLAY",
          artifactRef: "artifacts/mixed-rail/replay-1",
          contentDigest: "digest-replay-1",
        },
        {
          evidenceId: "ev-counterfactual-1",
          kind: "COUNTERFACTUAL",
          artifactRef: "artifacts/mixed-rail/counterfactual-1",
          contentDigest: "digest-counterfactual-1",
        },
        {
          evidenceId: "ev-robustness-1",
          kind: "ROBUSTNESS",
          artifactRef: "artifacts/mixed-rail/robustness-1",
          contentDigest: "digest-robustness-1",
        },
      ],
    });
    expect(validated.stage).toBe("VALIDATED");

    // Published versions are immutable, content-addressed snapshots (INV-G02).
    const published = registry.publishVersion({
      candidateId: candidate.candidateId,
      publishedAt: "2026-10-03T00:00:00Z",
    });
    expect(published.version).toBe(1);
    expect(published.contentDigest.length).toBeGreaterThan(0);
    expect(published.snapshot.candidateId).toBe(candidate.candidateId);
    expect(published.snapshot.buildingBlocks).toContainEqual(
      candidate.buildingBlocks[candidate.buildingBlocks.length - 1],
    );
  });

  it("the published snapshot's program still references both sides (fiat rails + onchain rails)", () => {
    const candidate = buildMixedRailCandidate({
      candidateId: "mixed-rail:program-1",
      title: "program",
      domainPackId: MIXED_RAIL_DOMAIN_PACK.packId,
      executionMode: "OPTIMIZED_MULTI_PROVIDER",
      fiatBlocks: fiatExecutableBlocks(),
      onchainLanes: [provedSimLane()],
      body: CANDIDATE_BODY_REF,
      principal: CANDIDATE_PRINCIPAL,
    });
    expect(candidate.program.authorizationMode).toBe("PROTOCOL_AUTHORIZED");
    expect(candidate.program.fraudScreening).toBe(true);
    expect(candidate.program.routePreference).toContain("rail-a");
    expect(candidate.program.routePreference).toContain(onchainRailId("ethereum:mainnet"));
    // The scenario fixture still applies (fiat laws unchanged).
    expect(fiatScenario().demands.length).toBe(2);
  });
});

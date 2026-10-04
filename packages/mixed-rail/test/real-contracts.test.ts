import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  validateConnectedProtocolInstance,
  validateAssetObservation,
  validateOnchainExecutionObservation,
} from "@payswap/onchain-domain";
import { BestExecutionEngine } from "@payswap/best-execution";
import { classifyChainEnvironment } from "@payswap/onchain-adapters";
import {
  CHAIN,
  NOW,
  OWNER,
  baseBestExecutionPolicy,
  baseSecurityPolicy,
  baseSecurityState,
  createLabSimVenue,
  simProtocolInstance,
  uscAssetObservation,
  uscToEthSwapRequest,
  BENEFICIARY,
} from "./fixtures.js";
import { discoverOnchainLane, executeOnchainLane } from "../src/index.js";

/**
 * P4-W3-001 hard requirement 2: REAL capability contracts consumed, NO
 * shadow models. This suite adversarially proves it three ways:
 *
 * 1. DUPLICATE-VOCABULARY SCAN: src/** must DECLARE none of the kernel's
 *    contract vocabulary (a re-declared kernel type is a shadow model —
 *    a review blocker) while IMPORTING the kernel packages that own it.
 * 2. KERNEL VALIDATORS REJECT FAKES: mutating a kernel artifact in ways
 *    that break the kernel's own laws is caught by the KERNEL's
 *    validators — proving the artifacts this package consumes are the
 *    real contracts, not lookalikes.
 * 3. THE ENGINE ACTUALLY GATES: a policy BLOCK kills a route through the
 *    real engine (no local bypass of the kernel's gates).
 */

const PACKAGE_ROOT = process.cwd(); // vitest runs from packages/mixed-rail
const SRC_ROOT = join(PACKAGE_ROOT, "src");

function listSourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...listSourceFiles(full));
    } else if (entry.endsWith(".ts")) {
      found.push(full);
    }
  }
  return found;
}

const SRC_FILES = listSourceFiles(SRC_ROOT);

/** Kernel contract vocabulary this package must CONSUME, never re-declare. */
const KERNEL_VOCABULARY: readonly string[] = [
  "ChainDefinition",
  "ConnectedChainInstance",
  "ProtocolDefinition",
  "ProtocolImplementation",
  "ConnectedProtocolInstance",
  "AssetDefinition",
  "AssetObservation",
  "OnchainExecutionRequest",
  "OnchainExecutionDirective",
  "OnchainExecutionObservation",
  "OnchainExecutionOutcome",
  "OnchainRailOutcome",
  "OnchainRailOperationMapping",
  "SettlementAttemptEventCandidate",
  "OnchainFinalityCandidate",
  "OnchainFailureDescriptor",
  "OnchainWriteRequest",
  "PreparedWrite",
  "SimulationObservation",
  "SimulationStatus",
  "GateDecision",
  "GuardDimension",
  "GuardCheck",
  "OnchainSecurityPolicy",
  "OnchainSecurityState",
  "ExpectedStateDiff",
  "ExpectedStateDiffEntry",
  "OnchainWritePipeline",
  "TrustedApprovalSurface",
  "OnchainAuthorizationArtifact",
  "ExecutionVenue",
  "VenueDescriptor",
  "VenueQuote",
  "VenueQuoteOutcome",
  "VenueProtocolBinding",
  "VenueWritePlanningInput",
  "SwapRequest",
  "SwapKind",
  "BestExecutionEngine",
  "BestExecutionRequest",
  "BestExecutionPolicy",
  "BestExecutionDecision",
  "SelectedRoute",
  "RouteProvenanceChain",
  "CandidateEvaluationTrace",
  "VenueQuoteProvenance",
  "QuoteFreshness",
  "QuoteProvenance",
  "QuoteObserver",
  "HealthObservation",
  "NetOutcomeEvaluation",
  "RankableCandidate",
  "ValuedComponent",
  "RouteExecutionRecord",
  "AssetIdentity",
  "AssetConversionRule",
  "TieBreakerKind",
  "ExactRational",
  "RailEnvironment",
  "RailEnvironmentClass",
  "ChainHeadObservation",
  "AdapterLifecycleStage",
  "AdapterStageSupport",
  "ChainFamilyAdapter",
  "PreparedAdapterOperation",
  "AuthorizedExecutionFeed",
  "FinalityEvaluation",
  "ReconciliationPlan",
  "VenueExtensionPack",
  "SimulatedRail",
  "SimulatedWorld",
  "SimulationProgram",
  "SimulationRunResult",
  "SimulationMetrics",
  "DemandPlan",
  "ScenarioIncident",
  "SimulationScenarioPlan",
  "DemandOutcome",
  "LabCandidate",
  "ExecutableBlock",
  "SearchSelection",
  "SearchedCandidate",
  "LabSearchPlugin",
  "LabSearchInput",
  "LabBuildingBlock",
  "DomainPack",
  "CandidateRegistry",
  "DomainPackRegistry",
  "OrganizationDraft",
  "AmountSpec",
  "ExecutionMode",
  "ConnectedCapabilityInstance",
  "CapabilityDefinition",
  "CapabilityObservation",
  "CertificationRecord",
  "SmartContractExtension",
];

describe("P4-W3-001 no shadow models: the duplicate-vocabulary adversarial scan", () => {
  it("src/** declares NONE of the kernel contract vocabulary (a re-declaration is a shadow model)", () => {
    const offenders: { file: string; name: string }[] = [];
    for (const file of SRC_FILES) {
      const source = readFileSync(file, "utf8");
      for (const name of KERNEL_VOCABULARY) {
        const declaration = new RegExp(
          `(^|\\W)(interface\\s+${name}\\b|type\\s+${name}\\b|class\\s+${name}\\b)`,
        );
        if (declaration.test(source)) {
          offenders.push({ file, name });
        }
      }
    }
    expect(
      offenders,
      `shadow-model vocabulary declared in src (kernel contracts must be imported, never re-declared):\n${offenders.map((o) => `${o.file}: ${o.name}`).join("\n")}`,
    ).toEqual([]);
  });

  it("src/** imports the kernel packages that own the consumed vocabulary (real consumption)", () => {
    const allSource = SRC_FILES.map((file) => readFileSync(file, "utf8")).join("\n");
    for (const kernelPackage of [
      "@payswap/best-execution",
      "@payswap/onchain-adapters",
      "@payswap/onchain-domain",
      "@payswap/onchain-security",
      "@payswap/onchain-venues",
      "@payswap/protocol",
    ]) {
      expect(allSource.includes(`from "${kernelPackage}"`)).toBe(true);
    }
    // The consumed vocabulary appears in src as IMPORTED names, not declared ones.
    expect(allSource.includes("OnchainExecutionObservation")).toBe(true);
    expect(allSource.includes("VenueQuote")).toBe(true);
    expect(allSource.includes("GateDecision")).toBe(true);
    expect(allSource.includes("AdapterLifecycleStage")).toBe(true);
  });

  it("the Lab runtime is consumed from the test layer ONLY (INV-L01, the repo-wide law)", () => {
    // src/** never references the Lab runtime package (not even as a
    // string): the simulator is not callable from any production path.
    for (const file of SRC_FILES) {
      const source = readFileSync(file, "utf8");
      expect(source.includes("@payswap/lab")).toBe(false);
    }
    // The Lab model IS consumed — from the test layer (harness + suites).
    const harness = readFileSync(join(PACKAGE_ROOT, "test", "mixed-rail-lab-harness.ts"), "utf8");
    expect(harness.includes("from \"@payswap/lab\"")).toBe(true);
  });
});

describe("P4-W3-001 kernel validators reject fakes (the contracts are real)", () => {
  it("a fake ConnectedProtocolInstance is rejected by the kernel validator", () => {
    const real = simProtocolInstance();
    expect(() => validateConnectedProtocolInstance(real)).not.toThrow();
    // Deterministic id coupling broken:
    expect(() =>
      validateConnectedProtocolInstance({ ...real, capabilityId: "protocol.ethereum:mainnet:wrong" }),
    ).toThrow();
    // Authorization status corrupted:
    expect(() =>
      validateConnectedProtocolInstance({ ...real, authorization: { ...real.authorization, status: "MAYBE" } }),
    ).toThrow();
  });

  it("a fake AssetObservation is rejected by the kernel observation law", () => {
    const real = uscAssetObservation();
    expect(() => validateAssetObservation(real)).not.toThrow();
    // Freshness law broken (missing freshness):
    const { freshness: _omittedFreshness, ...noFreshness } = real;
    expect(() => validateAssetObservation(noFreshness)).toThrow();
    // Chain coupling broken:
    expect(() =>
      validateAssetObservation({ ...real, chainKey: "solana:mainnet-beta" }),
    ).toThrow();
    // Observer identity missing:
    const { observer: _omittedObserver, ...noObserver } = real;
    expect(() => validateAssetObservation(noObserver)).toThrow();
  });

  it("the Lab walk's observations satisfy the kernel observation law (no local loosening)", () => {
    const engine = new BestExecutionEngine();
    engine.register(createLabSimVenue());
    const result = discoverOnchainLane({
      engine,
      executionId: "real-contracts-test-001",
      swap: uscToEthSwapRequest(),
      policy: baseBestExecutionPolicy(),
      security: { policy: baseSecurityPolicy(), state: baseSecurityState() },
      instances: [simProtocolInstance()],
      assetObservations: [uscAssetObservation()],
      owner: OWNER,
      beneficiary: BENEFICIARY,
      requestedBy: "agent:mixed-rail-test",
      routeExpiryMs: NOW + 300_000,
      at: NOW,
    });
    if (result.status !== "LANE_PROVED") {
      throw new Error("fixture lane must be proved");
    }
    const execution = executeOnchainLane({
      lane: result.lane,
      at: NOW,
      observedAtIso: "2026-10-03T00:00:00Z",
    });
    if (execution.status !== "EXECUTED") {
      throw new Error("fixture execution must be EXECUTED");
    }
    expect(() => validateOnchainExecutionObservation(execution.observation)).not.toThrow();
    // A fault-injected UNKNOWN observation also satisfies the kernel law:
    // unknownReason REQUIRED, failure FORBIDDEN.
    const unknown = executeOnchainLane({
      lane: result.lane,
      at: NOW,
      observedAtIso: "2026-10-03T00:00:00Z",
      fault: { kind: "OUTCOME_UNKNOWN", reason: "simulated ambiguity" },
    });
    if (unknown.status !== "EXECUTED") {
      throw new Error("fixture execution must be EXECUTED");
    }
    expect(unknown.observation.unknownReason).toBeDefined();
    expect(unknown.observation.failure).toBeUndefined();
    expect(() => validateOnchainExecutionObservation(unknown.observation)).not.toThrow();
  });

  it("the engine actually gates: a BLOCK kills the route (no local bypass of kernel gates)", () => {
    // Same engine, same venue, same instances — but the security policy
    // forbids the chain: the kernel gates BLOCK every candidate write and
    // no lane is proved. There is no code path in this package that can
    // select a route the kernel gates rejected.
    const engine = new BestExecutionEngine();
    engine.register(createLabSimVenue());
    const result = discoverOnchainLane({
      engine,
      executionId: "real-contracts-test-002",
      swap: uscToEthSwapRequest(),
      policy: baseBestExecutionPolicy(),
      security: {
        policy: baseSecurityPolicy({ allowedChains: ["solana:mainnet-beta"] }),
        state: baseSecurityState(),
      },
      instances: [simProtocolInstance()],
      assetObservations: [uscAssetObservation()],
      owner: OWNER,
      beneficiary: BENEFICIARY,
      requestedBy: "agent:mixed-rail-test",
      routeExpiryMs: NOW + 300_000,
      at: NOW,
    });
    expect(result.status).toBe("NO_EXECUTABLE_ROUTE");
    if (result.status === "NO_EXECUTABLE_ROUTE") {
      const candidate = result.provenance.candidates.find((c) => c.venueId === "lab-sim-dex");
      expect(candidate?.status).toBe("SECURITY_BLOCKED");
      expect(candidate?.security.blockReasonCodes).toContain("chain_not_permitted");
    }
  });

  it("the chain-environment registry is the kernel's own (classify re-derivation)", () => {
    // The lane's environment class is RE-DERIVED from the kernel's frozen
    // registry on every proved lane — chain identity classifies, a runtime
    // flag can never claim a different class:
    expect(classifyChainEnvironment(CHAIN)).toBe("PRODUCTION");
    expect(classifyChainEnvironment("ethereum:sepolia")).toBe("TESTNET");
    // An unknown chain classifies FAIL CLOSED (environment is never guessed):
    expect(() => classifyChainEnvironment("ethereum:unknownnet")).toThrow();
    expect(() => classifyChainEnvironment("notachain")).toThrow();
  });
});

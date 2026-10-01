import { describe, expect, it } from "vitest";
import { ConnectorRegistry, observeCapability } from "@payswap/connectors";
import type {
  CapabilityDefinition,
  ConnectedCapabilityInstance,
  ExternalFundsPositionObservation,
  ProviderImplementation,
  ProviderStateEnvelope,
} from "@payswap/connectors";
import { releaseOrganization } from "@payswap/agents";
import type { OrganizationDraft } from "@payswap/agents";
import {
  CERTIFIABLE_COMPONENT_KINDS,
  CertificationSuiteRegistry,
  certifyConnector,
  connectorSuiteGateResults,
  defaultSuiteFor,
  evaluateSuite,
  verifyConnectedInstanceScope,
  verifyExecutionModesDeclaration,
  verifyExternalFundsObservation,
  verifyProviderStatePreservation,
  verifySubjectArtifact,
} from "@payswap/certification";
import type { SuiteEvidenceSubmission, SuiteGateResult } from "@payswap/certification";

/**
 * Certification suites (W2-006 acceptance: every production
 * strategy/org/package is certifiable; connector certification verifies
 * capability hierarchy, connected-instance scope, provider-state
 * preservation, execution modes and external-funds observation semantics).
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const paymentDefinition: CapabilityDefinition = {
  capabilityId: "conn:payments.create-authorization",
  capabilityVersion: "1.0.0",
  summary: "Create a payment authorization on a connected PSP account.",
  kind: "ACTION",
  requiredPermissions: ["payments:write"],
  executionModes: [
    "PASS_THROUGH_NATIVE",
    "COMPOSED_PAYSWAP",
    "OPTIMIZED_MULTI_PROVIDER",
  ],
  semantics: {
    operation: "payments.create_authorization",
    stateMachine: {
      documentRef: "state-machines/payments/authorization",
      version: "1.2.0",
    },
    description: "Reserves value on a customer funding instrument for later capture.",
  },
  preconditions: ["A connected instance is authorized and eligible."],
  authorization: {
    protocolAuthorization: true,
    requiredScopes: ["payments:write"],
    customerConsent: "EXPLICIT",
  },
  sideEffects: [
    {
      effect: "Reserves the authorized amount on the customer instrument.",
      financialEffect: "RESERVES_VALUE",
      reversible: true,
    },
  ],
  idempotency: {
    idempotent: true,
    keyScope: "REQUEST",
    duplicateBehavior: "RETURNED_SAME_RESULT",
    retryPolicy: "SAFE_TO_RETRY",
  },
  compensation: {
    compensable: false,
    cancellation: "NOT_SUPPORTED",
    partialExecution: { possible: false, granularity: "ATOMIC", onPartial: "DISCLOSED" },
  },
  requiredCustomerActions: [
    {
      action: "authenticate",
      actor: "CUSTOMER",
      description: "Complete the provider's authentication challenge (e.g. 3DS).",
    },
  ],
  providerVocabulary: {
    actions: [{ action: "capture", description: "Capture an authorized amount." }],
    states: [
      {
        providerState: "requires_action",
        canonicalState: "PENDING_CUSTOMER_ACTION",
        requiresCustomerAction: true,
        isTerminal: false,
      },
    ],
  },
  externalObjects: [
    {
      objectType: "PAYMENT_INTENT",
      idFormat: "provider-scoped opaque identifier",
      revisioned: true,
      revisionFormat: "monotonic revision integer",
    },
  ],
  evidence: {
    produced: ["EXECUTION", "STATE_OBSERVATION"],
    required: ["AUTHORIZATION"],
  },
  economics: { feeModel: "VARIABLE_BPS", limits: [], settlementImplications: "Settles to the merchant destination." },
  constraints: [],
};

const implementation: ProviderImplementation = {
  implementationId: "impl:psp-a-payments-1",
  providerName: "psp-a",
  providerVersion: "2026-01",
  capabilityId: "conn:payments.create-authorization",
  capabilityVersion: "1.0.0",
  version: "1.4.2",
  adapterRef: "future-adapter:psp-a-payments@1",
  corridors: [
    { fromCountries: ["DE", "FR"], toCountries: ["DE", "FR"], currencies: ["EUR"] },
  ],
  knownDeviations: [],
};

function connectedInstance(
  overrides: Partial<ConnectedCapabilityInstance> = {},
): ConnectedCapabilityInstance {
  return {
    instanceId: "inst:acct-1-payments",
    capabilityId: "conn:payments.create-authorization",
    implementationId: "impl:psp-a-payments-1",
    providerName: "psp-a",
    providerVersion: "2026-01",
    accountRef: "acct:merchant-1",
    tenantRef: "tenant:merchant-1",
    authorization: { status: "ACTIVE", grantedAt: "2026-09-01T00:00:00Z" },
    credentialScope: { credentialRef: "cred:oauth-merchant-1", credentialKind: "OAUTH" },
    geography: { countries: ["DE", "FR"] },
    currencies: ["EUR"],
    permissionState: {
      granted: ["payments:write"],
      requested: ["payments:write"],
      missing: [],
    },
    eligibility: { eligible: true, reasons: [] },
    configuration: { captureMode: "automatic" },
    ...overrides,
  };
}

const stateEnvelope: ProviderStateEnvelope = {
  provider: { name: "psp-a", version: "2026-01" },
  object: { objectType: "PAYMENT_INTENT", externalId: "pi_123" },
  revision: "rev-7",
  state: { raw: "requires_action" },
  classification: {
    family: "customer_action_required",
    lifecycleStep: "challenge_pending",
    isTerminal: false,
    requiresCustomerAction: true,
  },
  history: [{ toRevision: "rev-7", occurredAt: "2026-10-01T12:00:00Z" }],
  actionRequired: { kind: "3ds_challenge", message: "Complete the 3DS challenge." },
  privacy: {
    dataClassification: "PARTNER",
    constraints: ["no-PII-in-support-tickets"],
    shareableFields: ["status"],
  },
  provenance: { source: "PROVIDER_API", fetchId: "fetch-123" },
  timestamps: { observedAt: "2026-10-01T12:00:00Z" },
};

function observation(version: number, externalState?: ProviderStateEnvelope) {
  return observeCapability({
    instanceId: "inst:acct-1-payments",
    observedAt: `2026-10-01T12:00:0${version}Z`,
    observationVersion: version,
    capabilityState: "AVAILABLE",
    sourceAvailability: "REACHABLE",
    eligibility: "ELIGIBLE",
    health: { status: "HEALTHY", lastCheckedAt: `2026-10-01T12:00:0${version}Z` },
    ...(externalState !== undefined ? { externalState } : {}),
    provenance: {
      providerName: "psp-a",
      source: "PROVIDER_API",
      capturedAt: `2026-10-01T12:00:0${version}Z`,
    },
  });
}

const fundsObservation: ExternalFundsPositionObservation = {
  observationKind: "ExternalFundsPositionObservation",
  observationId: "obs-funds-1",
  observedAt: "2026-10-01T12:00:00Z",
  freshness: { asOf: "2026-10-01T11:59:30Z", maxAgeSeconds: 60 },
  location: { providerName: "psp-a", accountRef: "acct:merchant-1" },
  observedAmount: { currency: "EUR", minorUnits: "1250000" },
  provenance: {
    providerName: "psp-a",
    source: "PROVIDER_API",
    capturedAt: "2026-10-01T12:00:00Z",
  },
};

function completeRegistry(): ConnectorRegistry {
  const registry = new ConnectorRegistry();
  registry.registerDefinition(paymentDefinition);
  registry.registerProvider({
    providerName: "psp-a",
    providerVersion: "2026-01",
    displayName: "PSP A",
    systemKind: "psp",
  });
  registry.registerImplementation(implementation);
  registry.registerInstance(connectedInstance());
  registry.recordObservation(observation(1, stateEnvelope));
  return registry;
}

function orgDraft(): OrganizationDraft {
  return {
    id: "org:payops-1",
    version: 1,
    bodies: [{ id: "body:payer", version: 2 }],
    instances: [
      {
        id: "instance-payer",
        bodyRef: { id: "body:payer", version: 2 },
        principal: { agentKeyFingerprint: "agent-key-1", ownerRef: "user:owner-1" },
        runtimeState: { status: "IDLE" },
      },
    ],
    communicationEdges: [],
    delegationEdges: [],
    memory: { scope: "isolated", retention: "ephemeral" },
    budgets: [],
    evaluators: [{ evaluationSuiteRef: "evalsuite:payops@1" }],
    termination: { conditions: ["safety-violation"], requiresHumanApproval: true },
    safetyPolicy: {
      hardConstraints: ["no-unmandated-beneficiary-change"],
      escalationSurfaceRef: "surface:trusted-approval",
    },
  };
}

function evidenceFor(
  kinds: readonly string[],
): SuiteEvidenceSubmission[] {
  return kinds.map((kind, index) => ({
    evidenceId: `ev-${kind}-${index}`,
    kind: kind as SuiteEvidenceSubmission["kind"],
    artifactRef: `artifacts/${kind}-${index}`,
    contentDigest: `digest-${kind}-${index}`,
  }));
}

function passingGates(
  gateIds: readonly string[],
): SuiteGateResult[] {
  return gateIds.map((gateId) => ({ gateId: gateId as SuiteGateResult["gateId"], passed: true }));
}

// ---------------------------------------------------------------------------
// Suite parameterization: every production strategy/org/package is certifiable
// ---------------------------------------------------------------------------

describe("certification suites parameterized by component kind", () => {
  it("every certifiable component kind has a default production suite", () => {
    for (const kind of CERTIFIABLE_COMPONENT_KINDS) {
      const suite = defaultSuiteFor(kind);
      expect(suite.componentKind).toBe(kind);
      expect(suite.requiredEvidenceKinds.length).toBeGreaterThan(0);
      expect(suite.requiredGates.length).toBeGreaterThan(0);
    }
    expect(CERTIFIABLE_COMPONENT_KINDS).toHaveLength(4);
  });

  it("a strategy subject is certifiable with complete evidence and passing gates", () => {
    const suite = defaultSuiteFor("strategy");
    const subject = {
      componentKind: "strategy",
      subjectId: "cand-1",
      version: "3",
    } as const;
    const artifact = {
      componentKind: "strategy",
      artifact: {
        candidateId: "cand-1",
        executionMode: "COMPOSED_PAYSWAP",
        stage: "VALIDATED",
        evidence: [{ evidenceId: "ev-1", kind: "REPLAY" }],
      },
    } as const;
    expect(verifySubjectArtifact(artifact)).toEqual([]);
    const evaluation = evaluateSuite({
      suite,
      subject,
      evidence: evidenceFor(suite.requiredEvidenceKinds),
      gateResults: passingGates(suite.requiredGates),
    });
    expect(evaluation.passed).toBe(true);
    expect(evaluation.missingEvidenceKinds).toEqual([]);
    expect(evaluation.failedGates).toEqual([]);
  });

  it("a released organization (real agents artifact) is certifiable", () => {
    const suite = defaultSuiteFor("organization");
    const released = releaseOrganization(orgDraft(), 1_000);
    const artifact = {
      componentKind: "organization",
      artifact: released,
    } as const;
    // A REAL released organization flows through the structural view.
    expect(verifySubjectArtifact(artifact)).toEqual([]);
    const evaluation = evaluateSuite({
      suite,
      subject: { componentKind: "organization", subjectId: released.id, version: "1" },
      evidence: evidenceFor(suite.requiredEvidenceKinds),
      gateResults: passingGates(suite.requiredGates),
    });
    expect(evaluation.passed).toBe(true);
  });

  it("an agent package subject is certifiable; incomplete provenance is not", () => {
    const suite = defaultSuiteFor("agent_package");
    const good = {
      componentKind: "agent_package",
      artifact: {
        id: "pkg:routing",
        version: 4,
        provenance: { source: "registry/pkg-routed", contentHash: "sha256:pkg", createdAt: 1000 },
        evaluationSuiteRef: "evalsuite:routing@2",
      },
    } as const;
    expect(verifySubjectArtifact(good)).toEqual([]);
    const evaluation = evaluateSuite({
      suite,
      subject: { componentKind: "agent_package", subjectId: "pkg:routing", version: "4" },
      evidence: evidenceFor(suite.requiredEvidenceKinds),
      gateResults: passingGates(suite.requiredGates),
    });
    expect(evaluation.passed).toBe(true);

    const bad = {
      componentKind: "agent_package",
      artifact: {
        id: "pkg:routing",
        version: 4,
        provenance: { source: "", contentHash: "", createdAt: 1000 },
        evaluationSuiteRef: "",
      },
    } as const;
    expect(verifySubjectArtifact(bad).length).toBeGreaterThan(0);
  });

  it("a strategy without an explicit execution mode is rejected (INV-C07)", () => {
    const artifact = {
      componentKind: "strategy",
      artifact: {
        candidateId: "cand-2",
        executionMode: "NATIVE_MAGIC_BYPASS",
        stage: "VALIDATED",
        evidence: [{ evidenceId: "ev-1", kind: "REPLAY" }],
      },
    } as const;
    const violations = verifySubjectArtifact(artifact);
    expect(violations).toHaveLength(1);
    expect(String(violations[0]?.problem)).toContain("INV-C07");
  });

  it("an organization without hard constraints is rejected (AGENTS.md rule 14)", () => {
    const artifact = {
      componentKind: "organization",
      artifact: {
        id: "org:weak",
        version: 1,
        release: { releasedAt: 1000, contentHash: "sha256:org" },
        safetyPolicy: { hardConstraints: [] },
      },
    } as const;
    expect(verifySubjectArtifact(artifact).length).toBeGreaterThan(0);
  });

  it("suite evaluation reports missing evidence, failed gates and missing gates", () => {
    const suite = defaultSuiteFor("strategy");
    const evaluation = evaluateSuite({
      suite,
      subject: { componentKind: "strategy", subjectId: "cand-3", version: "1" },
      evidence: evidenceFor(["REPLAY"]),
      gateResults: [
        { gateId: "AUTHORIZATION_GATE", passed: true },
        { gateId: "SECURITY_GATE", passed: false },
      ],
    });
    expect(evaluation.passed).toBe(false);
    expect(evaluation.missingEvidenceKinds).toContain("COUNTERFACTUAL");
    expect(evaluation.failedGates).toEqual(["SECURITY_GATE"]);
    expect(evaluation.missingGates).toContain("COMPLIANCE_GATE");
  });

  it("a suite cannot certify a subject of another component kind", () => {
    expect(() =>
      evaluateSuite({
        suite: defaultSuiteFor("organization"),
        subject: { componentKind: "strategy", subjectId: "cand-4", version: "1" },
        evidence: [],
        gateResults: [],
      }),
    ).toThrow(/certifies organization components/);
  });

  it("the suite registry is versioned and append-only", () => {
    const registry = new CertificationSuiteRegistry();
    const v1 = registry.register(defaultSuiteFor("strategy"));
    const v2 = registry.register({
      ...defaultSuiteFor("strategy"),
      suiteVersion: 2,
      requiredEvidenceKinds: [...defaultSuiteFor("strategy").requiredEvidenceKinds, "AUDIT"],
    });
    expect(v1.suiteVersion).toBe(1);
    expect(v2.suiteVersion).toBe(2);
    expect(() =>
      registry.register(defaultSuiteFor("strategy")),
    ).toThrow(/already registered/);
    expect(registry.historyFor("suite:strategy")).toHaveLength(2);
    expect(registry.latest("suite:strategy")?.suiteVersion).toBe(2);
    // Unregistered kinds fall back to the default suite (every kind stays
    // certifiable).
    expect(registry.forComponentKind("connector").suiteId).toBe("suite:connector");
  });
});

// ---------------------------------------------------------------------------
// Connector certification: the five axes
// ---------------------------------------------------------------------------

describe("connector certification (INV-C05..C09)", () => {
  it("certifies a complete chain with lossless state and valid external funds", () => {
    const registry = completeRegistry();
    const result = certifyConnector({
      registry,
      capabilityIds: ["conn:payments.create-authorization"],
      externalFundsObservations: [fundsObservation],
    });
    expect(result.passed).toBe(true);
    expect(result.hierarchy.complete).toBe(true);
    expect(result.scopeViolations).toEqual([]);
    expect(result.providerStateViolations).toEqual([]);
    expect(result.executionModeViolations).toEqual([]);
    expect(result.externalFundsViolations).toEqual([]);
    // INV-C09: observations are observations, never custody.
    expect(result.externalFundsTreatedAsCustody).toBe(false);

    // The connector result feeds the suite evaluation as gate results.
    const gates = connectorSuiteGateResults(result);
    expect(gates.map((gate) => gate.gateId)).toEqual([
      "HIERARCHY_GATE",
      "SCOPE_GATE",
      "PROVIDER_STATE_GATE",
      "EXECUTION_MODE_GATE",
      "EXTERNAL_FUNDS_GATE",
    ]);
    expect(gates.every((gate) => gate.passed)).toBe(true);
    const suite = defaultSuiteFor("connector");
    const evaluation = evaluateSuite({
      suite,
      subject: {
        componentKind: "connector",
        subjectId: "conn:payments.create-authorization",
        version: "1.0.0",
      },
      evidence: evidenceFor(suite.requiredEvidenceKinds),
      gateResults: [
        ...passingGates(["AUTHORIZATION_GATE", "EVIDENCE_GATE", "SECURITY_GATE"]),
        ...gates,
      ],
    });
    expect(evaluation.passed).toBe(true);
  });

  it("HIERARCHY: an instance without observations is a chain gap", () => {
    const registry = new ConnectorRegistry();
    registry.registerDefinition(paymentDefinition);
    registry.registerProvider({
      providerName: "psp-a",
      providerVersion: "2026-01",
      displayName: "PSP A",
      systemKind: "psp",
    });
    registry.registerImplementation(implementation);
    registry.registerInstance(connectedInstance());
    // No observation recorded.
    const result = certifyConnector({
      registry,
      capabilityIds: ["conn:payments.create-authorization"],
    });
    expect(result.passed).toBe(false);
    expect(result.hierarchy.complete).toBe(false);
    expect(result.hierarchy.gaps.join(" ")).toContain("observation");
    expect(connectorSuiteGateResults(result)[0]?.passed).toBe(false);
  });

  it("SCOPE: a revoked authorization breaks the connected-instance scope (INV-C05)", () => {
    const instance = connectedInstance({
      authorization: { status: "REVOKED", revokedAt: "2026-10-01T00:00:00Z" },
    });
    const violations = verifyConnectedInstanceScope(instance);
    expect(violations).toHaveLength(1);
    expect(String(violations[0]?.problem)).toContain("REVOKED");

    const missingPermissions = verifyConnectedInstanceScope(
      connectedInstance({
        permissionState: {
          granted: [],
          requested: ["payments:write"],
          missing: ["payments:write"],
        },
      }),
    );
    expect(missingPermissions.length).toBeGreaterThan(0);
  });

  it("PROVIDER_STATE: a lossy envelope is rejected (INV-C06)", () => {
    // Raw state erased → the envelope is no longer lossless.
    const lossy = {
      ...stateEnvelope,
      state: undefined,
    } as ProviderStateEnvelope;
    const violations = verifyProviderStatePreservation(lossy);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.map((v) => v.problem).join(" ")).toContain("verbatim");

    // A definition declaring customer actions requires the observation
    // chain to preserve the envelope.
    const registry = new ConnectorRegistry();
    registry.registerDefinition(paymentDefinition);
    registry.registerProvider({
      providerName: "psp-a",
      providerVersion: "2026-01",
      displayName: "PSP A",
      systemKind: "psp",
    });
    registry.registerImplementation(implementation);
    registry.registerInstance(connectedInstance());
    registry.recordObservation(observation(1)); // no externalState
    const result = certifyConnector({
      registry,
      capabilityIds: ["conn:payments.create-authorization"],
    });
    expect(result.providerStateViolations.length).toBeGreaterThan(0);
    expect(
      result.providerStateViolations.map((v) => v.problem).join(" "),
    ).toContain("INV-C06");
  });

  it("EXECUTION_MODE: definitions without explicit modes or protocol authorization are rejected (INV-C07)", () => {
    const noModes = verifyExecutionModesDeclaration({
      ...paymentDefinition,
      executionModes: [],
    });
    expect(noModes.length).toBeGreaterThan(0);

    const bypass = verifyExecutionModesDeclaration({
      ...paymentDefinition,
      authorization: {
        ...paymentDefinition.authorization,
        protocolAuthorization: false,
      } as unknown as CapabilityDefinition["authorization"],
    } as CapabilityDefinition);
    expect(bypass.map((v) => v.problem).join(" ")).toContain(
      "no execution mode can bypass protocol authorization",
    );
  });

  it("EXTERNAL_FUNDS: observations without freshness are rejected (INV-C09)", () => {
    const stale = {
      ...fundsObservation,
      freshness: undefined,
    } as unknown as ExternalFundsPositionObservation;
    const violations = verifyExternalFundsObservation(stale);
    expect(violations).toHaveLength(1);
    expect(String(violations[0]?.problem)).toContain("freshness");

    expect(verifyExternalFundsObservation(fundsObservation)).toEqual([]);
  });
});

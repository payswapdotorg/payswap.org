import { describe, expect, it } from "vitest";
import { ValidationError } from "@payswap/protocol";
import {
  ConnectorRegistry,
  ConnectorRegistryError,
  observeCapability,
} from "../src/index.js";
import type {
  CapabilityDefinition,
  ConnectedCapabilityInstance,
  ConnectorCapabilityPack,
  ProviderCatalogueEntry,
  ProviderImplementation,
} from "../src/index.js";

/**
 * The generalized Connector registry: definition → implementation →
 * instance → observation chain completeness; packs map only to capabilities
 * actually exposed by ConnectedCapabilityInstances; a ProviderCatalogueEntry
 * can never become an instance (INV-C05); provider-native optimization is a
 * registered, benchmark-flagged capability (INV-C08); non-PSP systems use
 * the SAME registry.
 */

const paymentCreateDefinition: CapabilityDefinition = {
  capabilityId: "conn:payments.create-authorization",
  capabilityVersion: "1.0.0",
  summary: "Create a payment authorization on a connected PSP account.",
  kind: "ACTION",
  requiredPermissions: ["payments:write"],
  executionModes: ["PASS_THROUGH_NATIVE", "COMPOSED_PAYSWAP", "OPTIMIZED_MULTI_PROVIDER"],
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
      effect: "Reserves the authorized amount.",
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
    compensable: true,
    compensationCapabilityId: "conn:payments.cancel-authorization",
    cancellation: "BEFORE_EXECUTION",
    partialExecution: { possible: false, granularity: "ATOMIC", onPartial: "DISCLOSED" },
  },
  requiredCustomerActions: [
    { action: "authenticate", actor: "CUSTOMER", description: "Complete the challenge." },
  ],
  providerVocabulary: {
    actions: [{ action: "capture", description: "Capture an authorized amount." }],
    states: [
      {
        providerState: "succeeded",
        canonicalState: "AUTHORIZED",
        requiresCustomerAction: false,
        isTerminal: true,
      },
    ],
  },
  externalObjects: [
    {
      objectType: "PAYMENT_INTENT",
      idFormat: "opaque id",
      revisioned: true,
      revisionFormat: "revision integer",
    },
  ],
  evidence: {
    produced: ["EXECUTION", "STATE_OBSERVATION"],
    required: ["AUTHORIZATION"],
  },
  economics: {
    feeModel: "VARIABLE_BPS",
    limits: [
      { dimension: "AMOUNT", description: "Per-transaction cap.", amount: { currency: "USD", minorUnits: "100000000" } },
    ],
    settlementImplications: "Settles to the merchant settlement destination.",
  },
  constraints: [
    { kind: "JURISDICTION", description: "Licensed jurisdictions only.", countryCodes: ["DE", "FR"] },
  ],
};

const nativeRoutingDefinition: CapabilityDefinition = {
  ...paymentCreateDefinition,
  capabilityId: "conn:payments.native-routing",
  summary: "The provider's own payment-method routing optimization (incumbent baseline).",
  requiredPermissions: ["payments:route"],
  nativeOptimization: { optimizationKind: "ROUTING", benchmarkBaseline: true },
};

const crmSearchDefinition: CapabilityDefinition = {
  ...paymentCreateDefinition,
  capabilityId: "conn:crm.search-contacts",
  summary: "Search contacts in a connected CRM.",
  kind: "SEARCH",
  requiredPermissions: ["crm:read"],
  executionModes: ["PASS_THROUGH_NATIVE"],
  sideEffects: [
    { effect: "Read-only query.", financialEffect: "NO_FINANCIAL_EFFECT", reversible: true },
  ],
  compensation: {
    compensable: false,
    cancellation: "NOT_SUPPORTED",
    partialExecution: { possible: false, granularity: "ATOMIC", onPartial: "DISCLOSED" },
  },
  requiredCustomerActions: [],
  economics: { feeModel: "NONE", limits: [], settlementImplications: "None." },
};

const pspAImplementation: ProviderImplementation = {
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
  knownDeviations: [
    {
      aspect: "partial capture",
      deviation: "Provider supports partial captures; the definition models them as STAGED.",
      documented: true,
    },
  ],
  nativeOptimization: {
    representableAsCapability: true,
    capabilityId: "conn:payments.native-routing",
  },
};

const instance: ConnectedCapabilityInstance = {
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
};

const catalogueEntry: ProviderCatalogueEntry = {
  catalogueEntryId: "cat:psp-a-payments",
  providerName: "psp-a",
  providerVersion: "2026-01",
  capabilityId: "conn:payments.create-authorization",
  summary: "Platform-wide advertisement.",
  advertisedScope: {
    platformWide: true,
    advertisedGeographies: ["*"],
    advertisedCurrencies: ["*"],
  },
};

const paymentsPack: ConnectorCapabilityPack = {
  packId: "pack:psp-a-payments",
  family: "payments",
  version: "4.1.0",
  subPacks: [],
  capabilityRefs: [
    { capabilityId: "conn:payments.create-authorization", capabilityVersion: "1.0.0" },
  ],
  auth: { authKind: "OAUTH", scopes: ["payments:write"] },
  schemas: [{ schemaId: "schemas/payments/intent", version: "1.1.0" }],
  objectMappings: [
    {
      externalObjectType: "PAYMENT_INTENT",
      canonicalObjectRef: "work-graph/payment-intent",
      sourceOfTruth: "EXTERNAL_AUTHORITATIVE",
    },
  ],
  sourceOfTruth: "EXTERNAL_AUTHORITATIVE",
  rateLimits: [{ limit: 100, windowSeconds: 1, scope: "per-connected-instance" }],
  provenance: {
    publisher: "payswap-connector-publishers/psp-a",
    publishedAt: "2026-09-30T00:00:00Z",
    contentHash: "sha256:pack",
  },
  evidence: [{ evidenceId: "ev-pack-1", artifactRef: "artifacts/psp-a-payments.tgz" }],
};

function observation(version: number, sourceAvailability: "REACHABLE" | "UNREACHABLE" | "UNKNOWN" = "REACHABLE") {
  return observeCapability({
    instanceId: "inst:acct-1-payments",
    observedAt: `2026-10-01T12:00:0${version}Z`,
    observationVersion: version,
    capabilityState: "AVAILABLE",
    sourceAvailability,
    eligibility: "ELIGIBLE",
    health: { status: "HEALTHY", lastCheckedAt: `2026-10-01T12:00:0${version}Z` },
    provenance: {
      providerName: "psp-a",
      source: "PROVIDER_API",
      capturedAt: `2026-10-01T12:00:0${version}Z`,
    },
  });
}

describe("chain completeness: definition → implementation → instance → observation", () => {
  it("enforces the chain at every registration step", () => {
    const registry = new ConnectorRegistry();
    registry.registerProvider({
      providerName: "psp-a",
      providerVersion: "2026-01",
      systemKind: "psp",
      displayName: "PSP A",
    });

    // instance before implementation → rejected
    expect(() => registry.registerInstance(instance)).toThrow(ConnectorRegistryError);
    expect(() => registry.registerInstance(instance)).toThrow(
      /references implementation 'impl:psp-a-payments-1' which is not registered/,
    );

    // implementation before definition → rejected
    expect(() => registry.registerImplementation(pspAImplementation)).toThrow(
      /references capability 'conn:payments.create-authorization' which is not a registered CapabilityDefinition/,
    );

    // definition first, then the implementation passes
    registry.registerDefinition(paymentCreateDefinition);
    registry.registerImplementation(pspAImplementation);
    registry.registerInstance(instance);

    // observation before instance would be rejected; here the instance exists
    expect(() => registry.recordObservation(observation(1))).not.toThrow();
    expect(() =>
      registry.recordObservation(
        observeCapability({
          instanceId: "inst:unknown",
          observedAt: "2026-10-01T12:00:00Z",
          observationVersion: 1,
          capabilityState: "AVAILABLE",
          sourceAvailability: "REACHABLE",
          eligibility: "ELIGIBLE",
          health: { status: "HEALTHY", lastCheckedAt: "2026-10-01T12:00:00Z" },
          provenance: { providerName: "psp-a", source: "INTERNAL", capturedAt: "2026-10-01T12:00:00Z" },
        }),
      ),
    ).toThrow(/which is not registered/);
  });

  it("requires strictly monotonic per-instance observation versions", () => {
    const registry = new ConnectorRegistry();
    registry.registerProvider({
      providerName: "psp-a",
      providerVersion: "2026-01",
      systemKind: "psp",
      displayName: "PSP A",
    });
    registry.registerDefinition(paymentCreateDefinition);
    registry.registerImplementation(pspAImplementation);
    registry.registerInstance(instance);
    registry.recordObservation(observation(2));
    expect(() => registry.recordObservation(observation(2))).toThrow(/strictly monotonic/);
    expect(() => registry.recordObservation(observation(1))).toThrow(/strictly monotonic/);
    registry.recordObservation(observation(3));
    expect(registry.observationsFor("inst:acct-1-payments")).toHaveLength(2);
    expect(registry.latestObservationFor("inst:acct-1-payments")?.observationVersion).toBe(3);
  });

  it("validateChain reports completion once the chain is whole", () => {
    const registry = new ConnectorRegistry();
    registry.registerProvider({
      providerName: "psp-a",
      providerVersion: "2026-01",
      systemKind: "psp",
      displayName: "PSP A",
    });
    registry.registerDefinition(paymentCreateDefinition);
    registry.registerImplementation(pspAImplementation);
    registry.registerInstance(instance);

    // The instance exists but has no observation yet — the chain is incomplete.
    const before = registry.validateChain();
    expect(before.complete).toBe(false);
    expect(before.gaps.some((gap) => gap.link === "observation")).toBe(true);

    registry.recordObservation(observation(1));
    expect(registry.validateChain()).toEqual({ complete: true, gaps: [] });
  });
});

describe("INV-C05: a provider catalogue entry can never be registered as an instance", () => {
  it("rejects the catalogue entry with an explicit registry error", () => {
    const registry = new ConnectorRegistry();
    expect(() =>
      registry.registerInstance(catalogueEntry as never),
    ).toThrow(ConnectorRegistryError);
    expect(() => registry.registerInstance(catalogueEntry as never)).toThrow(
      /INV-C05.*never authorize execution/s,
    );
    expect(registry.allInstances()).toHaveLength(0);
  });

  it("lookups never fabricate an instance from a catalogue claim (INV-NC04)", () => {
    const registry = new ConnectorRegistry();
    expect(() => registry.assertInstance("cat:psp-a-payments")).toThrow(ValidationError);
    expect(registry.instancesForCapability("conn:payments.create-authorization")).toEqual([]);
  });
});

describe("packs map only to capabilities exposed by connected instances", () => {
  it("rejects a pack whose capabilities are not exposed by any instance", () => {
    const registry = new ConnectorRegistry();
    registry.registerProvider({
      providerName: "psp-a",
      providerVersion: "2026-01",
      systemKind: "psp",
      displayName: "PSP A",
    });
    registry.registerDefinition(paymentCreateDefinition);
    registry.registerImplementation(pspAImplementation);

    expect(() => registry.registerPack(paymentsPack)).toThrow(
      /not exposed by any ConnectedCapabilityInstance/,
    );

    registry.registerInstance(instance);
    expect(() => registry.registerPack(paymentsPack)).not.toThrow();
    expect(registry.pack("pack:psp-a-payments")?.version).toBe("4.1.0");
  });
});

describe("INV-C08: provider-native optimization is a registered, benchmark-flagged capability", () => {
  it("registers the incumbent baseline and exposes it to the Lab", () => {
    const registry = new ConnectorRegistry();
    registry.registerProvider({
      providerName: "psp-a",
      providerVersion: "2026-01",
      systemKind: "psp",
      displayName: "PSP A",
    });
    registry.registerDefinition(paymentCreateDefinition);
    registry.registerDefinition(nativeRoutingDefinition);
    registry.registerImplementation(pspAImplementation);
    registry.registerImplementation({
      ...pspAImplementation,
      implementationId: "impl:psp-a-native-routing-1",
      capabilityId: "conn:payments.native-routing",
      capabilityVersion: "1.0.0",
      corridors: [],
    });
    registry.registerInstance({
      ...instance,
      instanceId: "inst:acct-1-native-routing",
      capabilityId: "conn:payments.native-routing",
      implementationId: "impl:psp-a-native-routing-1",
    });

    const baselines = registry.benchmarkBaselines();
    expect(baselines.map((definition) => definition.capabilityId)).toEqual([
      "conn:payments.native-routing",
    ]);
    expect(baselines[0]?.nativeOptimization?.optimizationKind).toBe("ROUTING");
    // The ordinary payment capability is not flagged as an incumbent baseline.
    expect(
      registry
        .definition("conn:payments.create-authorization")
        ?.nativeOptimization,
    ).toBeUndefined();
  });
});

describe("non-PSP systems expose capabilities through the SAME registry", () => {
  it("registers a CRM connector with SEARCH/READ/EVENT capabilities", () => {
    const registry = new ConnectorRegistry();
    registry.registerProvider({
      providerName: "crm-x",
      providerVersion: "3.2",
      systemKind: "crm",
      displayName: "CRM X",
    });
    registry.registerDefinition(crmSearchDefinition);
    registry.registerImplementation({
      implementationId: "impl:crm-x-search-1",
      providerName: "crm-x",
      providerVersion: "3.2",
      capabilityId: "conn:crm.search-contacts",
      capabilityVersion: "1.0.0",
      version: "1.0.0",
      adapterRef: "future-adapter:crm-x@1",
      corridors: [],
      knownDeviations: [],
    });
    registry.registerInstance({
      ...instance,
      instanceId: "inst:tenant-1-crm-search",
      capabilityId: "conn:crm.search-contacts",
      implementationId: "impl:crm-x-search-1",
      providerName: "crm-x",
      providerVersion: "3.2",
      permissionState: { granted: ["crm:read"], requested: ["crm:read"], missing: [] },
      currencies: ["*"],
      geography: { countries: ["*"] },
    });

    expect(registry.allProviders().map((provider) => provider.systemKind)).toContain("crm");
    expect(
      registry.definitionsOfKind("SEARCH").map((definition) => definition.capabilityId),
    ).toEqual(["conn:crm.search-contacts"]);
    expect(registry.instance("inst:tenant-1-crm-search")).toBeDefined();
  });
});

describe("provider/corridor queries", () => {
  it("answers implementations serving a corridor deterministically", () => {
    const registry = new ConnectorRegistry();
    registry.registerProvider({
      providerName: "psp-a",
      providerVersion: "2026-01",
      systemKind: "psp",
      displayName: "PSP A",
    });
    registry.registerDefinition(paymentCreateDefinition);
    registry.registerImplementation(pspAImplementation);

    expect(
      registry
        .implementationsServingCorridor({ fromCountry: "DE", toCountry: "FR", currency: "EUR" })
        .map((implementation) => implementation.implementationId),
    ).toEqual(["impl:psp-a-payments-1"]);
    expect(registry.implementationsServingCorridor({ currency: "JPY" })).toEqual([]);
    expect(
      registry.implementationsForDefinition("conn:payments.create-authorization"),
    ).toHaveLength(1);
  });
});

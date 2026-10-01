import { describe, expect, it } from "vitest";
import { ValidationError } from "@payswap/protocol";
import {
  CONNECTOR_CAPABILITY_KINDS,
  EVIDENCE_KINDS,
  FINANCIAL_EFFECT_CLASSIFICATIONS,
  validateCapabilityDefinition,
} from "../src/index.js";
import type { CapabilityDefinition } from "../src/index.js";

/**
 * CapabilityDefinition — the §2A declaration completeness contract:
 * canonical semantics + state machine, preconditions, authorization,
 * side effects + financial effect classification, idempotency/retry,
 * compensation/partial execution, customer actions, provider vocabulary,
 * external objects/revisions, evidence, economics, constraints — plus the
 * INV-C07 authorization coupling and the INV-C08 incumbent-baseline flag.
 */

/** Shared fixture: the canonical fully-declared payment authorization definition. */
const paymentCreate: CapabilityDefinition = {
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
  preconditions: [
    "A ConnectedCapabilityInstance for this capability is authorized and eligible.",
  ],
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
    compensable: true,
    compensationCapabilityId: "conn:payments.cancel-authorization",
    cancellation: "BEFORE_EXECUTION",
    partialExecution: {
      possible: false,
      granularity: "ATOMIC",
      onPartial: "DISCLOSED",
    },
  },
  requiredCustomerActions: [
    {
      action: "authenticate",
      actor: "CUSTOMER",
      description: "Complete the provider's authentication challenge (e.g. 3DS).",
    },
  ],
  providerVocabulary: {
    actions: [
      { action: "capture", description: "Capture an authorized amount." },
    ],
    states: [
      {
        providerState: "requires_action",
        canonicalState: "PENDING_CUSTOMER_ACTION",
        requiresCustomerAction: true,
        isTerminal: false,
      },
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
      idFormat: "provider-scoped opaque identifier",
      revisioned: true,
      revisionFormat: "monotonic revision integer",
    },
  ],
  evidence: {
    produced: ["EXECUTION", "STATE_OBSERVATION"],
    required: ["AUTHORIZATION"],
  },
  economics: {
    feeModel: "VARIABLE_BPS",
    limits: [
      {
        dimension: "AMOUNT",
        description: "Per-transaction maximum.",
        amount: { currency: "USD", minorUnits: "100000000" },
      },
    ],
    settlementImplications:
      "Captured value settles to the merchant's settlement destination per contract.",
  },
  constraints: [
    {
      kind: "JURISDICTION",
      description: "Offered only in licensed jurisdictions.",
      countryCodes: ["DE", "FR", "US"],
    },
  ],
};



describe("CapabilityDefinition declaration completeness (§2A)", () => {
  it("validates a fully declared definition", () => {
    const parsed = validateCapabilityDefinition(paymentCreate);
    expect(parsed.capabilityId).toBe("conn:payments.create-authorization");
    expect(parsed.authorization.protocolAuthorization).toBe(true);
    expect(parsed.executionModes).toHaveLength(3);
  });

  it("requires protocol authorization to be declared true (INV-C07)", () => {
    expect(() =>
      validateCapabilityDefinition({
        ...paymentCreate,
        authorization: {
          ...paymentCreate.authorization,
          protocolAuthorization: false,
        },
      }),
    ).toThrow(/protocolAuthorization must be declared true.*INV-C07/);
  });

  it("requires at least one explicit execution mode (INV-C07)", () => {
    expect(() =>
      validateCapabilityDefinition({ ...paymentCreate, executionModes: [] }),
    ).toThrow(/executionModes must declare at least one explicit mode/);
    expect(() =>
      validateCapabilityDefinition({
        ...paymentCreate,
        executionModes: ["AUTOMATIC"],
      }),
    ).toThrow(/unknown execution mode 'AUTOMATIC'/);
    expect(() =>
      validateCapabilityDefinition({
        ...paymentCreate,
        executionModes: ["COMPOSED_PAYSWAP", "COMPOSED_PAYSWAP"],
      }),
    ).toThrow(/duplicate execution mode/);
  });

  it("forbids blind retries of non-idempotent capabilities (INV-X02)", () => {
    expect(() =>
      validateCapabilityDefinition({
        ...paymentCreate,
        idempotency: {
          idempotent: false,
          keyScope: "REQUEST",
          duplicateBehavior: "PROVIDER_DEFINED",
          retryPolicy: "SAFE_TO_RETRY",
        },
      }),
    ).toThrow(/REQUIRES_RECONCILIATION.*INV-X02/);
    expect(() =>
      validateCapabilityDefinition({
        ...paymentCreate,
        idempotency: {
          idempotent: false,
          keyScope: "REQUEST",
          duplicateBehavior: "PROVIDER_DEFINED",
          retryPolicy: "REQUIRES_RECONCILIATION",
        },
      }),
    ).not.toThrow();
  });

  it("requires a named compensation capability when compensable", () => {
    const { compensationCapabilityId: _omitted, ...compensation } =
      paymentCreate.compensation;
    expect(() =>
      validateCapabilityDefinition({
        ...paymentCreate,
        compensation,
      }),
    ).toThrow(/compensationCapabilityId is required when compensable/);
  });

  it("requires a revision format for revisioned external objects", () => {
    expect(() =>
      validateCapabilityDefinition({
        ...paymentCreate,
        externalObjects: [
          { objectType: "PAYMENT_INTENT", idFormat: "opaque", revisioned: true },
        ],
      }),
    ).toThrow(/revisionFormat is required when revisioned/);
  });

  it("rejects unknown evidence kinds and vocabulary comes from the closed sets", () => {
    expect(() =>
      validateCapabilityDefinition({
        ...paymentCreate,
        evidence: { produced: ["MYSTERY"], required: [] },
      }),
    ).toThrow(/not a known evidence kind/);
    expect([...EVIDENCE_KINDS]).toContain("RECONCILIATION");
    expect([...FINANCIAL_EFFECT_CLASSIFICATIONS]).toContain("RESERVES_VALUE");
  });
});

describe("generalized capability kinds (non-PSP systems use the same registry)", () => {
  it("includes search/read/write/action/event/health", () => {
    expect([...CONNECTOR_CAPABILITY_KINDS]).toEqual([
      "SEARCH",
      "READ",
      "WRITE",
      "ACTION",
      "EVENT",
      "HEALTH",
    ]);
  });

  it("validates a non-PSP (CRM) capability definition through the same contract", () => {
    const crmSearch = validateCapabilityDefinition({
      ...paymentCreate,
      capabilityId: "conn:crm.search-contacts",
      kind: "SEARCH",
      summary: "Search contacts in a connected CRM.",
      requiredPermissions: ["crm:read"],
      executionModes: ["PASS_THROUGH_NATIVE"],
      sideEffects: [
        {
          effect: "Read-only query; no external mutation.",
          financialEffect: "NO_FINANCIAL_EFFECT",
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
      requiredCustomerActions: [],
      economics: {
        feeModel: "NONE",
        limits: [],
        settlementImplications: "None — no financial effect.",
      },
    });
    expect(crmSearch.kind).toBe("SEARCH");
    expect(() => validateCapabilityDefinition({ ...paymentCreate, kind: "CRUD" })).toThrow(
      /kind must be one of/,
    );
  });
});

describe("provider-native optimization as a capability (INV-C08)", () => {
  it("accepts and flags an incumbent benchmark baseline", () => {
    const nativeRouting = validateCapabilityDefinition({
      ...paymentCreate,
      capabilityId: "conn:payments.native-routing",
      summary: "The provider's native payment-method routing optimization.",
      nativeOptimization: {
        optimizationKind: "ROUTING",
        benchmarkBaseline: true,
      },
    });
    expect(nativeRouting.nativeOptimization?.benchmarkBaseline).toBe(true);
  });

  it("rejects a native-optimization declaration without the benchmark baseline flag", () => {
    expect(() =>
      validateCapabilityDefinition({
        ...paymentCreate,
        nativeOptimization: {
          optimizationKind: "RECOVERY",
          benchmarkBaseline: false,
        },
      }),
    ).toThrow(/benchmarkBaseline must be true.*INV-C08/);
  });
});

describe("validation error type", () => {
  it("throws protocol ValidationError for malformed input", () => {
    let thrown = false;
    try {
      validateCapabilityDefinition({ capabilityId: "" });
    } catch (error) {
      thrown = true;
      expect(error).toBeInstanceOf(ValidationError);
    }
    expect(thrown).toBe(true);
  });
});

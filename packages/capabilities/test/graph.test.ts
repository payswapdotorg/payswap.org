import { describe, expect, it } from "vitest";
import {
  CapabilityGraphStore,
  isAcceptanceCapability,
  isServiceAccessCapability,
} from "../src/index.js";
import type {
  AcceptanceCapability,
  Capability,
  CapabilityClass,
  FundingCredentialScope,
  ServiceAccessCapability,
  ServiceCredentialScope,
} from "../src/index.js";
import type { Equal, Expect } from "./type-utils.js";

/**
 * W2-003 — Capability Graph (FROZEN-ARCHITECTURE §11).
 *
 * Register/query by class + conditions; AcceptanceCapability queryable as a
 * capability; ServiceAccessCapability describes service acquisition
 * INDEPENDENT from funding, with funding and service credentials as distinct
 * non-interchangeable types.
 */

function baseCapability(
  id: string,
  capabilityClass: CapabilityClass,
): Capability {
  return {
    id,
    capabilityClass,
    conditions: [
      { kind: "eligibility", description: "test eligibility", hardConstraint: true },
    ],
    cost: [],
    risk: { riskClass: "test", severity: "low", mitigations: [] },
    provenance: {
      declaredBy: "test",
      artifactRef: "artifacts/test",
      contentHash: "sha256:test",
    },
    economicAccountability: {
      accountablePartyRef: "party:test",
      ledgerAccountRef: "acct:test",
      recoursePolicyRef: "policy:test",
    },
    proofRequirements: [{ proofLevel: "P1" }],
  };
}

function acceptanceCapability(id: string): AcceptanceCapability {
  return {
    ...baseCapability(id, "merchant_acceptance"),
    capabilityClass: "merchant_acceptance",
    acceptedPaymentMethods: ["card", "sepa_debit"],
    acceptedCurrencies: ["EUR", "USD"],
    acceptedCountries: ["DE", "FR"],
    terms: {
      supportsRecurring: true,
      supportsPartialPayments: false,
      supportsRefunds: true,
      recoursePolicyRef: "policy:acceptance",
    },
  };
}

function serviceAccessCapability(id: string): ServiceAccessCapability {
  return {
    ...baseCapability(id, "developer_service"),
    capabilityClass: "developer_service",
    serviceId: "svc:forecast-api",
    fundingCredential: {
      kind: "funding_credential",
      credentialRef: "cred:card-on-file-1",
      credentialType: "card_on_file",
    },
    serviceCredential: {
      kind: "service_credential",
      credentialRef: "cred:subscription-1",
      credentialType: "subscription_entitlement",
    },
    subscriptionModel: "SUBSCRIPTION",
  };
}

describe("CapabilityGraphStore: register/query by class + conditions", () => {
  it("registers capabilities and assigns deterministic registration order", () => {
    const store = new CapabilityGraphStore();
    store.register({
      capability: baseCapability("cap:fx-1", "fx"),
      sourceId: "source:fx",
      capabilityState: "AVAILABLE",
      sourceAvailability: "REACHABLE",
    });
    store.register({
      capability: baseCapability("cap:fx-2", "fx"),
      sourceId: "source:fx",
      capabilityState: "DEGRADED",
      sourceAvailability: "REACHABLE",
    });
    expect(store.entries.length).toBe(2);
    const first = store.entries[0];
    const second = store.entries[1];
    expect(first?.registrationSequence).toBe(1);
    expect(second?.registrationSequence).toBe(2);
    expect(store.byId("cap:fx-1")?.capabilityClass).toBe("fx");
    expect(store.byId("cap:missing")).toBeUndefined();
  });

  it("resolves by class and required condition kinds (delegates to the frozen resolver)", () => {
    const store = new CapabilityGraphStore();
    store.register({
      capability: {
        ...baseCapability("cap:liquidity-1", "liquidity"),
        conditions: [
          { kind: "eligibility", description: "eligible", hardConstraint: true },
          { kind: "compliance", description: "KYC cleared", hardConstraint: true },
        ],
      },
      sourceId: "source:bank",
      capabilityState: "AVAILABLE",
      sourceAvailability: "REACHABLE",
    });
    store.register({
      capability: {
        ...baseCapability("cap:liquidity-2", "liquidity"),
        conditions: [
          { kind: "eligibility", description: "eligible", hardConstraint: true },
        ],
      },
      sourceId: "source:bank",
      capabilityState: "AVAILABLE",
      sourceAvailability: "REACHABLE",
    });

    const resolution = store.resolve({
      capabilityClass: "liquidity",
      requiredConditionKinds: ["compliance"],
    });
    expect(resolution.candidates.map((candidate) => candidate.capability.id)).toEqual([
      "cap:liquidity-1",
    ]);
    expect(resolution.selected?.capability.id).toBe("cap:liquidity-1");
  });

  it("rejects duplicate ids and invalid two-axis values", () => {
    const store = new CapabilityGraphStore();
    store.register({
      capability: baseCapability("cap:dup", "fx"),
      sourceId: "source:fx",
      capabilityState: "AVAILABLE",
      sourceAvailability: "REACHABLE",
    });
    expect(() =>
      store.register({
        capability: baseCapability("cap:dup", "fx"),
        sourceId: "source:fx",
        capabilityState: "AVAILABLE",
        sourceAvailability: "REACHABLE",
      }),
    ).toThrow(/already registered/);
    expect(() =>
      store.register({
        capability: baseCapability("cap:bad-state", "fx"),
        sourceId: "source:fx",
        capabilityState: "FAILED" as never,
        sourceAvailability: "REACHABLE",
      }),
    ).toThrow(/invalid capabilityState/);
    expect(() =>
      store.register({
        capability: baseCapability("cap:bad-source", "fx"),
        sourceId: "source:fx",
        capabilityState: "AVAILABLE",
        sourceAvailability: "REACHABLE-ish" as never,
      }),
    ).toThrow(/invalid sourceAvailability/);
  });
});

describe("merchant acceptance is queryable as a capability (§11)", () => {
  it("filters acceptance candidates by method, currency and country", () => {
    const store = new CapabilityGraphStore();
    store.register({
      capability: acceptanceCapability("cap:acceptance-de"),
      sourceId: "source:merchant-1",
      capabilityState: "AVAILABLE",
      sourceAvailability: "REACHABLE",
    });
    store.register({
      capability: baseCapability("cap:unrelated", "fx"),
      sourceId: "source:fx",
      capabilityState: "AVAILABLE",
      sourceAvailability: "REACHABLE",
    });

    const cardEur = store.queryAcceptance({
      paymentMethod: "card",
      currency: "EUR",
      country: "DE",
    });
    expect(cardEur.length).toBe(1);
    expect(cardEur[0]?.capability.id).toBe("cap:acceptance-de");
    expect(cardEur[0]?.effectiveAvailability).toBe("AVAILABLE");

    expect(store.queryAcceptance({ paymentMethod: "blik" })).toHaveLength(0);
    expect(store.queryAcceptance({ currency: "JPY" })).toHaveLength(0);
    expect(store.queryAcceptance({ country: "JP" })).toHaveLength(0);
    expect(
      store.queryAcceptance({ requireRecurringSupport: true }).map(
        (candidate) => candidate.capability.id,
      ),
    ).toEqual(["cap:acceptance-de"]);
  });

  it("keeps unreachable-source acceptance candidates with UNKNOWN availability (INV-C02)", () => {
    const store = new CapabilityGraphStore();
    store.register({
      capability: acceptanceCapability("cap:acceptance-unreachable"),
      sourceId: "source:merchant-2",
      capabilityState: "AVAILABLE",
      sourceAvailability: "UNREACHABLE",
    });
    const candidates = store.queryAcceptance({ paymentMethod: "card" });
    expect(candidates.length).toBe(1);
    expect(candidates[0]?.sourceAvailability).toBe("UNREACHABLE");
    expect(candidates[0]?.effectiveAvailability).toBe("UNKNOWN");
  });

  it("narrows via isAcceptanceCapability", () => {
    expect(isAcceptanceCapability(acceptanceCapability("cap:a"))).toBe(true);
    expect(isAcceptanceCapability(baseCapability("cap:b", "merchant_acceptance"))).toBe(
      false,
    );
    expect(isAcceptanceCapability(baseCapability("cap:c", "fx"))).toBe(false);
  });
});

describe("ServiceAccessCapability: service acquisition independent from funding", () => {
  it("is queryable by serviceId and subscription model", () => {
    const store = new CapabilityGraphStore();
    store.register({
      capability: serviceAccessCapability("cap:service-forecast"),
      sourceId: "source:provider",
      capabilityState: "AVAILABLE",
      sourceAvailability: "REACHABLE",
    });
    const found = store.queryServiceAccess({ serviceId: "svc:forecast-api" });
    expect(found.length).toBe(1);
    expect(found[0]?.capability.fundingCredential.kind).toBe("funding_credential");
    expect(found[0]?.capability.serviceCredential.kind).toBe("service_credential");
    expect(store.queryServiceAccess({ serviceId: "svc:other" })).toHaveLength(0);
    expect(
      store.queryServiceAccess({ subscriptionModel: "USAGE_BASED" }),
    ).toHaveLength(0);
  });

  it("separates funding and service credentials at the type level", () => {
    const funding: FundingCredentialScope = {
      kind: "funding_credential",
      credentialRef: "cred:card",
      credentialType: "card_on_file",
    };
    const service: ServiceCredentialScope = {
      kind: "service_credential",
      credentialRef: "cred:sub",
      credentialType: "subscription_entitlement",
    };
    // @ts-expect-error — a funding credential is never a service credential
    const notService: ServiceCredentialScope = funding;
    // @ts-expect-error — a service credential is never a funding credential
    const notFunding: FundingCredentialScope = service;
    expect(notService).toBeDefined();
    expect(notFunding).toBeDefined();

    type Cases = [
      Expect<Equal<FundingCredentialScope["kind"], "funding_credential">>,
      Expect<Equal<ServiceCredentialScope["kind"], "service_credential">>,
    ];
    const cases: Cases = [true, true];
    expect(cases).toEqual([true, true]);
  });

  it("narrows via isServiceAccessCapability", () => {
    expect(isServiceAccessCapability(serviceAccessCapability("cap:s"))).toBe(true);
    expect(isServiceAccessCapability(baseCapability("cap:t", "developer_service"))).toBe(
      false,
    );
  });
});

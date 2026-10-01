import { describe, expect, it } from "vitest";
import { ValidationError } from "@payswap/protocol";
import {
  ConnectorAuthorityError,
  assertConnectedInstance,
  isConnectedCapabilityInstance,
  isProviderCatalogueEntry,
  validateConnectedCapabilityInstance,
  validateProviderCatalogueEntry,
} from "../src/index.js";
import type {
  ConnectedCapabilityInstance,
  ProviderCatalogueEntry,
} from "../src/index.js";

/**
 * INV-C05: a ConnectedCapabilityInstance is scoped to a REAL provider
 * account/tenant, credential scope, authorization, geography/currency and
 * permission state. A ProviderCatalogueEntry is a structurally distinct,
 * NON-ASSIGNABLE type — a provider catalogue claim NEVER authorizes
 * execution (catalogue → instance rejection at the type level AND at
 * runtime).
 */

const instance: ConnectedCapabilityInstance = {
  instanceId: "inst:acct-1-payments",
  capabilityId: "conn:payments.create-authorization",
  implementationId: "impl:psp-a-payments-1",
  providerName: "psp-a",
  providerVersion: "2026-01",
  accountRef: "acct:merchant-1",
  tenantRef: "tenant:merchant-1",
  authorization: {
    status: "ACTIVE",
    grantedAt: "2026-09-01T00:00:00Z",
    authorizationRef: "authz:oauth-1",
  },
  credentialScope: {
    credentialRef: "cred:oauth-merchant-1",
    credentialKind: "OAUTH",
    delegationRef: "deleg:merchant-1",
  },
  geography: { countries: ["DE", "FR"] },
  currencies: ["EUR", "USD"],
  permissionState: {
    granted: ["payments:write"],
    requested: ["payments:write"],
    missing: [],
  },
  eligibility: { eligible: true, reasons: [] },
  configuration: {
    captureMode: "automatic",
    statementDescriptor: "MERCHANT 1",
  },
};

const catalogue: ProviderCatalogueEntry = {
  catalogueEntryId: "cat:psp-a-payments",
  providerName: "psp-a",
  providerVersion: "2026-01",
  capabilityId: "conn:payments.create-authorization",
  summary: "PSP A advertises payment creation platform-wide.",
  advertisedScope: {
    platformWide: true,
    advertisedGeographies: ["*"],
    advertisedCurrencies: ["*"],
  },
};

describe("catalogue ≠ instance (INV-C05)", () => {
  it("is non-assignable in BOTH directions at the type level", () => {
    // @ts-expect-error — INV-C05: a catalogue entry is not a connected instance
    const notAnInstance: ConnectedCapabilityInstance = catalogue;
    // @ts-expect-error — INV-C05: a connected instance is not a catalogue entry
    const notACatalogue: ProviderCatalogueEntry = instance;
    expect(notAnInstance).toBeDefined();
    expect(notACatalogue).toBeDefined();
  });

  it("runtime guards keep the two families distinct", () => {
    expect(isProviderCatalogueEntry(catalogue)).toBe(true);
    expect(isConnectedCapabilityInstance(catalogue)).toBe(false);
    expect(isConnectedCapabilityInstance(instance)).toBe(true);
    expect(isProviderCatalogueEntry(instance)).toBe(false);
  });

  it("assertConnectedInstance rejects a catalogue entry with an explicit INV-C05 error", () => {
    expect(() => assertConnectedInstance(catalogue)).toThrow(ConnectorAuthorityError);
    expect(() => assertConnectedInstance(catalogue)).toThrow(
      /INV-C05.*never authorize execution/s,
    );
  });

  it("assertConnectedInstance accepts a genuine instance and rejects malformed objects", () => {
    expect(() => assertConnectedInstance(instance)).not.toThrow();
    expect(() => assertConnectedInstance({ some: "object" })).toThrow(ValidationError);
    expect(() => assertConnectedInstance(null)).toThrow(ValidationError);
  });

  it("a catalogue-shaped advertisement of an unreachable rail is still only an advertisement", () => {
    const optimistic: ProviderCatalogueEntry = {
      ...catalogue,
      catalogueEntryId: "cat:psp-a-everything",
      summary: "Advertises every rail in every country (an advertisement, never authority).",
    };
    expect(isProviderCatalogueEntry(optimistic)).toBe(true);
    expect(isConnectedCapabilityInstance(optimistic)).toBe(false);
    expect(() => assertConnectedInstance(optimistic)).toThrow(ConnectorAuthorityError);
  });
});

describe("connected instance validation (full INV-C05 scope)", () => {
  it("validates a fully scoped instance", () => {
    const parsed = validateConnectedCapabilityInstance(instance);
    expect(parsed.credentialScope.credentialKind).toBe("OAUTH");
    expect(parsed.eligibility.eligible).toBe(true);
  });

  it("rejects instances missing the real-account/authorization scope", () => {
    const { credentialScope: _noCredential, ...withoutCredential } = instance;
    expect(() =>
      validateConnectedCapabilityInstance(withoutCredential),
    ).toThrow(/credentialScope/);

    const { eligibility: _noEligibility, ...withoutEligibility } = instance;
    expect(() =>
      validateConnectedCapabilityInstance(withoutEligibility),
    ).toThrow(/eligibility/);

    expect(() =>
      validateConnectedCapabilityInstance({ ...instance, accountRef: "" }),
    ).toThrow(/accountRef/);

    expect(() =>
      validateConnectedCapabilityInstance({
        ...instance,
        configuration: { nested: { object: true } as never },
      }),
    ).toThrow(/configuration.nested/);
  });
});

describe("catalogue entries remain legal discovery seeds", () => {
  it("validates a well-formed catalogue entry", () => {
    const parsed = validateProviderCatalogueEntry(catalogue);
    expect(parsed.advertisedScope.platformWide).toBe(true);
    expect(() =>
      validateProviderCatalogueEntry({ ...catalogue, advertisedScope: undefined }),
    ).toThrow(/advertisedScope/);
  });
});

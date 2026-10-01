import { describe, expect, it } from "vitest";
import { observeCapability } from "@payswap/connectors";
import type { ExternalFundsPositionObservation } from "@payswap/connectors";
import {
  PspConnector,
  PSP_INTEGRATION_MODES,
  RailNotReachableError,
  StripePspAdapterShape,
} from "../src/psp-connector.js";
import { ValidationError } from "@payswap/protocol";
import {
  CLOCK,
  GenericPspSdkShape,
  MOBILE_MONEY_CAPABILITY,
  PSP_PROVIDER,
  definitionsMap,
  makeAdapterAuthority,
  makeInstance,
  makePack,
  makeRegistry,
} from "./fixtures.js";

function shape(registry = makeRegistry()): {
  shape: StripePspAdapterShape;
  connector: PspConnector;
  registry: ReturnType<typeof makeRegistry>;
} {
  const adapterShape = new StripePspAdapterShape(
    CLOCK,
    definitionsMap(MOBILE_MONEY_CAPABILITY),
    makePack(MOBILE_MONEY_CAPABILITY.capabilityId),
  );
  const connector = new PspConnector({
    connectorId: "connector_psp_1",
    provider: PSP_PROVIDER,
    integrationModes: ["PAYMENT_METHOD", "PROCESSOR_ORCHESTRATION"],
    sdk: adapterShape,
    adapter: adapterShape,
    registry,
    rails: ["rails.mobile_money.collect", "rails.stablecoin.transfer", "rails.card.authorize"],
  });
  return { shape: adapterShape, connector, registry };
}

describe("PspConnector (W3-003)", () => {
  it("keeps the incumbent PSP: the canonical merchant promise is structural", () => {
    const { connector } = shape();
    const descriptor = connector.descriptor();
    expect(descriptor.merchantKeepsIncumbentPsp).toBe(true);
    expect(descriptor.integrationModes).toEqual(["PAYMENT_METHOD", "PROCESSOR_ORCHESTRATION"]);
    expect(PSP_INTEGRATION_MODES).toContain("PAYMENT_RECORD");
  });

  it("rejects non-PSP providers (fail closed)", () => {
    const { shape: adapterShape, registry } = shape();
    expect(
      () =>
        new PspConnector({
          connectorId: "bad",
          provider: { ...PSP_PROVIDER, systemKind: "crm" },
          integrationModes: ["PAYMENT_METHOD"],
          sdk: adapterShape,
          adapter: adapterShape,
          registry,
        }),
    ).toThrow(ValidationError);
  });

  it("INV-NC04: cannot imply support for rails that are not actually reachable and authorized", () => {
    const { connector } = shape();
    // rails.card.authorize has NO connected instance at all → not supported.
    const cardClaim = connector.supportedRails().find((claim) => claim.rail === "rails.card.authorize");
    expect(cardClaim?.supported).toBe(false);
    expect(cardClaim?.reason).toBe("NO_CONNECTED_INSTANCE");
    expect(() => connector.assertRailReachable("rails.card.authorize")).toThrow(
      RailNotReachableError,
    );

    // The mobile money rail IS authorized + observed reachable → supported.
    const mmClaim = connector.supportedRails().find((claim) => claim.rail === "rails.mobile_money.collect");
    expect(mmClaim?.supported).toBe(true);
    expect(() => connector.assertRailReachable("rails.mobile_money.collect")).not.toThrow();

    // The stablecoin instance exists but has NO observation → not supported.
    const { registry } = shape();
    const usdc = makeInstance({
      instanceId: "inst-usdc-1",
      capabilityId: "cap.stablecoin.transfer",
      implementationId: "impl-psp-usdc",
    });
    registry.registerInstance(usdc);
    const connector2 = new PspConnector({
      connectorId: "connector_psp_2",
      provider: PSP_PROVIDER,
      integrationModes: ["PAYMENT_METHOD"],
      sdk: shape().shape,
      adapter: shape().shape,
      registry,
      rails: ["rails.stablecoin.transfer"],
    });
    expect(() => connector2.assertRailReachable("rails.stablecoin.transfer")).toThrow(
      RailNotReachableError,
    );

    // Once observed AVAILABLE + ELIGIBLE, the rail becomes supported.
    registry.recordObservation(
      observeCapability({
        instanceId: "inst-usdc-1",
        observedAt: "2026-01-01T00:00:01.000Z",
        observationVersion: 1,
        capabilityState: "AVAILABLE",
        sourceAvailability: "REACHABLE",
        eligibility: "ELIGIBLE",
        health: { status: "HEALTHY", lastCheckedAt: "2026-01-01T00:00:01.000Z" },
        provenance: { providerName: PSP_PROVIDER.providerName, source: "PROVIDER_API", capturedAt: "2026-01-01T00:00:01.000Z" },
      }),
    );
    expect(() => connector2.assertRailReachable("rails.stablecoin.transfer")).not.toThrow();
  });

  it("a merchant exposes PaySwap through ONE connector (all reachable rails through one connection)", () => {
    const { connector } = shape();
    const surfaces = connector.exposedPaymentMethodSurfaces();
    expect(surfaces).toHaveLength(1); // only mobile money is currently reachable
    expect(surfaces[0]!.surface).toBe("payswap-method:rails.mobile_money.collect");
  });

  it("health is checkable independently from PaySwap core and never fabricates outcomes", () => {
    const { connector } = shape();
    const report = connector.health();
    // Derived purely from the connector-scoped registry observations.
    expect(report.status).toBe("HEALTHY");
    expect(report.capabilityStatuses[0]!.instanceId).toBe("inst-mm-1");
    // Structural: the report carries no business-outcome/finality fields.
    expect(Object.keys(report).sort()).toEqual(
      ["capabilityStatuses", "connectorId", "degradedReasons", "lastCheckedAt", "providerName", "providerVersion", "status"].sort(),
    );

    // A fresh registry where one instance has NO observation reports UNKNOWN —
    // never HEALTHY (INV-C02: absence of knowledge is not health).
    const partial = makeRegistry();
    partial.registerInstance(
      makeInstance({ instanceId: "inst-mm-2", implementationId: "impl-psp-mm" }),
    );
    const { shape: adapterShape } = shape();
    const partialConnector = new PspConnector({
      connectorId: "connector_psp_partial",
      provider: PSP_PROVIDER,
      integrationModes: ["PAYMENT_METHOD"],
      sdk: adapterShape,
      adapter: adapterShape,
      registry: partial,
    });
    expect(partialConnector.health().status).toBe("UNKNOWN");
  });

  it("health aggregates DEGRADED observations deterministically", () => {
    const registry = makeRegistry();
    registry.recordObservation(
      observeCapability({
        instanceId: "inst-mm-1",
        observedAt: "2026-01-01T00:00:02.000Z",
        observationVersion: 2,
        capabilityState: "AVAILABLE",
        sourceAvailability: "REACHABLE",
        eligibility: "ELIGIBLE",
        health: { status: "DEGRADED", lastCheckedAt: "2026-01-01T00:00:02.000Z" },
        provenance: { providerName: PSP_PROVIDER.providerName, source: "PROVIDER_API", capturedAt: "2026-01-01T00:00:02.000Z" },
      }),
    );
    const { shape: adapterShape } = shape();
    const connector = new PspConnector({
      connectorId: "connector_psp_degraded",
      provider: PSP_PROVIDER,
      integrationModes: ["PAYMENT_METHOD"],
      sdk: adapterShape,
      adapter: adapterShape,
      registry,
    });
    expect(connector.health().status).toBe("DEGRADED");
  });

  it("new providers can be added WITHOUT domain rewrites", () => {
    // A second provider registers through the same registry and gets its own
    // connector built from the SAME classes and interfaces — no domain code changed.
    const registry = makeRegistry();
    const secondProvider = {
      providerName: "another-psp",
      providerVersion: "1.0.0",
      systemKind: "psp" as const,
      displayName: "Another PSP",
    };
    const secondCapability = MOBILE_MONEY_CAPABILITY;
    registry.registerImplementation({
      implementationId: "impl-another-mm",
      providerName: secondProvider.providerName,
      providerVersion: secondProvider.providerVersion,
      capabilityId: secondCapability.capabilityId,
      version: "1.0.0",
      adapterRef: "adapter.another",
      corridors: [],
      knownDeviations: [],
    });
    const instance = makeInstance({
      instanceId: "inst-another-1",
      implementationId: "impl-another-mm",
      providerName: secondProvider.providerName,
    });
    registry.registerInstance(instance);
    registry.recordObservation(
      observeCapability({
        instanceId: instance.instanceId,
        observedAt: "2026-01-01T00:00:00.000Z",
        observationVersion: 1,
        capabilityState: "AVAILABLE",
        sourceAvailability: "REACHABLE",
        eligibility: "ELIGIBLE",
        health: { status: "HEALTHY", lastCheckedAt: "2026-01-01T00:00:00.000Z" },
        provenance: { providerName: secondProvider.providerName, source: "PROVIDER_API", capturedAt: "2026-01-01T00:00:00.000Z" },
      }),
    );
    const { shape: adapterShape } = shape();
    const secondSdk = new GenericPspSdkShape(secondProvider, CLOCK);
    const anotherConnector = new PspConnector({
      connectorId: "connector_another",
      provider: secondProvider,
      integrationModes: ["PROCESSOR_ORCHESTRATION"],
      sdk: secondSdk,
      adapter: adapterShape,
      registry,
      rails: ["rails.mobile_money.collect"],
    });
    expect(anotherConnector.assertRailReachable("rails.mobile_money.collect").supported).toBe(true);
  });

  it("StripePspAdapterShape behaves deterministically with NO network and NO provider SDK", async () => {
    const { shape: adapterShape } = shape();
    const authority = makeAdapterAuthority();
    const ctx = {
      authority,
      idempotencyKey: "idem-shape-1",
      request: {
        simulate: "OUTCOME_UNKNOWN",
        externalRef: "pay_9",
        providerNativePayload: { keepVerbatim: true },
      },
    };
    const result = await adapterShape.executeAction(ctx);
    // INV-X01: the ambiguous outcome is OUTCOME_UNKNOWN — never FAILED.
    expect(result.outcome.outcome).toBe("OUTCOME_UNKNOWN");
    // INV-C06: the provider-native payload is preserved verbatim in the envelope.
    expect((result.providerState.state as { providerNativePayload: unknown }).providerNativePayload).toEqual({
      keepVerbatim: true,
    });
    expect(result.providerState.failure?.ambiguity).toBe("OUTCOME_UNKNOWN");
    // INV-E02: an execution evidence draft is produced for the attempt ledger.
    expect(result.evidence.evidenceRef).toBe("provider-op:action:pay_9");

    // The other deterministic behaviors.
    const failed = await adapterShape.executeAction({
      ...ctx,
      request: { simulate: "FAILED" },
    });
    expect(failed.outcome.outcome).toBe("FAILED");
    const action = await adapterShape.create({
      ...ctx,
      request: { simulate: "CUSTOMER_ACTION_REQUIRED" },
    });
    expect(action.outcome.outcome).toBe("AWAITING_CUSTOMER_ACTION");
    expect(action.providerState.actionRequired?.kind).toBe("three_d_secure");
    const succeeded = await adapterShape.read({
      ...ctx,
      request: { simulate: "SUCCEEDED" },
    });
    expect(succeeded.outcome.outcome).toBe("SUCCEEDED");

    // Deterministic: same inputs → same envelope state.
    const again = await adapterShape.executeAction(ctx);
    expect(again.providerState.state).toEqual(result.providerState.state);

    // Health is a pure read-only probe.
    expect((await adapterShape.health()).status).toBe("HEALTHY");
  });

  it("the reference shape requires adapter authority on every operation (INV-C04)", async () => {
    const { shape: adapterShape } = shape();
    const authority = makeAdapterAuthority();
    await expect(
      adapterShape.executeAction({
        authority,
        idempotencyKey: "",
        request: { simulate: "SUCCEEDED" },
      }),
    ).rejects.toThrow(/idempotency key/);
  });

  it("INV-C09: external funds are observations with freshness and provenance — never custody", () => {
    const { shape: adapterShape } = shape();
    const observation: ExternalFundsPositionObservation = {
      observationKind: "ExternalFundsPositionObservation",
      observationId: "obs_1",
      observedAt: "2026-01-01T00:00:00.000Z",
      freshness: { asOf: "2026-01-01T00:00:00.000Z", maxAgeSeconds: 60 },
      location: { providerName: "stripe-shape", accountRef: "acct_merchant_1" },
      observedAmount: { currency: "USD", minorUnits: "125000" },
      provenance: { providerName: "stripe-shape", source: "PROVIDER_API", capturedAt: "2026-01-01T00:00:00.000Z" },
    };
    expect(adapterShape.observeExternalFunds(observation)).toBe(observation);
    // A bare balance-shaped object is rejected (INV-C09).
    expect(() =>
      adapterShape.observeExternalFunds({
        currency: "USD",
        minorUnits: "125000",
      } as never),
    ).toThrow(/INV-C09/);
  });

  it("passes through the lossless state mapping of the RailAdapter surface", () => {
    const { shape: adapterShape } = shape();
    const definition = MOBILE_MONEY_CAPABILITY;
    expect(adapterShape.describePreconditions(definition.capabilityId)).toContain(
      "connected instance authorized and eligible",
    );
    expect(adapterShape.authorizationRequirements(definition.capabilityId).protocolAuthorization).toBe(true);
    expect(adapterShape.sourceOfTruthPolicy("payment")).toBe("EXTERNAL_AUTHORITATIVE");
    expect(adapterShape.externalObjectIdentity(definition.capabilityId)).toHaveLength(1);
  });
});

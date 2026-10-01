import { describe, expect, it } from "vitest";
import {
  CONNECTOR_SDK_OPERATIONS,
  ConnectorSDK,
  ConnectorSdkError,
  capabilityKindForSdkOperation,
  validateSdkCallContext,
} from "../src/sdk.js";
import type {
  ConnectorHealthReport,
  CredentialRotationResult,
  SdkCallContext,
  SdkCallResult,
} from "../src/sdk.js";
import type { ProviderIdentity, ConnectorCapabilityPack } from "@payswap/connectors";
import { makeAdapterAuthority, CLOCK } from "./fixtures.js";

/** A minimal concrete SDK used to exercise the framework base. */
class NullSdk extends ConnectorSDK {
  providerIdentity(): ProviderIdentity {
    return {
      providerName: "null-provider",
      providerVersion: "1.0.0",
      systemKind: "other",
      displayName: "Null Provider",
    };
  }
  capabilityPack(): ConnectorCapabilityPack {
    return {
      packId: "pack.null",
      family: "payments",
      version: "1.0.0",
      subPacks: [],
      capabilityRefs: [{ capabilityId: "cap.null", capabilityVersion: "1.0.0" }],
      auth: { authKind: "API_KEY", scopes: [] },
      schemas: [],
      objectMappings: [],
      sourceOfTruth: "DERIVED_PROJECTION",
      rateLimits: [],
      provenance: { publisher: "test", publishedAt: "2026-01-01T00:00:00.000Z", contentHash: "h" },
      evidence: [],
    };
  }
  async search(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new Error("not implemented");
  }
  async read(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new Error("not implemented");
  }
  async create(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new Error("not implemented");
  }
  async update(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new Error("not implemented");
  }
  async executeAction(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new Error("not implemented");
  }
  async subscribe(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new Error("not implemented");
  }
  async reconcile(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new Error("not implemented");
  }
  async disconnect(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new Error("not implemented");
  }
  async rotateCredentials(_ctx: SdkCallContext): Promise<CredentialRotationResult> {
    throw new Error("not implemented");
  }
  async health(): Promise<ConnectorHealthReport> {
    return {
      connectorId: "connector.null",
      providerName: "null-provider",
      providerVersion: "1.0.0",
      status: "UNKNOWN",
      lastCheckedAt: "never",
      capabilityStatuses: [],
      degradedReasons: [],
    };
  }
  callRequireAuthority(ctx: SdkCallContext, operation: (typeof CONNECTOR_SDK_OPERATIONS)[number]) {
    this.requireAuthority(ctx, operation);
  }
}

describe("ConnectorSDK framework (W3-003)", () => {
  it("exposes the full operation surface: search/read/create/update/action/subscribe/reconcile/health/disconnect/credential-rotation", () => {
    expect([...CONNECTOR_SDK_OPERATIONS]).toEqual([
      "search",
      "read",
      "create",
      "update",
      "action",
      "subscribe",
      "reconcile",
      "health",
      "disconnect",
      "credential_rotation",
    ]);
  });

  it("maps SDK operations onto the canonical capability kinds (W2-003 vocabulary — consumed)", () => {
    expect(capabilityKindForSdkOperation("search")).toBe("SEARCH");
    expect(capabilityKindForSdkOperation("read")).toBe("READ");
    expect(capabilityKindForSdkOperation("create")).toBe("WRITE");
    expect(capabilityKindForSdkOperation("update")).toBe("WRITE");
    expect(capabilityKindForSdkOperation("action")).toBe("ACTION");
    expect(capabilityKindForSdkOperation("subscribe")).toBe("EVENT");
    expect(capabilityKindForSdkOperation("reconcile")).toBe("ACTION");
    expect(capabilityKindForSdkOperation("health")).toBe("HEALTH");
    // Lifecycle operations deliberately map to no capability kind.
    expect(capabilityKindForSdkOperation("disconnect")).toBeUndefined();
    expect(capabilityKindForSdkOperation("credential_rotation")).toBeUndefined();
  });

  it("INV-C04/INV-F06: mutating calls require an adapter execution authority — never financial write authority", () => {
    const sdk = new NullSdk({ clock: CLOCK });
    const authority = makeAdapterAuthority();
    const ctx: SdkCallContext = { authority, idempotencyKey: "idem-1", request: {} };
    expect(() => sdk.callRequireAuthority(ctx, "create")).not.toThrow();

    // Missing idempotency key (INV-F05).
    expect(() =>
      sdk.callRequireAuthority(
        { authority, idempotencyKey: "", request: {} },
        "create",
      ),
    ).toThrow(ConnectorSdkError);

    // A financial-write-claiming authority is rejected outright (INV-C04).
    expect(() =>
      sdk.callRequireAuthority(
        {
          authority: {
            authorityKind: "ADAPTER_EXECUTION_ONLY",
            canWriteFinancialState: true as never,
            grant: authority.grant,
          },
          idempotencyKey: "idem-1",
          request: {},
        },
        "create",
      ),
    ).toThrow(/never hold financial write authority/);
  });

  it("validates call contexts from untyped sources", () => {
    const authority = makeAdapterAuthority();
    expect(() =>
      validateSdkCallContext({ authority, idempotencyKey: "k", request: {} }),
    ).not.toThrow();
    expect(() => validateSdkCallContext({ idempotencyKey: "k" })).toThrow();
    expect(() =>
      validateSdkCallContext({ authority, idempotencyKey: "", request: {} }),
    ).toThrow();
  });

  it("describes the operation surface with canonical kinds", () => {
    const sdk = new NullSdk({ clock: CLOCK });
    const described = sdk.describeOperations();
    expect(described).toHaveLength(10);
    const rotation = described.find((entry) => entry.operation === "credential_rotation");
    expect(rotation?.lifecycleOperation).toBe(true);
    expect(rotation?.canonicalKind).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import type { ProviderIdentity } from "@payswap/connectors";
import {
  ExternalSystemConnector,
  isNonPspSystemKind,
  validateExternalSystemConnector,
} from "../src/external-systems.js";
import { ValidationError } from "@payswap/protocol";
import type { SdkCallContext, SdkCallResult, CredentialRotationResult } from "../src/sdk.js";
import type { NonPspSystemKind } from "../src/external-systems.js";
import { CLOCK, makePack } from "./fixtures.js";

const CRM_PROVIDER: ProviderIdentity = Object.freeze({
  providerName: "crm-shape",
  providerVersion: "1.0.0",
  systemKind: "crm",
  displayName: "CRM (reference)",
});

class CrmConnectorShape extends ExternalSystemConnector {
  providerIdentity() {
    return CRM_PROVIDER;
  }
  systemKind(): NonPspSystemKind {
    return "crm";
  }
  exposedCapabilityKinds() {
    return ["SEARCH", "READ", "WRITE", "ACTION", "EVENT", "HEALTH"] as const;
  }
  capabilityPack() {
    return makePack("cap.crm.contacts.search");
  }
  async search(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new Error("deterministic stub — not implemented");
  }
  async read(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new Error("deterministic stub — not implemented");
  }
  async create(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new Error("deterministic stub — not implemented");
  }
  async update(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new Error("deterministic stub — not implemented");
  }
  async executeAction(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new Error("deterministic stub — not implemented");
  }
  async subscribe(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new Error("deterministic stub — not implemented");
  }
  async reconcile(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new Error("deterministic stub — not implemented");
  }
  async disconnect(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new Error("deterministic stub — not implemented");
  }
  async rotateCredentials(_ctx: SdkCallContext): Promise<CredentialRotationResult> {
    throw new Error("deterministic stub — not implemented");
  }
  async health() {
    return {
      connectorId: "connector.crm",
      providerName: CRM_PROVIDER.providerName,
      providerVersion: CRM_PROVIDER.providerVersion,
      status: "HEALTHY" as const,
      lastCheckedAt: "2026-01-01T00:00:00.000Z",
      capabilityStatuses: [],
      degradedReasons: [],
    };
  }
}

class MisconfiguredPspConnector extends CrmConnectorShape {
  override providerIdentity(): ProviderIdentity {
    return { ...CRM_PROVIDER, systemKind: "psp" };
  }
}

describe("External-system connectors (W3-003)", () => {
  it("non-PSP systems use the same ConnectorSDK framework and canonical capability kinds", () => {
    const connector = new CrmConnectorShape({ clock: CLOCK });
    expect(connector.systemKind()).toBe("crm");
    expect(connector.exposedCapabilityKinds()).toContain("SEARCH");
    expect(connector.descriptor("connector.crm").provider.systemKind).toBe("crm");
    expect(connector.descriptor("connector.crm").capabilityKinds).toContain("HEALTH");
  });

  it("isNonPspSystemKind accepts every non-psp kind and rejects 'psp'", () => {
    expect(isNonPspSystemKind("crm")).toBe(true);
    expect(isNonPspSystemKind("erp")).toBe(true);
    expect(isNonPspSystemKind("healthcare_ehr")).toBe(true);
    expect(isNonPspSystemKind("fleet_telematics")).toBe(true);
    expect(isNonPspSystemKind("hospitality_pms")).toBe(true);
    expect(isNonPspSystemKind("legal_matter")).toBe(true);
    expect(isNonPspSystemKind("communications")).toBe(true);
    expect(isNonPspSystemKind("cloud_platform")).toBe(true);
    expect(isNonPspSystemKind("document_storage")).toBe(true);
    expect(isNonPspSystemKind("other")).toBe(true);
    expect(isNonPspSystemKind("psp")).toBe(false);
    expect(isNonPspSystemKind("not-a-kind")).toBe(false);
  });

  it("an external-system connector cannot face a 'psp' provider (fail closed)", () => {
    const connector = new MisconfiguredPspConnector({ clock: CLOCK });
    expect(() => connector.descriptor("connector.bad")).toThrow(
      /cannot face a 'psp' provider/,
    );
  });

  it("conformance validates the pack and the exposed kinds", () => {
    const connector = new CrmConnectorShape({ clock: CLOCK });
    const conformance = validateExternalSystemConnector(connector);
    expect(conformance.ok).toBe(true);
  });

  it("conformance reports violations for a mismatched system kind", () => {
    const connector = new (class extends CrmConnectorShape {
      override systemKind() {
        return "erp" as const; // does not match the provider identity (crm)
      }
    })({ clock: CLOCK });
    const conformance = validateExternalSystemConnector(connector);
    expect(conformance.ok).toBe(false);
    if (!conformance.ok) {
      expect(conformance.violations.join(" ")).toContain("does not match");
    }
  });
});

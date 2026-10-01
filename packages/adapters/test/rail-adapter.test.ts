import { describe, expect, it } from "vitest";
import {
  createProviderStateEnvelope,
  serializeProviderStateEnvelope,
  parseProviderStateEnvelope,
} from "@payswap/connectors";
import {
  BaseRailAdapter,
  mapProviderStateToCanonical,
  requiredCustomerActionsFrom,
} from "../src/rail-adapter.js";
import {
  MOBILE_MONEY_CAPABILITY,
  definitionsMap,
  makePack,
} from "./fixtures.js";

class TestRailAdapter extends BaseRailAdapter {
  readonly adapterId = "adapter.test";
  readonly implementationId = "impl.test";
  constructor() {
    super(makePack(MOBILE_MONEY_CAPABILITY.capabilityId), definitionsMap(MOBILE_MONEY_CAPABILITY));
  }
}

function envelope(options?: {
  readonly actionRequired?: boolean;
  readonly failure?: boolean;
  readonly ambiguity?: "NONE" | "OUTCOME_UNKNOWN";
}) {
  return createProviderStateEnvelope({
    provider: { name: "stripe-shape", version: "1.0.0" },
    object: { objectType: "payment", externalId: "pay_ext_1" },
    revision: "rev_1",
    state: { providerNative: { nested: { keep: "me" } }, flags: [1, 2, 3] },
    classification: {
      family: options?.actionRequired ? "customer_action_required" : "capture",
      lifecycleStep: options?.actionRequired ? "challenge_issued" : "pending_capture",
      isTerminal: false,
      requiresCustomerAction: options?.actionRequired ?? false,
    },
    history: [],
    ...(options?.actionRequired
      ? { actionRequired: { kind: "three_d_secure", message: "challenge required" } }
      : {}),
    ...(options?.failure
      ? {
          failure: {
            providerErrorCode: "timeout",
            retryable: true,
            ambiguity: options?.ambiguity ?? "NONE",
          },
        }
      : {}),
    privacy: { dataClassification: "PARTNER", constraints: [], shareableFields: [] },
    timestamps: { observedAt: "2026-01-01T00:00:00.000Z" },
    provenance: { source: "PROVIDER_API" },
  });
}

describe("RailAdapter (W3-003)", () => {
  it("INV-C06: maps provider state additively — the envelope is preserved VERBATIM end-to-end", () => {
    const raw = envelope();
    const mapping = mapProviderStateToCanonical(raw);
    // The SAME envelope object passes through — no copy, no flattening.
    expect(mapping.envelope).toBe(raw);
    expect(mapping.canonicalState).toBe("capture:pending_capture");
    // And it survives a serialize → parse round-trip losslessly.
    const roundTripped = parseProviderStateEnvelope(serializeProviderStateEnvelope(raw));
    expect(roundTripped.state).toEqual(raw.state);
    expect(roundTripped.classification).toEqual(raw.classification);
    expect(mapProviderStateToCanonical(roundTripped).canonicalState).toBe("capture:pending_capture");
  });

  it("INV-C06: required customer actions are surfaced from the preserved envelope, never flattened", () => {
    const withAction = envelope({ actionRequired: true });
    const actions = requiredCustomerActionsFrom(withAction);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.kind).toBe("three_d_secure");
    expect(requiredCustomerActionsFrom(envelope())).toEqual([]);
  });

  it("derives preconditions, authorization requirements and external object identity from the consumed definitions", () => {
    const adapter = new TestRailAdapter();
    expect(adapter.describePreconditions(MOBILE_MONEY_CAPABILITY.capabilityId)).toContain(
      "connected instance authorized and eligible",
    );
    const authorization = adapter.authorizationRequirements(MOBILE_MONEY_CAPABILITY.capabilityId);
    expect(authorization.protocolAuthorization).toBe(true);
    expect(authorization.requiredScopes).toContain("payments:execute");
    expect(
      adapter.externalObjectIdentity(MOBILE_MONEY_CAPABILITY.capabilityId)[0]!.objectType,
    ).toBe("payment");
    // Unknown capability: fail closed, never invented.
    expect(() => adapter.authorizationRequirements("cap.unknown")).toThrow(
      /consumed from the W2-003 vocabulary/,
    );
    expect(adapter.describePreconditions("cap.unknown")).toEqual([]);
  });

  it("declares the source-of-truth policy from the pack object mappings", () => {
    const adapter = new TestRailAdapter();
    expect(adapter.sourceOfTruthPolicy("payment")).toBe("EXTERNAL_AUTHORITATIVE");
    expect(adapter.sourceOfTruthPolicy("unknown_object_type")).toBeUndefined();
  });

  it("BaseRailAdapter.mapProviderState preserves the envelope by identity too", () => {
    const adapter = new TestRailAdapter();
    const raw = envelope();
    expect(adapter.mapProviderState(raw).envelope).toBe(raw);
    expect(adapter.requiredCustomerActions(raw)).toEqual([]);
  });
});

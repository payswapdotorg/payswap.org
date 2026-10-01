import { describe, expect, it } from "vitest";
import {
  parseProviderStateEnvelope,
  serializeProviderStateEnvelope,
} from "@payswap/connectors";
import { classifyOutcome } from "@payswap/adapters";
import {
  RailNotAuthorizedError,
  resolveCredentialRefs,
} from "../src/support.js";
import {
  FIAT_RAIL_ADAPTER_ID,
  StripeShapeFiatClient,
  StripeShapeFiatRail,
  fiatPaymentIntentEnvelope,
  fiatRailCapabilityDefinition,
  fiatRailCapabilityPack,
} from "../src/fiat.js";
import type { FiatPaymentIntentProviderObject } from "../src/fiat.js";
import { CLOCK, ScriptedHttpTransport, ctx, makeAdapterAuthority } from "./fixtures.js";

const AUTHORITY = makeAdapterAuthority();

function intent(
  status: string,
  overrides?: Partial<FiatPaymentIntentProviderObject>,
): FiatPaymentIntentProviderObject {
  return {
    id: "pi_test_123",
    status,
    currency: "USD",
    amount: 12345,
    ...overrides,
  };
}

const ENV_WITH_CREDENTIALS = {
  PAYSWAP_RAILS_FIAT_SECRET_REF: "vault:fiat-test-ref-1",
};

function clientWithCredential(transport: ScriptedHttpTransport, env: NodeJS.ProcessEnv = { ...ENV_WITH_CREDENTIALS }): {
  client: StripeShapeFiatClient;
  transport: ScriptedHttpTransport;
  env: NodeJS.ProcessEnv;
} {
  return { client: new StripeShapeFiatClient({ clock: CLOCK, http: transport.transport, env }), transport, env };
}

describe("fiat rail — payment-intent lifecycle mapping (INV-C06 lossless)", () => {
  it("maps requires_action to the customer-action family with the provider challenge verbatim", () => {
    const providerObject = intent("requires_action", {
      next_action: { type: "redirect_to_url", redirect_to_url: { url: "https://psp.example/3ds/abc" } },
    });
    const envelope = fiatPaymentIntentEnvelope({
      intent: providerObject,
      revision: "pi_test_123",
      observedAt: "2026-10-01T00:00:00.000Z",
    });
    expect(envelope.classification.family).toBe("customer_action_required");
    expect(envelope.classification.requiresCustomerAction).toBe(true);
    expect(envelope.actionRequired?.kind).toBe("PROVIDER_CHALLENGE_REDIRECT");
    expect(envelope.actionRequired?.deepLink).toBe("https://psp.example/3ds/abc");
    // The RAW provider object is carried VERBATIM (INV-C06).
    expect(envelope.state).toEqual(providerObject);
    expect(classifyOutcome(envelope)).toEqual({ outcome: "AWAITING_CUSTOMER_ACTION" });
  });

  it("preserves capture semantics (requires_capture → capture family, not flattened)", () => {
    const envelope = fiatPaymentIntentEnvelope({
      intent: intent("requires_capture"),
      revision: "pi_test_123",
      observedAt: "2026-10-01T00:00:00.000Z",
    });
    expect(envelope.classification.family).toBe("capture");
    expect(envelope.classification.lifecycleStep).toBe("requires_capture");
    expect(envelope.classification.isTerminal).toBe(false);
    expect(classifyOutcome(envelope)).toEqual({ outcome: "ASYNC_PROCESSING" });
  });

  it("maps processing to async_processing", () => {
    const envelope = fiatPaymentIntentEnvelope({
      intent: intent("processing"),
      revision: "pi_test_123",
      observedAt: "2026-10-01T00:00:00.000Z",
    });
    expect(envelope.classification.family).toBe("async_processing");
    expect(classifyOutcome(envelope)).toEqual({ outcome: "ASYNC_PROCESSING" });
  });

  it("maps succeeded to a terminal success", () => {
    const envelope = fiatPaymentIntentEnvelope({
      intent: intent("succeeded"),
      revision: "pi_test_123",
      observedAt: "2026-10-01T00:00:00.000Z",
    });
    expect(envelope.classification.isTerminal).toBe(true);
    expect(classifyOutcome(envelope)).toEqual({ outcome: "SUCCEEDED" });
  });

  it("maps canceled to a DEFINITIVE non-success while the raw provider state stays 'canceled'", () => {
    const providerObject = intent("canceled");
    const envelope = fiatPaymentIntentEnvelope({
      intent: providerObject,
      revision: "pi_test_123",
      observedAt: "2026-10-01T00:00:00.000Z",
    });
    // Canonical classification (additive): definitive failure, not retryable.
    expect(classifyOutcome(envelope)).toEqual({ outcome: "FAILED", retryable: false });
    // Provider semantics preserved verbatim (INV-C06): support/audit still
    // see 'canceled', the failure metadata is ADDITIVE, not a replacement.
    expect((envelope.state as FiatPaymentIntentProviderObject).status).toBe("canceled");
    expect(envelope.failure?.ambiguity).toBe("NONE");
  });

  it("preserves unknown provider states verbatim under the total 'other' family", () => {
    const providerObject = intent("some_future_provider_state");
    const envelope = fiatPaymentIntentEnvelope({
      intent: providerObject,
      revision: "pi_test_123",
      observedAt: "2026-10-01T00:00:00.000Z",
    });
    expect(envelope.classification.family).toBe("other");
    expect(envelope.classification.lifecycleStep).toBe("some_future_provider_state");
    expect(envelope.state).toEqual(providerObject);
  });

  it("round-trips losslessly through serialization (INV-C06)", () => {
    const envelope = fiatPaymentIntentEnvelope({
      intent: intent("requires_action", {
        next_action: { type: "redirect_to_url", redirect_to_url: { url: "https://psp.example/3ds/abc" } },
      }),
      revision: "pi_test_123",
      observedAt: "2026-10-01T00:00:00.000Z",
    });
    const roundTripped = parseProviderStateEnvelope(serializeProviderStateEnvelope(envelope));
    expect(roundTripped.state).toEqual(envelope.state);
    expect(roundTripped.actionRequired).toEqual(envelope.actionRequired);
    expect(roundTripped.classification).toEqual(envelope.classification);
  });

  it("exposes the consumed vocabulary through the RailAdapter framework", () => {
    const rail = new StripeShapeFiatRail();
    expect(rail.adapterId).toBe(FIAT_RAIL_ADAPTER_ID);
    expect(rail.capabilityPack().packId).toBe("pack.rails.fiat");
    // Preconditions/authorization are CONSUMED from the capability definition.
    expect(rail.describePreconditions("cap.rails.fiat.payment_intent").length).toBeGreaterThan(0);
    expect(rail.authorizationRequirements("cap.rails.fiat.payment_intent").protocolAuthorization).toBe(true);
    expect(rail.sourceOfTruthPolicy("payment_intent")).toBe("EXTERNAL_AUTHORITATIVE");
    expect(() => rail.authorizationRequirements("cap.unknown")).toThrow();
  });

  it("validates its capability definition and pack through the W2-003 validators", () => {
    expect(fiatRailCapabilityDefinition().capabilityId).toBe("cap.rails.fiat.payment_intent");
    expect(fiatRailCapabilityPack().family).toBe("payments");
  });
});

describe("fiat rail — credential-gated availability (INV-C01/C02, INV-NC04)", () => {
  it("reports UNKNOWN availability with provenance when the credential ref is absent", () => {
    const transport = new ScriptedHttpTransport(() => ({ status: 401, bodyText: "{}" }));
    const client = new StripeShapeFiatClient({ clock: CLOCK, http: transport.transport, env: {} });
    const observation = client.availabilityObservation({
      instanceId: "inst-rails-fiat-1",
      observationVersion: 1,
    });
    // Two-axis model: last-known capability state carried, source UNKNOWN →
    // derived availability UNKNOWN — never success, never failure.
    expect(observation.sourceAvailability).toBe("UNKNOWN");
    expect(observation.availability).toBe("UNKNOWN");
    expect(observation.capabilityState).toBe("AVAILABLE");
    expect(observation.provenance.providerName).toBe("stripe-shape");
    // INV-NC04: UNKNOWN is never routable.
    expect(client.railImplication(observation.availability).routable).toBe(false);
    expect(client.railImplication(observation.availability).reason).toContain("INV-NC04");
  });

  it("does not fabricate REACHABLE without a live probe even when credentials exist", () => {
    const transport = new ScriptedHttpTransport(() => ({ status: 200, bodyText: "{}" }));
    const { client } = clientWithCredential(transport);
    const observation = client.availabilityObservation({
      instanceId: "inst-rails-fiat-1",
      observationVersion: 1,
    });
    expect(observation.sourceAvailability).toBe("UNKNOWN");
    expect(observation.availability).toBe("UNKNOWN");
  });

  it("fails effectful operations CLOSED before any provider call when unauthorized", async () => {
    const transport = new ScriptedHttpTransport(() => ({ status: 200, bodyText: "{}" }));
    const client = new StripeShapeFiatClient({ clock: CLOCK, http: transport.transport, env: {} });
    await expect(
      client.create(ctx(AUTHORITY, { kind: "create_intent", amountMinor: "1234", currency: "USD" })),
    ).rejects.toBeInstanceOf(RailNotAuthorizedError);
    // NO provider call was made — no fabricated outcome, no settlement effect.
    expect(transport.calls.length).toBe(0);
  });

  it("resolves credential refs as an explicit provisioned/not-provisioned state", () => {
    expect(resolveCredentialRefs([]).provisioned).toBe(true);
    expect(
      resolveCredentialRefs(
        [
          {
            railId: FIAT_RAIL_ADAPTER_ID,
            envVar: "PAYSWAP_RAILS_FIAT_SECRET_REF",
            kind: "API_KEY",
            description: "test",
          },
        ],
        {},
      ).provisioned,
    ).toBe(false);
  });
});

describe("fiat rail — provider reads with evidence (INV-E02)", () => {
  it("reads a payment intent and captures execution evidence with the provider state", async () => {
    const transport = new ScriptedHttpTransport((url) => {
      expect(url).toContain("/v1/payment_intents/pi_test_123");
      return {
        status: 200,
        bodyText: JSON.stringify(intent("succeeded")),
      };
    });
    const { client } = clientWithCredential(transport);
    const result = await client.read(ctx(AUTHORITY, { kind: "read_intent", intentId: "pi_test_123" }));
    expect(result.providerState.classification.isTerminal).toBe(true);
    expect(result.outcome).toEqual({ outcome: "SUCCEEDED" });
    // Evidence per effect (INV-E02): the draft links the envelope.
    expect(result.evidence.kind).toBe("EXECUTION");
    expect(result.evidence.evidenceRef).toBe("payment_intent:pi_test_123");
    expect(result.evidence.providerState).toBe(result.providerState);
    expect(result.evidence.recordedAt).toBe(CLOCK.now());
  });

  it("classifies a requires_action read as AWAITING_CUSTOMER_ACTION (never an error)", async () => {
    const transport = new ScriptedHttpTransport(() => ({
      status: 200,
      bodyText: JSON.stringify(
        intent("requires_action", {
          next_action: { type: "redirect_to_url", redirect_to_url: { url: "https://psp.example/3ds/xyz" } },
        }),
      ),
    }));
    const { client } = clientWithCredential(transport);
    const result = await client.read(ctx(AUTHORITY, { kind: "read_intent", intentId: "pi_test_123" }));
    expect(result.outcome).toEqual({ outcome: "AWAITING_CUSTOMER_ACTION" });
  });
});

describe("fiat rail — credential rotation surface (CREDENTIAL-ROTATION.md)", () => {
  it("refuses rotation when no credential is provisioned", async () => {
    const transport = new ScriptedHttpTransport(() => ({ status: 200, bodyText: "{}" }));
    const client = new StripeShapeFiatClient({ clock: CLOCK, http: transport.transport, env: {} });
    await expect(client.rotateCredentials(ctx(AUTHORITY, {}))).rejects.toBeInstanceOf(
      RailNotAuthorizedError,
    );
  });

  it("records the baseline on first use and completes rotation only on a NEW reference", async () => {
    const transport = new ScriptedHttpTransport(() => ({
      status: 200,
      bodyText: JSON.stringify(intent("succeeded")),
    }));
    const env: NodeJS.ProcessEnv = { PAYSWAP_RAILS_FIAT_SECRET_REF: "vault:fiat-ref-1" };
    const client = new StripeShapeFiatClient({ clock: CLOCK, http: transport.transport, env });
    // First use records the baseline; rotation then requires a NEW ref.
    await client.read(ctx(AUTHORITY, { kind: "read_intent", intentId: "pi_test_123" }));
    await expect(client.rotateCredentials(ctx(AUTHORITY, {}))).rejects.toThrow(
      /rotation requires a NEW provisioned reference/,
    );
    env["PAYSWAP_RAILS_FIAT_SECRET_REF"] = "vault:fiat-ref-2";
    const rotation = await client.rotateCredentials(ctx(AUTHORITY, {}));
    expect(rotation.newCredentialRef).toBe("vault:fiat-ref-2");
    expect(rotation.evidence.providerState?.object.objectType).toBe("credential_rotation");
    expect(rotation.evidence.providerState?.provenance.source).toBe("OPERATOR");
    // The secret VALUE never appears in the evidence — only the env var name.
    const evidenceText = JSON.stringify(rotation.evidence, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    );
    expect(evidenceText).not.toContain("fiat-ref-2");
  });
});

describe("fiat rail — health (reachability projection, never a business outcome)", () => {
  it("documents the credential-gated state when the endpoint answers 401", async () => {
    const transport = new ScriptedHttpTransport(() => ({ status: 401, bodyText: "{}" }));
    const client = new StripeShapeFiatClient({ clock: CLOCK, http: transport.transport, env: {} });
    const report = await client.health();
    expect(report.status).toBe("DEGRADED");
    expect(report.degradedReasons[0]).toContain("credentials absent");
    expect(report.degradedReasons[0]).toContain("INV-C01/C02");
  });

  it("reports UNKNOWN when the transport fails (INV-C02)", async () => {
    const transport = new ScriptedHttpTransport(() => {
      throw new Error("network down");
    });
    const client = new StripeShapeFiatClient({ clock: CLOCK, http: transport.transport, env: {} });
    const report = await client.health();
    expect(report.status).toBe("UNKNOWN");
    expect(report.degradedReasons[0]).toContain("unreachable");
  });
});

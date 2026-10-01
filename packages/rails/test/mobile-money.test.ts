import { describe, expect, it } from "vitest";
import { classifyOutcome } from "@payswap/adapters";
import { RailNotAuthorizedError } from "../src/support.js";
import {
  MOBILE_MONEY_RAIL_ADAPTER_ID,
  MtnMomoClient,
  MtnMomoRail,
  mobileMoneyEnvelope,
  mobileMoneyRailCapabilityDefinition,
} from "../src/mobile-money.js";
import type { MobileMoneyRequestProviderObject } from "../src/mobile-money.js";
import { CLOCK, ScriptedHttpTransport, ctx, makeAdapterAuthority } from "./fixtures.js";

const AUTHORITY = makeAdapterAuthority();

function request(status: string): MobileMoneyRequestProviderObject {
  return { referenceId: "ref-123", status };
}

const ENV_WITH_CREDENTIALS = {
  PAYSWAP_RAILS_MOMO_SUBSCRIPTION_KEY_REF: "vault:momo-sub-1",
  PAYSWAP_RAILS_MOMO_API_USER_REF: "vault:momo-user-1",
  PAYSWAP_RAILS_MOMO_API_KEY_REF: "vault:momo-key-1",
};

describe("mobile-money rail — USSD/push + mandate semantics preserved (INV-C06)", () => {
  it("maps PENDING to customer-action-required with the USSD approval surface verbatim", () => {
    const raw = { ...request("PENDING"), promptReference: "prompt-abc" };
    const envelope = mobileMoneyEnvelope({
      objectType: "request_to_pay",
      externalId: "ref-123",
      rawState: raw,
      status: "PENDING",
      revision: "PENDING",
      observedAt: "2026-10-01T00:00:00.000Z",
      promptReference: "prompt-abc",
      ussdDeepLink: "tel:*123*456#",
    });
    expect(envelope.classification.family).toBe("customer_action_required");
    expect(envelope.classification.requiresCustomerAction).toBe(true);
    expect(envelope.actionRequired?.kind).toBe("USSD_APPROVAL");
    expect(envelope.actionRequired?.message).toContain("prompt-abc");
    expect(envelope.actionRequired?.deepLink).toBe("tel:*123*456#");
    // Raw provider state preserved VERBATIM (INV-C06) — never flattened.
    expect(envelope.state).toEqual(raw);
    expect(classifyOutcome(envelope)).toEqual({ outcome: "AWAITING_CUSTOMER_ACTION" });
  });

  it("maps ONGOING to async processing (not a failure)", () => {
    const envelope = mobileMoneyEnvelope({
      objectType: "request_to_pay",
      externalId: "ref-123",
      rawState: request("ONGOING"),
      status: "ONGOING",
      revision: "ONGOING",
      observedAt: "2026-10-01T00:00:00.000Z",
    });
    expect(envelope.classification.family).toBe("async_processing");
    expect(classifyOutcome(envelope)).toEqual({ outcome: "ASYNC_PROCESSING" });
  });

  it("maps SUCCESSFUL to terminal success and TIMEOUT to a definitive failure with the raw status retained", () => {
    const success = mobileMoneyEnvelope({
      objectType: "request_to_pay",
      externalId: "ref-123",
      rawState: request("SUCCESSFUL"),
      status: "SUCCESSFUL",
      revision: "SUCCESSFUL",
      observedAt: "2026-10-01T00:00:00.000Z",
    });
    expect(classifyOutcome(success)).toEqual({ outcome: "SUCCEEDED" });

    const raw = request("TIMEOUT");
    const timeout = mobileMoneyEnvelope({
      objectType: "request_to_pay",
      externalId: "ref-123",
      rawState: raw,
      status: "TIMEOUT",
      revision: "TIMEOUT",
      observedAt: "2026-10-01T00:00:00.000Z",
    });
    expect(classifyOutcome(timeout)).toEqual({ outcome: "FAILED", retryable: true });
    expect((timeout.state as MobileMoneyRequestProviderObject).status).toBe("TIMEOUT");
    expect(timeout.failure?.ambiguity).toBe("NONE");
  });

  it("preserves the mandate lifecycle family for recurring-debit semantics", () => {
    const created = mobileMoneyEnvelope({
      objectType: "mandate",
      externalId: "mandate_1",
      rawState: { mandateId: "mandate_1", status: "mandate.created" },
      status: "mandate.created",
      revision: "mandate.created",
      observedAt: "2026-10-01T00:00:00.000Z",
    });
    expect(created.classification.family).toBe("mandate");
    expect(created.classification.requiresCustomerAction).toBe(true);
    expect(created.actionRequired?.kind).toBe("USSD_APPROVAL");

    const active = mobileMoneyEnvelope({
      objectType: "mandate",
      externalId: "mandate_1",
      rawState: { mandateId: "mandate_1", status: "mandate.active" },
      status: "mandate.active",
      revision: "mandate.active",
      observedAt: "2026-10-01T00:00:00.000Z",
    });
    expect(active.classification.family).toBe("mandate");
    expect(active.classification.lifecycleStep).toBe("active");

    const cancelled = mobileMoneyEnvelope({
      objectType: "mandate",
      externalId: "mandate_1",
      rawState: { mandateId: "mandate_1", status: "mandate.cancelled" },
      status: "mandate.cancelled",
      revision: "mandate.cancelled",
      observedAt: "2026-10-01T00:00:00.000Z",
    });
    expect(cancelled.classification.isTerminal).toBe(true);
  });

  it("preserves unknown provider statuses verbatim under the total 'other' family", () => {
    const raw = request("SOME_FUTURE_STATUS");
    const envelope = mobileMoneyEnvelope({
      objectType: "request_to_pay",
      externalId: "ref-123",
      rawState: raw,
      status: "SOME_FUTURE_STATUS",
      revision: "SOME_FUTURE_STATUS",
      observedAt: "2026-10-01T00:00:00.000Z",
    });
    expect(envelope.classification.family).toBe("other");
    expect(envelope.classification.lifecycleStep).toBe("SOME_FUTURE_STATUS");
    expect(envelope.state).toEqual(raw);
  });

  it("exposes the consumed vocabulary through the RailAdapter framework", () => {
    const rail = new MtnMomoRail();
    expect(rail.adapterId).toBe(MOBILE_MONEY_RAIL_ADAPTER_ID);
    expect(rail.sourceOfTruthPolicy("mandate")).toBe("EXTERNAL_AUTHORITATIVE");
    expect(mobileMoneyRailCapabilityDefinition().kind).toBe("ACTION");
  });
});

describe("mobile-money rail — credential-gated availability (INV-C01/C02, INV-NC04)", () => {
  it("reports UNKNOWN availability when credential refs are not fully provisioned", () => {
    const transport = new ScriptedHttpTransport(() => ({ status: 401, bodyText: "{}" }));
    const client = new MtnMomoClient({
      clock: CLOCK,
      http: transport.transport,
      env: { PAYSWAP_RAILS_MOMO_SUBSCRIPTION_KEY_REF: "vault:momo-sub-1" },
    });
    const observation = client.availabilityObservation({
      instanceId: "inst-rails-momo-1",
      observationVersion: 1,
    });
    expect(observation.sourceAvailability).toBe("UNKNOWN");
    expect(observation.availability).toBe("UNKNOWN");
    expect(client.railImplication(observation.availability).routable).toBe(false);
  });

  it("fails effectful operations CLOSED before any provider call when unauthorized", async () => {
    const transport = new ScriptedHttpTransport(() => ({ status: 200, bodyText: "{}" }));
    const client = new MtnMomoClient({ clock: CLOCK, http: transport.transport, env: {} });
    await expect(
      client.create(
        ctx(AUTHORITY, {
          kind: "request_to_pay",
          amountMinor: "5000",
          currency: "GHS",
          payerMsisdn: "233500000000",
        }),
      ),
    ).rejects.toBeInstanceOf(RailNotAuthorizedError);
    expect(transport.calls.length).toBe(0);
  });

  it("health documents the credential-gated state when the token endpoint answers", async () => {
    const transport = new ScriptedHttpTransport(() => ({ status: 401, bodyText: "{}" }));
    const client = new MtnMomoClient({ clock: CLOCK, http: transport.transport, env: {} });
    const report = await client.health();
    expect(report.status).toBe("DEGRADED");
    expect(report.degradedReasons[0]).toContain("credentials absent");
  });
});

describe("mobile-money rail — provider reads with evidence (INV-E02)", () => {
  it("reads a request-to-pay through the token + read flow and captures evidence", async () => {
    const transport = new ScriptedHttpTransport((url) => {
      if (url.endsWith("/collection/token/")) {
        return { status: 200, bodyText: JSON.stringify({ access_token: "tok_1" }) };
      }
      return { status: 200, bodyText: JSON.stringify(request("PENDING")) };
    });
    const client = new MtnMomoClient({
      clock: CLOCK,
      http: transport.transport,
      env: { ...ENV_WITH_CREDENTIALS },
    });
    const result = await client.read(ctx(AUTHORITY, { kind: "read_request", referenceId: "ref-123" }));
    expect(result.outcome).toEqual({ outcome: "AWAITING_CUSTOMER_ACTION" });
    expect(result.evidence.kind).toBe("EXECUTION");
    expect(result.evidence.evidenceRef).toBe("request_to_pay:ref-123");
    expect(result.evidence.providerState).toBe(result.providerState);
  });

  it("credential rotation completes only when a reference CHANGED (names only in evidence)", async () => {
    const transport = new ScriptedHttpTransport((url) => {
      if (url.endsWith("/collection/token/")) {
        return { status: 200, bodyText: JSON.stringify({ access_token: "tok_1" }) };
      }
      return { status: 200, bodyText: JSON.stringify(request("PENDING")) };
    });
    const env: NodeJS.ProcessEnv = { ...ENV_WITH_CREDENTIALS };
    const client = new MtnMomoClient({ clock: CLOCK, http: transport.transport, env });
    await client.read(ctx(AUTHORITY, { kind: "read_request", referenceId: "ref-123" }));
    await expect(client.rotateCredentials(ctx(AUTHORITY, {}))).rejects.toThrow(
      /requires at least one NEW provisioned reference/,
    );
    env["PAYSWAP_RAILS_MOMO_API_KEY_REF"] = "vault:momo-key-2";
    const rotation = await client.rotateCredentials(ctx(AUTHORITY, {}));
    expect(rotation.evidence.providerState?.object.objectType).toBe("credential_rotation");
    // Only NAMES of rotated refs — values never appear.
    const evidenceText = JSON.stringify(rotation.evidence, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    );
    expect(evidenceText).toContain("PAYSWAP_RAILS_MOMO_API_KEY_REF");
    expect(evidenceText).not.toContain("momo-key-2");
  });
});

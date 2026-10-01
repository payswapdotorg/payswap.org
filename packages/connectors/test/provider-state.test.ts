import { describe, expect, it } from "vitest";
import { ValidationError } from "@payswap/protocol";
import {
  PROVIDER_STATE_FAMILIES,
  createProviderStateEnvelope,
  isProviderStateEnvelope,
  parseProviderStateEnvelope,
  serializeProviderStateEnvelope,
} from "../src/index.js";
import type {
  ProviderStateEnvelope,
  ProviderStateFamily,
} from "../src/index.js";

/**
 * INV-C06: provider state required for customer action, reconciliation,
 * support or audit is preserved in ProviderStateEnvelope and is NEVER
 * lossy-mapped into a canonical status. Every consequential state family —
 * customer-action-required, async, capture, mandate, refund, dispute,
 * payout and connected-account — round-trips LOSSLESSLY through the JSON
 * codec, including raw provider-native state, history, required actions,
 * failure metadata, privacy scope and provenance.
 */

function envelope(
  family: ProviderStateFamily,
  overrides: Partial<ProviderStateEnvelope> = {},
): ProviderStateEnvelope {
  return createProviderStateEnvelope({
    provider: { name: "psp-a", version: "2026-01" },
    object: { objectType: "PAYMENT_INTENT", externalId: "pi_3Qabc123" },
    revision: "rev_8812",
    state: { status: "requires_action", raw: { next_action: "redirect_to_url", url: "https://psp-a.example/challenge" } },
    classification: {
      family,
      lifecycleStep: "challenge_issued",
      isTerminal: false,
      requiresCustomerAction: true,
    },
    history: [
      { toRevision: "rev_8811", occurredAt: "2026-10-01T11:58:00Z", actor: "customer", note: "authentication started" },
      { fromRevision: "rev_8811", toRevision: "rev_8812", occurredAt: "2026-10-01T11:59:00Z", actor: "provider" },
    ],
    actionRequired: {
      kind: "customer_authentication",
      message: "Complete the 3DS challenge.",
      deepLink: "https://psp-a.example/challenge",
    },
    failure: {
      providerErrorCode: "authentication_required",
      providerErrorMessage: "The customer must authenticate.",
      retryable: true,
      ambiguity: "NONE",
    },
    privacy: {
      dataClassification: "PARTNER",
      constraints: ["no-PII-in-support-tickets"],
      shareableFields: ["status", "next_action"],
    },
    metadata: {
      routingHint: "sca-ios",
      providerInternalCorrelation: "ic_99213",
    },
    timestamps: { observedAt: "2026-10-01T12:00:00Z", updatedAt: "2026-10-01T11:59:00Z" },
    provenance: { source: "PROVIDER_API", fetchId: "fetch_1a" },
    ...overrides,
  });
}

describe("the consequential state-family vocabulary (INV-C06)", () => {
  it("covers every family the lossless model names, plus an escape hatch", () => {
    expect([...PROVIDER_STATE_FAMILIES]).toEqual([
      "customer_action_required",
      "async_processing",
      "capture",
      "mandate",
      "refund",
      "dispute",
      "payout",
      "connected_account",
      "other",
    ]);
  });
});

describe("lossless round-trip for every consequential state family (INV-C06)", () => {
  const families = [
    "customer_action_required",
    "async_processing",
    "capture",
    "mandate",
    "refund",
    "dispute",
    "payout",
    "connected_account",
    "other",
  ] as const;

  for (const family of families) {
    it(`round-trips a ${family} envelope losslessly (serialize → parse)`, () => {
      const original = envelope(family);
      const parsed = parseProviderStateEnvelope(
        serializeProviderStateEnvelope(original),
      );
      expect(parsed).toStrictEqual(original);
    });
  }

  it("preserves the raw provider-native state verbatim — no canonical flattening", () => {
    const original = envelope("dispute", {
      object: { objectType: "DISPUTE", externalId: "dp_1" },
      state: {
        status: "needs_response",
        evidence_requirements: ["receipt", "customer_communication"],
        provider_quirks: {
          nested: { deeply: { arbitrary: ["structure", 42, true, null] } },
        },
      },
      classification: {
        family: "dispute",
        lifecycleStep: "evidence_required",
        isTerminal: false,
        requiresCustomerAction: true,
      },
    });
    const parsed = parseProviderStateEnvelope(
      serializeProviderStateEnvelope(original),
    );
    expect(parsed.state).toStrictEqual(original.state);
    expect(
      (parsed.state as { provider_quirks?: unknown }).provider_quirks,
    ).toStrictEqual({
      nested: { deeply: { arbitrary: ["structure", 42, true, null] } },
    });
  });

  it("preserves connected-account onboarding state without collapsing it into CRUD outcomes", () => {
    const original = envelope("connected_account", {
      object: { objectType: "CONNECTED_ACCOUNT", externalId: "acct_1" },
      state: {
        status: "restricted_soon",
        requirements: {
          current_deadline: "2026-10-15",
          disabled_reason: "listed",
          currently_due: ["individual.verification.document"],
        },
      },
      classification: {
        family: "connected_account",
        lifecycleStep: "requirements_due",
        isTerminal: false,
        requiresCustomerAction: true,
      },
      actionRequired: {
        kind: "submit_verification_document",
        message: "Upload an identity document for the account representative.",
      },
    });
    const parsed = parseProviderStateEnvelope(
      serializeProviderStateEnvelope(original),
    );
    expect(parsed.actionRequired).toStrictEqual(original.actionRequired);
    expect(parsed.state).toStrictEqual(original.state);
  });

  it("round-trips optional-field-free envelopes (absence stays absence)", () => {
    const { actionRequired: _a, failure: _f, metadata: _m, ...minimal } =
      envelope("payout", {
        object: { objectType: "PAYOUT", externalId: "po_1" },
        classification: {
          family: "payout",
          lifecycleStep: "in_transit",
          isTerminal: false,
          requiresCustomerAction: false,
        },
      });
    const parsed = parseProviderStateEnvelope(
      serializeProviderStateEnvelope(minimal),
    );
    expect(parsed).toStrictEqual(minimal);
    expect("actionRequired" in parsed).toBe(false);
  });
});

describe("envelope construction and validation", () => {
  it("freezes the constructed envelope shell", () => {
    const frozen = envelope("refund");
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(() => {
      (frozen as { revision?: string }).revision = "tampered";
    }).toThrow();
  });

  it("requires the classification and privacy scope (canonical additions)", () => {
    const { classification: _c, ...withoutClassification } = envelope("mandate");
    expect(() =>
      createProviderStateEnvelope(withoutClassification),
    ).toThrow(/classification/);
    const { privacy: _p, ...withoutPrivacy } = envelope("mandate");
    expect(() => createProviderStateEnvelope(withoutPrivacy)).toThrow(/privacy/);
  });

  it("rejects unknown state families and malformed JSON", () => {
    expect(() =>
      createProviderStateEnvelope(
        envelope("other", {
          classification: {
            family: "magically_resolved" as never,
            lifecycleStep: "x",
            isTerminal: true,
            requiresCustomerAction: false,
          },
        }),
      ),
    ).toThrow(/classification.family/);
    expect(() => parseProviderStateEnvelope("{not json")).toThrow(ValidationError);
    expect(() => parseProviderStateEnvelope('"just a string"')).toThrow(
      /not a ProviderStateEnvelope/,
    );
  });

  it("guards envelopes structurally", () => {
    expect(isProviderStateEnvelope(envelope("capture"))).toBe(true);
    expect(isProviderStateEnvelope({ revision: "r" })).toBe(false);
    expect(isProviderStateEnvelope(null)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  EpochLedger,
  evaluate,
  issueGrant,
  verifyApprovalArtifact,
} from "../src/index.js";
import type {
  AuthorizationRequest,
  Mandate,
  PermissionGrant,
  SignedApprovalArtifact,
  UsageRecord,
} from "../src/index.js";

const NOW = 2_000_000;
const EXPIRY = NOW + 10 * 86_400_000;

const principal = {
  kind: "agent",
  agentKeyFingerprint: "agent-key-1",
  ownerRef: "user:owner-1",
  bodyRef: "body:payer@1",
  packageVersionRef: "pkg:payer@1",
  authorityEnvelope: [{ mandateId: "mandate-1", version: 1 }],
  securityEpoch: 0n,
} as const;

function mandate(overrides: Partial<Mandate> = {}): Mandate {
  return {
    id: "mandate-1",
    version: 1,
    grantor: "user:owner-1",
    grantee: "agent:agent-key-1",
    actions: ["payments.initiate"],
    resources: [{ type: "payment_intent" }, { type: "beneficiary", resourceId: "ben-1" }],
    expiresAt: EXPIRY,
    proofRequirements: [],
    ...overrides,
  };
}

function grant(m: Mandate = mandate()): PermissionGrant {
  return issueGrant(m, { grantId: "grant-1", issuedAt: NOW - 1000 });
}

function request(overrides: Partial<AuthorizationRequest> = {}): AuthorizationRequest {
  return {
    principal,
    action: "payments.initiate",
    resource: { type: "payment_intent", resourceId: "pi-1" },
    context: {
      amount: { currency: "EUR", minorUnits: "10000" },
      rail: "sepa",
      country: "DE",
      beneficiary: "ben-1",
    },
    requestHash: "reqhash-1",
    requestedAt: NOW,
    ...overrides,
  };
}

function state(usage: readonly UsageRecord[] = []) {
  return { ledger: new EpochLedger(), usage };
}

describe("evaluate — deterministic authorization", () => {
  it("ALLOWs a fully matching grant with authorization lineage evidence", () => {
    const decision = evaluate(request(), [grant()], state());
    expect(decision).toEqual({
      decision: "ALLOW",
      evidenceRefs: [
        "grant:grant-1",
        "mandate:mandate-1@1",
        "lineage:grant-1>grant-1",
        "request:reqhash-1",
      ],
    });
  });

  it("is deterministic: identical inputs produce identical decisions", () => {
    const first = evaluate(request(), [grant()], state());
    const second = evaluate(request(), [grant()], state());
    expect(first).toEqual(second);
  });

  it("DENYs when no grant exists for the principal", () => {
    const decision = evaluate(request(), [], state());
    expect(decision).toEqual({
      decision: "DENY",
      reason: "no_matching_grant",
      policyRefs: ["principal:agent:agent-key-1"],
    });
  });

  it("DENYs an action outside the mandate", () => {
    const decision = evaluate(
      request({ action: "payouts.initiate" }),
      [grant()],
      state(),
    );
    expect(decision.decision).toBe("DENY");
    if (decision.decision === "DENY") {
      expect(decision.reason).toBe("action_not_permitted");
      expect(decision.policyRefs).toContain("mandate:mandate-1@1");
    }
  });

  it("DENYs a resource outside the mandate", () => {
    const decision = evaluate(
      request({ resource: { type: "payout", resourceId: "po-1" } }),
      [grant()],
      state(),
    );
    expect(decision.decision).toBe("DENY");
    if (decision.decision === "DENY") {
      expect(decision.reason).toBe("resource_not_permitted");
    }
  });

  it("DENYs an expired mandate", () => {
    const decision = evaluate(request({ requestedAt: EXPIRY }), [grant()], state());
    expect(decision.decision).toBe("DENY");
    if (decision.decision === "DENY") {
      expect(decision.reason).toBe("mandate_expired");
    }
  });

  it("fail-closed: DENYs a restricted scope dimension with no context evidence", () => {
    const railsGrant = grant(mandate({ rails: ["sepa"] }));
    const noRail = evaluate(request({ context: {} }), [railsGrant], state());
    expect(noRail.decision).toBe("DENY");
    if (noRail.decision === "DENY") {
      expect(noRail.reason).toBe("scope_not_permitted");
    }

    const countriesGrant = grant(mandate({ countries: ["DE"] }));
    const otherCountry = evaluate(
      request({ context: { amount: { currency: "EUR", minorUnits: "1" }, country: "US" } }),
      [countriesGrant],
      state(),
    );
    expect(otherCountry.decision).toBe("DENY");
    if (otherCountry.decision === "DENY") {
      expect(otherCountry.reason).toBe("scope_not_permitted");
    }
  });

  it("DENYs scope widening on rails, currencies and beneficiaries", () => {
    const scoped = grant(
      mandate({
        rails: ["sepa"],
        currencies: ["EUR"],
        beneficiaries: ["ben-1"],
      }),
    );
    const wrongRail = evaluate(
      request({ context: { ...request().context, rail: "swift" } }),
      [scoped],
      state(),
    );
    expect(wrongRail.decision).toBe("DENY");
    if (wrongRail.decision === "DENY") {
      expect(wrongRail.reason).toBe("scope_not_permitted");
    }

    const wrongCurrency = evaluate(
      request({ context: { ...request().context, amount: { currency: "USD", minorUnits: "1" } } }),
      [scoped],
      state(),
    );
    expect(wrongCurrency.decision).toBe("DENY");
    if (wrongCurrency.decision === "DENY") {
      expect(wrongCurrency.reason).toBe("scope_not_permitted");
    }

    const wrongBeneficiary = evaluate(
      request({ context: { ...request().context, beneficiary: "ben-2" } }),
      [scoped],
      state(),
    );
    expect(wrongBeneficiary.decision).toBe("DENY");
    if (wrongBeneficiary.decision === "DENY") {
      expect(wrongBeneficiary.reason).toBe("scope_not_permitted");
    }
  });

  it("DENYs a per-transaction amount above the limit (exact minor units)", () => {
    const limited = grant(
      mandate({ limits: { perTransactionAmount: { currency: "EUR", minorUnits: "5000" } } }),
    );
    const decision = evaluate(request(), [limited], state());
    expect(decision.decision).toBe("DENY");
    if (decision.decision === "DENY") {
      expect(decision.reason).toBe("per_transaction_limit_exceeded");
      expect(decision.policyRefs).toContain("INV-A01");
    }
  });

  it("fail-closed: DENYs when the limit currency cannot bound the request amount", () => {
    const limited = grant(
      mandate({ limits: { perTransactionAmount: { currency: "USD", minorUnits: "100000" } } }),
    );
    const decision = evaluate(request(), [limited], state());
    expect(decision.decision).toBe("DENY");
    if (decision.decision === "DENY") {
      expect(decision.reason).toBe("per_transaction_limit_currency_mismatch");
    }
  });

  it("NEEDS_APPROVAL instead of DENY when escalation requires approval (AGENTS.md rule 10)", () => {
    const limited = grant(
      mandate({
        limits: { perTransactionAmount: { currency: "EUR", minorUnits: "5000" } },
        escalation: { onLimitExceeded: "require_approval", approverRef: "user:owner-1" },
      }),
    );
    const decision = evaluate(request(), [limited], state());
    expect(decision.decision).toBe("NEEDS_APPROVAL");
    if (decision.decision === "NEEDS_APPROVAL") {
      expect(decision.approvalSpec.approverRef).toBe("user:owner-1");
      expect(decision.approvalSpec.requestHash).toBe("reqhash-1");
      expect(decision.approvalSpec.scope.actions).toEqual(["payments.initiate"]);
      expect(decision.approvalSpec.scope.maxAmount).toEqual({ currency: "EUR", minorUnits: "10000" });
      expect(decision.approvalSpec.expiresAt).toBe(EXPIRY);
    }
  });

  it("velocity: DENYs above maxCount inside the window, allows inside it", () => {
    const limited = grant(
      mandate({
        limits: { velocity: { windowMs: 60_000, maxCount: 3 } },
      }),
    );
    const usage: UsageRecord[] = [
      { granteeRef: "agent:agent-key-1", occurredAt: NOW - 30_000 },
      { granteeRef: "agent:agent-key-1", occurredAt: NOW - 20_000 },
    ];
    const inside = evaluate(request(), [limited], state(usage));
    expect(inside.decision).toBe("ALLOW");

    const extra: UsageRecord[] = [
      ...usage,
      { granteeRef: "agent:agent-key-1", occurredAt: NOW - 10_000 },
    ];
    const outside = evaluate(request(), [limited], state(extra));
    expect(outside.decision).toBe("DENY");
    if (outside.decision === "DENY") {
      expect(outside.reason).toBe("velocity_count_exceeded");
    }
  });

  it("velocity: ignores usage outside the window and usage of other principals", () => {
    const limited = grant(
      mandate({ limits: { velocity: { windowMs: 60_000, maxCount: 2 } } }),
    );
    const usage: UsageRecord[] = [
      { granteeRef: "agent:agent-key-1", occurredAt: NOW - 120_000 },
      { granteeRef: "agent:other-agent", occurredAt: NOW - 10_000 },
      { granteeRef: "agent:agent-key-1", occurredAt: NOW - 5_000 },
    ];
    const decision = evaluate(request(), [limited], state(usage));
    expect(decision.decision).toBe("ALLOW");
  });

  it("velocity: DENYs when the windowed amount sum exceeds maxAmount (exact arithmetic)", () => {
    const limited = grant(
      mandate({
        limits: {
          velocity: { windowMs: 60_000, maxAmount: { currency: "EUR", minorUnits: "15000" } },
        },
      }),
    );
    const usage: UsageRecord[] = [
      { granteeRef: "agent:agent-key-1", occurredAt: NOW - 30_000, amount: { currency: "EUR", minorUnits: "6000" } },
    ];
    const decision = evaluate(request(), [limited], state(usage)); // 6000 + 10000 > 15000
    expect(decision.decision).toBe("DENY");
    if (decision.decision === "DENY") {
      expect(decision.reason).toBe("velocity_amount_exceeded");
    }
  });

  it("a fully authorizing grant beats a NEEDS_APPROVAL from another grant", () => {
    const limited = grant(
      mandate({
        id: "mandate-limited",
        limits: { perTransactionAmount: { currency: "EUR", minorUnits: "5000" } },
        escalation: { onLimitExceeded: "require_approval", approverRef: "user:owner-1" },
      }),
    );
    const unlimited = grant(mandate({ id: "mandate-unlimited" }));
    const decision = evaluate(request(), [limited, unlimited], state());
    expect(decision.decision).toBe("ALLOW");
  });

  it("a stale security epoch DENYs a sensitive action before any mandate is considered (INV-A02/INV-S02)", () => {
    const ledger = new EpochLedger();
    ledger.raiseEpoch("agent:agent-key-1", "device change signal", NOW - 10);
    const decision = evaluate(request(), [grant()], { ledger, usage: [] });
    expect(decision.decision).toBe("DENY");
    if (decision.decision === "DENY") {
      expect(decision.reason).toBe("stale_security_epoch");
      expect(decision.policyRefs).toContain("INV-A02");
      expect(decision.policyRefs).toContain("INV-S02");
    }
  });
});

describe("verifyApprovalArtifact — signed approval is the authority, not a chat message", () => {
  const baseArtifact: SignedApprovalArtifact = {
    principal: "user:owner-1",
    agentRef: "agent:agent-key-1",
    scope: {
      actions: ["payments.initiate"],
      resources: [{ type: "payment_intent", resourceId: "pi-1" }],
      maxAmount: { currency: "EUR", minorUnits: "10000" },
    },
    expiry: NOW + 60_000,
    requestHash: "reqhash-1",
    signature: "sig-opaque-1",
    issuedAt: NOW - 1_000,
  };

  it("accepts a matching, unexpired, signed artifact (INV-A03 fields)", () => {
    const decision = verifyApprovalArtifact(baseArtifact, request(), NOW);
    expect(decision).toEqual({ valid: true });
    expect(baseArtifact.requestHash).toBe("reqhash-1");
    expect(baseArtifact.principal).toBe("user:owner-1");
    expect(baseArtifact.agentRef).toBe("agent:agent-key-1");
    expect(baseArtifact.expiry).toBeGreaterThan(NOW);
  });

  it("rejects a missing signature, expiry and request-hash mismatch", () => {
    expect(
      verifyApprovalArtifact({ ...baseArtifact, signature: "" }, request(), NOW),
    ).toEqual({ valid: false, reason: "missing_signature" });
    expect(
      verifyApprovalArtifact(baseArtifact, request(), NOW + 61_000),
    ).toEqual({ valid: false, reason: "expired" });
    expect(
      verifyApprovalArtifact(
        { ...baseArtifact, requestHash: "reqhash-other" },
        request(),
        NOW,
      ),
    ).toEqual({ valid: false, reason: "request_hash_mismatch" });
  });

  it("rejects an artifact bound to a different supervised agent", () => {
    const decision = verifyApprovalArtifact(
      { ...baseArtifact, agentRef: "agent:someone-else" },
      request(),
      NOW,
    );
    expect(decision).toEqual({ valid: false, reason: "principal_mismatch" });
  });

  it("rejects actions, resources and amounts outside the approval scope", () => {
    expect(
      verifyApprovalArtifact(baseArtifact, request({ action: "payouts.initiate" }), NOW),
    ).toEqual({ valid: false, reason: "action_out_of_scope" });
    expect(
      verifyApprovalArtifact(
        baseArtifact,
        request({ resource: { type: "payment_intent", resourceId: "pi-2" } }),
        NOW,
      ),
    ).toEqual({ valid: false, reason: "resource_out_of_scope" });
    expect(
      verifyApprovalArtifact(
        baseArtifact,
        request({ context: { ...request().context, amount: { currency: "EUR", minorUnits: "10001" } } }),
        NOW,
      ),
    ).toEqual({ valid: false, reason: "amount_exceeds_approval" });
    expect(
      verifyApprovalArtifact(
        baseArtifact,
        request({ context: { ...request().context, amount: { currency: "USD", minorUnits: "1" } } }),
        NOW,
      ),
    ).toEqual({ valid: false, reason: "amount_currency_mismatch" });
  });
});

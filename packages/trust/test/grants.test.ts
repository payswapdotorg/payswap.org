import { describe, expect, it } from "vitest";
import {
  EpochLedger,
  evaluate,
  issueGrant,
  ScopedGrantRegistry,
  checkScopedGrant,
} from "../src/index.js";
import type {
  AuthorizationRequest,
  Mandate,
  ScopedExecutionGrant,
  UsageRecord,
} from "../src/index.js";

/**
 * W2-002 — Scoped execution grants: narrow, expiring, revocable instruments
 * derived from mandates. Revocation is immediate and monotonic; revoked,
 * expired and unknown grants fail closed in `checkScopedGrant` AND in
 * `evaluate` (INV-A02, INV-E01, INV-S02).
 */

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
    actions: ["payments.*"],
    resources: [{ type: "payment_intent" }],
    expiresAt: EXPIRY,
    proofRequirements: [],
    ...overrides,
  };
}

function grant(m: Mandate = mandate()) {
  return issueGrant(m, { grantId: "grant-1", issuedAt: NOW - 1000 });
}

function request(overrides: Partial<AuthorizationRequest> = {}): AuthorizationRequest {
  return {
    principal,
    action: "payments.initiate",
    resource: { type: "payment_intent", resourceId: "pi-1" },
    context: { amount: { currency: "EUR", minorUnits: "10000" } },
    requestHash: "reqhash-1",
    requestedAt: NOW,
    ...overrides,
  };
}

function state(overrides: { scopedGrants?: ScopedGrantRegistry; usage?: readonly UsageRecord[] } = {}) {
  return { ledger: new EpochLedger(), ...overrides };
}

describe("ScopedGrantRegistry — issue", () => {
  it("issues a frozen, narrow, expiring instrument with decision provenance", () => {
    const registry = new ScopedGrantRegistry();
    const scoped = registry.issue({
      grantId: "sg-1",
      mandateRef: { mandateId: "mandate-1", version: 1 },
      scope: { actions: ["payments.initiate"] },
      grantedAt: NOW,
      expiresAt: NOW + 1000,
      conditions: ["session-bound"],
      decisionRef: "decision:allow-1",
    });
    expect(scoped.id).toBe("sg-1");
    expect(scoped.decisionRef).toBe("decision:allow-1");
    expect(scoped.conditions).toEqual(["session-bound"]);
    expect(Object.isFrozen(scoped)).toBe(true);
    expect(registry.lookup("sg-1")).toBe(scoped);
    expect(registry.status("sg-1", NOW)).toBe("ACTIVE");
  });

  it("rejects duplicate ids, non-expiring instruments and empty decision refs", () => {
    const registry = new ScopedGrantRegistry();
    registry.issue({
      grantId: "sg-1",
      mandateRef: { mandateId: "mandate-1", version: 1 },
      grantedAt: NOW,
      expiresAt: NOW + 1,
      conditions: [],
      decisionRef: "decision:allow-1",
    });
    expect(() =>
      registry.issue({
        grantId: "sg-1",
        mandateRef: { mandateId: "mandate-1", version: 1 },
        grantedAt: NOW,
        expiresAt: NOW + 1,
        conditions: [],
        decisionRef: "decision:allow-2",
      }),
    ).toThrow(/already exists/);
    expect(() =>
      registry.issue({
        grantId: "sg-2",
        mandateRef: { mandateId: "mandate-1", version: 1 },
        grantedAt: NOW,
        expiresAt: NOW,
        conditions: [],
        decisionRef: "decision:allow-2",
      }),
    ).toThrow(/strictly after/);
    expect(() =>
      registry.issue({
        grantId: "sg-3",
        mandateRef: { mandateId: "mandate-1", version: 1 },
        grantedAt: NOW,
        expiresAt: NOW + 1,
        conditions: [],
        decisionRef: "",
      }),
    ).toThrow(/decisionRef/);
  });

  it("validates narrowing against the supplied parent mandate (fail closed)", () => {
    const registry = new ScopedGrantRegistry();
    // widening action scope beyond the parent mandate
    expect(() =>
      registry.issue({
        grantId: "sg-wide",
        mandateRef: { mandateId: "mandate-1", version: 1 },
        scope: { actions: ["transfers.*"] },
        grantedAt: NOW,
        expiresAt: NOW + 1,
        conditions: [],
        decisionRef: "decision:allow-1",
        parentMandate: mandate(),
      }),
    ).toThrow(/not covered by the parent mandate/);
    // outliving the parent mandate
    expect(() =>
      registry.issue({
        grantId: "sg-late",
        mandateRef: { mandateId: "mandate-1", version: 1 },
        grantedAt: NOW,
        expiresAt: EXPIRY + 1,
        conditions: [],
        decisionRef: "decision:allow-1",
        parentMandate: mandate(),
      }),
    ).toThrow(/outlives the parent mandate/);
    // parent mandate does not match the mandateRef
    expect(() =>
      registry.issue({
        grantId: "sg-mismatch",
        mandateRef: { mandateId: "mandate-9", version: 1 },
        grantedAt: NOW,
        expiresAt: NOW + 1,
        conditions: [],
        decisionRef: "decision:allow-1",
        parentMandate: mandate(),
      }),
    ).toThrow(/does not match mandateRef/);
  });
});

describe("ScopedGrantRegistry — revoke is immediate and monotonic", () => {
  it("revokes from revokedAt onward and never again authorizes", () => {
    const registry = new ScopedGrantRegistry();
    registry.issue({
      grantId: "sg-1",
      mandateRef: { mandateId: "mandate-1", version: 1 },
      grantedAt: NOW,
      expiresAt: NOW + 10_000,
      conditions: [],
      decisionRef: "decision:allow-1",
    });
    const revocation = registry.revoke("sg-1", NOW + 100, "user-requested");
    expect(revocation).toEqual({
      grantId: "sg-1",
      revokedAt: NOW + 100,
      reason: "user-requested",
    });
    // immediate: at and after revokedAt the grant is REVOKED
    expect(registry.status("sg-1", NOW + 99)).toBe("ACTIVE");
    expect(registry.status("sg-1", NOW + 100)).toBe("REVOKED");
    expect(registry.status("sg-1", NOW + 500)).toBe("REVOKED");
    expect(registry.revocations()).toHaveLength(1);
  });

  it("rejects double revocation, unknown ids and backdated revocations", () => {
    const registry = new ScopedGrantRegistry();
    registry.issue({
      grantId: "sg-1",
      mandateRef: { mandateId: "mandate-1", version: 1 },
      grantedAt: NOW,
      expiresAt: NOW + 10_000,
      conditions: [],
      decisionRef: "decision:allow-1",
    });
    registry.revoke("sg-1", NOW + 100, "first");
    expect(() => registry.revoke("sg-1", NOW + 200, "second")).toThrow(
      /monotonic and cannot be reversed or repeated/,
    );
    expect(() => registry.revoke("sg-unknown", NOW, "ghost")).toThrow(/unknown/);
    const other = new ScopedGrantRegistry();
    other.issue({
      grantId: "sg-2",
      mandateRef: { mandateId: "mandate-1", version: 1 },
      grantedAt: NOW,
      expiresAt: NOW + 10_000,
      conditions: [],
      decisionRef: "decision:allow-1",
    });
    expect(() => other.revoke("sg-2", NOW - 1, "backdated")).toThrow(/cannot be backdated/);
  });

  it("status precedence: REVOKED beats EXPIRED; unknown ids are UNKNOWN", () => {
    const registry = new ScopedGrantRegistry();
    registry.issue({
      grantId: "sg-dead",
      mandateRef: { mandateId: "mandate-1", version: 1 },
      grantedAt: NOW,
      expiresAt: NOW + 10,
      conditions: [],
      decisionRef: "decision:allow-1",
    });
    registry.revoke("sg-dead", NOW + 5, "before expiry");
    expect(registry.status("sg-dead", NOW + 20)).toBe("REVOKED");
    expect(registry.status("sg-never-issued", NOW)).toBe("UNKNOWN");
  });
});

describe("checkScopedGrant — fail-closed sensitive-action guard (INV-S02)", () => {
  function activeGrant(registry: ScopedGrantRegistry): ScopedExecutionGrant {
    return registry.issue({
      grantId: "sg-live",
      mandateRef: { mandateId: "mandate-1", version: 1 },
      grantedAt: NOW,
      expiresAt: NOW + 10_000,
      conditions: [],
      decisionRef: "decision:allow-1",
    });
  }

  it("vouches only for issued, ACTIVE grants", () => {
    const registry = new ScopedGrantRegistry();
    const live = activeGrant(registry);
    const check = checkScopedGrant("sg-live", registry, NOW + 1);
    expect(check.ok).toBe(true);
    if (check.ok) {
      expect(check.grant).toBe(live);
    }
  });

  it("refuses UNKNOWN, REVOKED and EXPIRED grants — never best-effort", () => {
    const registry = new ScopedGrantRegistry();
    const unknown = checkScopedGrant("sg-ghost", registry, NOW);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.status).toBe("UNKNOWN");
      expect(unknown.reason).toMatch(/never issued/);
    }
    registry.issue({
      grantId: "sg-revoked",
      mandateRef: { mandateId: "mandate-1", version: 1 },
      grantedAt: NOW,
      expiresAt: NOW + 10_000,
      conditions: [],
      decisionRef: "decision:allow-1",
    });
    registry.revoke("sg-revoked", NOW + 1, "revoked");
    const revoked = checkScopedGrant("sg-revoked", registry, NOW + 2);
    expect(revoked.ok).toBe(false);
    if (!revoked.ok) {
      expect(revoked.status).toBe("REVOKED");
    }
    registry.issue({
      grantId: "sg-expired",
      mandateRef: { mandateId: "mandate-1", version: 1 },
      grantedAt: NOW,
      expiresAt: NOW + 10,
      conditions: [],
      decisionRef: "decision:allow-1",
    });
    const expired = checkScopedGrant("sg-expired", registry, NOW + 11);
    expect(expired.ok).toBe(false);
    if (!expired.ok) {
      expect(expired.status).toBe("EXPIRED");
    }
  });

  it("refuses on a stale security epoch when principal and ledger are supplied", () => {
    const registry = new ScopedGrantRegistry();
    activeGrant(registry);
    const ledger = new EpochLedger();
    ledger.raiseEpoch("agent:agent-key-1", "key rotated", NOW + 1);
    const check = checkScopedGrant("sg-live", registry, NOW + 2, principal, ledger);
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.status).toBe("STALE_SECURITY_EPOCH");
    }
  });

  it("requires principal and ledger together (never half the inputs)", () => {
    const registry = new ScopedGrantRegistry();
    activeGrant(registry);
    expect(() => checkScopedGrant("sg-live", registry, NOW, principal, undefined)).toThrow(
      /principal and ledger together/,
    );
  });
});

describe("evaluate — scoped-execution gate (fail closed, INV-E01)", () => {
  function registryWith(scope: { actions?: readonly string[]; expiresAt?: number }): {
    registry: ScopedGrantRegistry;
    scopedId: string;
  } {
    const registry = new ScopedGrantRegistry();
    const scopedId = scope.actions?.join(",") === "payments.refund" ? "sg-other" : "sg-path";
    registry.issue({
      grantId: scopedId,
      mandateRef: { mandateId: "mandate-1", version: 1 },
      ...(scope.actions !== undefined ? { scope: { actions: scope.actions } } : {}),
      grantedAt: NOW - 10,
      expiresAt: scope.expiresAt ?? NOW + 10_000,
      conditions: [],
      decisionRef: "decision:allow-1",
    });
    return { registry, scopedId };
  }

  it("DENIES with scoped_grant_revoked once the covering scoped grant is revoked", () => {
    const { registry } = registryWith({});
    registry.revoke("sg-path", NOW, "user revoked the session grant");
    const decision = evaluate(request(), [grant()], state({ scopedGrants: registry }));
    expect(decision).toEqual({
      decision: "DENY",
      reason: "scoped_grant_revoked",
      policyRefs: ["mandate:mandate-1@1", "INV-A02", "INV-S02", "INV-E01"],
    });
  });

  it("DENIES with scoped_grant_expired when the covering scoped grant expired", () => {
    const { registry } = registryWith({ expiresAt: NOW });
    const decision = evaluate(request(), [grant()], state({ scopedGrants: registry }));
    expect(decision.decision).toBe("DENY");
    if (decision.decision === "DENY") {
      expect(decision.reason).toBe("scoped_grant_expired");
    }
  });

  it("ALLOWs and cites the vouching scoped grant as authorization evidence", () => {
    const { registry, scopedId } = registryWith({ actions: ["payments.initiate"] });
    const decision = evaluate(request(), [grant()], state({ scopedGrants: registry }));
    expect(decision.decision).toBe("ALLOW");
    if (decision.decision === "ALLOW") {
      expect(decision.evidenceRefs).toContain(`scopedGrant:${scopedId}`);
    }
  });

  it("an ACTIVE scoped grant vouches even when a sibling covering grant is revoked", () => {
    const registry = new ScopedGrantRegistry();
    registry.issue({
      grantId: "sg-a",
      mandateRef: { mandateId: "mandate-1", version: 1 },
      scope: { actions: ["payments.initiate"] },
      grantedAt: NOW - 10,
      expiresAt: NOW + 10_000,
      conditions: [],
      decisionRef: "decision:allow-1",
    });
    registry.issue({
      grantId: "sg-b",
      mandateRef: { mandateId: "mandate-1", version: 1 },
      scope: { actions: ["payments.*"] },
      grantedAt: NOW - 10,
      expiresAt: NOW + 10_000,
      conditions: [],
      decisionRef: "decision:allow-2",
    });
    registry.revoke("sg-b", NOW, "killed");
    const decision = evaluate(request(), [grant()], state({ scopedGrants: registry }));
    expect(decision.decision).toBe("ALLOW");
    if (decision.decision === "ALLOW") {
      expect(decision.evidenceRefs).toContain("scopedGrant:sg-a");
    }
  });

  it("scoped grants that do not cover the request never gate it", () => {
    // sg-other narrows a DIFFERENT action; the request is not its execution path
    const { registry } = registryWith({ actions: ["payments.refund"] });
    const decision = evaluate(request(), [grant()], state({ scopedGrants: registry }));
    expect(decision.decision).toBe("ALLOW");
    if (decision.decision === "ALLOW") {
      expect(decision.evidenceRefs).not.toContain("scopedGrant:sg-other");
    }
  });

  it("no registry supplied ⇒ Stage-0 semantics unchanged", () => {
    const decision = evaluate(request(), [grant()], state());
    expect(decision.decision).toBe("ALLOW");
  });

  it("a dead scoped path cannot be rescued by a second dead scoped grant (rank stability)", () => {
    const registry = new ScopedGrantRegistry();
    registry.issue({
      grantId: "sg-x",
      mandateRef: { mandateId: "mandate-1", version: 1 },
      scope: { actions: ["payments.initiate"] },
      grantedAt: NOW - 20,
      expiresAt: NOW - 1,
      conditions: [],
      decisionRef: "decision:allow-1",
    });
    registry.issue({
      grantId: "sg-y",
      mandateRef: { mandateId: "mandate-1", version: 1 },
      scope: { actions: ["payments.*"] },
      grantedAt: NOW - 20,
      expiresAt: NOW + 10_000,
      conditions: [],
      decisionRef: "decision:allow-2",
    });
    registry.revoke("sg-y", NOW, "killed");
    // REVOKED is the stronger death: reported even though a sibling is expired
    const decision = evaluate(request(), [grant()], state({ scopedGrants: registry }));
    if (decision.decision === "DENY") {
      expect(decision.reason).toBe("scoped_grant_revoked");
    } else {
      expect.unreachable("expected a deny");
    }
  });

  it("deterministic: identical inputs yield the identical decision", () => {
    const { registry } = registryWith({});
    registry.revoke("sg-path", NOW, "user revoked the session grant");
    const one = evaluate(request(), [grant()], state({ scopedGrants: registry }));
    const two = evaluate(request(), [grant()], state({ scopedGrants: registry }));
    expect(one).toEqual(two);
  });
});

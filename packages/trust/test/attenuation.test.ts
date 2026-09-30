import { describe, expect, it } from "vitest";
import {
  AttenuationViolationError,
  attenuate,
  attenuateGrant,
  issueGrant,
} from "../src/index.js";
import type { Mandate } from "../src/index.js";

/**
 * INV-A01: child authority is always attenuated. Every dimension must reject
 * widening and accept valid narrowing, and the error must name the exact
 * violated dimension.
 */

const BASE_TIME = 1_000_000;

function parentMandate(overrides: Partial<Mandate> = {}): Mandate {
  return {
    id: "mandate-root",
    version: 1,
    grantor: "user:owner-1",
    grantee: "agent:agent-1",
    actions: ["payments.initiate", "payments.status.read"],
    resources: [{ type: "payment_intent" }, { type: "beneficiary", resourceId: "ben-1" }],
    rails: ["sepa", "card"],
    currencies: ["EUR", "USD"],
    countries: ["DE", "FR"],
    beneficiaries: ["ben-1", "ben-2"],
    limits: {
      perTransactionAmount: { currency: "EUR", minorUnits: "500000" },
      velocity: { windowMs: 86_400_000, maxCount: 10, maxAmount: { currency: "EUR", minorUnits: "2000000" } },
    },
    costCaps: {
      maxTotalCost: { currency: "EUR", minorUnits: "10000" },
      maxFxSpreadBps: 150n,
    },
    expiresAt: BASE_TIME + 10 * 86_400_000,
    escalation: { onLimitExceeded: "require_approval", approverRef: "user:owner-1" },
    proofRequirements: [{ proofLevel: "P2", scope: "settlement" }],
    ...overrides,
  };
}

const baseRequest = {
  mandateId: "mandate-child",
  version: 1,
  grantee: "agent:agent-2",
};

describe("attenuate — valid narrowing is accepted", () => {
  it("accepts a strictly narrowed child on every dimension and records lineage", () => {
    const child = attenuate(
      parentMandate(),
      {
        ...baseRequest,
        actions: ["payments.initiate"],
        resources: [{ type: "payment_intent" }],
        rails: ["sepa"],
        currencies: ["EUR"],
        countries: ["DE"],
        beneficiaries: ["ben-1"],
        limits: {
          perTransactionAmount: { currency: "EUR", minorUnits: "100000" },
          velocity: { windowMs: 172_800_000, maxCount: 5, maxAmount: { currency: "EUR", minorUnits: "1000000" } },
        },
        costCaps: { maxTotalCost: { currency: "EUR", minorUnits: "5000" }, maxFxSpreadBps: 100n },
        expiresAt: BASE_TIME + 5 * 86_400_000,
        escalation: { onLimitExceeded: "deny" },
        proofRequirements: [{ proofLevel: "P3", scope: "settlement" }],
      },
    );

    expect(child.grantor).toBe("agent:agent-1");
    expect(child.grantee).toBe("agent:agent-2");
    expect(child.actions).toEqual(["payments.initiate"]);
    expect(child.limits?.perTransactionAmount).toEqual({ currency: "EUR", minorUnits: "100000" });
    expect(child.limits?.velocity?.maxCount).toBe(5);
    expect(child.costCaps?.maxFxSpreadBps).toBe(100n);
    expect(child.escalation?.onLimitExceeded).toBe("deny");
    expect(child.proofRequirements).toEqual([{ proofLevel: "P3", scope: "settlement" }]);
    expect(child.parentMandate).toEqual({ mandateId: "mandate-root", version: 1 });
  });

  it("accepts identity attenuation (inherit-everything request)", () => {
    const parent = parentMandate();
    const child = attenuate(parent, baseRequest);
    expect(child.actions).toEqual(parent.actions);
    expect(child.resources).toEqual(parent.resources);
    expect(child.rails).toEqual(parent.rails);
    expect(child.limits).toEqual(parent.limits);
    expect(child.costCaps).toEqual(parent.costCaps);
    expect(child.expiresAt).toBe(parent.expiresAt);
    expect(child.escalation).toEqual(parent.escalation);
    expect(child.proofRequirements).toEqual(parent.proofRequirements);
  });

  it("accepts narrowing a wildcard action namespace to a subset namespace", () => {
    const parent = parentMandate({ actions: ["payments.*"] });
    const child = attenuate(parent, { ...baseRequest, actions: ["payments.card.*"] });
    expect(child.actions).toEqual(["payments.card.*"]);
  });

  it("accepts adding limits/cost caps when the parent has none", () => {
    const full = parentMandate();
    const {
      limits: _limits,
      costCaps: _caps,
      escalation: _esc,
      ...parent
    } = full;
    const child = attenuate(parent, {
      ...baseRequest,
      limits: { perTransactionAmount: { currency: "EUR", minorUnits: "1" } },
      costCaps: { maxFxSpreadBps: 10n },
    });
    expect(child.limits?.perTransactionAmount?.minorUnits).toBe("1");
    expect(child.costCaps?.maxFxSpreadBps).toBe(10n);
  });

  it("attenuateGrant carries lineage back to the root grant", () => {
    const parentGrant = issueGrant(parentMandate(), {
      grantId: "grant-root",
      issuedAt: BASE_TIME,
    });
    const childGrant = attenuateGrant(
      parentGrant,
      { ...baseRequest, actions: ["payments.status.read"] },
      { grantId: "grant-child", issuedAt: BASE_TIME + 1000 },
    );
    expect(childGrant.lineage).toEqual({ rootGrantId: "grant-root", chain: ["grant-root"] });
    expect(childGrant.grantorRef).toBe("agent:agent-1");
    expect(childGrant.granteeRef).toBe("agent:agent-2");
  });
});

describe("attenuate — every dimension rejects widening (INV-A01)", () => {
  const widening: ReadonlyArray<{
    dimension: string;
    mutate: () => void;
  }> = [
    {
      dimension: "actions",
      mutate: () => {
        attenuate(parentMandate(), { ...baseRequest, actions: ["payouts.initiate"] });
      },
    },
    {
      dimension: "actions (namespace escape)",
      mutate: () => {
        attenuate(parentMandate(), { ...baseRequest, actions: ["payments.*"] });
      },
    },
    {
      dimension: "resources",
      mutate: () => {
        attenuate(parentMandate(), {
          ...baseRequest,
          resources: [{ type: "payment_intent" }, { type: "beneficiary", resourceId: "ben-2" }],
        });
      },
    },
    {
      dimension: "resources (type widening)",
      mutate: () => {
        attenuate(parentMandate(), { ...baseRequest, resources: [{ type: "payout" }] });
      },
    },
    {
      dimension: "rails",
      mutate: () => {
        attenuate(parentMandate(), { ...baseRequest, rails: ["sepa", "swift"] });
      },
    },
    {
      dimension: "currencies",
      mutate: () => {
        attenuate(parentMandate(), { ...baseRequest, currencies: ["EUR", "GBP"] });
      },
    },
    {
      dimension: "countries",
      mutate: () => {
        attenuate(parentMandate(), { ...baseRequest, countries: ["DE", "US"] });
      },
    },
    {
      dimension: "beneficiaries",
      mutate: () => {
        attenuate(parentMandate(), { ...baseRequest, beneficiaries: ["ben-1", "ben-3"] });
      },
    },
    {
      dimension: "limits.perTransactionAmount",
      mutate: () => {
        attenuate(parentMandate(), {
          ...baseRequest,
          limits: { perTransactionAmount: { currency: "EUR", minorUnits: "600000" } },
        });
      },
    },
    {
      dimension: "limits.perTransactionAmount (currency switch)",
      mutate: () => {
        attenuate(parentMandate(), {
          ...baseRequest,
          limits: { perTransactionAmount: { currency: "USD", minorUnits: "1" } },
        });
      },
    },
    {
      dimension: "limits.velocity.windowMs",
      mutate: () => {
        attenuate(parentMandate(), {
          ...baseRequest,
          limits: {
            velocity: { windowMs: 3_600_000, maxCount: 10, maxAmount: { currency: "EUR", minorUnits: "2000000" } },
          },
        });
      },
    },
    {
      dimension: "limits.velocity.maxCount",
      mutate: () => {
        attenuate(parentMandate(), {
          ...baseRequest,
          limits: {
            velocity: { windowMs: 86_400_000, maxCount: 11, maxAmount: { currency: "EUR", minorUnits: "2000000" } },
          },
        });
      },
    },
    {
      dimension: "limits.velocity.maxAmount",
      mutate: () => {
        attenuate(parentMandate(), {
          ...baseRequest,
          limits: {
            velocity: { windowMs: 86_400_000, maxCount: 10, maxAmount: { currency: "EUR", minorUnits: "2000001" } },
          },
        });
      },
    },
    {
      dimension: "costCaps.maxTotalCost",
      mutate: () => {
        attenuate(parentMandate(), {
          ...baseRequest,
          costCaps: { maxTotalCost: { currency: "EUR", minorUnits: "10001" } },
        });
      },
    },
    {
      dimension: "costCaps.maxFxSpreadBps",
      mutate: () => {
        attenuate(parentMandate(), {
          ...baseRequest,
          costCaps: { maxFxSpreadBps: 151n },
        });
      },
    },
    {
      dimension: "expiry",
      mutate: () => {
        attenuate(parentMandate(), {
          ...baseRequest,
          expiresAt: BASE_TIME + 11 * 86_400_000,
        });
      },
    },
    {
      dimension: "escalation",
      mutate: () => {
        // parent approver replaced by the child itself
        attenuate(parentMandate(), {
          ...baseRequest,
          escalation: { onLimitExceeded: "require_approval", approverRef: "agent:agent-2" },
        });
      },
    },
    {
      dimension: "escalation (dropped approver)",
      mutate: () => {
        attenuate(parentMandate(), {
          ...baseRequest,
          escalation: { onLimitExceeded: "require_approval" },
        });
      },
    },
    {
      dimension: "proofRequirements",
      mutate: () => {
        attenuate(parentMandate(), { ...baseRequest, proofRequirements: [] });
      },
    },
    {
      dimension: "proofRequirements (weakened level)",
      mutate: () => {
        attenuate(parentMandate(), {
          ...baseRequest,
          proofRequirements: [{ proofLevel: "P1", scope: "settlement" }],
        });
      },
    },
  ];

  for (const case_ of widening) {
    it(`rejects widening on ${case_.dimension}`, () => {
      expect(case_.mutate).toThrow(AttenuationViolationError);
    });
  }

  it("error names the exact violated dimension", () => {
    try {
      attenuate(parentMandate(), { ...baseRequest, rails: ["swift"] });
      expect.unreachable("must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AttenuationViolationError);
      const violation = error as AttenuationViolationError;
      expect(violation.dimension).toBe("rails");
      expect(violation.message).toContain("rails");
      expect(violation.message).toContain("swift");
    }
  });

  it("rejects lifting a scope restriction the parent does not have (never unrestricted)", () => {
    // parent restricted to SEPA; child asks for the parent's set minus nothing
    // but tries to drop the rail restriction entirely by sending [] — empty is
    // narrower (deny-all), which is fine; instead assert an explicit wider set fails
    expect(() =>
      attenuate(parentMandate(), { ...baseRequest, rails: ["sepa", "card", "swift"] }),
    ).toThrow(/rails/);
  });
});

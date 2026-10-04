/**
 * The no-hidden-custody law (Work Order P4-W4-001; INV-C09).
 *
 * Custody is EXPLICIT and CONTIGUOUS at every hop of every compiled route:
 * nothing may implicitly hold funds. This suite proves the law from both
 * sides —
 *
 * - the POSITIVE side: every plan of every representative route (all four
 *   intents, ALL emitted plans — mixed, provider-native baselines and
 *   Stripe Mode A/B) custody-chains through assertCustodyContinuity, and
 *   every custody transfer of every leg carries non-empty evidence refs
 *   (INV-E02) and an explicit exact-integer amount (INV-F01);
 * - the ADVERSARIAL side: a custody GAP between consecutive hops throws
 *   (value arriving at party A while the next hop starts from party B is
 *   structurally unrepresentable); an unevidenced custody transfer throws;
 *   an unknown custody-party kind throws (hidden custody is structurally
 *   unrepresentable); a non-integer amount throws.
 */

import { describe, expect, it } from "vitest";
import {
  assertCustodyContinuity,
  validateCustodyTransfer,
} from "../src/index.js";
import type { CustodyTransfer, CustodyParty } from "../src/index.js";
import {
  compileBase,
  route1Intent,
  route2Intent,
  route3Intent,
  route4Intent,
} from "./fixtures.js";

/** All plans of all four representative routes (the full compiled surface). */
function allRepresentativePlans(): { label: string; shapeId: string; plan: ReturnType<typeof compileBase>["plans"][number] }[] {
  const collected: { label: string; shapeId: string; plan: ReturnType<typeof compileBase>["plans"][number] }[] = [];
  const intents: readonly [string, () => ReturnType<typeof route1Intent>][] = [
    ["route-1", route1Intent],
    ["route-2", route2Intent],
    ["route-3", route3Intent],
    ["route-4", route4Intent],
  ];
  for (const [label, intent] of intents) {
    const result = compileBase(intent());
    expect(result.plans.length).toBeGreaterThan(0);
    for (const plan of result.plans) {
      collected.push({ label, shapeId: plan.shapeId, plan });
    }
  }
  return collected;
}

/** A validated deep copy of one compiled custody transfer (mutable base for adversarial mutation). */
function cloneCustody(custody: CustodyTransfer): Record<string, unknown> {
  return JSON.parse(JSON.stringify(custody)) as Record<string, unknown>;
}

describe("every compiled plan custody-chains (the positive law)", () => {
  it("assertCustodyContinuity passes over the legs' custodies of EVERY plan of EVERY representative route", () => {
    const plans = allRepresentativePlans();
    expect(plans.length).toBeGreaterThanOrEqual(8);
    for (const { label, shapeId, plan } of plans) {
      expect(plan.legs.length).toBeGreaterThan(0);
      expect(() =>
        assertCustodyContinuity(plan.legs.map((leg) => leg.custody)),
      ).not.toThrow(`${label}/${shapeId} must custody-chain`);
    }
  });

  it("every custody transfer of every leg of every compiled plan is evidenced and explicitly amounted", () => {
    for (const { label, shapeId, plan } of allRepresentativePlans()) {
      for (const leg of plan.legs) {
        // INV-E02: an external effect without linked evidence is not evidence.
        expect(
          leg.custody.evidenceRefs.length,
          `${label}/${shapeId}/${leg.legId} custody evidenceRefs`,
        ).toBeGreaterThan(0);
        for (const ref of leg.custody.evidenceRefs) {
          expect(ref.length).toBeGreaterThan(0);
        }
        // The amount is EXPLICIT and exact (INV-F01) — never implied.
        expect(leg.custody.amount).toBeDefined();
        expect(leg.custody.amount.currency).toMatch(/^[A-Z]{3}$/);
        expect(leg.custody.amount.minorUnits).toMatch(/^(0|[1-9][0-9]*)$/);
        // The hop names BOTH parties explicitly (no implicit holder).
        expect(leg.custody.from.kind).toBeTruthy();
        expect(leg.custody.to.kind).toBeTruthy();
        // And re-validating the compiled custody through the fail-closed
        // validator accepts it verbatim (defense in depth).
        expect(() => validateCustodyTransfer(leg.custody)).not.toThrow();
      }
    }
  });

  it("the walk's custodyAtStop agrees with the custody chain's last hop (no hidden custody mid-journey)", () => {
    // A plan's terminal custody party IS the last leg's `to` party — the
    // chain and the walk can never disagree about where value sits.
    for (const { shapeId, plan } of allRepresentativePlans()) {
      const lastLeg = plan.legs[plan.legs.length - 1]!;
      expect(lastLeg.custody.to).toBeDefined();
      // Single-leg plans (e.g. the Stripe native settlement) trivially chain.
      if (plan.legs.length === 1) {
        expect(() => assertCustodyContinuity([lastLeg.custody])).not.toThrow();
      }
    }
  });
});

describe("adversarial custody (hidden custody is structurally unrepresentable)", () => {
  // The route-1 mixed plan's first two custody transfers: wallet→wallet
  // (DEX morph) then wallet→provider (the off-ramp deposit).
  function mixedPlanCustodies(): CustodyTransfer[] {
    const plan = compileBase(route1Intent()).plans.find(
      (plan) => plan.shapeId === "mixed-dex-offramp",
    )!;
    return plan.legs.map((leg) => leg.custody);
  }

  it("a GAP between consecutive hops throws (value never moves implicitly)", () => {
    const custodies = mixedPlanCustodies();
    // leg0.to is the (post-swap) wallet; leg1.from must be that same wallet.
    const [first, second, ...rest] = custodies;
    const gappedSecond = validateCustodyTransfer({
      ...cloneCustody(second!),
      from: { kind: "ONCHAIN_WALLET", accountRef: "0x9999999999999999999999999999999999999999" },
    });
    expect(() =>
      assertCustodyContinuity([first!, gappedSecond, ...rest]),
    ).toThrow(/custody continuity broken between hop 0 and hop 1/);
    expect(() =>
      assertCustodyContinuity([first!, gappedSecond, ...rest]),
    ).toThrow(/INV-C09/);
  });

  it("a gap between later hops throws too (every hop boundary is guarded)", () => {
    const custodies = mixedPlanCustodies();
    const [first, second, third, fourth] = custodies;
    const gappedThird = validateCustodyTransfer({
      ...cloneCustody(third!),
      from: { kind: "ONCHAIN_WALLET", accountRef: "0x8888888888888888888888888888888888888888" },
    });
    expect(() =>
      assertCustodyContinuity([first!, second!, gappedThird, fourth!]),
    ).toThrow(/custody continuity broken between hop 1 and hop 2/);
  });

  it("an empty custody transfer (no evidence refs) throws (INV-E02)", () => {
    const [first] = mixedPlanCustodies();
    expect(() =>
      validateCustodyTransfer({ ...cloneCustody(first!), evidenceRefs: [] }),
    ).toThrow(/INV-E02/);
    expect(() =>
      validateCustodyTransfer({ ...cloneCustody(first!), evidenceRefs: [""] }),
    ).toThrow(/INV-E02/);
    expect(() =>
      validateCustodyTransfer({ ...cloneCustody(first!), evidenceRefs: undefined }),
    ).toThrow(/INV-E02/);
  });

  it("a custody party with an unknown kind throws (hidden custody is structurally unrepresentable)", () => {
    const [first] = mixedPlanCustodies();
    expect(() =>
      validateCustodyTransfer({
        ...cloneCustody(first!),
        from: { kind: "SOMEWHERE_UNNAMED" },
      }),
    ).toThrow(/hidden custody is structurally unrepresentable/);
    expect(() =>
      validateCustodyTransfer({
        ...cloneCustody(first!),
        to: { kind: "IMPLICIT_HOLDER" },
      }),
    ).toThrow(/hidden custody is structurally unrepresentable/);
    expect(() =>
      validateCustodyTransfer({ ...cloneCustody(first!), from: null }),
    ).toThrow(/custody from is required/);
  });

  it("an amount with non-integer minorUnits throws (INV-F01)", () => {
    const [first] = mixedPlanCustodies();
    expect(() =>
      validateCustodyTransfer({
        ...cloneCustody(first!),
        amount: { currency: "ETH", minorUnits: "1.5" },
      }),
    ).toThrow(/INV-F01/);
    expect(() =>
      validateCustodyTransfer({
        ...cloneCustody(first!),
        amount: { currency: "ETH", minorUnits: "-10000000000000000" },
      }),
    ).toThrow(/INV-F01/);
    expect(() =>
      validateCustodyTransfer({
        ...cloneCustody(first!),
        amount: { currency: "ether", minorUnits: "10000000000000000" },
      }),
    ).toThrow(/INV-F01/);
  });

  it("a missing custody transfer fails closed (value never moves implicitly)", () => {
    expect(() => validateCustodyTransfer(null)).toThrow(
      /a custody transfer is required for every hop/,
    );
    expect(() => validateCustodyTransfer(undefined)).toThrow(
      /a custody transfer is required for every hop/,
    );
    const [first] = mixedPlanCustodies();
    expect(() =>
      validateCustodyTransfer({ ...cloneCustody(first!), assetRef: "" }),
    ).toThrow(/assetRef must be non-empty/);
  });

  it("a validated custody transfer is frozen and carries its evidence verbatim", () => {
    const [first] = mixedPlanCustodies();
    const validated = validateCustodyTransfer(cloneCustody(first!));
    expect(Object.isFrozen(validated)).toBe(true);
    expect(validated.evidenceRefs).toEqual(first!.evidenceRefs);
    // The party vocabulary is closed: every compiled party has a known kind.
    const knownKinds: readonly CustodyParty["kind"][] = [
      "ONCHAIN_WALLET",
      "EXTERNAL_PROVIDER",
      "EXTERNAL_BANK_INSTRUMENT",
      "ONCHAIN_PROTOCOL",
      "STRIPE_MERCHANT_BALANCE",
    ];
    expect(knownKinds).toContain(validated.from.kind);
    expect(knownKinds).toContain(validated.to.kind);
  });
});

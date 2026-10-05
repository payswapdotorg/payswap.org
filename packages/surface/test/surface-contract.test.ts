/**
 * Surface contract tests (P4-W4-002 §4): the versioned registries are
 * complete, ordered and provenance-tagged; the money formatter is exact
 * integer arithmetic; the folds are pure. These are CONTRACT tests — they
 * pin the public surface shape, so an accidental breaking change fails
 * here before it fails a downstream extension or mobile app.
 */

import { describe, expect, it } from "vitest";
import { registerCurrency } from "@payswap/protocol";

import {
  OUTCOME_REGISTRY,
  SURFACE_API_VERSION,
  UNIVERSAL_AREAS,
  UNIVERSAL_AREA_IDS,
  formatMinorUnits,
  minorUnitsSortKey,
  outcomeActionById,
  outcomeCapabilityBoard,
  resolveMinorUnitDigits,
  surfaceProvenance,
  universalAreaById,
} from "../src/index.js";

// The landed registry primitive: registration is a HOST responsibility
// (route-compiler's fixtures do the same) — the formatter consumes the
// registry, it never seeds it.
registerCurrency("EUR", 2);
registerCurrency("USD", 2);

describe("surface versioning contract", () => {
  it("exposes a semver surface version", () => {
    expect(SURFACE_API_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("tags provenance with the version and work order", () => {
    const p = surfaceProvenance("P4-W4-002");
    expect(p.surfaceApiVersion).toBe(SURFACE_API_VERSION);
    expect(p.workOrder).toBe("P4-W4-002");
    expect(p.stability).toBe("stable");
  });
});

describe("outcome registry contract (§3.1)", () => {
  it("carries exactly the five outcome actions in the work order's order", () => {
    expect(OUTCOME_REGISTRY.map((action) => action.id)).toEqual([
      "pay",
      "receive",
      "move",
      "convert",
      "checkout",
    ]);
  });

  it("every action has a real dispatch authority and provenance", () => {
    for (const action of OUTCOME_REGISTRY) {
      expect(action.outcomeLine.length).toBeGreaterThan(10);
      expect(action.advancedDisclosure.length).toBeGreaterThan(0);
      expect(["payswap-api-runtime", "merchant-checkout-dispatch", "route-compiler-preview"]).toContain(
        action.dispatch.authority,
      );
      expect(action.provenance.workOrder).toBe("P4-W4-002");
    }
  });

  it("pay/receive/move carry the certified API commandTypes", () => {
    expect(outcomeActionById("pay").dispatch.commandType).toBe("payments.intent.create");
    expect(outcomeActionById("receive").dispatch.commandType).toBe("payments.collect.request");
    expect(outcomeActionById("move").dispatch.commandType).toBe("payouts.payout.create");
  });

  it("unknown ids fail closed", () => {
    expect(() => outcomeActionById("borrow" as never)).toThrow();
  });
});

describe("outcome capability honesty (state machine)", () => {
  const nothing = {
    apiRuntimeConfigured: false,
    merchantCheckoutContextBound: false,
    routeCompilationInputsAvailable: false,
  };

  it("an empty deployment honestly reports every action und dispatchable with a typed prerequisite", () => {
    const board = outcomeCapabilityBoard(nothing);
    for (const { state } of board) {
      expect(state.dispatchable).toBe(false);
      expect(state.missingPrerequisite).toBeDefined();
      expect(state.missingPrerequisite?.length).toBeGreaterThan(20);
    }
  });

  it("pay becomes dispatchable ONLY with the API runtime configured", () => {
    expect(
      outcomeActionById("pay").capability({ ...nothing, apiRuntimeConfigured: true }).dispatchable,
    ).toBe(true);
    expect(outcomeActionById("pay").capability(nothing).dispatchable).toBe(false);
  });

  it("convert is independent of the API runtime (route-compiler authority)", () => {
    const state = outcomeActionById("convert").capability({
      ...nothing,
      apiRuntimeConfigured: true,
    });
    expect(state.dispatchable).toBe(false); // lanes are the prerequisite, not the API
  });

  it("checkout requires the merchant checkout context, never the API runtime alone", () => {
    expect(
      outcomeActionById("checkout").capability({ ...nothing, apiRuntimeConfigured: true })
        .dispatchable,
    ).toBe(false);
    expect(
      outcomeActionById("checkout").capability({ ...nothing, merchantCheckoutContextBound: true })
        .dispatchable,
    ).toBe(true);
  });
});

describe("universal areas contract (§3.2)", () => {
  it("carries exactly the eleven areas in the work order's order", () => {
    expect([...UNIVERSAL_AREA_IDS]).toEqual([
      "overview",
      "payments",
      "accounts",
      "activity",
      "opportunities",
      "connections",
      "capabilities",
      "security",
      "reports",
      "developers",
      "settings",
    ]);
    expect(UNIVERSAL_AREAS.length).toBe(11);
  });

  it("every area cites research documents (auditable mapping)", () => {
    for (const area of UNIVERSAL_AREAS) {
      expect(area.researchCitations.length).toBeGreaterThan(0);
      for (const citation of area.researchCitations) {
        expect(citation).toMatch(/\.md$/);
      }
    }
  });

  it("every area has a designed honest empty state with a real next action", () => {
    for (const area of UNIVERSAL_AREAS) {
      expect(area.emptyState.reason.length).toBeGreaterThan(20);
      expect(["route", "outcome"]).toContain(area.emptyState.nextAction.kind);
      expect(area.emptyState.nextAction.value.length).toBeGreaterThan(0);
    }
  });

  it("unknown area ids fail closed", () => {
    expect(() => universalAreaById("vault" as never)).toThrow();
  });
});

describe("exact integer money display (INV-F01)", () => {
  it("formats registered two-digit currencies exactly", () => {
    expect(formatMinorUnits(123456n, "EUR")).toBe("1,234.56 EUR");
    expect(formatMinorUnits(0n, "usd")).toBe("0.00 USD");
    expect(formatMinorUnits(5n, "USD")).toBe("0.05 USD");
    expect(formatMinorUnits(100n, "USD")).toBe("1.00 USD");
  });

  it("formats integer strings (the wire form) without floats", () => {
    expect(formatMinorUnits("999999999999", "USD")).toBe("9,999,999,999.99 USD");
  });

  it("handles negatives with a true minus sign", () => {
    expect(formatMinorUnits(-420n, "USD")).toBe("−4.20 USD");
  });

  it("labels the honest fallback for unregistered codes", () => {
    const out = formatMinorUnits(1n, "XYZ");
    expect(out).toContain("unregistered code");
    expect(resolveMinorUnitDigits("XYZ").kind).toBe("fallback-assumed-2");
    expect(resolveMinorUnitDigits("USD").kind).toBe("registry");
  });

  it("rejects non-integer and malformed inputs (never silently rounds)", () => {
    expect(() => formatMinorUnits("12.5", "USD")).toThrow();
    expect(() => formatMinorUnits("abc", "USD")).toThrow();
  });

  it("produces a stable machine sort key", () => {
    expect(minorUnitsSortKey(5n, "usd") < minorUnitsSortKey(50n, "USD")).toBe(true);
  });
});

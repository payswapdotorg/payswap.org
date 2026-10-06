/**
 * UX-002 — outcome-action reconciliation alias tests (@payswap/surface):
 *
 * - the alias table covers exactly the FIVE certified outcome actions;
 * - `receive` ≈ the request lane; `move` ≈ the withdraw/convert lanes;
 * - every mapped verb is a REAL command grammar verb and every nav anchor is
 *   a REAL sidebar group or persistent row (imported from @payswap/ux — the
 *   single vocabularies; no second vocabulary can drift here);
 * - the CERTIFIED registry is untouched: ids, order, dispatch commandTypes
 *   and capability folds keep their P4-W4-002 shapes (additive-only proof).
 */

import { describe, expect, it } from "vitest";
import {
  COMMAND_VERBS,
  SIDEBAR_GROUP_SLUGS,
  SIDEBAR_PERSISTENT_ROW_IDS,
} from "@payswap/ux";

import {
  OUTCOME_ACTION_ALIASES,
  OUTCOME_REGISTRY,
  outcomeActionAlias,
  outcomeActionById,
  outcomeCapabilityBoard,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// The alias table (UX-002 deliverable 5)
// ---------------------------------------------------------------------------

describe("outcome-action aliases reconcile onto the command verbs + nav anchors", () => {
  it("the REAL @payswap/ux registries equal the surface-side mirror unions (drift fails here)", () => {
    // The src-side types deliberately mirror ux's single vocabularies (see the
    // comment in src/outcomes.ts); this pins the mirror to the source.
    expect([...COMMAND_VERBS]).toEqual(["pay", "request", "invoice", "link", "convert", "withdraw"]);
    expect([...SIDEBAR_GROUP_SLUGS]).toEqual(["accept", "bill", "insights", "capabilities", "more"]);
    expect([...SIDEBAR_PERSISTENT_ROW_IDS]).toEqual([
      "home",
      "balances",
      "transactions",
      "customers",
      "catalog",
    ]);
  });

  it("covers exactly the five certified outcome actions", () => {
    expect(Object.keys(OUTCOME_ACTION_ALIASES).sort()).toEqual(
      ["pay", "receive", "move", "convert", "checkout"].sort(),
    );
  });

  it("receive ≈ the request lane; move ≈ the withdraw/convert lanes (work-order mapping)", () => {
    expect(OUTCOME_ACTION_ALIASES.receive.commandVerbs).toEqual(["request"]);
    expect(OUTCOME_ACTION_ALIASES.move.commandVerbs).toEqual(["withdraw", "convert"]);
    expect(OUTCOME_ACTION_ALIASES.pay.commandVerbs).toEqual(["pay"]);
    expect(OUTCOME_ACTION_ALIASES.convert.commandVerbs).toEqual(["convert"]);
    expect(OUTCOME_ACTION_ALIASES.checkout.commandVerbs).toEqual(["link"]);
  });

  it("every mapped verb is one of the SIX grammar verbs (single vocabulary, typed)", () => {
    for (const alias of Object.values(OUTCOME_ACTION_ALIASES)) {
      expect(alias.commandVerbs.length).toBeGreaterThan(0);
      for (const verb of alias.commandVerbs) {
        expect(COMMAND_VERBS).toContain(verb);
      }
    }
  });

  it("every nav anchor is a REAL sidebar group or persistent row (single navigation vocabulary)", () => {
    const anchors = new Set<string>([...SIDEBAR_GROUP_SLUGS, ...SIDEBAR_PERSISTENT_ROW_IDS]);
    for (const alias of Object.values(OUTCOME_ACTION_ALIASES)) {
      expect(alias.navAnchors.length).toBeGreaterThan(0);
      for (const anchor of alias.navAnchors) {
        expect(anchors.has(anchor)).toBe(true);
      }
    }
  });

  it("move anchors on the Balances object row — where the withdraw flow routes (contract 06 §3)", () => {
    expect(OUTCOME_ACTION_ALIASES.move.navAnchors).toContain("balances");
    expect(OUTCOME_ACTION_ALIASES.convert.navAnchors).toContain("balances");
    expect(OUTCOME_ACTION_ALIASES.pay.navAnchors).toContain("accept");
    expect(OUTCOME_ACTION_ALIASES.receive.navAnchors).toContain("accept");
    expect(OUTCOME_ACTION_ALIASES.checkout.navAnchors).toContain("accept");
  });

  it("every alias carries an auditable note; lookups fail closed on unknown ids", () => {
    for (const alias of Object.values(OUTCOME_ACTION_ALIASES)) {
      expect(alias.note.length).toBeGreaterThan(20);
      expect(alias.actionId).toBeDefined();
    }
    expect(() => outcomeActionAlias("borrow" as never)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// The certified registry is UNTOUCHED (additive-only proof)
// ---------------------------------------------------------------------------

describe("the certified outcome registry keeps its P4-W4-002 shape (additive-only)", () => {
  it("still carries exactly the five actions in the certified order", () => {
    expect(OUTCOME_REGISTRY.map((action) => action.id)).toEqual([
      "pay",
      "receive",
      "move",
      "convert",
      "checkout",
    ]);
  });

  it("the certified dispatch commandTypes are unchanged", () => {
    expect(outcomeActionById("pay").dispatch.commandType).toBe("payments.intent.create");
    expect(outcomeActionById("receive").dispatch.commandType).toBe("payments.collect.request");
    expect(outcomeActionById("move").dispatch.commandType).toBe("payouts.payout.create");
  });

  it("the capability folds still work exactly as before (no alias leakage into the registry)", () => {
    const nothing = {
      apiRuntimeConfigured: false,
      merchantCheckoutContextBound: false,
      routeCompilationInputsAvailable: false,
    };
    const board = outcomeCapabilityBoard(nothing);
    expect(board).toHaveLength(5);
    for (const { state } of board) {
      expect(state.dispatchable).toBe(false);
      expect(state.missingPrerequisite).toBeDefined();
    }
    expect(outcomeActionById("pay").capability({ ...nothing, apiRuntimeConfigured: true }).dispatchable).toBe(
      true,
    );
  });

  it("the aliases add no fields to the OutcomeAction objects themselves", () => {
    for (const action of OUTCOME_REGISTRY) {
      expect(Object.keys(action).sort()).toEqual(
        [
          "advancedDisclosure",
          "capability",
          "dispatch",
          "id",
          "label",
          "outcomeLine",
          "provenance",
        ].sort(),
      );
    }
  });
});

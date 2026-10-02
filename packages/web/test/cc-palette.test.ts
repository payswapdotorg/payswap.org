import { describe, expect, it } from "vitest";

import { deriveCcPalette, derivePaletteActions, derivePaletteGoTo } from "../src/lib/cc/palette";
import { deriveNavigationForRole, PRODUCT_NAVIGATION } from "@payswap/ux";

/**
 * P3-W2-002 — the ⌘K palette derivation: Go-to covers every section the
 * role's derived navigation exposes; Actions are the real journey starts,
 * role-filtered; nothing placeholder.
 */

describe("palette derivation", () => {
  it("Go-to covers every visible section for the default role", () => {
    const nav = deriveNavigationForRole(PRODUCT_NAVIGATION, "merchant");
    const goTo = derivePaletteGoTo("merchant");
    expect(goTo.map((command) => command.href)).toEqual(
      nav.items.map((view) =>
        view.item.id === "overview" ? "/app" : `/app/${view.item.id}`,
      ),
    );
  });

  it("Go-to respects role-derived visibility (expert sees no Payments)", () => {
    const goTo = derivePaletteGoTo("expert");
    const hrefs = goTo.map((command) => command.href);
    expect(hrefs).not.toContain("/app/payments");
    expect(hrefs).not.toContain("/app/payouts");
    expect(hrefs).toContain("/app");
    expect(hrefs).toContain("/app/settings");
    expect(hrefs).toContain("/app/evidence");
  });

  it("Actions are the verb-first journey starts with role filtering", () => {
    const actions = derivePaletteActions("merchant");
    const labels = actions.map((action) => action.label);
    expect(labels).toContain("Pay a recipient");
    expect(labels).toContain("Collect from a payer");
    expect(labels).toContain("Request a payout");
    expect(labels).toContain("Connect a provider");
    // The expert role cannot see Payments — the Pay action must not appear.
    const expertLabels = derivePaletteActions("expert").map((action) => action.label);
    expect(expertLabels).not.toContain("Pay a recipient");
    expect(expertLabels).not.toContain("Request a payout");
  });

  it("journey-start actions carry the ?start=1 deep-link parameter", () => {
    const pay = derivePaletteActions("merchant").find((action) => action.id === "action-pay");
    expect(pay?.href).toBe("/app/payments?start=1");
    const collect = derivePaletteActions("merchant").find((action) => action.id === "action-collect");
    expect(collect?.href).toBe("/app/collections?start=1");
  });

  it("links Connect to the parallel plane's /connect route string", () => {
    const connect = derivePaletteActions("merchant").find((action) => action.id === "action-connect");
    expect(connect?.href).toBe("/connect");
  });

  it("every command id is unique across both sections", () => {
    const palette = deriveCcPalette("merchant");
    const ids = [...palette.actions, ...palette.goTo].map((command) => command.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every go-to command carries a real group chip from the nav model", () => {
    for (const command of derivePaletteGoTo("lp")) {
      expect(command.group.length).toBeGreaterThan(0);
      expect(["Overview", "Money movement", "Capabilities", "Trust", "Develop", "Account"]).toContain(
        command.group,
      );
    }
  });
});

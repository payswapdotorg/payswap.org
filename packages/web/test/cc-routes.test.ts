import { describe, expect, it } from "vitest";

import { appRouteForNavItemId, appRoutes, resolveAppSection } from "../src/lib/cc/routes";
import { PRODUCT_ROLES } from "@payswap/ux";
import { navigationItems, PRODUCT_NAVIGATION } from "@payswap/ux";

/**
 * P3-W2-002 — the /app route binding: every certified navigation item
 * resolves to a real /app route (no dead navigation), and pathnames resolve
 * back to their sections honestly (unknown paths are UNKNOWN_SECTION, never
 * a silent redirect).
 */

const ALL_ITEM_IDS = navigationItems(PRODUCT_NAVIGATION).map((item) => item.id);

describe("command center route binding", () => {
  it("gives every navigation item a unique /app route", () => {
    expect(ALL_ITEM_IDS.length).toBeGreaterThanOrEqual(16);
    const routes = appRoutes().map(([, route]) => route);
    expect(new Set(routes).size).toBe(routes.length);
    for (const [id, route] of appRoutes()) {
      expect(route).toMatch(/^\/app(\/[a-z-]+)?$/);
      expect(route).toBe(id === "overview" ? "/app" : `/app/${id}`);
    }
  });

  it("resolves every section route back to its nav item", () => {
    for (const [id, route] of appRoutes()) {
      const resolution = resolveAppSection(route);
      expect(resolution).toEqual({ kind: "SECTION", navItemId: id, route });
    }
  });

  it("marks unknown /app paths UNKNOWN_SECTION (deep links never silently redirect)", () => {
    expect(resolveAppSection("/app/nonsense")).toEqual({
      kind: "UNKNOWN_SECTION",
      path: "/app/nonsense",
    });
    expect(resolveAppSection("/app/payments/deeper")).toEqual({
      kind: "UNKNOWN_SECTION",
      path: "/app/payments/deeper",
    });
  });

  it("marks paths outside /app NOT_APP", () => {
    expect(resolveAppSection("/")).toEqual({ kind: "NOT_APP" });
    expect(resolveAppSection("/capabilities")).toEqual({ kind: "NOT_APP" });
  });

  it("fails closed on unknown nav item ids", () => {
    expect(() => appRouteForNavItemId("not-a-real-item" as never)).toThrow();
  });

  it("covers the eight core sections the work order mandates", () => {
    for (const id of [
      "overview",
      "activity",
      "payments",
      "collections",
      "payouts",
      "capabilities",
      "evidence",
      "settings",
    ] as const) {
      expect(appRouteForNavItemId(id)).toMatch(/^\/app/);
    }
  });

  it("exports all eight roles from the certified model (the switcher's data)", () => {
    expect(PRODUCT_ROLES).toHaveLength(8);
  });
});

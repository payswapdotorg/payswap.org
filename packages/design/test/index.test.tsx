import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import * as design from "../src/index.js";

/**
 * Barrel contract: the package index exports the complete public surface and
 * the pieces compose. Catches export collisions, typos, and missing files.
 */

describe("@payswap/design index", () => {
  it("exports tokens, hooks, utilities and every component family", () => {
    const expected = [
      // tokens
      "TOKEN_VERSION", "neutral", "emerald", "amber", "red",
      "SEMANTIC_TOKEN_NAMES", "semanticLight", "semanticDark",
      "typeScale", "fontStacks", "spacing", "density", "radius", "motion",
      "elevation", "STATUS_TONES", "statusToneClass", "statusToneTokenFamily",
      // utils + hooks
      "cx", "getFocusable", "useFocusTrap", "useCommandKey",
      "useReducedMotion", "useId",
      // primitives
      "Button", "Card", "CardMeta", "CardSubtitle", "CardTitle", "Panel",
      "Badge", "StatusPill", "STATUS_PILL_TONES",
      "Field", "FieldContext", "Input", "Select",
      "Tabs", "Dialog", "CommandPalette", "fuzzyMatch",
      "Sidebar", "SidebarDrawer", "SidebarSection", "SidebarItem",
      "Topbar", "SkipLink",
      // honest states
      "Skeleton", "EmptyState", "ErrorState", "UnknownState", "AuthRequiredState",
      "Toast", "ToastViewport", "TOAST_TONES", "KeyValue",
    ] as const;
    for (const name of expected) {
      expect(design, `missing export: ${name}`).toHaveProperty(name);
    }
  });

  it("the pieces compose into an honest shell", () => {
    render(<design.SkipLink />);
    // SkipLink renders fixed text; smoke-assert it plus a composed state
    render(
      <design.UnknownState
        action={<design.Button size="sm">Check again later</design.Button>}
      />,
    );
    expect(screen.getByRole("status")).toHaveClass("ps-state--unknown");
    expect(screen.getByRole("button", { name: "Check again later" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /skip to main content/i })).toBeInTheDocument();
  });

  it("status tone tables stay consistent (UNKNOWN never styled as danger)", () => {
    expect(design.statusToneTokenFamily.unknown).toBe("--ps-unknown");
    expect(design.statusToneTokenFamily.unknown).not.toBe(
      design.statusToneTokenFamily.failed,
    );
    expect(design.statusToneClass.unknown).not.toBe(design.statusToneClass.failed);
    expect(design.STATUS_PILL_TONES).toContain("unknown");
  });
});

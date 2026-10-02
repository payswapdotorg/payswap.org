import { describe, it, expect } from "vitest";
import { cx } from "../src/utils/cx.js";

describe("cx", () => {
  it("joins truthy parts with spaces", () => {
    expect(cx("ps-button", "ps-button--primary")).toBe(
      "ps-button ps-button--primary",
    );
  });

  it("drops falsy parts", () => {
    expect(cx("ps-card", false && "x", undefined, null, "ps-card--raised")).toBe(
      "ps-card ps-card--raised",
    );
  });

  it("returns empty string for no truthy parts", () => {
    expect(cx(false, undefined, null)).toBe("");
  });
});

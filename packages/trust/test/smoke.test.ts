import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "../src/index.js";

describe("package scaffold", () => {
  it("exposes its package identity", () => {
    expect(PACKAGE_NAME).toMatch(/^@payswap\//);
  });
});

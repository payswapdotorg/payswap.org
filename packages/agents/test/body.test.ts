import { describe, expect, it } from "vitest";
import { bodyContractKey } from "../src/index.js";
import type { AgentBody } from "../src/index.js";
import type { Equal, Expect } from "./type-utils.js";

/**
 * INV-G01: Agent Body is independent of model or Soul — structurally, at the
 * type level and at runtime.
 */

const body: AgentBody = {
  id: "body:payer",
  version: 1,
  declaredInterfaces: {
    inputs: [{ name: "intent", artifactType: "Intent" }],
    outputs: [{ name: "proposal", artifactType: "Execution" }],
  },
  capabilityDescriptors: [
    { name: "route-selection", summary: "Proposes a routing strategy for an intent" },
  ],
  constraints: [
    { kind: "safety", description: "Never proposes actions outside mandate scope" },
    { kind: "resource", description: "At most one in-flight proposal per session" },
  ],
};

describe("AgentBody (INV-G01: no model/Soul fields)", () => {
  it("has no model or soul keys at runtime", () => {
    const keys = JSON.stringify(body);
    expect(keys).not.toMatch(/"model"/i);
    expect(keys).not.toMatch(/"soul"/i);
    expect(keys).not.toMatch(/"persona"/i);
    expect(keys).not.toMatch(/"provider"/i);
  });

  it("declares exactly the contract fields", () => {
    expect(Object.keys(body).sort()).toEqual([
      "capabilityDescriptors",
      "constraints",
      "declaredInterfaces",
      "id",
      "version",
    ]);
  });

  it("bodyContractKey is deterministic and content-sensitive", () => {
    const same = bodyContractKey(body);
    expect(bodyContractKey({ ...body })).toBe(same);
    expect(
      bodyContractKey({
        ...body,
        declaredInterfaces: {
          ...body.declaredInterfaces,
          inputs: [{ name: "intent", artifactType: "Quote" }],
        },
      }),
    ).not.toBe(same);
    // constraints do not participate in the contract key
    expect(
      bodyContractKey({ ...body, constraints: [] }),
    ).toBe(same);
  });
});

// Type-level guarantees (enforced by `tsc --noEmit`):

// AgentBody must NOT structurally contain model/soul/provider/prompt fields.
type _bodyHasNoModel = AgentBody extends { model?: unknown } ? true : false;
type _bodyHasNoSoul = AgentBody extends { soul?: unknown } ? true : false;
type _bodyHasNoProvider = AgentBody extends { provider?: unknown } ? true : false;
type _bodyHasNoPrompt = AgentBody extends { prompt?: unknown } ? true : false;
type _bodyHasNoWeights = AgentBody extends { weights?: unknown } ? true : false;
type _assert1 = Expect<Equal<_bodyHasNoModel, false>>;
type _assert2 = Expect<Equal<_bodyHasNoSoul, false>>;
type _assert3 = Expect<Equal<_bodyHasNoProvider, false>>;
type _assert4 = Expect<Equal<_bodyHasNoPrompt, false>>;
type _assert5 = Expect<Equal<_bodyHasNoWeights, false>>;

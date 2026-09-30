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

// ---------------------------------------------------------------------------
// W2-002 — possession: multiple models can possess one Body (INV-G01).
// ---------------------------------------------------------------------------

import {
  possess,
  possessorsOf,
  possessingBindings,
  isBodyContractCompatible,
} from "../src/index.js";
import type { ModelBinding } from "../src/index.js";

const anthropic: ModelBinding = {
  provider: "anthropic",
  modelId: "claude-sonnet",
  bindingVersion: 1,
};
const openai: ModelBinding = {
  provider: "openai",
  modelId: "gpt-5",
  bindingVersion: 2,
};
const local: ModelBinding = {
  provider: "self-hosted",
  modelId: "qwen-inhouse",
  bindingVersion: 1,
};

describe("possess — Body/ModelBinding possession (W2-002)", () => {
  it("creates an instance pinning the Body id+version under a model binding", () => {
    const instance = possess(body, anthropic, {
      instanceId: "inst-payer-a",
      principal: { agentKeyFingerprint: "key-a", ownerRef: "user:owner-1" },
    });
    expect(instance.bodyRef).toEqual({ id: "body:payer", version: 1 });
    expect(instance.modelBinding).toEqual(anthropic);
    expect(instance.runtimeState).toEqual({ status: "IDLE" });
    expect(isBodyContractCompatible(body, instance)).toBe(true);
  });

  it("two+ DISTINCT ModelBindings can possess ONE Body with identical contract compatibility", () => {
    const a = possess(body, anthropic, {
      instanceId: "inst-payer-a",
      principal: { agentKeyFingerprint: "key-a", ownerRef: "user:owner-1" },
    });
    const b = possess(body, openai, {
      instanceId: "inst-payer-b",
      principal: { agentKeyFingerprint: "key-b", ownerRef: "user:owner-2" },
    });
    const c = possess(body, local, {
      instanceId: "inst-payer-c",
      principal: { agentKeyFingerprint: "key-c", ownerRef: "user:owner-1" },
    });
    const possessors = possessorsOf(body, [a, b, c]);
    expect(possessors.map((instance) => instance.id)).toEqual([
      "inst-payer-a",
      "inst-payer-b",
      "inst-payer-c",
    ]);
    // three distinct bindings, one Body
    const bindings = possessingBindings(body, [a, b, c]);
    expect(bindings).toHaveLength(3);
    expect(bindings).toEqual([anthropic, openai, local]);
    // identical Body contract across possessors (INV-G01)
    for (const instance of possessors) {
      expect(isBodyContractCompatible(body, instance)).toBe(true);
    }
  });

  it("possession of a DIFFERENT Body version does not count (id+version pin)", () => {
    const a = possess(body, anthropic, {
      instanceId: "inst-payer-a",
      principal: { agentKeyFingerprint: "key-a", ownerRef: "user:owner-1" },
    });
    const otherVersion = possess(
      { ...body, version: 2 },
      openai,
      {
        instanceId: "inst-payer-v2",
        principal: { agentKeyFingerprint: "key-a", ownerRef: "user:owner-1" },
      },
    );
    expect(possessorsOf(body, [a, otherVersion])).toEqual([a]);
    expect(possessingBindings(body, [a, otherVersion])).toEqual([anthropic]);
  });

  it("deduplicates identical model bindings across possessors", () => {
    const a = possess(body, anthropic, {
      instanceId: "inst-payer-a",
      principal: { agentKeyFingerprint: "key-a", ownerRef: "user:owner-1" },
    });
    const b = possess(body, { ...anthropic }, {
      instanceId: "inst-payer-b",
      principal: { agentKeyFingerprint: "key-b", ownerRef: "user:owner-2" },
    });
    expect(possessorsOf(body, [a, b])).toHaveLength(2);
    expect(possessingBindings(body, [a, b])).toEqual([anthropic]);
  });

  it("rejects empty instanceId and empty principal fingerprint", () => {
    expect(() =>
      possess(body, anthropic, {
        instanceId: "",
        principal: { agentKeyFingerprint: "key-a", ownerRef: "user:owner-1" },
      }),
    ).toThrow(/instanceId/);
    expect(() =>
      possess(body, anthropic, {
        instanceId: "inst-x",
        principal: { agentKeyFingerprint: "", ownerRef: "user:owner-1" },
      }),
    ).toThrow(/agentKeyFingerprint/);
  });
});

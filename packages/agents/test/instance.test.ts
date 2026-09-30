import { describe, expect, it } from "vitest";
import {
  bodyContractKey,
  isBodyContractCompatible,
  rebindModel,
} from "../src/index.js";
import type { AgentBody, AgentInstance, ModelBinding } from "../src/index.js";

/**
 * INV-G01 at the instance level: the model binding is replaceable and never
 * changes Body-contract compatibility.
 */

const body: AgentBody = {
  id: "body:payer",
  version: 3,
  declaredInterfaces: {
    inputs: [{ name: "intent", artifactType: "Intent" }],
    outputs: [{ name: "proposal", artifactType: "Execution" }],
  },
  capabilityDescriptors: [{ name: "route-selection", summary: "Routing proposals" }],
  constraints: [{ kind: "behavioral", description: "Deterministic tie-breaking" }],
};

const openAiBinding: ModelBinding = {
  provider: "openai",
  modelId: "gpt-5.1",
  bindingVersion: 1,
};
const localBinding: ModelBinding = {
  provider: "self-hosted",
  modelId: "qwen-3.5-72b",
  bindingVersion: 2,
};

function makeInstance(modelBinding?: ModelBinding): AgentInstance {
  return {
    id: "instance-1",
    bodyRef: { id: body.id, version: body.version },
    principal: { agentKeyFingerprint: "agent-key-1", ownerRef: "user:owner-1" },
    ...(modelBinding !== undefined ? { modelBinding } : {}),
    runtimeState: { status: "IDLE" },
  };
}

describe("AgentInstance — model swap leaves the Body contract unchanged (INV-G01)", () => {
  it("keeps Body compatibility when the model binding is swapped", () => {
    const withOpenAi = makeInstance(openAiBinding);
    const withLocal = rebindModel(withOpenAi, localBinding);

    expect(isBodyContractCompatible(body, withOpenAi)).toBe(true);
    expect(isBodyContractCompatible(body, withLocal)).toBe(true);
    expect(withLocal.bodyRef).toEqual(withOpenAi.bodyRef);
    expect(withLocal.principal).toEqual(withOpenAi.principal);
    expect(withLocal.modelBinding?.provider).toBe("self-hosted");
  });

  it("keeps the Body contract key stable across model swaps", () => {
    const keyBefore = bodyContractKey(body);
    // the contract key is derived only from the Body, never from instances
    const withOpenAi = makeInstance(openAiBinding);
    const withLocal = rebindModel(withOpenAi, localBinding);
    const none = rebindModel(withLocal, undefined);
    expect(bodyContractKey(body)).toBe(keyBefore);
    expect(withOpenAi.bodyRef).toEqual(none.bodyRef);
    expect(none.modelBinding).toBeUndefined();
  });

  it("detects an actual Body contract change (different body version)", () => {
    const instance = makeInstance(openAiBinding);
    const bodyV4: AgentBody = { ...body, version: 4 };
    expect(isBodyContractCompatible(bodyV4, instance)).toBe(false);
  });
});

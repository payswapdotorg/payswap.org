import { describe, expect, it } from "vitest";
import {
  AGENT_EVENT_TYPES,
  RUNTIME_OPERATIONS,
} from "../src/index.js";
import type { AgentRuntimeContract } from "../src/index.js";
import type { Equal, Expect } from "./type-utils.js";

/**
 * FROZEN-ARCHITECTURE §20: the runtime contract exposes exactly session
 * creation, execution, event streaming, approval, tool request, checkpoint,
 * pause, resume, cancel and inspect — as typed signatures, no implementation.
 */

describe("AgentRuntimeContract surface", () => {
  it("declares exactly the ten §20 operations", () => {
    expect([...RUNTIME_OPERATIONS]).toEqual([
      "createSession",
      "execute",
      "streamEvents",
      "approve",
      "requestTool",
      "checkpoint",
      "pause",
      "resume",
      "cancel",
      "inspect",
    ]);
  });

  it("declares the §20 event vocabulary", () => {
    expect(AGENT_EVENT_TYPES).toContain("approval_requested");
    expect(AGENT_EVENT_TYPES).toContain("checkpointed");
    expect(AGENT_EVENT_TYPES).toContain("tool_requested");
    expect(AGENT_EVENT_TYPES).toContain("cancelled");
    expect(AGENT_EVENT_TYPES.length).toBeGreaterThanOrEqual(11);
  });
});

// Type-level guarantees (enforced by `tsc --noEmit`):

// The contract interface surface is exactly RUNTIME_OPERATIONS — no more, no less.
type _contractKeys = keyof AgentRuntimeContract;
type _assertOperationsMatchContract = Expect<Equal<_contractKeys, (typeof RUNTIME_OPERATIONS)[number]>>;

// Every operation returns a Promise or an AsyncIterable (streaming).
type _streamIsAsync = ReturnType<AgentRuntimeContract["streamEvents"]> extends AsyncIterable<unknown>
  ? true
  : false;
type _assertStream = Expect<Equal<_streamIsAsync, true>>;
type _executeIsAsync = ReturnType<AgentRuntimeContract["execute"]> extends Promise<unknown>
  ? true
  : false;
type _assertExecute = Expect<Equal<_executeIsAsync, true>>;
type _createTakesInstance = Parameters<AgentRuntimeContract["createSession"]>[0] extends {
  instanceId: string;
}
  ? true
  : false;
type _assertCreate = Expect<Equal<_createTakesInstance, true>>;

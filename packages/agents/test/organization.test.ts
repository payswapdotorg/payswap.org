import { describe, expect, it } from "vitest";
import {
  OrganizationValidationError,
  ReleasedOrganizationImmutableError,
  amendOrganization,
  contentDigest,
  isReleased,
  releaseOrganization,
} from "../src/index.js";
import type { OrganizationDraft } from "../src/index.js";
/**
 * INV-G02: released Organization versions are immutable. Releasing freezes a
 * content hash; mutation on a released version is rejected.
 */

const RELEASED_AT = 5_000_000;

function makeDraft(): OrganizationDraft {
  return {
    id: "org:payops-1",
    version: 1,
    bodies: [{ id: "body:payer", version: 2 }],
    instances: [
      {
        id: "instance-payer",
        bodyRef: { id: "body:payer", version: 2 },
        principal: { agentKeyFingerprint: "agent-key-1", ownerRef: "user:owner-1" },
        modelBinding: { provider: "openai", modelId: "gpt-5.1", bindingVersion: 1 },
        runtimeState: { status: "IDLE" },
      },
      {
        id: "instance-reviewer",
        bodyRef: { id: "body:payer", version: 2 },
        principal: { agentKeyFingerprint: "agent-key-2", ownerRef: "user:owner-1" },
        runtimeState: { status: "IDLE" },
      },
    ],
    communicationEdges: [
      { fromInstanceId: "instance-payer", toInstanceId: "instance-reviewer", channel: "a2a" },
    ],
    delegationEdges: [
      {
        fromInstanceId: "instance-payer",
        toInstanceId: "instance-reviewer",
        mandateRef: { mandateId: "mandate-1", version: 1 },
      },
    ],
    memory: { scope: "shared", retention: "session" },
    budgets: [{ budgetId: "budget-1", scope: "routing-proposals", amount: { currency: "EUR", minorUnits: "50000" } }],
    evaluators: [{ evaluationSuiteRef: "evalsuite:payops@1" }],
    termination: { conditions: ["budget-exhausted", "safety-violation"], requiresHumanApproval: true },
    safetyPolicy: { hardConstraints: ["no-unmandated-beneficiary-change"], escalationSurfaceRef: "surface:trusted-approval" },
  };
}

describe("releaseOrganization", () => {
  it("freezes a content hash and marks the version released", () => {
    const released = releaseOrganization(makeDraft(), RELEASED_AT);
    expect(isReleased(released)).toBe(true);
    expect(released.release.releasedAt).toBe(RELEASED_AT);
    expect(released.release.contentHash).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
    expect(isReleased(makeDraft())).toBe(false);
  });

  it("content hash is deterministic for identical drafts and differs for changed drafts", () => {
    const first = releaseOrganization(makeDraft(), RELEASED_AT);
    const second = releaseOrganization(makeDraft(), RELEASED_AT);
    expect(second.release.contentHash).toBe(first.release.contentHash);

    const changed = releaseOrganization(
      { ...makeDraft(), budgets: [{ budgetId: "budget-1", scope: "routing-proposals", amount: { currency: "EUR", minorUnits: "60000" } }] },
      RELEASED_AT,
    );
    expect(changed.release.contentHash).not.toBe(first.release.contentHash);
  });

  it("validates the graph before releasing", () => {
    const danglingEdge = {
      ...makeDraft(),
      communicationEdges: [
        { fromInstanceId: "instance-payer", toInstanceId: "instance-ghost", channel: "a2a" },
      ],
    };
    expect(() => releaseOrganization(danglingEdge, RELEASED_AT)).toThrow(OrganizationValidationError);

    const unknownBody: OrganizationDraft = {
      ...makeDraft(),
      instances: [
        {
          id: "instance-x",
          bodyRef: { id: "body:unknown", version: 1 },
          principal: { agentKeyFingerprint: "agent-key-9", ownerRef: "user:owner-1" },
          runtimeState: { status: "IDLE" },
        },
      ],
    };
    expect(() => releaseOrganization(unknownBody, RELEASED_AT)).toThrow(OrganizationValidationError);

    const base = makeDraft();
    const first = base.instances[0];
    if (first === undefined) {
      throw new Error("fixture error: expected first instance");
    }
    const duplicate = { ...base, instances: [...base.instances, first] };
    expect(() => releaseOrganization(duplicate, RELEASED_AT)).toThrow(OrganizationValidationError);
  });

  it("releasing an already-released organization is rejected (immutability)", () => {
    const released = releaseOrganization(makeDraft(), RELEASED_AT);
    expect(() => releaseOrganization(released, RELEASED_AT + 1)).toThrow(
      ReleasedOrganizationImmutableError,
    );
  });
});

describe("released organizations are immutable (INV-G02)", () => {
  it("amendOrganization on a released organization throws", () => {
    const released = releaseOrganization(makeDraft(), RELEASED_AT);
    expect(() =>
      amendOrganization(released, (draft) => ({ ...draft, version: 2 })),
    ).toThrow(ReleasedOrganizationImmutableError);
  });

  it("amendOrganization on a draft produces a new draft without mutating the source", () => {
    const draft = makeDraft();
    const amended = amendOrganization(draft, (d) => ({
      ...d,
      budgets: [{ budgetId: "budget-2", scope: "new", amount: { currency: "USD", minorUnits: "1" } }],
    }));
    expect(draft.budgets).toHaveLength(1);
    expect(amended.budgets).toHaveLength(1);
    expect(amended.budgets[0]?.budgetId).toBe("budget-2");
    expect(isReleased(amended)).toBe(false);
  });

  it("direct property mutation on a released organization throws (deep-frozen)", () => {
    const released = releaseOrganization(makeDraft(), RELEASED_AT);
    expect(() => {
      (released as { id: string }).id = "org:mutated";
    }).toThrow(TypeError);
    const budget = released.budgets[0];
    if (budget === undefined) {
      throw new Error("fixture error: expected budget");
    }
    expect(() => {
      (budget as { scope: string }).scope = "mutated";
    }).toThrow(TypeError);
    expect(released.id).toBe("org:payops-1");
  });

  it("releasing does not alias the draft: later draft changes cannot rewrite history", () => {
    const draft = makeDraft();
    const released = releaseOrganization(draft, RELEASED_AT);
    const mutatedDraft = amendOrganization(draft, (d) => ({ ...d, version: 99 }));
    expect(released.version).toBe(1);
    expect(mutatedDraft.version).toBe(99);
    expect(contentDigest(mutatedDraft)).not.toBe(released.release.contentHash);
  });
});

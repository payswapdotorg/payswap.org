import { describe, expect, it } from "vitest";
import { EpochLedger, issueGrant } from "@payswap/trust";
import type { EpochState, Mandate, PermissionGrant, Principal } from "@payswap/trust";
import {
  OrganizationExecutionError,
  executeOrganizationCommand,
  releaseOrganization,
} from "../src/index.js";
import type {
  OrganizationCommandRequest,
  OrganizationDraft,
  OrganizationExecutionTrace,
  ReleasedOrganization,
} from "../src/index.js";

/**
 * W2-002 — organization graph execution: deterministic scheduler over a
 * RELEASED version (INV-G02), trust evaluate() before EVERY node acts (no
 * bypass), delegation authority minted through attenuate() ONLY (INV-A01).
 */

const NOW = 5_000_000;
const RELEASED_AT = 4_000_000;

function payerPrincipal(): Principal {
  return {
    kind: "agent",
    agentKeyFingerprint: "agent-key-1",
    ownerRef: "user:owner-1",
    bodyRef: "body:payer@2",
    packageVersionRef: "pkg:payer@1",
    authorityEnvelope: [{ mandateId: "mandate-1", version: 1 }],
    securityEpoch: 0n,
  };
}

function reviewerPrincipal(): Principal {
  return {
    kind: "agent",
    agentKeyFingerprint: "agent-key-2",
    ownerRef: "user:owner-1",
    bodyRef: "body:payer@2",
    packageVersionRef: "pkg:payer@1",
    authorityEnvelope: [],
    securityEpoch: 0n,
  };
}

function payerMandate(): Mandate {
  return {
    id: "mandate-1",
    version: 1,
    grantor: "user:owner-1",
    grantee: "agent:agent-key-1",
    actions: ["payments.*"],
    resources: [{ type: "payment_intent" }],
    expiresAt: NOW + 86_400_000,
    proofRequirements: [],
  };
}

function payerGrant(): PermissionGrant {
  return issueGrant(payerMandate(), { grantId: "grant-payer", issuedAt: NOW - 1000 });
}

function withEpoch(p: Principal, securityEpoch: bigint): Principal {
  if (p.kind === "agent" || p.kind === "user") {
    return { ...p, securityEpoch };
  }
  return p;
}

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
    budgets: [
      { budgetId: "budget-1", scope: "routing-proposals", amount: { currency: "EUR", minorUnits: "50000" } },
    ],
    evaluators: [{ evaluationSuiteRef: "evalsuite:payops@1" }],
    termination: { conditions: ["budget-exhausted"], requiresHumanApproval: true },
    safetyPolicy: {
      hardConstraints: ["no-unmandated-beneficiary-change"],
      escalationSurfaceRef: "surface:trusted-approval",
    },
  };
}

function command(overrides: Partial<OrganizationCommandRequest> = {}): OrganizationCommandRequest {
  return {
    initiatingInstanceId: "instance-payer",
    action: "payments.initiate",
    resource: { type: "payment_intent", resourceId: "pi-1" },
    context: { amount: { currency: "EUR", minorUnits: "10000" } },
    requestHash: "reqhash-1",
    requestedAt: NOW,
    ...overrides,
  };
}

function principals(): Map<string, Principal> {
  return new Map<string, Principal>([
    ["instance-payer", payerPrincipal()],
    ["instance-reviewer", reviewerPrincipal()],
  ]);
}

function state(overrides: Partial<EpochState> = {}): EpochState {
  return { ledger: new EpochLedger(), ...overrides };
}

function run(
  overrides: {
    organization?: OrganizationDraft | ReleasedOrganization;
    grants?: readonly PermissionGrant[];
    epochState?: EpochState;
    principals?: ReadonlyMap<string, Principal>;
    request?: Partial<OrganizationCommandRequest>;
  } = {},
): OrganizationExecutionTrace {
  return executeOrganizationCommand({
    organization: overrides.organization ?? releaseOrganization(makeDraft(), RELEASED_AT),
    request: command(overrides.request ?? {}),
    grants: overrides.grants ?? [payerGrant()],
    epochState: overrides.epochState ?? state(),
    principals: overrides.principals ?? principals(),
  });
}

describe("executeOrganizationCommand — fail-closed validation", () => {
  it("refuses to execute a DRAFT (unreleased) organization (INV-G02)", () => {
    expect(() => run({ organization: makeDraft() })).toThrow(OrganizationExecutionError);
    expect(() => run({ organization: makeDraft() })).toThrow(/RELEASED/);
  });

  it("refuses unknown initiating instances and empty request fields", () => {
    expect(() => run({ request: { initiatingInstanceId: "instance-ghost" } })).toThrow(
      /not part of organization/,
    );
    expect(() => run({ request: { action: "" } })).toThrow(/action/);
    expect(() => run({ request: { requestHash: "" } })).toThrow(/requestHash/);
  });

  it("refuses unresolvable participant principals — never best-effort", () => {
    expect(() => run({ principals: new Map() })).toThrow(
      /no trust principal resolved for participating instance 'instance-payer'/,
    );
    const partial = new Map<string, Principal>([["instance-payer", payerPrincipal()]]);
    expect(() => run({ principals: partial })).toThrow(
      /no trust principal resolved for participating instance 'instance-reviewer'/,
    );
  });
});

describe("executeOrganizationCommand — no node bypasses authority", () => {
  it("every participant passes through trust evaluate(); an unauthorized node is DENIED and recorded", () => {
    const trace = run({ grants: [] });
    expect(trace.relayOrder).toEqual(["instance-payer", "instance-reviewer"]);
    expect(trace.steps).toHaveLength(2);
    for (const step of trace.steps) {
      expect(step.decision.decision).toBe("DENY");
      if (step.decision.decision === "DENY") {
        expect(step.decision.reason).toBe("no_matching_grant");
      }
    }
    expect(trace.delegations).toHaveLength(0);
  });

  it("an initiator with a live grant acts (ALLOW); a stale epoch denies it (INV-A02)", () => {
    const allowed = run();
    const initiator = allowed.steps.find((step) => step.instanceId === "instance-payer");
    expect(initiator?.decision.decision).toBe("ALLOW");

    const ledger = new EpochLedger();
    ledger.raiseEpoch("agent:agent-key-1", "key rotated", NOW + 1);
    const raisedReviewer: Principal = withEpoch(reviewerPrincipal(), 1n);
    const stale = run({
      epochState: { ledger },
      principals: new Map<string, Principal>([
        ["instance-payer", payerPrincipal()], // stale credential (epoch 0 < 1)
        ["instance-reviewer", raisedReviewer],
      ]),
    });
    const staleStep = stale.steps.find((step) => step.instanceId === "instance-payer");
    expect(staleStep?.decision.decision).toBe("DENY");
    if (staleStep?.decision.decision === "DENY") {
      expect(staleStep.decision.reason).toBe("stale_security_epoch");
    }
    // the raised-credential run still allows the initiator
    const raisedPayer: Principal = withEpoch(payerPrincipal(), 1n);
    const fresh = run({
      epochState: { ledger },
      principals: new Map<string, Principal>([
        ["instance-payer", raisedPayer],
        ["instance-reviewer", raisedReviewer],
      ]),
    });
    const freshStep = fresh.steps.find((step) => step.instanceId === "instance-payer");
    expect(freshStep?.decision.decision).toBe("ALLOW");
  });
});

describe("executeOrganizationCommand — delegation via attenuate() ONLY (INV-A01)", () => {
  it("mints a strictly-narrower child grant and the delegate acts under it", () => {
    const trace = run();
    expect(trace.delegations).toHaveLength(1);
    const delegation = trace.delegations[0];
    if (delegation === undefined) {
      throw new Error("fixture setup: expected one delegation record");
    }
    expect(delegation.fromInstanceId).toBe("instance-payer");
    expect(delegation.toInstanceId).toBe("instance-reviewer");
    const result = delegation.result;
    if (result.outcome === "DELEGATED") {
      expect(result.childGrantId).toBe("delegated:org:payops-1@1:2");
      const child = trace.grantPool.find((g) => g.grantId === result.childGrantId);
      expect(child).toBeDefined();
      if (child !== undefined) {
        // child authority is attenuated: exactly this action/resource, never wider
        expect(child.mandate.actions).toEqual(["payments.initiate"]);
        expect(child.mandate.resources).toEqual([{ type: "payment_intent", resourceId: "pi-1" }]);
        expect(child.mandate.grantee).toBe("agent:agent-key-2");
        expect(child.mandate.parentMandate).toEqual({ mandateId: "mandate-1", version: 1 });
        // full grant lineage back to the root
        expect(child.lineage).toEqual({ rootGrantId: "grant-payer", chain: ["grant-payer"] });
      }
    } else {
      expect.unreachable("expected the delegation to be minted");
    }
    const delegateStep = trace.steps.find((step) => step.instanceId === "instance-reviewer");
    expect(delegateStep?.decision.decision).toBe("ALLOW");
    expect(delegateStep?.actingUnderDelegationFrom).toBe("instance-payer");
  });

  it("rejects a delegation edge whose mandate no grant in the pool carries", () => {
    const draft: OrganizationDraft = {
      ...makeDraft(),
      delegationEdges: [
        {
          fromInstanceId: "instance-payer",
          toInstanceId: "instance-reviewer",
          mandateRef: { mandateId: "mandate-ghost", version: 1 },
        },
      ],
    };
    const trace = run({
      organization: releaseOrganization(draft, RELEASED_AT),
      grants: [payerGrant()],
    });
    const delegation = trace.delegations[0];
    expect(delegation?.result.outcome).toBe("REJECTED");
    if (delegation?.result.outcome === "REJECTED") {
      expect(delegation.result.reason).toMatch(/no grant in the pool carries mandate mandate-ghost/);
    }
    // the delegate never received authority: its step is denied
    const delegateStep = trace.steps.find((step) => step.instanceId === "instance-reviewer");
    expect(delegateStep?.decision.decision).toBe("DENY");
    expect(trace.grantPool).toHaveLength(1);
  });

  it("rejects a delegation whose mandate is held by someone other than the source", () => {
    const heldByOther: Mandate = { ...payerMandate(), grantee: "agent:agent-key-9" };
    const draft: OrganizationDraft = {
      ...makeDraft(),
      delegationEdges: [
        {
          fromInstanceId: "instance-payer",
          toInstanceId: "instance-reviewer",
          mandateRef: { mandateId: "mandate-other", version: 1 },
        },
      ],
    };
    const trace = run({
      organization: releaseOrganization(draft, RELEASED_AT),
      grants: [
        payerGrant(),
        issueGrant({ ...heldByOther, id: "mandate-other" }, { grantId: "grant-other", issuedAt: NOW - 1 }),
      ],
    });
    const delegation = trace.delegations[0];
    expect(delegation?.result.outcome).toBe("REJECTED");
    if (delegation?.result.outcome === "REJECTED") {
      expect(delegation.result.reason).toMatch(/cannot delegate authority it does not hold/);
    }
  });

  it("a delegation edge whose source was never authorized never fires", () => {
    // no grants at all: the payer cannot act, so its delegation edge cannot fire
    const trace = run({ grants: [] });
    expect(trace.delegations).toHaveLength(0);
    expect(trace.steps.every((step) => step.decision.decision === "DENY")).toBe(true);
  });

  it("authority never flows to instances unreachable over communication edges", () => {
    const draft: OrganizationDraft = { ...makeDraft(), communicationEdges: [] };
    const trace = run({ organization: releaseOrganization(draft, RELEASED_AT) });
    expect(trace.relayOrder).toEqual(["instance-payer"]);
    expect(trace.steps).toHaveLength(1);
    expect(trace.delegations).toHaveLength(0);
  });
});

describe("executeOrganizationCommand — determinism", () => {
  it("identical inputs produce byte-identical traces", () => {
    const one = run();
    const two = run();
    expect(JSON.stringify(one)).toBe(JSON.stringify(two));
    expect(one.contentHash).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
    expect(one.organizationId).toBe("org:payops-1");
    expect(one.organizationVersion).toBe(1);
  });
});

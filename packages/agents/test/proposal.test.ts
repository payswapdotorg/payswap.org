import { describe, expect, it } from "vitest";
import {
  ProtocolCommandShapeError,
  assertNotProtocolCommand,
  makeProposal,
} from "../src/index.js";
import type { AgentProposal } from "../src/index.js";
import type { Equal, Expect } from "./type-utils.js";

/**
 * INV-G03: agent proposals do not mutate financial truth. They are advisory
 * inputs, structurally distinct from protocol commands: no idempotency key,
 * no authority fields, no signatures.
 */

describe("assertNotProtocolCommand (INV-G03 guard)", () => {
  it("accepts plain advisory payloads", () => {
    expect(() =>
      assertNotProtocolCommand({
        suggestion: "route via SEPA to cut cost by 12 bps",
        confidence: "medium",
      }),
    ).not.toThrow();
  });

  it("rejects a value carrying an idempotency key at the top level", () => {
    expect(() =>
      assertNotProtocolCommand({ action: "settle", idempotencyKey: "idem-1" }),
    ).toThrow(ProtocolCommandShapeError);
  });

  it("rejects authority-shaped values", () => {
    expect(() => assertNotProtocolCommand({ authorization: "Bearer x" })).toThrow(
      ProtocolCommandShapeError,
    );
    expect(() =>
      assertNotProtocolCommand({ mandateRef: { mandateId: "m-1", version: 1 } }),
    ).toThrow(ProtocolCommandShapeError);
    expect(() => assertNotProtocolCommand({ signature: "sig" })).toThrow(
      ProtocolCommandShapeError,
    );
  });

  it("rejects command shape nested at any depth, including arrays", () => {
    expect(() =>
      assertNotProtocolCommand({
        plan: {
          steps: [{ name: "pay", payload: { idempotencyKey: "idem-2" } }],
        },
      }),
    ).toThrow(/plan\.steps\.0\.payload/);
  });

  it("handles cycles without looping forever", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic["self"] = cyclic;
    expect(() => assertNotProtocolCommand(cyclic)).not.toThrow();
    cyclic["idempotencyKey"] = "idem-3";
    expect(() => assertNotProtocolCommand(cyclic)).toThrow(ProtocolCommandShapeError);
  });
});

describe("makeProposal", () => {
  it("accepts and returns a well-formed advisory proposal", () => {
    const proposal = makeProposal({
      proposalId: "proposal-1",
      proposingInstance: "instance-payer",
      proposalType: "money_movement",
      payload: { route: "sepa", rationale: "cheapest" },
      rationale: "Cheapest available rail for this corridor",
      evidenceRefs: ["quote:q-1", "capability:sepa@2"],
      expiresAt: 9_999_999,
    });
    expect(proposal.proposalId).toBe("proposal-1");
    expect(() => assertNotProtocolCommand(proposal)).not.toThrow();
  });

  it("rejects a proposal whose payload hides protocol-command shape", () => {
    expect(() =>
      makeProposal({
        proposalId: "proposal-2",
        proposingInstance: "instance-payer",
        proposalType: "money_movement",
        payload: { commandType: "Settle", idempotencyKey: "idem-4" },
        evidenceRefs: [],
        expiresAt: 9_999_999,
      }),
    ).toThrow(ProtocolCommandShapeError);
  });
});

// Type-level guarantees (enforced by `tsc --noEmit`):

// AgentProposal must NOT structurally contain idempotency/authority/signature fields.
type _noIdempotencyKey = AgentProposal extends { idempotencyKey?: unknown } ? true : false;
type _noAuthorization = AgentProposal extends { authorization?: unknown } ? true : false;
type _noSignature = AgentProposal extends { signature?: unknown } ? true : false;
type _noAuthorityEnvelope = AgentProposal extends { authorityEnvelope?: unknown } ? true : false;
type _assert1 = Expect<Equal<_noIdempotencyKey, false>>;
type _assert2 = Expect<Equal<_noAuthorization, false>>;
type _assert3 = Expect<Equal<_noSignature, false>>;
type _assert4 = Expect<Equal<_noAuthorityEnvelope, false>>;

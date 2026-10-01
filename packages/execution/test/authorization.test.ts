import { describe, expect, it } from "vitest";
import { asCommandId } from "@payswap/protocol";
import type { CommandEnvelope } from "@payswap/protocol";
import {
  ExecutionAuthorizationError,
  ExecutionGrantAuthority,
  validateAdapterExecutionAuthority,
} from "../src/authorization.js";
import type {
  AdapterExecutionAuthority,
  ExecutionGrantVerification,
  FinancialProtocolWriteAuthority,
  GrantApprovalArtifact,
} from "../src/authorization.js";
import type { Equal, Expect } from "./type-utils.js";
import { AGENT, NOW, PRINCIPAL } from "./fixtures.js";

const COMMAND: CommandEnvelope<unknown> = {
  id: asCommandId("cmd_1"),
  commandType: "execution.executePlan",
  payload: { planId: "plan_1" },
  principalRef: PRINCIPAL,
  idempotencyKey: "idem-1",
  issuedAt: NOW,
  schemaVersion: 1,
};

const SCOPE = {
  capabilityInstanceIds: ["inst-mm-1"],
  executionModes: ["COMPOSED_PAYSWAP" as const],
};

function authority(): ExecutionGrantAuthority {
  return new ExecutionGrantAuthority();
}

describe("Scoped execution grants (W3-003)", () => {
  it("issues a grant against a protocol command with authorization evidence (INV-E01)", () => {
    const grants = authority();
    const grant = grants.issue({
      grantId: "grant_1",
      command: COMMAND,
      scope: SCOPE,
      requestHash: "req_hash_1",
      expiresAt: NOW + 60_000n,
      authorizationEvidenceRef: "evidence:auth-1",
    });
    expect(grant.principal.principalId).toBe("user_1");
    expect(grant.authorizationEvidenceRef).toBe("evidence:auth-1");
    const verification = grants.verify("grant_1", { now: NOW + 1n, requestHash: "req_hash_1" });
    expect(verification.ok).toBe(true);
  });

  it("fails closed: unknown, expired, unbound and out-of-scope grants never vouch", () => {
    const grants = authority();
    grants.issue({
      grantId: "grant_1",
      command: COMMAND,
      scope: SCOPE,
      requestHash: "req_hash_1",
      expiresAt: NOW + 60_000n,
      authorizationEvidenceRef: "evidence:auth-1",
    });

    const reasonOf = (verification: ExecutionGrantVerification): string =>
      verification.ok ? "OK" : verification.reason;

    expect(reasonOf(grants.verify("missing", { now: NOW }))).toBe("UNKNOWN_GRANT");
    expect(reasonOf(grants.verify("grant_1", { now: NOW + 61_000n }))).toBe("EXPIRED");
    expect(reasonOf(grants.verify("grant_1", { now: NOW + 1n, requestHash: "other" }))).toBe(
      "REQUEST_HASH_MISMATCH",
    );
    expect(
      reasonOf(grants.verify("grant_1", { now: NOW + 1n, capabilityInstanceId: "inst-other" })),
    ).toBe("INSTANCE_NOT_IN_SCOPE");
    expect(
      reasonOf(grants.verify("grant_1", { now: NOW + 1n, executionMode: "PASS_THROUGH_NATIVE" })),
    ).toBe("MODE_NOT_IN_SCOPE");
  });

  it("INV-A03: approval artifacts identify principal, agent, scope, expiry and request hash", () => {
    const grants = authority();
    const artifact: GrantApprovalArtifact = {
      artifactId: "approval_1" as GrantApprovalArtifact["artifactId"],
      principal: PRINCIPAL,
      agent: AGENT,
      scope: SCOPE,
      expiresAt: NOW + 120_000n,
      requestHash: "req_hash_1",
      signatureRef: "signature:1",
    };
    const grant = grants.issue({
      grantId: "grant_2",
      command: { ...COMMAND, principalRef: AGENT },
      scope: SCOPE,
      requestHash: "req_hash_1",
      expiresAt: NOW + 60_000n,
      authorizationEvidenceRef: "evidence:auth-1",
      approvalArtifact: artifact,
    });
    expect(grant.approvalArtifact?.agent.principalId).toBe("agent_1");
    expect(grant.approvalArtifact?.requestHash).toBe("req_hash_1");

    // A grant that outlives its approval is rejected.
    expect(() =>
      grants.issue({
        grantId: "grant_3",
        command: COMMAND,
        scope: SCOPE,
        requestHash: "req_hash_1",
        expiresAt: NOW + 300_000n,
        authorizationEvidenceRef: "evidence:auth-1",
        approvalArtifact: artifact,
      }),
    ).toThrow(ExecutionAuthorizationError);

    // A request-hash mismatch between artifact and grant is rejected.
    expect(() =>
      grants.issue({
        grantId: "grant_4",
        command: COMMAND,
        scope: SCOPE,
        requestHash: "req_hash_DIFFERENT",
        expiresAt: NOW + 60_000n,
        authorizationEvidenceRef: "evidence:auth-1",
        approvalArtifact: artifact,
      }),
    ).toThrow(/not bound to what was approved/);
  });

  it("INV-C04/INV-F06: adapters NEVER receive financial write authority", () => {
    const grants = authority();
    grants.issue({
      grantId: "grant_adapter",
      command: COMMAND,
      scope: SCOPE,
      requestHash: "req_hash_1",
      expiresAt: NOW + 60_000n,
      authorizationEvidenceRef: "evidence:auth-1",
    });
    const adapterAuthority = grants.attenuateForAdapter("grant_adapter", NOW + 1n);
    expect(adapterAuthority.authorityKind).toBe("ADAPTER_EXECUTION_ONLY");
    expect(adapterAuthority.canWriteFinancialState).toBe(false);

    // TYPE-LEVEL: the adapter authority is not assignable to the financial
    // write authority marker — `canWriteFinancialState: false` blocks it.
    type NotFinancial = Expect<
      Equal<AdapterExecutionAuthority["canWriteFinancialState"], false>
    >;
    type AssertNotAssignable = Expect<
      Equal<AdapterExecutionAuthority extends FinancialProtocolWriteAuthority ? true : false, false>
    >;
    void ({} as NotFinancial | AssertNotAssignable | void);

    // RUNTIME: an adapter authority claiming financial write is rejected.
    expect(() =>
      validateAdapterExecutionAuthority({
        authorityKind: "ADAPTER_EXECUTION_ONLY",
        canWriteFinancialState: true,
        grant: adapterAuthority.grant,
      }),
    ).toThrow(ExecutionAuthorizationError);
    expect(() => grants.attenuateForAdapter("missing", NOW)).toThrow(ExecutionAuthorizationError);
  });
});

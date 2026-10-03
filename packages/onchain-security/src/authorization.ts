/**
 * @payswap/onchain-security — onchain authorization (Work Order P4-W1-002;
 * AGENTS.md rule 10; INV-A03, INV-A02, INV-S02, INV-E01).
 *
 * EXTENDS the @payswap/trust signed-authorization artifact model — it does
 * not replace it: `OnchainApprovalScope` narrows trust's `ApprovalScope`
 * with the full onchain binding set (chain, asset, amount, destination,
 * spender/approval changes, route, protocol identity, expected-state diff,
 * settlement instruction), and `OnchainAuthorizationArtifact` narrows
 * trust's `SignedApprovalArtifact`. Trust's `verifyApprovalArtifact`
 * (signature presence, expiry, request-hash binding, principal/agent
 * binding, action/resource/amount scope) is composed verbatim as the first
 * verification stage; the onchain bindings are verified on top.
 *
 * Rule 10: user approval is a trusted-surface operation creating a signed
 * authorization artifact; a chat message is not authority. The ONLY
 * construction path is `TrustedApprovalSurface.approve()`:
 *
 * - it re-verifies the request's content hash;
 * - it RE-RUNS the deterministic gates with the current policy and
 *   security state and refuses to mint anything unless they currently say
 *   ALLOW (a BLOCK or UNKNOWN can never be approved into authority, and a
 *   passing simulation alone can never mint an artifact —
 *   simulation-never-authority is enforced here by construction);
 * - the approving principal must differ from the requesting principal (an
 *   agent can never approve its own request);
 * - the signature comes from a `TrustedSurfaceSigner` port implemented at
 *   the trusted surface (UI/wallet) — never in agent context.
 */

import type {
  ApprovalScope,
  Principal,
  ResourceRef,
  SignedApprovalArtifact,
} from "@payswap/trust";
import type { AuthorizationRequest } from "@payswap/trust";
import { approvalSigningPayload, compareAmounts, principalRef } from "@payswap/trust";
import { assertNoSecretMaterial } from "./secrets.js";
import { contentDigest } from "./digest.js";
import type { ExpectedStateDiff } from "./diff.js";
import type { GateDecision } from "./gates.js";
import { evaluateOnchainWriteGates } from "./gates.js";
import type { OnchainSecurityPolicy, OnchainSecurityState } from "./gates.js";
import type { PreparedWrite } from "./write-intent.js";
import type {
  ApprovalChangeRequest,
  AssetIdentity,
  ChainRef,
  ProtocolIdentity,
  SettlementInstructionBinding,
} from "./types.js";
import { sameAsset, sameProtocol } from "./types.js";
import type { SigningDelegation, SigningDelegationRegistry } from "./delegation.js";
import { delegationCoversWrite } from "./delegation.js";

/** Raised on invalid authorization construction/verification input (fail closed). */
export class InvalidAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAuthorizationError";
  }
}

/**
 * The onchain narrowing of trust's ApprovalScope: everything a user
 * approves is bound here. The pre-authorization evaluation dimensions
 * (chain, asset, amount, destination, spender/approval changes, expiry,
 * route, protocol/contract identity) are ALL pinned on the scope.
 */
export interface OnchainApprovalScope extends ApprovalScope {
  readonly chain: ChainRef;
  readonly asset: AssetIdentity;
  readonly amount: { readonly currency: string; readonly minorUnits: string };
  readonly destination?: string;
  readonly approvals: readonly ApprovalChangeRequest[];
  readonly routeHash: string;
  readonly protocol?: ProtocolIdentity;
  readonly expectedStateDiffDigest: string;
  readonly writeDigest: string;
  readonly settlementInstruction?: SettlementInstructionBinding;
  readonly expiry: number;
}

/**
 * A signed onchain authorization artifact (INV-A03): identifies principal,
 * agent, scope (onchain-narrowed), expiry and request hash, plus the
 * trusted surface that minted it and the network epoch at issuance
 * (INV-S02 binding — an epoch advance voids it at verification).
 */
export interface OnchainAuthorizationArtifact extends SignedApprovalArtifact {
  readonly scope: OnchainApprovalScope;
  /** The trusted approval surface that minted this artifact. */
  readonly surfaceRef: string;
  /** Network SecurityEpoch at issuance (INV-S02). */
  readonly networkEpochAtIssuance: bigint;
  /** The signing delegation (session key / smart account) executing this, if any. */
  readonly delegationId?: string;
}

/**
 * The agent-facing authorization request: exactly what the trusted surface
 * shows the user — the prepared write, the readable expected-state diff and
 * the deterministic gate outcome. Content-addressed by `requestHash`.
 */
export interface OnchainAuthorizationRequest {
  readonly requestId: string;
  /** The principal requesting execution (usually the agent). */
  readonly principal: Principal;
  readonly write: PreparedWrite;
  readonly expectedDiff: ExpectedStateDiff;
  readonly gateDecision: GateDecision;
  readonly requestHash: string;
  readonly requestedAt: number;
}

/** Canonical request hash binding write + diff + decision + principal. */
export function onchainRequestHash(input: {
  readonly requestId: string;
  readonly requestedAt: number;
  readonly writeDigest: string;
  readonly diffDigest: string;
  readonly gateDecision: GateDecision;
  readonly requestingPrincipalRef: string;
}): string {
  return contentDigest({
    requestId: input.requestId,
    requestedAt: input.requestedAt,
    writeDigest: input.writeDigest,
    diffDigest: input.diffDigest,
    gateDecision: input.gateDecision,
    requestingPrincipalRef: input.requestingPrincipalRef,
  });
}

/** Build (validate + secret-scan + hash) an agent-facing authorization request. */
export function buildAuthorizationRequest(input: {
  readonly requestId: string;
  readonly principal: Principal;
  readonly write: PreparedWrite;
  readonly expectedDiff: ExpectedStateDiff;
  readonly gateDecision: GateDecision;
  readonly requestedAt: number;
}): OnchainAuthorizationRequest {
  if (input.requestId.length === 0) {
    throw new InvalidAuthorizationError("requestId must be a non-empty string");
  }
  if (!Number.isInteger(input.requestedAt) || input.requestedAt < 0) {
    throw new InvalidAuthorizationError("requestedAt must be a non-negative integer (ms)");
  }
  if (input.expectedDiff.diffDigest === undefined || input.expectedDiff.diffDigest.length === 0) {
    throw new InvalidAuthorizationError("expectedDiff must be content-addressed");
  }
  const request: OnchainAuthorizationRequest = Object.freeze({
    requestId: input.requestId,
    principal: input.principal,
    write: input.write,
    expectedDiff: input.expectedDiff,
    gateDecision: input.gateDecision,
    requestHash: onchainRequestHash({
      requestId: input.requestId,
      requestedAt: input.requestedAt,
      writeDigest: input.write.writeDigest,
      diffDigest: input.expectedDiff.diffDigest,
      gateDecision: input.gateDecision,
      requestingPrincipalRef: principalRef(input.principal),
    }),
    requestedAt: input.requestedAt,
  });
  assertNoSecretMaterial(request, "onchain authorization request");
  return request;
}

/** Adapt an onchain request to the trust-plane AuthorizationRequest shape. */
export function asTrustAuthorizationRequest(request: OnchainAuthorizationRequest): AuthorizationRequest {
  const write = request.write;
  const resource: ResourceRef = { type: "onchain_write", resourceId: write.writeId };
  return {
    principal: request.principal,
    action: write.action,
    resource,
    context: {
      ...(write.transfer !== undefined ? { amount: write.transfer.amount } : {}),
      rail: write.chain,
      ...(write.transfer !== undefined ? { beneficiary: write.transfer.to } : {}),
    },
    requestHash: request.requestHash,
    requestedAt: request.requestedAt,
  };
}

// ---------------------------------------------------------------------------
// The trusted approval surface (rule 10 — the ONLY minting path)
// ---------------------------------------------------------------------------

/**
 * Signer port implemented at the trusted surface (UI/wallet integration).
 * It signs the canonical approval payload for one request and returns an
 * opaque signature. It NEVER runs in agent context, and its inputs/outputs
 * are secret-scanned by the surface.
 */
export interface TrustedSurfaceSigner {
  readonly surfaceId: string;
  signApprovalPayload(payload: string, request: OnchainAuthorizationRequest): string;
}

/**
 * The trusted approval surface: the ONLY constructor of
 * OnchainAuthorizationArtifact. approve() fails closed unless:
 * - the request hash verifies (no tampering);
 * - the deterministic gates CURRENTLY return ALLOW for this write under the
 *   supplied policy and security state (BLOCK/UNKNOWN cannot be approved
 *   into authority; simulation alone can never mint);
 * - the approver is not the requesting principal (no self-approval);
 * - the approval expires strictly after issuance and within the write's
 *   expiry;
 * - the signer produces a non-empty opaque signature.
 */
export class TrustedApprovalSurface {
  readonly #signer: TrustedSurfaceSigner;
  readonly #minted: string[] = [];

  constructor(signer: TrustedSurfaceSigner) {
    if (signer.surfaceId.length === 0) {
      throw new InvalidAuthorizationError("trusted surface signer requires a surfaceId");
    }
    this.#signer = signer;
  }

  get surfaceId(): string {
    return this.#signer.surfaceId;
  }

  /** Append-only list of minted artifact request-hashes (provenance). */
  mintedArtifacts(): readonly string[] {
    return [...this.#minted];
  }

  /** Did this surface mint the artifact bound to this request hash? */
  minted(requestHash: string): boolean {
    return this.#minted.includes(requestHash);
  }

  approve(input: {
    readonly request: OnchainAuthorizationRequest;
    readonly policy: OnchainSecurityPolicy;
    readonly securityState: OnchainSecurityState;
    readonly approverRef: string;
    readonly expiresAt: number;
    readonly at: number;
    readonly agentRef?: string;
    readonly delegationId?: string;
  }): OnchainAuthorizationArtifact {
    const { request, policy, securityState, at } = input;
    assertNoSecretMaterial(input, "trusted-surface approval input");

    // Request integrity: the hash must bind the exact content presented.
    const recomputed = onchainRequestHash({
      requestId: request.requestId,
      requestedAt: request.requestedAt,
      writeDigest: request.write.writeDigest,
      diffDigest: request.expectedDiff.diffDigest,
      gateDecision: request.gateDecision,
      requestingPrincipalRef: principalRef(request.principal),
    });
    if (recomputed !== request.requestHash) {
      throw new InvalidAuthorizationError(
        `request hash mismatch: '${request.requestHash}' does not bind the presented content (tamper defense)`,
      );
    }

    // The user must see the gate outcome the pipeline actually produced.
    const current = evaluateOnchainWriteGates({
      write: request.write,
      policy,
      securityState,
      at,
    });
    if (current.decision !== request.gateDecision.decision) {
      throw new InvalidAuthorizationError(
        `gate decision drift: the request carries '${request.gateDecision.decision}' but the deterministic gates currently say '${current.decision}'`,
      );
    }
    if (current.decision !== "ALLOW") {
      // A BLOCK can never be approved into authority; an UNKNOWN requires
      // new evidence, never approval. This is the simulation-never-authority
      // and block-never-bypassed enforcement point.
      throw new InvalidAuthorizationError(
        `the trusted surface refuses to mint an authorization for a '${current.decision}' gate decision`,
      );
    }

    // Rule 10: the approver is the USER — an agent never approves itself.
    if (input.approverRef === principalRef(request.principal)) {
      throw new InvalidAuthorizationError(
        `approver '${input.approverRef}' is the requesting principal: an agent can never approve its own request`,
      );
    }
    if (input.approverRef.length === 0) {
      throw new InvalidAuthorizationError("approverRef must be a non-empty principal ref");
    }
    if (input.expiresAt <= at) {
      throw new InvalidAuthorizationError("approval must expire strictly after issuance");
    }
    if (input.expiresAt > request.write.expiry) {
      throw new InvalidAuthorizationError(
        "approval expiry must not outlive the write expiry (attenuation of validity)",
      );
    }
    if (request.write.expiry <= at) {
      throw new InvalidAuthorizationError("the underlying write is already expired");
    }

    const write = request.write;
    const scope: OnchainApprovalScope = Object.freeze({
      actions: [write.action],
      resources: Object.freeze([{ type: "onchain_write", resourceId: write.writeId }]),
      ...(write.transfer !== undefined
        ? { maxAmount: { currency: write.transfer.amount.currency, minorUnits: write.transfer.amount.minorUnits } }
        : {}),
      chain: write.chain,
      asset: write.transfer?.asset ?? write.approvals[0]?.asset ?? { chain: write.chain, assetId: "none", symbol: "NUL" },
      amount:
        write.transfer?.amount ??
        write.approvals[0]?.amount ??
        write.contractCall?.value ??
        { currency: "NUL", minorUnits: "0" },
      ...(write.transfer !== undefined ? { destination: write.transfer.to } : {}),
      approvals: write.approvals,
      routeHash: write.route.routeHash,
      ...(write.protocol !== undefined ? { protocol: write.protocol } : {}),
      expectedStateDiffDigest: request.expectedDiff.diffDigest,
      writeDigest: write.writeDigest,
      ...(write.settlementInstruction !== undefined
        ? { settlementInstruction: write.settlementInstruction }
        : {}),
      expiry: write.expiry,
    });

    const artifact: OnchainAuthorizationArtifact = Object.freeze({
      principal: input.approverRef,
      ...(input.agentRef !== undefined ? { agentRef: input.agentRef } : {}),
      scope,
      expiry: input.expiresAt,
      requestHash: request.requestHash,
      signature: "",
      issuedAt: at,
      surfaceRef: this.#signer.surfaceId,
      networkEpochAtIssuance: securityState.networkEpoch,
      ...(input.delegationId !== undefined ? { delegationId: input.delegationId } : {}),
    });

    const payload = onchainApprovalSigningPayload(artifact);
    const signature = this.#signer.signApprovalPayload(payload, request);
    if (signature.length === 0) {
      throw new InvalidAuthorizationError("the trusted surface signer returned an empty signature");
    }
    const signed: OnchainAuthorizationArtifact = Object.freeze({
      ...artifact,
      signature,
    });
    assertNoSecretMaterial(signed, "onchain authorization artifact");
    this.#minted.push(request.requestHash);
    return signed;
  }
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export type OnchainAuthorizationReason =
  | "secret_material_detected"
  | "missing_signature"
  | "expired"
  | "request_hash_mismatch"
  | "principal_mismatch"
  | "action_out_of_scope"
  | "resource_out_of_scope"
  | "amount_currency_mismatch"
  | "amount_exceeds_approval"
  | "unregistered_surface"
  | "stale_network_epoch"
  | "chain_mismatch"
  | "asset_mismatch"
  | "amount_mismatch"
  | "destination_mismatch"
  | "approval_mismatch"
  | "route_mismatch"
  | "protocol_identity_mismatch"
  | "expected_diff_mismatch"
  | "write_digest_mismatch"
  | "settlement_instruction_mismatch"
  | "write_expiry_mismatch"
  | "delegation_required"
  | "delegation_unknown"
  | "delegation_revoked"
  | "delegation_expired"
  | "delegation_scope_mismatch"
  | "malformed_artifact";

export type OnchainAuthorizationVerification =
  | { readonly valid: true; readonly evidenceRefs: readonly string[] }
  | { readonly valid: false; readonly reason: OnchainAuthorizationReason; readonly detail: string };

function approvalsEqual(a: readonly ApprovalChangeRequest[], b: readonly ApprovalChangeRequest[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const key = (approval: ApprovalChangeRequest) =>
    `${approval.asset.chain}|${approval.asset.assetId}|${approval.owner}|${approval.spender}|${approval.amount.currency}|${approval.amount.minorUnits}|${approval.unlimited}`;
  const sortedA = a.map(key).sort();
  const sortedB = b.map(key).sort();
  return sortedA.every((value, index) => value === sortedB[index]);
}

/**
 * Verify a signed onchain authorization artifact against the request it
 * claims to authorize, at instant `at`, with the CURRENT security state
 * (INV-S02 network-epoch binding) and optional delegation registry +
 * trusted-surface provenance.
 *
 * Stage 1 composes trust's verifyApprovalArtifact verbatim (signature
 * presence, expiry, request-hash binding, principal/agent binding, action/
 * resource/amount scope). Stage 2 verifies every onchain binding. Stage 3
 * verifies epoch, surface provenance and delegation liveness. Fail closed
 * on the first violation, with the exact reason recorded.
 */
export function verifyOnchainAuthorization(
  artifact: OnchainAuthorizationArtifact,
  request: OnchainAuthorizationRequest,
  at: number,
  deps: {
    readonly securityState: OnchainSecurityState;
    readonly delegationRegistry?: SigningDelegationRegistry;
    readonly trustedSurfaces?: readonly TrustedApprovalSurface[];
  },
): OnchainAuthorizationVerification {
  // Stage 0: the artifact itself must be structurally sound and must not
  // smuggle secret material. Malformed shapes fail closed, never crash.
  if (!isWellFormedArtifact(artifact)) {
    return { valid: false, reason: "malformed_artifact", detail: "artifact does not carry the required scope/identity fields" };
  }
  try {
    assertNoSecretMaterial(artifact, "onchain authorization artifact");
  } catch {
    return { valid: false, reason: "secret_material_detected", detail: "artifact carries secret-shaped material" };
  }

  // Stage 1: trust-plane verification, composed verbatim.
  const trustVerification = trustVerifyCompat(artifact, request, at);
  if (trustVerification !== undefined) {
    return trustVerification;
  }

  // Stage 2: onchain bindings — the artifact's scope must bind EXACTLY the
  // request's write (every pre-authorization dimension).
  const write = request.write;
  const scope = artifact.scope;
  const evidence = [
    `artifact:${artifact.requestHash}`,
    `surface:${artifact.surfaceRef}`,
    `write:${write.writeDigest}`,
  ];

  if (scope.chain !== write.chain) {
    return { valid: false, reason: "chain_mismatch", detail: `artifact binds chain ${scope.chain}, write is ${write.chain}` };
  }
  if (write.transfer !== undefined) {
    if (!sameAsset(scope.asset, write.transfer.asset)) {
      return { valid: false, reason: "asset_mismatch", detail: "artifact asset identity differs from the write" };
    }
    if (
      scope.amount.currency !== write.transfer.amount.currency ||
      compareAmounts(scope.amount, write.transfer.amount) !== 0
    ) {
      return { valid: false, reason: "amount_mismatch", detail: "artifact amount differs from the write amount" };
    }
    if (scope.destination !== write.transfer.to) {
      return { valid: false, reason: "destination_mismatch", detail: `artifact binds destination ${scope.destination ?? "-"}, write sends to ${write.transfer.to}` };
    }
  }
  if (!approvalsEqual(scope.approvals, write.approvals)) {
    return { valid: false, reason: "approval_mismatch", detail: "artifact approval set differs from the write approval set" };
  }
  if (scope.routeHash !== write.route.routeHash) {
    return { valid: false, reason: "route_mismatch", detail: "artifact route hash differs from the write route" };
  }
  if (write.protocol !== undefined && (scope.protocol === undefined || !sameProtocol(scope.protocol, write.protocol))) {
    return { valid: false, reason: "protocol_identity_mismatch", detail: "artifact protocol identity differs from the write" };
  }
  if (scope.expectedStateDiffDigest !== request.expectedDiff.diffDigest) {
    return { valid: false, reason: "expected_diff_mismatch", detail: "artifact binds a different expected-state diff than the request presents" };
  }
  if (scope.writeDigest !== write.writeDigest) {
    return { valid: false, reason: "write_digest_mismatch", detail: "artifact binds a different write payload" };
  }
  if (scope.expiry !== write.expiry) {
    return { valid: false, reason: "write_expiry_mismatch", detail: "artifact write expiry differs from the write" };
  }
  if (
    (scope.settlementInstruction?.instructionId ?? undefined) !==
    (write.settlementInstruction?.instructionId ?? undefined)
  ) {
    return { valid: false, reason: "settlement_instruction_mismatch", detail: "artifact settlement instruction binding differs" };
  }

  // Stage 3: epoch, provenance, delegation.
  if (artifact.networkEpochAtIssuance < deps.securityState.networkEpoch) {
    return {
      valid: false,
      reason: "stale_network_epoch",
      detail: `artifact issued at network epoch ${artifact.networkEpochAtIssuance.toString()}, current epoch ${deps.securityState.networkEpoch.toString()} (INV-S02)`,
    };
  }
  if (deps.trustedSurfaces !== undefined) {
    const minting = deps.trustedSurfaces.some(
      (surface) => surface.surfaceId === artifact.surfaceRef && surface.minted(artifact.requestHash),
    );
    if (!minting) {
      return { valid: false, reason: "unregistered_surface", detail: `artifact was not minted by a registered trusted surface (${artifact.surfaceRef})` };
    }
  }
  if (artifact.delegationId !== undefined) {
    if (deps.delegationRegistry === undefined) {
      return { valid: false, reason: "delegation_required", detail: "artifact names a delegation but no registry was supplied (fail closed)" };
    }
    const delegation: SigningDelegation | undefined = deps.delegationRegistry.lookup(artifact.delegationId);
    const status = deps.delegationRegistry.status(artifact.delegationId, at);
    if (status === "UNKNOWN") {
      return { valid: false, reason: "delegation_unknown", detail: `delegation '${artifact.delegationId}' was never issued` };
    }
    if (status === "REVOKED") {
      return { valid: false, reason: "delegation_revoked", detail: `delegation '${artifact.delegationId}' is revoked` };
    }
    if (status === "EXPIRED") {
      return { valid: false, reason: "delegation_expired", detail: `delegation '${artifact.delegationId}' expired` };
    }
    if (delegation === undefined || !delegationCoversWrite(delegation, write)) {
      return { valid: false, reason: "delegation_scope_mismatch", detail: "the delegation's scope does not cover this write (attenuated authority)" };
    }
    evidence.push(`delegation:${artifact.delegationId}`);
  }

  return { valid: true, evidenceRefs: Object.freeze(evidence) };
}

function isWellFormedArtifact(artifact: OnchainAuthorizationArtifact): boolean {
  const scope = artifact.scope as Partial<OnchainApprovalScope> | undefined;
  return (
    typeof artifact.principal === "string" &&
    artifact.principal.length > 0 &&
    typeof artifact.requestHash === "string" &&
    typeof artifact.signature === "string" &&
    typeof artifact.issuedAt === "number" &&
    typeof artifact.expiry === "number" &&
    typeof artifact.surfaceRef === "string" &&
    typeof artifact.networkEpochAtIssuance === "bigint" &&
    scope !== undefined &&
    Array.isArray(scope.actions) &&
    Array.isArray(scope.resources) &&
    Array.isArray(scope.approvals) &&
    typeof scope.chain === "string" &&
    typeof scope.routeHash === "string" &&
    typeof scope.expectedStateDiffDigest === "string" &&
    typeof scope.writeDigest === "string" &&
    typeof scope.expiry === "number" &&
    scope.asset !== undefined &&
    typeof scope.asset.chain === "string" &&
    scope.amount !== undefined &&
    typeof scope.amount.currency === "string"
  );
}

function trustVerifyCompat(
  artifact: OnchainAuthorizationArtifact,
  request: OnchainAuthorizationRequest,
  at: number,
): OnchainAuthorizationVerification | undefined {
  // Same order as trust's verifyApprovalArtifact, mapped onto onchain reasons.
  if (artifact.signature.length === 0) {
    return { valid: false, reason: "missing_signature", detail: "artifact carries no signature" };
  }
  if (at >= artifact.expiry) {
    return { valid: false, reason: "expired", detail: `artifact expired at ${artifact.expiry} (evaluation at ${at})` };
  }
  if (artifact.requestHash !== request.requestHash) {
    return { valid: false, reason: "request_hash_mismatch", detail: "artifact request hash does not bind this request" };
  }
  if (artifact.agentRef !== undefined && principalRef(request.principal) !== artifact.agentRef) {
    return { valid: false, reason: "principal_mismatch", detail: "artifact agent binding differs from the requesting principal" };
  }
  if (!artifact.scope.actions.includes(request.write.action)) {
    return { valid: false, reason: "action_out_of_scope", detail: `action '${request.write.action}' outside artifact scope` };
  }
  const resourceInScope = artifact.scope.resources.some(
    (scoped) => scoped.type === "onchain_write" && scoped.resourceId === request.write.writeId,
  );
  if (!resourceInScope) {
    return { valid: false, reason: "resource_out_of_scope", detail: "write id outside artifact resource scope" };
  }
  const maxAmount = artifact.scope.maxAmount;
  const requestAmount = request.write.transfer?.amount;
  if (maxAmount !== undefined && requestAmount !== undefined) {
    if (requestAmount.currency !== maxAmount.currency) {
      return { valid: false, reason: "amount_currency_mismatch", detail: "approval currency differs from request amount currency" };
    }
    if (compareAmounts(requestAmount, maxAmount) > 0) {
      return { valid: false, reason: "amount_exceeds_approval", detail: "request amount exceeds the approved maximum" };
    }
  }
  return undefined;
}

/**
 * Canonical signing payload for an onchain authorization artifact: trust's
 * canonical approval payload EXTENDED with every onchain binding. The
 * trusted surface signs exactly this serialization.
 */
export function onchainApprovalSigningPayload(artifact: OnchainAuthorizationArtifact): string {
  const trustPayload = approvalSigningPayload(artifact);
  const scope = artifact.scope;
  const parts = [
    trustPayload,
    `chain:${scope.chain}`,
    `asset:${scope.asset.chain}/${scope.asset.assetId}/${scope.asset.symbol}`,
    `amount:${scope.amount.currency}:${scope.amount.minorUnits}`,
    scope.destination === undefined ? "destination:-" : `destination:${scope.destination}`,
    `approvals:${scope.approvals
      .map((a) => `${a.asset.assetId}|${a.owner}|${a.spender}|${a.amount.currency}:${a.amount.minorUnits}|${a.unlimited ? "U" : "F"}`)
      .join(",")}`,
    `routeHash:${scope.routeHash}`,
    scope.protocol === undefined
      ? "protocol:-"
      : `protocol:${scope.protocol.protocolId}@${scope.protocol.version}:${scope.protocol.contract.contractAddress}:${scope.protocol.contract.sourceHash}`,
    `expectedDiff:${scope.expectedStateDiffDigest}`,
    `writeDigest:${scope.writeDigest}`,
    scope.settlementInstruction === undefined
      ? "settlement:-"
      : `settlement:${scope.settlementInstruction.instructionId}:${scope.settlementInstruction.instructionDigest}`,
    `writeExpiry:${scope.expiry}`,
    `surface:${artifact.surfaceRef}`,
    `networkEpoch:${artifact.networkEpochAtIssuance.toString()}`,
    artifact.delegationId === undefined ? "delegation:-" : `delegation:${artifact.delegationId}`,
  ];
  return parts.join("|");
}

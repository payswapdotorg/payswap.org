/**
 * @payswap/onchain-security — immediate pre-broadcast recheck (Work Order
 * P4-W1-002; AGENTS.md rule 26; INV-S02, INV-A03).
 *
 * Between authorization and broadcast the world is re-observed and compared
 * against EXACTLY what the user authorized. ANY drift — amount,
 * destination, spender, expiry, nonce, route, protocol/contract identity,
 * chain, asset, settlement instruction, the write payload itself, an
 * advanced security epoch, or a stale (pre-authorization) observation —
 * VOIDS the authorization.
 *
 * A voided authorization is re-requested, NEVER auto-repaired: there is no
 * API that repairs or re-binds an artifact. The pipeline transitions to
 * VOIDED, a terminal state; a new authorization request must be built and
 * approved from scratch.
 *
 * Deterministic only: the caller supplies the observation and `at`.
 */

import { compareAmounts } from "@payswap/trust";
import { assertNoSecretMaterial } from "./secrets.js";
import type { OnchainAuthorizationArtifact, OnchainAuthorizationRequest } from "./authorization.js";
import type { OnchainSecurityState } from "./gates.js";
import type {
  ApprovalChangeRequest,
  AssetIdentity,
  ChainRef,
  ProtocolIdentity,
  SettlementInstructionBinding,
} from "./types.js";
import { sameAsset, sameProtocol } from "./types.js";

/** Raised on malformed recheck input (fail closed). */
export class InvalidRecheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRecheckError";
  }
}

/** The fresh pre-broadcast observation of what is about to be broadcast. */
export interface RecheckObservation {
  readonly writeId: string;
  readonly observedAt: number;
  readonly chain: ChainRef;
  readonly writeDigest: string;
  readonly transfer?: {
    readonly asset: AssetIdentity;
    readonly amount: { readonly currency: string; readonly minorUnits: string };
    readonly to: string;
  };
  readonly approvals: readonly ApprovalChangeRequest[];
  readonly routeHash: string;
  readonly nonce?: string;
  readonly protocol?: ProtocolIdentity;
  readonly settlementInstruction?: SettlementInstructionBinding;
  readonly securityState: OnchainSecurityState;
}

/** Every drift dimension that voids an authorization. */
export type DriftReason =
  | "stale_observation"
  | "authorization_expired"
  | "stale_network_epoch"
  | "chain_drift"
  | "asset_drift"
  | "amount_drift"
  | "destination_drift"
  | "approval_drift"
  | "route_drift"
  | "nonce_drift"
  | "protocol_identity_drift"
  | "settlement_instruction_drift"
  | "write_payload_drift";

export type RecheckOutcome =
  | {
      readonly outcome: "RECHECK_OK";
      readonly evidenceRefs: readonly string[];
      readonly checked: readonly DriftReason[];
    }
  | {
      readonly outcome: "AUTHORIZATION_VOIDED";
      readonly drift: readonly DriftReason[];
      readonly evidenceRefs: readonly string[];
      readonly detail: string;
    };

function approvalsKey(approvals: readonly ApprovalChangeRequest[]): readonly string[] {
  return approvals
    .map(
      (approval) =>
        `${approval.asset.chain}|${approval.asset.assetId}|${approval.owner}|${approval.spender}|${approval.amount.currency}|${approval.amount.minorUnits}|${approval.unlimited}`,
    )
    .sort();
}

/**
 * The immediate pre-broadcast recheck. Compares the fresh observation
 * against the artifact's authorized bindings. Deterministic, pure, and
 * fail-closed: any unresolvable difference voids the authorization.
 */
export function performPreBroadcastRecheck(
  artifact: OnchainAuthorizationArtifact,
  request: OnchainAuthorizationRequest,
  observation: RecheckObservation,
  at: number,
): RecheckOutcome {
  assertNoSecretMaterial(observation, "recheck observation");
  if (observation.writeId.length === 0) {
    throw new InvalidRecheckError("observation.writeId must be a non-empty string");
  }
  if (!Number.isInteger(observation.observedAt) || observation.observedAt < 0) {
    throw new InvalidRecheckError("observedAt must be a non-negative integer (ms)");
  }

  const drift: DriftReason[] = [];
  const evidence = [
    `artifact:${artifact.requestHash}`,
    `recheck-observation:${observation.observedAt.toString()}`,
    `securityState:epoch-${observation.securityState.networkEpoch.toString()}`,
  ];

  // An observation older than the authorization is a re-used observation.
  if (observation.observedAt < artifact.issuedAt) {
    drift.push("stale_observation");
  }
  if (at >= artifact.expiry) {
    drift.push("authorization_expired");
  }
  if (artifact.networkEpochAtIssuance < observation.securityState.networkEpoch) {
    drift.push("stale_network_epoch");
    evidence.push(`epoch-drift:${artifact.networkEpochAtIssuance.toString()}->${observation.securityState.networkEpoch.toString()}`);
  }

  const write = request.write;
  const scope = artifact.scope;

  if (observation.writeId !== write.writeId) {
    drift.push("write_payload_drift");
  }
  if (observation.writeDigest !== write.writeDigest || observation.writeDigest !== scope.writeDigest) {
    drift.push("write_payload_drift");
  }
  if (observation.chain !== write.chain || observation.chain !== scope.chain) {
    drift.push("chain_drift");
  }

  const observedTransfer = observation.transfer;
  const writeTransfer = write.transfer;
  if (writeTransfer !== undefined) {
    if (observedTransfer === undefined) {
      drift.push("amount_drift", "destination_drift", "asset_drift");
    } else {
      if (!sameAsset(observedTransfer.asset, writeTransfer.asset) || !sameAsset(observedTransfer.asset, scope.asset)) {
        drift.push("asset_drift");
      }
      if (
        observedTransfer.amount.currency !== writeTransfer.amount.currency ||
        compareAmounts(observedTransfer.amount, writeTransfer.amount) !== 0 ||
        observedTransfer.amount.currency !== scope.amount.currency ||
        compareAmounts(observedTransfer.amount, scope.amount) !== 0
      ) {
        drift.push("amount_drift");
      }
      if (observedTransfer.to !== writeTransfer.to || observedTransfer.to !== scope.destination) {
        drift.push("destination_drift");
      }
    }
  } else if (observedTransfer !== undefined) {
    // A transfer appeared that the authorized write does not contain.
    drift.push("write_payload_drift");
  }

  const observedApprovalKeys = approvalsKey(observation.approvals).join(";");
  const authorizedApprovalKeys = approvalsKey(scope.approvals).join(";");
  if (observedApprovalKeys !== authorizedApprovalKeys) {
    drift.push("approval_drift");
  }

  if (observation.routeHash !== write.route.routeHash || observation.routeHash !== scope.routeHash) {
    drift.push("route_drift");
  }

  const observedNonce = observation.nonce;
  const writeNonce = write.nonce;
  if ((observedNonce ?? undefined) !== (writeNonce ?? undefined)) {
    drift.push("nonce_drift");
  }

  const observedProtocol = observation.protocol;
  const authorizedProtocol = write.protocol;
  if (
    (authorizedProtocol ?? undefined) !== undefined ||
    (observedProtocol ?? undefined) !== undefined ||
    (scope.protocol ?? undefined) !== undefined
  ) {
    const allSame =
      observedProtocol !== undefined &&
      authorizedProtocol !== undefined &&
      scope.protocol !== undefined &&
      sameProtocol(observedProtocol, authorizedProtocol) &&
      sameProtocol(observedProtocol, scope.protocol);
    if (!allSame) {
      drift.push("protocol_identity_drift");
    }
  }

  const observedInstruction = observation.settlementInstruction;
  const authorizedInstruction = write.settlementInstruction;
  if (
    (observedInstruction?.instructionId ?? undefined) !== (authorizedInstruction?.instructionId ?? undefined) ||
    (observedInstruction?.instructionDigest ?? undefined) !==
      (authorizedInstruction?.instructionDigest ?? undefined) ||
    (observedInstruction?.instructionDigest ?? undefined) !==
      (scope.settlementInstruction?.instructionDigest ?? undefined)
  ) {
    drift.push("settlement_instruction_drift");
  }

  if (drift.length > 0) {
    const unique = [...new Set(drift)];
    return {
      outcome: "AUTHORIZATION_VOIDED",
      drift: Object.freeze(unique),
      evidenceRefs: Object.freeze(evidence),
      detail: `authorization '${artifact.requestHash}' is VOIDED: drift on [${unique.join(", ")}]; it must be re-requested, never auto-repaired`,
    };
  }
  return {
    outcome: "RECHECK_OK",
    evidenceRefs: Object.freeze(evidence),
    checked: Object.freeze([]),
  };
}

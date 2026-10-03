/**
 * @payswap/onchain-security — prepare stage (Work Order P4-W1-002).
 *
 * A consequential onchain write is PREPARED before anything else happens:
 * structurally validated, secret-scanned, frozen and content-addressed.
 * `prepare` is the only entry point into the pipeline; every later stage
 * (simulation, gates, diff, authorization, recheck, broadcast handoff)
 * binds to the prepared write's digest.
 *
 * One prepared write targets exactly ONE chain: chain confusion is a
 * first-class threat (UMI architecture "Security"), so multi-chain routes
 * are sequences of single-chain writes coordinated by the route, never one
 * write spanning chains.
 *
 * Money is exact integer minor units (INV-F01). Deterministic only: the
 * caller supplies `at`; no ambient clock, no randomness.
 */

import type { AmountSpec } from "@payswap/trust";
import { validateAmountSpec } from "@payswap/trust";
import { assertNoSecretMaterial } from "./secrets.js";
import { contentDigest } from "./digest.js";
import type {
  ApprovalChangeRequest,
  AssetIdentity,
  ChainRef,
  ContractCallRequest,
  ProtocolIdentity,
  SettlementInstructionBinding,
} from "./types.js";
import {
  validateAddress,
  validateAssetIdentity,
  validateChainRef,
  validateProtocolIdentity,
} from "./types.js";

/** Raised when a write request fails structural validation (fail closed). */
export class InvalidWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidWriteError";
  }
}

/** One value-movement leg of the write. */
export interface OnchainTransferLeg {
  readonly asset: AssetIdentity;
  /** Exact integer minor units (INV-F01). */
  readonly amount: AmountSpec;
  readonly from: string;
  readonly to: string;
}

/** Descriptive route hop (venue identity preserved end-to-end). */
export interface RouteHop {
  readonly venue: string;
  readonly chain: ChainRef;
  readonly protocolId?: string;
}

/** The route a prepared write executes (hash-bound). */
export interface RouteRef {
  readonly routeId: string;
  readonly routeHash: string;
  readonly hops?: readonly RouteHop[];
}

/**
 * The request to prepare one consequential onchain write. This is an
 * AGENT-FACING contract: it must never carry secret-shaped material
 * (asserted at prepare time, AGENTS.md rule 25).
 */
export interface OnchainWriteRequest {
  readonly writeId: string;
  /** Trust action vocabulary, e.g. `onchain.transfer`. No wildcards. */
  readonly action: string;
  readonly chain: ChainRef;
  readonly transfer?: OnchainTransferLeg;
  readonly approvals: readonly ApprovalChangeRequest[];
  readonly contractCall?: ContractCallRequest;
  readonly route: RouteRef;
  readonly protocol?: ProtocolIdentity;
  /** Absolute expiry (ms). An expired write is BLOCKED at the gates, never guessed. */
  readonly expiry: number;
  /** Sequence/nonce marker for chains that use one, when known. */
  readonly nonce?: string;
  /** The settlement instruction this write executes (INV-E01 lineage). */
  readonly settlementInstruction?: SettlementInstructionBinding;
  /** Principal ref of the requesting agent (not authority — authority is separate). */
  readonly requestedBy: string;
}

/** A validated, frozen, content-addressed prepared write. */
export interface PreparedWrite {
  readonly writeId: string;
  readonly action: string;
  readonly chain: ChainRef;
  readonly transfer?: OnchainTransferLeg;
  readonly approvals: readonly ApprovalChangeRequest[];
  readonly contractCall?: ContractCallRequest;
  readonly route: RouteRef;
  readonly protocol?: ProtocolIdentity;
  readonly expiry: number;
  readonly nonce?: string;
  readonly settlementInstruction?: SettlementInstructionBinding;
  readonly requestedBy: string;
  /** Content digest binding every field: later stages pin this. */
  readonly writeDigest: string;
  /** Caller-supplied preparation instant (deterministic evaluation input). */
  readonly preparedAt: number;
}

function requireNonEmpty(value: string | undefined, label: string): string {
  if (value === undefined || value.length === 0) {
    throw new InvalidWriteError(`${label} must be a non-empty string`);
  }
  return value;
}

function validateApproval(approval: ApprovalChangeRequest, chain: ChainRef): void {
  validateAssetIdentity(approval.asset);
  if (approval.asset.chain !== chain) {
    throw new InvalidWriteError(
      `approval asset chain '${approval.asset.chain}' differs from write chain '${chain}': one write targets exactly one chain`,
    );
  }
  validateAddress(approval.owner, "approval.owner");
  validateAddress(approval.spender, "approval.spender");
  validateAmountSpec(approval.amount);
  if (approval.amount.currency !== approval.asset.symbol) {
    throw new InvalidWriteError(
      `approval amount currency '${approval.amount.currency}' does not match asset symbol '${approval.asset.symbol}'`,
    );
  }
  if (approval.unlimited && approval.amount.minorUnits !== "0") {
    throw new InvalidWriteError(
      "an unlimited approval must carry amount 0 (the explicit allowance is unbounded)",
    );
  }
}

function validateTransfer(transfer: OnchainTransferLeg, chain: ChainRef): void {
  validateAssetIdentity(transfer.asset);
  if (transfer.asset.chain !== chain) {
    throw new InvalidWriteError(
      `transfer asset chain '${transfer.asset.chain}' differs from write chain '${chain}': one write targets exactly one chain`,
    );
  }
  validateAddress(transfer.from, "transfer.from");
  validateAddress(transfer.to, "transfer.to");
  validateAmountSpec(transfer.amount);
  if (transfer.amount.currency !== transfer.asset.symbol) {
    throw new InvalidWriteError(
      `transfer amount currency '${transfer.amount.currency}' does not match asset symbol '${transfer.asset.symbol}'`,
    );
  }
}

/**
 * prepare — validate, secret-scan, freeze and content-address one
 * consequential onchain write request. Structural validation is fail
 * closed: a malformed request is never repaired or guessed. Expiry is a
 * GATE dimension (an expired write is BLOCKED deterministically, not
 * rejected at construction — the adversarial suite proves the BLOCK case).
 */
export function prepareWrite(request: OnchainWriteRequest, at: number): PreparedWrite {
  assertNoSecretMaterial(request, "onchain write request");

  requireNonEmpty(request.writeId, "writeId");
  requireNonEmpty(request.action, "action");
  if (request.action.includes("*")) {
    throw new InvalidWriteError(`action '${request.action}' must be concrete, not a wildcard pattern`);
  }
  validateChainRef(request.chain);

  if (request.transfer === undefined && request.approvals.length === 0 && request.contractCall === undefined) {
    throw new InvalidWriteError(
      "a consequential write must move value, change an approval, or call a contract",
    );
  }

  if (request.transfer !== undefined) {
    validateTransfer(request.transfer, request.chain);
  }
  for (const approval of request.approvals) {
    validateApproval(approval, request.chain);
  }

  if (request.contractCall !== undefined) {
    validateAddress(request.contractCall.target, "contractCall.target");
    requireNonEmpty(request.contractCall.calldata, "contractCall.calldata");
    requireNonEmpty(request.contractCall.calldataDigest, "contractCall.calldataDigest");
    if (request.contractCall.value !== undefined) {
      validateAmountSpec(request.contractCall.value);
    }
  }

  requireNonEmpty(request.route.routeId, "route.routeId");
  requireNonEmpty(request.route.routeHash, "route.routeHash");
  for (const hop of request.route.hops ?? []) {
    requireNonEmpty(hop.venue, "route.hop.venue");
    validateChainRef(hop.chain);
  }

  if (request.protocol !== undefined) {
    validateProtocolIdentity(request.protocol);
    if (request.protocol.contract.chainRef !== request.chain) {
      throw new InvalidWriteError(
        `protocol contract chain '${request.protocol.contract.chainRef}' differs from write chain '${request.chain}'`,
      );
    }
  }

  if (!Number.isInteger(request.expiry) || request.expiry < 0) {
    throw new InvalidWriteError("expiry must be a non-negative integer (absolute ms)");
  }
  if (request.nonce !== undefined) {
    requireNonEmpty(request.nonce, "nonce");
  }
  if (request.settlementInstruction !== undefined) {
    requireNonEmpty(request.settlementInstruction.instructionId, "settlementInstruction.instructionId");
    requireNonEmpty(
      request.settlementInstruction.instructionDigest,
      "settlementInstruction.instructionDigest",
    );
  }
  requireNonEmpty(request.requestedBy, "requestedBy");
  if (!Number.isInteger(at) || at < 0) {
    throw new InvalidWriteError("preparation instant `at` must be a non-negative integer (ms)");
  }

  const writeDigest = contentDigest({
    writeId: request.writeId,
    action: request.action,
    chain: request.chain,
    transfer: request.transfer,
    approvals: request.approvals,
    contractCall: request.contractCall,
    route: { routeId: request.route.routeId, routeHash: request.route.routeHash, hops: request.route.hops },
    protocol: request.protocol,
    expiry: request.expiry,
    nonce: request.nonce,
    settlementInstruction: request.settlementInstruction,
    requestedBy: request.requestedBy,
  });

  return Object.freeze({
    writeId: request.writeId,
    action: request.action,
    chain: request.chain,
    ...(request.transfer !== undefined ? { transfer: Object.freeze(request.transfer) } : {}),
    approvals: Object.freeze(request.approvals.map((a) => Object.freeze(a))),
    ...(request.contractCall !== undefined
      ? { contractCall: Object.freeze(request.contractCall) }
      : {}),
    route: Object.freeze(request.route),
    ...(request.protocol !== undefined ? { protocol: Object.freeze(request.protocol) } : {}),
    expiry: request.expiry,
    ...(request.nonce !== undefined ? { nonce: request.nonce } : {}),
    ...(request.settlementInstruction !== undefined
      ? { settlementInstruction: Object.freeze(request.settlementInstruction) }
      : {}),
    requestedBy: request.requestedBy,
    writeDigest,
    preparedAt: at,
  });
}

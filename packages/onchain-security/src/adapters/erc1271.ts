/**
 * @payswap/onchain-security — ERC-1271 contract-signature adapter (EVM).
 *
 * ERC-1271 semantics (smart-account contract signatures:
 * `isValidSignature(bytes32 hash, bytes signature)`) live HERE and ONLY
 * HERE — never in core contracts (Work Order P4-W1-002). A smart account
 * authorizes onchain writes through its contract-signature path; this
 * adapter builds the canonical ERC-1271 verification envelope the trusted
 * surface / chain adapter submits to the account's validator.
 *
 * The actual on-chain `isValidSignature` call belongs to P4-W2-001's
 * multi-chain adapter SDK; this module only constructs the deterministic,
 * content-addressed envelope.
 */

import { assertNoSecretMaterial } from "../secrets.js";
import { contentDigest } from "../digest.js";
import type {
  OnchainAuthorizationArtifact,
  OnchainAuthorizationRequest,
} from "../authorization.js";
import { onchainApprovalSigningPayload } from "../authorization.js";
import type { SignerAdapter } from "../signers.js";
import type { ChainRef } from "../types.js";

/** Raised on malformed ERC-1271 adapter input (fail closed). */
export class Erc1271AdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Erc1271AdapterError";
  }
}

/**
 * The ERC-1271 verification envelope: the message hash the smart account
 * validator must authenticate, plus every binding needed to audit it.
 */
export interface Erc1271VerificationEnvelope {
  /** The smart account whose validator must accept the signature. */
  readonly account: string;
  /** Digest of the canonical approval payload (the ERC-1271 message hash input). */
  readonly messageDigest: string;
  readonly requestHash: string;
  readonly writeDigest: string;
  readonly chain: ChainRef;
  readonly delegationId?: string;
}

/** The ERC-1271 magic value a validator returns for a valid signature. */
export const ERC1271_MAGIC_VALUE = "0x1626ba7e" as const;

/**
 * The ERC-1271 adapter: builds the contract-signature verification
 * envelope for an authorized write executed by a smart account (or scoped
 * signer delegating through one).
 */
export class Erc1271SignerAdapter implements SignerAdapter {
  readonly adapterId: string;
  readonly supportedChains: readonly ChainRef[];

  constructor(input?: {
    readonly adapterId?: string;
    readonly supportedChains?: readonly ChainRef[];
  }) {
    this.adapterId = input?.adapterId ?? "signer-adapter:erc1271";
    this.supportedChains = input?.supportedChains ?? ["ethereum:*"];
  }

  buildSigningPayload(input: {
    readonly artifact: OnchainAuthorizationArtifact;
    readonly request: OnchainAuthorizationRequest;
  }): string {
    const write = input.request.write;
    const account = write.transfer?.from ?? write.approvals[0]?.owner;
    if (account === undefined) {
      throw new Erc1271AdapterError("the authorized write carries no smart-account address");
    }
    const payload = onchainApprovalSigningPayload(input.artifact);
    const envelope: Erc1271VerificationEnvelope = {
      account,
      messageDigest: contentDigest(payload),
      requestHash: input.artifact.requestHash,
      writeDigest: input.artifact.scope.writeDigest,
      chain: write.chain,
      ...(input.artifact.delegationId !== undefined
        ? { delegationId: input.artifact.delegationId }
        : {}),
    };
    assertNoSecretMaterial(envelope, "erc-1271 verification envelope");
    return JSON.stringify(envelope, null, 0);
  }
}

/** Parse a serialized envelope (for adapter consumers / tests). */
export function parseErc1271Envelope(payload: string): Erc1271VerificationEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Erc1271AdapterError("payload is not a serialized ERC-1271 envelope");
  }
  const record = parsed as Partial<Erc1271VerificationEnvelope>;
  if (
    typeof record.account !== "string" ||
    typeof record.messageDigest !== "string" ||
    typeof record.requestHash !== "string" ||
    typeof record.writeDigest !== "string" ||
    typeof record.chain !== "string"
  ) {
    throw new Erc1271AdapterError("payload does not carry the ERC-1271 envelope fields");
  }
  return {
    account: record.account,
    messageDigest: record.messageDigest,
    requestHash: record.requestHash,
    writeDigest: record.writeDigest,
    chain: record.chain,
    ...(record.delegationId !== undefined ? { delegationId: record.delegationId } : {}),
  };
}

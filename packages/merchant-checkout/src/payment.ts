/**
 * @payswap/merchant-checkout — customer wallet payment (P4-W2-003 §3.4).
 *
 * The customer authorizes with their wallet THROUGH the W1-002 kernel:
 * prepare → simulate → policy (deterministic gates) → diff → authorize →
 * recheck → broadcast handoff. This module COMPOSES the
 * @payswap/onchain-security pipeline — it never reimplements signing, key
 * handling or gate logic. The trusted approval surface and the signer
 * adapter are INJECTED (caller-supplied): the signing surface is a
 * trusted-surface operation producing a signed authorization artifact
 * (AGENTS.md rule 10); this package never signs and never broadcasts.
 *
 * ACCEPTANCE LAW (work item §3.4): the customer SEES what they are signing.
 * `buildCheckoutAuthorization` produces a `CheckoutAuthorizationBundle`
 * carrying the human-readable payment summary (merchant, fiat amount,
 * crypto amount, asset, chain, destination, fees, expiry — deterministic
 * plain sentences) alongside the kernel's typed expected-state diff and
 * gate outcome, all bound to the same prepared write. A payment without
 * explicit customer authorization lineage is structurally unrepresentable:
 * the lifecycle layer (lifecycle.ts) requires the
 * `WalletAuthorizationLineage` record minted here on every wallet payment
 * attempt.
 *
 * Deterministic only: every stage takes an explicit instant; the only
 * caller-supplied effects are the trusted surface and the submission
 * boundary.
 */

import { ValidationError } from "@payswap/protocol";
import type { Money, TimestampMs } from "@payswap/protocol";
import {
  OnchainWritePipeline,
  assertNoSecretMaterial,
  contentDigest,
} from "@payswap/onchain-security";
import type {
  BroadcastHandoffReceipt,
  GateDecision,
  OnchainAuthorizationRequest,
  OnchainSecurityPolicy,
  OnchainSecurityState,
  PreparedWrite,
  RecheckObservation,
  SignerAdapter,
  SigningRequest,
  SimulationObservation,
  TrustedApprovalSurface,
} from "@payswap/onchain-security";
import type { Principal } from "@payswap/trust";
import type { CustomerPaymentOption } from "./checkout.js";
import { checkoutOption } from "./checkout.js";
import type { CheckoutFlow } from "./checkout.js";

/** The kernel write action for a checkout wallet payment. */
export const CHECKOUT_WALLET_PAYMENT_ACTION = "onchain.transfer" as const;

/** The kernel route id for a direct checkout wallet payment. */
export const CHECKOUT_WALLET_PAYMENT_ROUTE_ID = "merchant-checkout.wallet-payment" as const;

/**
 * Convert a protocol bigint TimestampMs to a kernel number instant exactly
 * (fail-closed on unsafe integers). The two planes use different instant
 * representations; this is the ONLY conversion path.
 */
export function asKernelInstant(value: TimestampMs, label: string): number {
  if (typeof value !== "bigint") {
    throw new ValidationError(`${label} must be a bigint TimestampMs`);
  }
  const instant = Number(value);
  if (!Number.isSafeInteger(instant) || instant < 0) {
    throw new ValidationError(
      `${label} cannot be represented as a safe kernel instant (ms)`,
      { value: value.toString() },
    );
  }
  return instant;
}

/** The typed diff of what the simulation predicts, summarized for display. */
export interface PaymentSummaryInput {
  readonly merchantName: string;
  readonly fiatAmount: Money;
  readonly fees: Money;
  readonly option: CustomerPaymentOption;
  readonly customerWalletAddress: string;
  readonly destinationAddress: string;
}

/**
 * The customer-facing authorization bundle: EXACTLY what the trusted surface
 * shows before signing — the human-readable payment summary, the kernel's
 * typed expected-state diff rendering, the gate outcome, and the kernel's
 * own authorization request (which content-addresses write + diff +
 * decision). The summary is a deterministic pure function of the same
 * facts, so it can never drift from the write the customer signs.
 */
export interface CheckoutAuthorizationBundle {
  readonly request: OnchainAuthorizationRequest;
  readonly paymentSummary: readonly string[];
  readonly summaryDigest: string;
  readonly diffRendering: readonly string[];
}

/**
 * The authorization lineage every wallet payment attempt must carry
 * (ACCEPTANCE LAW — without this record a wallet payment is structurally
 * unrepresentable in the lifecycle layer).
 */
export interface WalletAuthorizationLineage {
  /** requestHash of the kernel authorization request the customer approved. */
  readonly authorizationRequestHash: string;
  /** Content digest of the exact prepared write that was authorized. */
  readonly writeDigest: string;
  /** Digest of the payment summary the customer was shown. */
  readonly paymentSummaryDigest: string;
  /** The signing request handed to the trusted-surface signer adapter. */
  readonly signingRequestId: string;
  /** The chain the payment was authorized on. */
  readonly chainRef: string;
  /** External submission reference from the broadcast handoff receipt. */
  readonly externalSubmissionRef: string;
  /** The kernel pipeline's append-only evidence log entries. */
  readonly evidenceRefs: readonly string[];
}

/** The full wallet payment authorization result (lineage + artifacts). */
export interface WalletPaymentAuthorization {
  readonly lineage: WalletAuthorizationLineage;
  readonly signingRequest: SigningRequest;
  readonly handoffReceipt: BroadcastHandoffReceipt;
}

/**
 * Render the human-readable payment summary (deterministic plain
 * sentences). The customer sees: merchant, fiat amount + fees, the exact
 * crypto amount + asset + chain, source and destination addresses, quote
 * validity and the expiry boundary.
 */
export function renderPaymentSummary(input: PaymentSummaryInput): readonly string[] {
  if (input === null || typeof input !== "object") {
    throw new ValidationError("renderPaymentSummary requires a PaymentSummaryInput");
  }
  if (input.option.kind !== "CRYPTO_WALLET_PAYMENT") {
    throw new ValidationError(
      "a payment summary describes a CRYPTO_WALLET_PAYMENT option",
      { optionId: input.option.optionId },
    );
  }
  const quote = input.option.quote;
  const lines: string[] = [
    `Pay ${input.merchantName}`,
    `Amount: ${quote.fiatAmount.value} minor units of ${quote.fiatAmount.currency}` +
      ` (fees: ${quote.fees.value} minor units of ${quote.fees.currency})`,
    `You will send exactly ${quote.cryptoAmount.value} minor units of ` +
      `${input.option.railBinding.assetIdentity.symbol} on ${input.option.railBinding.chainRef}`,
    `From your wallet ${input.customerWalletAddress}`,
    `To destination ${input.destinationAddress}`,
    `Quote ${quote.id} is valid until ${quote.validUntil} (the last instant it is usable is ${quote.validUntil - 1n})`,
  ];
  const summary = Object.freeze(lines);
  assertNoSecretMaterial(summary, "payment summary");
  return summary;
}

/** Deterministic digest of the rendered payment summary. */
export function paymentSummaryDigest(summary: readonly string[]): string {
  if (!Array.isArray(summary) || summary.length === 0) {
    throw new ValidationError("a payment summary digest requires the summary lines");
  }
  return contentDigest({ lines: [...summary] });
}

/**
 * Prepare the consequential onchain write for one checkout option: builds
 * the kernel `OnchainWriteRequest` (action, chain, exact transfer leg,
 * route, expiry, requester) and constructs the REAL kernel pipeline over
 * it. The write expires AT the quote's validity boundary — a payment may
 * only be signed and submitted while the quote is usable.
 */
export function prepareCheckoutWrite(input: {
  readonly flow: CheckoutFlow;
  readonly optionId: string;
  readonly customerWalletAddress: string;
  readonly destinationAddress: string;
  readonly writeId: string;
  /** Principal ref of the requesting service (NOT authority — authority is separate). */
  readonly requestedBy: string;
  readonly policy: OnchainSecurityPolicy;
  readonly trustedSurfaces?: readonly TrustedApprovalSurface[];
  readonly now: TimestampMs;
}): { readonly write: PreparedWrite; readonly pipeline: OnchainWritePipeline } {
  if (input.flow === null || typeof input.flow !== "object") {
    throw new ValidationError("prepareCheckoutWrite requires a CheckoutFlow");
  }
  const option = checkoutOption(input.flow, input.optionId);
  if (option.kind !== "CRYPTO_WALLET_PAYMENT") {
    throw new ValidationError(
      "only a CRYPTO_WALLET_PAYMENT option prepares a wallet payment write",
      { optionId: option.optionId },
    );
  }
  if (typeof input.writeId !== "string" || input.writeId.length === 0) {
    throw new ValidationError("writeId must be a non-empty string");
  }
  if (typeof input.requestedBy !== "string" || input.requestedBy.length === 0) {
    throw new ValidationError("requestedBy must be a non-empty string");
  }
  const nowInstant = asKernelInstant(input.now, "now");
  if (input.now >= option.quote.validUntil) {
    throw new ValidationError(
      "the quote is expired; a fresh checkout option is required (expiry at boundary)",
      { flowId: input.flow.id, optionId: option.optionId, validUntil: option.quote.validUntil, now: input.now },
    );
  }
  const binding = option.railBinding;
  const minorUnits = option.quote.cryptoAmount.value.toString();
  if (!/^(0|[1-9][0-9]*)$/.test(minorUnits) || minorUnits === "0") {
    throw new ValidationError(
      "the quoted crypto amount must be a positive integer minor-unit string",
      { optionId: option.optionId },
    );
  }
  const routeHash = contentDigest({
    routeId: CHECKOUT_WALLET_PAYMENT_ROUTE_ID,
    flowId: input.flow.id,
    optionId: option.optionId,
    assetId: binding.merchantAssetId,
    chainId: binding.merchantChainId,
    chainRef: binding.chainRef,
    quoteId: option.quote.id,
  });
  const pipeline = new OnchainWritePipeline({
    request: {
      writeId: input.writeId,
      action: CHECKOUT_WALLET_PAYMENT_ACTION,
      chain: binding.chainRef,
      transfer: {
        asset: binding.assetIdentity,
        amount: {
          currency: binding.assetIdentity.symbol,
          minorUnits,
        },
        from: input.customerWalletAddress,
        to: input.destinationAddress,
      },
      approvals: [],
      route: {
        routeId: CHECKOUT_WALLET_PAYMENT_ROUTE_ID,
        routeHash,
      },
      expiry: asKernelInstant(option.quote.validUntil, "quote.validUntil"),
      requestedBy: input.requestedBy,
    },
    policy: input.policy,
    ...(input.trustedSurfaces !== undefined
      ? { trustedSurfaces: input.trustedSurfaces }
      : {}),
    at: nowInstant,
  });
  return { write: pipeline.prepared, pipeline };
}

/**
 * Attach a simulation observation (an OBSERVATION, never authority — the
 * kernel law). Checkout-specific consistency: when the simulation reports
 * balance deltas for the paying wallet, the debited amount must EQUAL the
 * quote's exact crypto amount — a divergent simulation is a ValidationError
 * here (the kernel gates would also BLOCK it before authorization).
 */
export function attachCheckoutSimulation(
  pipeline: OnchainWritePipeline,
  simulation: SimulationObservation,
  option: CustomerPaymentOption,
  now: TimestampMs,
): SimulationObservation {
  if (pipeline === null || typeof pipeline !== "object") {
    throw new ValidationError("attachCheckoutSimulation requires a pipeline");
  }
  if (option === null || typeof option !== "object" || option.kind !== "CRYPTO_WALLET_PAYMENT") {
    throw new ValidationError(
      "attachCheckoutSimulation requires a CRYPTO_WALLET_PAYMENT option",
    );
  }
  const recorded = pipeline.simulate(simulation, asKernelInstant(now, "now"));
  if (recorded.status === "SUCCEEDED") {
    const expectedMinor = option.quote.cryptoAmount.value.toString();
    for (const delta of recorded.balanceDeltas) {
      if (
        delta.direction === "debit" &&
        delta.asset.chain === option.railBinding.chainRef &&
        delta.asset.assetId === option.railBinding.assetIdentity.assetId &&
        delta.amount.minorUnits !== expectedMinor
      ) {
        throw new ValidationError(
          "the simulation predicts a different debit amount than the quote — the customer would not see what they sign",
          {
            simulatedMinorUnits: delta.amount.minorUnits,
            quotedMinorUnits: expectedMinor,
          },
        );
      }
    }
  }
  return recorded;
}

/**
 * Build the customer-facing authorization bundle from a GATED_ALLOW
 * pipeline: the kernel's typed expected-state diff (rendered as plain
 * sentences), the gate decision, and the human-readable payment summary —
 * everything the customer sees before signing, bound to the same write.
 */
export function buildCheckoutAuthorization(input: {
  readonly pipeline: OnchainWritePipeline;
  readonly requestId: string;
  readonly principal: Principal;
  readonly merchantName: string;
  readonly option: CustomerPaymentOption;
  readonly customerWalletAddress: string;
  readonly destinationAddress: string;
  readonly now: TimestampMs;
}): CheckoutAuthorizationBundle {
  if (input.pipeline === null || typeof input.pipeline !== "object") {
    throw new ValidationError("buildCheckoutAuthorization requires a pipeline");
  }
  if (input.option === null || typeof input.option !== "object") {
    throw new ValidationError("buildCheckoutAuthorization requires an option");
  }
  if (input.option.kind !== "CRYPTO_WALLET_PAYMENT") {
    throw new ValidationError(
      "an authorization bundle describes a CRYPTO_WALLET_PAYMENT option",
    );
  }
  const diff = input.pipeline.buildExpectedDiff(asKernelInstant(input.now, "now"));
  const request = input.pipeline.buildAuthorizationRequest({
    requestId: input.requestId,
    principal: input.principal,
    requestedAt: asKernelInstant(input.now, "now"),
  });
  const summary = renderPaymentSummary({
    merchantName: input.merchantName,
    fiatAmount: input.option.quote.fiatAmount,
    fees: input.option.quote.fees,
    option: input.option,
    customerWalletAddress: input.customerWalletAddress,
    destinationAddress: input.destinationAddress,
  });
  const bundle: CheckoutAuthorizationBundle = Object.freeze({
    request,
    paymentSummary: summary,
    summaryDigest: paymentSummaryDigest(summary),
    diffRendering: Object.freeze([
      ...renderDiffEntries(input.pipeline, request),
    ]),
  });
  assertNoSecretMaterial(bundle, "checkout authorization bundle");
  return bundle;
}

function renderDiffEntries(
  pipeline: OnchainWritePipeline,
  request: OnchainAuthorizationRequest,
): readonly string[] {
  // The kernel's diff rendering is the authoritative plain-sentence view;
  // this wraps it so the bundle is self-contained for the trusted surface.
  const lines: string[] = [];
  for (const entry of request.expectedDiff.entries) {
    lines.push(entry.description);
  }
  if (lines.length === 0) {
    throw new ValidationError("the expected-state diff must describe at least one effect");
  }
  return lines;
}

/** The gate decision the pipeline last produced (displayed with the bundle). */
export function checkoutGateDecision(pipeline: OnchainWritePipeline): GateDecision | undefined {
  if (pipeline === null || typeof pipeline !== "object") {
    throw new ValidationError("checkoutGateDecision requires a pipeline");
  }
  return pipeline.gateDecision;
}

/**
 * Authorize the wallet payment: the INJECTED trusted approval surface mints
 * the signed authorization artifact (the kernel re-runs the deterministic
 * gates with the current policy + security state and refuses BLOCK/UNKNOWN;
 * this method then verifies every binding again). Rule 10: the approving
 * principal is the CUSTOMER at the trusted surface — never this package.
 */
export function authorizeCheckoutPayment(
  pipeline: OnchainWritePipeline,
  input: {
    readonly surface: TrustedApprovalSurface;
    readonly approverRef: string;
    readonly securityState: OnchainSecurityState;
    readonly expiresAt: TimestampMs;
    readonly now: TimestampMs;
    readonly agentRef?: string;
  },
): ReturnType<OnchainWritePipeline["authorize"]> {
  if (pipeline === null || typeof pipeline !== "object") {
    throw new ValidationError("authorizeCheckoutPayment requires a pipeline");
  }
  return pipeline.authorize({
    surface: input.surface,
    approverRef: input.approverRef,
    securityState: input.securityState,
    expiresAt: asKernelInstant(input.expiresAt, "expiresAt"),
    at: asKernelInstant(input.now, "now"),
    ...(input.agentRef !== undefined ? { agentRef: input.agentRef } : {}),
  });
}

/**
 * Immediate pre-broadcast recheck: ANY drift between the authorized
 * expected state and the fresh observation VOIDS the authorization
 * (terminal VOIDED; re-request, never auto-repair — the kernel law).
 */
export function recheckCheckoutPayment(
  pipeline: OnchainWritePipeline,
  observation: RecheckObservation,
  now: TimestampMs,
): ReturnType<OnchainWritePipeline["recheck"]> {
  if (pipeline === null || typeof pipeline !== "object") {
    throw new ValidationError("recheckCheckoutPayment requires a pipeline");
  }
  return pipeline.recheck(observation, asKernelInstant(now, "now"));
}

/**
 * Broadcast handoff: the pipeline's ONLY exit toward execution — a
 * SigningRequest for the INJECTED signer adapter (the trusted-surface
 * wallet layer). This package never broadcasts.
 */
export function handOffForBroadcast(
  pipeline: OnchainWritePipeline,
  input: {
    readonly requestId: string;
    readonly adapter: SignerAdapter;
    readonly now: TimestampMs;
  },
): SigningRequest {
  if (pipeline === null || typeof pipeline !== "object") {
    throw new ValidationError("handOffForBroadcast requires a pipeline");
  }
  return pipeline.handoffForBroadcast({
    requestId: input.requestId,
    adapter: input.adapter,
    at: asKernelInstant(input.now, "now"),
  });
}

/**
 * The deterministic kernel-instant bridge for recheck observations: builds
 * the observation's timing fields from protocol instants. (The observation
 * content itself comes from the fresh world state — caller-supplied.)
 */
export function kernelInstantOf(value: TimestampMs, label: string): number {
  return asKernelInstant(value, label);
}

/** Whether the pipeline reached the BROADCAST_HANDOFF terminal state. */
export function pipelineReadyForHandoff(pipeline: OnchainWritePipeline): boolean {
  return pipeline.state === "BROADCAST_HANDOFF";
}

/**
 * Mint the wallet payment authorization lineage from a completed handoff:
 * binds the authorization request hash, the write digest, the payment
 * summary digest, the signing request and the external submission
 * reference from the trusted-surface receipt, plus the kernel pipeline's
 * append-only evidence log. This record is MANDATORY on every wallet
 * payment attempt in lifecycle.ts (ACCEPTANCE LAW).
 */
export function walletPaymentAuthorizationLineage(input: {
  readonly bundle: CheckoutAuthorizationBundle;
  readonly signingRequest: SigningRequest;
  readonly handoffReceipt: BroadcastHandoffReceipt;
  readonly chainRef: string;
}): WalletAuthorizationLineage {
  if (input.bundle === null || typeof input.bundle !== "object") {
    throw new ValidationError("walletPaymentAuthorizationLineage requires a bundle");
  }
  if (input.signingRequest === null || typeof input.signingRequest !== "object") {
    throw new ValidationError("walletPaymentAuthorizationLineage requires a signing request");
  }
  if (input.handoffReceipt === null || typeof input.handoffReceipt !== "object") {
    throw new ValidationError(
      "walletPaymentAuthorizationLineage requires a broadcast handoff receipt",
    );
  }
  if (
    input.signingRequest.authorizationRef !== input.bundle.request.requestHash
  ) {
    throw new ValidationError(
      "the signing request must execute the authorization the customer approved",
      {
        signingRequestAuthorizationRef: input.signingRequest.authorizationRef,
        approvedRequestHash: input.bundle.request.requestHash,
      },
    );
  }
  if (typeof input.chainRef !== "string" || input.chainRef.length === 0) {
    throw new ValidationError("chainRef must be a non-empty string");
  }
  const lineage: WalletAuthorizationLineage = Object.freeze({
    authorizationRequestHash: input.bundle.request.requestHash,
    writeDigest: input.bundle.request.write.writeDigest,
    paymentSummaryDigest: input.bundle.summaryDigest,
    signingRequestId: input.signingRequest.requestId,
    chainRef: input.chainRef,
    externalSubmissionRef: input.handoffReceipt.externalRef,
    evidenceRefs: Object.freeze([
      `authorization:${input.bundle.request.requestHash}`,
      `signingRequest:${input.signingRequest.requestId}`,
      `submission:${input.handoffReceipt.externalRef}`,
      ...input.handoffReceipt.evidenceRefs,
    ]),
  });
  assertNoSecretMaterial(lineage, "wallet authorization lineage");
  return lineage;
}

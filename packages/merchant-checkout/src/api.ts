/**
 * @payswap/merchant-checkout — typed API-surface contracts (P4-W2-003 §3.10).
 *
 * The merchant + customer journeys modeled as typed request/response
 * contracts over ONE dispatch function. Every handler composes the REAL
 * package functions (onboarding, acceptance, checkout, the kernel wallet
 * payment, lifecycle, webhooks, refunds, settlement) — there are no mocks
 * of this package's own code anywhere: the dispatch walks the same
 * functions the direct tests walk.
 *
 * The browser/API end-to-end evidence the acceptance criteria demand is
 * exactly this surface: request/response shapes for the merchant journey
 * (onboarding → acceptance activation → settlement configuration) and the
 * customer journey (checkout → option → explicit signing → lifecycle →
 * status), proven deterministically by the test battery.
 *
 * Deterministic only: every request carries its own `now`; the trusted
 * surface, signer adapter and submission boundary are INJECTED deps (the
 * signing surface stays a trusted-surface operation — rule 10).
 */

import { ValidationError } from "@payswap/protocol";
import type { Money, TimestampMs } from "@payswap/protocol";
import type { PaymentAcceptancePolicy } from "@payswap/payment";
import type {
  BroadcastHandoffReceipt,
  OnchainSecurityPolicy,
  OnchainSecurityState,
  SignerAdapter,
  SigningRequest,
  SimulationObservation,
  TrustedApprovalSurface,
} from "@payswap/onchain-security";
import type { OnchainWritePipeline } from "@payswap/onchain-security";
import type { Principal } from "@payswap/trust";
import type { CryptoQuote } from "@payswap/merchant-crypto";
import type { MerchantPaymentIntent } from "@payswap/merchant-crypto";
import type { ConnectedCapabilityInstance } from "@payswap/connectors";
import type { MerchantSettlementDestination } from "@payswap/payment";
import type { MerchantProfile } from "./onboarding.js";
import {
  activateMerchant,
  draftMerchant,
  submitMerchantApplication,
  updateMerchantProfile,
  verifyMerchant,
} from "./onboarding.js";
import type { CryptoAcceptanceActivation } from "./acceptance.js";
import { acceptanceOfferView, activateCryptoAcceptance, deactivateCryptoAcceptance } from "./acceptance.js";
import type { CheckoutFlow, CheckoutPaymentOption, RailAssetBinding } from "./checkout.js";
import { checkoutOption, openCheckoutFlow } from "./checkout.js";
import type {
  CheckoutAuthorizationBundle,
  WalletAuthorizationLineage,
} from "./payment.js";
import {
  authorizeCheckoutPayment,
  buildCheckoutAuthorization,
  handOffForBroadcast,
  prepareCheckoutWrite,
  recheckCheckoutPayment,
  walletPaymentAuthorizationLineage,
} from "./payment.js";
import type {
  CheckoutPaymentAttempt,
  AttemptOutcomeObservation,
} from "./lifecycle.js";
import {
  attachMethodToIntent,
  confirmIntentSubmission,
  observeAttemptOutcome,
  resolveAttemptUnknown,
  settleIntentOutcome,
  submitWalletPaymentAttempt,
} from "./lifecycle.js";
import type { RecoursePolicyKind } from "@payswap/payment";
import type {
  MerchantCheckoutWebhookEvent,
  WebhookInbox,
  WebhookProcessingResult,
} from "./webhooks.js";
import { emptyWebhookInbox, processWebhookEvent } from "./webhooks.js";
import type {
  RailRefundSupportObservation,
  RefundInitiationResult,
  RefundRecord,
  RefundOutcomeObservation,
} from "./refunds.js";
import { initiateRefund, observeRefundOutcome } from "./refunds.js";
import type {
  MerchantSettlementModeConfig,
  MerchantSettlementRecord,
  MerchantStripeSettlementMode,
  SettlementRouteSelection,
} from "./settlement.js";
import { selectSettlementRoute, settleConfirmedAttempt } from "./settlement.js";

// ---------------------------------------------------------------------------
// Context + trusted deps
// ---------------------------------------------------------------------------

/** The merchant-checkout session state the API operates over. */
export interface MerchantCheckoutApiContext {
  readonly profile?: MerchantProfile;
  readonly activation?: CryptoAcceptanceActivation;
  readonly flow?: CheckoutFlow;
  /** The evolving intent record (state machine transitions return new records). */
  readonly intent?: MerchantPaymentIntent;
  readonly pipeline?: OnchainWritePipeline;
  readonly bundle?: CheckoutAuthorizationBundle;
  /** The wallet payment authorization minted at the trusted surface (lineage + the option paid). */
  readonly authorization?: {
    readonly lineage: WalletAuthorizationLineage;
    readonly option: CheckoutPaymentOption;
  };
  readonly attempt?: CheckoutPaymentAttempt;
  readonly inbox: WebhookInbox;
  readonly refund?: RefundRecord;
  readonly settlement?: MerchantSettlementRecord;
}

/** The injected trusted-surface dependencies (never implemented here). */
export interface MerchantCheckoutTrustedDeps {
  readonly securityPolicy: OnchainSecurityPolicy;
  readonly approvalSurface: TrustedApprovalSurface;
  readonly signerAdapter: SignerAdapter;
  /**
   * The trusted-surface submission boundary: receives the signing request
   * handed off by the kernel and returns the broadcast handoff receipt.
   * This is the wallet integration point — this package never broadcasts.
   */
  submitToTrustedSurface(request: SigningRequest, now: TimestampMs): BroadcastHandoffReceipt;
}

/** The base request envelope: every request carries its own instant. */
export interface ApiRequestBase {
  readonly now: TimestampMs;
}

// ---------------------------------------------------------------------------
// Requests (the merchant + customer journeys)
// ---------------------------------------------------------------------------

export type MerchantCheckoutApiRequest =
  // --- merchant journey ---
  | (ApiRequestBase & {
      readonly kind: "merchant/onboarding.draft";
      readonly input: {
        readonly id: string;
        readonly businessName: string;
        readonly country: string;
        readonly pricingCurrency: string;
        readonly supportContact?: string;
      };
    })
  | (ApiRequestBase & {
      readonly kind: "merchant/onboarding.submit";
    })
  | (ApiRequestBase & {
      readonly kind: "merchant/onboarding.verify";
      readonly verificationRef: string;
    })
  | (ApiRequestBase & {
      readonly kind: "merchant/onboarding.activate";
      readonly settlementDestination: MerchantSettlementDestination;
    })
  | (ApiRequestBase & {
      readonly kind: "merchant/onboarding.update";
      readonly businessName?: string;
      readonly supportContact?: string;
    })
  | (ApiRequestBase & {
      readonly kind: "merchant/acceptance.activate";
      readonly policyInput: {
        readonly id: string;
        readonly merchantRef: string;
        readonly basePolicyId: string;
        readonly assets: readonly import("@payswap/merchant-crypto").CryptoAssetAcceptance[];
        readonly quoteValidityMs: bigint;
      };
      readonly basePolicy: PaymentAcceptancePolicy;
    })
  | (ApiRequestBase & {
      readonly kind: "merchant/acceptance.deactivate";
      readonly reason: string;
    })
  // --- customer journey ---
  | (ApiRequestBase & {
      readonly kind: "checkout/session.open";
      readonly flowId: string;
      readonly basePolicy: PaymentAcceptancePolicy;
      readonly cart: { readonly amount: Money };
      readonly quotes: readonly CryptoQuote[];
      readonly railBindings: readonly RailAssetBinding[];
      readonly expiresAt: TimestampMs;
    })
  | (ApiRequestBase & {
      readonly kind: "checkout/option.prepare";
      readonly optionId: string;
      readonly customerWalletAddress: string;
      readonly destinationAddress: string;
      readonly writeId: string;
      readonly requestedBy: string;
      readonly principal: Principal;
      readonly securityState: OnchainSecurityState;
      readonly simulation?: SimulationObservation;
    })
  | (ApiRequestBase & {
      readonly kind: "checkout/option.authorize";
      readonly approverRef: string;
      readonly securityState: OnchainSecurityState;
      readonly expiresAt: TimestampMs;
      readonly signingRequestId: string;
    })
  | (ApiRequestBase & {
      readonly kind: "payment/attempt.submit";
      readonly attemptId: string;
    })
  | (ApiRequestBase & {
      readonly kind: "payment/attempt.observe";
      readonly observation: AttemptOutcomeObservation;
    })
  | (ApiRequestBase & {
      readonly kind: "payment/attempt.resolve";
      readonly resolution: import("@payswap/settlement").UnknownOutcomeResolution;
    })
  | (ApiRequestBase & {
      readonly kind: "webhook/event.process";
      readonly event: MerchantCheckoutWebhookEvent;
      handler(event: MerchantCheckoutWebhookEvent): void;
    })
  | (ApiRequestBase & {
      readonly kind: "refund/initiate";
      readonly refundId: string;
      readonly amount: Money;
      readonly railSupport: RailRefundSupportObservation;
      readonly destinationRef: string;
      readonly recourse: RecoursePolicyKind;
    })
  | (ApiRequestBase & {
      readonly kind: "refund/observe";
      readonly observation: RefundOutcomeObservation;
    })
  | (ApiRequestBase & {
      readonly kind: "settlement/route.select";
      readonly desiredMode: MerchantStripeSettlementMode;
      readonly native?: {
        readonly connectedInstance: ConnectedCapabilityInstance;
        readonly stripeAccountRef?: string;
        readonly settlementCurrency: string;
        readonly supportedAssets: readonly string[];
        readonly evidenceRefs: readonly string[];
      };
      readonly external: {
        readonly destination: MerchantSettlementDestination;
        readonly conversionChain: readonly string[];
      };
      readonly modeConfig: MerchantSettlementModeConfig;
    })
  | (ApiRequestBase & {
      readonly kind: "settlement/attempt.settle";
      readonly settlementId: string;
      readonly selection: SettlementRouteSelection;
      readonly confirmationInput?: {
        readonly confirmationId: string;
        readonly connectedInstanceId: string;
        readonly stripeBalanceTxRef: string;
        readonly amount: Money;
        readonly providerStateEnvelopeRef: string;
        readonly evidenceIds: readonly string[];
      };
      readonly protocolInstructionId: string;
      readonly protocolSettlementAttemptIds: readonly string[];
    })
  | (ApiRequestBase & { readonly kind: "status/view" });

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/** The response envelope: typed success payload or a fail-closed error. */
export type MerchantCheckoutApiResponse =
  | { readonly kind: "merchant/onboarding"; readonly profile: MerchantProfile }
  | { readonly kind: "merchant/acceptance"; readonly activation: CryptoAcceptanceActivation; readonly offerView: ReturnType<typeof acceptanceOfferView> }
  | { readonly kind: "checkout/session.open"; readonly flow: CheckoutFlow; readonly optionIds: readonly string[] }
  | {
      readonly kind: "checkout/option.prepare";
      readonly status: "PREPARED";
      readonly option: CheckoutPaymentOption;
      readonly bundle: CheckoutAuthorizationBundle;
    }
  | {
      readonly kind: "checkout/option.prepare";
      readonly status: "GATE_BLOCKED" | "GATE_UNKNOWN";
      readonly optionId: string;
      readonly decision: import("@payswap/onchain-security").GateDecision;
    }
  | {
      readonly kind: "checkout/option.authorize";
      readonly status: "AUTHORIZED";
      readonly lineage: WalletAuthorizationLineage;
    }
  | {
      readonly kind: "checkout/option.authorize";
      readonly status: "VOIDED_BY_RECHECK";
      readonly reason: string;
    }
  | { readonly kind: "payment/attempt"; readonly attempt: CheckoutPaymentAttempt; readonly intent: MerchantPaymentIntent }
  | { readonly kind: "webhook/event.process"; readonly result: WebhookProcessingResult }
  | { readonly kind: "refund/initiate"; readonly initiation: RefundInitiationResult }
  | { readonly kind: "refund/observe"; readonly refund: RefundRecord }
  | { readonly kind: "settlement/route.select"; readonly selection: SettlementRouteSelection }
  | { readonly kind: "settlement/attempt.settle"; readonly settlement: MerchantSettlementRecord }
  | {
      readonly kind: "status/view";
      readonly profile?: MerchantProfile;
      readonly activation?: CryptoAcceptanceActivation;
      readonly flow?: CheckoutFlow;
      readonly intent?: MerchantPaymentIntent;
      readonly attempt?: CheckoutPaymentAttempt;
      readonly refund?: RefundRecord;
      readonly settlement?: MerchantSettlementRecord;
      readonly inbox: WebhookInbox;
    };

/** The dispatch result: the updated context plus the typed response. */
export interface MerchantCheckoutApiDispatch {
  readonly context: MerchantCheckoutApiContext;
  readonly response: MerchantCheckoutApiResponse;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

function requireProfile(context: MerchantCheckoutApiContext): MerchantProfile {
  const profile = context.profile;
  if (profile === undefined) {
    throw new ValidationError("the operation requires an onboarded merchant (no profile in context)");
  }
  return profile;
}

function requireActivation(context: MerchantCheckoutApiContext): CryptoAcceptanceActivation {
  const activation = context.activation;
  if (activation === undefined) {
    throw new ValidationError("the operation requires an activated crypto acceptance");
  }
  return activation;
}

function requireFlow(context: MerchantCheckoutApiContext): CheckoutFlow {
  const flow = context.flow;
  if (flow === undefined) {
    throw new ValidationError("the operation requires an open checkout flow");
  }
  return flow;
}

/**
 * Dispatch one typed API request over the session context. Every branch
 * composes the REAL package functions; the context evolves functionally
 * (new frozen records). Fail-closed on precondition violations.
 */
export function dispatchMerchantCheckoutApi(
  context: MerchantCheckoutApiContext,
  deps: MerchantCheckoutTrustedDeps,
  request: MerchantCheckoutApiRequest,
): MerchantCheckoutApiDispatch {
  const inbox = context.inbox ?? emptyWebhookInbox();
  const base: MerchantCheckoutApiContext = { ...context, inbox };

  switch (request.kind) {
    case "merchant/onboarding.draft": {
      const profile = draftMerchant({ ...request.input, now: request.now });
      return { context: { ...base, profile }, response: { kind: "merchant/onboarding", profile } };
    }
    case "merchant/onboarding.submit": {
      const profile = submitMerchantApplication(requireProfile(base), request.now);
      return { context: { ...base, profile }, response: { kind: "merchant/onboarding", profile } };
    }
    case "merchant/onboarding.verify": {
      const profile = verifyMerchant(requireProfile(base), {
        verificationRef: request.verificationRef,
        now: request.now,
      });
      return { context: { ...base, profile }, response: { kind: "merchant/onboarding", profile } };
    }
    case "merchant/onboarding.activate": {
      const profile = activateMerchant(requireProfile(base), {
        settlementDestination: request.settlementDestination,
        now: request.now,
      });
      return { context: { ...base, profile }, response: { kind: "merchant/onboarding", profile } };
    }
    case "merchant/onboarding.update": {
      const profile = updateMerchantProfile(requireProfile(base), {
        ...(request.businessName !== undefined ? { businessName: request.businessName } : {}),
        ...(request.supportContact !== undefined
          ? { supportContact: request.supportContact }
          : {}),
        now: request.now,
      });
      return { context: { ...base, profile }, response: { kind: "merchant/onboarding", profile } };
    }
    case "merchant/acceptance.activate": {
      const activation = activateCryptoAcceptance({
        id: `activation:${requireProfile(base).id}:${request.now}`,
        merchant: requireProfile(base),
        policyInput: request.policyInput,
        basePolicy: request.basePolicy,
        now: request.now,
      });
      return {
        context: { ...base, activation },
        response: {
          kind: "merchant/acceptance",
          activation,
          offerView: acceptanceOfferView(activation),
        },
      };
    }
    case "merchant/acceptance.deactivate": {
      const activation = deactivateCryptoAcceptance(requireActivation(base), {
        reason: request.reason,
        now: request.now,
      });
      return {
        context: { ...base, activation },
        response: {
          kind: "merchant/acceptance",
          activation,
          offerView: acceptanceOfferView(activation),
        },
      };
    }
    case "checkout/session.open": {
      const profile = requireProfile(base);
      const activation = requireActivation(base);
      const flow = openCheckoutFlow({
        id: request.flowId,
        merchantId: profile.id,
        activation,
        basePolicy: request.basePolicy,
        cart: request.cart,
        quotes: request.quotes,
        railBindings: request.railBindings,
        now: request.now,
        expiresAt: request.expiresAt,
      });
      return {
        context: { ...base, flow, intent: flow.intent },
        response: {
          kind: "checkout/session.open",
          flow,
          optionIds: Object.freeze(flow.options.map((option) => option.optionId)),
        },
      };
    }
    case "checkout/option.prepare": {
      const flow = requireFlow(base);
      const option = checkoutOption(flow, request.optionId);
      if (option.kind !== "CRYPTO_WALLET_PAYMENT") {
        throw new ValidationError(
          "only a CRYPTO_WALLET_PAYMENT option can be prepared for wallet payment",
          { optionId: option.optionId },
        );
      }
      const { pipeline } = prepareCheckoutWrite({
        flow,
        optionId: request.optionId,
        customerWalletAddress: request.customerWalletAddress,
        destinationAddress: request.destinationAddress,
        writeId: request.writeId,
        requestedBy: request.requestedBy,
        policy: deps.securityPolicy,
        now: request.now,
      });
      if (request.simulation !== undefined) {
        pipeline.simulate(request.simulation, Number(request.now));
      }
      const decision = pipeline.runGates(request.securityState, Number(request.now));
      if (decision.decision !== "ALLOW") {
        return {
          context: { ...base, pipeline },
          response: {
            kind: "checkout/option.prepare",
            status: decision.decision === "BLOCK" ? "GATE_BLOCKED" : "GATE_UNKNOWN",
            optionId: option.optionId,
            decision,
          },
        };
      }
      const bundle = buildCheckoutAuthorization({
        pipeline,
        requestId: `authreq:${option.optionId}:${request.now}`,
        principal: request.principal,
        merchantName: requireProfile(base).businessName,
        option,
        customerWalletAddress: request.customerWalletAddress,
        destinationAddress: request.destinationAddress,
        now: request.now,
      });
      return {
        context: { ...base, pipeline, bundle },
        response: { kind: "checkout/option.prepare", status: "PREPARED", option, bundle },
      };
    }
    case "checkout/option.authorize": {
      const pipeline = base.pipeline;
      const bundle = base.bundle;
      const flow = requireFlow(base);
      if (pipeline === undefined || bundle === undefined) {
        throw new ValidationError(
          "authorization requires a prepared option (run checkout/option.prepare first)",
        );
      }
      const option = flow.options.find(
        (candidate) =>
          candidate.kind === "CRYPTO_WALLET_PAYMENT" &&
          candidate.railBinding.chainRef === pipeline.prepared.chain,
      );
      if (option === undefined || option.kind !== "CRYPTO_WALLET_PAYMENT") {
        throw new ValidationError(
          "the prepared write does not match any crypto option of the open flow",
        );
      }
      authorizeCheckoutPayment(pipeline, {
        surface: deps.approvalSurface,
        approverRef: request.approverRef,
        securityState: request.securityState,
        expiresAt: request.expiresAt,
        now: request.now,
      });
      // Pre-broadcast recheck: re-observe the same authorized write against
      // the fresh security state (deterministic walk).
      const recheck = recheckCheckoutPayment(
        pipeline,
        recheckObservationFor(pipeline, request.securityState, request.now),
        request.now,
      );
      if (recheck.outcome !== "RECHECK_OK") {
        return {
          context: { ...base },
          response: {
            kind: "checkout/option.authorize",
            status: "VOIDED_BY_RECHECK",
            reason: "the pre-broadcast recheck observed drift — the authorization is voided and must be re-requested",
          },
        };
      }
      const signingRequest = handOffForBroadcast(pipeline, {
        requestId: request.signingRequestId,
        adapter: deps.signerAdapter,
        now: request.now,
      });
      const receipt = deps.submitToTrustedSurface(signingRequest, request.now);
      const lineage = walletPaymentAuthorizationLineage({
        bundle,
        signingRequest,
        handoffReceipt: receipt,
        chainRef: signingRequest.chain,
      });
      // The intent moves to confirmation once the payment was submitted.
      const intent = confirmIntentSubmission(
        attachMethodToIntent(flow.intent, request.now),
        request.now,
      );
      return {
        context: { ...base, intent, authorization: { lineage, option } },
        response: { kind: "checkout/option.authorize", status: "AUTHORIZED", lineage },
      };
    }
    case "payment/attempt.submit": {
      const flow = requireFlow(base);
      const authorization = base.authorization;
      const intent = base.intent;
      if (authorization === undefined || intent === undefined) {
        throw new ValidationError(
          "an attempt submission requires an authorized wallet payment (prepare + authorize first)",
        );
      }
      if (authorization.option.kind !== "CRYPTO_WALLET_PAYMENT") {
        throw new ValidationError("the authorized option must be a crypto wallet payment");
      }
      if (authorization.option.quote.fiatAmount.currency !== flow.intent.amount.currency) {
        throw new ValidationError(
          "the authorized option must price the open flow's cart currency",
        );
      }
      const attempt = submitWalletPaymentAttempt({
        attemptId: request.attemptId,
        intent,
        quote: authorization.option.quote,
        authorization: authorization.lineage,
        now: request.now,
      });
      return {
        context: { ...base, attempt },
        response: { kind: "payment/attempt", attempt, intent },
      };
    }
    case "payment/attempt.observe": {
      const attemptRecord = base.attempt;
      const intent = base.intent;
      if (attemptRecord === undefined || intent === undefined) {
        throw new ValidationError("observing an outcome requires a submitted attempt");
      }
      const attempt = observeAttemptOutcome(attemptRecord, request.observation, request.now);
      const nextIntent = settleIntentOutcome(intent, attempt, {
        evidenceIds: request.observation.evidenceIds,
        now: request.now,
      });
      return {
        context: { ...base, attempt, intent: nextIntent },
        response: { kind: "payment/attempt", attempt, intent: nextIntent },
      };
    }
    case "payment/attempt.resolve": {
      const attemptRecord = base.attempt;
      const intent = base.intent;
      if (attemptRecord === undefined || intent === undefined) {
        throw new ValidationError("resolving an ambiguity requires an attempt");
      }
      const attempt = resolveAttemptUnknown(attemptRecord, request.resolution, request.now);
      const nextIntent = settleIntentOutcome(intent, attempt, {
        evidenceIds: request.resolution.evidenceIds,
        now: request.now,
      });
      return {
        context: { ...base, attempt, intent: nextIntent },
        response: { kind: "payment/attempt", attempt, intent: nextIntent },
      };
    }
    case "webhook/event.process": {
      const result = processWebhookEvent(inbox, request.event, request.handler);
      return {
        context: { ...base, inbox: result.inbox },
        response: { kind: "webhook/event.process", result: result.result },
      };
    }
    case "refund/initiate": {
      const attemptRecord = base.attempt;
      const flow = base.flow;
      if (attemptRecord === undefined || flow === undefined) {
        throw new ValidationError("a refund requires a payment attempt in context");
      }
      const initiation = initiateRefund({
        refundId: request.refundId,
        attempt: attemptRecord,
        originalAmount: flow.intent.amount,
        amount: request.amount,
        railSupport: request.railSupport,
        destinationRef: request.destinationRef,
        recourse: request.recourse,
        now: request.now,
      });
      const nextContext: MerchantCheckoutApiContext =
        initiation.outcome === "REFUND_STARTED"
          ? { ...base, refund: initiation.refund }
          : base;
      return {
        context: nextContext,
        response: { kind: "refund/initiate", initiation },
      };
    }
    case "refund/observe": {
      const refund = base.refund;
      if (refund === undefined) {
        throw new ValidationError("observing a refund requires an initiated refund");
      }
      const observed = observeRefundOutcome(refund, request.observation, request.now);
      return {
        context: { ...base, refund: observed },
        response: { kind: "refund/observe", refund: observed },
      };
    }
    case "settlement/route.select": {
      const selection = selectSettlementRoute({
        desiredMode: request.desiredMode,
        ...(request.native !== undefined ? { native: request.native } : {}),
        external: request.external,
      });
      return {
        context: { ...base },
        response: { kind: "settlement/route.select", selection },
      };
    }
    case "settlement/attempt.settle": {
      const attemptRecord = base.attempt;
      if (attemptRecord === undefined) {
        throw new ValidationError("settling requires a payment attempt in context");
      }
      const settled = settleConfirmedAttempt({
        settlementId: request.settlementId,
        attempt: attemptRecord,
        selection: request.selection,
        ...(request.confirmationInput !== undefined
          ? { confirmationInput: request.confirmationInput }
          : {}),
        protocolInstructionId: request.protocolInstructionId,
        protocolSettlementAttemptIds: request.protocolSettlementAttemptIds,
        now: request.now,
      });
      return {
        context: { ...base, attempt: settled.attempt, settlement: settled.settlement },
        response: { kind: "settlement/attempt.settle", settlement: settled.settlement },
      };
    }
    case "status/view": {
      return {
        context: base,
        response: {
          kind: "status/view",
          ...(base.profile !== undefined ? { profile: base.profile } : {}),
          ...(base.activation !== undefined ? { activation: base.activation } : {}),
          ...(base.flow !== undefined ? { flow: base.flow } : {}),
          ...(base.intent !== undefined ? { intent: base.intent } : {}),
          ...(base.attempt !== undefined ? { attempt: base.attempt } : {}),
          ...(base.refund !== undefined ? { refund: base.refund } : {}),
          ...(base.settlement !== undefined ? { settlement: base.settlement } : {}),
          inbox,
        },
      };
    }
    default:
      throw new ValidationError("the API request kind is not declared", {
        kind: (request as { kind: string }).kind,
      });
  }
}

/** Deterministic recheck observation for the authorized write (same payload, fresh state). */
function recheckObservationFor(
  pipeline: OnchainWritePipeline,
  securityState: OnchainSecurityState,
  now: TimestampMs,
): import("@payswap/onchain-security").RecheckObservation {
  const write = pipeline.prepared;
  return {
    writeId: write.writeId,
    observedAt: Number(now),
    chain: write.chain,
    writeDigest: write.writeDigest,
    ...(write.transfer !== undefined
      ? {
          transfer: {
            asset: write.transfer.asset,
            amount: write.transfer.amount,
            to: write.transfer.to,
          },
        }
      : {}),
    approvals: write.approvals,
    routeHash: write.route.routeHash,
    ...(write.nonce !== undefined ? { nonce: write.nonce } : {}),
    ...(write.protocol !== undefined ? { protocol: write.protocol } : {}),
    ...(write.settlementInstruction !== undefined
      ? { settlementInstruction: write.settlementInstruction }
      : {}),
    securityState,
  };
}

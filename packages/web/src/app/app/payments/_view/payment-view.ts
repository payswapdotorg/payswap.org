/**
 * UX-004 — the payment view-model: PURE types + derivations for the
 * money-movement workflows and the object-detail anatomy (contracts 04/05/07).
 *
 * LAWS honored structurally:
 * - money is exact integer minor-unit arithmetic (BigInt only — no float
 *   anywhere on a money path; AGENTS.md rule 3 / INV-F01);
 * - outcome states are the certified eight-state vocabulary consumed from
 *   @payswap/design (`OutcomeState`), NEVER re-defined here;
 * - failure reasons come from the certified @payswap/ux error-reason
 *   registry — this module maps API error CODES onto registry ids through
 *   ONE typed table (fail-closed: unmapped codes render no registry label,
 *   only the verbatim technical detail — never an invented free-text reason);
 * - UNKNOWN outcomes project to `processing`/`dropped`, never `failed`
 *   (INV-X01) — the projection helpers are consumed from @payswap/ux;
 * - copy affordances never carry secrets: identifiers are copyable, secret
 *   material is masked upstream by the data source and never enters a copy
 *   affordance.
 *
 * Pure data + pure derivations only: no DOM, no network, no env, no clock.
 */

import type { OutcomeState } from "@payswap/design";
import type { ErrorReasonId, ErrorReason } from "@payswap/ux";
import { composeErrorSentence, errorReasonById } from "@payswap/ux";

// ---------------------------------------------------------------------------
// Money (exact minor-unit arithmetic — BigInt only)
// ---------------------------------------------------------------------------

/** An exact amount: integer minor units + the asset/currency code. */
export interface MoneyView {
  /** Integer minor units as a decimal string (e.g. "25000000" = 25 USDC). */
  readonly minorUnits: string;
  readonly currency: string;
}

/** Minor-unit exponents per asset code (default 2). Exact, never rounded. */
const ASSET_EXPONENTS: Readonly<Record<string, number>> = Object.freeze({
  USDC: 6,
  USDT: 6,
  BTC: 8,
  ETH: 18,
});

/** The minor-unit exponent of an asset code (fiat default: 2). */
export function assetExponent(currency: string): number {
  return ASSET_EXPONENTS[currency.toUpperCase()] ?? 2;
}

function pow10(exp: number): bigint {
  return 10n ** BigInt(exp);
}

/**
 * Format minor units as an exact human amount — "25000000" USDC → "25",
 * "1050" EUR → "10.50", "1" USDC → "0.000001". NEVER rounds: an exact
 * decimal always exists because the exponent divides the unit. An invalid
 * minor-units string renders verbatim (this formatter never invents digits).
 */
export function formatMinorUnits(minorUnits: string, currency: string): string {
  const trimmed = minorUnits.trim();
  if (!/^\d+$/.test(trimmed)) {
    return trimmed;
  }
  const exp = assetExponent(currency);
  const value = BigInt(trimmed);
  const whole = value / pow10(exp);
  const frac = value % pow10(exp);
  if (frac === 0n) {
    return whole.toLocaleString("en-US");
  }
  const fracDigits = frac.toString().padStart(exp, "0");
  return `${whole.toLocaleString("en-US")}.${fracDigits}`;
}

/** "25 USDC" — the amount-cell / header format ("X CUR", contract 03 §2.1). */
export function formatMoney(money: MoneyView): string {
  return `${formatMinorUnits(money.minorUnits, money.currency)} ${money.currency.toUpperCase()}`;
}

/** Exact subtraction (fees from amount); null when the inputs are not integers. */
export function subtractMoney(amount: MoneyView, part: MoneyView): MoneyView | null {
  if (!/^\d+$/.test(amount.minorUnits) || !/^\d+$/.test(part.minorUnits)) {
    return null;
  }
  return {
    minorUnits: (BigInt(amount.minorUnits) - BigInt(part.minorUnits)).toString(),
    currency: amount.currency,
  };
}

/**
 * Parse a human decimal amount into exact minor units ("25" USDC →
 * "25000000"). Returns null for anything that is not a plain non-negative
 * decimal with no more fractional digits than the asset allows — the W1 form
 * blocks submission on null (never silently rounds).
 */
export function parseAmountToMinorUnits(
  text: string,
  currency: string,
): string | null {
  const normalized = text.trim().replace(/,/g, "");
  if (!/^\d+(?:\.\d+)?$/.test(normalized) || normalized === "0") {
    return null;
  }
  const [whole, frac = ""] = normalized.split(".");
  const exp = assetExponent(currency);
  if (frac.length > exp) {
    return null; // more precision than the asset carries — never round
  }
  const padded = frac.padEnd(exp, "0");
  return BigInt(whole + padded).toString();
}

// ---------------------------------------------------------------------------
// The failure-reason bridge (contract 07 — registry ids, never free text)
// ---------------------------------------------------------------------------

/**
 * THE typed mapping from the authoritative API's error codes onto the
 * certified error-reason registry. Fail-closed: an unmapped code maps to
 * null and the surface renders ONLY the verbatim technical detail (never an
 * invented label). Extending this table is a typed, reviewable change — the
 * anti-pattern is inline free-text at a render site.
 */
const API_ERROR_CODE_TO_REASON_ID: Readonly<Record<string, ErrorReasonId>> = Object.freeze({
  insufficient_balance: "insufficient-balance",
  wallet_insufficient_balance: "insufficient-balance",
  payment_reverted: "payment-reverted",
  execution_reverted: "payment-reverted",
  transfer_reverted: "payment-reverted",
  no_viable_route: "route-unavailable",
  route_no_viable_route: "route-unavailable",
  slippage_beyond_limit: "slippage-beyond-limit",
  execution_slippage_exceeded: "slippage-beyond-limit",
  transaction_dropped: "transaction-dropped",
  chain_transaction_dropped: "transaction-dropped",
  timed_out_awaiting_confirmation: "timed-out-awaiting-confirmation",
  confirmation_timeout: "timed-out-awaiting-confirmation",
  blocked_by_security_policy: "blocked-by-security-policy",
  policy_blocked: "blocked-by-security-policy",
  compliance_blocked: "blocked-by-security-policy",
  cancelled_by_user: "cancelled-by-user",
  user_cancelled: "cancelled-by-user",
});

/** Look up the registry reason for an API error code (null = unmapped). */
export function errorReasonIdFromApiCode(code: string): ErrorReasonId | null {
  return API_ERROR_CODE_TO_REASON_ID[code] ?? null;
}

/** Registry lookup for a payment's recorded failure reason (fail-closed). */
export function failureReasonFor(reasonId: ErrorReasonId | undefined): ErrorReason | null {
  if (reasonId === undefined) {
    return null;
  }
  try {
    return errorReasonById(reasonId);
  } catch {
    // An unknown id is a data error, not a free-text license: render no
    // registry label (the verbatim technical detail still shows).
    return null;
  }
}

/**
 * Compose the contract-07 §4 anatomy sentence for a certified reason id —
 * `[What happened] — [Why] — [What you can do now]` — from the registry row
 * (never free text). Null when the id is not in the registry (fail-closed).
 */
export function composeRegistrySentence(reasonId: ErrorReasonId): string | null {
  const reason = failureReasonFor(reasonId);
  return reason === null ? null : composeErrorSentence(reason);
}

// ---------------------------------------------------------------------------
// The payment record view (the anatomy's data shape)
// ---------------------------------------------------------------------------

/** The world a record lives in (drives the environment marking). */
export type PaymentEnvironment = "test" | "live";

/** Where a rendered record came from — stated, never implied. */
export type PaymentRecordSource = "api" | "test-fixture";

/** One method check ("CVC check: Passed" analogue). */
export interface MethodCheckView {
  readonly label: string;
  readonly passed: boolean;
  /** Honest "not available" rendering when the check was not run. */
  readonly detail?: string;
}

/** Masked method details (contract 05 §2.3 — masked by the data source). */
export interface PaymentMethodView {
  readonly kind: "card" | "wallet" | "bank-transfer" | "manual";
  /** Pre-masked display line: "Visa •••• 4242" / "Wallet 0x12…ab90". */
  readonly maskedLine: string;
  /** The FULL public identifier (never a secret) for the raw detail card. */
  readonly fullIdentifier: string;
  readonly rail: string;
  readonly expiry?: string;
  readonly checks: readonly MethodCheckView[];
  readonly origin?: string;
  readonly issuer?: string;
}

/** One human event (the audit-trail sentence + the raw row). */
export interface PaymentEventView {
  readonly id: string;
  /** RFC 3339 timestamp (formatting belongs to the app layer). */
  readonly occurredAt: string;
  /** The human sentence for this state change (never a bare code). */
  readonly sentence: string;
  readonly actor?: string;
  /** The raw event row (expandable technical detail). */
  readonly raw?: Readonly<Record<string, string>>;
}

/** One recorded refund on the payment. */
export interface RefundSummaryView {
  readonly id: string;
  readonly amount: MoneyView;
  readonly reasonId?: ErrorReasonId;
  readonly createdAt: string;
}

/** Settlement/payout linkage (contract 05 §3 — expected date → Balances). */
export interface SettlementLinkageView {
  readonly settlementId?: string;
  readonly asset: string;
  readonly rail: string;
  /** Expected settlement date (ISO) — a column/link, never a countdown. */
  readonly expectedDate?: string;
}

/** How the payment is funded (W1's funding-rail section). */
export type FundingRail = "manual-entry" | "on-file" | "hosted-link";

/** The human label of a funding rail (list cells + the W1 radio section). */
export function fundingRailLabel(rail: FundingRail): string {
  switch (rail) {
    case "manual-entry":
      return "Manual entry";
    case "on-file":
      return "Method on file";
    case "hosted-link":
      return "Hosted link";
  }
}

export interface PaymentCounterpartyView {
  readonly name: string;
  readonly email?: string;
  readonly customerId?: string;
}

/**
 * The payment record as the anatomy renders it. Constructed ONLY by the
 * honest data plane (authoritative API fold) or by the clearly-marked TEST
 * fixtures — a component never fabricates one.
 */
export interface PaymentRecordView {
  readonly id: string;
  readonly environment: PaymentEnvironment;
  readonly source: PaymentRecordSource;
  readonly state: OutcomeState;
  /** Technical detail for the StatusChip tooltip. */
  readonly stateDetail?: string;
  readonly createdAt: string;
  readonly amount: MoneyView;
  readonly counterparty: PaymentCounterpartyView;
  readonly description?: string;
  readonly descriptor?: string;
  readonly fundingRail: FundingRail;
  readonly method?: PaymentMethodView;
  /** Registry reason id — present exactly when the payment failed. */
  readonly failureReasonId?: ErrorReasonId;
  /** Verbatim technical detail (API code/message) for the expandable row. */
  readonly failureTechnical?: string;
  readonly settlement?: SettlementLinkageView;
  readonly fees?: MoneyView;
  readonly items?: readonly {
    readonly name: string;
    readonly quantity: number;
    readonly amount: MoneyView;
  }[];
  readonly events: readonly PaymentEventView[];
  readonly refunds: readonly RefundSummaryView[];
  readonly relatedIds?: {
    readonly linkId?: string;
    readonly customerId?: string;
    readonly settlementId?: string;
  };
  readonly receiptsSent: number;
}

// ---------------------------------------------------------------------------
// Derivations for the anatomy
// ---------------------------------------------------------------------------

/** True when source and settlement differ in asset or rail (fees mandatory). */
export function isCrossRail(payment: PaymentRecordView): boolean {
  const settlement = payment.settlement;
  if (settlement === undefined) {
    return false;
  }
  return (
    settlement.asset.toUpperCase() !== payment.amount.currency.toUpperCase() ||
    settlement.rail !== (payment.method?.rail ?? "")
  );
}

/**
 * The MANDATORY cross-rail disclosure sentence (contract 05 §2.3): "Customer
 * paid USDC on Base; settled to you in EUR via optimal route". Rendered on
 * 100% of cross-asset payments (test-enforced).
 */
export function crossRailSentence(payment: PaymentRecordView): string {
  const sourceRail = payment.method?.rail ?? "the source rail";
  return `Customer paid ${payment.amount.currency.toUpperCase()} on ${sourceRail}; settled to you in ${payment.settlement?.asset.toUpperCase() ?? "?"} via ${payment.settlement?.rail ?? "the settlement rail"}`;
}

/** Net = amount − fees (exact); undefined when fees are absent. */
export function netAmountFor(payment: PaymentRecordView): MoneyView | undefined {
  if (payment.fees === undefined) {
    return undefined;
  }
  return subtractMoney(payment.amount, payment.fees) ?? undefined;
}

/** The human strapline ("Charged to <name>" — contract 05 §2.1). */
export function paymentStrapline(payment: PaymentRecordView): string {
  return `Charged to ${payment.counterparty.name}`;
}

/** The remaining refundable amount + totals (exact BigInt arithmetic). */
export interface RefundTotals {
  readonly refunded: MoneyView;
  readonly remaining: MoneyView;
  /** True when part (but not all) of the amount was returned. */
  readonly partial: boolean;
}

export function refundTotalsFor(payment: PaymentRecordView): RefundTotals {
  let refundedMinor = 0n;
  for (const refund of payment.refunds) {
    if (/^\d+$/.test(refund.amount.minorUnits)) {
      refundedMinor += BigInt(refund.amount.minorUnits);
    }
  }
  const total = BigInt(/^\d+$/.test(payment.amount.minorUnits) ? payment.amount.minorUnits : "0");
  const remaining = total - refundedMinor;
  return {
    refunded: { minorUnits: refundedMinor.toString(), currency: payment.amount.currency },
    remaining: { minorUnits: remaining.toString(), currency: payment.amount.currency },
    partial: refundedMinor > 0n && remaining > 0n,
  };
}

/** The remaining-amount line for partially refunded payments (W4). */
export function refundRemainingLine(payment: PaymentRecordView): string | null {
  const totals = refundTotalsFor(payment);
  if (!totals.partial) {
    return null;
  }
  return `${formatMoney(totals.remaining)} still refundable on this payment`;
}

/** The refund consequence line (W4 §2): fees are not returned. */
export function refundConsequenceLine(payment: PaymentRecordView): string {
  const rail = payment.method?.rail ?? "the original rail";
  return `Returns to the customer on ${rail}; fees are not returned.`;
}

/** The primary action for the detail header (the object's next move). */
export type PaymentPrimaryAction =
  | { readonly kind: "refund" }
  | { readonly kind: "retry" }
  | { readonly kind: "send-receipt" }
  | { readonly kind: "none" };

export function paymentPrimaryAction(payment: PaymentRecordView): PaymentPrimaryAction {
  switch (payment.state) {
    case "succeeded":
    case "partially_refunded":
      return { kind: "refund" };
    case "failed":
      return { kind: "retry" };
    case "processing":
    case "dropped":
      return { kind: "send-receipt" };
    default:
      return { kind: "none" };
  }
}

/** True when the W4 refund modal may open on this payment. */
export function refundAvailableFor(payment: PaymentRecordView): boolean {
  return payment.state === "succeeded" || payment.state === "partially_refunded";
}

/** Format an ISO timestamp for display (UTC, stable, locale-free). */
export function formatEventTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)} UTC`;
}

// ---------------------------------------------------------------------------
// The payment-link view (W2 result page)
// ---------------------------------------------------------------------------

/** The CTA wording the merchant picked (contract 04 §2 W2.4). */
export type LinkCtaWording = "pay" | "request" | "donate";

export const LINK_CTA_LABELS: Readonly<Record<LinkCtaWording, string>> = Object.freeze({
  pay: "Pay",
  request: "Request",
  donate: "Donate",
});

export interface PaymentLinkRecordView {
  readonly id: string;
  readonly environment: PaymentEnvironment;
  readonly source: PaymentRecordSource;
  /** The full URL as created (copyable — a public link, never a secret). */
  readonly url: string;
  readonly cta: LinkCtaWording;
  readonly productName: string;
  readonly pricing: { readonly kind: "one-off" | "recurring"; readonly amount: MoneyView };
  /** Payment methods accepted on the link (display list). */
  readonly methods: readonly string[];
  readonly createdAt: string;
}

/** The live estimate line (W2 §5): "1 × 25 USDC = 25 USDC · Total". */
export function linkEstimateLine(
  productName: string,
  amount: MoneyView,
  feeBps: bigint,
): { readonly estimate: string; readonly total: MoneyView } {
  const base = /^\d+$/.test(amount.minorUnits) ? BigInt(amount.minorUnits) : 0n;
  const fee = (base * feeBps) / 10_000n; // exact integer floor — an ESTIMATE
  const total: MoneyView = { minorUnits: (base + fee).toString(), currency: amount.currency };
  const quantityLine = `1 × ${formatMoney(amount)} = ${formatMoney(amount)}`;
  const estimate =
    feeBps === 0n
      ? `${quantityLine} · Total ${formatMoney(total)}`
      : `${quantityLine} · Managed-delivery fee ${Number(feeBps) / 100}% · Estimated total ${formatMoney(total)}`;
  return { estimate, total };
}

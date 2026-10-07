/**
 * UX-004 — the TEST payment fixtures.
 *
 * These records are OBVIOUSLY test data: every id carries the `pay_test_` /
 * `link_test_` prefix, `environment` is "test" and `source` is
 * "test-fixture", and every surface that renders them MUST carry the TEST
 * environment marking (contract 02 §9 / 03 §2.11). They are served ONLY by
 * the payments plane when the deployment explicitly enables
 * WEB_APP_TEST_PAYMENT_FIXTURES — never mixed with authoritative API data,
 * never presented as real money.
 *
 * The set exercises the contract surfaces: a cross-rail settlement (the
 * MANDATORY money-breakdown sentence), a failed payment with a registry
 * reason, a partial refund (the remaining-amount line), an UNKNOWN-style
 * processing payment (never failure), and a manual-entry payment (the
 * statement descriptor).
 */

import type {
  PaymentLinkRecordView,
  PaymentRecordView,
} from "../_view/payment-view.js";

/**
 * Contextual-typing helpers: the literal below is checked DIRECTLY against
 * the view type (so every literal field narrows), then frozen — the registry
 * of fixture records stays immutable.
 */
const paymentFixture = (record: PaymentRecordView): PaymentRecordView =>
  Object.freeze(record);
const linkFixture = (record: PaymentLinkRecordView): PaymentLinkRecordView =>
  Object.freeze(record);

export const PAY_TEST_SUCCEEDED_CROSS_RAIL: PaymentRecordView = paymentFixture({
  id: "pay_test_usdc_base_to_eur",
  environment: "test",
  source: "test-fixture",
  state: "succeeded",
  stateDetail: "Observed with evidence; settled through the optimal route.",
  createdAt: "2026-10-06T09:12:00Z",
  amount: { minorUnits: "25000000", currency: "USDC" },
  counterparty: {
    name: "Amara Okafor",
    email: "amara@example.test",
    customerId: "cus_test_amara",
  },
  description: "Order #1024 — design retainer",
  descriptor: "PAYSWAP*ORDER1024",
  fundingRail: "on-file",
  method: {
    kind: "wallet",
    maskedLine: "Wallet 0x12…ab90",
    fullIdentifier: "0x12ab90cd12ab90cd12ab90cd12ab90cd12ab90cd",
    rail: "Base (USDC)",
    checks: [
      { label: "Signature verified", passed: true },
      { label: "Allowance confirmed", passed: true },
    ],
    origin: "Lagos, NG",
    issuer: "Self-custody wallet",
  },
  failureReasonId: undefined,
  settlement: {
    settlementId: "settle_test_eur_1",
    asset: "EUR",
    rail: "SEPA",
    expectedDate: "2026-10-08",
  },
  fees: { minorUnits: "880000", currency: "USDC" },
  items: [
    { name: "Design retainer — October", quantity: 1, amount: { minorUnits: "25000000", currency: "USDC" } },
  ],
  events: [
    {
      id: "evt_test_settled",
      occurredAt: "2026-10-06T09:31:00Z",
      sentence: "Settled to you in EUR via the optimal route (SEPA)",
      actor: "System",
      raw: { type: "payment.settled", settlementId: "settle_test_eur_1" },
    },
    {
      id: "evt_test_broadcast",
      occurredAt: "2026-10-06T09:12:20Z",
      sentence: "Broadcast confirmed on Base (block 21,904,112)",
      actor: "System",
      raw: { type: "payment.broadcast_confirmed", block: "21904112" },
    },
    {
      id: "evt_test_authorized",
      occurredAt: "2026-10-06T09:12:02Z",
      sentence: "Payment authorized",
      actor: "amara@example.test",
      raw: { type: "payment.authorized" },
    },
    {
      id: "evt_test_started",
      occurredAt: "2026-10-06T09:12:00Z",
      sentence: "Payment started",
      actor: "System",
      raw: { type: "payment.started" },
    },
  ],
  refunds: [],
  relatedIds: {
    customerId: "cus_test_amara",
    settlementId: "settle_test_eur_1",
    linkId: "link_test_retainer",
  },
  receiptsSent: 1,
});

export const PAY_TEST_FAILED_INSUFFICIENT: PaymentRecordView = paymentFixture({
  id: "pay_test_failed_insufficient",
  environment: "test",
  source: "test-fixture",
  state: "failed",
  stateDetail: "The failure reason comes from protocol evidence, not inference.",
  createdAt: "2026-10-05T16:40:00Z",
  amount: { minorUnits: "4500", currency: "EUR" },
  counterparty: {
    name: "Kwame Mensah",
    email: "kwame@example.test",
    customerId: "cus_test_kwame",
  },
  description: "Invoice #218 — consulting",
  fundingRail: "on-file",
  method: {
    kind: "card",
    maskedLine: "Visa •••• 4242",
    fullIdentifier: "card_test_visa_4242",
    rail: "Card (Stripe)",
    expiry: "12/29",
    checks: [
      { label: "CVC check", passed: true },
      { label: "Address check", passed: false, detail: "Not provided" },
    ],
    origin: "Accra, GH",
    issuer: "Test Bank",
  },
  failureReasonId: "insufficient-balance",
  failureTechnical: "API error insufficient_balance (VALIDATION): the source wallet holds less than the payment amount.",
  events: [
    {
      id: "evt_test_failed",
      occurredAt: "2026-10-05T16:40:12Z",
      sentence: "Payment failed — Insufficient balance",
      actor: "System",
      raw: { type: "payment.failed", code: "insufficient_balance" },
    },
    {
      id: "evt_test_attempt_started",
      occurredAt: "2026-10-05T16:40:00Z",
      sentence: "Payment started",
      actor: "System",
      raw: { type: "payment.started" },
    },
  ],
  refunds: [],
  relatedIds: { customerId: "cus_test_kwame" },
  receiptsSent: 0,
});

export const PAY_TEST_PARTIAL_REFUND: PaymentRecordView = paymentFixture({
  id: "pay_test_partial_refund",
  environment: "test",
  source: "test-fixture",
  state: "partially_refunded",
  stateDetail: "Part of the amount was returned; the remainder is still refundable.",
  createdAt: "2026-10-04T11:05:00Z",
  amount: { minorUnits: "25000000", currency: "USDC" },
  counterparty: {
    name: "Amara Okafor",
    email: "amara@example.test",
    customerId: "cus_test_amara",
  },
  description: "Order #1019 — support plan",
  descriptor: "PAYSWAP*ORDER1019",
  fundingRail: "on-file",
  method: {
    kind: "wallet",
    maskedLine: "Wallet 0x12…ab90",
    fullIdentifier: "0x12ab90cd12ab90cd12ab90cd12ab90cd12ab90cd",
    rail: "Base (USDC)",
    checks: [{ label: "Signature verified", passed: true }],
    origin: "Lagos, NG",
    issuer: "Self-custody wallet",
  },
  settlement: {
    settlementId: "settle_test_usdc_2",
    asset: "USDC",
    rail: "Base (USDC)",
    expectedDate: "2026-10-06",
  },
  fees: { minorUnits: "600000", currency: "USDC" },
  items: [
    { name: "Support plan — 3 months", quantity: 1, amount: { minorUnits: "25000000", currency: "USDC" } },
  ],
  events: [
    {
      id: "evt_test_partial_refund",
      occurredAt: "2026-10-05T08:20:00Z",
      sentence: "A partial refund of 10 USDC was issued — 15 USDC remains refundable on this payment",
      actor: "owner@example.test",
      raw: { type: "payment.refund.created", refundId: "re_test_partial", amount: "10000000" },
    },
    {
      id: "evt_test_succeeded_2",
      occurredAt: "2026-10-04T11:07:00Z",
      sentence: "Payment succeeded",
      actor: "System",
      raw: { type: "payment.succeeded" },
    },
    {
      id: "evt_test_started_2",
      occurredAt: "2026-10-04T11:05:00Z",
      sentence: "Payment started",
      actor: "System",
      raw: { type: "payment.started" },
    },
  ],
  refunds: [
    {
      id: "re_test_partial",
      amount: { minorUnits: "10000000", currency: "USDC" },
      reasonId: "cancelled-by-user",
      createdAt: "2026-10-05T08:20:00Z",
    },
  ],
  relatedIds: { customerId: "cus_test_amara", settlementId: "settle_test_usdc_2" },
  receiptsSent: 0,
});

export const PAY_TEST_PROCESSING: PaymentRecordView = paymentFixture({
  id: "pay_test_processing",
  environment: "test",
  source: "test-fixture",
  state: "processing",
  stateDetail: "In flight — the outcome is not yet known, and that is not a failure.",
  createdAt: "2026-10-06T10:02:00Z",
  amount: { minorUnits: "180000", currency: "GHS" },
  counterparty: {
    name: "Kwame Mensah",
    email: "kwame@example.test",
    customerId: "cus_test_kwame",
  },
  description: "Top-up — mobile money",
  fundingRail: "manual-entry",
  descriptor: "PAYSWAP*TOPUP441",
  method: {
    kind: "bank-transfer",
    maskedLine: "Mobile money •••• 8891",
    fullIdentifier: "momochan_test_8891",
    rail: "Mobile money (MTN)",
    checks: [{ label: "Account check", passed: true }],
    origin: "Accra, GH",
  },
  events: [
    {
      id: "evt_test_submitted",
      occurredAt: "2026-10-06T10:02:09Z",
      sentence: "Payment submitted — we're still watching this",
      actor: "System",
      raw: { type: "payment.submitted", intentId: "pay_test_processing" },
    },
    {
      id: "evt_test_started_3",
      occurredAt: "2026-10-06T10:02:00Z",
      sentence: "Payment started",
      actor: "System",
      raw: { type: "payment.started" },
    },
  ],
  refunds: [],
  relatedIds: { customerId: "cus_test_kwame" },
  receiptsSent: 0,
});

/** The TEST payment-link record (the W2 result page in test mode). */
export const LINK_TEST_RETAINER: PaymentLinkRecordView = linkFixture({
  id: "link_test_retainer",
  environment: "test",
  source: "test-fixture",
  url: "https://payswap.link/l/test-retainer-october",
  cta: "pay",
  productName: "Design retainer — October",
  pricing: { kind: "one-off", amount: { minorUnits: "25000000", currency: "USDC" } },
  methods: ["USDC on Base", "Card (Stripe)", "Mobile money (MTN)"],
  createdAt: "2026-10-06T08:00:00Z",
});

/** Every TEST payment fixture (the collection the list renders). */
export const PAY_TEST_FIXTURES: readonly PaymentRecordView[] = Object.freeze([
  PAY_TEST_SUCCEEDED_CROSS_RAIL,
  PAY_TEST_PARTIAL_REFUND,
  PAY_TEST_PROCESSING,
  PAY_TEST_FAILED_INSUFFICIENT,
]);

/** Every TEST payment-link fixture. */
export const LINK_TEST_FIXTURES: readonly PaymentLinkRecordView[] = Object.freeze([
  LINK_TEST_RETAINER,
]);

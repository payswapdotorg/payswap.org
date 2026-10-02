/**
 * @payswap/rails — the first real rail adapters and reconciliation
 * connectors (Work Order W1-005, Stage 5).
 *
 * - Fiat rail (`src/fiat.ts`): payment-intent lifecycle mapped losslessly
 *   through ProviderStateEnvelope (INV-C06), credential-gated — UNKNOWN
 *   availability with provenance while credentials are absent (INV-C01/C02,
 *   BLOCKED-RAILS.md), fail-closed effectful operations (INV-NC04).
 * - Mobile-money rail (`src/mobile-money.ts`): customer-action-required +
 *   mandate semantics preserved; USSD/push patterns represented through
 *   provider state, never flattened (INV-C06).
 * - Crypto rail (`src/crypto.ts`): Ethereum mainnet over a REAL public
 *   JSON-RPC endpoint — read-only balance/transaction lookups;
 *   confirmations → finality CANDIDATES (finality is protocol-owned);
 *   reorg/double-spend → UNKNOWN pending reconciliation (INV-X01);
 *   ExternalFundsPositionObservation with freshness + provenance (INV-C09 —
 *   never custody).
 * - FX source (`src/fx-source.ts`): ECB daily reference rates over the REAL
 *   public feed — exact rational rates, INV-F09 provenance (publisher,
 *   reference, timestamp), staleness → UNKNOWN with provenance retained,
 *   spread/fee disclosure.
 * - Reconciliation connectors (`src/reconciliation-connectors.ts`):
 *   webhook-loss recovery by external object id/revision through the
 *   settlement reconciliation authority (INV-X03), idempotent re-ingestion
 *   and append-only provider-revision merge (INV-C06).
 * - Incident handling (`src/incidents.ts`): outage → UNKNOWN (never a
 *   fabricated business outcome), recovery probes, append-only outage
 *   window evidence for audit.
 * - Stripe production connector (`src/stripe.ts`, P2-W2-001): the REAL
 *   Stripe v1 REST adapter — PaymentIntent/Refund/Dispute/Payout/
 *   Subscription lifecycles mapped losslessly through
 *   ProviderStateEnvelope (INV-C06), customer-action states as
 *   first-class CustomerActionRequirement, Stripe-Signature webhook
 *   verification with replay/dedupe, Idempotency-Key derived from the
 *   protocol key, mid-effect transport failures → OUTCOME_UNKNOWN (INV-X01,
 *   never FAILED), balance/payouts as ExternalFundsPositionObservation
 *   ONLY (INV-C09 — never custody), credentials through the P2-W1-001
 *   control plane (PROVIDER_STRIPE_CREDENTIAL_REF → sealed bundle),
 *   observed-not-assumed account capability scope, the PayPal-on-Stripe
 *   eligibility datum (distinct from PayPal Direct) and the GHS negative
 *   datum as a non-routable eligibility fact.
 *
 * NO SIMULATED SETTLEMENT: an adapter that cannot reach a real provider
 * fails or reports UNKNOWN — it never fabricates a settlement effect, and
 * no mock provider is reachable from any production path.
 */

export const PACKAGE_NAME = "@payswap/rails" as const;

export * from "./support.js";
export * from "./fiat.js";
export * from "./mobile-money.js";
export * from "./crypto.js";
export * from "./fx-source.js";
export * from "./reconciliation-connectors.js";
export * from "./incidents.js";
export * from "./stripe.js";

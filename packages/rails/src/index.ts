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
 * - Paystack production connector (`src/paystack.ts`, P2-W3-001): the REAL
 *   Paystack adapter — hosted payment initialization + verify lifecycle
 *   (the reference preserved as the external id, statuses verbatim,
 *   pending/abandoned/failed/success/paid/reversed classified, verify-timeout
 *   never FAILED), X-Paystack-Signature HMAC-SHA512 webhook verification
 *   (constant-time, raw-body, no fabricated timestamp scheme), bank
 *   enumeration as capability/eligibility evidence (GHS ghipss/NGN/KES/ZAR
 *   probe-verified), refunds, exact minor-unit amounts (kobo/pesewas/cents),
 *   credentials through the control plane
 *   (PROVIDER_PAYSTACK_CREDENTIAL_REF → sealed bundle), honest
 *   unsupported-country states (UNKNOWN, never assumed).
 * - Flutterwave production connector (`src/flutterwave.ts`, P2-W3-001): the
 *   REAL Flutterwave v3 adapter — hosted-checkout transaction lifecycle
 *   (numeric tx id + statuses verbatim: successful/failed/pending/reversed),
 *   the 31-currency wallet observation (incl. the USDC/USDT/RLUSD stablecoin
 *   wallets) as ExternalFundsPositionObservation ONLY (INV-C09 — never
 *   custody, exact bigint major→minor conversion), verif-hash webhook
 *   verification (constant-time secret compare — the scheme signs NO
 *   payload), refunds where supported, credentials through the control
 *   plane (PROVIDER_FLUTTERWAVE_CREDENTIAL_REF → sealed bundle),
 *   eligibility from the probe-verified wallet currencies.
 * - Mobile-money rail (`src/mobile-money.ts`): customer-action-required +
 *   mandate semantics preserved; USSD/push patterns represented through
 *   provider state, never flattened (INV-C06); EXTENDED (P2-W3-001) to the
 *   real MTN MoMo API mapping — OAuth2 Basic token acquisition,
 *   requesttopay lifecycle with X-Reference-Id idempotency and
 *   X-Target-Environment, status-polling reconciliation (reason codes
 *   verbatim), account balance as an ExternalFundsPositionObservation — and
 *   the honest BLOCKED state: the 2026-10-02 probe recorded the sandbox
 *   subscription key rejected at the APIM gate (HTTP 401, collection/
 *   disbursement/remittance), so availability stays UNKNOWN, control-plane
 *   provider calls refuse citing the recorded datum, and NO simulated
 *   substitute exists (lifted only by a successful authenticated re-probe).
 * - Rapyd production connector (`src/rapyd.ts`, P2-W2-002): the REAL
 *   Rapyd v1 adapter — salt/timestamp HMAC-SHA256 request signing (the
 *   documented canonicalization implemented verbatim), pay-in and payout
 *   as SEPARATE coverage families observed only from the connected
 *   account, KYC/document requirement fields as capability PRECONDITIONS,
 *   explicit beneficiary requirements, ACT/CLO/ERR/EXP statuses verbatim
 *   with payment_method_data.next_action as customer-action-required
 *   first-class, wallet observation as ExternalFundsPositionObservation
 *   ONLY (INV-C09), the salt/timestamp webhook verifier, deterministic
 *   client references (INV-F05), credentials through the control plane
 *   (PROVIDER_RAPYD_CREDENTIAL_REF → sealed bundle), fail-closed on the
 *   absent credential (the recorded 2026-10-02 sandbox 401 reachability
 *   datum).
 * - dLocal production connector (`src/dlocal.ts`, P2-W2-002): the REAL
 *   dLocal v6 adapter — V2-HMAC-SHA256 authentication (X-Login/X-Trans-
 *   Key/X-Date + the documented signature string, honest uncertainty
 *   recorded), the full 11-status payment vocabulary verbatim
 *   (PAID=settled-external, CHARGEBACK=dispute family, the provider's
 *   ERROR kept distinct from transport OUTCOME_UNKNOWN), refunds/cancel/
 *   payouts, coverage-as-preconditions from payment-methods/v2, the
 *   X-Signature raw-body webhook verifier, deterministic tracking ids
 *   (INV-F05), credentials through the control plane
 *   (PROVIDER_DLOCAL_CREDENTIAL_REF → sealed bundle), fail-closed on the
 *   absent credential (the recorded host-reachable datum).
 * - Thunes production connector (`src/thunes.ts`, P2-W2-002): the
 *   documented Thunes V2 adapter mapped faithfully — payers/countries/
 *   services coverage observation, quotes, transaction lifecycle
 *   (CREATED/IN_PROGRESS/HELD/CONFIRMED/RECONCILED/CANCELED/FAILED/
 *   RETURNED verbatim; HELD = the compliance-review customer-action
 *   family; CONFIRMED/RECONCILED = settled-external), explicit per-payer
 *   beneficiary requirements as preconditions, the documented V2
 *   api-key authentication and HMAC webhook pattern — with the HONEST
 *   datum that BOTH documented API hosts are GLOBALLY NXDOMAIN (probed
 *   2026-10-02, THUNES_UNRESOLVABLE_ENDPOINT_20261002): availability
 *   UNKNOWN with provenance and every provider-calling operation refuses
 *   citing the datum until the operator confirms the current host (no
 *   simulated substitute; the MTN MoMo honest-BLOCKED pattern).
 * - Adyen production connector (`src/adyen.ts`, P2-W3-002): the REAL
 *   Adyen Checkout API v70 adapter — every resultCode preserved verbatim
 *   (Authorised/Refused/Received/Pending/ConfirmationPending/
 *   RedirectShopper/ChallengeShopper/IdentifyShopper/PresentToShopper/
 *   Cancelled; action objects ride the state verbatim behind first-class
 *   customer-action states), asynchronous modifications (captures/refunds/
 *   cancels/reversals stay processing until webhook evidence), merchant-
 *   observed payment-method eligibility (POST /v70/paymentMethods —
 *   OBSERVED, never assumed), the documented base64(HMAC-SHA256) raw-body
 *   webhook verification with (provider, eventId) dedupe, reference +
 *   Idempotency-Key derivation (INV-F05), payouts as the DISTINCT
 *   observation-only family (INV-C09 — PaySwap executes no Adyen payout),
 *   credentials through the control plane (PROVIDER_ADYEN_CREDENTIAL_REF)
 *   — ABSENT in this deployment, so the rail fails closed with the
 *   recorded HTTP 401 reachability datum.
 * - Airwallex production connector (`src/airwallex.ts`, P2-W3-002): the
 *   REAL Airwallex API v1 adapter — Basic base64(client_id:client_secret)
 *   login + bearer, payment-intent statuses verbatim
 *   (PENDING/AUTHORIZED/CAPTURED/SETTLED/FAILED/CANCELLED/EXPIRED),
 *   observed payment-method eligibility (GET /api/v1/payment_methods/
 *   current), the DISTINCT payout family (POST /api/v1/payouts/create with
 *   an EXPLICIT beneficiary), balances as ExternalFundsPositionObservation
 *   ONLY (INV-C09), X-Signature hex(HMAC-SHA256) raw-body webhook
 *   verification with (provider, eventId) dedupe, request_id idempotency
 *   (INV-F05) with the AirwallexDuplicateRequestIdError provider error
 *   class, credentials through the control plane
 *   (PROVIDER_AIRWALLEX_CREDENTIAL_REF) — ABSENT, fail-closed with the
 *   recorded HTTP 403 reachability datum.
 * - EBANX production connector (`src/ebanx.ts`, P2-W3-002): the REAL EBANX
 *   /ws Direct API adapter on the CURRENT SUPPORTED signing/authentication
 *   path — the integration_key authenticates every request as a JSON body
 *   parameter; webhook notifications are verified by QUERY-BACK (POST
 *   /ws/query is the authoritative evidence; the notification itself is
 *   never trusted); two-letter payment statuses verbatim (PE/OP/CO/CA with
 *   voucher types like boleto as first-class customer-action states
 *   carrying the voucher URL), refunds with explicit partial amounts
 *   (RE/CO/CA verbatim), the DISTINCT payout family (T-Claims with
 *   explicit per-country payee/bank details), balances as
 *   ExternalFundsPositionObservation ONLY (INV-C09),
 *   merchant_payment_code idempotency (INV-F05) with the
 *   EbanxDuplicateMerchantPaymentCodeError provider error class, documented
 *   country/method catalogue recorded as DOCUMENTED_NOT_OBSERVED (never an
 *   eligibility assertion), credentials through the control plane
 *   (PROVIDER_EBANX_CREDENTIAL_REF) — ABSENT, fail-closed with the
 *   recorded HTTP 401 reachability datum.
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
export * from "./paystack.js";
export * from "./flutterwave.js";
export * from "./paypal-direct.js";
export * from "./rapyd.js";
export * from "./dlocal.js";
export * from "./thunes.js";
export * from "./adyen.js";
export * from "./airwallex.js";
export * from "./ebanx.js";

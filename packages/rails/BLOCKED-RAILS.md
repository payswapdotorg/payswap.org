# BLOCKED RAILS — @payswap/rails (W1-005; Stripe P2-W2-001; Paystack/Flutterwave/MTN P2-W3-001; PayPal Direct P2-W1-002)

Rails whose providers require credentials PaySwap does not currently hold.
Per the real-network policy these rails are **NOT simulated**: their adapters
report **UNKNOWN availability with provenance** (INV-C01: capability state and
source availability are separate axes; INV-C02: unreachable/unauthorized
source means availability UNKNOWN — never success, never failure) and every
effectful operation **fails closed** before any provider call (INV-NC04: a
connector cannot imply support for a rail that is not actually reachable AND
authorized). No mock provider exists on any production path, and no
settlement effect is ever fabricated for these rails.

## 1. Fiat rail — Stripe (payment-intent lifecycle)

- Adapter: `StripeShapeFiatRail` + `StripeShapeFiatClient` (`src/fiat.ts`).
- Provider endpoint observed: `https://api.stripe.com/v1/charges` answers
  `HTTP 401` without credentials (endpoint reachable; authorization absent).
  Contact documented in `test/live/credential-gated-rails.live.test.ts`.
- Access required: a Stripe **secret API key** (`sk_test_…` / `sk_live_…`)
  for a connected account, plus (for live rails) a completed Stripe account
  activation with the payment methods in scope enabled.
- Who must grant it: the merchant/account owner or PaySwap operations
  through the Stripe Dashboard (Developers → API keys), delivered into the
  secret store referenced by the env var
  `PAYSWAP_RAILS_FIAT_SECRET_REF` (see CREDENTIAL-ROTATION.md).
- Until granted: `availability()` is UNKNOWN (source axis UNKNOWN), `health()`
  reports DEGRADED/UNKNOWN with explicit reasons, `create`/`update`/
  `executeAction` throw `RailNotAuthorizedError` — no provider call, no
  fabricated outcome, no settlement effect.

## 2. Stripe PRODUCTION connector (`src/stripe.ts`, P2-W2-001) — credential
   supplied, probe-verified, connector REAL; remaining preconditions honest

The real Stripe connector (`StripeConnector` + `StripeProductionRail`) speaks
the Stripe v1 REST API (pinned `Stripe-Version: 2025-08-27.basil`) over the
injected HTTP transport. Status as of 2026-10-02:

- **Credential: SUPPLIED and probe-verified** — operator batch 2026-10-02,
  a Stripe test-mode secret key on account `acct_1FPs7UAkPdhgtN6I` (FR,
  sole_prop, charges_enabled). Authentication VERIFIED by live probe
  (spec/development-state/provider-probes-20261002.json). The repo/manifests
  carry ONLY the control-plane reference: `PROVIDER_STRIPE_CREDENTIAL_REF` →
  `vault://payswap/providers/stripe/test-20261002` — the sealed bundle
  material opens exclusively through the P2-W1-001 CredentialBroker
  connector-runtime path (never env values in deployments, never agent
  context, never logs, never envelopes).
- **Connector: REAL** — PaymentIntent / Refund / Dispute / Payout /
  Subscription lifecycles mapped losslessly through ProviderStateEnvelope
  (INV-C06); Stripe-Signature webhook verification with replay window and
  (provider, eventId) dedupe; Idempotency-Key derived from the protocol key
  (INV-F05) with 409 `idempotency_error` mapped to an error state, never a
  silent success; mid-effect transport failures → OUTCOME_UNKNOWN (INV-X01,
  never FAILED); balance/payouts as ExternalFundsPositionObservation ONLY
  (INV-C09 — observations of provider-held funds, never custody).
- **Remaining honest preconditions** (why this is still not a live rail):
  1. The credential is **test-mode** (`livemode: false`): real money cannot
     move; production requires a live-mode key AND an operator-authorized
     activation through the phase-2 activation machine (P2-W1-001) with the
     gates in spec/development-state/phase-2-state.json satisfied.
  2. **No webhook endpoint is registered at Stripe yet** — the webhook
     signing secret is present in the vault but unproven until an endpoint is
     registered and a real signed event is received and verified end-to-end
     (the verifier, replay window and dedupe are implemented and unit-tested;
     the live delivery path is the remaining datum).
  3. `payouts_enabled: false` on the account — payouts are OBSERVABLE
     (GET /v1/payouts → ExternalFundsPositionObservation) but no payout can
     execute on this account; PaySwap executes no payouts in any case
     (non-custodial law — observation only).
  4. Capability scope is OBSERVED, not assumed: `cartes_bancaires` pending
     and `sepa_debit` inactive on this account (live GET /v1/account);
     PayPal-on-Stripe ELIGIBLE per probe; **GHS non-routable** (negative
     datum: "Stripe accounts in FR do not support ghs" — Ghana-local
     collection routes via Paystack/Flutterwave/MTN).
  5. PayPal-on-Stripe is a **distinct capability** from PayPal Direct
     (different provider, capability id and settlement) — never conflated.
- Until a precondition is lifted: the same fail-closed semantics as every
  rail — no credential path → availability UNKNOWN (INV-C01/C02), health
  DEGRADED/UNKNOWN with reasons, effectful operations throw
  `RailNotAuthorizedError` before any provider call (INV-NC04).

## 3. Mobile-money rail — MTN MoMo (collection / request-to-pay)

- Adapter: `MtnMomoRail` + `MtnMomoClient` (`src/mobile-money.ts`).
- Provider endpoints observed: `https://sandbox.momodeveloper.mtn.com`
  answers on the sandbox host (resource paths require auth; the token
  endpoint `POST /collection/token/` requires Basic credentials).
  Contact documented in `test/live/credential-gated-rails.live.test.ts`.
- Access required: an MTN MoMo **product subscription** (Collection) with
  `Ocp-Apim-Subscription-Key`, plus provisioned API user/key pair
  (`X-Reference-Id` / Basic auth) for bearer-token issuance. Production
  additionally requires a signed MTN merchant agreement per market.
- Who must grant it: MTN Group Fintech (developer portal
  https://momodeveloper.mtn.com) after product subscription approval, and
  the merchant for the collection account.
- Until granted: same fail-closed semantics as the fiat rail
  (`PAYSWAP_RAILS_MOMO_SUBSCRIPTION_KEY_REF`,
  `PAYSWAP_RAILS_MOMO_API_USER_REF`, `PAYSWAP_RAILS_MOMO_API_KEY_REF`).

### 3a. MTN MoMo — the honest BLOCKED state (P2-W3-001, recorded 2026-10-02)

The LIVE probe of 2026-10-02
(spec/development-state/provider-probes-20261002.json) recorded the sandbox
**subscription key REJECTED at the APIM gate** — HTTP 401 "Access denied
due to invalid subscription key" — across the **collection, disbursement
and remittance products**; the API-user/API-key pair was **never
evaluated**. The connector (extended in P2-W3-001 to the real API mapping:
token acquisition, requesttopay lifecycle with X-Reference-Id idempotency
and X-Target-Environment, status-polling reconciliation, account-balance
observation) therefore proceeds **fail-closed with the blocked-probe
reachability documented**:

- **Credential: operator-supplied but probe-BLOCKED** — the vault reference
  `PROVIDER_MTN_MOMO_CREDENTIAL_REF` →
  `vault://payswap/providers/mtn-momo/sandbox-20261002` names exactly the
  credential the probe recorded as rejected. The sealed bundle (subscription
  key + API user + API key) opens only through the P2-W1-001
  CredentialBroker connector-runtime path.
- **Availability: UNKNOWN** (INV-C01/C02) — never AVAILABLE, never
  UNAVAILABLE; the recorded datum
  (`MTN_MOMO_BLOCKED_PROBE_20261002` in `src/mobile-money.ts`) is the
  honest evidence.
- **Effectful operations REFUSE**: on the control-plane path every
  provider-calling operation throws `MtnMomoBlockedProbeError` BEFORE any
  provider call, citing the recorded datum. The gate lifts ONLY through a
  successful authenticated re-probe (`probeAuthentication()` — real
  bearer-token issuance at `POST /collection/token/`) or newer verified
  evidence supplied at construction. The env-driven path (unattributed
  material) stays UNPROBED — the provider answer is the truth there, and
  availability stays UNKNOWN.
- **NO simulated substitute**: no mock MoMo, no fabricated requesttopay
  states, no invented balances. The disbursement/remittance products share
  the blocked-probe status and are recorded in the datum; their SDK surface
  is deliberately not implemented (unverifiable against a rejected
  subscription key — adding it would be dead code pretending to coverage).
- **Re-probe path**: supply a valid subscription key, re-run
  `probeAuthentication()` (the machine-checked counterpart is
  `test/live/mtn-momo-reachability.live.test.ts`); on success the gate
  lifts and operations proceed through the real API.

## 4. Paystack production connector (`src/paystack.ts`, P2-W3-001) —
   credential supplied, probe-verified, connector REAL

The real Paystack connector (`PaystackConnector` + `PaystackProductionRail`)
speaks the Paystack REST API (pinned surface `2026-10-02`) over the injected
HTTP transport. Status as of 2026-10-02:

- **Credential: SUPPLIED and probe-verified** — operator batch 2026-10-02, a
  Paystack test-mode secret key. Authentication VERIFIED by live probe
  (authenticated `GET /v1/bank?currency=GHS` ghipss enumeration; NGN 287
  banks, KES 54, ZAR 33). The repo/manifests carry ONLY the control-plane
  reference: `PROVIDER_PAYSTACK_CREDENTIAL_REF` →
  `vault://payswap/providers/paystack/test-20261002` — the sealed bundle
  material opens exclusively through the P2-W1-001 CredentialBroker
  connector-runtime path.
- **Connector: REAL** — hosted payment initialization + verify lifecycle
  lossless through ProviderStateEnvelope (INV-C06; the `reference` preserved
  as the external id, statuses verbatim: pending/processing/ongoing/success/
  paid/failed/abandoned/reversed); recurring charges over saved
  authorizations (POST /v3/charge); refunds (POST /v3/refund); bank
  enumeration as capability/eligibility evidence with every bank entry
  (name, code, supports_transfer) preserved verbatim; minor-unit amounts
  (kobo/pesewas/cents) exact; `X-Paystack-Signature` = HMAC-SHA512(secret,
  raw body) hex, constant-time, raw-body-required webhook verification with
  (provider, eventId) dedupe (the scheme carries NO timestamp — no
  fabricated window); duplicate reference at initialize → error state
  (`PaystackDuplicateReferenceError`), never a silent success; mid-effect
  transport failures → OUTCOME_UNKNOWN (INV-X01, never FAILED; a
  verify-timeout never produces a FAILED payment).
- **Eligibility honest**: the four probe-verified local-collection bank
  rails (GHS ghipss — exemplar Absa Bank Ghana code 030100 supports_transfer
  — NGN, KES, ZAR) are the ONLY eligibility facts the connector asserts;
  every other country/currency is UNKNOWN — never assumed (the provider is
  the authority).
- **Remaining honest preconditions** (the same test-mode law as Stripe):
  the credential is test-mode — real money cannot move; production requires
  a live-mode key and operator-authorized activation through the phase-2
  activation machine; no webhook endpoint is registered at Paystack yet
  (the verifier, ingestor and dedupe are implemented and unit-tested; the
  live delivery path is the remaining datum).

## 5. Flutterwave production connector (`src/flutterwave.ts`, P2-W3-001) —
   credential supplied, probe-verified, connector REAL

The real Flutterwave connector (`FlutterwaveConnector` +
`FlutterwaveProductionRail`) speaks the Flutterwave v3 API over the injected
HTTP transport. Status as of 2026-10-02:

- **Credential: SUPPLIED and probe-verified** — operator batch 2026-10-02, a
  Flutterwave test secret key. Authentication VERIFIED by live probe
  (authenticated `GET /v3/balances`: 31 currency wallets incl. NGN/KES/GHS/
  USD/EUR/ZAR/XOF/XAF/UGX/TZS/RWF/ETB/ZMW/MWK/MZN/MAD/AED/EGP/MUR and the
  stablecoin wallets USDC 1234.56 / USDT 789.01 / RLUSD 20004.01 test
  balances). The repo/manifests carry ONLY the control-plane reference:
  `PROVIDER_FLUTTERWAVE_CREDENTIAL_REF` →
  `vault://payswap/providers/flutterwave/test-20261002`.
- **Connector: REAL** — hosted-checkout transaction lifecycle (POST
  /v3/payments link generation → GET /v3/transactions/{id}; the numeric tx
  id is the external id, statuses verbatim: successful/failed/pending/
  reversed, the tx_ref rides the state verbatim); refunds where supported
  (POST /v3/refunds); the 31-currency wallet observation (including the
  stablecoin wallets — an honest datum for the Stellar USDC local-rail
  path) as ExternalFundsPositionObservation ONLY (INV-C09 — never custody;
  exact bigint major→minor conversion, unconvertible wallets honestly
  reported); `verif-hash` webhook verification (constant-time secret
  compare — the scheme signs NO payload; integrity is the secret compare +
  (provider, eventId) dedupe, never a fabricated body signature);
  idempotency honesty (tx_ref derived deterministically from the protocol
  key, duplicateBehavior PROVIDER_DEFINED — the provider enforces no
  unique constraint); mid-effect transport failures → OUTCOME_UNKNOWN
  (INV-X01, never FAILED).
- **Eligibility honest**: the 30 probe-verified wallet currencies (27 fiat
  + USDC/USDT/RLUSD) are the only eligibility facts asserted; every other
  currency is UNKNOWN — never assumed.
- **Remaining honest preconditions**: test-mode credential (no real money
  can move); no webhook secret is proven against a live delivery yet (the
  verifier + ingestor are implemented and unit-tested; the dashboard
  endpoint registration and a real event are the remaining datum).

## 6. PayPal Direct production connector (`src/paypal-direct.ts`, P2-W1-002) —
   credential NOT supplied (no Wave-2 credentials held), connector REAL,
   fail-closed

The real PayPal Direct connector (`PayPalDirectConnector` +
`PayPalDirectProductionRail`) speaks the native PayPal REST API (OAuth2
client-credentials + v2 checkout orders + v2 payments
authorizations/captures/refunds + the Payouts API) over the injected HTTP
transport. It is a SEPARATE provider identity from "Stripe PayPal"
(`paypal-direct` vs the stripe provider's `paypal_on_stripe` capability —
different provider, different capability ids, different settlement; the two
are selectable ONLY through their own ConnectedCapabilityInstance eligibility
and are never interchangeable). Status as of 2026-10-02:

- **Credential: NOT SUPPLIED** — the phase-2 fail-closed law applies ("no
  Wave-2 credentials held"): PaySwap holds no PayPal client_id/client_secret
  and no PayPal webhook id. The repo/manifests carry ONLY the control-plane
  reference shape: `PROVIDER_PAYPAL_DIRECT_CREDENTIAL_REF` → a `vault://…`
  reference (to be bound at the vault when a credential is granted; the
  sealed bundle would carry the OAuth2 client-credentials pair and would
  open exclusively through the P2-W1-001 CredentialBroker
  connector-runtime path). Until then: availability is UNKNOWN
  (INV-C01/C02), `health()` reports DEGRADED/UNKNOWN with explicit reasons,
  and every effectful operation throws `RailNotAuthorizedError` BEFORE any
  provider call (INV-NC04). NOTHING is simulated — no fake token endpoint,
  no fabricated order/payout states.
- **Connector: REAL** — the v2 checkout-order lifecycle
  (CREATED/SAVED/APPROVED/COMPLETED/VOIDED verbatim;
  PAYER_ACTION_REQUIRED as a first-class CustomerActionRequirement with the
  approve link preserved), v2 authorizations (capture/reauthorize/void —
  204-void contract honored), v2 captures and refunds (statuses verbatim,
  seller-payable-breakdown reconciliation evidence preserved),
  provider-side webhook verification (POST
  /v1/notifications/verify-webhook-signature with transmission-id/time
  correlation, tolerance window, replay dedupe and event-type mapping),
  PayPal-Request-Id derived from the protocol key (duplicate submits map to
  error/duplicate states, never silent success), mid-effect transport
  failures → OUTCOME_UNKNOWN (INV-X01, never FAILED).
- **Global payout controls (the honest laws)**: the payout destination is
  EXTERNAL and EXPLICIT by construction (`destinationKind: "EXTERNAL"`,
  recipient_type EMAIL/PAYPAL_ID); transfer-out authority is a SEPARATE
  control-plane authorization (`assertTransferOutAuthorized` on an ACTIVE
  ConnectedCapabilityInstance activation — connection scope alone never
  authorizes debit); payout batch/item states are
  ExternalFundsPositionObservation ONLY (INV-C09 — external funds in motion
  toward the explicit external recipient, never custody, and NO balance
  observation is fabricated: PayPal exposes no REST balance endpoint on
  this surface).
- **Country eligibility: FACTS ONLY, none held** — merchant/account-country
  support is represented as eligibility facts on the connected instance
  (`paypalDirectCountryEligibility`); with no connected-instance evidence
  every country verdict is basis UNKNOWN — never assumed eligible, never
  routable (INV-C05/INV-NC04).
- **Who must grant access**: the PayPal account owner or PaySwap operations
  through the PayPal Developer Dashboard (REST app credentials:
  client_id + secret, `payments` + `payouts` scopes; plus the Payouts
  eligibility on the account), delivered into the secret store bound to
  `PROVIDER_PAYPAL_DIRECT_CREDENTIAL_REF` (see CREDENTIAL-ROTATION.md), and
  a configured webhook id after endpoint registration.
- **Live probes**: `test/live/paypal-direct.live.test.ts` is
  credential-gated and SKIPS cleanly while unprovisioned (no network, no
  fabricated outcome). The lift path is exactly the Stripe one: provision
  the credential through the control plane, then re-run the live suite and
  the phase-2 activation machine (P2-W1-001) gates.

## Not blocked (exercised against genuinely reachable public endpoints)

- **Crypto rail (Ethereum mainnet)**: public JSON-RPC
  `https://ethereum-rpc.publicnode.com` — read-only balance / transaction /
  block lookups, no credentials required (public infrastructure).
- **FX source**: European Central Bank daily reference rates
  `https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml` —
  public reference feed, no credentials required.

Both are read-only surfaces: the crypto rail produces finality CANDIDATES and
external-funds OBSERVATIONS (INV-C09 — never custody), and the FX source
produces provenanced exact quotes (INV-F09). Neither can effect settlement
on its own; only protocol-authorized execution may.

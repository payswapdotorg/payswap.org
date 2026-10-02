# BLOCKED RAILS — @payswap/rails (W1-005; Stripe section updated P2-W2-001)

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

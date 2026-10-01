# BLOCKED RAILS — @payswap/rails (W1-005)

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

## 2. Mobile-money rail — MTN MoMo (collection / request-to-pay)

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

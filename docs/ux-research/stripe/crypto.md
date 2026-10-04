Status: PUBLIC-SURFACE RESEARCH — 2026-10-03 (P4-W1-003 Phase 1) — source: public Stripe pages/docs via automated extraction, no authentication

# Stripe crypto/stablecoin surface — the boundaries of "native Stripe crypto settlement"

Sources: R2 notes for `stripe.com/crypto`, the `docs.stripe.com/stablecoins` suite, the availability matrix (`/stablecoins/availability`, captured via the official `.md` docs view), and the payment-method fact sheet (`/payments/stablecoin-payments`), plus R2 `SUMMARY.md`. Cross-batch facts are attributed inline. Quotes are short and verbatim from the published pages.

## Why this matters for PaySwap merchant-crypto contracts

The merchant-crypto packages discriminate two settlement route families: **NATIVE_STRIPE_CRYPTO** (provider-verified only, pass-through native) and **EXTERNAL_PAYSWAP_CONVERSION** (composed, never presented as native). This file is the empirical boundary of the first family. Stripe's public crypto surface defines what "native Stripe crypto settlement" can honestly mean: which products exist, which asset × network × region combinations each supports, how money actually flows (acceptance converts crypto-in to a fiat Stripe balance; payouts convert a fiat balance to stablecoin-out), what recourse does not exist (no disputes or chargebacks on stablecoin acceptance), and which limits are provider-imposed ($10k per transaction). A contract claiming more than this surface provides would misrepresent the provider; a contract ignoring its seams (acceptance and disbursement are different products) would be unimplementable.

## The support matrix (as published at docs.stripe.com/stablecoins/availability)

Five product tabs; only the default tab renders in server HTML — the full matrix was recovered via the `.md` view. Direction columns separate the two sides of each corridor (merchant-side availability vs. where consumers/ recipients can transact from).

| Product | Asset | Networks | Availability (as documented) |
|---|---|---|---|
| Storage (Treasury balances) | OUSD; USDC | Tempo, Base, Solana, Ethereum | US + ~100 other countries (Treasury private preview) |
| Payouts (Global Payouts) | OUSD | Tempo, Base, Solana, Ethereum | Merchants US, EU; payouts to global recipients |
| Payouts (Global Payouts) | USDC | Tempo, Base, Solana, Ethereum, Arbitrum, Avalanche, Optimism, Polygon, Stellar | Merchants US, EU; global recipients |
| Issuing (stablecoin-backed cards) | OUSD | Tempo, Base, Ethereum, Solana | 60+ countries across US, Europe, LATAM, Africa, Asia |
| Issuing (stablecoin-backed cards) | USDC | Base, Ethereum, Solana | same 60+ countries |
| Payments (accept) | OUSD; USDC | Tempo, Base, Solana, Ethereum | Merchants US, EU, HK, MX, CH; consumers Global¹ |
| Payments (accept) | USDG | Ethereum | Merchants US; consumers Global¹ |
| Crypto Onramp | OUSD | Tempo, Base, Solana, Ethereum | Merchants: all Stripe-supported countries; onramp from US, EU |
| Crypto Onramp | USDC | Ethereum, Solana, Polygon, Avalanche, Base, Stellar | onramp from US, EU (EU excludes Avalanche, Base, Polygon, Solana) |
| Crypto Onramp | ETH | Ethereum, Base | US, EU (EU excludes Base) |
| Crypto Onramp | BTC | Bitcoin | US, EU |
| Crypto Onramp | SOL | Solana | US, EU |
| Crypto Onramp | POL | Polygon | US, EU |
| Crypto Onramp | AVAX | Avalanche | US only |
| Crypto Onramp | XLM | Stellar | US (not NY), EU |

¹ "Excludes sanctioned countries" (linked to the legal/restricted-businesses page).

Inline callouts: the payouts tab escalates to Bridge (apidocs.bridge.xyz) for unsupported regions, corridors, assets, or networks; issuing supports "any custom Bridge-issued stablecoin". Adjacent documented surface: Machine Payments Protocol — open protocol co-authored with Tempo, an HTTP 402 challenge flow for agentic payments, stablecoin minimum 0.01 USDC. The marketing umbrella (`stripe.com/crypto`) frames the wider stack: Stripe products + Bridge (stablecoin orchestration) + Privy (wallets) + OUSD + Tempo (payments L1, incubated by Stripe and Paradigm).

## Settlement semantics — two one-way doors

- **Payments (accept): crypto-in → fiat out.** "Funds settle in your Stripe balance in USD" or local currency; presentment USD (other currencies private preview); Stripe manages conversion — "we'll manage the crypto logistics for you". On the surveyed pages there is no crypto-out settlement on the acceptance path (see the Deposit-mode gap note below).
- **Payouts: fiat-in → stablecoin-out.** Connect stablecoin payouts (private preview, US platforms only): "Your platform balance stays in fiat currency, while Stripe handles conversion and payout" — recipients link a wallet in Express Dashboard and get a USDC balance that "works like any other local currency balance"; Transfers in USD auto-convert. Recipients: individuals/sole proprietors in ~60 listed countries, except NY and HI; Tempo transfers use USDC.e. Global Payouts reaches 160+ countries via OutboundPayments v2 (GA) / PayoutIntents (preview), or Link users who hold funds in USD stablecoins within Link (withdrawable to bank or crypto wallet).
- **Treasury: both balances, constrained flow.** Two-way stablecoin ↔ fiat balances with an explicit fund-flow diagram; "You can't move funds from an external fiat account directly to your Stripe stablecoin balance" — everything routes through a Stripe fiat balance.
- **Refunds: stablecoins only.** "Refunds are always returned as stablecoins to the customer's original wallet" — never fiat; partial refunds supported. Integration docs flag an edge case: the token received may use a different contract than the payment — review the refund's transaction_hash on a block explorer.
- **No disputes/chargebacks.** Confirmation is customer-authenticated; "you won't have disputes that turn into chargebacks". Manual capture not supported.
- **Per-transaction cap.** "Customer transaction limits are 10,000 USD per transaction." Payout timing "Varies by network".
- **Consumer flow.** Checkout → redirect to crypto.stripe.com → currency + network selection + wallet connect → completion notification → optional return redirect. crypto.stripe.com itself was intentionally not visited (no-auth rule).
- **Testnet testing.** Testnet assets at no cost; MetaMask + Polygon Amoy testnet (chain 80002) + Circle faucet; POL needed for gas; documented step-by-step including the refund-contract edge case.
- **Activation is gated, not self-serve.** Request the "Stablecoins and Crypto" payment method in the Dashboard → Stripe review → "Pending" → active. US: "available to businesses in all US states, except New York". Onramp access: application, "We review most onramp applications within 48 hours". Connect payouts: sales contact + due diligence questionnaire + additional account requirements.
- **Connect capability.** Acceptance works "for all charge types" but "Each connected account must have the crypto payment method enabled" — full-Dashboard accounts (incl. Standard) self-serve; others request the `crypto_payments` capability from the platform Dashboard or API; verify `active` in the capabilities hash on the Account object.
- **Release-phase labels.** private preview / public preview / GA used consistently and linked to a `/release-phases` explainer. Examples as published: acceptance GA in US, private preview for EU/HK/MX/CH; Treasury balances public preview (US) + private preview (~100 countries); Connect payouts and Link stablecoin payouts private preview; onramp public preview.

## Documentation-consistency observation: USDP and Polygon

The payment-method fact sheet lists accepted tokens as "USDC (Tempo, Ethereum, Solana, Polygon, and Base networks), USDP (Ethereum and Solana, US-only), USDG (Ethereum, US-only)" — while the availability matrix's Payments tab lists OUSD + USDC on Tempo/Base/Solana/Ethereum plus USDG on Ethereum, with no USDP and no Polygon. Both are recorded verbatim as published. The pages appear updated on different cadences or scopes (product matrix vs. payment-method sheet). Contract-relevant consequence: neither list may be hard-coded; asset/network coverage is a provider-observed, time-varying parameter.

## UX patterns worth reusing

- **Escape-hatch routing.** The use-cases page is a routing table that explicitly escalates to Privy for "custom wallet functionality not supported by Stripe Treasury" and to Bridge for "complex use cases that aren't met by Stripe's suite" — coverage gaps are acknowledged in-product, not hidden.
- **Liability transfer on the onramp.** "Stripe acts as the merchant of record... and assumes full liability for all fraud and disputes", plus KYC and sanctions handling — risk moves up-stack by product design, not by settings.
- **Risk control by activation friction.** Every crypto surface is request/review-gated (payment-method request → review; onramp application; sales + due diligence for payouts); preview registration is even a documented endpoint taking preview slugs.
- **Fiat-settlement reassurance as headline.** The core de-risking message for merchants accepting stablecoins is that they never touch crypto logistics.
- **LLM-first docs.** `.md` views, llms.txt, "Copy for LLM", "Ask AI" — the support matrix is machine-readable by design (this survey depended on it).
- **Dynamic payment methods** marked "Recommended": automatic display of the crypto method to eligible customers across Payment Links, Hosted/Embedded Checkout, and Elements.

## PaySwap contract implications

1. **Native route = provider-verified capability, scoped.** Encode NATIVE_STRIPE_CRYPTO acceptance as a provider-verified capability bound to the connected account (mirroring `crypto_payments` on the capabilities hash), with observed state transitions request → pending → active — never a static boolean.
2. **Observed assets/chains, not constants.** The USDP/Polygon discrepancy shows coverage drift between Stripe's own pages; contracts must carry asset/network sets as provider-observed parameters validated at execution time, and the two route families must surface different (honest) capability sources.
3. **External conversion is a separate family.** Stripe's own answer to coverage gaps is a different product layer (Bridge/Privy); PaySwap's EXTERNAL_PAYSWAP_CONVERSION family mirrors this and must never be presented as native settlement.
4. **The settlement leg lands in fiat.** Native acceptance settles to a fiat/USD Stripe balance; merchant-crypto contracts must encode settlement currency and cannot promise crypto-out through the acceptance product — crypto-out is a payout-product concern (fiat-in → stablecoin-out).
5. **Quote expiry must be defined by PaySwap.** No surveyed stablecoin-acceptance page documents a quote or rate-lock model (the pricing page's rate-lock line item is a fiat FX product). Contracts must define time-boxed quote validity themselves; the crypto.stripe.com redirect leaves a customer-side gap (wallet connect, network choice) exactly where quote staleness appears.
6. **No-dispute recourse shape.** Recourse on native stablecoin acceptance is refunds-only (stablecoin-denominated, to the original wallet, partial supported). Contracts must encode and disclose this shape — there is no chargeback path to inherit.
7. **Per-transaction caps are provider-observed limits.** The $10k limit is a provider parameter that can change without notice; model caps as observed limits re-validated per contract, not compile-time constants.

## Honest gaps and fetch failures (from R2)

- The billing stablecoin-subscriptions page returned a variant index only; integration-variant bodies were not retrievable (the reader does not honor query parameters).
- The docs sidebar lists a "Deposit mode stablecoin payments" sibling page that R2 did not survey — whether it offers a crypto-holding acceptance variant is unverified.
- Stablecoin fee numbers are absent from the R2-surveyed crypto pages; R1's pricing-page survey recorded the stablecoin fee as 1.5% of the USD transaction, including conversion to fiat, wallet/AML screening, fraud prevention, and gas sponsorship (see `billing.md`).
- crypto.stripe.com consumer flow and Dashboard activation screens intentionally not visited (no-auth rule); tabbed matrix content invisible in HTML (recovered via `.md` view); transient rate limits on four fetches, all recovered.

## Cross-references

Related files in this set: `public-pages.md` (survey index), `payments.md` (Crypto in checkout cross-sell), `connect.md` (Connect payout patterns), `billing.md` (stablecoin subscriptions gap; pricing notes), `risk.md` (no-chargeback posture, onramp liability), `developers.md` (docs IA, release phases, testnet testing), `settings.md` (activation gating), `pay-swap-ux-mapping.md`, `README.md`.

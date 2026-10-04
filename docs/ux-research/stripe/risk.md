Status: PUBLIC-SURFACE RESEARCH — 2026-10-03 (P4-W1-003 Phase 1) — source: public Stripe pages/docs via automated extraction, no authentication

# Stripe risk, disputes, and security — presentation patterns

Sources: R2 notes for `stripe.com/radar`, `docs.stripe.com/disputes`, `docs.stripe.com/security` (+ R2 `SUMMARY.md`); dispute-state vocabulary cross-checked against R3's test-mode notes. Product-design observations only; Dashboard behavior beyond marketing mocks is not observable from static content.

## Radar: fraud as a lifecycle, not a checkout moment

- Hero: "Stop fraud without stopping growth" — Radar is sold as unified fraud prevention (transaction + account + abuse + disputes) for risk-averse growth owners.
- Framing: "Fraud isn't limited to checkout" — three lifecycle stages, each with named fraud types: **sign-up/onboarding** (account fraud, multi-account abuse, free-trial abuse, account sharing), **payment** (card testing, transaction fraud, bot abuse), **post-purchase** (disputes, negative balances, payouts fraud, pay-as-you-go abuse). Interactive mocks dramatize each stage (business-profile scan with "Threat level: low"; payment analyses with risk scores 98/82/24; early fraud warning).
- **Risk score presentation:** numeric 0–100 + Low/High label + named signals ("Linked to fraudulent accounts", "Dispute history"); the risk-level chip appears as a column value in mock review tables. Outcomes are framed as states: Pending, Fraud detected / not detected, early fraud warning.
- **Quantified trust claims:** 70 trillion training data points; $1.9T payments volume processed in 2025; 11M active Connect-onboarded accounts; "92% likelihood a charge is from a card Stripe has seen before"; "32% average reduction in fraud".
- **Productized responses:** Smart Disputes (automated evidence collection and submission), Verifi/Ethoca prevention programs, Radar rules, risk controls. Processor-agnostic positioning — "Use Radar whether you process payments with Stripe or not" — with risk signals available via API for own-stack scoring.
- Audience tabs for platforms/marketplaces vs AI companies (token-theft prevention; Anthropic's 83% reduction in incorrectly blocked legitimate transactions; FreshBooks' 300 fraudulent accounts blocked in three months).
- FAQ discloses the operating model: "requires no additional setup... Radar is working in the background from day one"; four pricing tiers (Lite/Standard/Plus/Pro) as subscription pricing with a fixed monthly fee including set screen volumes.
- Page mechanics: local sub-nav (Overview / Transaction fraud / Account fraud / Customer abuse / Pricing + Docs); the embedded Dashboard mock navigates Overview / Reviews / Rules / Risk controls / Insights and shows third-party payment evaluations; industry cards (Retail, Travel, SaaS, Marketplaces); a Forrester Wave Leader badge carries an explicit disclaimer; cross-sell adjacency places Radar next to Authorization Boost (fraud prevention ↔ authorization optimization).

## Disputes: money-flow-first lifecycle

- The definition leads with money movement: the cardholder questions the payment, "the issuer creates a formal dispute on the card network, which immediately reverses the payment", and "Stripe debits your balance for the payment amount and dispute fee" — the debit happens before any merchant action.
- Docs sub-tree: How disputes work / Handle / Respond / Smart Disputes / **Manage programmatically** / Dispute withdrawals / High risk merchant lists / Analyze (Measuring, Monitoring programs) / Prevent.
- **Reason-code abstraction:** issuer reason codes are normalized into Network categories spanning Visa/Mastercard/Amex, each with evidence guidelines.
- **Evidence-packet pattern:** the Dashboard-guided response asks for "text and images for the dispute reason, and your counterargument" — evidence is a structured packet per reason category, not freeform.
- Three-layer strategy: **respond** (challenge or accept) → **analyze** (dispute-rate measurement + card-network monitoring programs) → **prevent** (Verifi/Ethoca, Smart Disputes automation).
- Programmatic surface ("Manage disputes programmatically"): Disputes API — retrieve, update, submit evidence, handle events.
- State vocabulary (from R3's test-mode notes): needs_response, warning_needs_response (inquiry — no funds withdrawn unless escalated; refundable until disputed), won, lost, warning_closed; funds_withdrawn event; asynchronous outcomes explicitly taught.
- Adjacent sub-tree topics acknowledge issuer-side and network-side risk programs: Dispute withdrawals and High risk merchant lists.
- Cost shape (cross-batch, from R1's pricing-page survey, see `billing.md`): dispute received $15, countered $15 refunded if won; Smart Disputes takes 30% of won amounts; Verifi/Ethoca prevention lookups priced per lookup — the fee structure itself nudges toward prevention over response.

## Security page layering (docs.stripe.com/security)

- **Certifications first:** PCI Service Provider Level 1 (covering the Card Data Vault + secure SDLC of integration code), SOC 1 + SOC 2 Type II annually on request, public SOC 3, EMVCo Level 1&2 + PA-DSS (Terminal), NIST CSF alignment, CBPR/PRP + EU-US/UK/Swiss DPF — each named standard gets a plain-language summary; the public SOC 3 is the shareable artifact.
- **User controls next:** MFA ranked honestly (passkeys/hardware keys > TOTP > SMS as "last resort" due to SIM-swapping); SAML 2.0 SSO + SCIM; least-privilege roles; restricted keys; key access policies by location; audit logs + automatic email alerts for unknown IPs/devices; authenticated support requests.
- **Infrastructure:** AES-256 PAN encryption at rest with decryption keys on separate machines; internal tokenization; the card data vault in an isolated AWS environment with quarterly access reviews; internal mTLS; TLS 1.2+ minimum; HSTS preload; homoglyph protection.
- **Proactive internet monitoring:** scanning for leaked merchant keys, GitHub Token Scanner, phishing takedowns + Safe Browsing reporting — Stripe watching the public internet on users' behalf.
- The security docs sidebar frames the surface: Platform security / Integration guide / Python library PGP key / Activity logs / Stripebot web crawler / Privacy — plus a dynamic PCI validation form that varies by integration method (Elements/Checkout/Terminal SDKs/mobile).
- **Culture last:** threat models and trust boundaries, 24/7 on-call, annual security education, internal phishing campaigns, formal access grants with auto-removal of inactive access, HackerOne bug bounty.
- "See also" routing links onward: Integration security guide, SSO, Fighting fraud, Verify webhook events, Stripe IP addresses — security cross-linked into the integration path, not isolated.
- Design logic: evidence-over-adjectives (named standards, public SOC 3), audience-layered narrative (certifications → user-facing features → invisible infrastructure → employee controls), honest tradeoff guidance (SMS MFA risk stated, not hidden).

## Crypto risk posture (details in crypto.md)

No chargebacks on stablecoin acceptance (customer-authenticated push); onramp liability transferred up-stack (Stripe as merchant of record assuming fraud/dispute liability); access-gated activation (request/review, applications, due diligence) functioning as risk control; issuing marketed with a "compliance and fraud prevention framework"; Treasury/platform loss controls via reserves, payout restrictions, and due-diligence questionnaires.

## PaySwap implications

- **Directive B §12:** security belongs inside the lifecycle — onboarding, payment creation, checkout, wallet connection, transaction signing, payout, withdrawal, DEX/bridge execution, merchant settlement — not in a separate "security application". Radar's lifecycle framing is the reference model.
- Present merchant-crypto risk inline in payment flows as **score + label + named signals** (the 0–100 / High-Low / signal triple), with risk-level chips as column values in review tables.
- Encode **evidence-packet patterns** for any dispute-like or recourse flow: per-category guidance, text + images + counterargument structure, programmatic submission.
- Disclose the **no-dispute recourse shape** wherever stablecoin acceptance is offered (refunds-only recourse; see `crypto.md`).
- Quantify trust claims honestly, always paired with scope (Stripe's stat bands name the denominator); PaySwap's blockchain security model should surface verification evidence the same way.
- Layer security communication by audience scope for a PaySwap trust surface: certifications → controls users touch → infrastructure → culture.

## Not observable from static content

Radar rule syntax, live Dashboard risk-review screens, dispute detail/evidence UI, SOC report contents, the integration security guide (separate page not fetched), and actual Radar pricing numbers (they live on the pricing page — R1 survey; see `billing.md`).

## Cross-references

Related files in this set: `public-pages.md`, `crypto.md` (no-chargeback semantics, onramp liability transfer), `payments.md` (risk states in payment mocks), `connect.md` (operational review queues), `developers.md` (keys, webhook verification), `settings.md` (sensitive-action auth, restricted keys), `component-patterns.md` (state presentation), `pay-swap-ux-mapping.md`, `README.md`.

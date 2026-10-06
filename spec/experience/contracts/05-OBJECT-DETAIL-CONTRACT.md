Status: NORMATIVE CONTRACT v1 — 2026-10-06 — derived from Stripe UX research Phase 2 (`payments.md` — the payment-detail exemplar) + directive §7. Compliance MANDATORY for all PaySwap object detail routes.

# PaySwap object-detail contract

## 1. Principle

Every object (Payment, Settlement, Refund, Customer, Product, Dispute/Claim, Link) renders through ONE detail-page anatomy — the merchant learns it once, applies it everywhere. The anatomy is Stripe's payment-detail pattern: **header → timeline → context → raw detail → related objects → event log**.

## 2. Normative anatomy (top to bottom)

1. **Header**: display amount + asset · StatusChip · human strapline ("Charged to <name>" / "Sent to <address>" / "From <customer>") · primary action (the object's most likely next move: Refund / Retry / Cancel / Send receipt) · overflow (More).
2. **ActivityTimeline**: [Add note] + reverse-chronological human events with timestamps (Payment authorized / Payment started / Broadcast confirmed / Settled in block N).
3. **Context cards** (KeyValueCard sections, ordered by operator relevance):
   - **Execution summary** (checkout-summary analogue): counterparty · items/products · total.
   - **Money breakdown**: cross-rail disclosure sentence ("Customer paid USDC on Base; settled to you in EUR via optimal route") + Payment amount + Route/network fees + **Net amount**. FX/rate/fee lines are MANDATORY whenever source and settlement differ in asset or rail.
   - **Method details**: masked method ("Visa •••• 4242" / "Wallet 0x12…ab90") · expiry · checks ("CVC check: Passed" analogue: "Signature verified", "Allowance confirmed") · origin · issuer/counterparty metadata.
   - **Risk section**: risk factors/scores when applicable; test-mode honesty line when not ("Risk insights are only available for live data") — never fabricated scores.
4. **Raw detail card**: IDs in metadata typography, copyable: object ID, related tx hashes, session/link IDs. Copy-on-click with toast.
5. **RelatedObjects**: cross-object links (Payment → Settlement(s) → Refund(s); Payment → Link; Customer → their payments). Same component as everywhere.
6. **Receipt/communication history**: View receipt · Send receipt · "No receipts sent".
7. **Events log**: every state change as a human sentence + timestamp ("A 25 USDC payment for <id> was confirmed", "Checkout Session completed") + raw event rows (expandable). This is the object's audit trail and the reconciliation UI.

## 3. Object-specific minimums

| Object | Mandatory context sections | Primary action |
|---|---|---|
| Payment | execution, money breakdown, method, risk, payout linkage (expected date → Balances link) | Refund |
| Settlement | rail, net, fee breakdown, payout batch link | — |
| Refund | original payment link, reason, destination | Send receipt |
| Customer | contact, methods on file, balance(s), recent payments | Add method |
| Product/Link | pricing, options, share actions (copy/QR/embed) | Copy link |
| Dispute/Claim | reason, deadline ("Response due by"), evidence status, outcome | Submit evidence |

## 4. Behavior rules

- Deep-linkable: every detail route is `/collection/<id>`; invalid IDs render the dedicated error page (resource + world + next hop).
- Notes: operators can annotate any object (timeline [Add note]); notes are events.
- Copy affordances never copy full secrets; masked by default, reveal is explicit and session-scoped.
- The payout/settlement linkage on a payment shows expected date as a link into Balances (money flow is navigable end-to-end).

## 5. Acceptance

- All six object types implement the full anatomy (grep for bespoke detail layouts = 0).
- Money breakdown renders the cross-rail sentence on 100% of cross-asset payments.
- Event logs contain human sentences for every state transition (no bare event codes).
- Every ID on every detail page is copyable; every related-object link navigates to a valid detail route.

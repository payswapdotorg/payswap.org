Status: NORMATIVE CONTRACT v1 — 2026-10-06 — derived from directive §6, §9 (merchant UX Stripe-grade; mental model Amount/Customer/Payment/Settlement/Refund/Risk with chain/gas/ABI progressive disclosure) + Phase 2 evidence (whole dashboard survey). Compliance MANDATORY for the merchant dashboard.

# PaySwap merchant-dashboard contract

## 1. Principle — the acceptance test

A merchant's first session must feel like a **mature financial operating system**, not a crypto wallet with panels (directive §15). The mental model stays: **Amount / Customer / Payment / Settlement / Refund / Risk**; all blockchain specifics (chains, gas, ABI, mempool) are progressive disclosure beneath it, never the primary vocabulary.

## 2. Surface composition (normative)

The merchant dashboard consumes the shell contracts (navigation `01`, tokens `02`, components `03`) and adds:

### Home
- **Today card**: balances per rail (Incoming vs Available) + next settlement schedule timeline + [Withdraw] — first block even at zero.
- **Recommendations**: capability activation cards (one sentence + verb CTA): "Accept USDC on Base — no code needed. [Enable]" / "Set up recurring invoices. [Get started]".
- **Develop card**: publishable key + masked secret + [Go to API keys].
- **Your overview**: metric cards (Payments, Gross volume, Net volume, Failed payments, New customers, Top customers) with built-in comparison, freshness labels, scaffold-rendered empties, [More details].

### Balances
- Header: total (display currency) + [Withdraw] + [Add funds] + [Manage schedule] + [Add rail].
- **Incoming vs Available** table per asset/rail; "Settle <cadence>" as inline status.
- Tabs: Settlements · Top-ups · All activity · Statements & reconciliation.

### Transactions
- ListPage per component contract; eight-state chips; Failure-reason column; sub-tabs (Payments · Settlements · Top-ups · All activity).
- Empty = integration ladder: "Accept via PaySwap Link (no code) / Embed a payment component / Integrate the API / Accept in person (QR)".

### Customers
- Directory + auto-created guests (from hosted payments) with derived display names; detail per object contract (methods on file, balances, payments).

### Catalog
- Products · Prices · Links · Coupons/Perks — same page family; link detail carries share actions (copy/QR/embed) + method list + CTA wording selector (Pay/Request/Donate).

### Billing family (Accept / Bill groups)
- Unactivated capabilities render **hub pages** (education + test CTAs), never blank or 404.
- Subscriptions with Simulations + Migrations tabs; dunning/recovery visible as product proof.

### Risk & disputes
- Tabs = lifecycle (Needs response · In review · Won · Lost); **Response due by** as a column; empty states teach simulation; program standings as statuses ("VAMP standing: Projected good" analogue: network health standing).

### Insights/Reports
- Task-routed catalog: reconcile (balance summary, fees, settlement reconciliation) · recognize (revenue) · analyze (acceptance, methods, optimization) · export (warehouse). Reports open with visible query/model provenance (Phase 1 `reports.md`).

### Capabilities marketplace
- Installed/Browse; curated shelves with one-line pitches + one-click Install; empty state: "Explore the marketplace".
- **Account connections (TL-review R3)**: external rails and PSPs — Stripe included — are capabilities. The Installed list renders a per-connection status chip (`connected` · `attention` · `disconnected`) with a re-connect/re-auth affordance inline; connecting is an install + credential-handshake flow that NEVER puts the secret in page DOM (security contract §3); Settings mirrors the connection list with scope sentences ("Stripe can charge your customers and pays out to your bank"). The §20 "Stripe connection" certification scenario exercises this flow end-to-end.

### Settings
- Personal vs Account groups, each card with scope sentence; Team and security grouped; test/live management under account.

## 3. Progressive disclosure ladder (normative)

Level 0 (always visible): objects, amounts, statuses, people.
Level 1 (in place, expandable): fees, rates, rail names, expected times.
Level 2 (detail pages): route breakdown, confirmations, event logs, IDs.
Level 3 (developers' surfaces): chain IDs, gas params, ABI/method calls, raw payloads — ONLY at this level, and ONLY in the Developers area or expandable technical sections.
Rule: a merchant can operate 100% of core workflows seeing only levels 0–1.

## 4. Crypto-to-financial vocabulary mapping (display layer)

| Crypto concept | Merchant-facing rendering |
|---|---|
| chain | rail / network name ("Base", "Arbitrum") |
| gas | network fee (amount + currency, folded into Money breakdown) |
| confirmation depth | "Settled in block N" / settlement time |
| approval/allowance | "Spending permission" with scope + revoke |
| mempool | "Broadcasting" (processing state) |
| revert | "Reverted by receiver (reason)" |
| stablecoin | asset name + display-currency amount side by side |
| wallet | payment method / payout account |
| smart contract | automated rule (with "View technical details" → Level 3) |

## 5. Acceptance

- §15 battery: a Stripe-familiar merchant completes accept-link → payment → settlement → refund without seeing a chain, gas price, or ABI string (levels 0–1 only).
- Every section above exists with its states (empty/populated/error) per the component + error contracts.
- Unactivated capabilities render hub pages with test CTAs (no blanks).

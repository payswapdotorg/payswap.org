Status: PUBLIC-SURFACE RESEARCH — 2026-10-03 (P4-W1-003 Phase 1) — source: public Stripe docs via automated extraction, no authentication; authenticated dashboard survey is Phase 2 (operator-gated)

# Stripe reporting and Sigma — task-routed reports, 12h SLA, SQL with visible queries

Sources: R3 `notes-reports.md` (stripe.com/sigma; docs.stripe.com/reports, /reports/select-a-report, /reports/options) + R3 SUMMARY §e. Primary users: finance, ops, data, product roles.

## Task→report routing and mental models

- Docs route by operational task: a table maps "which report answers which task" before describing any report — discovery starts from the question, not the artifact.
- Two free reports with deliberately different mental models:
  - **Balance summary** — "Reconcile your Stripe balance like a bank account": Starting balance / Balance change from activity / Total payouts (negative) / **Ending balance**. Bank-statement model, reconciled at end of period.
  - **Payout reconciliation** — per-payout transaction breakdown; the clearing-account model (what moved in each payout, keyed on created; available_on for automatic-payout entries).

## Data freshness and exceptions

- **12-hour data SLA:** a day's data (00:00–23:59 window) is complete by ~12:00 the next day.
- Documented exceptions: first-time automatic payouts and gaps >180 days delay availability — exceptions are published, not discovered.

## Configuration UX

- Date range (default prior month, inclusive); timezone toggle (account timezone vs UTC); currency selector (settlement currency).
- **Connect scoping:** platform / all connected accounts / **subset via a connected-accounts picker drawer** / single account from the account-detail page — reporting as an operational workflow across a fleet.
- **Scheduled reports:** daily/weekly/monthly; Schedule → frequency + columns + currency; email-when-ready; "None" stops delivery.

## Sigma (SQL analytics layer)

- Positioning: "Analyze Stripe Data Using SQL and AI" — usable inside the Dashboard or with agents (MCP surface).
- Custom reports three ways: raw SQL / prebuilt template / **natural-language → SQL assistant** (example question: "What percentage of disputes did we contest?").
- **Query Run API** for programmatic report execution.
- Schema sidebar with search, grouped tables (Payment Tables…), typed columns (Varchar / Bigint / Timestamp).
- Save/share queries by link; publish reports to the Dashboard; scheduled email delivery.
- **Persona gallery:** 4 persona tabs (Business Operations / Finance / Data Analysis / Product Management) × ~10 example natural-language questions each, with **"Show query"** progressive disclosure exposing the full SQL — the query is visible under every question; the query effectively is the documentation.
- Read-only analytics surface; free unlimited use in sandboxes.
- Metrics = Sigma reports organized in **metric groups (≤20 reports; only the author can edit)**.
- **Documented docs-vs-dashboard divergence table:** timezone / date-range / currency / metadata semantics differ between Sigma reports and Dashboard reports — Stripe publishes where its own two reporting systems disagree.
- Report templates map to API report types (e.g., payout reconciliation itemized v5) — dashboard artifacts have programmatic equivalents.
- Marketing/pricing: monthly vs annual plan pair with 30-day free trial; cancellation via settings → "Cancel Stripe Sigma subscription" (ends at billing-cycle close).

## PaySwap implications

- Task→report routing + persona-based discovery is the pattern for PaySwap's Reports surface over protocol projections: start from operator questions ("settlement exceptions today", "failed USDC payments") not from data tables.
- **"Show query" transparency is the analytics analogue of PaySwap's evidence-first principle:** every aggregate must be traceable to authoritative records — a PaySwap report should expose its derivation (filters, window, source ledger) the way Sigma exposes SQL.
- The divergence table is the honesty bar: where PaySwap UI projections and on-chain/provider truth can differ (latency, reorgs, provider lag), publish the difference rather than papering over it (INV-X01; analytics as projection of protocol state, never a second source of truth).
- 12h SLA + published exceptions → PaySwap should state data-freshness contracts per report, including stablecoin-chain finality windows.
- Scheduled + Connect-subset delivery shows reporting as an operational workflow; PaySwap organizations/merchants scoping should reuse the subset-drawer pattern.
- Metric groups (≤20, author-only edits) is a lightweight governance model for shared dashboards.
- Sigma's NL assistant + MCP/agent surface prefigures PaySwap's SEARCH/COMMAND (`search.md`) executing analytical intents.

## Honest gaps

- Visual report layouts, the in-Dashboard Sigma editor experience, and actual generated SQL were not observable from static fetches; pricing-tier details for reports beyond Sigma's plan pair are not on the surveyed pages. Authenticated report rendering is Phase 2.

## Cross-references

Related files in this set: `search.md` (Sigma as search escape hatch), `balances.md` (balance-summary model, settlement timing), `connect.md` (connected-account scoping), `developers.md` (Query Run API, API conventions), `navigation.md` (Reporting in sidebar IA), `crypto.md` (stablecoin reporting adjacency), `component-patterns.md` (tabs, progressive disclosure), `pay-swap-ux-mapping.md`, `README.md`.

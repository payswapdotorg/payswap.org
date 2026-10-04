Status: PUBLIC-SURFACE RESEARCH — 2026-10-03 (P4-W1-003 Phase 1) — source: public Stripe docs via automated extraction, no authentication; authenticated dashboard survey is Phase 2 (operator-gated)

# Stripe Dashboard search — and the SEARCH/COMMAND question for PaySwap

Sources: R3 `notes-dashboard-search.md` (docs.stripe.com/dashboard/search) + R3 SUMMARY §a; mobile search parity from `notes-mobile-responsive.md`. This is the single strongest public-documented precedent for Directive B §8 (universal command/search experience).

## Searchable resources

- Cross-resource fuzzy search over: payments, customers, invoices, payouts, products, connected accounts, disputes.
- Searchable without knowing IDs: last four digits of a card/account number, payment method type, connected-account business name, email receipt number, flexible dates (08/22, 2020-07-12, "last week").
- Typing an object identifier (e.g., a dispute ID) jumps directly to the object.
- Default behavior is fuzzy-smart matching in "the most logical fields within objects" — "No additional context is necessary for most searches."

## Results flow (progressive drill-down)

1. Instant top results — "the top results appear immediately" while typing.
2. "View all results" or Enter → grouped results by resource type.
3. Per-group "View all" → expanded display with column headings, some sortable (search results promote into list views).
- Mobile app claims "Search across your entire business" (global search parity on native).

## Filter vocabulary (field:term)

- ~20 documented fields: amount:, brand:, country:, created: (alias date:), currency:, date:, email:, exp:, flow:, last4:, metadata:, name:, number: (invoice), postal:, receipt:, risk_level:, status:, type:, usage:, zip:, profile:.
- Many fields are shared across objects (amount: applies to payments, invoices, payouts…).
- Phrase search with quotes: name:"John Doe"; "Stripe Shop" matches the full phrase vs separate words.
- Negation with hyphen prefix: -exp:08/22 excludes matches.
- Multiple terms narrow results (AND semantics).
- Metadata searches accept bare value, key:value, metadata:value, and metadata:key=value forms.

## Scope, sharing, and consistency semantics

- Organizations: search spans all accounts the team member can access by default; a dropdown option restricts to the current account.
- URL-shareable state: "you can bookmark the search or share it with other team members" — search terms live in the URL (saved-view via URL, not a saved-view UI).
- Documented best practices: start with one fairly specific term (name or email); too few results → broaden; too many → add terms one at a time; use wider ranges for dates/amounts because currency conversion and timezone differences cause missed lookups.
- **Eventually-consistent caveat** (from the Testing use cases doc): recently created/updated objects may not appear immediately; verify via deterministic ID retrieval or list endpoints; never retry creation requests because search missed them (duplicate-creation hazard).
- Escape hatch: advanced/power querying is delegated to Sigma ("interactive SQL environment in the Dashboard") — search is for quick lookup, Sigma for custom reports.

## PaySwap SEARCH/COMMAND evolution (Directive B §8)

Directive B mandates evolving this into a single user surface — `SEARCH / COMMAND` — that can find:

- payments, customers, merchants, wallets, accounts, transactions, providers, chains, tokens, DEXs, capabilities, organizations, opportunities, security events, settlements, evidence

and, where authorization permits, execute commands such as:

- "Pay Alice €100" · "Show failed USDC payments" · "Cash out my USDC" · "Connect my Stripe account" · "Show today's settlement exceptions" · "Find opportunities requiring less than $1,000 capital"

Design contracts Stripe's precedent supports:

- One entry point, instant results, then grouped drill-down into typed object pages (matches PaySwap's deterministic object pages, INV-X01).
- A filter grammar (field:term + quotes + negation) mapped to PaySwap resources — e.g., chain:, token:, provider:, capability:, status: over settlements and security events.
- Search state in the URL → shareable links are an operational collaboration primitive (support ↔ finance handoff).
- **Search and command are separate concepts internally even if they share one user surface** — parse into intent (find vs act), gate commands on authorization, and confirm before external writes (INV-X02: no blind retry; commands over money need explicit confirmation surfaces).
- Eventual-consistency honesty carries over: search is a read model; authoritative verification goes through deterministic retrieval, never through re-triggering creates.
- Sigma-style escape hatch → PaySwap reports/query surface over protocol projections (`reports.md`).

## Honest gaps

- Empty-state, error behavior, and result-count semantics of Dashboard search are not documented on the public page ("not observable"); search-result ranking logic is not documented. The authenticated search UI is Phase 2.

## Cross-references

Related files in this set: `public-pages.md` (no site search on marketing surfaces; Guide-me recommender), `navigation.md` (command-center IA), `customers.md` (customer search fields), `balances.md` (amount:/status: on payouts), `reports.md` (Sigma escape hatch), `developers.md` (eventual-consistency testing guidance), `component-patterns.md` (progressive disclosure toolkit), `workflow-patterns.md`, `pay-swap-ux-mapping.md`, `README.md`.

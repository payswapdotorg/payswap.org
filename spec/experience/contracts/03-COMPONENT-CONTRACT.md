Status: NORMATIVE CONTRACT v1 — 2026-10-06 — derived from Stripe UX research Phase 2 (`docs/ux-research/stripe/phase2/dashboard-shell.md`, `payments.md`, `dashboard-pages-survey.md`) + Phase 1 `component-patterns.md`. Compliance MANDATORY.

# PaySwap component contract

## 1. Principle

Every recurring UI shape is ONE component with a fixed anatomy. Components are contracts: same data shape in, same structure out, on every surface (merchant dashboard, consumer dashboard, hosted payment pages).

## 2. The component catalog (normative)

### 2.1 ListPage (every collection route)
```
[ListPageHeader: title + primary Create action (with chord) + secondary actions]
[SubTabs: facets of the collection] [StatusChips: state vocabulary] [Filter]
[DataTable: columns per collection spec below]
[ListFooter: "N–M of X results" + pagination]
```
Column specs (normative):
- Transactions: Amount · Status · Rail/Method · Description · Counterparty · Date · Failure reason · (row menu)
- Customers: Customer · Email/Address · Description · Country · Created
- Catalog: Name · Updated · Pricing · Category · Created · Status
- Disputes/Claims: Reason · Status · Amount · Filed date · **Response due by**
- Settlements: Amount · Status · Rail · Expected date · Net
Rules: masked identifiers in cells ("••• 4242", "0x12…ab90"); amount cells always "X CUR"; the failure/decline column exists even when all rows are healthy ("—").

### 2.2 StatusChip
`state` ∈ {succeeded, processing, failed, refunded, partially_refunded, disputed, blocked, dropped} + optional tooltip with technical detail. Used identically in lists, detail headers, events, toasts. (Token contract §7; TL-review R1.)

### 2.3 EmptyState
Anatomy: headline value proposition (one sentence) + primary **test-mode-capable CTA** + optional secondary docs link + optional "simulate this" teaching line. Never a bare "No data". Every collection MUST define its EmptyState. (Evidence: disputes empty state teaches test cards; invoices pairs value prop + settings action.)

### 2.4 ObjectDetailHeader
`display amount` + StatusChip + human strapline ("Charged to <counterparty>") + primary action (Refund / Retry / Cancel) + overflow menu. The amount is `display` typography; the action is the object's most likely next move.

### 2.5 ActivityTimeline
Reverse-chronological event list; each entry = human sentence + timestamp + optional actor + [Add note]. Terminal-first: latest state at top. (Evidence: "Payment authorized/started".)

### 2.6 KeyValueCard (context sections)
Label + value rows; values may be links (IDs, related objects). Used for Payment breakdown, Method details, Tax, Settings groups. IDs in metadata typography.

### 2.7 MetricCard
Title · value · built-in comparison ("previous period") · mini chart (scaffold always rendered) · freshness label ("Updated N ago") · [More details]. Empty = "No data" inside the scaffold. (Evidence: Home overview.)

### 2.8 CommandBar (search/command) — per `06-SEARCH-COMMAND-CONTRACT.md`.

### 2.9 CreateMenu
Split-button; items carry visible chords; chords active globally. Items: Pay (`c p`), Request (`c r`), Invoice (`c i`), Payment link (`c l`), Convert (`c v`). (Nav contract §6.)

### 2.10 SetupGuideWidget
Sidebar-footer card: "Next: <single step>" + collapsible full checklist. (Nav contract §7.)

### 2.11 EnvironmentBanner — per nav contract §2; component reused on hosted payment pages (badge variant).

### 2.12 FormField + inline validation
- Label + helper sentence (what it's for, where it appears) + input + per-field error BELOW the field.
- Errors clear on valid input; NEVER persist stale errors after re-validation (Stripe's stale "A value is required" observed — explicit anti-pattern).
- Dependent inputs disable with a REASON ("Select a customer above to save a card…").
- Money inputs: currency-prefix, auto-format on blur; statement-descriptor-like inputs auto-format visibly.
- Card/wallet/secret entry uses the secure embedded component (masked, never full secret in DOM).

### 2.13 RecommendationsCard
One-sentence value prop + single verb CTA. Used on Home and empty surfaces for capability activation. (Evidence: Home recommendations.)

### 2.14 RelatedObjects
List of cross-object links (Payment → Settlement → Refund; Customer → Payments). One component everywhere.

### 2.15 ConfirmationButton
Buttons that move money RESTATE the amount+asset in their label ("Pay 25 USDC") and expose an in-button Processing state. No spinner-only money buttons. (Evidence: hosted checkout Pay button.)

## 3. Interaction rules (normative)

- Keyboard: "/" focuses search; arrows traverse tables; Enter activates rows; chords per CreateMenu; Esc closes topmost layer. Focus visible everywhere.
- Rows are links (drill to detail); row-menu for row-scoped actions; bulk-select column when >1 action supports batching.
- Modals: Esc + backdrop close; primary/secondary footer bar; dual-submit pattern ("Submit and create another") for high-frequency creation flows.
- Loading: skeletons matching final layout; never spinners gating whole pages.
- Toasts: for confirmations ("Payment link copied"); never for errors (errors are inline).

## 4. Acceptance

- Every collection route renders ListPage with its spec'd columns + EmptyState.
- StatusChip is the only state renderer (grep for bespoke badge classes = 0).
- Every money-moving button passes the ConfirmationButton rule.
- Component library (shadcn/ui base) wraps each catalog entry with the anatomy above; Storybook specimens for all 15 components × primary states.

Status: PHASE 2 (authenticated) — 2026-10-06 — live survey of the logged-in dashboard shell and Home.

# Dashboard shell — global chrome, navigation taxonomy, Home

## The page shell (every dashboard route)

1. **Sandbox banner** — a persistent full-width strip pinned to the very top of the viewport (observed 1424×44 at top:0), present on EVERY page of the test-mode dashboard and on the hosted payment page:
   > "Sandbox — You're testing in a sandbox. Changes you make here don't affect real customers or payments. — [Switch to live account]"

   Design logic: the test/live separation is not a toggle that can be forgotten — it is a **permanent environmental banner** that (a) names the environment, (b) states the safety promise in human language ("changes don't affect real customers or payments"), and (c) carries the exit door ("Switch to live account") inline. The user can never be unsure which world they are in, and the exit is one click, not buried in settings.

2. **Topbar**: account switcher (avatar + account name + business name) · **Search with "/" keyboard hint** · Apps · Help · Notifications · Settings · **Create** (the global create split-button) · Customize.
3. **Left sidebar** — persistent section + accordion workload groups (taxonomy below).
4. **Sidebar footer**: **Setup guide widget** (persistent onboarding checklist — see below) · Search "/" · **Developers** · Customize.
5. **Accessibility chrome**: "Skip to content" link; a live region that announces navigations ("Navigated to Home – …").

## Sidebar taxonomy (exact, 2026-10)

Persistent (always visible — the money objects):
- Home → `dashboard`
- Balances → `balance/overview`
- Transactions → `payments`
- Customers → `customers`
- Product catalog → `products?status=active&listId=active`

Workload groups (accordion; one open at a time; `data-testid="toggle-workload-*"` — the nav is a tested contract):
- **Payments**: Analytics · Managed Payments · Checkout · Disputes · Radar · Terminal · Agentic commerce
- **Billing**: Overview · Subscriptions · Invoices · Usage-based · Revenue recovery · Retention
- **Reporting**: Reports · Custom metrics · Sigma · Revenue Recognition · Data management
- **Apps**: Overview (`apps/installed`)
- **More**: Link · Profiles · Tax · Connect · Identity · Atlas · Issuing · Financial Connections · Climate · Workflows · Projects

### Nav design logic

- **Objects first, workloads second.** The five always-visible links are the merchant's money objects (Home, Balances, Transactions, Customers, Product catalog). Feature areas collapse behind workload labels → the nav never grows unboundedly; every new Stripe product lands inside a group, never as a new top-level row.
- **Accordion = scoped expansion.** Only one workload group open at a time; the closed state is the default. Nav is not a settings dump.
- **"More" is the pressure valve.** Mature/adjacent products (Tax, Connect, Identity, Atlas, Issuing, Financial Connections, Climate, Workflows, Projects) live behind one group — the primary object model is never fragmented by the long tail of the catalog.
- **Search has a discoverable kbd hint ("/")** — the command surface is one keystroke away, always visible in chrome.
- **Developers is a top-level sidebar-footer item** — developers are a first-class dashboard audience, not a settings subsection.
- **The nav carries testids** (`toggle-workload-payments` etc.) — Stripe treats navigation as a tested contract; PaySwap should too.

## Setup guide (sidebar-footer widget)

- Header: "Setup guide" + Customize + close; **"Next: <step>"** pointer always visible.
- Steps observed: Verify your account · Verify your email · **Activate payments** (the current "Next") · Create your Stripe profile.
- Behavior: onboarding lives in persistent chrome (not a modal wall); each step is a link; the widget names exactly one next action so the merchant never wonders what's first. It can be collapsed and re-expanded from the topbar ("Maximize setup guide").

## Home page anatomy (near-empty account — the empty-state showcase)

1. **Today card** (first thing on Home, even at €0.00): "Pay out funds" · Gross volume €0.00 · next-payout schedule timeline ("12:51 PM Today / Yesterday") · EUR balance €0.00 (View) · Payouts "—" (View).
   → The money-in/money-out picture leads the product even when empty; the payout cadence is shown as a timeline, not a setting.
2. **Recommendations** (contextual activation cards, one-sentence value prop + verb CTA):
   - "Send customized invoices to your customers with a secure link to pay online—no coding required." → [Create invoice]
   - "Automatically calculate and collect tax across all your products and services." → [Get started]
3. **API keys card** ("Set up integrations with secret and publishable keys"): Secret key + Publishable key rows with **masked display** (prefix + ellipsis + last chars, never full values in the UI) → [Go to API keys].
   → For new accounts the keys are surfaced contextually on Home — collapsing the "go hunt for your keys" journey; masked by default, reveal is a separate explicit action.
4. **Your overview**: Date range (Last 7 days · Daily · Compare: Previous period · Add · Edit) + metric cards:
   - Payments (chart — "No data")
   - Gross volume €0.00 (+ "€0.00 previous period" + mini chart with visible axes + "Updated 15 seconds ago" + [More details])
   - Net volume (same anatomy)
   - Failed payments ("No data")
   - New customers 0 (same anatomy)
   - Top customers by spend (All time · "No data")
   → (a) **freshness labels** ("Updated N seconds ago") on every metric; (b) **comparison is built-in** (previous period always rendered, not a feature to enable); (c) **empty metric = "No data" inside the fully-rendered chart scaffold** (axes + date ticks visible) so the shape of future data is legible; (d) "More details" progressive-disclosure link per card; (e) range + granularity + compare are inline controls, not buried settings.
5. A11y live-region navigation announcements; "Skip to content" first tab stop.

## Derivation seeds (→ contracts)

- OBSERVED: permanent environment banner with promise + inline exit → PROBLEM: mode confusion destroys trust (test vs live, testnet vs mainnet) → PAYSWAP: persistent TESTNET/MAINNET banner on every surface with "funds here are test assets; switch to mainnet" inline (contract: error-state/security-presentation).
- OBSERVED: objects-first sidebar + workload accordions + "More" pressure valve → PAYSWAP nav contract (5 persistent money objects: Home, Balances, Transactions, Customers, Catalog; workloads collapse).
- OBSERVED: setup guide as chrome widget with "Next:" → PAYSWAP onboarding: persistent checklist naming exactly one next step.
- OBSERVED: masked keys on Home → PAYSWAP: publishable key + masked secret in a Home "Develop" card.
- OBSERVED: "No data" inside chart scaffold + freshness + built-in comparison → PaySwap metric-card contract.

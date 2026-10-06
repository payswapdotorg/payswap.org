Status: PHASE 2 (authenticated) — 2026-10-06 — structured per-page captures of the remaining dashboard areas. All data are test-mode artifacts; key values are masked (pattern only, never transcribed).

# Dashboard pages survey — Customers, Balances, Products, Billing family, Reports, Radar, Disputes, Developers/API keys, Settings, Apps, Connect

## Customers (`/customers`)

- Header: "Customers" + **[Add customer]** (with `N` chord hint on the button).
- Sub-tabs: **All · Remaining balances** + [Filter].
- Table columns: **Customer · Email · Description · Country · Created**.
- Observed row: the survey's test customer ("UX SurveyGuest" / ux-survey@example.com / Hong Kong SAR China / timestamp). Guest checkout customers are auto-created with a display name derived from their email/payment — no manual customer creation required for them to appear.
- Empty-state cross-sell: "Create and send your first invoice directly from the Dashboard—no code required." → [Send first invoice].
- Footer: "1–1 of 1 results".

## Balances (`/balance/overview`)

- Header: **"Balances €0.00"** + **[Pay out]** + [Add funds] + [Manage payouts] + [Add settlement currency].
- **Balance summary** table: "Payments type · Amount — **Incoming €23.96 · Available €0.00**" — the incoming (in-flight/pending settlement) vs available (payable now) split is the page's lead concept, shown even when available is zero.
- Tabs: **Payouts · Top-ups · All activity** (+ More · "Statements and reports").
- Payouts tab empty state: "No payouts to display — Payouts will appear here once they've been created." (plain promise of when content will appear).
- **Automatic payouts — "Settle daily"** (the payout schedule as an inline, human-readable status).
- Cross-sell card: Invoicing/AR pitch → [Create first invoice].

## Payouts (route probed) — error-state specimen

- Probing the payouts area surfaced Stripe's **"Transaction not found"** page: "The requested transaction does not exist: payouts" + **[View all test mode payments]**.
- Design logic: an invalid/deep-linked resource renders a dedicated error page that (a) states exactly what was looked up, (b) names the world (test mode), and (c) offers the single most useful next hop — not a generic 404.

## Product catalog (`/products`)

- Header: "Product catalog" + **[Create product]** (chord `N`).
- Sub-tabs: **All products · Features · Coupons · Shipping rates · Tax rates · Pricing tables** + status chips **All · Active · Archived** + [Filter].
- Table columns: **Name · Updated · Tax code · Pricing · Product category · Created · Status**.
- Pricing cell renders "€25.00 EUR" inline (price + currency in the cell, no detail-click needed).
- The survey's product ("UX Survey Product", Active) appears exactly as created via the payment-link inline flow.

## Billing (`/billing`) — capability-gated hub page

- Since Billing is not activated, the page is a **marketing-style hub inside the dashboard**: "Manage revenue, automate workflows, and accept payments — Billing supports one-time, recurring, and usage-based pricing models." → [Get started] [Watch demo] [View plans].
- Task cards, each with a test-mode CTA: "Create payment links → **Create a test payment link**", "Create a custom subscription → **Create a test subscription**", invoicing → **Create a test invoice**.
- Design logic: unactivated products present as in-dashboard education + test-mode entry points; the user can experiment BEFORE activation (test CTAs are live).

## Invoices (`/invoices`) — empty-state specimen

- "Get paid fast with Invoicing" hero → **[Create a test invoice]** · [Watch demo] · [View plans].
- "Brand and customize your invoices — Manage branding, add payment methods, set reminders…" → [Invoice settings].
- "Set up your customer portal — Set up a Stripe-hosted portal that allows your customers to pay invoices, check invoice statuses, download invoice PDFs…" → [Set up your portal].
- Every empty module pairs its value proposition with a settings action.

## Subscriptions (`/subscriptions`)

- Tabs: **Subscriptions · Simulations · Migrations**.
- Empty-state: "Start collecting recurring revenue without writing code — Launch pricing models with built in support for dunning, coupons, free trials and prorations." → **[Create a test subscription]** + [View docs].
- Secondary cards: payment links → "Create payment links", integration guidance → "Design an integration".
- "Simulations" and "Migrations" as first-class tabs — rehearsal and transition are product features, not afterthoughts.

## Reports (`/reports`) — task-routed catalog

- Hero: "Track money movement — Understand the activity in your Stripe account, focused on how activity, fees, and payouts affect your balance."
- **Task groups** (not a file tree):
  - Balance summary · All fees · Payout reconciliation
  - "Automate accounting" → Revenue recognition
  - "Custom reports and data analysis" → **Sigma custom reports** ("Build custom reports with SQL and AI-assisted natural language prompts") · Export to data warehouse
  - Analytics family: Acceptance · Authentication · Disputes · Payment methods · Optimization (New) · Billing overview · Radar analytics.
- Design logic: reports are organized by the question the merchant is asking (reconcile, recognize, analyze), each entry a link with a one-line description.

## Radar (`/radar`) — risk area

- Tabs: **Overview · Reviews · Rules · Lists · Risk controls · Insights**.
- Date-range picker inline (Oct 2 – Oct 6).
- Modules: "Customer account fraud — Detect abuse across the customer lifecycle, including signup and login" (account evaluations API) · "Payment fraud — Track fraud trends across your accepted payments" (Payment method · View · Count · Date table + fraud-rate chart 0–100%) · "Disputes 0%" · "VAMP standing — Projected good" (Visa dispute program standing surfaced as a status!) · "Rules and actions — Rules that trigger often may need tuning to avoid…" + [View integration guide].
- Empty-data honesty: charts render axes at 0% with zero counts — no fake data.

## Disputes (`/disputes`) — lifecycle-state tabs

- Tabs = **dispute lifecycle states**: **Needs response · In review · All disputes · Won · Lost** + [Export] [Analyze].
- Table columns: **Reason · Status · Amount · Disputed date · Evidence due by** (deadline as a first-class column!).
- Empty state: "No disputed test payments — Disputed test payments will show up here, along with the reasons cardholders reported them to their issuing banks. You can use [test cards] to simulate a disputed transaction. [View docs]" — the empty state TEACHES the simulation path.

## Developers / API keys (`/apikeys`)

- Tabs: **Secret keys · Access policies · Suspicious API activity** (+ status chips All 1 · Active 1 · Inactive 0).
- **Publishable key** row: shown in full (publishable by design) — pattern `pk_test_…` (masked here).
- Secret keys table columns: **Name · Status · Permissions · Last used · Created date** / expanded row: **Name · Token · Permissions · Access policy · Last used · Created date**.
- Observed: one secret key, "Full access", "Access policy: None", "Last used —", created Oct 2. Secret values render **masked by default** (`sk_test_…` pattern, reveal-on-click).
- **[Create secret key]** primary CTA. "Suspicious API activity" is a first-class tab — API misuse monitoring lives next to the keys themselves.

## Settings (`/settings`)

- Two-tier structure: **Personal settings** vs **Account settings**, rendered as parallel cards:
  - Personal: Personal details ("Contact information, password, authentication methods, and your active sessions") · Communication preferences · Developers ("API policies, Workbench, and more") · Sigma.
  - Account: Business ("Account details, account health, public info, legal entity, custom domains…") · **Linked accounts and payouts** ("Bank accounts, debit cards, transfer rules, and settlement currencies") · **Team and security** ("Team members, roles, account security, authorized apps…") · (more below fold).
- Each settings group card carries a one-sentence scope description — settings are discoverable by description, not by hunting through nested tabs.
- Footer actions: Share feedback · Keyboard shortcuts.

## Apps (`/apps/installed`) — capability marketplace

- Tabs: **Installed · Created**.
- Empty state: "No apps installed yet — The App Marketplace has apps to help you run your business better." → **[Explore App Marketplace]**.
- **Recommended apps** (curated shelves, each with one-line pitch + [Install]):
  - "Popular this month": HubSpot Quote-Billing Sync ("Connect & automate HubSpot to Stripe Billing for visibility, error-free billing") · Mercury ("Stripe revenue to your Mercury account in minutes")…
  - "Best new apps and updates": Cap Genius AI · GoFunnel · DocuSign eSignature · Stripe Tax for BigCommerce · Salesforce Platform.
- Install is a one-click affordance from the shelf — marketplace discovery embedded in the dashboard.

## Connect (`/connect`) — platform product hub

- "Power your platform with Connect — Onboard and manage users, process payments, and send global payouts—all while Stripe handles risk, tax, and compliance." → [Get started] [View docs].
- Path cards: "Build a platform — Facilitate direct payments between other businesses and their own customers. [View docs]" · "Build a marketplace — Collect payments from customers and pay them out to sellers or service providers. [View docs]".
- Same hub-page pattern as Billing: in-dashboard education for not-yet-activated products, with model-choice guidance (platform vs marketplace).

## Cross-cutting patterns (→ contracts)

1. **Every list page** = Header + primary create action (with chord) + sub-tabs + status chips + Filter + table with meaningful columns + "N–M of X results" footer.
2. **Every empty state** = value-proposition sentence + primary test-mode CTA + docs link; some teach the simulation path (disputes).
3. **Unactivated products** become in-dashboard hub pages (marketing + test CTAs), keeping the IA stable while capability grows.
4. **Deadlines are columns** (Evidence due by), **schedules are statuses** (Settle daily), **programs are statuses** (VAMP standing: Projected good).
5. **Error pages name the resource + the world + the next hop** (Transaction not found → view test-mode payments).
6. **Balance semantics split Incoming vs Available** on the page header itself.
7. **Settings are described by scope sentences**, grouped Personal vs Account.
8. **API security is a neighbor of API keys** (Suspicious API activity tab).
9. **Marketplace shelves live inside the dashboard** (Install from recommendation cards).

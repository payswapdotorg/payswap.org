# RESEARCH-MAPPING — the universal interface, derived from the Stripe UX research

Work Order: **P4-W4-002**. Authority: `docs/STRIPE-UX-DIRECTIVE-2026-10-02.md`
+ `docs/ux-research/stripe/**` (the Phase-1 public-surface survey, 21 docs).

Scope honesty: the Phase-2 **authenticated** dashboard survey is NOT
available (research README records it as pending/operator-gated). Every
dashboard-class claim below derives from the public-surface research + the
dashboard IA **proposal** — nothing claims an authenticated-page
observation. Rows cite the research document each decision derives from;
the TL audits this table against the corpus.

## 1. Information architecture → the eleven areas (`@payswap/surface` areas.ts)

| Research finding (doc) | PaySwap decision (where it lives) |
|---|---|
| Stripe's dashboard nav groups a small set of primary areas with a collapsed "More" (navigation.md; dashboard-pages.md) | Eleven primary areas in a versioned registry; the certified 16-item nav stays as the deeper grouped layer — primary-first, full model one group below (`packages/surface/src/areas.ts`; `cc-nav-content.tsx`) |
| The IA proposal's area set maps the product's own domain (pay-swap-ux-mapping.md) | Overview / Payments / Accounts / Activity / Opportunities / Connections / Capabilities / Security / Reports / Developers / Settings — exact set, order fixed in the registry |
| Home is the attention + quick-action surface (navigation.md; dashboard-pages.md) | Overview leads with the five outcome actions (OutcomeLauncher), then honest runtime/coverage cards (`app/app/page.tsx`) |
| Balances-page UX has no Stripe precedent — a soft-404 in the survey (balances.md) | Accounts area is PaySwap-original: balances/positions as provider OBSERVATIONS, never custody (rule 21) — designed empty state with the connect next-action (`app/app/accounts/page.tsx`) |
| Payments is the operational spine with object drill-down (payments.md) | Payments area = the Pay journey surface + the object spine already rendered by the certified journeys (`app/app/payments/page.tsx`) |
| Connect model distinguishes catalogue from connected account (connect.md; settings.md) | Connections area renders AUTHORITY records only; the catalogue-never-connection law (rule 18) is the area's first sentence (`app/app/connections/page.tsx`) |
| Risk/security is integrated into workflows, not a separate app (risk.md; directive §12) | Security area renders the gate vocabulary presentation + live gate records as journeys produce them; every journey surface renders gates inline (`app/app/security/page.tsx`; `security-gate-view.tsx`) |
| Reports are generated from evidenced records (reports.md) | Reports area states the evidence-lineage contract honestly and links the activity ledger — no fabricated sample report (`app/app/reports/page.tsx`) |
| Developers surface the same contracts programmatic clients use (developers.md) | Developers area (existing certified surface) unchanged; the surface API is documented for exactly those clients (`packages/surface/README.md`) |

## 2. Outcome actions → the primary surface (`outcomes.ts`; components/universal/*)

| Research finding (doc) | PaySwap decision |
|---|---|
| Stripe workflows are choose-your-path ladders where every tier produces authoritative state (workflow-patterns.md; payments.md) | Five outcome actions as typed registry entries; each carries its REAL dispatch authority (API runtime commandType / merchant-checkout dispatch / route-compiler preview) — never a UI-side imitation |
| Simple view first, expert detail behind explicit disclosure (component-patterns.md; crypto.md; directive §10) | OutcomeLauncher renders the outcome line + advanced disclosure in `<details>`; Convert renders the simple outcome line then every plan/leg/reason on drill-down (`convert-surface.tsx`) |
| Confirmation is a human-readable summary before consequence (workflow-patterns.md) | Convert request summary renders as exact minor-units line before any fold; the pay/payout journeys' confirm steps are the certified ones |
| Crypto payment appears as naturally as any payment — network/method disclosed at the right step (crypto.md; directive §10) | Checkout renders fiat-first pricing with the crypto acceptance layer explicit and the customer explicit-signing summary (`checkout-surface.tsx`) |
| Two route families never conflated (crypto.md; merchant-checkout README §3.9) | Checkout's settlement step presents native Stripe crypto vs external PaySwap conversion as the two explicit paths |

## 3. Search / command → the palette extension (`lib/universal/palette.ts`)

| Research finding (doc) | PaySwap decision |
|---|---|
| One search surface over resources with grouped drill-down (search.md) | The palette gains the five outcome actions (verb-first) + the universal area go-tos, grouped "Outcome actions" / "Universal areas" |
| Search and command are separate concepts behind one surface (search.md; directive §8) | Actions are journeys (run → navigate to the real route); go-tos are navigation — the surface distinction the directive mandates |
| No-match honesty is undocumented in the Stripe corpus (search.md — a gap the research records) | The shared CommandPalette primitive's honest empty message stands ("No matching commands or sections.") — no fake matches invented |
| Keyboard accessible (search.md; responsive.md) | The @payswap/design CommandPalette + `useCommandKey` (⌘K) — unchanged, inherited |

## 4. States, modes, a11y, responsive (`security-vocabulary.ts`; mode-indicator.tsx)

| Research finding (doc) | PaySwap decision |
|---|---|
| Test/live keys determine mode; never visually ambiguous (settings.md; developers.md; directive §13) | ModeIndicator on every money-adjacent surface: TEST/LIVE + TESTNET/MAINNET badges + honesty note, never color alone (`mode-indicator.tsx`) |
| Empty/loading/error/success states are designed, named and action-linked (component-patterns.md) | Every area's empty state is a typed contract in the surface registry (reason + real next action) rendered uniformly |
| Risk presentation explains the why and the recommendation (risk.md; directive §11) | SecurityGateView: headline + explanation + typed drill-down in `<details>` + evidence refs — never a raw error dump |
| Responsive from mobile to desktop (responsive.md) | The existing shell's sidebar→drawer collapse + CSS grid cards at auto-fill minmax(16rem) — verified in the browser evidence at 390px and desktop |
| Keyboard navigation + ARIA (component-patterns.md) | nav/section/list semantics, aria-labelledby on every region, aria-current on active items (existing patterns extended; a11y suites still green) |

## 5. Money display (`money-view.ts`)

| Research finding (doc) | PaySwap decision |
|---|---|
| Amounts render exactly, grouped, with the currency clear (payments.md; balances.md) | `formatMinorUnits`: integer bigint arithmetic only (INV-F01), threes grouping, true minus sign, registry-resolved digits, unregistered codes honestly labeled |
| Fiat-first merchant model (directive §9; crypto.md) | Checkout and money surfaces render fiat as the primary frame; crypto acceptance is the explicit layer |

## 6. Corpus coverage

All 21 research documents map into the implementation: navigation.md,
dashboard-pages.md, payments.md, workflow-patterns.md, component-patterns.md,
search.md, crypto.md, risk.md, connect.md, settings.md, developers.md,
reports.md, balances.md, customers.md (customer framing inside the
checkout customer steps), billing.md + onboarding.md (progressive
merchant onboarding vocabulary in the checkout journey steps),
apps.md (the extension-ready surface API placement), public-pages.md
(honest public explorer unchanged), responsive.md (§4 above),
pay-swap-ux-mapping.md (the IA proposal — §1), README.md (authority
scope + the Phase-2 caveat recorded above).

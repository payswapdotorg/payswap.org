# §20 Final UX certification report — PaySwap web

- **Date:** 2026-10-07
- **Worker:** ux-cert certification worker (directive `docs/STRIPE-UX-DIRECTIVE-2026-10-06.md` §20)
- **Branch:** `ux-cert` (base `main @ 12f94a1da`, verified `git rev-parse HEAD` = `12f94a1da6891744b3021c99b88fa8b95a67f48c`)
- **Primary target:** production https://payswap-web.vercel.app — `/api/health` reports commit `12f94a1da…` / build `97385cb450185267` (the exact base SHA, fully built Next.js output)
- **Secondary target:** local dev — `packages/web`, `bun run dev -- --webpack -p 4173` (Next 16.3.8; webpack required — the repo's `next.config.ts` and `vercel.json` build with `--webpack`, and Turbopack dev disagrees with the config here). Identity plane loaded from server env only: scrypt seed user, session signing key, `WEB_APP_TEST_PAYMENT_FIXTURES=1`, `NEXT_PUBLIC_PAYSWAP_API_URL` unset (honest UNKNOWN states by design — INV-X01: UNKNOWN is not failure).
- **Method:** browser automation (agent-browser/Chromium) against actual rendered pages; every battery row below records the route exercised and the concrete evidence observed. No row is inferred from code alone; the two FAILs found were reproduced in-browser before fixing.

## Battery table (every §20 line item)

### Viewports

| Item | Route(s) | PASS/FAIL | Evidence |
| --- | --- | --- | --- |
| desktop 1280×800 | production: `/`, `/capabilities`, `/security`, `/developers`, `/app`, `/app/{balances,payments,collections,payouts,billing,convert,customers,safety,settings,connections,checkout}` | PASS | All routes 200 with full content; **0 console errors, 0 page errors** across the entire walk (agent-browser `console`/`errors` after each navigation). Unauthenticated `/app/*` renders the honest auth gate ("Overview — authentication required" + "Sign in — this section is preserved"). |
| desktop 1280×800 | local: `/app`, `/app/payments`, `/app/payments?start=1`, `/app/payments/{4 fixtures}`, `/app/convert`, `/app/connections`, `/app/checkout`, `/connect/{stripe,mtn_momo,stellar}`, `/app/safety`, `/app/customers`, `/app/capabilities` | PASS | Authenticated renders throughout (re-login between route groups — see Dev-environment notes); 0 console errors, 0 page errors. |
| tablet 768×1024 | production: `/`, `/capabilities`, `/security`, `/developers`, `/app`, `/app/balances`; local: `/app/payments` | PASS | `scrollWidth=768 == clientWidth` (no horizontal overflow) on every route; navigation drawer trigger present below lg and the static sidebar above; 0 console errors. |
| mobile 375×667 | production: `/`, `/capabilities`, `/security`, `/developers` | PASS | `scrollWidth=375` (no overflow) on all four; footer pushes naturally with content (bottom 5749px on `/` — content-driven, no floating gap). |
| mobile 375×667 | production + local: `/app` | **FAIL → fixed (cert-fix 3)** | Pre-fix: `scrollWidth=557 > 375` — `.ps-topbar__end` (search input + TEST badge + Settings + Create) measured 541px wide, pushing the page wider than the phone. Post-fix (local, branch build): `scrollWidth=375`, topbar end wraps (343×92, every affordance present). Production still runs the base build, so the deployed site shows the pre-fix behavior until `ux-cert` merges — stated here per the honesty doctrine. |
| mobile 375×667 | local: `/app/payments` (authenticated, fixture table 900px) | **FAIL → fixed (cert-fix 3)** | Pre-fix: `scrollWidth=917` (the object table escaped its panel). Post-fix: `scrollWidth=375`; `.ps-listpage__tablewrap` computes `overflow-x: auto` and the table scrolls within its panel. |
| mobile 375×667 | production: `/app` mobile drawer | PASS | "Open navigation" opens the dialog drawer (Home/Balances/Transactions/Customers/Catalog + groups); clicking Balances navigates to `/app/balances` and closes the drawer; honest auth-gate h1 renders there. |

### Keyboard navigation

| Item | Route(s) | PASS/FAIL | Evidence |
| --- | --- | --- | --- |
| Tab order — top nav | local `/app` | PASS | Tab sequence observed: "Skip to content" → "PaySwap — home" → Home → Capabilities → Security → Developers → Open Command Center → sidebar rows — full order captured via `document.activeElement` stepping. |
| Tab order — sidebar + accordion + topbar | local `/app` | PASS | Tab reaches sidebar rows (Home, My balances… projection-aware), ACCEPT group items (Analytics/Checkout/Disputes/Risk/In-person/QR/Agentic-links), BILL/INSIGHTS/CAPABILITIES/MORE accordion buttons, then topbar (breadcrumb → palette button → search input). |
| Accordion keyboard toggle | local `/app` | PASS | Enter on the BILL button toggles `aria-expanded` true/false; expanded state reveals Subscriptions / Invoices / Usage-based links. |
| Keyboard link navigation | local `/app` | PASS | Enter on the focused Subscriptions link navigates to `/app/billing` (route renders; first-visit module compile is a dev artifact, not a navigation failure — re-verified after warm). |
| Command palette '/' | local `/app`, `/app/payments/link` | PASS | `/` focuses the topbar universal search; typed "payments" → live results listbox ("Search and command results": New payment / Payment link / Convert); ArrowDown moves `aria-selected` (index 0→1); Enter navigates to `/app/payments/link` (h1 "Payment link"); Escape closes (`aria-expanded=false`, listbox removed). Context-aware placeholder on the link surface ("Search your account… or 'convert 2 ETH'"). |
| Payment create dialog keyboard | local `/app/payments?start=1` | PASS | Form fields tab-focusable; radio groups (One-time/Recurring, funding rails) keyboard-settable; Send stays disabled until valid (honest dependent-disable with reasons, e.g. Interval disabled-for-one-time with explanation); prefill route from search grammar lands keyboard-first into the form. |
| Consumer projection switch | local `/app` | PASS | Radio "CONSUMER VIEW" + "Apply view" → sidebar becomes My balances / My payments / My contacts / My requests + Consumer tab bar (Home/Pay/Activity/Contacts/Safety); switch back via "MERCHANT VIEW" + Apply → Home/Balances/Transactions/Customers/Catalog. Cookie-based; copy states "The projection never changes your session or your authority." |

### Search (universal search surface, topbar '/')

| Item | Route(s) | PASS/FAIL | Evidence |
| --- | --- | --- | --- |
| Universal search surface | local `/app` | PASS | Topbar combobox "Search or type a command" with context placeholder; query "payments" returns the Quick-actions group (New payment — "The create-payment workflow — compose, fund, confirm"; Payment link; Convert). Result options carry destination routes. |
| Natural-language grammar entry | local `/app` | PASS | Typed "request 50 EUR" → option "Request 50 EUR — Pre-fill: 50 · EUR — the form asks for: counterparty"; Enter → `/app/payments?start=1&amount=5000&asset=EUR` (server saw the exact query; the form opens pre-filled). |

### Navigation (public site, app shell, consumer projection)

| Item | Route(s) | PASS/FAIL | Evidence |
| --- | --- | --- | --- |
| Public site | production `/`, `/capabilities`, `/security`, `/developers` | PASS | All 200 with real content; 0 console errors; footer nav duplicates the header links (below-md the header nav is hidden — links remain reachable via footer + body CTAs; no 404s anywhere). |
| App shell + sections | production + local `/app`, `/app/{balances,payments,collections,payouts,billing,convert,customers,safety,settings}` | PASS | Every section 200 with content; sidebar active states resolve; unauthenticated production renders honest gates. |
| Consumer projection | local `/app?view=contacts`, `?view=requests`, `?view=payments`, `?payment=<id>` | PASS | Contacts → "My contacts" + "No contacts yet" empty; Requests → "My requests" + "No requests addressed to you yet"; Payments view renders the consumer home collections; `?payment=pay_test_usdc_base_to_eur` renders the consumer payment detail ("25 USDC", "Succeeded", "When it arrived", "How it was paid"). |
| Sidebar TOTAL binding sweep | local `/app/{transactions,catalog,disputes,reports,capabilities,connections,checkout,developers,agents,credit,accounts,activity,evidence,liquidity,opportunities,programs,security}` | PASS | Every sidebar registry target resolves to a real route (curl 200 × all; browser spot-verifications); the binding table in `src/lib/cc/routes.ts` folds family facets onto their hubs with named justifications — no invented routes. |

### Payment creation (the create menu + dual-amount line)

| Item | Route(s) | PASS/FAIL | Evidence |
| --- | --- | --- | --- |
| Create menu | production + local `/app` topbar | PASS | Split button "Pay" + "More create actions" opens Pay / Request money / Invoice / Payment link / Convert (with keyboard hint badges); keyboard: Enter opens, ArrowDown moves active item (Request), Enter navigates to `/app/payments?start=1`, Escape closes. |
| Crypto payment | local `/app/payments?start=1` | PASS | 25 USDC + wallet counterparty (resolved through the "Add contact" chip — "Paying 0x8f4Aa… (contact:new:…) — Change"), descriptor for manual rail; Send button restates "Send 25 USDC"; submission renders the honest journey state: `AMOUNT 25000000 USDC (minor units)` / `RECIPIENT 0x8f…` / `JOURNEY STATE SELECTING_CAPABILITY` + "No connected capability… This is the honest empty state, not an error: the provider catalogue is never treated as executable authority." |
| Fiat payment | local `/app/payments?start=1` | PASS | Currency switched to EUR; "Send 50 EUR" enabled after validation; submission → same honest SELECTING_CAPABILITY state with `5000 EUR (minor units)` + recipient `merchant@example.test`. |
| crypto → fiat | local `/app/payments/pay_test_usdc_base_to_eur` | PASS | The mandatory cross-rail disclosure (contract 05 §2.3) renders: **"Customer paid USDC on Base (USDC); settled to you in EUR via SEPA"**; Money breakdown 25 USDC paid / 0.880000 fee / 24.120000 net; "Settled to you in EUR via the optimal route (SEPA)". |
| fiat → crypto | local `/app/convert` | PASS | The conversion surface renders its honest not-dispatchable state: "No compiled conversion to show — and none invented. Route compilation requires onchain lane and venue observations… None are configured in this deployment — the honest state is an empty capability observation, never an invented route." + TESTNET/TEST mode indicators + an expandable "What this journey walks when inputs exists" contract list (disclosure verified live). |
| Journey action buttons (observed in the create flow) | local `/app/payments?start=1` | **FAIL → fixed (cert-fix 2)** | Pre-fix: "Cancel this payment" and "Connect another capability" rendered as available NAVIGATION buttons whose click did nothing (the workflow's action handler had no case for `abandon-payment` / `connect-another-capability` — silent `default: return`). Post-fix: Cancel folds through the certified `abandonPayJourney` (terminal ABANDONED state renders "Cancelled" + "View journey history" evidence link); Connect routes to `/app/capabilities`. Both verified by re-clicking in-browser on the fixed branch build. |

### Wallet authorization surface

| Item | Route(s) | PASS/FAIL | Evidence |
| --- | --- | --- | --- |
| Wallet authorization scope surface | local `/connect/mtn_momo` | PASS | Renders "What connecting MTN MoMo authorizes — and what it never does": connection scope vs withdrawal scope — "Withdrawing funds. Withdrawal is a separate, explicitly-granted authority — never a side effect of connecting."; honest BLOCKED status verbatim ("Blocked since the 2026-10-02 06:37 UTC probe: subscription key rejected HTTP 401 at the APIM gate…"); no initiation control is offered for a blocked provider (no dead button). |
| Local-rail wallet authorization | local `/connect/stellar` | PASS | "The providerless LOCAL rail — … connections run through the user-authorized browser-session path"; "your authorization happens in YOUR browser session; the app only ever holds an opaque session reference — never your keys"; Begin the connection review → `POST /api/connect/select` 200; Initiate the connection → `POST /api/connect/stellar/initiate` 503 with the verbatim answer surfaced in the `aria-live` region: "The PaySwap API runtime is not configured in this deployment (NEXT_PUBLIC_PAYSWAP_API_URL) — there is nothing to initiate against yet." |

### Stripe connection surface

| Item | Route(s) | PASS/FAIL | Evidence |
| --- | --- | --- | --- |
| Connections hub | local `/app/connections` | PASS | "No connected instances yet — the catalogue is browsable, but nothing is authorized until you connect." + "0 active connections — … nothing here implies a connection until an authority record exists." + working "Connect a provider" link → `/connect`. |
| Stripe connect flow | local `/connect/stripe` | PASS | Honest status "Verified at the platform level (probe + certification) — you are NOT connected to it." with probe evidence (VERIFIED 2026-10-02 06:37 UTC, 13/13 conformance, SCOPED_API_CREDENTIAL operator-held, honest limitations incl. "GHS not routable on this account"); "Begin the connection review" → select POST 200 (journey parks in initiation); "Initiate the connection" → 503 answer rendered verbatim in `aria-live` (quoted above) — no fake connected state. |

### Merchant checkout

| Item | Route(s) | PASS/FAIL | Evidence |
| --- | --- | --- | --- |
| Merchant checkout | local `/app/checkout` | PASS | "The merchant checkout journey: fiat-first pricing with the explicit crypto acceptance layer and customer explicit-signing." + TEST MODE/TESTNET indicators + the honest not-bound state: "No merchant checkout context is bound in this deployment — merchant onboarding and the crypto acceptance policy come first; this surface refuses to fabricate a checkout session without them." + the typed step-by-step contract (onboarding → acceptance activation → session open → explicit signing). |

### Refund flow

| Item | Route(s) | PASS/FAIL | Evidence |
| --- | --- | --- | --- |
| Refund dialog | local `/app/payments/pay_test_partial_refund` | PASS | "Refund" button labeled with the refundable remainder ("15 USDC still refundable"); dialog prefills the full remaining amount, supports partial edits, reason select uses the shared registry vocabulary (8 options incl. "Blocked by security policy"), honest rail note "Returns to the customer on Base (USDC); fees are not returned."; Escape closes; existing partial refund renders in the timeline ("A partial refund of 10 USDC was issued — 15 USDC remains refundable"). |
| Refund submission | same | PASS | Submitting "Refund 15 USDC" renders the honest not-dispatched answer: "Refund not submitted. The certified refund command (payments.refund.create) … the authenticated journey-dispatch transport does not carry the refund command on its allowlist in this deployment. Nothing was refunded and nothing here pretends otherwise: the refund outcome on the payment (state, remaining amount, timeline event) changes only when the authoritative API records it." The payment state stays "Partially refunded" — unchanged, honest. |

### State rendering (honest-states vocabulary / StatusChip tokens)

| Item | Route(s) | PASS/FAIL | Evidence |
| --- | --- | --- | --- |
| failed payment | local `/app/payments/pay_test_failed_insufficient` | PASS | Failed chip + protocol-sourced reason "Insufficient balance — The source wallet holds less than the payment amount." + actionable next steps (top up / switch rail) + verbatim API error "API error insufficient_balance (VALIDATION)" + timeline event. |
| UNKNOWN transaction | local `/app/payments/pay_test_nonexistent` | PASS | "Payment not found — The requested payment does not exist: pay_test_nonexistent — looked up in test mode … Nothing is fabricated in its place. Deep links stay honest: this is the dedicated not-found state, not an error." (INV-X01 honored.) |
| security block | local `/app/capabilities` | PASS | StatusPill **BLOCKED** (tone `blocked`): "Recorded non-connection example, verbatim from the release record — MTN MoMo: BLOCKED" with the verbatim probe detail; plus the COMPLIANCE_BLOCKED terminal-state card ("Blocked by compliance policy… INV-R04… not retryable from this surface"). |
| security warning | local `/app/safety` | PASS | SecurityWarnings renders the honest empty: "No active warnings — … Silence here means nothing is recorded, not that checks are off. Risk insights are only available for live data — none is fabricated for test records." (warning records render from the real risk plane only — none invented). |
| empty state | local `/app/customers`, `/app?view=contacts`, `/app?view=requests` | PASS | "No customers yet — Customers appear here automatically when someone pays through your hosted payment pages or payment links… No customer is ever fabricated." + "Create a payment link" CTA; contacts/requests honest empties; convert "No compiled conversion to show — and none invented." |
| loading state | local `/app/payments?start=1` (submission), `/connect/stripe` | PASS | In-button Processing with live labels ("Dispatching the payment submission to the authoritative PaySwap API…" `role=status`; "Opening the connection review" / "Initiating" on the connect buttons); the in-flight payment state renders "Processing — In flight — the outcome is not yet known, and that is not a failure." |
| error state | local `/app/capabilities`, `/connect/stripe` | PASS | "API runtime not configured" ErrorState with a live Retry button (click verified: `router.refresh()` re-rendered the server panel); the 401/503 transport answers render verbatim in the live region — never as fake success. |
| success state | local `/app/payments/pay_test_usdc_base_to_eur` | PASS | Succeeded chip + "Settled to you in EUR via the optimal route (SEPA)" + evidence timeline ("Payment succeeded" event) + fees/net breakdown. |
| StatusChip vocabulary (list surface) | local `/app/payments` | PASS | The fixture list renders the vocabulary end-to-end: Succeeded \| Partially refunded \| Processing \| Failed, with a Failure-reason column and honest TEST marking: "Showing clearly-marked TEST records — WEB_APP_TEST_PAYMENT_FIXTURES is enabled for this deployment. Fixture data (pay_test_*ids), never real money." (no mock-as-real; every fixture id carries `pay_test_`). |

## Console-error audit

| Environment | Scope | Result |
| --- | --- | --- |
| Production (payswap-web.vercel.app) | Full desktop walk (4 public + 13 app routes), tablet + mobile sweeps, drawer navigation, create-menu interaction | **0 console errors, 0 page errors** (agent-browser `console` / `errors` queried after every navigation; final sweep greps returned 0 error-level entries). |
| Local dev (:4173, webpack) | All battery routes listed above, including the full payment-create flow, refund submission, connect flows, projection switch, palette | **0 console errors, 0 page errors.** One Next.js dev-tools advisory **warning** ("Detected scroll-behavior: smooth on the <html> element… add data-scroll-behavior") appears only in dev mode; it is a framework hint, not an app error, and does not appear in production. |

## cert-fixes applied (branch `ux-cert`)

1. **`8ff4cfa` — cert-fix: settings auth links point at the real session routes.** The Settings "Authentication and connections" panel linked `/login` (a dead route — 404) while describing it as a parallel-workstream hand-off. It now offers sign-in/sign-out per the live session state (`/signin`, `/signout`, `/connect` — all real routes). Found during the §20 battery (settings surface).
2. **`ef315f0` — cert-fix: pay journey NAVIGATION actions resolve to real behaviors (no dead buttons).** "Cancel this payment" (`abandon-payment`) and "Connect another capability" (`connect-another-capability`) rendered as available buttons with silent no-op handlers. Cancel now folds through the certified `abandonPayJourney` (terminal ABANDONED state; the submitted-intent refusal surfaces as the honest note); Connect routes to `/app/capabilities` (the empty state's own destination). Both re-verified by clicking in-browser post-fix.
3. **`f43c289` — cert-fix: keep the mobile viewport zero-overflow (topbar wrap + in-panel table scroll).** At 375×667 the topbar end cluster (541px) pushed `/app` to 557px and the payments table (900px) pushed the page to 917px. The end cluster now wraps below 640px and `.ps-listpage__tablewrap` scrolls horizontally within its panel — matching the design system's own zero-overflow rule. Post-fix local verification: `scrollWidth=375` on `/app` and `/app/payments`; tablet 768 unaffected.

All fixes are minimal and contract-preserving: `spec/experience/contracts/` untouched; `packages/web` suite **561/561 passing**; `packages/design` suite **218/218 passing** (the CSS fix lives in the design system stylesheet).

## Dev-environment notes (observed, non-defects)

- **In-memory session + on-demand dev compiles:** the local dev server keeps the session store in module memory; the first request that compiles (or re-resolves) a route resets it — sessions drop and the honest auth gate renders until the next sign-in. The codebase itself documents this as a known dev-only limitation of the session seam. The battery worked around it by pre-warming routes (HTML + RSC variants + API routes) before each authenticated pass; production (fully built) never exhibits it. Recorded here because an honest report names the environment's behavior.
- **One transient dev-infrastructure error:** during the very first grammar-command navigation (`request 50 EUR` → prefill route) the browser hit a `Runtime ChunkLoadError` (stale client chunk vs. freshly compiled server module — a webpack dev artifact). Re-running the identical flow on the warmed route rendered correctly with the prefilled form; the flow itself is real (verified end-to-end, see the Search row). No such error exists in production (static chunks).
- **Honest UNKNOWN states are by design:** with `NEXT_PUBLIC_PAYSWAP_API_URL` unset, journey dispatches answer 401/503 and the surfaces render those answers verbatim (INV-X01). The battery treats these as PASS — per the work order, honest UNKNOWN is correct behavior, not failure.

## Verdict

Every §20 battery line item above passes on the `ux-cert` branch (the three FAILs found were each reproduced in-browser, fixed minimally with a `cert-fix:` commit, and re-verified). No dead buttons, fake success states, placeholder workflows, mock-as-real data, broken navigation, or console errors survive on the branch. The production deployment still exhibits the two fixed defects until the Tech Lead merges `ux-cert` (noted in the viewport and payment-creation rows — the deployed base build predates the fixes).

VERDICT: CERTIFIED

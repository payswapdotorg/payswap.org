# P3-W2-003 — Responsive, Accessibility and Visual Verification Matrix

Status: executed 2026-10-03 (Worker 2)
Deployment under test: https://payswap-web.vercel.app (public URL)
Base: `8f6eedb` (branch `work/P3-W2-003`)

This is the binding verification plan for the work order's acceptance: major
journeys at desktop and mobile widths, keyboard/focus/navigation, console
errors eliminated, loading/error/empty/UNKNOWN states visually verified,
screenshots as evidence, the You-platform-inspired visual system, and no dead
buttons or broken deep links.

## 1. Method legend (how a cell is verified)

| Code | Method | Where it runs | Evidence |
|---|---|---|---|
| **K** | `packages/web/test/a11y-keyboard.test.tsx` — jsdom keyboard contracts (focus trap + restore, Esc, roving tabindex, skip-link first-focus, ⌘K) | `npm run test --workspace @payswap/web` | vitest run log (TL gate) |
| **A** | `packages/web/test/a11y-aria.test.tsx` — roles/labels, aria-describedby, aria-live, aria-current, landmarks, focus-visible styles | same | same |
| **D** | `packages/web/test/a11y-deep-links.test.tsx` — every nav href resolves against the route inventory; inventory matches the filesystem; no dead buttons | same | same |
| **H** | `packages/web/test/honest-states.test.tsx` — loading/error/empty/UNKNOWN/auth-required honest copy; UNKNOWN never reads as failed | same | same |
| **B** | `packages/web/scripts/verify-visual.mjs` — live Chrome (CDP, zero deps) against the DEPLOYED site: screenshot per route × viewport, no-overflow assertion, console-error collection, deep-link HTTP resolution, keyboard spot-checks | sandbox (ran) / TL (re-runnable) | `evidence/<route>--<viewport>.png` + `evidence/manifest.json` |
| **L** | Live-browser-ONLY cell — no jsdom/static approximation can prove it (pixels, layout, real focus paint, real console). Verified by **B**. | browser | screenshots + manifest |
| **N/O** | Not observable in THIS deployment without a session/credentials or an injected backend failure. The contract is still pinned by the component-level suite (**K/A/H**); the cell is honestly marked instead of simulated. Honest per `AGENTS.md` law 4 and the design foundations §4. | — | suite result + this note |

Verdict laws for **B** (recorded per cell in `manifest.json`):

1. HTTP status must equal the route's expected status (200, or 404 for the
   honesty probes).
2. `document.documentElement.scrollWidth <= window.innerWidth` at BOTH
   1440×900 and 390×844 (no horizontal overflow).
3. Zero console errors / uncaught exceptions per page.
4. The honest-state marker for the route must be present in the rendered DOM
   (e.g. the auth gate copy on gated `/app` sections).

## 2. Route inventory (authoritative)

Source of truth: `packages/web/src/app/**/page.tsx` (filesystem), mirrored in
`test/a11y-deep-links.test.tsx` which FAILS if the two drift apart.

| # | Route | Group | Expected status | Screenshot id |
|---|---|---|---|---|
| 1 | `/` | public | 200 | `home` |
| 2 | `/capabilities` | public | 200 | `capabilities` |
| 3 | `/security` | public | 200 | `security` |
| 4 | `/developers` | public | 200 | `developers` |
| 5 | `/signin` | auth group | 200 | `signin` |
| 6 | `/signout` | auth group | 200 | `signout` |
| 7 | `/connect` | auth group | 200 | `connect` |
| 8 | `/reauth` | auth group | 200 | `reauth` |
| 9 | `/onboarding` | auth group | 200 | `onboarding` |
| 10 | `/app` | Command Center | 200 | `app` |
| 11 | `/app/activity` | Command Center | 200 | `app-activity` |
| 12 | `/app/agents` | Command Center (role-derived) | 200 | `app-agents` |
| 13 | `/app/billing` | Command Center (role-derived) | 200 | `app-billing` |
| 14 | `/app/capabilities` | Command Center | 200 | `app-capabilities` |
| 15 | `/app/collections` | Command Center | 200 | `app-collections` |
| 16 | `/app/credit` | Command Center (role-derived) | 200 | `app-credit` |
| 17 | `/app/developers` | Command Center (role-derived) | 200 | `app-developers` |
| 18 | `/app/disputes` | Command Center (role-derived) | 200 | `app-disputes` |
| 19 | `/app/evidence` | Command Center | 200 | `app-evidence` |
| 20 | `/app/liquidity` | Command Center (role-derived) | 200 | `app-liquidity` |
| 21 | `/app/opportunities` | Command Center (role-derived) | 200 | `app-opportunities` |
| 22 | `/app/payments` | Command Center | 200 | `app-payments` |
| 23 | `/app/payouts` | Command Center | 200 | `app-payouts` |
| 24 | `/app/programs` | Command Center (role-derived) | 200 | `app-programs` |
| 25 | `/app/settings` | Command Center | 200 | `app-settings` |
| 26 | `/api/health` | API (JSON, no viewport) | 200 | — (fetch probe only) |
| P1 | `/app/nonsense` | honesty probe — UNKNOWN deep-link notice | 404 | `probe-app-unknown` |
| P2 | `/does-not-exist` | honesty probe — root 404 | 404 | `probe-root-404` |

`/connect/[providerId]` is a dynamic route; concrete deep links (one per
catalogue provider, e.g. `/connect/stripe`) are extracted from the rendered
`/connect` page by the harness and HTTP-resolved (deep-link law), with
`/connect/stripe` additionally screenshotted.

Viewports: **desktop 1440×900** and **mobile 390×844** (iPhone 12/13-class,
per the work order).

## 3. State semantics in THIS deployment

The deployment is the honest Wave-1/2 surface: unauthenticated visitors get
real server-rendered pages, and every `/app` section renders the honest
authentication gate (`CcAuthGate`) instead of data. That fixes each state's
meaning per route:

- **default** — the route as an unauthenticated visitor sees it (static
  server render; no client fetch in flight).
- **loading** — transport-level pending affordances only (Button `loading` +
  `aria-busy`, `Skeleton` `role=status`, the sign-in Suspense fallback).
  Server components stream; there is no fake client spinner theater.
- **error** — `ErrorState`/`CcErrorRetry` surfaces (server-fetch failure) and
  the sign-in form's verbatim failure/live-region. Requires a failing backend
  to trigger live → **N/O** for pixels, pinned by **H** for copy/semantics.
- **empty** — `EmptyState` surfaces with honest copy (no connected instances,
  no session to sign out, provider not in catalogue…).
- **UNKNOWN** — outcome-not-yet-known surfaces: `UnknownState`
  (reconciliation language), the unmatched-`/app`-path notice, and the honest
  blocked/unknown provider statuses on `/capabilities`.
- **auth-required** — `CcAuthGate` on all `/app` sections (directly reachable
  unauthenticated) and the connect-flow gates.

## 4. The matrix

Cell format: `check — method(s) — evidence`. Evidence `B` cells resolve to
`evidence/<screenshot-id>--{desktop-1440|mobile-390}.png` and one row in
`evidence/manifest.json`; suite methods resolve to the TL gate run log.

### 4.1 Public pages (`/`, `/capabilities`, `/security`, `/developers`)

| State | Desktop 1440×900 | Mobile 390×844 |
|---|---|---|
| default | Visual system (stone/emerald, You-inspired chrome), header/nav/footer landmarks, one `h1`, honest copy — **A, B, L** — `evidence/<page>--desktop-1440.png` | No horizontal overflow, nav collapses to the `<details>` disclosure (44×44 summary), touch targets ≥44px, no clipped text — **B, L** — `evidence/<page>--mobile-390.png` |
| loading | N/A — fully static server render, no async surface (by design; no spinner theater). Button/Skeleton contracts still pinned globally — **H** | same |
| error | N/A — no client fetch to fail; server errors surface Next's error boundary (deployment-level, out of this matrix's control) — documented | same |
| empty | N/A — editorial pages always have content. (`/capabilities` shows the honest "built, awaiting credentials" and BLOCKED coverage — that is data, not emptiness) — **H** | same |
| UNKNOWN | `/capabilities` only: MTN MoMo BLOCKED status rendered honestly (never softened to connected) — **A, H, B, L** — `evidence/capabilities--*.png` | same check at 390px — **B, L** |
| auth-required | N/A — public by design | same |

### 4.2 Auth group (`/signin`, `/signout`, `/connect`, `/reauth`, `/onboarding`)

| State | Desktop 1440×900 | Mobile 390×844 |
|---|---|---|
| default | Landmarks, labelled form fields (Field label/hint wiring), honest session status — **A, B, L** — `evidence/<page>--desktop-1440.png` | No overflow; form fields usable at 390px; focus rings visible — **B, L** — `evidence/<page>--mobile-390.png` |
| loading | Sign-in submit pending: Button `aria-busy` + sr-only "Signing in" label, form live region — **K, H**. Live pixel capture of the pending button is **N/O** (needs real credentials + latency; never faked) | same |
| error | Sign-in failure copy verbatim in `aria-live=polite` region; `aria-describedby` error wiring on fields — **A, H**. Live trigger **N/O** (needs wrong credentials POST; the harness does NOT fire fake auth attempts against the deployed plane) | same |
| empty | `/signout` unconfigured/no-session EmptyState; `/connect` catalogue statuses; `/onboarding` honest no-session state — **H, B, L** — `evidence/signout--*.png`, `evidence/connect--*.png` | same at 390px — **B, L** |
| UNKNOWN | `/connect/[providerId]` UnknownState import path + reauth journey ambiguity language — **H**; live reachability of the reconcile surface needs a session — **N/O** for pixels | same |
| auth-required | Connect-flow gates when identity plane is unconfigured — **H, B** — `evidence/connect--*.png` | same — **B** |

### 4.3 Command Center (`/app` + 15 sections)

All 16 routes are directly reachable unauthenticated; each renders the shell
(sidebar ≥1024px, topbar, drawer <1024px) with the honest gate inside.

| State | Desktop 1440×900 | Mobile 390×844 |
|---|---|---|
| default | Shell renders: static sidebar (aria-current on active section), topbar breadcrumb, ⌘K trigger, palette; gate copy for the section — **A, K, B, L** — `evidence/app-*--desktop-1440.png` | Sidebar collapses; menu button opens `SidebarDrawer` (dialog semantics, focus trap, Esc); no overflow with `min-width:0` law — **K, B, L** — `evidence/app-*--mobile-390.png` |
| loading | Section content is server-rendered behind `CcSection` (a gated page never runs its fetches); loading affordances are the design-system contracts — **H**. Live skeleton pixels need an authenticated slow fetch — **N/O** | same |
| error | `CcErrorRetry` (ErrorState + router.refresh) pinned by **H** (copy) and **K** (retry button is a real, working button — no dead button). Live trigger needs a failing API — **N/O** | same |
| empty | Authenticated-but-no-data empties (e.g. payments with zero connected instances) — **H** (EmptyState copy). Unauthenticated renders the gate instead — honest, never fabricated data — **B** confirms the gate marker | same |
| UNKNOWN | (a) unmatched `/app` path notice — live at `/app/nonsense` — **B, L** — `evidence/probe-app-unknown--*.png`; (b) journey RECONCILING UnknownState language — **H**; pixels need a session — **N/O** | same |
| auth-required | THE state every `/app` route shows unauthenticated: "authentication required", "not yet wired in this deployment", role preview marked as never-an-authentication, zero credential capture, zero financial claims — **A, H, B, L** — all 16 × 2 screenshots | same |

### 4.4 API + probes

| Route | Check | Method | Evidence |
|---|---|---|---|
| `/api/health` | 200 JSON; no viewport applies | **B** (fetch) | `manifest.json` entry |
| `/app/nonsense` | 404 + the honest unmatched-path notice | **B, L** | `evidence/probe-app-unknown--*.png` |
| `/does-not-exist` | 404 + root not-found with a working "Back to home" link | **B, D, L** | `evidence/probe-root-404--*.png` |

**Ground truth recorded (verified against BOTH the deployed build and a
local production build of this source):** for a FULLY-unmatched `/app/*`
path, Next.js 16 serves the ROOT `not-found.tsx` ("Page not found", which
itself explains that Command Center deep links live under `/app`). The
app-group `app/app/not-found.tsx` ("Unrecognized Command Center path")
only renders for `notFound()` calls thrown inside a MATCHED `/app` segment
— no live trigger exists today. Both notices are honest 404s with working
links; the harness marker accepts the truthful union and records the
behavior per run. The `app/not-found.tsx` docstring's broader claim
("unmatched /app/* paths render this notice") is a semantic mismatch
worth a future catch-all route decision — documented here for the TL, not
changed unilaterally by this work order (no suite proves a defect: the
404 rendered is honest and the deep-link inventory is fully intact).

## 5. Cross-cutting contracts (every route)

- **Keyboard/focus** — **K**: skip link is the first focusable element and
  lands on a focusable `#main-content`; Tab reaches every interactive element
  in DOM order; dialog/palette/drawer trap focus and restore it on close;
  Esc closes every overlay; Tabs use roving tabindex; ⌘K/Ctrl-K opens the
  palette. Live spot-checks in **B** (drawer open/Esc/close, palette
  open/Esc/close on the deployed app).
- **Deep links** — **D**: PRIMARY_NAV, footer, CC nav (per role), gate links,
  not-found links and palette commands all resolve to real routes; the
  harness HTTP-checks every anchor it finds on the deployed pages.
- **No dead buttons** — **D/K**: every rendered `<button>` has an accessible
  name; known action buttons (retry, dismiss, drawer open, palette trigger)
  are clicked in jsdom and their effect asserted.
- **Console errors** — **B**: zero per page at both widths (collected via
  `Runtime.consoleAPICalled` / `Runtime.exceptionThrown` / `Log.entryAdded`).
- **Visual system** — **A** (structural: focus-visible rings, semantic token
  classes, 44px touch targets) + **L** (pixels: screenshots reviewed against
  the You-platform-inspired stone/emerald system).

## 6. Honest verification boundaries

- Cells marked **N/O** above cannot be truthfully verified in this deployment
  without a session, credentials, or an injected backend failure. Simulating
  them would violate the repository's honesty laws; they are pinned at the
  component-contract level instead and listed for the TL's authenticated
  pass.
- **B** ran in the Worker-2 sandbox against the deployed site at base
  `8f6eedb` — **56/56 route×viewport cells PASS, 0 console errors, 0
  horizontal-overflow failures, 0 broken deep links** (see
  `evidence/manifest.json`). A SECOND run verified a local production
  build of this branch (which carries the defect fixes) into
  `evidence-local/` — also 56/56 PASS, and the live skip-link keyboard
  check records focus landing on `#main-content` (`activeId:
  "main-content"`), proving defect fix D1 in a real browser.
- Defect fixes made on this branch (see the work report) are proven by the
  vitest suites and the local harness run; the TL re-runs
  `verify-visual.mjs` after merge+redeploy to confirm them on the
  deployment:
  `node packages/web/scripts/verify-visual.mjs` (env overrides:
  `VERIFY_VISUAL_BASE_URL`, `VERIFY_VISUAL_BROWSER`, `VERIFY_VISUAL_EVIDENCE_DIR`).

# Browser verification evidence — P4-W4-002 universal interface

Recorded with the platform browser automation (agent-browser/Playwright)
against a local dev server (`npx next dev --webpack --port 3111` from
`packages/web`) at commit `347e856` on branch `work/P4-W4-002`.

**Regeneration:** `cd packages/web && npx next dev --webpack --port 3111`,
then open the routes below in a Chromium browser; set the viewport to
1440x900 (desktop) and 390x844 (mobile); apply a role preview on the
auth gate (View as role → merchant → Apply) to render the section
surfaces without a session (the clearly-marked preview affordance —
session-scoped data keeps its honest unavailable states).

| Evidence file | Viewport | Route | Verified rendered behavior |
|---|---|---|---|
| desktop-app-overview.png | 1440x900 | /app | 5 outcome-action cards (Pay/Receive/Move/Convert/Checkout) with honest not-dispatchable states + prerequisites; universal-areas sidebar group |
| desktop-convert.png | 1440x900 | /app/convert | TEST MODE + TESTNET indicators; honest no-lane-observations state; advanced-disclosure contract |
| desktop-checkout.png | 1440x900 | /app/checkout | honest no-merchant-context state; fiat-first typed journey steps with merchant/customer badges |
| desktop-security.png | 1440x900 | /app/security | BLOCK gate vocabulary in people language with drilldown open (unlimited-allowance reason + invariant refs + evidence) |
| desktop-accounts.png | 1440x900 | /app/accounts | honest empty state — balances are provider observations, never custody |
| mobile-app-overview.png | 390x844 | /app | 5 outcome cards render in one column; sidebar collapses to the drawer |
| mobile-convert.png | 390x844 | /app/convert | mode indicators + honest state at mobile width |
| mobile-checkout.png | 390x844 | /app/checkout | journey steps readable at mobile width |
| mobile-connections.png | 390x844 | /app/connections | catalogue-never-connection law visible |

Console verification across all captures: **0 console errors, 0 page
errors** (only the React DevTools info line). No dead buttons — every
rendered internal link resolves to a real route (asserted by
`test/a11y-deep-links.test.tsx` against the filesystem route inventory).
No fake financial success — asserted by
`test/universal-interface.test.tsx` (adversarial scans) and visible in
every capture: undispatchable surfaces state their typed prerequisites.

---

# Certification journey captures — P4-W4-003 (this directory: `cert/`)

All 20 certification captures under `packages/web/evidence/cert/` (10
areas × 2 viewports), recorded on branch `work/P4-W4-003` over base
`bf41475` for the Phase-4 full-production-certification work order.

**Method:** headless Playwright 1.63 (cached Chromium) driving
`npx next dev --webpack` (localhost:4321, packages/web) — desktop
viewport 1440x900, mobile viewport 390x844; merchant role applied via the
documented preview affordance (`ps-cc-role=merchant` cookie — exactly
what the RoleSwitcher server action sets; session-scoped data keeps its
honest unavailable states). Per page the script asserts: HTTP 200, **zero
console errors, zero page errors**, then click-probes every visible
disclosure (`<summary>`), internal link, and enabled button, recording
`disclosed/mutated` (DOM mutated), `navigated` (route change), or
`NO-OBSERVABLE-EFFECT` (dead-button candidate) — full-page screenshot
after the probes. 20 pages, 83 click probes, **0 console errors, 0 page
errors, 0 dead-button candidates** (machine-verified over the per-page
records banked in `cert/journeys/*.json`; throwaway capture script kept
in `/tmp` only, per the certification-only no-new-test-code law).

| Capture (in `cert/`) | Viewport | Route | Probes on this page |
|---|---|---|---|
| desktop-overview.png | 1440x900 | /app | 5 outcome cards, all honestly not-dispatchable (data-dispatchable=false ×5); 4 disclosures + 4 buttons all mutated |
| desktop-pay.png | 1440x900 | /app/payments?start=1 | Pay journey entry; 3 buttons all mutated |
| desktop-payments.png | 1440x900 | /app/payments | payments area; 3 buttons all mutated |
| desktop-convert.png | 1440x900 | /app/convert | TEST + TESTNET mode indicators present; disclosure + 3 buttons mutated |
| desktop-checkout.png | 1440x900 | /app/checkout | honest no-context state; 3 buttons all mutated |
| desktop-security.png | 1440x900 | /app/security | BLOCK/ALLOW/UNKNOWN vocabulary all present; disclosure + 3 buttons mutated |
| desktop-accounts.png | 1440x900 | /app/accounts | observation-never-custody vocabulary present; 3 buttons mutated |
| desktop-connections.png | 1440x900 | /app/connections | catalogue-never-connection vocabulary present; 3 buttons mutated |
| desktop-opportunities.png | 1440x900 | /app/opportunities | honest opportunities empty state; 3 buttons mutated |
| desktop-reports.png | 1440x900 | /app/reports | honest reports empty state; 3 buttons mutated |
| mobile-overview.png | 390x844 | /app | same 5 honest outcome cards at mobile width; 4 disclosures + 4 buttons mutated |
| mobile-pay.png | 390x844 | /app/payments?start=1 | Pay journey at mobile width; disclosure + 3 buttons mutated |
| mobile-payments.png | 390x844 | /app/payments | disclosure + 3 buttons mutated |
| mobile-convert.png | 390x844 | /app/convert | TEST + TESTNET indicators at mobile width; 2 disclosures + 3 buttons mutated |
| mobile-checkout.png | 390x844 | /app/checkout | honest no-context state; disclosure + 3 buttons mutated |
| mobile-security.png | 390x844 | /app/security | BLOCK/ALLOW/UNKNOWN vocabulary; 2 disclosures + 3 buttons mutated |
| mobile-accounts.png | 390x844 | /app/accounts | observation vocabulary; disclosure + 3 buttons mutated |
| mobile-connections.png | 390x844 | /app/connections | catalogue vocabulary; disclosure + 3 buttons mutated |
| mobile-opportunities.png | 390x844 | /app/opportunities | disclosure + 3 buttons mutated |
| mobile-reports.png | 390x844 | /app/reports | disclosure + 3 buttons mutated |

**Regeneration:** `cd packages/web && PORT=4321 npx next dev --webpack`
(the `--webpack` flag is required — Next 16 exits on a webpack config
without an explicit bundler choice), then run the areas at both viewports
with the merchant preview cookie; the per-page JSON records in
`cert/journeys/` are the machine-checkable form of this table.

**Honest capture notes (classification recorded, not hidden):** (1) two
text-presence probes read the *pre-interaction* `innerText` and returned
false because the target strings live inside collapsed disclosure
widgets at initial render (`innerText` excludes closed-`<details>`
content): checkout's "no merchant context" line and overview's
prerequisite lines — both phrases exist in the component sources
(`checkout-surface.tsx`, `outcome-launcher.tsx`) and are visible in the
post-interaction captures; not an app error. (2) Chunk provenance: the
captures were taken in several script invocations (dev-server restarts
and two Chromium renderer kills under sandbox memory pressure —
environment casualties, not page failures; every recorded page is a
complete record: screenshot + zero errors + click results). Two chunk
records (`dsk3`, `mob3`) lack the `finishedAt` marker because their
processes were killed after their last recorded page completed — all
their recorded pages are complete with zero errors.

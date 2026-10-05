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

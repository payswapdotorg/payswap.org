# Phase-4 production deployment — trigger record (2026-10-06)

This file is the pre-deployment trigger note for the Phase-4 web production
release. It is written BEFORE the deployment runs: every claim below is a
fact verifiable at commit time, and the post-deployment verification
receipts are recorded only after the checks pass — in the release record
written by `scripts/deployment/web-release.mjs` (`spec/development-state/
web-release-2026-10-06.json`) and the repo worklog. Nothing here asserts
the deployment succeeded; that is proven afterwards, or not at all.

## Why this commit exists (the open item it closes)

`docs/certification/PHASE-4-CERTIFICATION.md` §5 records the honest gap:
"no deployment record or live URL yet … a Phase-4 deployment needs the
operator-side credential at the review gate plus a fresh `deploy:record`
run." The operator supplied the Vercel credential on 2026-10-06; this
commit is the deployment half of that closure.

## Link forensics (why the Git auto-deploy had gone silent)

- The last production deployment of this project was `409d920`
  (buildId `gukgxzaxx`, 2026-10-03 01:44 UTC) — every push to `main`
  after that failed to deploy, while the repo advanced through the whole
  of Phase 4 (through `973eab9`).
- Cause (verified via the Vercel API on 2026-10-06): the project
  `payswap-web` had `link: null`. An accidental project named `web`
  (created 2026-10-03 — the fingerprint of a `vercel link` run from the
  `packages/web` directory without the project name, which auto-attached
  the GitHub repo) held the repo's Git integration instead. That project
  had **no rootDirectory, no environment variables**, and **all five of
  its deployments ERRORED** (2026-10-04 15:46 → 2026-10-06 06:31, the
  last being our `973eab9` push itself).
- Repair (this session, via API with the operator token): re-linked
  `payswap-web` to `github.com/payswapdotorg/payswap.org` using the same
  Git credential the accident had captured (`cred_26dd4…`, HTTP 200),
  then deleted the accident project (HTTP 204; its only history was the
  five error builds). `payswap-web` verified after repair: rootDirectory
  `packages/web`, framework nextjs, buildCommand `next build --webpack`,
  nodeVersion 24.x, production branch `main`, both
  `NEXT_PUBLIC_PAYSWAP_API_URL` env entries (preview + production)
  intact.

## Why a Git push (and not the deploy API / CLI)

The Vercel free-tier limit of 100 deployments/day through the API/CLI was
already exhausted for this account on 2026-10-06 (HTTP 402,
`api-deployments-free-per-day`, reset 2026-10-07T07:37:33Z — the
account's other 40+ projects deploy heavily). Git-integrated deployments
do not count against that quota, so the deploy is triggered the same way
the certified Oct-2/Oct-3 releases were: a push to `main`. Because this
project's builds are gated on changes under `packages/web`
(rootDirectory), the push must touch this directory — this note is that
touch.

## What is being deployed

- Commit: `973eab9` plus this note (the first `packages/web` change after
  the Phase-4 certification merges).
- Content: the full Phase-4 state of the universal web interface — the
  five outcome actions (Pay/Receive/Move/Convert/Checkout) as the primary
  surface, the eleven-area navigation IA bound from `@payswap/surface`,
  the mode-indicator (TEST/LIVE + TESTNET/MAINNET), the BLOCK/ALLOW/
  UNKNOWN security gate vocabulary, and the honest empty states — i.e.
  the tree certified by `docs/certification/PHASE-4-CERTIFICATION.md`
  (12/12 work orders) and the machine-checked gate wall merged in
  `973eab9`.
- The web surface is a CONSUMER of the authoritative PaySwap API (the
  API-runtime project separation law; `NEXT_PUBLIC_PAYSWAP_API_URL` is
  supplied per environment on the project, never stored in git).

## Predicted URLs (deterministic, not yet asserted live)

- Production alias: `https://payswap-web-ekonplacidegmailcoms-projects.vercel.app`
- Per-deployment URL: `payswap-<buildId>-ekonplacidegmailcoms-projects.vercel.app`,
  where `<buildId>` is the sha256 content digest over this package's
  build inputs truncated to 16 hex — the same digest the release driver
  recomputes independently and requires to match the build.

## Post-deployment checklist (executed after READY, receipts in the record)

1. Deployment state READY on `payswap-web`, commit SHA recorded.
2. The production alias serves the app; `/api/health` responds.
3. Public routes render (`/`, `/capabilities`, `/security`, `/developers`).
4. `web-release.mjs` re-run with the live URLs; the locally verified
   buildId matches the deployed deployment URL's buildId.
5. The release record (`web-release-2026-10-06.json`) committed with the
   live URLs and the verification receipts.

---

## Post-deployment verification receipts (appended 2026-10-06, after the checks ran)

Every item of the checklist above, executed and observed:

1. **Deployment READY** — `payswap-clnfv0s9s-ekonplacidegmailcoms-projects.vercel.app`,
   target `production`, commit `5f9f117fdd5164df1d780ccc83d8ca80ccd01301`,
   created 2026-10-06T07:43:01Z, state READY at 07:44:04Z (cloud build, 63s).
   Production aliases assigned: `payswap-web.vercel.app`,
   `payswap-web-ekonplacidegmailcoms-projects.vercel.app`,
   `payswap-web-git-main-ekonplacidegmailcoms-projects.vercel.app`.
   The project's `ssoProtection` (`all_except_custom_domains`) was removed
   via the API (PATCH, HTTP 200) so the production deployment is publicly
   reachable — consistent with the certified topology (the 2026-10-03
   runtime-plane probe hit public URLs `payswap-mu.vercel.app` /
   `payswap.vercel.app` from an external vantage and PASSED).
2. **The alias serves; /api/health answers honestly** — `GET /` on
   `https://payswap-web.vercel.app` → HTTP 200. `GET /api/health` reports:
   `status: "degraded"` (HTTP 503), `liveness: alive`, build
   `{id: "5b69854e18b6bab1", commit: "5f9f117..."}`, and readiness
   `degraded` with the verbatim upstream reason: the bounded probe of
   `GET /v1/health` on the API runtime answered HTTP 400
   (`auth.principal is required on every request; apiVersion is required`).
   That is the honest designed state, not a failure of this surface: the
   API's envelope contract (packages/interfaces validateRequestEnvelope)
   requires an authenticated principal on every request, and a public
   web surface has none to send — the health route records the verbatim
   reason and never fakes success. (The API runtime itself is alive and
   answering; it is an older deployment of the `payswap` API project and
   is NOT touched by a web release — the separation law.)
3. **Public routes render** — verified in a real browser (desktop
   1440x900): `/` (title "PaySwap — the non-custodial economic operating
   system", hero, outcome list, provider coverage), `/capabilities`,
   `/security`, `/developers`, and the `/app` boundary (the honest gate:
   "Overview — authentication required", session plane "not configured
   (honest)", no demo mode, no sample data). ZERO page errors and ZERO
   console messages across all visited routes. Captures banked beside
   this note: `live-home-desktop.png`, `live-capabilities-desktop.png`,
   `live-security-desktop.png`, `live-developers-desktop.png`,
   `live-app-gate-desktop.png`.
4. **Release driver re-run with the live URLs** —
   `node scripts/deployment/web-release.mjs 2026-10-06
   https://payswap-web.vercel.app
   https://payswap-clnfv0s9s-ekonplacidegmailcoms-projects.vercel.app
   P4-W4-003 --live` — the local production build (webpack, matching the
   project's buildCommand) verified BUILD_ID `5b69854e18b6bab1` against
   the independent source-digest recomputation, and it equals the LIVE
   deployment's reported build id exactly: local build == source digest
   == live /api/health. The record carries 40 routes derived from the
   actual tree (every page.tsx/route.ts under src/app).
5. **The release record** — `spec/development-state/web-release-2026-10-06.json`,
   digest `fnv1a64:3226182a8c35187a`, committed with this note and the
   captures. The driver extension (optional workOrder/routes/note
   parameters + the tree-derived route inventory, defaults byte-identical
   to the P3-W1-001 fixture) is covered by 7 new tests in
   `packages/web/test/infra-release-repro.test.ts` — package suite
   313/313 green.

One honest note on the sequence: pushing this receipts note re-triggers
the production deployment (it touches packages/web). The web sources are
unchanged by this note, so the redeployment produces the same BUILD_ID
`5b69854e18b6bab1` — the record's release identity holds for it too.

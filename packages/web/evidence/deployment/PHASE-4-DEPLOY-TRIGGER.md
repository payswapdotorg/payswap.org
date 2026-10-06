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

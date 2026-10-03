# Web Rollback Runbook — `payswap-web` (P3-W1-003)

Status: Active runbook — 2026-10-02
Scope: the Vercel project **`payswap-web`** (public web surface, root
directory `packages/web`) ONLY. The API/runtime host is the SEPARATE Vercel
project **`payswap`** and is NEVER touched by a web rollback (the web
surface is a consumer of the authoritative API; the web app holds no
financial state, so a web rollback rolls back CODE + PRESENTATION only —
there is no data to roll back).

Automation: `node scripts/deployment/web-rollback.mjs [--to <url|uid>] [--record]`
prints the exact plan (credential-gated dry-run, exit 0) and, with
`VERCEL_TOKEN` bound, executes the rollback + verification through the
Vercel API. The script refuses to touch any project other than `payswap-web`.

## 1. Symptom → diagnosis (when to roll back)

| Symptom | Diagnosis step | Roll back? |
|---|---|---|
| Production alias serves a broken build (blank pages, error boundary) after a deploy | `GET https://payswap-web.vercel.app/api/health` — check `status`, `readiness` and `build.id` | Yes — Procedure A immediately |
| `/api/health` reports `unready` (a configured dependency failed) or the app misbehaves only under the NEW build id | compare `build.id` against the last release record (`spec/development-state/web-release-*.json`) | Yes — Procedure A, then B |
| Regression tracked to a specific commit already merged to main | confirm the commit is the release record's `release.commit` | Yes — Procedure B (revert), A only if user-facing pain is immediate |
| Platform-wide outage (Vercel incident) | Vercel status page | No — nothing to roll back to; wait |
| Bad ENV VAR value (e.g. wrong `NEXT_PUBLIC_PAYSWAP_API_URL`) | `/api/health` `readiness.checks[].state === "skipped"` on production | No rollback — fix the env var in the Vercel project and redeploy (rollbacks restore BUILDS, not env) |

## 2. Procedure A — Vercel rollback (instant mitigation, minutes)

1. **Identify the target** — the last known-good production deployment:
   - `cd packages/web && vercel ls --prod` (CLI), or
   - `node scripts/deployment/web-rollback.mjs` (prints the candidate list
     and the exact command; with `VERCEL_TOKEN` bound it executes).
   - Cross-check the target's `gitCommitSha` against the release records in
     `spec/development-state/` — the target must correspond to a recorded
     release (a release whose record exists is by definition a reviewed one).
2. **Roll back** (one command, from `packages/web` with the `payswap-web`
   project linked):
   ```bash
   vercel rollback <target-deployment-url> --yes --token "$VERCEL_TOKEN"
   # team scope if applicable: --scope <team>
   ```
   Zero-cost note: rollback repoints the production alias to an existing
   deployment — no build minutes, free-tier compatible.
3. **Verify (build-id re-verification)**:
   ```bash
   curl -s https://payswap-web.vercel.app/api/health
   ```
   - HTTP 200 with `liveness: "alive"`;
   - `readiness.ready` reflects the target release's dependency posture
     (`ok` when the API runtime was configured+healthy for that release);
   - `build.id` equals the `release.buildId` of the release record whose
     `release.commit` matches the target deployment's commit — this is the
     reproducibility chain: sources → build id → record → live probe.
4. **Record**: re-run the script with `--record` (writes
   `spec/development-state/web-rollback-record.json`) or file the facts by
   hand; the TL folds the event into the next release record.

## 3. Procedure B — git revert (source-of-truth repair)

A rollback only buys time: main still contains the bad commit. Repair it:

1. **Identify the bad commit** from the release record
   (`release.commit`) or the deployment meta (`gitCommitSha`).
2. **Revert on a branch** (never rewrite history — AGENTS.md rule 8):
   ```bash
   git checkout -b revert/web-<date>-<short-sha> main
   git revert <bad-commit-sha>
   ```
3. **Run the verification battery on the revert branch** (same law as any
   delivery): `node scripts/verify-repository.mjs`, `npm run typecheck`,
   `npm test`, `cd packages/web && npm run build`.
4. **Merge per governance** (TL review; the web surface is a consumer
   surface, but the same commit convention applies:
   `P3-W1-003: revert <short-sha> ...`).
5. **Redeploy through the review gate**: the TL re-runs
   `node scripts/deployment/web-release.mjs <date> [production-url] [preview-url]`
   (which re-verifies the build id against the sources) and deploys; the
   rollback alias then becomes the reverted-forward release.

## 4. Procedure C — both (the normal path for real regressions)

A now (stop user-facing pain) → B (repair main) → re-release. Never leave
main diverged from production longer than one release cycle.

## 5. Non-goals / boundaries

- **No data rollback**: the web app holds no financial state; the
  authoritative ledger lives behind the API runtime (project `payswap`) —
  out of scope here by law (no parallel financial truth in the web surface).
- **No env rollback**: env vars are project-level; fix and redeploy.
- **Never touch the `payswap` project**: an API-runtime rollback is a
  separate, protocol-governed procedure (production promotion/rollback
  orders live in @payswap/certification) — not this runbook.
- **Preview deployments**: broken previews are simply superseded; no
  rollback needed.

## 6. Rehearsal (honesty note)

The Vercel-API leg of this runbook is CREDENTIAL-GATED until the operator
vault is re-supplied (lost to the sandbox reset, 2026-10-02): the script's
live execution (list → rollback → probe → build-id match) has NOT been
executed against the real project. The dry-run plan, the API shapes and the
verification chain are repository artifacts; the first live rehearsal must
be recorded in `spec/development-state/web-rollback-record.json` before
this runbook is certified as "rehearsed" (topology section 6 rollback gate).

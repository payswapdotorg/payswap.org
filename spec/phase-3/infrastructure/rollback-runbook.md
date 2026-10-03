# Web Rollback Runbook (P3-W1-003)

Status: Active — 2026-10-02
Applies to: the `payswap-web` Vercel project (the public web surface,
`@payswap/web`, root directory `packages/web`).

Security law: **env var NAMES only.** No tokens, no URLs-with-credentials.
Every command below assumes the TL's integration station holds the Vercel CLI
login for the `payswaporg` account (operator vault) and any needed values.

## The law of a web rollback

1. A rollback of the web surface is an **alias re-point, never a rebuild**:
   `vercel rollback` promotes a PREVIOUS immutable deployment back under the
   production alias. No new build id is produced; the target deployment's
   build id + commit are whatever they already were.
2. **The API-runtime project (`payswap`) is never touched** by a web
   rollback — the web surface is a consumer; the authority stays exactly as
   deployed. If the root cause is in the API runtime, that is an API-runtime
   incident with its own procedure (see the production deployment record's
   rollback gate), not this runbook.
3. The rollback is **recorded reproducibly**: the record is assembled by the
   same driver as release records (`scripts/deployment/web-release.mjs`,
   rollback mode) — deterministic, digest-carried, byte-identical for the
   same inputs.

## When to roll back (trigger conditions)

- A defect shipped in a `payswap-web` production deployment that degrades a
  public journey (broken page, broken honest-state rendering) and cannot wait
  for a forward fix.
- The health endpoint reports **degraded** because of a web-side regression
  (note: degraded caused by the API runtime is NOT a web rollback trigger).
- An operator/TL decision to revert content or behavior quickly.

Never roll back to fix anything owned by `packages/api`, the protocol, or any
financial code — those follow the frozen-architecture governance path.

## Procedure (exact commands — env var names only)

Prerequisites at the integration station:

- `vercel` CLI logged in to the `payswaporg` account.
- The `payswap-web` project linked: run from `packages/web` (a `.vercel`
  directory linked to the project) — the CLI commands below are all executed
  from `packages/web`.

### 1. Identify the current and target deployments

```sh
cd packages/web
vercel ls payswap-web            # list deployments; production alias target is marked
vercel inspect <current-production-deployment-url>
vercel inspect <candidate-target-deployment-url>
```

Notes:

- Deployment URLs are public (no credentials in them) — safe to paste in
  records and reports.
- Pick the target as the **last known-good production deployment** — normally
  the one recorded in the previous release record
  (`spec/development-state/web-release-<previous-date>.json`,
  `vercelProject.deploymentUrls.production`).
- If unsure which deployment is good: check `/api/health` on the candidate's
  deployment URL (below) and the release record's build id it should report.

### 2. Verify the target deployment before promoting it

```sh
curl -fsS "<candidate-target-deployment-url>/api/health"
```

Expect:

- HTTP 200;
- `build.id` = the build id recorded in the target's release record;
- `readiness.state` = `ready` or `unknown` (unconfigured is honest, NOT
  failure);
- if `readiness.state` = `degraded`, stop: the target is not good either —
  escalate instead of rolling back.

### 3. Execute the rollback (alias re-point — no rebuild)

```sh
vercel rollback <candidate-target-deployment-url> --yes
```

(Without `--yes` the CLI asks for confirmation; interactive confirmation is
fine at the station.)

### 4. Verify production after the rollback

```sh
curl -fsS "https://payswap-web.vercel.app/api/health"
```

Expect — the exact points that prove the rollback took effect:

- HTTP 200;
- `build.id` = the TARGET deployment's build id (it must equal the value from
  step 2 — the alias now serves the old artifact);
- `build.commit` = the target deployment's commit;
- `readiness.state` = `ready` or `unknown`, never `degraded` (unless the
  degradation is API-runtime-side, which is out of this runbook's scope);
- spot-check one public journey (`/`, `/capabilities`) renders.

If the production alias still reports the OLD (bad) build id, the rollback
did not take effect: re-run step 3 and check `vercel ls` — the alias target
must be the target deployment.

### 5. Record the rollback (reproducible, no rebuild)

From the repository root, with the values observed above:

```sh
node scripts/deployment/web-release.mjs rollback \
  <record-date YYYY-MM-DD> \
  <from-deployment-url> \
  <to-deployment-url> \
  "<verbatim reason>" \
  <to-build-id> \
  <to-commit>
```

The driver (rollback mode) runs NO build: it assembles the deterministic
record — including the `to` deployment's build id + commit, the reason, the
no-rebuild method and the API-runtime separation law — computes its fnv1a64
digest, and writes `spec/development-state/web-rollback-<record-date>.json`.
When the to-build-id is provided, the driver cross-checks it against the
existing release records and prints the pairing (informational, honest: a
miss is possible for deployments that predate release records).

The `<to-build-id>` and `<to-commit>` values are the ones the release record
of the target deployment carries (or the ones `/api/health` reported in
step 4 — they must agree).

### 6. Commit the record

```sh
git add spec/development-state/web-rollback-<record-date>.json
git commit -m "P3-W1-003: record web rollback <record-date> (<reason>)"
```

### 7. Forward fix (after the incident)

A rollback is a stabilization, not a fix: file the forward-fix work under the
normal work-order flow. When the fix ships, a NEW release record supersedes
the rollback state as the current production record.

## Rollback drill (rehearsal without touching production)

Vercel's rollback cannot be rehearsed on the production alias safely, so the
drill is performed on a PREVIEW deployment instead (the same mechanic, zero
production impact):

1. Deploy two previews: `vercel` (preview deployment A), change one visible
   byte, `vercel` again (preview deployment B).
2. `vercel rollback <preview-A-url> --yes` — re-points the preview alias.
3. `curl -fsS <preview-A-url>/api/health` — confirm the build id changed back
   to A's.
4. Record the drill result in the live-verification notes (a drill record is
   NOT written to spec/development-state — only real rollbacks are recorded).

The TL live-verification runbook
(`spec/phase-3/infrastructure/tl-live-verification.md`) includes this drill
as its Vercel production-readiness step.

## What a rollback does NOT change

- The `payswap` API-runtime project, its env vars, its deployments.
- Neon branches, Upstash namespaces, R2 buckets — none are web-surface
  resources.
- Environment variables of `payswap-web` (rollback re-points an alias; the
  target deployment already carries its own baked `NEXT_PUBLIC_*` values).
- The repository's release records already written (records are append-only
  evidence; the rollback record is a NEW file).

# TL Live-Verification Runbook — P3-W1-003 (Integration Station)

Status: Active — 2026-10-02.
Executor: the Tech Lead, **with credentials**, at the integration station.

> **NOT-EXECUTABLE-IN-SANDBOX** — Worker 1 holds no credentials by law; this
> runbook is the deliverable. Every value below is an environment variable
> NAME resolved at the station from the operator vault
> (`/home/z/.secrets/env.sh`, mode 0600) — no values, tokens or connection
> strings are recorded anywhere in this repository. Verification outputs are
> recorded in the TL's live-verification notes (observed VALUES of usage
> metrics are fine to record; secrets are never).

Verification target: the acceptance items of Work Order P3-W1-003 —
Neon production/preview separation, Upstash budget conformance, R2 posture,
Vercel production-readiness of `payswap-web` (health/readiness/observability/
rollback), Resend/Apify absence, no unexpected paid dependency.

Honesty law for this runbook: a check that cannot run is recorded as
**UNKNOWN — not "ok"**. A reading over threshold is recorded verbatim and
follows the breach procedure in
`spec/phase-3/infrastructure/free-tier-budgets.md` §8.

## 0. Preconditions (ordered)

```sh
# At the station, in the payswap repository checkout at the release commit:
git rev-parse HEAD                                   # record the SHA you verify
npm install                                          # workspace install (npm, never ci after dep changes)
npm run test --workspace @payswap/web                # dependency audit + health + repro suites green
# Source the vault (env var NAMES land in your shell; do not echo them):
source /home/z/.secrets/env.sh
```

Expected env var NAMES (all resolved from the vault — do not print values):

| Purpose | Env var name |
| --- | --- |
| Neon production branch connection | `PAYSWAP_DATABASE_URL_PROD` |
| Neon preview branch connection | `PAYSWAP_DATABASE_URL_PREVIEW` |
| Upstash Redis REST endpoint (prod binding) | `PAYSWAP_REDIS_REST_URL_PROD` |
| Upstash Redis REST token | `PAYSWAP_REDIS_REST_TOKEN_PROD` |
| R2 S3 endpoint | `R2_S3_ENDPOINT` |
| R2 access key id | `R2_ACCESS_KEY_ID` |
| R2 secret access key | `R2_SECRET_ACCESS_KEY` |
| Vercel API token | `VERCEL_TOKEN` |
| Vercel team id | `PAYSWAP_VERCEL_TEAM` |
| Vercel project name (API runtime) | `PAYSWAP_VERCEL_PROJECT` |

## 1. Neon production/preview separation (in that order)

### 1.1 Host separation (the branches are different computes)

```sh
node -e 'const u=new URL(process.env.PAYSWAP_DATABASE_URL_PROD);console.log("prod host:",u.hostname)'
node -e 'const u=new URL(process.env.PAYSWAP_DATABASE_URL_PREVIEW);console.log("preview host:",u.hostname)'
```

Expected: **two different hostnames** (`ep-…-main…` / `ep-…-preview…`-style —
record both hostnames in the notes). Same hostname = STOP: separation is not
real; escalate before any other step.

### 1.2 Live connectivity to both branches

```sh
psql "$PAYSWAP_DATABASE_URL_PROD" -tAc "select current_database(), current_user;"
psql "$PAYSWAP_DATABASE_URL_PREVIEW" -tAc "select current_database(), current_user;"
```

Expected: both answer (record database/user only — they are in the
deployment record already).

### 1.3 Write isolation (the strongest separation proof)

```sh
# 1. Write a probe table on PREVIEW only:
psql "$PAYSWAP_DATABASE_URL_PREVIEW" -c "create table if not exists _tl_separation_probe (id int primary key, note text); insert into _tl_separation_probe values (1,'preview-only');"
# 2. The same table MUST NOT EXIST on production (expect an ERROR — that error is the PASS):
psql "$PAYSWAP_DATABASE_URL_PROD" -tAc "select count(*) from _tl_separation_probe;"
# 3. Clean up the preview probe:
psql "$PAYSWAP_DATABASE_URL_PREVIEW" -c "drop table if exists _tl_separation_probe;"
```

Expected: step 2 fails with `relation "_tl_separation_probe" does not exist`.
Record the verbatim error. A successful select would mean preview writes are
visible on production — STOP and escalate.

### 1.4 Budget posture (manual-check hooks per the budget contract §2)

- Neon console → project `payswap` → usage: record storage (expect ≤ 300 MB,
  alert 50 % of the free limit) and compute hours this month (expect ≤ 100,
  alert at 60 % of allowance).
- Neon console → branches: confirm exactly two long-lived branches
  (`main`, `preview`); autosuspend (suspend timeout) on BOTH = 5 minutes —
  this is the free-tier compute lever; a third long-lived branch = breach of
  the branch policy.

## 2. Upstash budget conformance

All commands go through the REST binding (the account's single free-tier
database; namespace law `payswap:*`). The REST API answers JSON
(`{"result": …}`).

### 2.1 Database facts and command counters

```sh
curl -fsS "$PAYSWAP_REDIS_REST_URL_PROD/info" -H "Authorization: Bearer $PAYSWAP_REDIS_REST_TOKEN_PROD"
curl -fsS "$PAYSWAP_REDIS_REST_URL_PROD/dbsize" -H "Authorization: Bearer $PAYSWAP_REDIS_REST_TOKEN_PROD"
```

Record: `# Keyspace` keys count, memory `used_memory` (expect ≤ 100 MB),
`total_commands_processed` (cumulative since creation — snapshot it; the
MONTHLY command count comes from the Upstash console usage page: expect
≤ 250 000, alert at 50 % of the free 500 000).

### 2.2 Namespace discipline

```sh
curl -fsS "$PAYSWAP_REDIS_REST_URL_PROD/scan/0/match/payswap:*/count/100" -H "Authorization: Bearer $PAYSWAP_REDIS_REST_TOKEN_PROD"
curl -fsS "$PAYSWAP_REDIS_REST_URL_PROD/scan/0/match/*/count/100" -H "Authorization: Bearer $PAYSWAP_REDIS_REST_TOKEN_PROD"
```

Expected: every key starts with `payswap:` — any key outside the namespace
(`payswap:`-less) is a defect to record and remove. Iterate the SCAN cursor
until complete for the sampled audit.

### 2.3 Rate-limit/cache TTL law (unbounded keys are defects)

```sh
curl -fsS "$PAYSWAP_REDIS_REST_URL_PROD/scan/0/match/payswap:rl:*/count/100" -H "Authorization: Bearer $PAYSWAP_REDIS_REST_TOKEN_PROD"
# For each sampled rl/cache key (substitute <key>):
curl -fsS "$PAYSWAP_REDIS_REST_URL_PROD/ttl/<key>" -H "Authorization: Bearer $PAYSWAP_REDIS_REST_TOKEN_PROD"
```

Expected: every `payswap:rl:*` key TTL ≥ −1 but ≤ 60 (−1 = no expiry =
DEFECT); `payswap:cache:*` TTL ≤ 300. Record sampled values.

### 2.4 Observability namespace presence

```sh
curl -fsS "$PAYSWAP_REDIS_REST_URL_PROD/xlen/payswap:observability:production" -H "Authorization: Bearer $PAYSWAP_REDIS_REST_TOKEN_PROD"
```

Expected: a number > 0 (the live sink's stream, per the runtime activation
record). `0` or an error is recorded honestly as an UNKNOWN/finding, not a
silent pass.

## 3. Cloudflare R2 posture

The R2 binding is S3-API + SigV4. With the AWS CLI at the station (or any
SigV4-capable client):

```sh
export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION=auto

aws --endpoint-url "https://$R2_S3_ENDPOINT" s3api list-buckets

# Retention posture (the explicit per-bucket policy):
aws --endpoint-url "https://$R2_S3_ENDPOINT" s3api get-bucket-lifecycle-configuration --bucket payswap-evidence-prod
aws --endpoint-url "https://$R2_S3_ENDPOINT" s3api get-bucket-lifecycle-configuration --bucket payswap-evidence-preview

# Storage posture (record the two summary lines):
aws --endpoint-url "https://$R2_S3_ENDPOINT" s3 ls s3://payswap-evidence-prod --recursive --summarize | tail -n 2
aws --endpoint-url "https://$R2_S3_ENDPOINT" s3 ls s3://payswap-evidence-preview --recursive --summarize | tail -n 2
```

Expected (per the budget contract §4):

- `payswap-evidence-prod`: lifecycle has the 7-day incomplete-multipart
  abort and **NO expiry rule** (immutable evidence is retained indefinitely);
- `payswap-evidence-preview`: lifecycle has the **90-day expiry** rule plus
  the 7-day multipart abort;
- both buckets: total size within budget (prod+preview ≤ 5 GB);
- console → billing: R2 **egress line-item absent** (R2 egress is $0 by
  design — any non-zero egress charge is a finding);
- console → R2 metrics: Class A ops this month ≤ 50 000, Class B ≤ 500 000
  (alert at 10 % of the free limits — Class A ops are the surprise-bill
  risk).

Record the lifecycle JSON verbatim (it contains no secrets) in the notes.

## 4. Vercel production-readiness of `payswap-web`

### 4.1 Deployment state (CLI, from the repo's packages/web)

```sh
cd packages/web        # the payswap-web project must be linked here
vercel ls payswap-web
vercel inspect https://payswap-web.vercel.app
```

Expected: the production alias target is a deployment whose commit matches
the latest release record
(`spec/development-state/web-release-<latest>.json` → `release.commit`).

### 4.2 Environment completeness (names + environments only)

```sh
vercel env ls payswap-web
```

Expected: `NEXT_PUBLIC_PAYSWAP_API_URL` present for BOTH the Production and
Preview environments (production env value = the production API host; the
preview value = the preview API host — verify the NAMES and environments;
values are confirmed by behavior in 4.3, never recorded). Absent on purpose
is honest too — but then 4.3 must report readiness UNKNOWN (not ready).

### 4.3 Health/readiness verification (the hardened endpoint)

```sh
curl -fsS "https://payswap-web.vercel.app/api/health" | head -c 2000; echo
```

Expected JSON semantics:

- `liveness.state = "alive"`;
- `readiness.state = "ready"` (probe of `GET /v1/health` on the API runtime
  answered 2xx) **or** `"unknown"` when the env var is unconfigured —
  UNKNOWN is NOT failure; HTTP 200 either way;
- if `readiness.state = "degraded"` (HTTP 503): investigate the probe
  `outcome`/`message` — the web is up but cannot reach the API runtime
  (that is an API-runtime-side or env-wiring finding, not a web-surface
  bug);
- `build.id` + `build.commit` must match the release record — record them;
- also check the preview deployment URL the same way.

### 4.4 Rollback drill (on a PREVIEW deployment — never production)

Rehearse the exact mechanic from
`spec/phase-3/infrastructure/rollback-runbook.md` §"Rollback drill":

```sh
vercel                                   # deploy preview A
# (change one visible byte) …
vercel                                   # deploy preview B
vercel rollback <preview-A-url> --yes    # re-point the preview alias to A
curl -fsS "<preview-A-url>/api/health"   # build.id must be A's again
```

Record: the drill succeeded + the two build ids observed. (A drill is NOT
recorded into spec/development-state — only real rollbacks are.)

### 4.5 Release-record reproducibility (offline proof, at the station)

```sh
cd <repo root>
node -e 'import("./scripts/deployment/web-release.mjs").then(m=>{const r=m.assembleReleaseRecord({recordDate:"2026-10-02",commitSha:"c7a3856709d5fc5bdf98ebb70660aa2718e7c750",buildId:"dba11b45080e6786",buildIdVerifiedAgainstSources:true,productionUrl:"https://payswap-web.vercel.app",previewUrl:"https://payswap-6056skcol-ekonplacidegmailcoms-projects.vercel.app"});process.stdout.write(m.formatRecord(r));})' > /tmp/recomputed.json
diff /tmp/recomputed.json spec/development-state/web-release-2026-10-02.json && echo "REPRODUCIBLE: byte-identical"
```

Expected: `REPRODUCIBLE: byte-identical` (this is also CI-covered by
`packages/web/test/infra-release-repro.test.ts` — the station run proves it
against the same machine that holds the record).

### 4.6 Budget posture (manual check per the budget contract §1)

- Vercel dashboard → Usage: record Fast Data Transfer (expect ≤ 50 GB,
  alert 50 %) and function data transfer (≤ 20 GB);
- confirm hobby plan (no credit-card spend), 1 concurrent build.

## 5. Resend/Apify absence + no unexpected paid dependency (machine-checked)

Already proven by the repository test (section 0 ran it); at the station
confirm the gate is wired into the same battery:

```sh
npm run test --workspace @payswap/web -- dependency-audit
```

Expected: the dependency-audit suite passes — Resend/Apify absent from every
manifest AND the lockfile; the dependency surface equals the curated
allowlist exactly. Any drift fails with a diff (the escape hatch is
documented in `packages/web/test/dependency-audit-allowlist.json` and can
NEVER authorize Resend/Apify).

## 6. Sign-off checklist (record PASS / FAIL / UNKNOWN per line)

| # | Acceptance item | Where proven |
| --- | --- | --- |
| 1 | Vercel public web deployment is production-ready | §4.1–4.4 (state, env completeness, health, rollback drill) |
| 2 | Neon production/preview separation is verified | §1 (hosts differ + write isolation) |
| 3 | Upstash usage has explicit namespace/command/rate budgets | §2 + `free-tier-budgets.md` §3 |
| 4 | R2 storage/egress/retention posture is explicit | §3 + lifecycle JSON recorded |
| 5 | Resend/Apify are absent | §5 (machine-checked; no workflow justifies them today) |
| 6 | No unexpected paid dependency | §5 allowlist equality |
| 7 | Health/readiness, observability and rollback are verified | §4.3, §2.4, §4.4 |
| 8 | Production deployment record is reproducible | §4.5 byte-identical diff + CI repro test |

Any FAIL or UNKNOWN line blocks the P3-W1-003 acceptance sign-off until
resolved or explicitly accepted by the operator — never silently.

# Free/Low-Cost Infrastructure Budget Contract (P3-W1-003)

Status: Active contract — 2026-10-02
Owner: Worker 1 (P3-W1-003); enforced by `packages/web/test/dependency-audit.test.ts` (dependency surface) and verified live by the TL per `spec/phase-3/infrastructure/tl-live-verification.md`.

Purpose: keep the initial PaySwap stack (Vercel + Neon + Upstash + Cloudflare R2,
as bound in `spec/development-state/runtime-activation.json`) inside measured
free/low-cost bounds, with an explicit limit, an enforcement/observability hook
and an alert threshold for every budgeted resource. This is a **cost-governance
contract**, not a capacity plan: the honest posture is that limits are checked,
not assumed.

Laws inherited from the repo:

- Security law: this file names environment variables **by name only** — no
  values, tokens or URLs-with-credentials ever appear here. Live checks are
  performed by the TL at the integration station (see the TL live-verification
  runbook).
- The web surface (`payswap-web`) is a consumer; the authoritative API runtime
  (Vercel project `payswap`) owns all financial truth. A web release/rollback
  never touches the API project.
- UNKNOWN is not FAILED: a check that cannot run reports UNKNOWN, never "ok".

## How to read the budget tables

Each row states:

- **Limit** — the free-tier ceiling we budget against. Values are the
  provider-documented free-tier figures as known at contract time; providers
  revise them. Rows marked *(verify)* must be re-confirmed against the live
  account dashboard at the TL gate before the number is trusted as a gate.
- **Our budget** — the PaySwap self-imposed cap, at or below the limit, chosen
  so that normal operation never rides the ceiling.
- **Hook** — how the budget is enforced or observed. `MANUAL CHECK` marks an
  honestly manual, dashboard-based check (no automated alert exists at free
  tier); `TEST` marks a repository test that fails the build; `RUNBOOK` marks a
  TL-executed procedure.
- **Alert threshold** — the usage fraction at which the TL/operator acts
  (investigate, throttle, or upgrade deliberately). Free tiers rarely offer
  programmatic alerts, so thresholds are review triggers, not pager rules.

## 1. Vercel (hobby tier — projects `payswap-web` and `payswap`)

| Resource | Limit *(verify at TL gate)* | Our budget | Hook | Alert threshold |
| --- | --- | --- | --- | --- |
| Fast data transfer (bandwidth) | 100 GB / month / account | ≤ 50 GB / month | MANUAL CHECK — Vercel dashboard → Usage; monthly TL review | 50 % of limit (50 GB) investigate; 80 % (80 GB) act |
| Serverless function data transfer | 100 GB / month / account | ≤ 20 GB / month | MANUAL CHECK — dashboard Usage | 50 % investigate; 80 % act |
| Serverless function max duration (hobby default) | 10 s per invocation | web routes stay < 10 s; `/api/health` readiness probe is bounded at 5 s (see §health below) | TEST — `packages/web/test/infra-health.test.ts` bounds the probe timeout | n/a (correctness budget) |
| Build minutes / concurrency | 1 concurrent build; hobby build allowance | one release build at a time (release driver runs a single build) | RUNBOOK — release driver `scripts/deployment/web-release.mjs` runs exactly one build per record | 2 queued builds = investigate |
| Deployments/day | hobby daily deployment cap *(verify)* | ≤ 10 / day normal cadence; ≥ 1 rollback does not create a new deployment (alias re-point, no rebuild) | MANUAL CHECK — `vercel ls` at TL gate | any day > 10 |
| Team size | hobby = 1 personal account, non-commercial | single operator account (already the case) | MANUAL CHECK | any change requires plan review |
| Notifications/emails via Vercel | none assumed | Resend/Apify are ABSENT — see §5 | TEST — dependency audit | any appearance = build failure |

Notes:

- Function invocations are effectively unmetered on the hobby allowance; the
  metered risks are bandwidth and function data transfer, hence the 50 %/80 %
  thresholds above.
- The health endpoint performs one bounded upstream probe per request
  (readiness). Monitoring systems must poll at ≤ 1 req/min per surface to keep
  probe traffic immaterial (both for budget and for API-runtime noise).

## 2. Neon PostgreSQL (free plan — project `payswap`, aws-us-east-1, pg 17)

| Resource | Limit *(verify at TL gate)* | Our budget | Hook | Alert threshold |
| --- | --- | --- | --- | --- |
| Storage | 0.5 GB total *(verify)* | ≤ 300 MB | MANUAL CHECK — Neon console usage; `pg_database_size` at TL gate | 50 % (250 MB) investigate; 80 % (400 MB) act |
| Compute hours | ~190 compute-hours / month *(verify)* | ≤ 100 / month; autosuspend stays ON (5 min idle → suspend) — the single biggest free-tier lever | MANUAL CHECK — Neon console usage; TL gate re-checks autosuspend config | 60 % of monthly allowance |
| Branches | free-plan branch count cap *(verify)* | exactly 2 long-lived: `main` (production) + `preview` (preview); ephemeral branches are created and deleted inside a work session, never left overnight | RUNBOOK — Neon branch policy below + TL live verification | any third long-lived branch |
| Projects | free-plan project cap | 1 (`payswap`) | MANUAL CHECK | any second project |

### Branch separation policy (production vs preview — verified, not assumed)

- **`main` = PRODUCTION.** Wired only to the production API-runtime binding;
  its connection string is vault-resolved (env var name `DATABASE_URL`; the
  TL gate resolves prod/preview via `PAYSWAP_DATABASE_URL_PROD` /
  `PAYSWAP_DATABASE_URL_PREVIEW` vault references).
- **`preview` = PREVIEW.** Wired to preview deployments of the API runtime.
- **Law:** a preview environment must never resolve a production connection
  string, and vice versa. Verification is *separation by hostname*: Neon
  connection strings embed the branch in the host; the TL gate asserts
  prod-host ≠ preview-host and that a write on preview is not visible on prod
  (commands in the TL live-verification runbook).
- Preview data is disposable: it may be reset at any time; production data may
  never be reset outside a governed restore/replay (INV-O04).

## 3. Upstash Redis (free tier — account single database, REST binding)

| Resource | Limit *(verify at TL gate)* | Our budget | Hook | Alert threshold |
| --- | --- | --- | --- | --- |
| Commands / month | 500 000 *(verify)* | ≤ 250 000 / month | MANUAL CHECK — Upstash console metrics; `INFO` counters at TL gate | 50 % investigate; 80 % act |
| Commands / second (sustained) | provider soft limit (~1 000/s on free) | ≤ 100/s sustained application traffic; bursts ≤ 500/s | RUNBOOK — rate-limit policy below | sustained > 100/s |
| Databases | 1 (account free tier — already bound) | 1 | MANUAL CHECK | a second database = upgrade decision, never silent |
| Storage | 256 MB max data size *(verify)* | ≤ 100 MB | MANUAL CHECK — console metrics; `INFO` memory at TL gate | 50 % of cap |
| Rate-limit keys | none (our own policy) | TTL-capped, see policy | RUNBOOK | RL keys without TTL = defect |

### Namespace convention (single free-tier database, `payswap:*`)

All keys live in the one bound free-tier database and MUST carry the
`payswap:` root namespace plus a plane/environment segment:

| Namespace pattern | Owner plane | Lifetime | Example keys |
| --- | --- | --- | --- |
| `payswap:observability:production` | observability stream (already bound) | append-only stream, retention per §observability budget below | stream entries |
| `payswap:observability:preview` | preview observability | same, disposable | stream entries |
| `payswap:queue:*` | protocol/reconciliation/notification queues | consumed + XACKed | per-role consumer groups |
| `payswap:rl:<surface>:<scope>` | rate limiting | TTL ≤ 60 s (hard cap) | `payswap:rl:api:ip:*` |
| `payswap:cache:<surface>:*` | ephemeral cache (never financial truth) | TTL ≤ 300 s | projection caches |

Laws:

- **No financial truth ever lives in Redis.** Queues/streams/cache only; the
  PostgreSQL system of record owns all financial state (topology §4).
- **Every `payswap:rl:*` and `payswap:cache:*` key must have a TTL** —
  unbounded keys are a storage-budget leak and a defect (checked at the TL
  gate; the check is a `SCAN` + `TTL` sampling pass).
- Environment separation inside the single database is by namespace segment
  (`:production:` / `:preview:`), because the account has exactly one
  free-tier database. If prod/preview isolation ever needs to be stronger than
  a namespace, the recorded upgrade path is a second database — an explicit
  cost decision, never silent (runtime-activation record already notes this).

### Rate-limit policy (the commands budget's main consumer)

- Public web surface (`payswap-web`): no Upstash usage at all in this phase —
  the web surface is static-by-default; its only dynamic route is
  `/api/health` (bounded probe). Budget contribution: **0 commands**.
- API runtime (`payswap` project): rate limiting is applied at the API
  boundary per-scope with fixed windows stored under `payswap:rl:api:*`,
  TTL-capped at 60 s. Budget: ≤ 2 Redis commands per API request (INCR + EXPIRE
  or the equivalent), i.e. at ≤ 100 req/s sustained this stays ≤ ~200
  commands/s — inside the burst budget, and ≤ 250 k/month at average ≤ 100
  req/min.
- Observability stream appends are batched by the sink, not per-event writes
  from hot paths.

## 4. Cloudflare R2 (free tier — buckets `payswap-evidence-prod`, `payswap-evidence-preview`)

| Resource | Limit *(verify at TL gate)* | Our budget | Hook | Alert threshold |
| --- | --- | --- | --- | --- |
| Storage | 10 GB-month total *(verify)* | ≤ 5 GB-month across both buckets | MANUAL CHECK — console / `ListObjectsV2`+head at TL gate | 50 % (5 GB) investigate; 80 % (8 GB) act |
| Class A operations (writes/lists) | 1 000 000 / month | ≤ 50 000 / month | MANUAL CHECK — console metrics | 10 % (100 k) — Class A ops are the R2 surprise bill risk |
| Class B operations (reads/heads) | 10 000 000 / month | ≤ 500 000 / month | MANUAL CHECK — console metrics | 10 % (1 M) |
| Egress | **$0 — R2 has zero egress fees** (the reason R2 is chosen) | unmetered by policy; still verified at TL gate that no egress line-item exists | MANUAL CHECK — billing dashboard | any non-zero egress charge = investigate |
| Retention / lifecycle | lifecycle rules are free to configure | per-bucket policy below | RUNBOOK — `get-bucket-lifecycle-configuration` at TL gate | drift from policy |

### Retention policy per bucket (explicit)

- **`payswap-evidence-prod`** (production evidence artifacts — immutable,
  content-addressed): **no expiry** (retention: indefinite). Immutable
  evidence lineage is a financial-architecture requirement (authorization +
  evidence lineage, AGENTS.md rule 2); cost control comes from write
  discipline: evidence is written once, content-addressed, never re-uploaded.
  Lifecycle: abort-incomplete-multipart-uploads after 7 days (housekeeping,
  not data deletion).
- **`payswap-evidence-preview`** (preview evidence): **expiry 90 days**
  (lifecycle rule: delete objects 90 days after creation). Preview evidence is
  disposable; this rule is the explicit storage-budget control for the
  non-production bucket. Lifecycle: same 7-day multipart abort.
- Object versioning: OFF on both (evidence is content-addressed and immutable
  by construction; versioning would double storage silently).

Env var names (vault-resolved, never in git): `OBJECT_STORAGE_ENDPOINT`,
`OBJECT_STORAGE_BUCKET`, `OBJECT_STORAGE_REGION`,
`OBJECT_STORAGE_ACCESS_KEY_ID`, `OBJECT_STORAGE_SECRET_ACCESS_KEY` (topology
§3.1).

## 5. Resend and Apify — absent by default, justification-gated

The repo-wide law (Phase 3 TL handoff): Resend/Apify are added **only** when an
actual workflow justifies them. As of this contract:

- **Resend (transactional email): ABSENT.** No package.json in the repository
  declares the Resend SDK in any dependency section, and the lockfile contains
  no Resend package. The notification-worker plane signs webhooks itself
  (topology §5); email transport is not a current workflow requirement.
- **Apify (research/web extraction): ABSENT.** No package.json declares the
  Apify SDK; the lockfile contains no Apify package. All current provider
  evidence was gathered with direct probes (provider-probes record).
- **Enforcement: machine-checked.** `packages/web/test/dependency-audit.test.ts`
  fails the build if any `package.json` in the repository (or the root lockfile)
  gains a Resend/Apify package. The escape hatch for *other* new dependencies
  (documented in the audit test) does **not** apply here: re-introducing
  Resend/Apify requires an explicit work-order amendment, not an allowlist edit.

## 6. The "no unexpected paid dependency" budget (repo-wide)

- The full direct-dependency surface of every workspace is frozen by the
  curated allowlist `packages/web/test/dependency-audit-allowlist.json` and
  enforced by `packages/web/test/dependency-audit.test.ts`: any addition or
  removal fails the build with a diff. Justified additions are recorded in the
  allowlist's `justifications` map **in the same commit** that introduces the
  dependency (escape hatch, documented in the test).
- Zero new dependencies were added by P3-W1-003 itself (the work order's
  preference — and the audit test proves it mechanically for future commits).

## 7. Observability posture for the budgets themselves

- Free-tier limits are mostly verified by **manual dashboard checks** (honest
  marker: `MANUAL CHECK`) at the TL gate, on the cadence: **monthly review**
  (first TL session of each month) plus **at every production release** (the
  release record's runbook step).
- Automated coverage today: the dependency-audit test (dependency surface) and
  the health/readiness tests (function-duration discipline). These are
  repository tests — they run in CI on every commit at zero cost.
- Upstash usage counters and R2/N/Vercel/Neon dashboards are READ-ONLY checks;
  the TL records observed values in the live-verification notes. A reading of
  UNKNOWN (dashboard unreachable, metric not exposed) is recorded as UNKNOWN —
  never as "within budget".

## 8. Breach procedure

1. Any budget crossing an alert threshold: the TL records the observed value,
   the suspected consumer, and the projection to the limit in the
   live-verification notes (no silent consumption).
2. Containment levers, in preference order: reduce polling/cadence (health
   probes, monitors), shorten Redis TTLs / drop cache namespaces, tighten R2
   lifecycle, delete ephemeral Neon branches. All are config/policy changes,
   no code law violations.
3. A deliberate plan upgrade is an operator decision recorded in the
   development state — never a silent credit-card event (the accounts are the
   operator's; no worker ever holds billing credentials).

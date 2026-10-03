# @payswap/web — the public product surface

The public website of PaySwap (Work Order **P3-W1-001**): the product
homepage, the honest capabilities/coverage explorer over the recorded
provider-probe evidence, the security & non-custody page, the developer
entry point, and the authenticated entry boundary (`/app`) with its honest
gate.

**This package is a consumer, never an authority.** The authoritative
PaySwap API owns all financial truth; this surface holds no balances, no
ledger and no provider state of its own. Everything financial it can ever
show is a projection of the API for authenticated sessions — and the
`/app` boundary honestly renders "authentication required / not yet
available in this deployment phase" until those ship.

## Routes

| Route | What it is |
| --- | --- |
| `/` | Product homepage — true claims, primary journeys, derived coverage summary |
| `/capabilities` | The honest coverage explorer (recorded probe/rollout evidence, dates visible) |
| `/security` | Non-custody + session-isolation explanation |
| `/developers` | API-authority entry point (honest unconfigured state when the env var is absent) |
| `/app` (`/app/*`) | Authenticated entry boundary — honest gate, deep links resolve, hard-refresh safe |
| `/api/health` | Health/readiness (status + build id + commit) |

## Development

From the repository root (npm workspace):

```sh
npm run dev --workspace @payswap/web        # local dev server
npm run build --workspace @payswap/web      # production build
npm run typecheck --workspace @payswap/web  # tsc --noEmit (strict)
npm run test --workspace @payswap/web       # vitest
npm run lint --workspace @payswap/web       # eslint
```

The coverage pages import the evidence records
(`spec/development-state/provider-probes-20261002.json` and
`provider-rollout-20261002.json`) **at build time** — they are required
build inputs, and the pages fail loudly if those records drift out of the
expected shape.

## Build identity (reproducibility)

`next.config.ts` derives `BUILD_ID` as a sha256 content digest of this
package's build inputs (`src/`, `public/`, `package.json`,
`postcss.config.mjs`, `next.config.ts` — sorted, 16-hex). The same
committed sources always produce the same build id, and the build bakes
the id + commit into the runtime so `/api/health` reports them honestly.

## Deployment separation (the law)

- **This web surface deploys as its own Vercel project: `payswap-web`.**
- **Vercel project settings:** Root Directory `packages/web`, framework
  Next.js (explicit in `vercel.json`). Vercel's monorepo support installs the
  workspace dependencies at the repository root; the build runs in the root
  directory (`next build --webpack`, the project's build command).
- **The API/runtime host is a different, existing Vercel project —
  `payswap`** — and a web deployment never touches it. One authority,
  many clients: this surface reaches the API exclusively through the thin
  client (`src/lib/api.ts`).

### Environments (explicit)

| Environment | `NEXT_PUBLIC_PAYSWAP_API_URL` | Notes |
| --- | --- | --- |
| production | the **production** API host URL | set in the `payswap-web` project's production environment |
| preview | the **preview** API host URL | set in the `payswap-web` project's preview environment |
| absent | — | every page renders the **honest unconfigured state** (by design — no guessed URLs, no fake data) |

Environment variables are referenced **by name only** — no values, tokens
or `.env` files live in this repository. When set, the value is baked at
build time (Next.js `NEXT_PUBLIC_*` semantics).

### Health: liveness vs readiness (hardened in P3-W1-003)

`/api/health` reports two distinct signals, never conflated:

- **liveness** — the route answering is itself the proof the surface is
  alive (serverless: there is no deeper process to restart);
- **readiness** — can this deployment actually reach the authoritative API
  runtime? When the base URL is configured, each health request performs
  ONE bounded probe (GET `/v1/health` on the API runtime, through the thin
  transport, timeout default 5000 ms, env var name
  `PAYSWAP_WEB_HEALTH_PROBE_TIMEOUT_MS`). Unconfigured ⇒ readiness
  `unknown` — UNKNOWN is not failure. Probe failure ⇒ honest `degraded`
  (HTTP 503) with the verbatim reason — never faked success.

Monitoring note: poll at most once per minute (budget posture — see the
free-tier budget contract).

### Cost posture and infrastructure contracts (P3-W1-003)

The deployment's free/low-cost posture is an explicit contract:

- `spec/phase-3/infrastructure/free-tier-budgets.md` — per-service budgets
  (Vercel, Neon, Upstash, R2) with limits, hooks and alert thresholds;
- `spec/phase-3/infrastructure/tl-live-verification.md` — the TL's ordered
  live verification with credentials (env var names only);
- `packages/web/test/dependency-audit.test.ts` — machine-checked: no
  Resend/Apify, and the dependency surface of every workspace equals the
  curated allowlist (`packages/web/test/dependency-audit-allowlist.json`).

### Deploying (one command, performed at the TL review gate)

With the `payswap-web` project linked and the environment variables set
per the table above, from this directory:

```sh
vercel --prod
```

### Rolling back

Follow `spec/phase-3/infrastructure/rollback-runbook.md`: a web rollback
is an **alias re-point to a previous immutable deployment — never a
rebuild** — and it never touches the `payswap` API-runtime project. After
rolling back, record it reproducibly from the repository root:

```sh
node scripts/deployment/web-release.mjs rollback <record-date> <from-deployment> <to-deployment> "<reason>" [<to-build-id>] [<to-commit>]
```

### Release records

After (or before) deploying, from the repository root:

```sh
node scripts/deployment/web-release.mjs [record-date] [production-url] [preview-url]
```

The driver runs the build, verifies the built `BUILD_ID` against an
independent recomputation of the source digest, and writes the
deterministic release record to
`spec/development-state/web-release-<date>.json` (commit SHA, build hash,
vercel project, deployment URL placeholders, the API-runtime project
separation). Two runs with the same inputs produce byte-identical output —
proven by the fixture-based reproducibility test
(`packages/web/test/infra-release-repro.test.ts`, no network), which also
regresses the driver byte-for-byte against the record P3-W1-001 shipped.

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
  Next.js (detected). Vercel's monorepo support installs the workspace
  dependencies at the repository root; the build runs in the root
  directory (`next build`, the default).
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

### Deploying (one command, performed at the TL review gate)

With the `payswap-web` project linked and the environment variables set
per the table above, from this directory:

```sh
vercel --prod
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
separation). Two runs with the same inputs produce byte-identical output.

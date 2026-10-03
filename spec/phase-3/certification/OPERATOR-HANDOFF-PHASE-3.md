# PaySwap Phase 3 — Final Operator Handoff (P3-W3-003)

Status: CERTIFIED 2026-10-03. This document closes Phase 3 (the public
product surface). Executor of record: the TL at the integration station —
the dispatched worker session could not sustain execution through the
platform's degraded window (every turn died in the thinking phase; fresh
sessions never spawned; documented in the TL worklog 2026-10-03). Per the
Wave 1-2 precedent the TL completed the work order directly; every gate
below was executed and re-verified at the station — no agent report is
evidence.

## Exact versions

| Component | Value |
| --- | --- |
| Public web (production) | https://payswap-web.vercel.app |
| UI source commit | 165c98c (certification evidence) / 409d920 (deployed build at certification time) |
| Web package | @payswap/web 0.1.0 (Next.js 16.3.8, React 19.3.0) |
| API runtime | https://payswap-mu.vercel.app (schemaVersion 2026-09-30, contract version per X-PaySwap-API-Version) |
| Protocol | 1.5-frozen-2026-09-30 |
| Hardened health endpoint | liveness alive; readiness DEGRADED (honest) — see limitations |
| Vercel team/project | ekonplacidegmailcoms-projects / payswap-web (hobby plan) |

## The gate table (all re-executed at the station)

| # | Acceptance item | Result | Evidence |
| --- | --- | --- | --- |
| 1 | fresh install/build passes | PASS | npm install rc=0; `next build --webpack` rc=0, 35 routes, zero warnings |
| 2 | root typecheck passes | PASS | `npm run typecheck --workspaces` rc=0 |
| 3 | repository verification passes | PASS | `verify:repo` green |
| 4 | real deployment is reachable | PASS | https://payswap-web.vercel.app 200; /api/health honest envelope |
| 5 | browser suite covers public + authenticated journeys | PASS | verify-visual.mjs 56/56 cells PASS against the DEPLOYMENT and 56/56 against the LOCAL production build (zero console errors, zero overflow at 1440x900 and 390x844, 17/17 deep links resolve, honest markers verified per route incl. MTN MoMo BLOCKED and the auth gates) |
| 6 | provider/local-rail/authentication security boundaries verified | PASS | certification-boundaries.test.ts 9/9 (B1-B5) + the deep suites (cc-journey-continuity 27, honest-states 20, security 7, auth-connect 68, a11y 109) |
| 7 | deployment/release record is reproducible | PASS | infra-release-repro.test.ts 17/17 (byte-identical recomputation); the Wave 3 release record written by the driver at close |
| 8 | rollback is tested | PASS | full production cycle: `vercel rollback` to the Wave 2 build (verified via public /api/health: commit 239c4a2 + old shape) then fresh deploy + `vercel promote` (the promote-after-rollback law) — production serves the current build again |
| 9 | final operator handoff (this document) | PASS | exact versions + honest limitations below |

Full battery at certification: **3188/3188 tests** (workspaces), plus the
9 certification-boundaries tests on this branch (3197 total).

## Certification evidence

- `spec/phase-3/certification/evidence/deployed/` — manifest.json (56 cells,
  all PASS) + 8 representative PNGs + PNG-SHA256SUMS.txt (all 56 hashes; the
  full screenshot set is a station artifact — the sums make any future
  regeneration verifiable).
- `spec/phase-3/certification/evidence/local/` — the same shape for the
  local production build.
- `spec/phase-3/certification/tl-live-verification-2026-10-03.md` — the
  live infrastructure verification (Neon write-isolation PASS, R2 posture
  PASS with the preview-expiry gap fixed live, Upstash UNKNOWN — deleted
  endpoint, no Redis in the deployment; the Vercel rollback cycle).

## Known limitations (honest, complete)

1. **The API runtime answers HTTP 400 on unauthenticated `GET /v1/health`**
   — it requires session auth on EVERY route (fail-closed by W3-002
   design). The web health endpoint therefore reports readiness DEGRADED
   with that verbatim reason. This is recorded behavior, not an outage;
   readiness turns ready only when the API gains a public health path or
   the web surface holds a valid session.
2. **No public session issuance on the API** — every authenticated surface
   fails closed with verbatim reasons (the session plane is real
   server-side; the API's own session tokens are not publicly issued).
3. **The connection journey store is in-memory/process-local** (documented
   W3-002 limitation; persistence is a Phase 4+ concern).
4. **Authority-activation records are fold points** exercised with
   obviously-fake fixtures in tests — never minted by the app.
5. **Upstash**: the operator-provided Redis endpoint is deleted; the
   deployment uses no Redis (zero impact). Provide a live endpoint when a
   Redis binding is actually needed.
6. **Neon autosuspend** could not be confirmed through the API view
   (reports 0s); confirm the 5-minute console setting at leisure.
7. **Evidence lineage**: `spec/phase-3/verification/evidence/` (W2-003)
   screenshots record the PRE-fix deployed state; `evidence-local/` records
   the fixed local build; the CURRENT deployment carries the fixes
   (TL-verified live) and this certification's own evidence
   (`certification/evidence/deployed/`) records the current state.

## TL-side items executed for this wave (credential-bearing)

- Production deploy (repo-root law) + promote; controlled rollback drill.
- Neon branch separation + write-isolation proof.
- R2 lifecycle posture (preview 90-day expiry applied).
- Release record via the deployment driver (see
  spec/development-state/web-release-2026-10-03.json).

## What unblocks next

Phase 4 (Universal Money Interface, architecture 1.6-frozen-2026-10-02) is
BLOCKED_UNTIL_COMPLETE on this wave — closing P3-W3-003 completes Phase 3.
The Stripe UX research (P4-W1-003, the operator's 22-section directive,
user-assisted Google login through the replay) is the first Phase 4 item.

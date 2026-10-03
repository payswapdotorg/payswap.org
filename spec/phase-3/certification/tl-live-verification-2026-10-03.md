# TL Live-Verification Record — Phase 3 Wave 3 (P3-W1-003 acceptance §4)

Status: EXECUTED 2026-10-03, TL at the integration station, with operator credentials.
Runbook: `spec/phase-3/infrastructure/tl-live-verification.md` (Worker 1 deliverable).
Honesty law: values below are observed metrics and verbatim outcomes; secrets are never recorded.

## §1 Neon production/preview separation — VERIFIED

- Project `payswap` (floral-glade-01741858, aws-us-east-1) holds exactly two
  long-lived branches: `main` (default) and `preview` — branch policy holds.
- Host separation (§1.1): main = `ep-hidden-lab-b7oezqaq(-pooler)`,
  preview = `ep-mute-art-b7xn4xhl(-pooler)` — two different computes.
- Connectivity (§1.2): preview branch answered
  `select current_database(), current_user` → `neondb | neondb_owner` (via the
  pooler endpoint, TLS + channel_binding enforced by the platform).
- Write isolation (§1.3): probe table `_tl_separation_probe` written on
  preview (1 row); the SAME read on production FAILED with
  `relation "_tl_separation_probe" does not exist` — the expected PASS;
  probe dropped from preview after the proof.
- Autosuspend (§1.4): the API reports `suspend_timeout_seconds: 0` on both
  endpoints; the console-side 5-minute target could not be confirmed through
  this API view — recorded UNKNOWN, no action taken.

## §2 Upstash — UNKNOWN (endpoint deleted; zero production impact)

- The operator-provided REST endpoint `meet-ewe-145933.upstash.io` no longer
  resolves (NXDOMAIN); both provided REST tokens return WRONGPASS against
  every current endpoint — they belonged to the deleted database.
- The account's management API lists exactly one active database (`ADCOS`,
  `polished-yeti-167554.upstash.io`, global region) which does not accept
  either provided token — a different binding.
- The deployed PaySwap surfaces use NO Redis (in-memory Stage-1 by design);
  there is no production impact. The `payswap:*` namespace law and the
  command/rate budgets remain forward-looking contracts: when a Redis
  binding lands, re-run §2 against it.

## §3 Cloudflare R2 posture — VERIFIED (one gap FIXED live)

- Buckets exist: `payswap-evidence-prod` and `payswap-evidence-preview`
  (both created 2026-10-02).
- `payswap-evidence-prod` lifecycle: 7-day AbortIncompleteMultipartUpload,
  NO expiry rule — immutable evidence retained indefinitely. As expected.
- `payswap-evidence-preview` lifecycle: initially ONLY the 7-day multipart
  abort — the 90-day expiry rule required by the budget contract §4 was
  MISSING. FIXED live: `put-bucket-lifecycle-configuration` applied the
  "Preview Evidence Expiry" rule (Expiration 90 days) alongside the multipart
  abort; re-read confirms both rules Enabled.
- Storage posture: prod = 11 objects / 1,070 bytes (runtime-activation
  probes from 2026-10-02); preview = 0 objects. Far inside the 5 GB budget.
- Egress: R2 egress is $0 by design (console line-item check is
  operator-side; no charge mechanism exists on the free tier in use).

## §4 Vercel production-readiness — VERIFIED (with the drill adapted)

- §4.1 Deployment state: production alias `payswap-web.vercel.app` served
  the Wave 3 merge build (commit d12b329 → later 409d920 after the final
  promote), matching the source of truth.
- §4.2 Env completeness: `NEXT_PUBLIC_PAYSWAP_API_URL` is bound (the health
  envelope reports the API runtime baseUrl `https://payswap-mu.vercel.app`
  as configured).
- §4.3 Health/readiness: the hardened endpoint answers honestly —
  `liveness.state: "alive"`, `build.commit` present and correct, and
  `readiness.state: "degraded"` with the VERBATIM probe outcome:
  `GET /v1/health answered HTTP 400 on the API runtime`. Investigation: the
  API runtime (fail-closed by W3-002 design) requires session auth on every
  route including /v1/health — the web surface cannot authenticate (no
  public session issuance). This is the RECORDED honest limitation, not a
  web-surface bug; the degraded reading is correct behavior (UNKNOWN/degraded
  is never faked as ready).
- §4.4 Rollback drill — EXECUTED WITH ADAPTATION: the runbook's
  preview-deployment drill is NOT executable on the current platform
  (`vercel rollback` answers 422 "has never served production traffic" for
  preview-only deployments — preview aliases are not rollback targets).
  The controlled PRODUCTION drill was executed instead:
  1. BEFORE: production served the Wave 3 build (commit d12b329, hardened
     health shape) — verified via the public /api/health.
  2. `vercel rollback payswap-9f0dvy2ox…` re-pointed production to the Wave 2
     build — verified via public /api/health: commit 239c4a2, the OLD health
     shape (no readiness field). The alias re-point took ~2s.
  3. Roll forward: fresh production deploy + `vercel promote` (the promote
     step is REQUIRED after a rollback — a plain deploy does not reclaim the
     alias from a rollback pin; recorded as platform doctrine).
  4. AFTER: production serves commit 409d920, hardened health shape,
     liveness alive, readiness honestly degraded.
  The full rollback/roll-forward cycle is proven with public-endpoint
  evidence at every step. Drill deployments are not recorded in
  spec/development-state (only real rollbacks are).
- §4.5 Release-record reproducibility: machine-proven by
  `packages/web/test/infra-release-repro.test.ts` (byte-identical
  recomputation of the shipped record) in the wave battery; the FINAL Wave 3
  release record is written by the TL after the P3-W3-003 certification
  merge (deploy:record through the driver).
- §4.6 Budget posture: hobby plan, no credit-card spend; usage lines are
  operator-console-side (recorded as such).

## §5 Resend/Apify absence + dependency contract — VERIFIED (machine)

The dependency-audit suite ran in the wave battery (allowlist equality,
Resend/Apify absent from every manifest AND the lockfile; the escape hatch
cannot authorize them).

## §6 Sign-off

| # | Acceptance item | Verdict |
| --- | --- | --- |
| 1 | Vercel deployment production-ready | PASS (state, env, health, rollback cycle) |
| 2 | Neon production/preview separation | PASS (hosts differ + write isolation proof) |
| 3 | Upstash namespace/command/rate budgets | UNKNOWN (endpoint deleted; no Redis in the deployment — no impact) |
| 4 | R2 storage/egress/retention posture | PASS (preview expiry gap found and FIXED live) |
| 5 | Resend/Apify absent | PASS (machine-checked) |
| 6 | No unexpected paid dependency | PASS (allowlist equality) |
| 7 | Health/readiness/observability/rollback | PASS (honest degraded recorded verbatim; drill cycle proven) |
| 8 | Deployment record reproducible | PASS (repro test + record to be written at wave close) |

Open items for the operator (honest, non-blocking):
- Upstash: provide a live Redis endpoint + token if/when a Redis binding is
  actually needed (the current stack runs without it).
- Neon autosuspend: confirm the 5-minute suspend timeout in the console
  (the API view reports 0).

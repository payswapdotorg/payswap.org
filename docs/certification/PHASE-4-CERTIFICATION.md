# Phase 4 Certification Record — P4-W4-003 (Full Production Certification + Release)

- **Work order:** `spec/universal-money/work-items/P4-W4-003.md` (owner: worker-3; deps P4-W4-001, P4-W4-002, P4-W3-003 — all merged)
- **Base commit SHA:** `bf41475` (origin/main at dispatch — the P4-W4-002 merge)
- **Branch:** `work/P4-W4-003`
- **Dispatch:** local lane (TL-session subagent, Task 56-a)
- **Date:** 2026-10-06
- **Scope:** certification only — no contract changes, no new financial authority, no stubs replacing real calls. Every number below was produced by a fresh run at the recorded base/head on the local lane and cross-checks the banked integration-station evidence for the same tree.

> STATUS: Phase 1 (the 11 certification suites + integration evidence) is COMPLETE and
> recorded below. Phase 2 (browser journeys × viewports), the deployment-record section,
> the 16-gate table and the state-file reconciliation are being appended in follow-up
> commits on this branch as they complete — this checkpoint is pushed early per the
> push-early protocol; nothing below this note is provisional.

## 1. Integration evidence (root battery, typecheck, verify:repo)

All commands run from the repository root at base `bf41475` (clean tree,
`git status --short` empty) on node v24.21.0 / npm 11.19.0.

| Check | Exact command | Exact result |
|---|---|---|
| Root battery | `npm test` (root, = `npm run test --workspaces --if-present`) | **exit 0 — 4694 passed / 0 failed across 36 workspace packages** (log: `/tmp/w4003-local-battery.log`) |
| Pre-flight (ordered) | `cd packages/surface && npx vitest run` | 33/33 passed (2 files) |
| Pre-flight (ordered) | `cd packages/web && npx vitest run` | 306/306 passed (22 files) |
| Typecheck | `npm run typecheck` (root, = `npm run typecheck --workspaces --if-present`) | **exit 0 — 0 TypeScript errors** in every workspace that declares the script |
| Typecheck (work-order literal) | `npx tsc --noEmit` (repo root) | exit 1 — prints the tsc usage banner, **because the repository has no root `tsconfig.json`**; typecheck authority in this repo is per-workspace (`tsc --noEmit` inside each package, driven by `npm run typecheck`). The authoritative equivalent is the row above (0 errors). Recorded as an honest environment-mapping note, not a regression: the root has never had a tsconfig (verified `git log -- tsconfig.json` — no history). |
| Repository governance | `node scripts/verify-repository.mjs` | **exit 0 — `Repository governance verification passed.`** |

Battery totals per package (from `/tmp/w4003-local-battery.log`, vitest summary lines):

adapters 70, adversarial 61, agents 92, api 99, best-execution 81, campaigns 78,
capabilities 111, certification 62, connectors 170, design 156, execution 41,
interfaces 64, journeys 90, lab 109, merchant-checkout 170, merchant-crypto 191,
mixed-rail 71, onchain-adapters 90, onchain-domain 145, onchain-opportunities 153,
onchain-security 155, onchain-threat-intel 162, onchain-venues 61, operations 194,
participation 74, payment 60, protocol 237, rails 620, recourse 65, route-compiler 165,
security 72, settlement 53, surface 33, trust 79, ux 254, web 306 —
**sum 4694, 0 failed, 0 skipped-failed, exit 0.** Matches the banked run on this exact
HEAD (4694/4694) with zero delta.

## 2. The 11 certification suites (suite → package → exact command → exact result)

Each targeted command was run from inside the package's own directory. The root
battery (section 1) is the authoritative integration run; the targeted runs below
demonstrate each required suite in isolation with identical results.

| # | Required suite | Package(s) | Exact command (from inside the package dir) | Exact result |
|---|---|---|---|---|
| 1 | multi-chain | `packages/onchain-adapters` (W2-001) | `npx vitest run` (9 files: lifecycle-evm, lifecycle-solana, lifecycle-utxo, contract, environment, unknown-paths, secrets-boundary, no-vendor, smoke) | **90/90 passed** (EVM + Solana + UTXO family lifecycles, cross-chain contract semantics) |
| 2 | wallet/signer authorization | `packages/onchain-security` (W1-002) | `npx vitest run test/authorization.test.ts test/signers.test.ts test/delegation.test.ts test/secrets.test.ts` | **59/59 passed** (4 files: authorization artifacts/verification, signer/session-key envelopes, attenuated delegation, secret-material boundaries) |
| 3 | simulation/pre-broadcast recheck | `packages/onchain-security` (W1-002) | `npx vitest run test/recheck.test.ts test/pipeline.test.ts test/gates.test.ts test/stages.test.ts test/security-composition.test.ts test/boundary.test.ts` | **94/94 passed** (6 files: prepare→simulate→gates→state-diff→authorize→**pre-broadcast recheck**→broadcast handoff; recheck-diff abort paths) |
| 4 | DEX multi-venue routing | `packages/onchain-venues` (W2-002) + `packages/best-execution` | `npx vitest run` in `onchain-venues` (uniswap, aggregator, intents, best-execution-integration, pack-contract, adversarial); `npx vitest run` in `best-execution` | **61/61 passed** (7 files) + **81/81 passed** (7 files) — venue packs + best-execution comparator/gates integration |
| 5 | merchant crypto checkout | `packages/merchant-crypto` (W1-003) | `npx vitest run` (10 files: acceptance, quotes, intent, attempt, settlement, capabilities, assets, checkout, adversarial, boundary) | **191/191 passed** |
| 6 | eligible Stripe settlement | `packages/merchant-checkout` (W2-003) | `npx vitest run` (13 files: onboarding, acceptance, checkout, wallet-payment, settlement, refunds, webhooks, lifecycle, journey, api-surface, evidence-files, adversarial, boundary) | **170/170 passed** (settlement modes NATIVE_STRIPE_CRYPTO / PAYSWAP_EXTERNAL_SETTLEMENT with provider-verified effects only) |
| 7 | mixed fiat/onchain routes | `packages/route-compiler` (W4-001) + `packages/mixed-rail` (W3-001) | `npx vitest run` in `route-compiler` (route-1 crypto→DEX→off-ramp→bank, route-2 fiat→PSP→chain, route-3 DEX→bridge, route-4 Stripe-crypto, determinism, failure-injection, custody-continuity); `npx vitest run` in `mixed-rail` | **165/165 passed** (13 files) + **71/71 passed** (8 files) |
| 8 | onchain opportunities | `packages/onchain-opportunities` (W3-002) | `npx vitest run` (10 files: discovery, model, eligibility, observation, vocabulary, agent-cannot-execute, lab-composition, secret-free, boundary, smoke) | **153/153 passed** (no-guaranteed-returns vocabulary law; structural never-authorization tier) |
| 9 | adversarial blockchain exploits | `packages/onchain-threat-intel` (W3-003) + adversarial suites across the onchain packages | `npx vitest run` in `onchain-threat-intel` (14 files); then `npx vitest run test/adversarial.test.ts` in `onchain-domain`, `onchain-venues`, `merchant-crypto`, `merchant-checkout`; `npx vitest run test/adversarial.test.ts test/no-fake-quote-to-success.test.ts` in `best-execution` | **162/162 passed** + cross-package adversarial scans: onchain-domain **12/12**, onchain-venues **10/10**, best-execution (adversarial + no-fake-quote-to-success) **27/27**, merchant-crypto **15/15**, merchant-checkout **18/18** |
| 10 | UNKNOWN/reorg/finality | `packages/onchain-adapters` + `packages/onchain-domain` + `packages/settlement` | `npx vitest run test/unknown-paths.test.ts test/lifecycle-evm.test.ts test/lifecycle-solana.test.ts test/lifecycle-utxo.test.ts` (onchain-adapters); `npx vitest run test/execution.test.ts test/settlement-mapping.test.ts` (onchain-domain); `npx vitest run test/finality.test.ts test/reconciliation.test.ts test/certificates.test.ts` (settlement) | **40/40** + **42/42** + **23/23 passed** (reorg→UNKNOWN preservation, UNKNOWN never FAILED, reconciliation-only ambiguity exit, proof-carrying finality records/certificates) |
| 11 | responsive/browser UX | `packages/web` (W4-002) + `packages/surface` (W4-002) | `npx vitest run` in `web` (22 files incl. a11y-aria, a11y-keyboard, a11y-deep-links, honest-states, universal-interface, certification-boundaries); `npx vitest run` in `surface` | **306/306 passed** + **33/33 passed** (deep-link/no-dead-buttons scan, adversarial no-fake-success scans, responsive/a11y contracts) |

All targeted totals are strict subsets of the root battery's per-package totals
(section 1) — zero divergence between the targeted runs and the authoritative
integration run.

## 3. Browser verification (real rendered journeys)

*Appended in the follow-up commit: journeys × viewports (desktop 1440x900, mobile
390x844) over `http://localhost:4321`, console-error/page-error counts, screenshot
evidence under `packages/web/evidence/cert/` and the evidence README update.*

## 4. Security findings (adversarial summary)

*Appended in the follow-up commit (honest summary of suite 9 + the browser
no-fake-success / no-dead-buttons scans).*

## 5. Deployment URL/ID + environment mapping

*Appended in the follow-up commit (what the repository's own deployment tooling
produces; the existing certified chain; the honest operator-side gap).*

## 6. Rollback proof

*Appended in the follow-up commit.*

## 7. Unresolved limitations

*Appended in the follow-up commit.*

## 8. The 16 phase gates (gate-by-gate evidence table)

*Appended in the follow-up commit.*

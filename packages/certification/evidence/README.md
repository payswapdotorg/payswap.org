# P4-W4-003 Production Certification Evidence

Work Order: **P4-W4-003 — Production Certification + Release** (the terminal
Phase-4 item; `docs/UNIVERSAL-MONEY-HANDOFF-FULL-2026-10-02.md` §34, §35,
§36, §37).

This tree carries the COMMITTED, DETERMINISTIC certification artifacts of the
assembled PaySwap system at the pinned release base
`bf414753a8dce86b7d3afafbd447ecf74dd3e497` (the P4-W4-002 merge).

## What is here

```
evidence/
  certification-report.json     the generated, committed certification report
                                (regeneration: env-flag-guarded, below)
  deployment/
    deploy-record.json          the deploy:record receipt (run against a LOCAL
                                record target — never an external environment)
    runtime-plane-probe.txt     the deploy:probe receipt (attempt 1): the
                                fail-closed refusal — no vault bindings in the
                                certification sandbox, exit 1, recorded verbatim
    runtime-plane-probe-reprobe.txt   the re-probe receipt (identical refusal)
    provider-rollout.json       the rollout:record receipt (deterministic)
```

## How the certification is produced

The certification suites live in `src/production/` of this package and the
test battery in `test/production/`:

- the nine §35 acceptance journeys A–I are driven END-TO-END through the REAL
  composed kernels (the W4-001 route compiler, the W1-002 onchain-security
  kernel, the W2-002 best-execution engine over the real venue packs, the
  W3-001 mixed-rail lane composer, the W2-003 merchant-checkout kernel, the
  W3-002/W3-003 opportunity and threat engines, the W4-002 surface folds) —
  no re-implementations, no logic doubles. The ONLY synthetic elements are
  the DECLARED, NARROW DOUBLES at the external seams (the trusted-surface
  signer, the signer adapter, the trusted-surface submission boundary, the
  deterministic venue/pool/RFQ observation fixtures), each declared in
  `src/production/world.ts`;
- the seventeen §36 security certification gates are machine-checked against
  those kernels (plus proof-anchored source scans where the law is
  structural — each proof cites the exact file + line and is verified to
  contain the law at certification time);
- the fourteen-area matrix derives every verdict from the journeys, gates
  and deployment receipts — no verdict is ever asserted without its
  evidence;
- the deployment/rollback exercise drives the REAL `@payswap/operations`
  machinery (the same functions `scripts/deployment/` executes) and the
  committed CLI receipts were captured by running the actual scripts against
  a local record/probe target directory;
- the no-simulated-success audit scans every composed package's `src` tree
  for mock/stub/TODO/placeholder/simulated/fake markers outside the declared
  allowance contexts (the Lab tier's own vocabulary, simulation-as-
  observation vocabulary, adversarial-fixture vocabulary), verifies every
  definitive journey state is evidence-backed, and verifies the W4-001
  honest-unavailability notice renders verbatim.

## Determinism law

Same inputs → same artifacts. The test battery re-derives the certification
report from the same deterministic inputs and requires the committed file to
be BYTE-IDENTICAL. The journey digests, gate wall digest, matrix digest,
audit digest and report digest are all content-addressed
(`fnv1a64:<16 hex>` — the package's own `contentDigest`).

## Regenerating the committed report

```bash
cd packages/certification
CERTIFICATION_WRITE_EVIDENCE=1 npx vitest run test/production/matrix-report.test.ts
```

Without the flag, the same test READS the committed file and verifies the
twin (byte-equality + digest re-computation). The deployment CLI receipts
are point-in-time captures of the real script runs (the probe receipts are
honest fail-closed refusals — deterministic in content; the deploy record
and rollout record are byte-deterministic given the pinned release inputs).

## The safety claim

The report carries the §37 safety objective VERBATIM — and NOTHING stronger:

> **PaySwap provides a systematically stronger safety workflow than a raw
> transaction UI by inserting deterministic simulation, policy, route
> validation, security analysis, human-readable authorization,
> postcondition verification and continuous monitoring before and after
> execution.**

Evidence = certification tests + recorded observations. No marketing
language.

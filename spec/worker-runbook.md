# Worker Runbook

## Before coding
1. Read AGENTS.md.
2. Read docs/LLM-ARCHITECT-HANDOFF.md.
3. Read spec/architecture/FROZEN-ARCHITECTURE.md.
4. Read spec/architecture/INVARIANTS.md.
5. Read the active Work Order.
6. Read the development-state JSON and dependency graph.
7. Inspect source, tests and callers before trusting any completion claim.

## Contract-first sequence
1. freeze types/schemas/interfaces;
2. write contract tests;
3. implement deterministic authority;
4. wire real integration;
5. implement failure/reconciliation path;
6. add evidence;
7. add adversarial tests;
8. run verification;
9. update Work Order state.

## Forbidden
- Math.random for financial outcomes;
- setTimeout standing in for settlement;
- fake balances;
- production-reachable mock providers;
- UNKNOWN → FAILED fallback;
- unrestricted LLM transfer tools;
- duplicate local ledgers;
- untracked credit;
- opaque universal trust scores;
- incentive promises without funding/provenance;
- rewriting historical records.

## TL acceptance
The TL validates:
- exact changed files;
- Work Order scope;
- actual tests/commands;
- schema and migration safety;
- invariant coverage;
- failure paths;
- evidence;
- idempotency;
- security epoch;
- production wiring;
- browser/API journey where UI is affected.

## Worker completion report
Include:
- Work Order ID;
- commit SHA;
- files changed;
- tests actually run;
- real integrations verified;
- unresolved limitations;
- invariants exercised;
- next dependency unlocked.

Never claim tests pass without the exact command and environment.

## Architecture conflict
Worker finds conflict
→ stop at the boundary
→ report exact conflict
→ TL evaluates
→ ADR + architecture version if needed
→ dependency graph/state update
→ resume.

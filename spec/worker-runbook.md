# Worker Runbook

## Before coding
1. Read AGENTS.md.
2. Read docs/LLM-ARCHITECT-HANDOFF.md.
3. Read spec/architecture/FROZEN-ARCHITECTURE.md.
4. Read spec/architecture/INVARIANTS.md.
5. Read spec/architecture/LOSSLESS-CONNECTOR-CAPABILITY-MODEL.md when touching connector/provider code.
6. Read the active Work Order.
7. Read the development-state JSON and dependency graph.
8. Inspect source, tests and callers before trusting any completion claim.

## Contract-first sequence
1. freeze types/schemas/interfaces;
2. write contract tests;
3. implement deterministic authority;
4. wire real integration;
5. implement failure/reconciliation path;
6. add evidence;
7. preserve provider semantic state/evidence and connected-instance scope;
8. add adversarial tests;
9. run verification;
10. update Work Order state.

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
- rewriting historical records;
- treating provider catalogue availability as connected-account authority;
- flattening consequential provider state into generic CRUD outcomes;
- creating a second connector capability vocabulary;
- treating provider-reported balances as PaySwap custody;
- exposing provider passwords, API keys, refresh tokens, cookies, browser storage or MFA material to the agent model/context;
- using browser login on every transaction when an existing authorization/session can be reused;
- assuming PaySwap must possess a provider API credential to certify a local rail;
- treating an authenticated browser session as unrestricted withdrawal authority;
- capturing secret-bearing page content as ordinary evidence.

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

## Connector-specific acceptance
Before accepting connector work, the TL verifies:
- CapabilityDefinition → ProviderImplementation → ConnectedCapabilityInstance → CapabilityObservation;
- connected-account scope, authorization, geography/currency and eligibility are explicit;
- ProviderStateEnvelope preserves provider state, required customer action, external IDs/revisions and evidence where consequential;
- execution mode is explicit: PASS_THROUGH_NATIVE / COMPOSED_PAYSWAP / OPTIMIZED_MULTI_PROVIDER;
- provider-native optimization/recovery is represented as a capability and remains a valid incumbent baseline;
- external funds observations have freshness/provenance and cannot become PaySwap custody;
- W2-003 owns the capability vocabulary and W3-003 consumes it without redefining it;
- supported authorization mode is explicit and preserved on the ConnectedCapabilityInstance;
- browser/local-rail routes use an isolated browser/session boundary and expose only opaque references to agents;
- reauthentication/step-up and expiry are first-class customer-action states;
- connection scope is not blanket debit/withdrawal scope;
- providerless local-rail execution receives the same authorization, evidence, idempotency, reconciliation and UNKNOWN treatment as API execution.

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
→ TL evaluates
→ ADR + architecture version if needed
→ dependency graph/state update
→ resume.

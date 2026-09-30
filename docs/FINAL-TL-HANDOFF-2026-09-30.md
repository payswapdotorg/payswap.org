# Final TL Handoff — 2026-09-30

Repository: payswapdotorg/payswap.org
Default branch: main
Verified source HEAD before this handoff metadata update: f79ea407b37f45024c7c126779fa9713598375d2
Architecture lock: 1.2-frozen-2026-09-30

## Repository state

The repository was empty at takeover and has now been bootstrapped as the source of truth for the entire implementation.

Verified on the GitHub repository:
- frozen architecture exists;
- architecture closure review exists;
- non-negotiable invariants exist;
- Participation Engineering is first-class;
- external case studies are recorded;
- dependency graph exists;
- worker runbook exists;
- development-state JSON exists;
- all 21 Work Order files exist;
- governance verification script exists;
- CI workflow exists;
- production deployment remains disabled.

A direct local clone could not be performed in this environment because outbound GitHub DNS resolution is unavailable. Repository verification was therefore performed through the GitHub repository interface itself, including direct fetches of the architecture, state, work orders, tooling and latest commit.

## What is frozen

The network is an economic operating system centered on:

In addition to fulfillment, the architecture now explicitly includes FinancialOpportunity, typed protocol tokens, cognitive-tier selection, EconomicWork measurement, and versioned network treasury economics.
EconomicGoal → EconomicProgram → MoneyMovementIntent → authorization/policy → Strategy → Organization → Capability Graph → Execution Graph → Financial Protocol → clearing/netting/liquidity/FX → settlement/finality/evidence.

Participation is not an add-on. It is a first-class economic control loop:
bottleneck → ParticipationGoal → experiment → incentive/mechanism → contribution evidence → attribution → reward/recognition → abuse/dispute → adjustment/stop → learning.

## Initial three-worker frontier

Activate exactly these three:
- Worker 1: W1-001 Protocol Kernel + Persistence Contracts
- Worker 2: W2-001 Trust, Agent and Capability Contracts
- Worker 3: W3-001 API, Runtime and Experience Boundary Contracts

They are deliberately contract-first and pairwise-disjoint.

After each accepted Work Order:
1. TL verifies the commit and actual evidence.
2. TL updates the state JSON.
3. TL re-derives the frontier from the dependency graph.
4. TL activates no more than three pairwise-disjoint Work Orders.

## Architecture rules that prevent drift

Never:
- let agents/models call rails directly;
- duplicate the authoritative ledger in a downstream package;
- turn simulation into production settlement;
- turn UNKNOWN into failure;
- create unfunded monetary incentives;
- use a universal trust/reputation score for authorization;
- rewrite historical protocol/evaluation/contribution/expert records;
- add provider-specific types to domain contracts;
- expand a Work Order without updating repository state and dependency graph.

Always:
- use exact money;
- preserve authorization and evidence lineage;
- use idempotent commands;
- reserve financial/liquidity/credit/incentive capacity;
- version policies, programs, strategies, organizations, packages and resolutions;
- route external effects through the Financial Protocol Authority;
- keep the Lab outside financial authority;
- treat human experts as reusable capabilities;
- make security advisories network-wide.

## Implementation order

Use the dependency graph exactly as written. The intended cadence is:
Stage 0 contract foundations
→ Stage 1 authority enforcement
→ Stage 2 financial/capability/execution engines
→ Stage 3 settlement/evidence/Lab/participation
→ Stage 4 real rails/security/campaigns
→ Stage 5 recourse/certification/product UX
→ Stage 6 end-to-end certification/adversarial/deployment.

No downstream implementation should manufacture a missing dependency.

## Important architecture decisions

- Strategy and Agent Organization remain distinct.
- Netting is part of route/strategy optimization.
- Delay is not credit.
- FIAT, crypto and future rails are peers under one rail abstraction.
- AcceptanceCapability is distinct from user funding source.
- RecoursePolicy is frozen at intent initiation.
- Proof strength is explicit and policy-driven.
- Agent Body is stable; Soul/model is replaceable.
- Organizations are versioned data.
- Incentive campaigns are versioned, funded, attributable and anti-gaming.
- Leaderboards are projections, never financial authority.
- SecurityEpoch can globally restrict compromised components.
- Expert resolutions are versioned and reusable.
- OpenMuse/Codex/Claude/custom runtimes are adapters, not authorities.

## First implementation objective

Do not attempt to build the entire surface immediately.

First prove the kernel can express and persist:
- a signed identity/mandate;
- one EconomicGoal;
- one MoneyMovementIntent;
- one deterministic authorization decision;
- one obligation;
- one reservation;
- one idempotent command/event sequence.

Then add the dependency graph in order until a real test/sandbox rail can complete one end-to-end flow.

The TL should treat every worker report as a claim to verify, never as repository truth.

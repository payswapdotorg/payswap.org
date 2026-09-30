# Reality Engineering Lab and Director

## Lab responsibilities
The Lab is the experimentation engine. It never performs production money movement.

It can discover:
- strategies;
- organizations;
- Agent Bodies;
- capabilities;
- incentive mechanisms;
- pricing/routing policies;
- fraud/security responses;
- expert matching improvements.

## Domain Pack
A Domain Pack declares domain, scenario types, hard constraints, objectives, observables, action space, failure taxonomy, policy set, evaluation suite and provenance requirements.

## Scenario generation
Include normal demand plus:
- liquidity shortages;
- provider outages;
- FX volatility;
- delayed writes;
- approval delays;
- fraud;
- collusion;
- malicious agents;
- incentive gaming;
- partial payments;
- congestion;
- adversarial model behavior.

## Simulation and replay
The simulator models accounts, obligations, rails, liquidity, FX, credit, organizations, participants, incentives and incidents.

Simulation state is explicitly namespaced and cannot be returned as production evidence.

Replay uses recorded production facts without rewriting them.

## Search
Support replaceable optimizers:
- deterministic baseline;
- hand-designed baseline;
- evolutionary search;
- black-box optimization;
- contextual bandits;
- offline policy learning;
- RL;
- planning;
- hybrid portfolios.

## Evaluation
Measure:
- correctness;
- authorization;
- compliance;
- liquidity;
- deadline;
- total cost;
- economic compression;
- resilience;
- privacy;
- counterparty exposure;
- participation quality;
- reward efficiency;
- abuse rate;
- operational complexity.

Economic compression tracks unnecessary external movement, hops, liquidity locked, capital usage, cost/spread, latency and risk exposure.

## Promotion
DRAFT → BENCHMARKED → VALIDATED → SHADOW → CANARY → PRODUCTION → RETIRED.

Promotion is versioned and reversible.

A mandatory baseline suite contains:
1. deterministic/generalist;
2. hand-designed;
3. searched;
4. incumbent production candidate.

## Director
The Director is a subsystem:
- deterministic scheduler/policy engine;
- strategy resolver;
- organization resolver;
- capability resolver;
- mechanism/incentive resolver;
- candidate registry;
- evaluation/promotion service.

LLMs can provide reasoning, but cannot mutate authority state.

## Production learning
Outcomes become immutable trajectories, evaluations, failure cases, contribution outcomes, security incidents and expert resolutions.

Never rewrite a historical record to make a later candidate look better.

## Arena bridge
Unresolved capability gaps can be dispatched through an expert capability contract. Expert output becomes evidence and a learning artifact, not a hidden protocol override.

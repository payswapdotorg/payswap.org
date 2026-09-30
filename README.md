# PaySwap.org

Open economic operating system and programmable money-movement network.

Architecture lock: 1.1-frozen-2026-09-30. Repository status: architecture bootstrap; implementation is authorized only through the initial Work Order frontier.

The repository is the sole source of truth for the Tech Lead, three concurrent workers and future maintainers. Chat, agent reports, screenshots and claimed completion are not authoritative.

## Start here

1. AGENTS.md
2. docs/LLM-ARCHITECT-HANDOFF.md
3. docs/ARCHITECTURE-REVIEW-2026-09-30.md
4. spec/architecture/FROZEN-ARCHITECTURE.md
5. spec/architecture/INVARIANTS.md
6. spec/dependency-graph.md
7. spec/development-state/v2-work-order-state.json
8. spec/worker-runbook.md

## Architecture in one sentence

A deterministic financial protocol executes universal economic intents, while replaceable agents, strategies, capabilities, incentives and learning systems discover how to fulfill them safely and grow network participation.

## Initial concurrency

The first frontier is exactly:
- W1-001 — protocol kernel and persistence contracts;
- W2-001 — trust, agent and capability contracts;
- W3-001 — API, runtime and experience boundary contracts.

Maximum concurrency is three workers.

## Safety posture

The bootstrap contains no mock financial implementation. Simulation is reserved for the Reality Engineering Lab and cannot become production settlement.

## Verification

Run:

npm run verify:repo

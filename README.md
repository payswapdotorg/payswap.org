# PaySwap.org

Open economic operating system and programmable money-movement network.

Architecture lock: 1.5-frozen-2026-09-30. Repository status: architecture bootstrap; implementation is authorized only through the initial Work Order frontier.

The repository is the sole source of truth for the Tech Lead, three concurrent workers and future maintainers. Chat, agent reports, screenshots and claimed completion are not authoritative.

## Start here

1. AGENTS.md
2. docs/LLM-ARCHITECT-HANDOFF.md
3. docs/ARCHITECTURE-REVIEW-2026-09-30.md
4. spec/architecture/FROZEN-ARCHITECTURE.md
5. spec/architecture/SMART-CONTRACT-EXTENSIONS.md
6. spec/architecture/FRONTEND-UX-DEPLOYMENT.md
7. spec/architecture/PSP-ADAPTER-NETWORK.md
8. spec/architecture/SERVICE-CAPABILITIES.md
9. spec/architecture/LOSSLESS-CONNECTOR-CAPABILITY-MODEL.md
10. spec/architecture/PAYMENT-OPERATING-PLANE.md
11. spec/architecture/INVARIANTS.md
12. spec/dependency-graph.md
13. spec/development-state/v2-work-order-state.json
14. spec/worker-runbook.md

## Architecture in one sentence

A deterministic financial protocol executes universal economic intents, while replaceable agents, strategies, capabilities, incentives and learning systems discover how to fulfill them safely and grow network participation. The Payment Operating Plane keeps payment methods, rails, credentials, acceptance, settlement and reconciliation coherent above heterogeneous providers.

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


## Phase 2 — Real Provider Activation

The certified implementation phase is complete. Phase 2 activates real financial providers and closes executable geographic/payment-method coverage gaps.

Start here: `docs/FINAL-TL-HANDOFF-PHASE-2-2026-10-02.md` and `spec/research/PROVIDER-COVERAGE-STRATEGY-2026-10-02.md`.

Phase 2 frontier: P2-W1-001, P2-W2-001, P2-W3-001. Maximum concurrency remains three.

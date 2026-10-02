# Agent / Architect Governance

## Authority
This repository is the sole source of truth for implementation. Conversation history, model memory, PR descriptions, screenshots, agent reports, and claimed test counts are non-authoritative unless the repository records the underlying evidence.

Primary authority files:
- docs/SOURCE-OF-TRUTH.md
- docs/LLM-ARCHITECT-HANDOFF.md
- docs/FINAL-TL-HANDOFF-PHASE-4-2026-10-02.md
- docs/UNIVERSAL-MONEY-INTERFACE-ARCHITECTURE-2026-10-02.md
- spec/architecture/FROZEN-ARCHITECTURE.md
- spec/architecture/INVARIANTS.md
- spec/dependency-graph.md
- spec/development-state/v2-work-order-state.json
- spec/worker-runbook.md

## Mandatory rules
1. Never give an LLM, agent, extension, package, or external actor direct ledger or rail authority.
2. Every consequential financial effect has both authorization lineage and evidence lineage.
3. Money is exact integer minor-unit arithmetic or another explicitly lossless fixed representation. No floating-point money.
4. UNKNOWN is not FAILED. External ambiguity is reconciled; it is never blindly retried or converted into success or failure.
5. Financial truth is protocol-owned. Agents, RL, optimization, simulations, and human experts may propose actions but cannot declare financial finality.
6. Demo and production paths share one protocol pipeline. No fake settlement behind production UI.
7. Simulation code must be isolated under Lab/Simulation packages and must never be callable as a production rail adapter.
8. Historical protocol facts are immutable. Versioned specs, strategies, organizations, policies, resolutions, and incentive programs are never silently rewritten.
9. Child delegation is attenuated: childAuthority is a subset of parentAuthority.
10. User approval is a trusted-surface operation that creates a signed authorization artifact; a chat message itself is not authority.
11. Leaderboards, points, badges, and reputation are projections/signals, not universal trust scores and never substitute for authorization, compliance, or proof.
12. Monetary rewards become protocol obligations and use the same clearing/netting/settlement/reconciliation machinery as other economic value.
13. Incentive budgets are reserved before a program can promise funded monetary rewards.
14. Compliance, sanctions, risk, policy and security constraints are hard constraints before soft optimization.
15. A worker may not change frozen architecture. A required change must be proposed as an ADR/versioned architecture amendment and approved by the Tech Lead under repository governance.
16. Work must stay inside the assigned Work Order. Scope expansion requires an explicit update to the work-order file and dependency graph.
17. No speculative dependency, provider lock-in, or framework-specific primitive may leak into a domain contract when a provider-neutral interface is possible.
18. Never treat a provider catalogue capability as equivalent to a ConnectedCapabilityInstance. Execution must be scoped to actual account authorization, eligibility, geography/currency and current observation.
19. Preserve provider lifecycle semantics with ProviderStateEnvelope; do not collapse customer-action-required, asynchronous, capture, mandate, refund, dispute, payout or connected-account states into generic CRUD outcomes.
20. Provider-native optimization/recovery must be representable as a capability and remain an incumbent baseline; PaySwap must not assume composition is superior.
21. External provider balances/positions are observations, never PaySwap custody or customer balances.
22. W2-003 owns the canonical connector capability vocabulary; W3-003 consumes it. Do not create parallel connector/provider-state contracts.

## TL rules
The TL is an orchestrator, not a fourth worker. The TL:
- derives the active frontier from the state file and dependency graph;
- may activate at most three pairwise-disjoint Work Orders;
- owns integration, conflict resolution, architecture conformance, and promotion decisions;
- verifies source truth directly before accepting worker claims;
- never merges a financial effect without invariant, evidence, idempotency, reconciliation and failure-path checks;
- updates repository state after each accepted merge.

## Worker rules
Each worker:
- reads the architecture lock, its Work Order, and dependency graph before coding;
- implements only the assigned contract;
- writes tests with the implementation;
- records provenance for external specifications used;
- does not replace unresolved behavior with mocks;
- leaves an explicit capability state or TODO when required authority/evidence is missing rather than fabricating a result;
- reports exact commit SHA, tests run, known limits, and Work Order status.

## Commit convention
Use: <work-item-id>: <imperative change>

Example: W1-001: add deterministic obligation state machine

A commit is not accepted because a worker says it is complete. The TL validates the commit, CI, affected invariants, and the Work Order acceptance criteria.

## Phase 4 universal-money rules
23. Blockchain is a settlement-rail family, not the product identity; never create a parallel crypto ledger.
24. Chain, wallet, signer, smart-account, protocol, DEX, bridge, off-ramp and generic contract capabilities use the existing Capability/Connector model.
25. Raw private keys, seed phrases, wallet/provider secrets, cookies and MFA material never enter agent/model context or normal repository artifacts.
26. Supported consequential onchain writes require explicit authorization lineage and, where supported, simulation plus a pre-broadcast re-check.
27. Security/adversarial agents cannot override deterministic security BLOCK decisions.
28. Unknown generic contract writes never execute silently.
29. Submitted transactions are not financial finality; finality requires observation/evidence/reconciliation.
30. Stripe settlement is a capability only when the actual connected Stripe account/transaction is eligible; never fabricate provider effects.
31. Stripe UX research uses isolated browser sessions and user-assisted official Google authentication; credentials/session secrets remain outside workers and artifacts.
32. Stripe is the primary product/operational UX benchmark; reproduce interaction principles with original PaySwap implementation.

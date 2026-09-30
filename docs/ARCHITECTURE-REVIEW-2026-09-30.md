# Architecture Review — 2026-09-30

Architecture lock after closure: 1.1-frozen-2026-09-30

This review reconciles the full discussion into the frozen architecture.

## Added in this revision

### Opportunity Engine
FinancialOpportunity and the proactive Opportunity Engine are explicit first-class objects/services so the system can discover current, conditional and future economic improvements rather than only react to blocked intents.

### Typed protocol tokens
Typed protocol artifacts provide safe composition between extensions, capabilities and agent organizations without granting direct state mutation.

### Cognitive tiers and EconomicWork
The architecture now makes explicit how the Director chooses the least powerful safe cognitive capability and how the Lab measures economic compression.

### Treasury and network economics
The network's own fees, reserves, guarantees, incentives and operating budgets are versioned treasury policy rather than hidden application logic.

### Participation as a first-class economic subsystem
Added ParticipationGoal, ParticipationExperiment, IncentiveProgram, budget reservation, contribution attribution, reward accounting, referral attribution, recognition, role-specific leaderboards, reputation attestations and anti-gaming.

### Participation organizations
The Lab may discover organizations whose job is to increase liquidity, lending, repayment, merchant activation, corridor supply, expert supply, developer/agent participation, or security participation.

### Governance/policy authority
A separate Policy and Governance Authority owns versioned hard constraints, network parameters, fee rules, incentive budgets, eligibility, security response and effective epochs. Intelligence can propose, but cannot set financial truth.

### Reservation discipline
Financial value, liquidity, credit, incentive budgets and escrow capacity are explicitly reserved before execution or reward finalization. This prevents double allocation.

### Accounting completeness
The protocol covers journal entries, projections, fees, FX, incentive liabilities, credit exposures, escrow/bonds and recourse adjustments as first-class accounting objects.

### Time and epochs
All safety-sensitive versions and policies have explicit effective times/epochs. Delay is an optimization dimension. Security epochs bound delegated authority.

### Acceptance capability
Merchant/provider acceptance is a first-class capability, separate from funding source and route.

### Proof and evidence
Authorization lineage and evidence lineage are separate but linked. Proof policy chooses evidence strength; finality remains protocol-owned.

### Human fallback
Expert resolution is versioned and reusable. Later improvements never erase the historical resolution.

### Security immune system
Network-wide advisories can quarantine affected agents/packages/extensions/capabilities through a global security epoch.

### Production learning boundary
Simulation, RL and agent search are explicitly separated from production financial authority. Promotion is gated by replay/counterfactual, robustness, shadow and canary.

### Recovery and operations
Idempotency, durable outbox, reconciliation, replay, secret management, observability and restore/rebuild are implementation requirements rather than afterthoughts.

## Fundamental principles preserved
1. Intent is universal.
2. Economic intent is rail-neutral.
3. Permissions are delegated authority.
4. Agents never become financial authorities.
5. Bodies are stable; Souls/models are replaceable.
6. Organizations are data.
7. Capabilities are universal ecosystem primitives.
8. Extensions are first-class but non-authoritative.
9. Strategies are first-class.
10. Netting is an emergent strategy, not a bolt-on.
11. Time is an optimization dimension.
12. Credit is explicit.
13. FIAT, crypto and future rails are peers.
14. UNKNOWN never silently becomes failure.
15. Finality is protocol-owned.
16. Demo and production share the same protocol pipeline.
17. Security is network-wide.
18. Humans are capabilities.
19. The network learns from human resolutions and real outcomes.
20. REST, MCP, A2A and AG-UI are native boundary protocols.
21. Participation is optimized as an economic network problem.
22. Incentives are funded, attributable and anti-gaming.
23. Social reputation is evidence-backed and role-specific, never a universal authority score.

## Architecture closure check
No previously discussed core capability is intentionally omitted. The remaining details are implementation choices that must fit the frozen contracts rather than expand the authority model.

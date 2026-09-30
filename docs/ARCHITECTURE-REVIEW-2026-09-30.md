# Architecture Review — 2026-09-30

Architecture lock after closure: 1.5-frozen-2026-09-30

## Added in this revision

### Lossless executable connector model
The connector abstraction is tightened from a generic provider adapter into an account-scoped, executable capability representation:
CapabilityDefinition → ProviderImplementation → ConnectedCapabilityInstance → CapabilityObservation.

Provider state is preserved through ProviderStateEnvelope; required user actions, asynchronous lifecycle, provider IDs/revisions, evidence and recovery semantics are not flattened. Provider-native optimization/recovery is represented as a capability and can remain the incumbent baseline.

Execution modes are explicit: PASS_THROUGH_NATIVE, COMPOSED_PAYSWAP and OPTIMIZED_MULTI_PROVIDER.

Large provider packs are hierarchical and independently certifiable. Provider-reported external balances use ExternalFundsLocation / ExternalFundsPositionObservation and never imply PaySwap custody.

W2-003 owns the capability contract; W3-003 consumes it. The dependency graph now sequences them to prevent semantic drift.



### Payment-centric simulation closure
The revised benchmark compares payment/economic work against actual payment methods rather than vertical software products. It confirms that PaySwap's primary advantage is orchestration above rails and exposes payment-specific gaps: method/rail separation, acceptance policies, translation, recurring mandates, remittance preservation, off-network payment records, fallback reauthorization, refunds/recourse and merchant settlement destinations.

### Universal Connector Platform
Connectors now generalize beyond PSPs and expose versioned Connector Capability Packs covering authentication, search, reads, writes, actions, events, health, evidence, reconciliation and portability.

### Work Operating Plane
A first-class Work Graph links projects/cases, tasks, documents, conversations, decisions, contracts, external records and economic objects. This is the missing layer between professional work and the economic protocol.

### Main-interface strategy
PaySwap aims to become the primary interface while external vertical platforms can remain systems of record. This avoids a big-bang rebuild of every industry product.

### Regulatory perimeter
Each capability/flow explicitly declares its regulatory and contractual operating boundary.

### Commercial/operator architecture
Connector economics, PaySwap SaaS billing, partner revenue sharing, SLOs, support and enterprise procurement are explicit concerns.

### Simulation-driven closure
The one-year and multi-industry simulations surfaced context switching, external object mapping, long-running work, field/offline work and enterprise governance as the most important missing primitives.

## Retained principles
1. Intent is universal.
2. Economic intent is rail-neutral.
3. Permissions are delegated authority.
4. Agents never become financial authorities.
5. Bodies are stable; Souls/models are replaceable.
6. Organizations are data.
7. Capabilities are universal ecosystem primitives.
8. Extensions are first-class but non-authoritative.
9. Strategies are first-class.
10. Netting is a strategy, not a post-processing feature.
11. Time is an optimization dimension.
12. Credit is explicit.
13. FIAT, crypto and future rails are peers.
14. UNKNOWN never silently becomes failure.
15. Finality is protocol-owned.
16. Demo and production share one pipeline.
17. Security is network-wide.
18. Humans are capabilities.
19. The network learns from human resolutions and real outcomes.
20. REST, MCP, A2A and AG-UI are native boundaries.
21. Participation is optimized as an economic-network problem.
22. Incentives are funded, attributable and anti-gaming.
23. Smart contracts are first-class capabilities.
24. User Agents hide wallet mechanics without becoming custodians.
25. PSP integrations are provider-neutral.
26. UX/deployment architecture begins in Stage 0.
27. The main interface is a universal Work Command Center.

## Simulation conclusion
The architecture was coherent at the financial-protocol level but initially incomplete at the work-context level. The revised architecture closes that gap without turning PaySwap into a collection of vertical clones.

The intended product is:
**the agentic operating layer that understands the work, coordinates the systems and optimizes the economics.**

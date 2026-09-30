# Tech Lead Handoff — PaySwap.org

Date: 2026-09-30
Architecture: v1.1-frozen-2026-09-30

## Mission
Build an open economic operating system and programmable money-movement network in which humans, agents, developers, businesses, liquidity providers, lenders, merchants, experts, rails, and external services can contribute capabilities.

A user expresses an economic goal or money-movement intent. The network discovers feasible strategies, execution organizations, liquidity, capabilities, incentives, and human fallback as needed. The financial protocol remains deterministic and authoritative.

Core chain:

USER / DEV / EXTERNAL AGENT
→ TRUSTED SURFACE
→ USER/DEV AGENT
→ ECONOMIC GOAL / PROGRAM
→ PAYMENT / CREDIT / ASSET INTENT
→ AUTHORIZATION + POLICY + COMPLIANCE
→ STRATEGY
→ AGENT ORGANIZATION
→ CAPABILITY GRAPH
→ EXECUTION GRAPH
→ FINANCIAL PROTOCOL
→ CLEARING / NETTING / LIQUIDITY / FX
→ SETTLEMENT / RAIL EFFECT
→ FINALITY + EVIDENCE
→ OUTCOME / OPPORTUNITY / PARTICIPATION SIGNAL
→ LAB LEARNING

## Opportunity Engine

FinancialOpportunity is a first-class object for current, conditional and future opportunities. The engine can discover cost, revenue, liquidity, credit, asset, treasury, network and participation opportunities. Suggestions remain advisory until compiled into authorized protocol actions.

## Typed protocol artifacts

Extensions compose through typed protocol tokens for Intent, Capability, Authorization, Evidence, Quote, Liquidity, Credit, Execution, Settlement, Netting, Dispute/Recourse, Expert, Policy and Participation. Tokens are typed references/artifacts, not financial authority.

## Cognitive and economic efficiency

The Director selects among deterministic and increasingly capable cognitive tiers (0 deterministic through 5 human expert). The Lab tracks EconomicWork: external movement, hops, liquidity locked, capital, cost/spread, latency and risk.

## Participation Engineering
The network must discover ways to increase useful participation, not merely route value.

It detects bottlenecks such as:
- insufficient corridor liquidity;
- too few lenders;
- weak healthy borrower activity;
- low merchant activation;
- weak sender/recipient adoption;
- scarce experts, agents, developers, validators, or verification capacity.

It can discover interventions such as fee rebates, rate adjustments, matched funding, capacity priority, referrals, bounties, points, role-specific leaderboards, reputation attestations, cooperative pools, bond/collateral subsidies, targeted onboarding, or actual friction reduction.

Participation organizations are ordinary versioned Agent Organizations. They propose and operate programs but cannot become financial authorities.

## Five authorities
1. Financial Protocol Authority — immutable money/obligation state, reservations, clearing, netting, settlement, rail effects, finality, recourse and financial evidence.
2. Trust and Authorization Authority — identity, agent principals, mandates, delegation, approvals, credentials and security epochs.
3. Capability and Network Authority — capabilities, acceptance capabilities, provider records, extensions, packages and certification.
4. Policy and Governance Authority — versioned hard constraints: risk, compliance, fees, incentive budgets, security response, eligibility and effective epochs.
5. Intelligence and Learning Authority — simulation, search, opportunities, strategies, organizations, mechanisms, evaluation and promotion proposals.

## Implementation posture
Start as a modular monolith with hard package boundaries.
Recommended foundations:
- TypeScript / Node / Next.js for product and API surfaces;
- PostgreSQL / Neon as system of record;
- deterministic domain packages without framework imports;
- workers for asynchronous settlement, reconciliation and Lab work;
- provider-neutral adapters for rails and agent runtimes.

Do not copy prototype-only behavior from related repositories. Reuse concepts, then verify and harden them.

## External boundaries
- REST/HTTP for application and developer APIs.
- MCP for agent → capability/tool integration.
- A2A for agent ↔ agent collaboration.
- AG-UI for agent ↔ application interaction.
- Messaging adapters for trusted human approval.
- Rail/provider APIs only through protocol-authorized adapters.

## Acceptance definition
The architecture is implemented only when:
- every production financial effect passes through one authoritative protocol path;
- real rail adapters replace simulation;
- UNKNOWN and reconciliation work end-to-end;
- obligations, netting, liquidity, FX and credit are integrated;
- authorization, security epochs and evidence are enforced;
- incentive programs are funded, attributable, anti-gaming, auditable and settle through the same financial machinery;
- agent Bodies and Organizations can change without changing protocol truth;
- Lab candidates pass replay/counterfactual, robustness, shadow and canary gates;
- human expert fallback is recorded with reusable evidence;
- APIs/MCP/A2A/AG-UI interoperate through provider-neutral contracts;
- browser journeys exercise production wiring with no dead buttons or fake settlement.

## Current start
The exact initial frontier is in spec/development-state/v2-work-order-state.json. Do not invent a different starting point in chat.

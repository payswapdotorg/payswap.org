# PaySwap.org — Frozen Architecture v1.2

Status: FROZEN
Locked: 2026-09-30
Supersedes: 1.1-frozen-2026-09-30
Purpose: sole architecture authority for implementation

## 1. Product definition
PaySwap.org is an open economic operating system built around a deterministic financial protocol and a replaceable intelligence layer.

Two core primitives:
1. EconomicGoal — what the principal wants economically.
2. MoneyMovementIntent — an executable value-transfer demand.

FinancialOpportunity is a first-class proactive object. It describes a current, conditional or future way to improve an economic outcome, with affected objects, preconditions, proposed action, expected benefit, cost, risk, liquidity/capital impact, evidence and expiry.

Ecommerce, payroll, P2P, cross-border, savings, investment, credit, lending, BNPL, crowdfunding, treasury, DAO and service-access workflows compile into shared primitives rather than parallel payment engines.

## 2. System planes
A. Experience — web, mobile, developer UX, merchant checkout, SDKs, Aurum and messaging surfaces.
B. Trust / Delegation — identity, agent principals, mandates, permission grants, approvals, credentials and security epoch.
C. Economic Control — goals/programs, intent compiler, constraints, authorization, policy and strategy.
D. Agent Network — Agent Body, Agent Instance, Agent Package, Organization, runtime, communications and agent-native wallet/session-key capabilities.
E. Capability / Market Network — capabilities, acceptance, providers, rails, FX, liquidity, credit, experts, extensions and certification.
F. Financial Protocol — deterministic accounting of obligations, reservations, clearing, netting, settlement instructions, external rail effects, finality, FX, liquidity, credit, fees, disputes and recourse. PaySwap is non-custodial: it does not take custody/title to user funds and acts only as an orchestration/co-ordination layer.
G. Participation Economics — participation goals, experiments, contribution records, incentive programs, budgets, rewards, referrals, recognition, leaderboards and reputation attestations.
H. Reality Engineering Lab — replay, scenarios, simulation, fault injection, strategy/org/capability/mechanism search, evaluation, security experiments, human fallback and promotion.

Cross-cutting: evidence, provenance, privacy, compliance, security immune system, observability, governance, configuration epochs, non-custodial controls, frontend experience architecture and deployment architecture.

## 3. Core control loops
Fulfillment: Intent → constraints → strategy → organization → execution graph → protocol → settlement → evidence.

Liquidity: demand forecast → gap → capability discovery → liquidity/credit strategy → reservation → settlement → measured outcome.

Participation: bottleneck → ParticipationGoal → hypothesis → mechanism program → controlled exposure → contribution evidence → attribution → reward accrual → abuse/dispute checks → program adjustment/stop → learning.

Security: signal → threat signature → risk decision → restrict/quarantine → recovery/reconciliation → evidence → learned response.

Human capability: gap → CapabilityCase → qualified match → ExpertTask → Resolution version → protocol decision/evidence → learning.

Learning: outcome → trajectory → evaluation → candidate → replay/counterfactual → robustness → shadow → canary → promotion.

## 4. Authority boundaries
Financial Protocol Authority owns financial truth and external effect authorization.
Trust and Authorization Authority owns delegated power.
Capability and Network Authority owns the network capability catalog and certification.
Policy and Governance Authority owns versioned hard constraints and program budgets.
Intelligence and Learning Authority proposes, evaluates and promotes intelligence artifacts but cannot directly mutate protocol truth.

No authority may impersonate another.

## 5. Identity and delegation
Identity, Principal and AgentPrincipal are distinct.
An AgentPrincipal binds agent key, owner reference, Body/package version, authority envelope and security epoch.
Mandates define allowed actions, resources, rails, currencies, countries, beneficiaries, transaction and velocity limits, cost/spread limits, expiry, escalation and proof requirements.
Child delegation must be attenuated.

## 6. Economic intent
ServiceAccessIntent is a complementary goal/intent form for obtaining a service or entitlement. It may be fulfilled through direct subscription, prepaid entitlement, delegated billing, LP financing, network credit or a certified smart-contract service. Its funding credential and service/account credential remain distinct.

MoneyMovementIntent contains at minimum:
- principal and counterparty context;
- source/destination rail, currency and country;
- amount;
- deadline and timing window;
- max total cost and FX spread/cost;
- privacy requirements;
- AML/KYC/compliance requirements;
- beneficiaries;
- partial-payment/tranche rules;
- settlement atomicity;
- recourse/protection policy;
- liquidity/credit preferences;
- acceptable intermediate rails;
- proof requirements;
- idempotency key;
- expiry.

Historical intents pin the intent spec and compiler version that created them.

## 7. Strategy vs Organization
Strategy answers what should happen.
Organization answers who or what executes it.

Examples of strategies:
settle-now, delay-within-window, batch, net-later, consume-incoming-funds, use-network-credit, switch-FX-route, internalize, PvP, tranche, recruit-liquidity, subsidize-scarce-participant, use-expert, cooperative-pool and undiscovered strategies.

Organizations are versioned graphs of Bodies/Instances with communication, delegation, memory, budgets, evaluators, termination and safety policy.

The Director is a subsystem made from deterministic controls plus replaceable learned components; it is not one privileged LLM.

## 8. Financial protocol hierarchy
Economic activity
→ fulfillment activity
→ clearing record
→ obligation
→ netting set
→ net position
→ settlement instruction
→ settlement attempt
→ rail operation
→ finality record.

Evidence is separate but linked to every stage.

The protocol provides immutable double-entry **accountability accounting** for obligations, fees, FX, incentives, credit, escrow positions and settlement records. This ledger is not a custodial user-balance ledger: PaySwap does not take title to or directly hold user funds. External value remains at its rail/provider or certified smart-contract capability. Projections describe network obligations/positions and settlement status, not a claim that PaySwap possesses customer funds.

It also provides atomic reservations, idempotent commands, deterministic state machines, durable outbox/events, reconciliation, and temporal settlement windows.

## 9. Netting, timing and credit
Netting is a strategy available before final route selection.

A payment may be delayed only if the intent permits it, deadline remains satisfiable, policy allows it, protected atomicity is preserved, and liquidity/risk optimization shows a lawful benefit.

If a third party fronts value, create explicit CreditExposure. Delay is not hidden credit.

## 10. Value conversion graph
Every rail/currency pair is a graph node/edge capability with quote, fee, latency, reliability, liquidity requirements, compliance requirements, finality, reversibility/recourse, proof requirement, capacity and provenance.

No floating-point money. FX values are exact/provenanced.

## 11. Capability graph
Capabilities are the universal ecosystem unit.
Possible capability classes:
rail movement, liquidity, FX, credit, lending, merchant acceptance, identity/KYC/AML, expert resolution, agent behavior, software extension, developer service, verification and data/oracle.

Every capability declares conditions, cost, risk, availability, provenance, economic accountability, proof requirements and bond/collateral/recourse where relevant.

AcceptanceCapability is first-class so merchant acceptance is distinct from funding source.

## 8A. Non-custodial financial authority

Financial Protocol Authority means authority over PaySwap's protocol records and authorized execution, not custody of user funds.

PaySwap may:
- validate and sequence obligations;
- reserve protocol/accountability capacity;
- compute net positions;
- authorize external execution;
- record fees, credits, incentives and recourse;
- reconcile external outcomes.

PaySwap may not:
- unilaterally withdraw customer funds;
- move assets held in a user smart contract without the contract's permitted authorization path;
- represent an internal database balance as proof that PaySwap holds corresponding customer assets.

## 12. Smart-contract services and non-custodial custody
Smart contracts are first-class Extensions and may implement banking/PSP-like economic services such as escrow, lending, savings, credit, liquidity, guarantees, rewards, recurring logic, cooperative pools and treasury rules.

A smart-contract extension is represented in the Capability Graph exactly like any other provider and becomes searchable by the Lab after certification.

A contract is not automatically trustless. Certification evaluates source/bytecode correspondence, upgrade/admin authority, pause powers, oracle/bridge dependencies, accounting invariants, MEV/economic attacks and recovery paths.

PaySwap must not have unilateral withdrawal authority over funds. Any fund-holding capability must expose immutable or appropriately constrained withdrawal authority, with upgradeability/governance risks explicit.

User Agents may operate non-custodial smart accounts through provider-neutral SmartAccountCapability. Where supported, account abstraction can provide session keys, spending policies, recovery, batching and gas sponsorship. The root account credential never enters model context.

The network may coordinate onchain execution but does not itself become the custodian.

## 13. Packages and extensions
Agent Packages contain Bodies, organization templates, capabilities, required extensions, security epoch, runtime requirements, model compatibility, evaluation suite and provenance.

Lifecycle:
DRAFT → STATIC_ANALYSIS → BENCHMARKED → SECURITY_REVIEW → CERTIFIED → AVAILABLE → SUSPENDED → RETIRED.

Extensions use typed protocol artifacts/tokens and never hold direct ledger authority.

## 14. Participation Economics
Participation Engineering discovers interventions that increase useful participation.

ParticipationGoal declares target bottleneck, actor population, desired behavior, scope, time, budget, risk, privacy and stop condition.

ParticipationExperiment declares hypothesis, cohort, comparison, treatment, attribution, guardrails and evaluation.

IncentiveProgram declares sponsor, objective, eligibility, contribution definition, evidence requirements, reward formula, budget, emission policy, caps, concentration limits, anti-Sybil/anti-collusion policy, clawback/dispute rules, privacy, effective period and version.

Monetary rewards create RewardAccrual and protocol obligations. Points and leaderboards are non-authoritative projections.

Supported mechanism families:
fee rebate/credit; interest boost/discount; matched funding; threshold or time-bounded bonus; capacity/priority rights; referral; bounty; points; recognition; reputation attestation; bond/collateral subsidy; lawful network-funded guarantee; cooperative participation.

Dynamic programs may increase emissions below a target band, normalize inside a target band and taper above a target band. Every change creates a new effective version.

Leaderboards are role-specific, quality-adjusted, time-bounded projections. They must not reward raw activity when that activity can be fabricated cheaply.

## 15. Recourse and protection
RecoursePolicy is frozen at intent initiation.
Mechanisms can include rail reversal, authorized pullback where supported, escrow, seller reserve/bond, network guarantee/insurance, explicit credit or hybrid.
Disputes create new records and never rewrite the original transaction.

## 16. Proof-carrying settlement
Proof levels:
P0 assertion;
P1 authenticated artifact/receipt;
P2 provider-signed evidence;
P3 independent destination observation;
P4 multi-party corroboration plus bond;
P5 native ledger/rail finality.

Risk policy selects the required level. Every consequential movement has ExecutionProof and a final SettlementCertificate.

An agent signature proves the agent acted; it does not prove the owner was truthful.

## 17. Security immune system
Signals include device/SIM/account changes, beneficiary changes, graph anomalies, velocity, agent/package behavior, provider incidents, expert findings, verification failures and coordinated abuse.

SecurityAdvisory can raise SecurityEpoch and restrict, quarantine or retire affected components. Cached capability state cannot bypass quarantine.

## 18. Human fallback
CapabilityCase → requirements → qualified match → ExpertTask → ExpertResolution version → protocol decision/evidence → learning.

Later better resolutions coexist with historical versions.

## 19. Lab
The Lab owns domain packs, scenarios, world simulation, replay, fault injection, strategy search, organization search, capability discovery, incentive/mechanism discovery, security experiments, evaluator, calibration, robustness, shadow, canary and promotion.

Search methods are replaceable: evolutionary search, black-box optimization, bandits, offline learning, RL, planning or combinations.

Hard constraints are enforced before soft optimization. Baselines include deterministic/generalist, hand-designed, searched and incumbent candidates.

Simulation is never production truth.

## 20. Runtime and external protocols
Agent runtime contract supports session creation, execution, event streaming, approval, tool request, checkpoint, pause, resume, cancel and inspect.

MCP is agent → capability/tool.
A2A is agent ↔ agent.
AG-UI is agent ↔ application.
REST/webhooks are application/provider boundaries.
Messaging is a trusted human approval surface.

These standards are edge adapters, not domain authority.

## 21. Deployment topology
Start as a modular monolith:
- web/API;
- protocol worker;
- rail adapter workers;
- reconciliation worker;
- Lab worker;
- notification worker.

PostgreSQL is system-of-record. Object storage holds large evidence artifacts. Secrets use a vault/provider secret store.

Extract services only when measured needs justify it.

## 22. Terminal states
FULFILLED
WAITING
USER_ACTION_REQUIRED
NO_VIABLE_ROUTE
COMPLIANCE_BLOCKED
EXPIRED
CANCELLED
FAILED
UNKNOWN

UNKNOWN always requires reconciliation.

## 23. Opportunity Engine

The Financial Opportunity Engine continuously discovers opportunities across:
- cost reduction;
- revenue/capability supply;
- liquidity;
- credit;
- asset usage;
- treasury;
- network growth;
- participation.

An opportunity is advisory until compiled into an authorized program/intent. Opportunity discovery may be proactive or reactive. User agents may surface opportunities through trusted surfaces without treating suggestions as permission.

## 24. Typed protocol tokens

Extensions, Agents and Organizations compose through typed protocol artifacts rather than direct state mutation.

Token families:
- Intent;
- Capability;
- Authorization;
- Identity/Evidence;
- Quote;
- Liquidity;
- Credit;
- Execution;
- Settlement;
- Netting;
- Dispute/Recourse;
- Expert;
- Policy;
- Participation/Incentive.

A token is a typed reference to authoritative protocol state or an immutable content-addressed artifact. Tokens are not money.

An extension may consume and emit permitted token types declared in its manifest. Financial effects still require a protocol-authorized command.

## 25. Cognitive tiers and economic work

The network chooses the least powerful cognitive tier that safely solves a task:
- Tier 0: deterministic rules/algorithms;
- Tier 1: fast/small model;
- Tier 2: specialist model;
- Tier 3: deep reasoning;
- Tier 4: multi-agent organization;
- Tier 5: human expert.

Escalation is policy-driven by complexity, risk, ambiguity and expected value.

The Lab measures EconomicWork: external value moved, number of hops, liquidity locked, capital consumed, fees/FX spread, latency and risk exposure. Strategies that compress unnecessary economic work without violating hard constraints are preferred.

## 26. Network economics and treasury

The network itself is an economic actor with versioned treasury policies for:
- fees;
- reserves;
- guarantees;
- incentive budgets;
- security bounties;
- operator costs;
- liquidity programs.

Treasury actions are ordinary protocol obligations/settlements and are subject to the same authorization, policy, accounting and evidence rules as user activity.

## 21A. Frontend and deployment architecture
Experience and deployment are designed from Stage 0. Every major capability must have a discoverable UX journey, authoritative state mapping, approval/error/UNKNOWN behavior and deployment ownership before backend completion is declared.

Stripe.com is the primary design/reference lab for information architecture, product hierarchy, onboarding, dashboards, checkout, billing, Connect, developer tooling, agentic commerce and operational states. The repository records findings; proprietary/private data is never copied.

A PSP integration is provider-neutral. Stripe is one adapter among any PSP that can expose the required capability. The system supports a Merchant PSP Connector pattern in which a merchant keeps its existing PSP stack while exposing PaySwap as an additional payment method/processor/orchestration capability. PaySwap then routes to any supported rail/capability it can lawfully and operationally reach.

## 27. Completion criterion
The architecture is complete only when a real end-to-end economic flow can discover and use real capabilities and rails, produce deterministic accounting and evidence, reconcile ambiguity, enforce delegated authority, use netting/liquidity/FX/credit/incentives, support disputes/recourse, and learn from outcomes without allowing an LLM or simulator to become financial truth.

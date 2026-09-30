# Domain Model and Package Boundaries

## Rule
Domain packages must not import web/UI/framework/provider runtime code.

## Packages

protocol
- exact Money and identifiers;
- command/event envelopes;
- state machines;
- immutable journal;
- balances/projections;
- reservations;
- obligations;
- clearing/netting/settlement;
- finality;
- fee and incentive liabilities.

trust
- identities and principals;
- mandates;
- delegated authority;
- approval artifacts;
- credentials;
- security epoch.

intent
- EconomicGoal;
- EconomicProgram;
- MoneyMovementIntent;
- IntentArchetype;
- constraints;
- compiler contracts;
- recourse/proof requirements.

strategy
- Strategy;
- ExecutionPlan;
- route/temporal optimization;
- liquidity/credit/FX selection;
- evaluation interfaces.

agents
- AgentBody;
- AgentInstance;
- AgentPackage;
- Organization;
- runtime adapters;
- communication and memory contracts.

capabilities
- CapabilityGraph;
- AcceptanceCapability;
- Provider/Corridor;
- Extension;
- certification;
- availability and indeterminate semantics.

liquidity
- LiquidityAsset;
- LiquidityPosition;
- LiquidityReservation;
- forecasts;
- commitments.

credit
- CreditLine;
- CreditExposure;
- collateral;
- delegated credit;
- repayment.

fx
- FxQuote;
- conversion;
- rate provenance;
- realized/unrealized valuation.

participation
- ParticipationGoal;
- ParticipationExperiment;
- IncentiveProgram;
- IncentiveBudget/Reservation;
- ContributionRecord;
- attribution;
- RewardFormula/Accrual/Claim;
- referral;
- recognition;
- LeaderboardProjection;
- ReputationAttestation;
- anti-gaming.

disputes
- DisputeCase;
- adjudication;
- RecoursePolicy;
- RecourseObligation;
- escrow/bonds/guarantees.

evidence
- EvidenceGraph;
- ProofRequirement;
- ExecutionProof;
- SettlementCertificate;
- provenance.

lab
- DomainPack;
- Scenario;
- Simulation;
- Replay;
- Trajectory;
- Candidate;
- Evaluation;
- Promotion.

security
- ThreatSignature;
- SecurityAdvisory;
- SecurityEpoch;
- quarantine/incident handling.

interfaces
- REST/HTTP;
- webhooks;
- SDK;
- MCP;
- A2A;
- AG-UI;
- messaging;
- rail/provider adapters.

## Authority boundary
Financial commands are accepted only after authentication, mandate evaluation, policy/compliance, capability/risk checks and idempotency.

An agent proposal, plan, model explanation or human expert recommendation is an input to a decision, never the authority itself.

## Data rules
- versioned authoritative objects;
- append-only evidence;
- rebuildable projections;
- content-addressed or stable external references;
- PII/regulated data isolated from generic telemetry.

## Concurrency
Mutate on the smallest necessary authority key: account/ledger, reservation, obligation/netting set, settlement instruction, incentive budget.

Assume at-least-once delivery. Use idempotent commands and durable outbox/event processing.

## Provider isolation
Provider SDK types and API quirks remain inside adapters. Canonical domain contracts never import provider types.

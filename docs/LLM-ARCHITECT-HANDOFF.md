# Tech Lead Handoff — PaySwap.org

Date: 2026-09-30
Architecture: v1.5-frozen-2026-09-30

PaySwap operating boundary: non-custodial orchestration. PaySwap does not take custody/title to user funds; onchain holding is delegated to certified smart-contract capabilities with no unilateral PaySwap withdrawal path.

## Mission

PaySwap's payment-specific control plane is frozen in the Payment Operating Plane. PaymentMethod, RailCapability, PaymentCredentialCapability, PaymentAcceptancePolicy, PaymentMethodTranslation, PaymentAttempt, MerchantSettlementDestination, RemittanceAllocation and OffNetworkPaymentRecord are separate concepts.
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

## Connector authorization and credential isolation

Connector execution is explicitly non-custodial.

A connected provider account belongs to the external account owner. PaySwap receives authorization to use selected capabilities; it does not receive ownership of the underlying funds.

The connection layer must support:
- DELEGATED_OAUTH;
- CONNECTED_ACCOUNT;
- SCOPED_API_CREDENTIAL;
- INTERACTIVE_BROWSER_SESSION;
- PROVIDERLESS_RAIL.

The user's agent/trusted surface may initiate interactive provider login, especially for local rails with no usable API credential, but the LLM MUST NOT see passwords, API keys, OAuth refresh tokens, cookies, browser storage, MFA secrets or equivalent authentication material. The secure credential/browser broker returns only opaque authorization/session references and sanitized metadata.

Subsequent financial actions reuse the existing authorization through the connector runtime. Reauthentication/step-up is requested only when required. Connecting an account never implies unrestricted withdrawal authority; debit/transfer-out capabilities are separately scoped.

## Connector execution rule

A provider catalogue is not an executable capability. Every connector resolves:
CapabilityDefinition → ProviderImplementation → ConnectedCapabilityInstance → CapabilityObservation.

W2-003 owns that vocabulary and instance/observation contracts. W3-003 consumes it and owns executable adapter behavior.

ProviderStateEnvelope is mandatory for consequential provider operations where provider state, required customer action, external IDs/revisions or provider evidence matters.

Connector execution modes are explicit:
- PASS_THROUGH_NATIVE;
- COMPOSED_PAYSWAP;
- OPTIMIZED_MULTI_PROVIDER.

Provider-native optimization/recovery is itself a capability and is a mandatory incumbent baseline. The Lab must be able to choose the incumbent path rather than optimize merely for additional orchestration.

ExternalFundsLocation and ExternalFundsPositionObservation represent provider-reported external funds state. They never create PaySwap custody or a PaySwap customer balance.

Browser/local-rail execution is valid when the provider permits it and the real user-authorized external capability can be established. The browser runtime must be isolated from the model and preserve the same authorization, evidence, idempotency, ProviderStateEnvelope and reconciliation requirements as API execution.

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

## Payment benchmark

The repository's current payment-centric simulation is spec/research/SIMULATION-MULTI-INDUSTRY-PAYMENTS-2026-09-30.md. It is the authoritative synthetic benchmark for payment/economic-interface adoption and supersedes the earlier vertical-software comparison.

## Current start
The exact initial frontier is in spec/development-state/v2-work-order-state.json. Do not invent a different starting point in chat.

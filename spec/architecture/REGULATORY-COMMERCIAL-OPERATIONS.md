# Regulatory, Commercial and Operational Architecture

## Regulatory perimeter

PaySwap's orchestration model does not eliminate regulation.

Each capability/flow must carry a RegulatoryProfile:
- jurisdiction;
- actor/licensed entity;
- activity classification;
- allowed users;
- data restrictions;
- funds-flow restrictions;
- approval requirements;
- disclosure requirements;
- recordkeeping;
- effective policy epoch.

The Policy and Governance Authority evaluates whether PaySwap may coordinate a capability in the given context.

The system should prefer lawful provider capabilities rather than assuming a smart contract removes regulatory obligations.

## Commercial model

PaySwap is a network/software/orchestration business.

Potential revenue sources:
- connector subscription/usage fees;
- network/API fees;
- capability marketplace revenue share;
- agent/package marketplace revenue share;
- premium routing/orchestration;
- enterprise workspace subscription;
- developer usage;
- partner settlement/service fees where lawful;
- Lab/certification services.

Do not base the core business model on custody spread.

## Partner economics

Connectors, capabilities, agents, experts and incentive sponsors can have programmable commercial terms.

Commercial terms are explicit objects with:
- publisher/owner;
- price;
- revenue share;
- usage meter;
- effective period;
- taxes/withholding where applicable;
- settlement obligation;
- cancellation/termination.

## Billing PaySwap itself

PaySwap's own subscription/billing is separate from the end-user economic network.

The PaySwap company may use Stripe or another PSP for its own SaaS billing without making that PSP the network's financial dependency.

This distinction prevents the company from accidentally becoming architecturally dependent on its own example connector.

## Operations

The company needs:
- support/case management;
- incident management;
- provider incident registry;
- connector health;
- service-level objectives;
- runbooks;
- customer onboarding;
- partner management;
- credential rotation;
- disaster recovery;
- data deletion/export;
- security response;
- compliance operations.

These are Work Graph/Connector capabilities, not ad-hoc admin screens.

## Enterprise procurement

Enterprise adoption requires:
- security questionnaires;
- DPA/privacy terms;
- data residency;
- SSO/SCIM where needed;
- RBAC;
- audit export;
- retention controls;
- legal hold;
- procurement contracts;
- vendor risk evidence.

These should be represented in capability/tenant policy rather than discovered only at sales time.

## Deployment economics

The default deployment stack remains Vercel + Neon + R2 + Upstash or equivalent, but the system must support larger dedicated environments without changing domain contracts.

## Reliability

Network SLOs must distinguish:
- PaySwap-controlled components;
- connector/provider components;
- external rail finality.

A provider outage must not appear as PaySwap failure when PaySwap itself remains healthy.

## Observability

Every trace/metric/log carries canonical correlation:
- tenant;
- Work Graph object;
- EconomicProgram/Intent;
- connector;
- capability;
- agent;
- protocol command;
- settlement attempt;
- evidence.

Sensitive payloads are excluded by default.

# Frontend, UX/UI and Deployment Architecture

## Principle

Frontend and deployment architecture are designed concurrently with the protocol. They are not a final presentation layer.

Every major protocol capability must have:
- an information architecture location;
- a coherent user journey;
- an authoritative state mapping;
- error/UNKNOWN handling;
- approval interaction where needed;
- evidence/provenance disclosure;
- accessibility;
- responsive behavior;
- deployment/runtime ownership.

## UX north star

Stripe.com is the primary UX reference for information hierarchy, product discoverability, developer documentation, dashboard organization, pricing/operational clarity and polished financial-product interaction.

This is inspiration, not a visual copy.

The product should feel like a coherent financial/economic operating system rather than a collection of architecture demos.

## Required Stripe UX research

The first UX Work Order must conduct a Stripe product-surface survey using:
- public Stripe pages/docs;
- authenticated Stripe Dashboard surfaces where available.

When authentication is required, the worker must pause at the authentication boundary and have the authorized user authenticate through the browser session. Credentials must never be pasted into code, issues, logs or model prompts.

The survey must record:
- navigation/information architecture;
- onboarding;
- account/workspace model;
- dashboard patterns;
- checkout/payment flows;
- payment-method selection;
- subscriptions/billing;
- Connect/platform flows;
- disputes/refunds;
- analytics/reporting;
- developer experience;
- agentic-commerce surfaces;
- empty/loading/error states;
- mobile/responsive patterns;
- security/trust messaging.

Store findings in repository artifacts as screenshots/notes with source URLs and dates. Do not copy proprietary source code or private data.

## PaySwap information architecture

Initial top-level surfaces:
- Home/Overview;
- Activity;
- Goals;
- Payments;
- Collections;
- Payouts;
- Billing;
- Credit;
- Liquidity;
- Capabilities;
- Agents;
- Programs/Incentives;
- Opportunities;
- Disputes;
- Evidence;
- Developers;
- Settings.

Role-sensitive navigation may reveal merchant, LP, lender, borrower, developer, expert and network-operator workflows without creating separate products.

## Universal journey model

A user should be able to start from any of:
- “I need to pay X.”
- “I need this service.”
- “Help me reduce this cost.”
- “I need financing.”
- “I can provide liquidity.”
- “How can I earn from participating?”
- “Connect my existing PSP.”

The UI resolves the request into goals/intents/capabilities and shows the resulting strategy, required approvals, economic terms and expected evidence.

## State rendering

UI state must be a one-to-one projection of authority state.

Never infer:
- success from disappearance of a loading spinner;
- failure from unreachable network;
- finality from screenshots alone;
- payment completion from an optimistic local mutation.

## Agent UX

Agents should be visible as collaborators:
- what the agent proposes;
- which capabilities it is using;
- what authority it has;
- what it can spend;
- which action requires approval;
- what evidence was produced.

The user should not have to understand internal Agent Organizations.

## Wallet UX

For smart-contract services, the UX should feel like ordinary account activity:
- authenticate with passkey/device;
- approve a policy once;
- let the User Agent operate inside limits;
- abstract gas when supported;
- show human-readable transaction summaries;
- expose recovery controls;
- explain onchain/network dependencies only when relevant.

## Deployment topology from day one

Default free/low-cost bias:
- Vercel for web/API where suitable;
- Neon/Postgres for authoritative persistence;
- Cloudflare R2 for large evidence/artifacts;
- Upstash Redis/queues where suitable;
- Vercel Cron/Queues or equivalent for scheduled/asynchronous work when appropriate;
- object storage/CDN for immutable evidence artifacts;
- provider-neutral observability.

Do not make the architecture dependent on any single vendor.

## Environments

Maintain:
- local;
- preview;
- staging;
- production.

Environment differences are explicit and checked.

Financial production requires real provider credentials and real adapter paths. Preview/demo must never silently substitute fake financial state.

## Deployment gates

Every release checks:
- schema migration compatibility;
- environment-variable completeness;
- secret exposure;
- provider capability configuration;
- database connectivity;
- queue/outbox health;
- browser journeys;
- API conformance;
- architecture/invariant suite;
- observability;
- rollback.

## Cost posture

Free tiers are preferred for development and early production where they satisfy:
- reliability;
- security;
- data residency;
- throughput;
- retention;
- contractual requirements.

A paid dependency must have an explicit capability reason.

## Browser verification

Major journeys use agent-browser.

Every UI Work Order includes:
- desktop verification;
- responsive/mobile verification;
- console-error check;
- key interaction verification;
- screenshot artifact;
- evidence of real API/protocol wiring.

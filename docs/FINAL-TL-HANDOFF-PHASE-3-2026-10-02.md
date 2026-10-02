# Final TL Handoff — PaySwap.org Phase 3

Revision: 1
Date: 2026-10-02
Repository: payswapdotorg/payswap.org
Frozen protocol architecture: 1.5-frozen-2026-09-30
Phase 2 status: COMPLETE / historical provider-rollout evidence preserved
Phase 3: PUBLIC PRODUCT SURFACE + FREE/LOW-COST DEPLOYMENT + UX

## Executive finding

The Phase 2 repository is a real protocol/provider system and the production runtime is publicly deployed, but the current public Vercel surface is primarily the runtime/API host rather than a finished end-user application.

The current repository's `@payswap/ux` package is a deterministic UX contract/view-model layer with NO DOM, NO network and NO rendering. The root workspace is package-oriented and has no user-facing Next.js application. Therefore this phase must build the actual product interface rather than treating the Phase 2 UX contracts as a finished UI.

## Mission

Turn the certified PaySwap protocol into a user-friendly public product without changing the frozen financial architecture.

The result must feel like a coherent economic operating system:
- approachable to a non-technical merchant/supplier/user;
- visually polished;
- fast and responsive;
- trustworthy;
- understandable without exposing internal architecture;
- inspired by the user-supplied `https://you-platform.vercel.app` reference;
- fully wired to the real PaySwap API/protocol;
- non-custodial;
- honest about unavailable providers/capabilities;
- free/low-cost biased.

Do not replace the existing protocol, connector, authorization or financial state model to make the UI easier to build.

## Deployment finding

Current public deployment evidence:
- Vercel project `payswap`;
- public aliases include `payswap-mu.vercel.app` and `payswap-tepa.vercel.app`;
- the current production deployment is a Vercel Lambda/API-oriented runtime host;
- the public root currently responds with PaySwap API validation rather than a polished product homepage;
- the runtime activation record binds Vercel + Neon PostgreSQL + Upstash Redis + Cloudflare R2.

Cost posture:
- Upstash is explicitly recorded as a free-tier single database;
- Vercel, Neon and Cloudflare R2 are active infrastructure bindings, but the repository does not establish that every one of those accounts is currently on its free plan;
- Apify and Resend are not active infrastructure bindings in the current runtime activation record;
- do not add paid services merely to complete the UI.

Phase 3 must produce a user-facing public web deployment while preserving the existing API/runtime deployment as the backend surface.

## Canonical product topology

Separate concerns without creating a second source of truth:

PUBLIC WEB APP
→ PaySwap API
→ Financial Protocol / Authorization / Capability / Provider Connector Runtime
→ external providers/rails

The web app is a consumer of authoritative PaySwap APIs and view models. It must never maintain a parallel financial ledger or make local financial truth.

Suggested Vercel deployment surfaces:
1. `payswap-web` — actual public product UI;
2. existing runtime/API host — backend/API/worker-facing surface.

The exact deployment names may differ, but the separation between product UI and protocol/API runtime must remain explicit.

## UX reference and visual direction

Primary supplied visual reference:
`https://you-platform.vercel.app`

The TL must use agent-browser/browser inspection to reverse-engineer observable UX patterns from the accessible reference:
- information hierarchy;
- navigation;
- search/command interaction;
- typography scale;
- density;
- cards and panels;
- contextual sidebars;
- motion;
- responsive behavior;
- empty/loading/error states;
- keyboard interaction;
- accessibility;
- progressive disclosure.

Do not copy proprietary source code, hidden data, private assets or implementation details. Reproduce the interaction principles and visual language using PaySwap's own implementation.

The existing architecture doc names Stripe.com as the historical UX hierarchy reference. The user-supplied You-platform reference is now the primary visual/interaction reference for this phase. These references do not override PaySwap's domain truth.

## Product experience

The initial public product should expose:

### Public
- product home;
- clear explanation through actual workflows, not architecture diagrams;
- capabilities overview;
- provider/rail coverage explorer;
- security/non-custody explanation;
- developer entry point;
- sign-in / connect account;
- clearly marked demo/sandbox experiences where present.

### Authenticated Command Center
- Overview;
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
- Opportunities;
- Programs/Incentives;
- Disputes;
- Evidence;
- Developers;
- Settings.

Role-sensitive navigation can adapt for merchant, supplier, LP, lender, borrower, developer, expert and network operator without creating separate products.

## Required first-class user journeys

The UI must make these real workflows easy:

1. Connect an existing provider/rail.
2. See exactly what the connected account can currently do.
3. Pay a recipient.
4. Receive/collect money where the connected capability permits.
5. Request a payout to an explicit external destination.
6. Track an in-flight/UNKNOWN payment and see reconciliation state.
7. Resolve provider-required customer action.
8. Re-authenticate an expired provider/browser session.
9. Inspect evidence for an external financial action.
10. Compare available routes/providers without implying that a catalogue entry is executable.
11. See why a route is unavailable.
12. Manage agent permissions and approvals.
13. See provider balances only as external observations, never as PaySwap custody.

## Local-rail browser connection UX

This must be a polished first-class flow.

Connection:
User
→ Connect local rail
→ provider-hosted login in isolated browser
→ user enters credentials/MFA directly
→ session/authorization is sealed by secure browser/credential subsystem
→ PaySwap displays connected capability and scope.

The UI must never ask the user to paste provider passwords/API keys into PaySwap chat or an LLM message.

Later execution:
existing authorization/session
→ connector runtime
→ external rail.

Reauthentication:
expired/step-up
→ explicit customer-action state
→ trusted browser surface
→ fresh authorization evidence
→ new attempt/evidence lineage as required.

## Hard UX/security constraints

- No raw provider credential in model context.
- No browser cookies/storage/MFA material in model context.
- No secret-bearing values in screenshots/artifacts/logs.
- No optimistic success state for financial effects.
- UNKNOWN is rendered as UNKNOWN/in progress/reconciliation, never as failure.
- Provider catalogue does not create a connected capability.
- Provider-reported balances are external observations.
- Connection does not imply blanket debit/withdrawal authority.
- No UI action can bypass the Financial Protocol Authority.
- Demo/simulation cannot silently cross into production financial execution.

## Free/low-cost infrastructure plan

Use the already-bound infrastructure first:
- Vercel — public web deployment and suitable API/edge functions;
- Neon PostgreSQL — authoritative relational state;
- Upstash Redis — queues/cache/ephemeral coordination within measured free-tier limits;
- Cloudflare R2 — evidence/artifact/object storage.

Optional integrations:
- Resend — transactional email only when an actual workflow needs email;
- Apify — research/web extraction only where a real capability gap requires it;
- other providers only with explicit capability and cost justification.

Every new service must have:
- capability reason;
- free/low-cost option considered;
- quota/rate limit;
- failure behavior;
- deletion/retention policy;
- environment separation;
- no unnecessary paid plan dependency.

## Deployment requirements

Create a real user-facing Vercel deployment from the repository.

Required:
- production custom/public URL;
- preview deployments;
- production/preview environment separation;
- Neon production/preview branches;
- existing R2 evidence buckets;
- existing Upstash namespace discipline;
- secret values only in encrypted platform/vault configuration;
- health/readiness endpoint;
- error monitoring through existing observability;
- rollback path;
- deployment manifest/release record;
- reproducible deployment procedure.

Do not replace the existing API/runtime deployment. Add the UI surface and wire it to the existing backend.

## Browser verification

Use agent-browser for every major journey.

Before declaring the UI complete:
- test desktop;
- test mobile/responsive viewport;
- test keyboard navigation;
- check console errors;
- verify real API requests;
- verify auth flow;
- verify provider connection states;
- verify customer-action and UNKNOWN states;
- verify empty/error/loading states;
- capture screenshots;
- test deep links/refreshes;
- verify no dead buttons;
- verify no fake success.

The TL must personally inspect representative browser screenshots and interaction traces rather than trusting worker summaries.

## Work order orchestration

Maximum 3 concurrent workers. All active Work Orders must be pairwise disjoint.

Wave 1:
- P3-W1-001 Public web/deployment foundation;
- P3-W2-001 UX system and design reference extraction;
- P3-W3-001 Product information architecture and user-journey contracts.

Wave 2:
- P3-W1-002 Authentication/onboarding/connection UX;
- P3-W2-002 Command Center implementation;
- P3-W3-002 Payment/provider/local-rail journeys.

Wave 3:
- P3-W1-003 Infrastructure hardening/free-tier cost controls;
- P3-W2-003 Responsive/accessibility/visual verification;
- P3-W3-003 End-to-end production UI certification and release.

## Acceptance gates

A Work Order is not complete because components render in isolation.

The TL requires:
- repository source inspected;
- actual changed files verified;
- exact tests/commands recorded;
- real API/protocol wiring demonstrated;
- browser journey exercised;
- screenshot evidence;
- console clean;
- responsive behavior;
- no secret exposure;
- no fake financial state;
- no parallel ledger/view-model authority;
- deployment verified from the resulting commit.

## Phase 3 exit criteria

Phase 3 is complete only when:

1. a public user-facing web application is deployed on Vercel;
2. the public landing/product experience works without exposing API validation as the primary root page;
3. the visual/interaction system is demonstrably derived from the supplied You-platform reference and PaySwap's own product needs;
4. authenticated Command Center workflows are functional;
5. major payment/provider/local-rail journeys use the real API/protocol paths;
6. account connection and authorization modes are represented correctly;
7. browser-auth local rails work with isolated session handling where applicable;
8. no raw credential reaches the model/context or ordinary artifacts;
9. mobile/responsive and accessibility checks pass;
10. no dead buttons or fake success states remain;
11. Vercel + Neon + R2 + Upstash operate within measured free/low-cost bounds;
12. Resend/Apify are added only when justified by actual workflows;
13. production/preview parity and rollback are verified;
14. the public app is backed by the existing protocol/connector source of truth;
15. the release record is reproducible and names the exact UI/runtime deployment versions.

## Source-of-truth rule

The repository remains the sole implementation authority.

Phase 1 and Phase 2 historical records are immutable.

PaySwap protocol contracts remain authoritative for financial state.

The UI is a projection and interaction surface, never a new financial authority.

Provider dashboards remain authoritative for external provider account configuration.

User/browser sessions remain inside their approved secure authentication boundary.

No design decision in this phase may silently weaken the frozen non-custodial, authorization, evidence, reconciliation or provider-state laws.

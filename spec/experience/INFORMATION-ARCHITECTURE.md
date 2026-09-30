# Information Architecture — First Pass

Status: Draft (W3-001) — 2026-09-30

## 1. Purpose & sources

This document defines the first-pass information architecture (IA) for PaySwap
experience surfaces: the top-level areas, the URL space, the object hierarchy
and the authoritative-state ownership of each surface. Journey maps
(`JOURNEY-MAP.md`), design-system foundations (`DESIGN-SYSTEM-FOUNDATIONS.md`)
and the protocol-state → UI-state mapping (`FRONTEND-STATE-MAPPING.md`) build
on this document.

Sources (authoritative):
- `spec/architecture/FROZEN-ARCHITECTURE.md` — §2 (system planes A–J), §2A
  (Universal Connector Model), §2B (Work Interface Principle), §2D (Payment
  Control Loop), §21A (frontend and deployment architecture), §22 (terminal
  states), §24 (typed protocol tokens).
- `spec/architecture/FRONTEND-UX-DEPLOYMENT.md` — "PaySwap information
  architecture" (top-level surfaces list), "Universal journey model",
  "State rendering", "Agent UX".
- `spec/architecture/INVARIANTS.md` — INV-C05, INV-C09, INV-X01.
- `spec/work-items/W3-001.md` — acceptance requires "the repository contains
  a first-pass PaySwap information architecture and journey map".

## 2. IA principles

1. **The Work Graph is the main interface.** Per §2B the main interface is the
   Work Graph/Command Center, not the financial ledger. Professionals search,
   ask, coordinate, approve and execute work across connected systems; money
   movement is reached through work context as well as directly.
2. **UI state derives from protocol state.** UI state must be a one-to-one
   projection of authority state ("State rendering"); see
   `FRONTEND-STATE-MAPPING.md`. UNKNOWN renders as `reconciling`, never
   `failed` (INV-X01).
3. **Non-custodial framing.** Treasury/position surfaces render protocol
   projections and external observations only. An
   ExternalFundsPositionObservation is never presented as PaySwap custody or a
   PaySwap-held customer balance (§8A; INV-C09).
4. **External systems remain systems of record.** The Work Graph links
   external records; it never claims to replace the systems that own them
   (§2B).
5. **Role-sensitive navigation, one product.** Navigation may reveal merchant,
   LP, lender, borrower, developer, expert and network-operator workflows
   without creating separate products ("PaySwap information architecture").
6. **Every capability has a discoverable home.** Each major capability needs
   an IA location, authoritative state mapping and UNKNOWN behavior before
   backend completion is declared (§21A).

## 3. Top-level areas

| Area | Planes (§2) | Role |
|---|---|---|
| **Work Graph (Command Center) — MAIN** | C + H | Universal work/project context: search, ask, coordinate, approve, execute (§2B); links economic intents, obligations, payments, evidence |
| Payments | D | Payment methods, acceptance policies, attempts/fallbacks, refunds, off-network records; §2D control loop |
| Treasuries & Positions | H + G | Net positions, liquidity, credit projections; ExternalFundsPositionObservation rendered non-custodially (INV-C09) |
| Agents & Organizations | F | Agent Body/Instance/Package, Organizations, delegation, agent-native wallet capabilities |
| Capabilities & Connectors | G | Capability Graph and the §2A hierarchy: CapabilityDefinition → ProviderImplementation → ConnectedCapabilityInstance → CapabilityObservation |
| Developers | A | API keys, webhooks, logs, docs, SDKs, API versioning |
| Participation | I | Participation goals, experiments, incentive programs, reputation attestations |
| Security & Trust | B + cross-cutting | Identity, mandates, approvals, credentials, security epoch (§17), evidence/provenance |
| Settings & Teams | B + cross-cutting | Workspace, members, roles, configuration epochs, notification routing |

## 4. Secondary surfaces grouped under top-level areas

The top-level surfaces list in `FRONTEND-UX-DEPLOYMENT.md` maps onto the nine
areas above (Home/Overview is the Work Graph landing view):

| Secondary surface | Grouped under | Notes |
|---|---|---|
| Home/Overview | Work Graph | Command-center landing: approvals pending, work needing attention, live protocol states |
| Activity | Work Graph | Timeline of work objects and linked protocol events (plane C context; §3A coherence loop) |
| Goals | Work Graph | EconomicGoal objects (§1) compiled into Work/Economic Programs |
| Opportunities | Work Graph | FinancialOpportunity objects are advisory until compiled into an authorized program/intent (§23) |
| Collections | Payments | Receivables, recurring payments, remittance/document allocation (plane D) |
| Payouts | Payments | Merchant settlement destinations (plane D) |
| Billing | Payments | Subscriptions/billing; maps to provider Billing sub-packs (§2A) |
| Credit | Treasuries & Positions | Explicit CreditExposure — delay is not hidden credit (§9) |
| Liquidity | Treasuries & Positions | Liquidity control loop projections (§3) |
| Programs/Incentives | Participation | IncentiveProgram versions, reward accruals (plane I) |
| Disputes | Payments | Recourse lifecycle; new records never rewrite the original transaction (§15) |
| Evidence | Security & Trust | Cross-cutting evidence/provenance disclosure (§16) |

## 5. URL-space sketch

| URL | Surface | Authoritative state source | Notes |
|---|---|---|---|
| `/work` | Work Graph command center | Plane C work objects (linked to H) | Main interface (§2B); universal search/command bar |
| `/payments` | Payments list | Plane D attempts; H finality | Terminal-state badges per `FRONTEND-STATE-MAPPING.md` |
| `/payments/{id}` | Payment detail | Plane H protocol records + D translation | ProviderStateEnvelope disclosure; evidence links |
| `/treasuries` | Treasury overview | Plane H projections | Non-custodial framing (§8A) |
| `/positions` | External funds positions | G: ExternalFundsPositionObservation | Freshness + provenance always shown (INV-C09) |
| `/agents` | Agent instances | Plane F | Agent-as-collaborator visibility ("Agent UX") |
| `/organizations` | Agent Organizations | Plane F | Released versions immutable (INV-G02) |
| `/capabilities` | Capability catalogue | Plane G CapabilityDefinition graph | Catalogue is never execution authority (INV-C05) |
| `/connectors` | Connected capability instances | Plane G ConnectedCapabilityInstance + CapabilityObservation | Execution modes per §2A (INV-C07) |
| `/developers` | Developer home | Plane A | API versioning (`X-PaySwap-API-Version`), docs |
| `/developers/api-keys` | API key management | Plane A / B credentials | Key material shown once at creation |
| `/developers/webhooks` | Webhook endpoints + deliveries | Plane A | Signature/replay-window guidance |
| `/developers/logs` | API request log | Plane A projections | requestId correlation |
| `/participation` | Programs, incentives, reputation | Plane I | Leaderboards are projections, not trust (INV-P05) |
| `/security` | Mandates, approvals, epoch, advisories | Plane B (+ §17) | Security & Trust area |
| `/settings` | Workspace settings | Cross-cutting configuration epochs | |
| `/settings/teams` | Members, roles, teams | Plane B | Delegation/attenuation (INV-A01) |

## 6. Object hierarchy

```
Organization (plane F / workspace)
└── tenant / connected provider account
    └── ConnectedCapabilityInstance(s)            (§2A; INV-C05)
        └── domain objects
            ├── payments, payment attempts, refunds
            ├── proposals (agent), mandates, approvals
            └── disputes, evidence artifacts
```

- The Financial Protocol (plane H) owns truth for every financial domain
  object; all other planes project (§8; "State rendering").
- ConnectedCapabilityInstance is scoped to a real provider account/tenant,
  authorization, geography/currency and permission state (INV-C05); the
  provider catalogue entry above it is descriptive, never execution
  authority.
- Domain objects reference typed protocol tokens (§24) — a token is a typed
  reference to authoritative protocol state or an immutable content-addressed
  artifact; tokens are not money.

## 7. Authoritative-state mapping per surface

| Surface | Authoritative owner | Projections shown | UNKNOWN rule |
|---|---|---|---|
| `/work` | Plane C (work objects) | Linked H protocol states, F agent activity | Linked payment UNKNOWN → `reconciling` chip, never red (INV-X01) |
| `/payments`, `/payments/{id}` | Plane H (protocol records) | D translation chain, G envelope state | UNKNOWN → `reconciling`; reconciliation owns resolution (INV-X03) |
| `/treasuries` | Plane H projections | Net positions, reservations | Projections labeled as such (§8) |
| `/positions` | External provider (via G observation) | Freshness/provenance metadata | Stale/unverifiable observation cannot create a false balance (INV-C09) |
| `/agents`, `/organizations` | Plane F | Evaluation status, budget usage | Proposal ≠ execution (INV-G03) |
| `/capabilities` | Plane G (CapabilityDefinition) | Certification status | Catalogue claim never implies entitlement (INV-C05) |
| `/connectors` | G: ConnectedCapabilityInstance | CapabilityObservation (availability/health) | Unreachable source = availability unknown, not failure (INV-C02) |
| `/developers/*` | Plane A boundary contracts | Request logs, webhook deliveries | EXTERNAL_AMBIGUITY surfaced as outcome-unknown, not error |
| `/participation` | Plane I | Reward accruals → H obligations | Monetary rewards are protocol obligations |
| `/security` | Plane B | Epoch, advisories (§17) | Quarantine state always visible (INV-S03) |

## 8. Open questions / next steps

1. Naming: "Treasuries & Positions" vs separating "Balances" — must never
   imply custody either way (INV-C09); decide after the Stripe UX survey
   (`spec/research/STRIPE-UX-SURVEY-2026-09-30.md`, in progress).
2. Whether Opportunities deserve a first-class URL (`/opportunities`) once
   the Opportunity Engine (§23) has surfaced-surface requirements.
3. Mobile navigation: bottom-bar subset of the nine areas vs full menu; to be
   resolved with responsive rules in `DESIGN-SYSTEM-FOUNDATIONS.md`.
4. URL versioning strategy for developer docs relative to the explicit
   external API versioning header (`X-PaySwap-API-Version`).
5. Cross-area deep links from approvals (plane B) into the exact Work Graph
   node and payment detail; requires stable typed token references (§24).

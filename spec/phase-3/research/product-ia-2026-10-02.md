# Product Information Architecture — Phase 3 Wave 1 (P3-W3-001)

Date: 2026-10-02
Status: COMPLETE (battery 254/254, typecheck clean)
Implementation: `packages/ux/src/product-ia.ts`, `packages/ux/src/product-journeys.ts`
Tests: `packages/ux/test/product-ia.test.ts` (32), `packages/ux/test/product-journeys.test.ts` (222)

This artifact documents the product IA and the seven journey contracts that
Wave 2 UIs bind to. It consumes the existing `@payswap/ux` contract layer
(`command-center.ts`, `journeys.ts`, `honest-states.ts`,
`trusted-approvals.ts`, `incumbent-views.ts`) — never duplicating it.

## 1. Surface map (public vs authenticated)

| Surface | Route | Access | Honest-state contract |
|---|---|---|---|
| Product home | `/` | public | static truth: journeys + coverage summary from recorded evidence |
| Capabilities/coverage explorer | `/capabilities` | public | probe/rollout records; VERIFIED/BLOCKED/not-connected distinct |
| Security & non-custody | `/security` | public | static doctrine |
| Developers | `/developers` | public | API authority; unconfigured state honest |
| Demo/sandbox (where present) | `/demo` | public, marked | clearly marked, never silently production |
| Command Center | `/app/*` | authenticated | `AuthRequiredState` when session absent — never fake data |

## 2. Navigation model (grouped Command Center)

- **OVERVIEW**: Overview, Activity
- **MONEY MOVEMENT**: Payments, Collections, Payouts, Billing, Credit, Liquidity
- **CAPABILITIES**: Capabilities, Agents, Opportunities, Programs/Incentives
- **TRUST**: Disputes, Evidence
- **DEVELOP**: Developers
- **ACCOUNT**: Settings

Every nav item carries a data-declared capability/authorization requirement
(`ProductNavItem.requiredCapability`), derived at render time — navigation is
never hardcoded booleans.

## 3. Role-sensitive navigation (same product, derived views)

`deriveNavigationForRole(nav, role)` filters/annotates the SAME navigation
for: merchant, supplier, LP, lender, borrower, developer, expert,
network-operator. Tested for all eight roles (visibility, enabled-ness,
requires-attention). No separate products per role.

## 4. The seven journey contracts (state diagrams, text form)

### ConnectProvider
`IDLE → BROWSING_CATALOGUE → PROVIDER_SELECTED → INITIATING_CONNECTION → AWAITING_AUTHORIZATION → CONNECTED / (EXPIRED | REVOKED)`
- catalogue options are DERIVED (`deriveCatalogueOptions`) — catalogue ≠ authority;
- connection outcomes fold only from authority records (`applyConnectionAuthorizationOutcome`);
- opaque `BrowserSessionRef`/`ConnectedCapabilityInstanceId` only — credentials never appear.

### Pay
`IDLE → CAPABILITY_SELECTED → REVIEWING → AWAITING_APPROVAL → SUBMITTED → (PENDING | IN_FLIGHT | OUTCOME_UNKNOWN | SUCCEEDED | FAILED)`
- capability selected only from connected instances;
- UNKNOWN maps through the SAME `mapTerminalStateToUi` (INV-X01);
- submission is a validated RequestEnvelope with fresh idempotency key (INV-F05).

### Collect
`NOT_CREATED → CREATED → SHARED → (PENDING | FULFILLED | …)`
- honest empty state when no connected capability permits collection;
- share refs are opaque; fulfillment folds verbatim.

### Payout
`IDLE → SELECTING_DESTINATION → DESTINATION_SPECIFIED → CONFIRMING_WITHDRAWAL_SCOPE → SCOPE_CONFIRMED → AWAITING_APPROVAL → SUBMITTED → …`
- explicit destination required before ANY submission (fail-closed);
- withdrawal scope is single-use and bound to the destination (connection ≠ blanket withdrawal);
- balances are external observations.

### Reconcile (payment outcome)
`AMBIGUITY_RECORDED → AWAITING_OBSERVATION → (RESOLVED_SUCCEEDED | RESOLVED_FAILED | STILL_UNKNOWN)`
- ambiguity-first lifecycle: the ambiguity must be RECORDED (with evidence, INV-E02) before observation;
- STILL_UNKNOWN is honest and terminal-safe.

### Evidence
`LISTING → INSPECTING_ARTIFACT → LISTING`
- provenance strength consumed from `incumbent-views` (INV-E04), strongest-first;
- read-only journey (no API_COMMAND actions);
- empty list is honest (no dead buttons).

### Reauth
`AUTHORIZATION_EXPIRED → CUSTOMER_ACTION_REQUIRED → REAUTHORIZING_ON_TRUSTED_SURFACE → FRESH_AUTHORIZATION_RECORDED → EXECUTION_RESUMED`
- trigger carried verbatim (EXPIRED vs STEP_UP_REQUIRED) with honest guidance;
- the fresh authorization CONSUMES the customer-action approval (the resume
  envelope never carries a stale artifact — live 403 found by execution);
- a resume needing its own approval parks and re-dispatches with the artifact;
- lineage (intent/attempt/command/amount) preserved verbatim at every step.

## 5. Consumption map

- terminal-state mapping: `mapTerminalStateToUi` (@payswap/interfaces) — consumed, never re-defined;
- approvals: `trusted-approvals.ts` (INV-A03) — same completion channel;
- provenance order: `incumbent-views.ts` (INV-E04);
- mutations: RequestEnvelope through the injected @payswap/api handler (INV-F05);
- honest UNKNOWN: `honest-states.ts` semantics (INV-X01).

## 6. Wave-2 binding points

- `JOURNEY_NAV_BINDINGS` — each journey's nav-item binding (consumed from `product-ia.ts`, tested);
- `PRODUCT_JOURNEY_STATES` — the declared state table (states + terminal flags) the UI renders against;
- `productJourneyStateHasLiveActions` — no-dead-buttons derivation for every driven state;
- `productJourneyMutationEnvelope` — the exact envelope every UI submit must produce;
- `dispatchProductJourneyAction` — the single dispatch channel for all journey mutations.

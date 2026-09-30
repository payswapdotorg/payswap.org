# Journey Map — First Pass

Status: Draft (W3-001) — 2026-09-30

## 1. Purpose and the state-coverage rule

This document maps the four canonical PaySwap journeys with explicit UI state
coverage, per `FRONTEND-UX-DEPLOYMENT.md` ("Principle": every capability
needs a coherent journey, authoritative state mapping, error/UNKNOWN handling)
and W3-001 acceptance ("frontend state mappings are defined before downstream
feature UI work").

**Mandatory rule:** every asynchronous step in every journey defines all of:
- **loading** — skeleton/spinner with bounded expectations;
- **error** — actionable, keyed to the REST error category;
- **empty** — guidance to the next best action;
- **UNKNOWN-reconciling** — outcome unknown renders as `reconciling`, never
  as `failed` (INV-X01); reconciliation is authoritative for ambiguous
  external effects (INV-X03).

Terminal-state vocabulary is §22: FULFILLED, WAITING, USER_ACTION_REQUIRED,
NO_VIABLE_ROUTE, COMPLIANCE_BLOCKED, EXPIRED, CANCELLED, FAILED, UNKNOWN.
UI states follow `FRONTEND-STATE-MAPPING.md`.

### 1.1 Universal entry points

Per "Universal journey model", a user may start from any of: "I need to pay
X", "I need this service", "Help me reduce this cost", "I need financing",
"I can provide liquidity", "How can I earn from participating?", "Connect my
existing PSP". The UI resolves the request into goals/intents/capabilities and
shows the resulting strategy, required approvals, economic terms and expected
evidence. The four journeys below anchor those entry points:

| Entry point | Journey |
|---|---|
| "Connect my existing PSP" / "I need to pay X" | J1 (merchant onboarding → connector → first payment) |
| Developer/API integration of any of the above | J2 (developer: keys, idempotent mutations, webhooks) |
| Delegated execution of any of the above | J3 (mandate → proposal → approval → execution) |
| Post-completion recourse | J4 (dispute/refund) |

## 2. J1 — Merchant onboarding → connector setup → first payment

| Stage | Actor | Surface | Protocol/terminal states possible | UI states (loading/error/empty/reconciling) | Exit criteria |
|---|---|---|---|---|---|
| 1. Sign up | Merchant | `/signup` | none (identity) | loading: submit pending; error: VALIDATION (400) field errors, RATE_LIMITED (429) | Organization + workspace created (plane B identity) |
| 2. First run | Merchant | `/work` | none | empty: "Connect your existing PSP or create a payment" guidance | User starts connector setup or payment |
| 3. Browse provider catalogue | Merchant | `/capabilities`, `/connectors` | none (catalogue only) | loading: skeleton list; empty: no providers match filter; error: INTERNAL (500) with retry | Provider selected; catalogue is never execution authority (INV-C05) |
| 4. Connect flow (credential/OAuth) | Merchant + provider | `/connectors/{id}/connect` | SUBMITTED, VALIDATING (instance) | loading: handshake; error: AUTHORIZATION (403) re-scope prompt, EXTERNAL_AMBIGUITY (409 + `X-PaySwap-Outcome: unknown`) shown as reconciling | ConnectedCapabilityInstance created with authorization/permission state (INV-C05) |
| 5. Instance eligibility check | Merchant | `/connectors/{id}` | CapabilityObservation: available/unknown | loading: observation fetch; reconciling: unknown reachability is not failure (INV-C02); empty: no capabilities in scope | Executable capabilities listed; disabled/entitlement-missing visibly not executable |
| 6. Create first payment | Merchant | `/payments/new` | DRAFT → SUBMITTED → VALIDATING → AUTHORIZING → EXECUTING | loading: submit (idempotency key required); error: VALIDATION (400), POLICY (422) with recorded reason; empty: no connected capability → connect guidance | Intent accepted into protocol |
| 7. USER_ACTION_REQUIRED branch (3DS/customer action) | Customer | action-required surface from payment detail | USER_ACTION_REQUIRED | action-required: explicit card with the provider action surfaced verbatim from ProviderStateEnvelope (INV-C06); loading while awaiting customer; never a generic error | Customer completes action, or EXPIRED |
| 8. UNKNOWN branch (provider timeout) | Protocol + reconciliation worker | `/payments/{id}` | UNKNOWN | reconciling: "Outcome unknown — reconciling", neutral styling, never red (INV-X01); no blind retry (INV-X02) | Reconciliation record resolves to a terminal state (INV-X03) |
| 9. Terminal outcome | Merchant | `/payments/{id}` | FULFILLED (or FAILED/NO_VIABLE_ROUTE/…) | fulfilled: confirmation + evidence links (ExecutionProof, SettlementCertificate, §16) | Evidence viewable; journey complete |

## 3. J2 — Developer: API key → first idempotent mutation → webhooks

| Stage | Actor | Surface | Protocol/terminal states possible | UI states (loading/error/empty/reconciling) | Exit criteria |
|---|---|---|---|---|---|
| 1. Create API key | Developer | `/developers/api-keys` | none | loading: key generation; error: VALIDATION (400) scope errors; empty: first-key guidance + one-time-display warning | Key created; secret shown once |
| 2. First idempotent mutation | Developer | API client → `POST` with idempotency key | SUBMITTED → intermediate chain | loading: request in flight; error: VALIDATION (400) incl. missing idempotency key, POLICY (422) | 2xx envelope `{ data, meta: { schemaVersion, requestId, idempotentReplay? } }` |
| 3. Replay the same key | Developer | API client | same authoritative result as first call | `idempotentReplay` presented as "already processed" outcome, not an error (INV-F05: one idempotency key maps to one authoritative command result) | Replay result rendered deterministically |
| 4. Register webhook endpoint | Developer | `/developers/webhooks` | none | loading: validation; error: VALIDATION (400) bad URL; empty: no deliveries yet | Endpoint registered; secret material handled per §21 vault rules |
| 5. Receive + verify webhook | Developer system | consumer of `{ id, type, occurredAt, schemaVersion, data }` | n/a (event transport) | error: signature mismatch on `X-PaySwap-Signature` (v1 = hex HMAC-SHA256 over canonical JSON of the envelope joined with the timestamp) or `X-PaySwap-Timestamp` outside the 300-second replay window → event rejected with security guidance, never treated as a financial failure | Event accepted and correlated by id |
| 6. Ambiguous outcome handling | Developer | `/developers/logs`, `/payments/{id}` | EXTERNAL_AMBIGUITY → HTTP 409 + `X-PaySwap-Outcome: unknown` | reconciling presentation: outcome-unknown banner, not red error; link to reconciliation state | Reconciliation record resolves the authoritative outcome |

## 4. J3 — Principal: mandate → agent proposal → approval → execution

| Stage | Actor | Surface | Protocol/terminal states possible | UI states (loading/error/empty/reconciling) | Exit criteria |
|---|---|---|---|---|---|
| 1. Grant mandate | Principal | `/agents/{id}/mandates` | none (plane B) | loading: mandate save; error: POLICY (422) if beyond policy; empty: no agents yet | Mandate recorded with allowed actions, resources, rails, currencies, limits, expiry (§5); child delegation attenuated (INV-A01) |
| 2. Agent proposes | Agent | `/work` proposal card | proposal only | loading: proposal assembly; empty: no proposals; proposal is advisory — agent proposals do not mutate financial truth (INV-G03) | Proposal rendered with what it proposes, capabilities used, authority, spend |
| 3. Review proposal | Principal | `/work` | none | agent-visibility per "Agent UX": what the agent proposes, which capabilities it uses, what authority it has, what it can spend, which action requires approval, what evidence was produced | Principal decides to approve or reject |
| 4. Approve on trusted surface | Principal | trusted approval surface (web or messaging, §20) | none | loading: artifact signing; error: AUTHORIZATION (403) if security epoch expired/revoked (INV-A02); raw chat text is never authority (AGENTS.md rule 10) | Signed ApprovalArtifact created identifying principal, agent, scope, expiry and request hash (INV-A03) |
| 5. Execution | Protocol worker | `/payments/{id}` | AUTHORIZING → EXECUTING → terminal | loading: progress indication; reconciling: UNKNOWN branch (INV-X01); error: only protocol-authoritative failure | Terminal state reached |
| 6. Inspect evidence | Principal | payment detail / Evidence surface | terminal | evidence/provenance disclosure: ExecutionProof + SettlementCertificate (§16) | Evidence viewable with provenance; journey complete |

## 5. J4 — Dispute / refund

| Stage | Actor | Surface | Protocol/terminal states possible | UI states (loading/error/empty/reconciling) | Exit criteria |
|---|---|---|---|---|---|
| 1. Initiate dispute/refund | Principal or merchant | `/payments/{id}` | new Dispute/refund record | loading: submission (idempotent); error: POLICY (422) if RecoursePolicy (frozen at intent initiation, §15) disallows; empty: guidance | Dispute/refund record created |
| 2. Provider lifecycle sync | Protocol | `/disputes/{id}` | WAITING / USER_ACTION_REQUIRED / UNKNOWN | loading: provider state fetch; reconciling: UNKNOWN never red (INV-X01); provider dispute/refund lifecycle preserved verbatim in ProviderStateEnvelope — never lossy-mapped (INV-C06) | Canonical state + provider state both visible |
| 3. Submit evidence | Principal | `/disputes/{id}` | none (evidence) | loading: upload to object storage; error: VALIDATION (400) format/size; empty: evidence-requirements checklist from envelope | Evidence attached with provenance; historical evidence immutable (INV-E05) |
| 4. Resolution | Provider/protocol | `/disputes/{id}` | terminal (FULFILLED / FAILED / …) | resolved presentation with full timeline; resolution creates new records and never rewrites the original transaction (§15) | Resolution recorded; any adjustment is a new obligation |

## 6. Cross-journey state-coverage checklist

- [ ] Every async step defines a loading skeleton (no bare spinners).
- [ ] Every async step defines an error treatment keyed to REST error category
      (VALIDATION | CONFLICT | NOT_FOUND | AUTHORIZATION | POLICY |
      EXTERNAL_AMBIGUITY | RATE_LIMITED | INTERNAL) with a next action.
- [ ] Every list surface defines an empty state that points to the next best
      action (connect a PSP, create a payment, grant a mandate).
- [ ] Every UNKNOWN possibility renders `reconciling`, never `failed`
      (INV-X01), and never auto-retries the external write (INV-X02).
- [ ] Every USER_ACTION_REQUIRED renders an explicit action-required card with
      the provider action from ProviderStateEnvelope (INV-C06), never a
      generic error.
- [ ] Every terminal badge only changes via protocol-authoritative records;
      UI never downgrades a terminal badge except via an explicit
      reconciliation record (INV-X04).
- [ ] Approval steps produce signed artifacts (INV-A03); chat text alone is
      never shown as authority.
- [ ] Evidence views always disclose provenance (§16; INV-E04: UI/browser
      artifacts are not stronger than their authenticated provenance).

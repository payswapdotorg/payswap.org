# Frontend State Mapping — Protocol State → UI State

Status: Draft (W3-001) — 2026-09-30

## 1. Purpose

This document is the authoritative protocol-state → UI-state mapping for all
PaySwap surfaces. It **complements**
`packages/interfaces/src/protocol-state.ts` — the code is the source of truth;
if code and this document diverge, file an amendment rather than silently
re-mapping. Grounding: §22 (terminal states), §20 (runtime and external
protocols), `FRONTEND-UX-DEPLOYMENT.md` ("State rendering"),
`INVARIANTS.md` (INV-X01, INV-X02, INV-X03, INV-X04, INV-C06, INV-F05).

Rule of record ("State rendering"): **UI state must be a one-to-one projection
of authority state.** The UI never invents states, never merges two protocol
states into one visual state when their consequences differ, and never derives
finality from transport signals.

## 2. Terminal states → canonical UI states

| Terminal state (§22) | Canonical UI state | Presentation guidance |
|---|---|---|
| `FULFILLED` | `fulfilled` | Tone: confirmation. Copy: "Completed" + amount + evidence links (ExecutionProof / SettlementCertificate, §16). Actions: view receipt/evidence; dispute or refund only if the frozen RecoursePolicy (§15) permits. |
| `WAITING` | `reconciling` | Tone: neutral in-progress. Copy: "Reconciling — awaiting confirmation". Actions: refresh status, view provider envelope, contact support. Never styled as failure. |
| `USER_ACTION_REQUIRED` | `action-required` | Tone: attention, explicit. Copy: "Action required: <provider action rendered verbatim from ProviderStateEnvelope>" (e.g. 3DS/customer authentication). Actions: complete the action on the trusted surface, or cancel where allowed. Never a generic error. |
| `NO_VIABLE_ROUTE` | `no-viable-route` | Tone: blocked-but-constructive. Copy: "No viable route for this request" + why (acceptance, geography, currency, liquidity). Actions: adjust constraints, connect a capability, choose another method. |
| `COMPLIANCE_BLOCKED` | `compliance-blocked` | Tone: serious, policy-backed. Copy: "Blocked by compliance policy" with the recorded, policy/evidence-backed reason (INV-R04). Actions: view policy reason, contact compliance. Never retryable from the UI. |
| `EXPIRED` | `expired` | Tone: neutral muted. Copy: "Expired before completion" (deadline/timing window passed). Actions: re-issue as a new intent. |
| `CANCELLED` | `cancelled` | Tone: neutral muted. Copy: "Cancelled" + who/when from the authorization record. Actions: view history. |
| `FAILED` | `failed` | Tone: negative, terminal. Copy: "Failed" + reason from protocol evidence (not inferred). Actions: retry only as a **new** intent with a fresh idempotency key; investigate evidence. |
| `UNKNOWN` | `reconciling` | **NEVER `failed`** (INV-X01). Tone: neutral in-progress. Copy: "Outcome unknown — reconciling". Actions: wait/refresh, view reconciliation state. Rationale: absence of knowledge is not failure; reconciliation is authoritative for ambiguous external effects (INV-X03), and UNKNOWN external writes cannot be blindly retried (INV-X02). |

**INV-X01 rule (binding):** `UNKNOWN → reconciling`, never `failed`. §22:
"UNKNOWN always requires reconciliation."

## 3. Intermediate (non-terminal) states

Intermediate states render as progress contexts, never as terminal badges.

| Intermediate state | UI treatment | Progress indication | Transience / refresh policy |
|---|---|---|---|
| `DRAFT` | Editable intent form; no protocol claim yet | none | Local; validates client-side + server VALIDATION errors |
| `SUBMITTED` | Accepted, queued for validation | Indeterminate progress + position note | Auto-refresh on protocol events; idempotency key already bound |
| `VALIDATING` | Checking intent constraints, policy, acceptance | Stepped progress (constraints → policy) | Short-lived; auto-advance |
| `AUTHORIZING` | Mandate/credential authorization in progress | Stepped progress with authority summary | May pause for USER_ACTION_REQUIRED branch |
| `EXECUTING` | External rail effect underway | Bounded progress with rail/execution mode shown (INV-C07) | Auto-refresh; may transition to UNKNOWN→reconciling |
| `RECONCILING` | Ambiguity resolution underway (INV-X03) | Neutral "reconciling" banner, never error | Long-lived; refresh on reconciliation record only |
| `SETTLING` | Settlement window / netting in progress | Timeline of §8 hierarchy stages (clearing → obligation → netting → settlement) | Event-driven; finality requires policy-required proof (INV-E03) |

Intermediate states never render success/failure color; only §22 terminal
states produce terminal badges (via the section 2 mapping above).

## 4. Error-category presentation mapping

REST error model categories map deterministically to HTTP status and to UI
treatment:

| Category | HTTP | UI treatment |
|---|---|---|
| `VALIDATION` | 400 | Inline field errors; form stays editable; copy names the invalid input |
| `NOT_FOUND` | 404 | Empty-state page with guidance; offer search; never "payment failed" copy |
| `AUTHORIZATION` | 403 | Re-authenticate / missing-permission panel; lists required mandate scope |
| `POLICY` | 422 | Policy-decision panel with the recorded, versioned reason; no retry affordance |
| `CONFLICT` | 409 | State-conflict panel showing current authoritative state; link to the record |
| `EXTERNAL_AMBIGUITY` | 409 + `X-PaySwap-Outcome: unknown` | **Presented as reconciling/outcome-unknown, not a red error**; never a generic 500; links to reconciliation state (INV-X03) |
| `RATE_LIMITED` | 429 | Throttled panel with retry-after; queue-safe guidance |
| `INTERNAL` | 500 | Generic failure with retry + support path; no financial-state claims |

`POLICY` vs `AUTHORIZATION` distinction (must not be conflated):
AUTHORIZATION = the caller lacks delegated power (fix: authenticate or get
mandate scope); POLICY = the action itself is disallowed by versioned hard
constraints (fix: nothing user-side; appeal/contact path only).

All responses use the envelope `{ data, meta: { schemaVersion, requestId,
idempotentReplay? } }`; error bodies carry the category. External API
versioning is explicit via `X-PaySwap-API-Version`.

## 5. `idempotentReplay` presentation

When `meta.idempotentReplay` is present (replayed idempotency key), the UI
presents an **"already processed" outcome tied to the original authoritative
result** — the same data, the same terminal badge as the first execution.
It is never an error, never a warning about duplication, and never a second
execution. This is INV-F05 made visible: one idempotency key maps to one
authoritative command result. Developer surfaces (`/developers/logs`)
annotate the replayed request with its original `requestId`.

## 6. ProviderStateEnvelope surfacing rules (INV-C06)

Provider state required for customer action, reconciliation, support or audit
is preserved in ProviderStateEnvelope and is never lossy-mapped into a
canonical status. UI rules:

1. **Action surface:** when the envelope carries `actionRequired` (customer
   authentication required, capture required, mandate step, dispute evidence
   requirement, …), the action-required card renders the provider action
   verbatim, with provider name/version and external object ID/revision for
   support continuity.
2. **Canonical state controls the badge; the envelope enriches the detail
   view.** Canonical state determines protocol behavior; provider state
   remains visible in a provider-envelope drawer (never the reverse).
3. **Reconciliation context:** UNKNOWN/reconciling views show envelope
   observation timestamp, provenance and provider state history so operators
   can distinguish "provider says processing" from "we could not observe".
4. **Never collapse:** asynch-processing, capture, mandate, refund, dispute,
   payout and connected-account lifecycle states must not be flattened into
   generic CRUD outcomes in any UI summary (AGENTS.md rule 19).

## 7. Monotonic terminal transitions (INV-X04)

Terminal transitions are monotonic except explicit recovery states. UI rules:

- A terminal badge (`fulfilled`, `failed`, `cancelled`, …) is never
  downgraded or restyled by client-side logic, refetches, reconnects or
  optimistic updates.
- The **only** sanctioned change to an already-terminal record is an explicit
  reconciliation record (INV-X03) — e.g. a `reconciling` (UNKNOWN) that
  resolves to `fulfilled` or `failed`. The UI renders the resolution as an
  appended timeline event referencing the reconciliation record, not as an
  edit of history.
- Disputes/resolutions render as new records; the original transaction view
  remains immutable (§15; INV-E05).
- If two observations disagree (stale cache vs. fresh protocol record), the
  protocol record wins; the UI re-renders from authority state only.

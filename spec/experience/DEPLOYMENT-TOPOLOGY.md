# Deployment Topology and Configuration Contract

Status: Draft (W3-001) — 2026-09-30

## 1. Shape: modular monolith (§21)

PaySwap starts as a modular monolith with six deployable worker roles
(§21 Deployment topology). Extraction into separate services happens only
when measured needs justify it — "extract services only when measured needs
justify it" (§21). Every role below shares one codebase, one schema and one
protocol authority; they differ in process responsibility and egress rights.

| Service (worker role) | Responsibility | Owned queues / tables (illustrative) | Scaling note |
|---|---|---|---|
| web/API | Serves plane-A surfaces: dashboard, checkout, REST/HTTP boundary, webhooks egress, approval surfaces | read replicas; no queue ownership beyond request path | Scale on HTTP traffic; stateless; first candidate for managed hosting (e.g. Vercel per "Deployment topology from day one") |
| protocol worker | Executes Financial Protocol Authority commands: deterministic state machines, reservations, clearing/netting/settlement, outbox events | protocol command queue; protocol + outbox tables | Scale on command backlog; single-writer discipline per aggregate |
| rail adapter workers | One per provider/rail; translate canonical commands to provider APIs; produce ProviderStateEnvelope (INV-C06); never declare finality on their own | per-provider queues; adapter state tables | Scale per provider rate limits; isolate outages per provider |
| reconciliation worker | Owns ambiguity resolution: UNKNOWN outcomes, provider state comparison, resolution records (INV-X03) | reconciliation queue; reconciliation tables | Scale on ambiguity backlog; SLA-driven |
| Lab worker | Replay, scenarios, simulation, fault injection, strategy search (§19); simulation is never production truth (INV-L01) | Lab queues; sandbox schema | Best-effort scheduling; hard-isolated from production rails |
| notification worker | Webhook delivery with signatures and retry, email/messaging (trusted approval surface transport, §20) | notification/outbox delivery queues | Scale on delivery backlog; respects 300-second replay-window semantics for egress |

## 2. Environments

Maintained environments ("Environments"): **local / preview / staging /
production**.

- **Environment differences are explicit and checked** — a deploy-gate check
  (see section 6 below) compares the effective configuration against the
  declared environment contract; drift blocks deploy.
- **Financial production requires real provider credentials and real adapter
  paths.** No simulated rail adapter may be wired behind a production
  surface.
- **Preview/demo must never silently substitute fake financial state.** If a
  preview environment cannot reach real providers, surfaces must render
  explicit "not connected / no data" states — never fabricated balances or
  fake payment completion (W3-001 Forbidden: "No fake payment completion").
- Demo and production paths share one protocol pipeline (AGENTS.md rule 6);
  the Lab (plane J) is the only place simulation exists, and it is never
  callable as a production rail adapter (AGENTS.md rule 7).

## 3. Configuration contract

### 3.1 Environment variables

| Variable | Consumed by | Purpose |
|---|---|---|
| `DATABASE_URL` | all roles | PostgreSQL system-of-record connection |
| `OBJECT_STORAGE_ENDPOINT`, `OBJECT_STORAGE_BUCKET`, `OBJECT_STORAGE_REGION` | web/API, protocol, notification | Large/immutable evidence artifacts (e.g. R2-compatible object storage) |
| `OBJECT_STORAGE_ACCESS_KEY_ID` / `OBJECT_STORAGE_SECRET_ACCESS_KEY` (via `VAULT_REF`) | web/API, protocol | Storage credentials — vault-resolved, never committed |
| `VAULT_REF` (root) | all roles | Reference to the vault/secret-store mount holding all secrets |
| `PROVIDER_<NAME>_CREDENTIAL_REF` | rail adapter workers | Per-provider credential reference resolved from the vault at runtime (e.g. `PROVIDER_STRIPE_CREDENTIAL_REF`) |
| `WORKER_ROLE` | every worker process | Selects the role from section 1 within the monolith |
| `QUEUE_URL` / `REDIS_URL` | protocol, adapter, reconciliation, Lab, notification | Queue/bus connection for async work |
| `WEBHOOK_SIGNING_SECRET_REF` | notification worker | Resolves the key for `X-PaySwap-Signature` (v1) computation |
| `API_VERSION` | web/API | Value returned in `X-PaySwap-API-Version`; explicit external versioning |
| `OBSERVABILITY_ENDPOINT` | all roles | Vendor-neutral metrics/logs/traces sink |

### 3.2 Rules

1. Secrets are **vault/secret-store backed** and **never committed to the
   repo** (W3-001 acceptance: "no secret or private account data is
   committed"). Only `*_REF` names appear in configuration.
2. Env completeness is checked at the deploy gate; a missing variable for the
   declared environment blocks release (see section 6 below).
3. Local development uses the same variable names with local values (local
   Postgres, local object storage, local queue) so environment differences
   are explicit rather than emergent.
4. Provider capability configuration (which ConnectedCapabilityInstances are
   enabled, their scopes per INV-C05) is data in the system of record, not
   environment variables.

## 4. Data stores

- **PostgreSQL = system-of-record** (§21): protocol truth — obligations,
  reservations, clearing/netting/settlement records, terminal states,
  reconciliation records, outbox. Append-only ledger discipline; balances are
  projections (INV-F02); committed financial mutations cannot silently lose
  their outbox event (INV-O02).
- **Object storage** holds large evidence artifacts (immutable, content
  addressed; retention per policy) — not financial truth.
- **Observability posture:** vendor-neutral sink; every terminal-state
  transition, UNKNOWN outcome and reconciliation resolution is observable;
  request correlation via `requestId` from the response envelope
  (`{ data, meta: { schemaVersion, requestId, idempotentReplay? } }`).
- **Queues** carry async work between roles; async commands are retry-safe
  (INV-O01).

## 5. Egress and boundaries

- **Only rail adapter workers** talk to external payment providers, each
  through its adapter, each execution carrying an explicit execution mode —
  PASS_THROUGH_NATIVE | COMPOSED_PAYSWAP | OPTIMIZED_MULTI_PROVIDER (INV-C07).
  Adapters map provider states into canonical states via ProviderStateEnvelope
  without erasing provider meaning (INV-C06) and cannot declare finality
  (W3-001 acceptance: "adapters cannot declare finality").
- **web/API** terminates REST/webhooks and serves the approval surfaces; it
  never calls providers directly.
- **The reconciliation worker owns ambiguity resolution** (INV-X03): UNKNOWN
  outcomes, provider-vs-protocol comparison, and the authoritative resolution
  records that alone may change a terminal presentation (INV-X04). UNKNOWN
  external writes are never blindly retried (INV-X02).
- **Lab worker** has no production provider egress; simulation is never
  production truth (INV-L01).
- **notification worker** delivers signed webhooks (envelope
  `{ id, type, occurredAt, schemaVersion, data }`; `X-PaySwap-Signature` v1 =
  hex HMAC-SHA256 over canonical JSON of the envelope joined with the
  timestamp; `X-PaySwap-Timestamp`; 300-second replay window).

## 6. Deployment gates checklist

Every release checks ("Deployment gates"):

- [ ] **Schema migration compatibility** — forward-compatible migrations
      (INV-O03); restore/replay can reconstruct authoritative state (INV-O04).
- [ ] **Environment-variable completeness** — against the section 3
      configuration contract for the target environment.
- [ ] **Secret exposure** — scan for secrets in repo/artifacts; vault-only
      resolution verified.
- [ ] **Provider capability configuration** — declared instances consistent
      with actual account authorization/entitlement (INV-C05; INV-NC04).
- [ ] **Database connectivity** — from every worker role.
- [ ] **Queue/outbox health** — no stuck commands; outbox drain verified
      (INV-O02).
- [ ] **Browser journeys** — desktop + responsive verification, console-error
      check, key interactions, screenshot artifact, evidence of real
      API/protocol wiring ("Browser verification").
- [ ] **API conformance** — contract tests: envelope shape, error categories
      → status mapping, idempotency-key enforcement (INV-F05), webhook
      signature/replay window.
- [ ] **Architecture/invariant suite** — invariants incl. INV-X01 (UNKNOWN
      never mapped to FAILED) hold in tests.
- [ ] **Observability** — dashboards/alerts receive terminal and
      reconciliation events from the new release.
- [ ] **Rollback** — documented, rehearsed path (migrations must roll back or
      forward-safely).

## 7. Vendor-neutral cost posture

Per "Cost posture" and "Deployment topology from day one":

- **Free tiers are preferred** for development and early production where
  they satisfy reliability, security, data residency, throughput, retention
  and contractual requirements.
- A **paid dependency must have an explicit capability reason**; the reason is
  recorded with the dependency, not in tribal memory.
- **No single-vendor dependence**: the configuration contract (section 3)
  keeps every external dependency swappable — Postgres-compatible store,
  S3/R2-compatible object storage, queue abstraction, vendor-neutral
  observability. Provider lock-in must not leak into domain contracts
  (AGENTS.md rule 17).
- Reference deployments may use managed free tiers (e.g. web hosting,
  serverless Postgres, R2-class object storage, Redis/queues) — as defaults,
  not as architectural commitments.

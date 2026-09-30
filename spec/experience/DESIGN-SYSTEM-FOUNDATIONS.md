# Design System Foundations

Status: Draft (W3-001) — 2026-09-30

## 1. Purpose

Token model, responsive rules, state-coverage rules, accessibility baseline and
core presentation principles for all PaySwap surfaces (plane A). These
foundations are protocol-driven: styling keys off protocol state (§22), not
off transport events or optimistic local mutations. Grounding:
`FRONTEND-UX-DEPLOYMENT.md` ("State rendering", "Agent UX",
"Browser verification"), `INVARIANTS.md` (INV-X01, INV-E04), §21A.

## 2. Token model

### 2.1 Primitive tokens

| Family | Contents | Rules |
|---|---|---|
| `color` | neutral ramp, brand ramp, semantic ramps | No raw hex in components; only semantic tokens |
| `spacing` | 4px base scale (`space-1`…`space-12`) | Single base unit; no ad-hoc pixel gaps |
| `typography` | type scale, family stacks, weights, line heights | Numeric tabular figures for all money/ID columns |
| `radius` | `radius-sm/md/md-lg/lg/full` | Consistent control shape per elevation |
| `elevation` | `elevation-0…4` + focus ring tokens | Elevation communicates layering, never state |
| `motion` | durations (100/150/250/400ms), standard easings | All motion respects `prefers-reduced-motion` |

### 2.2 Semantic tokens

Semantic tokens name intent, not value: `surface-default`, `surface-raised`,
`text-primary`, `text-muted`, `border-subtle`, `accent-action`,
`feedback-success/warning/critical/info`. Components consume only semantic
tokens so dark/light themes swap one token layer.

### 2.3 Protocol-derived semantic state tokens

UI styling keys off protocol state (§22 → canonical UI states). One token per
canonical UI state, so a state never borrows another state's styling:

| Token | Canonical UI state | Styling intent |
|---|---|---|
| `state-fulfilled` | `fulfilled` | Confirmation (green ramp), terminal |
| `state-reconciling` | `reconciling` | Neutral/in-progress (blue ramp) — **never error styling** (INV-X01) |
| `state-action-required` | `action-required` | Attention (amber ramp), explicit action CTA |
| `state-no-viable-route` | `no-viable-route` | Blocked-but-constructive (slate) |
| `state-compliance-blocked` | `compliance-blocked` | Serious, policy-backed (deep red outline) |
| `state-expired` | `expired` | Neutral muted |
| `state-cancelled` | `cancelled` | Neutral muted |
| `state-failed` | `failed` | Negative (red ramp), terminal |

Rules:
- The mapping protocol-state → UI-state → token is single-sourced (see
  `FRONTEND-STATE-MAPPING.md`; code source of truth:
  `packages/interfaces/src/protocol-state.ts`).
- `state-reconciling` and `state-failed` are never interchangeable; UNKNOWN
  maps to `reconciling` (INV-X01).
- Dark/light parity is a release gate: every semantic token must be defined in
  both themes with contrast verified before shipping.

## 3. Responsive mobile-first rules

- **Mobile-first authoring:** base styles target small screens; breakpoints
  enhance upward. Breakpoints: `sm` 480px, `md` 768px, `lg` 1024px,
  `xl` 1280px.
- **Touch targets:** ≥44×44px for all interactive elements, including table
  row actions and state-badge affordances.
- **Safe areas:** respect `env(safe-area-inset-*)` for notches/home bars;
  sticky headers/footers account for it.
- **Content priority ordering** (what stays visible as width shrinks):
  1. protocol state badge and amount;
  2. primary action (approve / take required action);
  3. counterparties and identifiers;
  4. evidence/provenance links;
  5. secondary metadata and filters.
- Tables degrade to stacked cards at `md` and below; state badges never
  truncate to bare color dots (see section 5, Accessibility baseline).
- Responsive/mobile verification is part of every UI work order
  ("Browser verification").

## 4. State-coverage rules (MANDATORY checklist)

Every asynchronous surface must define, before implementation:

- [ ] **Loading** — skeleton matching final layout; no layout shift on
      resolve; no indefinite spinners without a cancel/refresh affordance.
- [ ] **Error** — actionable, error-category-aware (see
      `FRONTEND-STATE-MAPPING.md` section 4): VALIDATION highlights fields;
      AUTHORIZATION offers re-auth; POLICY shows the recorded policy reason;
      RATE_LIMITED shows retry-after; INTERNAL offers retry + support path.
- [ ] **Empty** — states the absence and guides to the next best action
      (connect a PSP, create a payment, grant a mandate).
- [ ] **UNKNOWN-reconciling** — neutral in-progress styling, explicit
      "outcome unknown — reconciling" copy, link to reconciliation state;
      **never error styling** (INV-X01) and never a blind retry of the
      external write (INV-X02).
- [ ] **Action-required** — explicit card with the provider action surfaced
      from ProviderStateEnvelope (INV-C06); never a generic error.

A surface missing any of the five is not done — this mirrors the W3-001
acceptance that "frontend state mappings are defined before downstream
feature UI work".

## 5. Accessibility baseline

- **WCAG 2.2 AA** is the minimum: contrast, target size, focus appearance
  (2.4.11/2.5.8-era criteria included).
- **Keyboard navigation:** full task completion without a pointer; logical
  tab order; skip links; no keyboard traps in modals/drawers.
- **Visible focus:** visible focus indicator on every interactive element;
  never removed without an equivalent.
- **Reduced motion:** honor `prefers-reduced-motion`; parallax/celebratory
  motion disabled; state transitions cross-fade only.
- **Semantic landmarks:** `main`/`nav`/`header`/`footer` per page; headings
  hierarchical; forms labeled; money values in tabular numerals.
- **Live regions:** state transitions announced via `aria-live="polite"`
  (loading→terminal, reconciling→resolved); `assertive` reserved for
  action-required prompts.
- **Screen-reader text for state badges:** every badge carries a text label
  plus accessible description (e.g. "Reconciling — outcome unknown, awaiting
  confirmation from provider"); color is never the only carrier of state.

## 6. Principle: UI state derives from protocol state

UI state must be a one-to-one projection of authority state ("State
rendering"). Consequences for the design system:

- Never infer **success** from disappearance of a loading spinner.
- Never infer **failure** from an unreachable network.
- Never infer **finality** from screenshots alone — UI/browser artifacts are
  not stronger than their authenticated provenance (INV-E04).
- Never infer **payment completion** from an optimistic local mutation.
- Terminal badges change only on protocol-authoritative records; the UI never
  downgrades a terminal badge except via an explicit reconciliation record
  (INV-X04).
- Loading/disabled visuals are transport-level only; they never substitute
  for a protocol state.

## 7. Evidence/provenance disclosure patterns

- **Provenance line** under every consequential record: actor (principal or
  agent), authorization reference (ApprovalArtifact id, INV-A03), timestamp,
  source system.
- **Proof level disclosure** using §16 vocabulary (P0 assertion → P5 native
  ledger/rail finality): show the achieved level and the policy-required
  level; "finality pending proof" when below.
- **Observation framing** for external positions: every
  ExternalFundsPositionObservation shows observation timestamp and provider
  provenance, and is labeled an external observation, never a PaySwap balance
  (INV-C09).
- **Provider envelope drawer:** provider name/version, external object ID and
  revision, provider state, action required — rendered verbatim from
  ProviderStateEnvelope for support/audit contexts (INV-C06).
- **Immutable history:** timelines are append-only visualizations; historical
  evidence is immutable (INV-E05) and resolution views show new records, not
  edits (§15).

## 8. Agent-visibility patterns

Per "Agent UX", agents are visible collaborators. Standard components:

| Component | Shows |
|---|---|
| Agent collaborator chip | Agent name/instance, package version, security epoch |
| Proposal card | What the agent proposes; which capabilities it uses; expected benefit/cost/risk |
| Authority summary | Mandate scope: allowed actions, resources, rails, currencies, limits, expiry (§5) |
| Spend envelope | What it can spend now (mandate + reservation headroom) |
| Approval request | Which action requires approval, with request hash linking to the signed ApprovalArtifact (INV-A03) |
| Evidence feed | What evidence the agent produced (INV-E01, INV-E02 lineage) |

Rules: proposals are advisory and never render as executed actions (INV-G03);
the user should not have to understand internal Agent Organizations; the agent
never receives an unrestricted money-movement tool (INV-A04), so UI never
offers a "let agent do anything" control.

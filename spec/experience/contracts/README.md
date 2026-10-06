# PaySwap UX contracts (§17 deliverables)

Status: NORMATIVE v1 — 2026-10-06 — derived from the Stripe UX research set (Phase 1 `docs/ux-research/stripe/` + Phase 2 `docs/ux-research/stripe/phase2/`) per `docs/STRIPE-UX-DIRECTIVE-2026-10-06.md` §17. These contracts are the single source of truth for implementation surfaces; they supersede the W3-001 first-pass `spec/experience/*.md` documents wherever they conflict (those remain as historical drafts).

## The ten contracts

| # | Contract | File | Scope |
|---|---|---|---|
| 1 | Navigation | `01-NAVIGATION-CONTRACT.md` | Global chrome, sidebar taxonomy, object-model drill, create menu, setup guide |
| 2 | Design tokens | `02-DESIGN-TOKEN-CONTRACT.md` | Semantic color/state/environment tokens, type, spacing, elevation, motion, freshness |
| 3 | Components | `03-COMPONENT-CONTRACT.md` | The 15-component catalog: ListPage, StatusChip, EmptyState, ObjectDetailHeader, MetricCard, … |
| 4 | Workflows | `04-WORKFLOW-CONTRACT.md` | W1–W6 money-movement flows: intent → steps → states → errors → recovery |
| 5 | Object detail | `05-OBJECT-DETAIL-CONTRACT.md` | The canonical detail anatomy: header → timeline → context → raw → related → events |
| 6 | Search/command | `06-SEARCH-COMMAND-CONTRACT.md` | Unified SEARCH/COMMAND bar, grammar, result model |
| 7 | Error states | `07-ERROR-STATE-CONTRACT.md` | Reason vocabulary, placement rules, message anatomy, no-dead-ends |
| 8 | Security presentation | `08-SECURITY-PRESENTATION-CONTRACT.md` | Environment safety, secrets masking, in-flow affordances, human attack explanations |
| 9 | Merchant dashboard | `09-MERCHANT-DASHBOARD-CONTRACT.md` | Section composition, progressive-disclosure ladder, crypto→financial vocabulary |
| 10 | Consumer dashboard | `10-CONSUMER-DASHBOARD-CONTRACT.md` | Consumer projection of the object model, flows, safety center, mobile shape |

## Sequencing (directive §19)

```
Stripe reconnaissance (DONE — Phase 1 + Phase 2)
        ↓
UX findings (DONE — research set)
        ↓
PaySwap UX contracts (THIS)
        ↓
TL review  ← current gate
        ↓
Shared component system
        ↓
Dashboard implementation
```

Implementation workers must NOT build competing dashboards before TL review of this set (directive §19). Non-conflicting foundation work may proceed.

## Compliance

"Compliance MANDATORY" means: pull requests touching UX surfaces cite the governing contract; certification (directive §20) tests against these documents; deviations require a contract revision first (amend the contract, then build).

## Certification hooks (directive §20, excerpt)

- Desktop/tablet/mobile rendering per responsive rules; keyboard-complete navigation.
- Payment success/failure/security-block/empty/loading states exercised per W1–W6.
- No dead buttons, no fake successes, no console errors.
- The §15 acceptance test: a Stripe-familiar merchant's first session feels like a mature financial operating system — chain/gas/ABI invisible at levels 0–1.

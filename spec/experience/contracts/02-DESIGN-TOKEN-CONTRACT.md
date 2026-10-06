Status: NORMATIVE CONTRACT v1 — 2026-10-06 — derived from Stripe UX research (Phase 2 + Phase 1 `component-patterns.md`); extends `spec/experience/DESIGN-SYSTEM-FOUNDATIONS.md` (W3-001). Compliance MANDATORY for all PaySwap surfaces.

# PaySwap design-token contract

## 1. Principle

Tokens encode **meaning, not looks**: every color, space, and type decision maps to a semantic role so that states (success/failure/pending), environments (testnet/mainnet), and surfaces (merchant/consumer) are visually consistent without ad-hoc styling. Nothing in this contract copies Stripe's visual identity — it copies the **role architecture** observed in the research.

## 2. Semantic color roles (normative set)

State colors (used for chips, icons, chart series, banners — never as decoration):
| Token | Meaning | Usage rule |
|---|---|---|
| `state.succeeded` | final success (settled/confirmed) | status chips, event log, success screens |
| `state.processing` | in-flight (pending inclusion, routing) | NEVER red; always paired with progress affordance |
| `state.failed` | terminal failure (reverted, insufficient) | paired with human reason + retry affordance |
| `state.refunded` | reversed after success | distinct from failed — money moved then returned |
| `state.disputed` | contested | pairs with evidence CTA |
| `state.blocked` | stopped by policy/risk before execution | pairs with explanation + appeal path |
| `state.dropped` | unknown/timeout after broadcast | pairs with investigation CTA |

Environment colors:
| Token | Meaning | Usage rule |
|---|---|---|
| `env.test` | testnet/sandbox surfaces | banner + badge; MUST be visually distinct from any state color so "test" can never read as "error" or "success" |
| `env.live` | mainnet | default; no special marking |

Surface colors: `bg.canvas`, `bg.surface` (cards), `bg.surface.raised` (modals/menus), `border.subtle`, `border.strong` (table headers). Text: `text.primary`, `text.secondary` (metadata, IDs), `text.muted` (placeholders). Action: `action.primary`, `action.secondary` (outline), `action.destructive` (refund/critical — never used for nav).

**Constraint**: no indigo/blue as primary (PaySwap brand decision); warm/neutral base with a single high-contrast action color.

## 3. Typography scale (semantic sizes only)

`display` (object-detail amount), `h1` (page), `h2` (section), `h3` (card), `body`, `body.small` (table cells), `metadata` (timestamps, IDs, "Updated N ago"). IDs and addresses ALWAYS render in `metadata` + monospace stack. Numbers in money contexts: tabular figures, never mixed with text in one node.

## 4. Spacing & layout rhythm

- Cards: `space.6` padding; page gutters `space.6`; card gap `space.4`. Lists: row height 44px minimum (touch).
- Section anatomy on object pages: header block (amount/status/actions) → timeline → context cards → raw detail card → related objects. (Evidence: payment-detail anatomy, `phase2/payments.md`.)
- Tables: 12px cell padding, header `bg.surface`, sticky header on scroll, row-select checkbox column + trailing row-menu column when actions exist.

## 5. Elevation & depth

Only two elevation levels exist: `raised.1` (sticky headers, hovered rows) and `raised.2` (modals, menus, popovers). Cards are flat with `border.subtle`. No decorative shadows.

## 6. Motion

Transitions 150–200ms ease-out for hover/focus; modals fade+scale 200ms; page transitions none (instant route swap with skeleton). **No animation may gate interaction** (buttons usable during transitions).

## 7. Iconography & status chips

- Status chip component is THE state vocabulary renderer: `<StatusChip state="succeeded|processing|failed|refunded|disputed|blocked|dropped" />` — icon + label + optional tooltip. Same mapping everywhere (list, detail, events, toasts).
- Chip labels are words ("Succeeded"), never codes; tooltips carry the technical detail ("Settled in block 192…").

## 8. Freshness & comparison affordances (normative)

Every metric/chart component carries: (a) a freshness label ("Updated N seconds/minutes ago") from the data's timestamp; (b) built-in previous-period comparison rendered as secondary series + delta; (c) empty state renders INSIDE the chart scaffold (axes/ranges visible + "No data" + a "how to fill this" link). (Evidence: Home overview cards, `phase2/dashboard-shell.md` §home-4.)

## 9. Environment marking rules

- Testnet: banner (nav contract §2) + badge on every page title + watermark-free — clarity without ugliness.
- Masked secrets: keys render `prefix + "…" + last-4` by default; reveal is an explicit per-row action that never persists across sessions.

## 10. Acceptance

- A grep for raw hex colors in components returns zero (tokens only).
- The seven state tokens cover 100% of payment-state renderings (no bespoke colors).
- Storybook/specimen page renders every token + StatusChip in every state.
- Design-token file is the single import for all surfaces (merchant + consumer + hosted payment pages share it).

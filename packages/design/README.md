# @payswap/design

PaySwap's presentation-only design system — tokens, hooks, and accessible React
component primitives distilled from the You-platform reference extraction
(2026-10-02, see `spec/phase-3/research/you-platform-reference-extraction-2026-10-02.md`).

**What this package is NOT**: it contains no financial semantics, no balances or
payment logic, no provider names, no business rules, no network calls, no
environment reads. It is a pure presentation layer. Surfaces render what they
are told — honestly.

- React 18/19 + TypeScript strict, ESM
- Tailwind CSS 4 compatible (token bridge in `tailwind-theme.css`) but **zero
  runtime dependencies** — plain CSS custom properties + classes
- Every component ships with a11y-first vitest + jsdom tests (keyboard paths,
  ARIA contracts, honest-state laws)

## Install

Peer dependencies: `react`, `react-dom` (>= 18).

```json
{
  "dependencies": { "@payswap/design": "*" }
}
```

## Quick start

```tsx
import "@payswap/design/styles/tokens.css";      // --ps-* custom properties (light + dark)
import "@payswap/design/styles/components.css";  // ps-* component classes
import {
  SkipLink, Topbar, Sidebar, SidebarSection, SidebarItem,
  Panel, Button, StatusPill, CommandPalette,
} from "@payswap/design";

export function App() {
  return (
    <div className="ps-root">
      <SkipLink />
      <Topbar
        breadcrumbs={[{ label: "Workspace", href: "/" }, { label: "Overview" }]}
        onSearch={() => setPaletteOpen(true)}
        actions={<Button variant="primary">Create goal</Button>}
      />
      <Sidebar
        brand={<strong>PS</strong>}
        footer={<Badge>ENV: LOCAL</Badge>}
      >
        <SidebarSection label="TRUST">
          <SidebarItem href="/evidence" active>Evidence</SidebarItem>
        </SidebarSection>
      </Sidebar>
      {/* <main id="main-content" tabIndex={-1}>…</main> */}
    </div>
  );
}
```

Dark theme: add `.ps-theme-dark` (or `data-ps-theme="dark"`) to any ancestor —
tokens cascade. Compact density (command-center tables): `.ps-density-compact`.
All motion collapses under `prefers-reduced-motion` (CSS tokens + the
`useReducedMotion()` hook for JS-driven paths).

## The honest-state philosophy (the core doctrine)

Every data surface renders the truth of its data — nothing else:

| Reality | Component | Contract |
|---|---|---|
| Content is loading | `Skeleton` | LOADING only. Never a substitute for absent data. Removed the moment loading ends. |
| Nothing exists | `EmptyState` | "Nothing here yet" + the real next action. No placeholder numbers. |
| A request failed | `ErrorState` | `role=alert`, danger styling, Retry re-runs the real request. |
| Outcome not yet known | `UnknownState` | Reconciliation language ("outcome not yet known") + amber **dashed** styling + an explicit UNKNOWN pill. The word "failed" and danger styling are banned here. |
| Data is auth-gated | `AuthRequiredState` | Title + "authentication required" + Retry + the doctrine line. No teaser data, no blurred fakes. |

**UNKNOWN ≠ danger** is a structural law, not a convention: `unknown` consumes
the amber ramp with a dashed border and hollow pill dot; failure states consume
the red ramp with solid borders. The classes, the tokens, and the accessible
labels are all disjoint — a reconciling outcome can never be dressed as failure
(and vice versa). The test suite enforces this.

Buttons follow the same honesty: `loading` disables + spins + `aria-busy` and
NEVER implies success — the outcome is always rendered by the caller's state.

## Component inventory

- **Button** — primary/secondary/ghost/danger; honest loading.
- **Card / CardTitle / CardSubtitle / CardMeta** — dense metadata cards;
  interactive cards are real buttons (Enter/Space).
- **Panel** — titled section with heading level + actions.
- **Badge / StatusPill** — ok/attention/unknown/blocked/disabled/failed;
  color is never the only carrier (text + shape + sr suffix).
- **Field / Input / Select** — label/hint/error wiring via context
  (`htmlFor`/`id`, `aria-describedby` merge, `aria-invalid`, `role=alert` errors).
- **Tabs** — roving tabindex, Arrow/Home/End with wrap, automatic activation;
  all panels mounted (aria-controls always resolves).
- **Dialog** — `aria-modal`, labelled title, focus trap + restore, Escape,
  scrim, body scroll lock; mounts only while open.
- **CommandPalette** — ⌘K/Ctrl-K surface: combobox + listbox + grouped options,
  fuzzy filter, `aria-activedescendant`, Enter runs, Escape closes.
- **Sidebar / SidebarSection / SidebarItem** — 240px grouped nav, small-caps
  section labels, `aria-current="page"`, real anchors by default;
  **SidebarDrawer** is the <lg overlay (modal Navigation dialog).
- **Topbar** — breadcrumb trail, "Search… ⌘K" trigger, leading/badges/actions slots.
- **SkipLink** — keyboard-first jump to main content.
- **Toast / ToastViewport** — info/success polite, error assertive; auto-dismiss
  with pause-on-focus/hover; exactly one viewport per app.
- **KeyValue** — definition-list metadata rows; mono ids; honest "—" for
  missing values; dates through the application's pure formatter.

## Hooks & utilities

- `cx(...)` — className combiner.
- `useFocusTrap(ref, active)` — Tab-cycle trap with focus restore (Dialog,
  palette, drawer all use it).
- `useCommandKey(handler)` — ⌘K / Ctrl-K global listener.
- `useReducedMotion()` — reactive `prefers-reduced-motion`.
- `useId(prefix, id?)` — deterministic, SSR-safe ids for ARIA wiring.

## Tokens

`src/tokens.ts` mirrors `tokens.css`: neutral/emerald/amber/red ramps, the
semantic `--ps-*` layer, 12–32px type scale, 4px spacing grid, comfortable vs
compact density, 4/8/12px radii, 150/200/250ms motion, two elevation levels.
Emerald is the only brand accent (money/positive); amber carries attention AND
unknown; red carries failure only; **no indigo/blue primary anywhere** — both
the CSS and the TS ramp tables are covered by invariant tests (including WCAG
AA contrast math).

## Development

```sh
npm run typecheck --workspace @payswap/design
npm run test --workspace @payswap/design
```

## Laws (encoded in tests where mechanically possible)

1. No copied reference code or assets — principles only, implemented fresh.
2. No financial semantics in this package.
3. UNKNOWN is visually and semantically distinct from danger — always.
4. Accessibility is acceptance: keyboard paths, focus management, ARIA,
   contrast, reduced motion.
5. No indigo/blue primary.
6. No network, no secrets, no env reads.

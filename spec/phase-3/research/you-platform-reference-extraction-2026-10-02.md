# You-Platform Reference Extraction — PaySwap UX System (P3-W2-001)

- **Date**: 2026-10-02
- **Reference**: https://you-platform.vercel.app/ ("YOU — Human Reality Infrastructure", a demo studio console)
- **Access method**: live browser inspection with `agent-browser` (headless Chromium)
  - **Primary session**: TL orchestrator, 2026-10-02, viewports 1440×900 (desktop) and 390×844 (mobile). Screenshots: `/home/z/my-project/download/you-reference-desktop.png`, `you-reference-mobile.png`.
  - **Verification session**: worker 40-b, 2026-10-02, same viewports; accessibility-tree snapshots, computed-style probes, and keyboard passes (Ctrl+K, ArrowDown, Escape, Tab). All TL primary findings below were independently re-confirmed unless marked otherwise.
- **Purpose**: extract observable interaction and visual-language **principles** (never code or assets) to inform the PaySwap design system (`packages/design`). PaySwap is a cross-border money-movement product; every borrowed pattern is adjusted for financial honesty, UNKNOWN-vs-failure distinctness, evidence disclosure, and non-custody messaging.
- **Law**: no proprietary source, assets, or implementation details copied. Everything below is observable black-box behavior; the PaySwap implementation in `packages/design` is written fresh.

---

## 1. Information hierarchy

Observed (verified both sessions):

- Three-zone app shell: fixed left sidebar (`role=complementary`, 240px at desktop) / top bar (`role=banner`) / scrollable `main`.
- Page header inside `main`: small-caps **group label** (e.g. "BUILD") → page name as `h1` → one-line description → page-level actions (`Refresh` secondary, `Create Twin` primary). The group label travels from the sidebar into the page heading, so the user always knows which section they are in.
- One `h1` per page; dialogs bring their own `h2` ("Command Palette", "Navigation").
- Content is **information-forward, not decorative**: dense metadata rows beat hero imagery. No gradients, no marketing chrome inside the console.

## 2. Navigation model

Observed (verified):

- Sidebar brand block: monogram "Y" + wordmark "YOU" + tagline "REALITY INFRASTRUCTURE".
- `navigation` labelled "Primary", items grouped by small-caps section labels rendered as plain (non-interactive) uppercase text:
  - ungrouped: **Overview**
  - **BUILD**: Twins, Captures, Performances, Templates, Renders, Live
  - **EMBODIMENT**: Agent Avatars
  - **DEVELOP**: API & Tools, Labs
  - **TRUST**: Consent & Provenance
  - **ACCOUNT**: Usage & Billing, Settings
- Sidebar footer (verified desktop): avatar initials ("SF") + user handle ("Studio Founder") + workspace name ("YOU Demo Studio") + context badges **ENV: LOCAL** and **API v1**.
- Grouping is *task-domain*, not technical: build/embodiment/develop/trust/account — trust gets a first-class seat.

## 3. Search / command interaction

Observed (verified by keyboard pass):

- Top bar search trigger renders `button "Open search"` with visible text **"Search… ⌘K"** — the keyboard shortcut is advertised in the control itself.
- **Ctrl/⌘-K opens a modal command palette** (`role=dialog`, labelled "Command Palette", `h2`, explicit `button "Close"`).
- Palette structure (verified in the a11y tree):
  - filter input with `role=combobox` (`aria-expanded=true`) — **fuzzy filter**: typing "tw" filtered the list to "Create Twin" and "Twins".
  - `role=listbox` labelled "Suggestions" with two `role=group` sections separated by a `separator`:
    - **Actions** — verb-first commands: "Create Twin", "Review captures", "Start agent avatar session", "Run Lab benchmark".
    - **Go to** — navigation entries that repeat the sidebar's group labels as a suffix: "Twins · Build", "Agent Avatars · Embodiment", "Consent & Provenance · Trust", "Usage & Billing · Account", …
  - **Arrow keys move an active option** (roving `aria-activedescendant` on the combobox; `aria-selected` on options).
  - **Escape closes** the palette (dialog unmounts).
- The palette unifies search + navigation + actions behind one keyboard-first entry point.

## 4. Typography

Observed (computed styles, verified):

- System sans stack: `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`. 16px root font size.
- Modest scale: page `h1` ≈ 24px; body 16px; controls/secondary 13–14px; metadata 12px; item-card mono ids 11px.
- Small-caps section labels: ~12px, semibold, wide letter-spacing, uppercase.
- Monospace stack (`ui-monospace, SFMono-Regular, …`) for ids/hashes — ids like `cmuq7ut610002fl304vycgr79i` are always mono.
- No web fonts loaded — system stacks only (fast first paint, no FOUT).

## 5. Color & density

Observed (computed, verified):

- Near-white canvas: body background `lab(98.62 -0.066 0.758)` (L≈98.6); near-black ink (L≈7.7 per TL probe); dark panel surfaces (L≈5.7–15.2); subtle tinted overlays via oklab alphas 0.15–0.85.
- Restrained, high-contrast, **no gradients**; color is used for state, not decoration.
- Uniform **8px radius** on buttons (verified computed `border-radius: 8px`).
- Density: dense but rhythmical — metadata rows use ~12px text with comfortable line-height; controls keep ≥36–44px targets.
- A light/dark **theme toggle** lives in the top bar (icon-only `button "Toggle theme"`).

## 6. Cards and panels

Observed on the Twins list (verified):

- Item cards are full-width selectable surfaces (`button`) carrying dense metadata:
  - name (e.g. "F9 items 3/7 no-consent twin"), a type tag ("person not named", "Re-verification"), a status chip ("capturing", "draft"),
  - **version badge** ("v0"), **relative date** ("created about 18 hours ago"), a **CONFIDENCE** field (may honestly show "—"), an **evidence count** ("evidence 0 assets"), and the **mono id**.
- Overview stat tiles are interactive buttons: label + big count + qualifier ("Twins — 5 — persistent human objects").
- Panels are titled regions with a header row (title, optional description, optional actions) and a bordered body.

## 7. Contextual sidebars & progressive disclosure

- The left sidebar is global, not page-contextual; context comes from the page header (group label + description) and the palette's Go-to group suffixes.
- Progressive disclosure: deep metadata (ids, confidence, evidence counts) is present but visually de-emphasized (mono, muted, small) rather than hidden behind interactions; dialogs are reserved for command/navigation, not for reading data.
- The palette itself is progressive disclosure: one shortcut surface reveals every action and destination.

## 8. Motion (observable)

- Micro-transitions only; no parallax, no large entrances. Dialog/drawer appear/disappear quickly (~150–250ms class of duration). Nothing observed that fights `prefers-reduced-motion` posture, and nothing that carries meaning — motion is never the only signal.

## 9. Responsive behavior

Observed (verified at 390×844):

- Sidebar collapses away; the top bar grows an **"Open navigation"** hamburger (`aria-expanded` tracked).
- Activating it opens the sidebar as a **modal dialog** (`role=dialog`, `h2 "Navigation"`, explicit `Close` button) containing the same brand block, grouped nav, and context footer — i.e. an overlay drawer, focus-contained.
- Page header and primary action remain visible; stat tiles reflow vertically.

## 10. Empty / loading / error states — the honest-state doctrine (the key pattern)

Observed (verified both sessions):

- Unauthenticated Overview renders, inside `main`:
  - an `alert` region: **"Overview data unavailable — authentication required — [Retry]"**
  - plus the line **"The Studio renders only real backend state — retry once the API is reachable."**
- **No fake data, no skeleton theater, no simulated success.** When the same Overview later had reachable state, it rendered real stat tiles (Twins 5, Ready twins 0, Captures 4, Evidence assets 1, Versions 0) — the honest state is data-driven, not static copy.
- Missing sub-values are honest too: CONFIDENCE renders "—" rather than an invented number.

## 11. Keyboard interaction

Verified by direct keyboard passes:

- ⌘/Ctrl-K palette; **Arrow keys** move the active option; **Escape** closes palette and drawer; **Tab** reaches top-bar controls and sidebar items; visible focus ring ≈ 2px with ~50%-alpha outline color.
- Interactive cards/stat tiles are true buttons (Enter/Space operable).
- No keyboard traps observed in palette or navigation drawer.

## 12. Accessibility observations

- Good: real landmark structure (banner/complementary/main/navigation); labelled dialogs with headings; combobox+listbox+`aria-activedescendant` palette; `aria-expanded` on disclosure triggers; explicit Close buttons; live region for notifications (labelled "Notifications alt+T").
- Gaps observed (PaySwap must do better): **no skip link** to `main`; nav items are `<button>`s rather than links (no deep-linkable URLs, no middle-click/SEO semantics); the notifications live region appears **twice** with identical labels (risk of double announcements); primary-action label truncates on mobile; horizontal overflow at 390px (§14).
- Color is never the only state carrier: status text is always visible ("capturing", "draft").

---

## 13. Translation table — observed pattern → PaySwap design decision

| # | Observed in reference | PaySwap design decision (`@payswap/design`) | Domain adjustment (money honesty) |
|---|---|---|---|
| T1 | 240px fixed sidebar, grouped small-caps nav (BUILD/TRUST/ACCOUNT) | `Sidebar` + `SidebarSection` + `SidebarItem`, 240px, `.ps-label` small-caps group headings | Groups carry PaySwap's IA (command center / pools / evidence / trust / account); "TRUST"-class sections stay first-class so provenance/consent-style surfaces (evidence disclosure) get a permanent seat |
| T2 | Sidebar footer: initials + handle + workspace + ENV/API badges | `Sidebar` footer slot + `Badge` (neutral metadata chips) | Badges state environment/version facts only — never provider names or fake health |
| T3 | Topbar: breadcrumb "workspace / page", search trigger "Search… ⌘K", primary action, icon toggle | `Topbar` with breadcrumb/search-trigger/action/badge slots; search trigger renders the shortcut | Primary action never implies financial outcome; toggles keep visible text or aria-labels |
| T4 | ⌘K palette: combobox + listbox, Actions (verb-first) + Go-to (group-suffixed), fuzzy filter, arrows, Esc | `CommandPalette` with identical ARIA geometry, written fresh (`useCommandKey`, `useFocusTrap`) | "Go to" entries carry PaySwap group labels; actions are UI verbs only — no payment execution in the design layer |
| T5 | Honest unauthenticated state: "data unavailable — authentication required — Retry" + doctrine line | `AuthRequiredState` with the same shape: title, reason, Retry, and an honesty line | PaySwap copy names the money-honesty contract explicitly ("only real settlement state is rendered") |
| T6 | "The Studio renders only real backend state" doctrine | Encoded package-wide: `Skeleton` is LOADING-only; `ErrorState`/`UnknownState`/`EmptyState` separate; README philosophy section | UNKNOWN is its own state (amber, dashed) — never styled as failure, never "failed" language while reconciling |
| T7 | CONFIDENCE field honestly "—"; evidence counts; mono ids; "created about N hours ago" | `KeyValue` metadata rows with mono values, `copyable` ids, relative dates via a **pure formatter prop** | Dates/ids format deterministically; the app supplies the formatter so the design package stays free of business/locale logic |
| T8 | Dense metadata cards: version badge + status chip + relative date + mono id | `Card`/`CardTitle`/`CardMeta` + `Badge` + `StatusPill` + `KeyValue` composition | Status vocabulary is PaySwap's: ok/attention/**unknown**/blocked/disabled/failed with UNKNOWN visually distinct from danger |
| T9 | 8px uniform radius; system font stacks; 16px base; modest scale | `radius.md = 8` standard, 4 inputs / 12 panels; identical system stacks; 12–32px named steps | No change — restraint fits a financial console |
| T10 | Near-white canvas, near-black ink, dark panels, restrained color | Neutral warm-stone ramp + semantic `--ps-*` layer, light+dark themes | Single emerald accent (money/positive); amber = attention+UNKNOWN; red = failure ONLY; **no indigo/blue primary** |
| T11 | Light/dark theme toggle in topbar | `.ps-theme-dark` / `[data-ps-theme="dark"]` token cascade | Dark theme keeps WCAG AA contrast (tested in tokens suite) |
| T12 | Micro-motion only (~150–250ms) | `motion.fast/panel/slow` tokens; CSS collapses under `prefers-reduced-motion`; `useReducedMotion()` hook | Motion never carries financial meaning; reduced-motion honored on CSS and JS paths |
| T13 | Mobile: sidebar → modal "Navigation" dialog with Close | `Sidebar` overlay mode at `<lg` (dialog semantics + `useFocusTrap` + Esc) | Zero horizontal overflow is a PaySwap hard rule (§14) |
| T14 | Notifications live region "alt+T" | `Toast` viewport as a labelled `aria-live="polite"` region, auto-dismiss + pause-on-focus | Toasts report transport/UI facts; money outcomes come from state, never toasts alone |
| T15 | Stat tiles as buttons (label + count + qualifier) | Composable `Card`/`KeyValue` patterns; interactive Card is role=button + Enter/Space | Counts are observations (e.g. evidence), never balances-hardcoded; the design layer stays semantics-free |
| T16 | Focus ring ~2px visible on keyboard focus | `.ps-root :focus-visible` 2px ring law, never removed; `useFocusTrap` restores focus on close | Keyboard path is acceptance for every interactive primitive |
| T17 | Dialogs: labelled, h2, Close button, Esc, focus contained | `Dialog` with `aria-modal`, labelled title, Esc, trap + focus restore (shared `useFocusTrap`) | Destructive confirmations use the `danger` Button variant only |

## 14. Defects observed in the reference — NOT adopted

1. **Horizontal overflow at 390px** — TL measured ~87px; the 40-b verification session measured `scrollWidth 898` vs `clientWidth 390` (508px, page-state dependent). PaySwap rule: **zero horizontal overflow** at every breakpoint ≥320px.
2. **Truncated primary action on mobile** — "Create Twin" renders as "Twin" at 390px. PaySwap: labels never clip; buttons wrap or reflow.
3. **No skip link** — keyboard users must tab through the whole sidebar. PaySwap ships a `SkipLink` component (jump to main content).
4. **Nav items are buttons, not links** — no deep-linkable URLs, no middle-click/new-tab semantics, no SEO surface. PaySwap `SidebarItem` renders a real anchor (`href`) by default with button mode available for SPA-internal views.
5. **Duplicate notifications live regions** — two regions labelled "Notifications alt+T" in the tree (double-announcement risk). PaySwap: exactly one toast viewport.
6. **Command palette always mounted in the DOM at first paint** (heading present while closed). Harmless here, but PaySwap mounts the palette only while open (or keeps it `inert`/`aria-hidden` when closed) to avoid stray heading/AT noise.
7. **11px mono metadata** — below the 12px floor PaySwap adopts for readable metadata (WCAG-friendly minimum; ids stay mono but ≥12px).
8. **No visible pagination/latency story for long lists** — beyond scope of one session, but PaySwap treats list length honestly (EmptyState/loaded counts) rather than silently truncating.

## 15. Acceptance mapping (work order → delivered)

- Reference findings stored with date/source: **this artifact**.
- Typography, spacing, navigation, density, panels, search/command, responsive, states documented: §1–§12.
- PaySwap tokens/components implemented without copying: `packages/design` (tokens + primitives + hooks, all tests in `packages/design/test/`).
- Accessible keyboard/focus/error/loading patterns specified: §11–§13, implemented in every component's tests.
- Architecture/financial semantics untouched: `packages/design` is presentation-only; no financial semantics, no network, no env reads (law-verified by package boundary).

**Amendment note (2026-10-02, worker 40-b)**: this artifact supersedes nothing — it is the single dated extraction for P3-W2-001, merging the TL primary inspection and the 40-b verification session. Findings marked "verified" were re-confirmed live on 2026-10-02 by worker 40-b.

Status: NORMATIVE CONTRACT v1 — 2026-10-06 — derived from Stripe UX research Phase 2 (`docs/ux-research/stripe/phase2/`) + Phase 1 (`docs/ux-research/stripe/`); supersedes the navigation section of `spec/experience/INFORMATION-ARCHITECTURE.md` (W3-001 first pass) wherever they conflict. Compliance is MANDATORY for every PaySwap dashboard surface.

# PaySwap navigation contract

## 1. Principle

Navigation is an **object model, not a feature list**. The merchant's money objects are always visible; capabilities and workloads collapse behind labeled groups; the long tail lives behind "More". The nav must never grow unboundedly as PaySwap adds capabilities.

## 2. Global chrome (every authenticated surface)

1. **Environment banner** — persistent, full-width, top-pinned strip on every page:
   - TESTNET: "Testnet — You're using test assets. Nothing here touches real money. [Switch to mainnet]"
   - MAINNET: no banner (default world needs no marking) — but the account switcher chip always shows the active network.
   - The banner MUST state the safety promise in human language and carry the inline exit link. It MUST NOT be dismissible. (Evidence: Stripe sandbox banner, `phase2/dashboard-shell.md` §shell-1; directive §13.)
2. **Topbar**: account switcher (avatar + account name + network chip) · **Search/Command with "/" kbd hint** · Apps/Capabilities · Help · Notifications · Settings · **Create** (split-button).
3. **Left sidebar** per §3. Responsive: collapses to icon rail ≤1024px, bottom-tab bar + FAB on mobile (Phase 1 `responsive.md`).
4. **Sidebar footer**: Setup guide widget ("Next: <one step>") · Developers · Customize.
5. Every route exposes: "Skip to content", a live region announcing route changes, and `data-testid` on all nav nodes (`nav.group.<id>`, `nav.item.<id>`).

## 3. Sidebar taxonomy (normative)

Persistent money objects (always visible, exact order):
| Item | Route | Object |
|---|---|---|
| Home | `/` | overview |
| Balances | `/balances` | balances per rail |
| Transactions | `/transactions` | all money movements |
| Customers | `/customers` | customer directory |
| Catalog | `/catalog` | products/prices/links |

Workload groups (accordion, one open, collapse default, `data-testid="nav.group.<slug>"`):
- **Accept** (payments family): Analytics · Checkout · Disputes · Risk · In-person/QR · Agentic/links
- **Bill** (recurring): Overview · Subscriptions · Invoices · Usage-based · Dunning/Recovery
- **Insights** (reporting): Reports · Custom metrics · Exports · Data pipeline
- **Capabilities** (apps/marketplace): Installed · Browse
- **More** (pressure valve): Tax/Compliance · Connect/marketplace-payouts · Identity · Issuing · Workflows · Projects

Rules:
- No capability EVER adds a new persistent nav row; it lands inside a group.
- "More" is the only group allowed to exceed 7 items.
- Route slugs are object-noun based (`/transactions`, `/customers/<id>`), never verb based (`/make-payment` is forbidden).

## 4. Object-model navigation (drill path)

Every list row routes to `<collection>/<objectId>`; every detail page links to its related objects (Payment → Charge/Settlement → Refund; Customer → their Payments/Subscriptions). Cross-object links MUST use the same component (RelatedObjects) everywhere. (Evidence: payment detail "Related objects", `phase2/payments.md`.)

## 5. Search/Command entry

- Topbar search with visible "/" hint; "/" focuses it from anywhere; Esc restores focus.
- It is a unified SEARCH + COMMAND surface per the search/command contract (`06-SEARCH-COMMAND-CONTRACT.md`).

## 6. Create split-button

One "Create" affordance in the topbar opening: Pay · Request · Invoice · Payment link · Convert — each showing its **keyboard chord** (visible in the menu, active globally): `c p`, `c r`, `c i`, `c l`, `c v`. (Evidence: Stripe create menu + chords, `phase2/payments.md` §create-menu.)

## 7. Setup guide widget

Persistent sidebar-footer checklist: exactly one **"Next:"** step is named and linked; steps verify account → secure wallet → activate first rail → create profile. Collapsible; re-openable from topbar. Never a modal wall. (Evidence: `phase2/dashboard-shell.md` §setup-guide.)

## 8. Acceptance

- A merchant can reach any money object in ≤2 clicks from any page (sidebar + row).
- The sidebar contains exactly 5 persistent rows on day 1 and on day 1000.
- Keyboard-only users can traverse the entire nav (arrows, Enter, "/").
- Every nav node has a stable `data-testid`; nav regression tests exist.
- No route anywhere uses verb-slugs; grep for `/pay`, `/send`, `/create-` in route definitions must return only modals/command handlers, never pages.

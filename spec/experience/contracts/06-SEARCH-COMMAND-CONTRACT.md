Status: NORMATIVE CONTRACT v1 — 2026-10-06 — derived from directive §8 (universal search/command) + Stripe evidence (`phase2/dashboard-shell.md` — "/" hint, create chords; Phase 1 `search.md`). Compliance MANDATORY.

# PaySwap search/command contract

## 1. Principle

ONE surface does BOTH: finding resources (search) and executing intentions (command). "Pay Alice 100 USDC" and "find the failed payment from Tuesday" land in the same box. (Directive §8: unified SEARCH/COMMAND.)

## 2. Entry & invocation

- Topbar search field with a visible **"/" kbd hint**; "/" focuses it from anywhere; Esc restores prior focus.
- CreateMenu chords (`c p` etc.) are the shortcut lane into the same command grammar.
- Placeholder rotates examples across both modes: "Search payments, customers… or type a command like 'pay 25 USDC'".

## 3. Result model (normative)

Opening the bar shows grouped, ranked results:
1. **Commands** (intent-first): Pay · Request · Invoice · Link · Convert · Withdraw — each opens its form, optionally pre-filled by parsed parameters (Withdraw routes to the Balances withdraw flow).
2. **Resources** (object search): Payments, Customers, Settlements, Refunds, Products/Links — grouped by type, each row = object's list-cell renderer (masked IDs, status chip).
3. **Navigation** (go-to): pages and settings sections, matched on title + synonyms.

Typing live-filters all groups; Enter takes the top hit; Tab/arrows move between groups.

## 4. Command grammar (v1 scope)

`<verb> [counterparty] [amount] [asset] [modifiers]`
- Verbs: pay, request, invoice, link, convert, withdraw (the same six as the commands group — TL-review R2).
- Natural parsing: "pay alice 100 usdc" → command=pay, counterparty=Alice (fuzzy contact match, else inline "Add contact 'alice'"), amount=100, asset=USDC.
- Missing parameters open the workflow form PRE-FILLED (never a parse error).
- Ambiguity resolution: inline disambiguation chips (which Alice? which rail?) — never dead-ends.

## 5. Behavior rules

- Search box never requires auth-sensitive data; it queries the operator's own account.
- Recent + suggested commands persist per account (local, not server).
- Results keyboard-navigable (↑↓ within group, ⇥ across groups, ⏎ execute).
- Commands and searches are announced to screen readers (listbox semantics).
- Zero-state of the bar (no query): recents + "New payment" quick actions.
- No-result state: "No matches for '<q>'" + closest suggestions + "Create payment for '<q>'?" (turn the miss into an intent).

## 6. Acceptance

- "/" focuses search on every authenticated page.
- The six verbs parse and pre-fill their workflows (test battery: 15 representative phrasings).
- Resource search returns each spec'd object type with list-cell rendering.
- Search/command works with keyboard only end-to-end.

# @payswap/surface — the stable, versioned, React-free surface API

Work Order: **P4-W4-002 — Universal User + Merchant UX** (§3.6).

## What this package is

The typed, versioned client contracts for every journey the PaySwap
universal interface exposes — the surface a **future browser extension**
and a **future mobile app** import WITHOUT React, WITHOUT Next.js and
WITHOUT any UI framework:

- the **five outcome actions** (`outcomes.ts`): Pay / Receive / Move /
  Convert / Checkout — each carrying WHERE its journey really executes
  (the dispatch authority: the PaySwap API runtime, the
  merchant-checkout dispatch, or the route-compiler preview) and its
  honest capability fold for whatever a deployment has configured;
- the **eleven operational areas** (`areas.ts`): Overview, Payments,
  Accounts, Activity, Opportunities, Connections, Capabilities, Security,
  Reports, Developers, Settings — the navigation IA derived from the
  Stripe UX research, every area citing the research document(s) its
  placement derives from (the TL audits this mapping against
  `docs/ux-research/stripe/**`);
- **exact integer minor-unit money display** (`money-view.ts`): integer
  arithmetic only — a float never touches an amount (INV-F01); the
  minor-unit digit count resolves through `@payswap/protocol`'s own
  currency registry with a LABELED honest fallback for unregistered codes;
- the **security gate vocabulary** (`security-vocabulary.ts`): the
  BLOCK/ALLOW/UNKNOWN fold of the REAL `@payswap/onchain-security`
  `GateDecision` into people language — verdicts preserved verbatim,
  UNKNOWN never rendered as failure or success, typed drill-down one
  explicit step away — plus the test/live + testnet/mainnet
  mode-indicator contract;
- the **Convert disclosure fold** (`convert-preview.ts`): a pure fold over
  the REAL `@payswap/route-compiler` compilation output — the simple
  outcome line first, every plan/leg/reason on explicit drill-down.

This package contains **no DOM, no network, no rendering and no financial
authority**: it renders what the authoritative layers authorize and folds
what they return — it never invents, upgrades or reinterprets a state
(web holds no financial state of its own; neither does this surface).

## The placement decision

The surface API lives in its own package — **not** under
`packages/web/src/lib/surface/` — because the work order's §3.6 asks for
contracts "suitable for a future browser extension and mobile app without
React", and a dependency boundary is the only mechanism that PROVES it:
`@payswap/surface` declares zero UI/framework dependencies, so an
extension or app importing it cannot accidentally drag React, Next.js or
the web app into its bundle. The web app is then merely the FIRST
consumer of the same contracts — not their owner. (Decision recorded per
the work order's "justify in the README"; approved by the TL in the
re-dispatch amendment.)

## Versioning and stability policy

`SURFACE_API_VERSION` (in `version.ts`) is the **contract version** — it
changes only when a contract shape changes, never because an
implementation detail moved:

| Change | Bump | Requirement |
|---|---|---|
| Removal / narrowing / required-field change of any exported type or function | MAJOR | A work order naming the surface explicitly + a changelog entry here |
| Additive contracts (new outcome action, new area, new optional field) | MINOR | Old consumers keep compiling — recorded in this README |
| Wording / documentation / pure implementation fixes | PATCH | None |

Every exported model carries `provenance` (`surfaceProvenance`): the
surface API version it was introduced under, its stability class
(`stable` — frozen, removal requires MAJOR; `experimental` — additive-only
between MINOR bumps), and the introducing work order. Consumers record
the version they compiled against so drift is detectable at build time,
not discovered in production.

## Dependencies (deliberately minimal)

- `@payswap/protocol` — the landed Money/currency-registry primitives the
  money view consumes (never re-implemented);
- `@payswap/ux` — the certified product journey contracts the outcome
  actions reference (pay/collect/payout journey ids and commands);
- `@payswap/onchain-security` — the REAL `GateDecision` vocabulary the
  security fold consumes (type contract only);
- `@payswap/route-compiler` — the REAL compilation output contracts the
  Convert fold reads (structural, type-checked at real call sites).

No React, no Next.js, no DOM types, no network stack — by construction.

## Testing

`npm test` (Vitest): contract tests pinning the registry shapes and
version policy; state-machine tests for the honest capability folds;
adversarial tests for the money formatter (non-integer rejection) and the
UNKNOWN-never-failure vocabulary law. Fixtures are values of the REAL
consumed types, never lookalikes.

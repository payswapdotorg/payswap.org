# TL review — UX contract set v1 (directive §19 gate)

Reviewer: resident TL · 2026-10-06 · Reviewed tree: commits `508e4e5` + `399af84` (contract set v1).

## Verdict

**PASS WITH REVISIONS — revisions applied in this commit (v1 → v1.1).**
The gate is now OPEN: implementation convergence (shared component system → dashboard implementation) may proceed against the amended set.

## What was reviewed

1. **§17 completeness** — all ten named contracts exist, are normative, cite their research evidence (Phase 1 + Phase 2), and carry acceptance criteria. CONFIRMED.
2. **§20 certification traceability** — each battery scenario mapped to a governing clause:
   - desktop/tablet/mobile → 02 §4/§9 responsive rules, 01 §2.3, 10 §6
   - keyboard navigation → 01 §8, 03 §3, 06 §5
   - search → 06 (whole contract)
   - navigation → 01 (whole contract)
   - payment creation → 04 W1; crypto payment → 04 W1/W3 + 09 §4
   - fiat payment → 04 W1; crypto→fiat / fiat→crypto → 04 W3 dual-amount + 10 §4 Convert
   - wallet authorization → 08 §3/§4 + 10 §5
   - merchant checkout → 04 W2/W3
   - refund → 04 W4; failed payment → 07 §2/§3; UNKNOWN transaction → 07 §5
   - security block/warning → 07 §2 + 08 §4
   - empty/loading/error/success → 03 §2.3/§3 + 07 + 04 W1/W3
   - **Stripe connection → 09 §2 Capabilities marketplace** (made explicit by revision R3 below)
3. **§21 architecture consumption** — intent compiler ↔ 06 grammar; capability discovery ↔ 09 marketplace; optimal execution ↔ 05 money breakdown + 04 W3 route disclosure; security engine ↔ 08; settlement ↔ W5; observation/reconciliation ↔ 05 §2.7 events log + 09 Insights; LAB ↔ test-mode teaching states (W6, empty states, Simulations tabs). CONFIRMED — the UX consumes the universal architecture without exposing it.
4. **Anti-copy discipline** — no Stripe brand/visual copying; role architecture only; explicit no-indigo/blue constraint (02 §2). CONFIRMED.
5. **One-product law (§6)** — merchant and consumer are projections sharing one component catalog (10 §1/§6). CONFIRMED.

## Revisions required and applied (v1.1)

- **R1 — state vocabulary gap.** 04 W4 used `partially_refunded`, which was outside the normative seven-state set (02 §2, 03 §2.2). FIXED: the state set is now EIGHT states — `succeeded · processing · failed · refunded · partially_refunded · disputed · blocked · dropped` — updated consistently in 02 §2, 03 §2.2, and 09 §2.
- **R2 — command verb mismatch.** 06 §3 listed commands "Pay · Request · Invoice · Link · Convert" while §4 grammar verbs were "pay, request, invoice, convert, withdraw" (`link` missing from grammar; `withdraw` missing from commands). FIXED: one verb set of six — `pay · request · invoice · link · convert · withdraw` — in both places; the commands group shows all six (Withdraw routes to the Balances withdraw flow).
- **R3 — Stripe-connection placement unspecified.** The §20 battery requires "Stripe connection", but no contract named where external account/PSP connections live or how connection status renders. FIXED: 09 §2 Capabilities marketplace now specifies account-connection flows: external rails (Stripe included) are capabilities; the Installed list carries per-connection status chips (connected / attention / disconnected) with re-auth affordances; Settings mirrors the connection list.

## Recorded (non-blocking — implementation convergence work, not contract defects)

- The existing `packages/design` `StatusPill` tone set (`ok/attention/unknown/blocked/disabled/failed`) predates this contract set; the implementation wave must converge it onto the eight-state `StatusChip` vocabulary (contract 03 §2.2 is the target; `unknown` maps to `processing`/`dropped` per 07 §5).
- The existing Command Center navigation is role-derived; it must converge onto the object-model sidebar (01 §3) — role becomes a projection, not a navigation axis.
- Known research gaps carried from Phase 2 (refund modal interior, Radar live views, authenticated-dashboard responsive behavior) remain honestly recorded in the research set; they do not block v1.1 because the contracts specify behavior classes, not those specimens.

## Disposition

With R1–R3 applied, the contract set is APPROVED as the single source of truth for all PaySwap UX surfaces. Next per §19: shared component system convergence, then dashboard implementation, then the §20 certification battery.

Status: NORMATIVE CONTRACT v1 — 2026-10-06 — derived from Stripe UX research Phase 2 (error specimens: failed payment + decline column, "Transaction not found" page, form validation behaviors) + directive §11–§12. Compliance MANDATORY.

# PaySwap error-state contract

## 1. Principle

Errors are first-class product surfaces: human sentences, a shared reason vocabulary, a next action always present. **No error is a dead end; no error masquerades as success; no error is toast-only.**

## 2. Error reason vocabulary (normative, shared with StatusChip)

| Reason (label shown) | Technical trigger | Next action |
|---|---|---|
| Insufficient balance | source wallet < amount | Top up / switch rail |
| Payment reverted | counterparty/receiver reverted | Show revert reason + retry with edit |
| Route unavailable | no live route meets constraints | Show alternatives ranked |
| Slippage beyond limit | execution exceeded tolerance | Retry with adjusted limit |
| Transaction dropped | not confirmed within window | Investigate (status explorer link) |
| Timed out awaiting confirmation | pending > SLA | Investigate / re-broadcast if safe |
| Blocked by security policy | risk/control stopped execution | Human explanation + appeal path |
| Cancelled by user | explicit cancel | — (recorded as event) |

Every reason maps to exactly one label + one icon + one next-action family. Custom errors MUST extend this table, never inline free-text.

## 3. Where errors render (placement rules)

1. **In the table**: collections carry a "Failure reason" column (present-but—"—" for healthy rows; populated for failed ones). (Evidence: Stripe decline-reason column.)
2. **In the detail header**: failed objects show StatusChip=failed + human reason line under the strapline + Retry/Edit actions in the header itself.
3. **In forms**: per-field inline errors BELOW fields; clear on valid input; submit blocked while invalid; **never persist stale errors after a successful re-validation** (Stripe's stale "A value is required" is the recorded anti-pattern).
4. **Dedicated error pages** for invalid/deep-linked resources: name the resource looked up, name the world (test/mainnet), offer the single best next hop. (Evidence: "Transaction not found — The requested transaction does not exist: payouts · View all test mode payments".)
5. **Toasts are for confirmations only.** Errors never toast.

## 4. Error message anatomy (normative)

`[What happened, in plain words] — [Why, if known, in human terms] — [What you can do now]`
- Example: "Payment failed — The receiving contract reverted the transfer (reason: allowance). You can retry after approving, or edit the payment."
- Never raw codes alone (codes go in the expandable technical detail / event log).
- Never blame the user; never speculate when unknown ("We couldn't determine the outcome" + Investigate).

## 5. Partial-failure & unknown states

- Unknown outcomes are `dropped`/`processing` — rendered as "We're still watching this" + freshness + expected-update time, NEVER as failure (evidence: Stripe never shows red for in-flight).
- Failed operations that created objects keep the object (audit trail) with failed state (evidence: failed manual payment persisted with decline reason).

## 6. Environment errors (test/mainnet)

- Testnet surfaces render test-aware error variants where simulation differs (evidence: disputes empty state teaches test cards).
- The environment banner (nav contract §2) is never replaced by an error.

## 7. Acceptance

- The reason vocabulary table is the single source (grep for inline error strings outside it = 0, except page copy).
- Every error render site (table/header/form/page) implemented per §3.
- Certification battery exercises each reason at least once (§20 of the directive).
- Zero toast-only errors; zero dead-end errors; zero success-rendered failures.

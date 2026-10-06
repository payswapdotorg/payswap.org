Status: NORMATIVE CONTRACT v1 — 2026-10-06 — derived from directive §6 (consumer + merchant in ONE product, not two) + Phase 2 `hosted-checkout.md` (the payer-side exemplar). Compliance MANDATORY for consumer-facing surfaces.

# PaySwap consumer-dashboard contract

## 1. Principle

The consumer (payer) surface is the SAME product as the merchant surface — same tokens, components, object model — re-projected around the consumer's mental model: **my money, my payments, my contacts, my safety**. It is not a separate app, and it never exposes merchant-only machinery. The hosted payment page (W3) is the consumer surface for non-users.

## 2. Consumer projection of the object model

| Merchant object | Consumer projection |
|---|---|
| Balances | My balances (per asset + display total; Incoming vs Available) |
| Transactions | My payments (sent/received; status chips; failure reasons) |
| Customers | My contacts (address book with verified entries) |
| Catalog | My requests (payment requests/links addressed to me) |
| Settlements | (folded into payment detail "when it arrived") |
| Risk | My safety center (permissions, warnings, dispute status) |

## 3. Consumer home (normative)

1. **Balance header**: display-currency total + per-asset chips + [Send] + [Request] + [Convert].
2. **Today card** (mirror of merchant's): latest expected incoming + next recurring outflow timeline.
3. **My payments**: recent list (list-cell renderer), status chips, tap → object detail (consumer projection).
4. **Safety card**: spending permissions count + active warnings + [Review].
5. Recommendations (activation cards): "Get paid back instantly with a payment link. [Try]".

## 4. Consumer flows (reuse workflow contract W1/W3/W4)

- **Pay**: Pay → choose contact/address → amount with dual-currency line ("25 USDC ≈ €23.10 — rate, fee") → method (wallet/rail picker in human words) → **Confirm button restating amount+destination** → processing → success with statement expectation ("This will appear as <descriptor> in your wallet app").
- **Request**: create a payment link addressed to a contact (or shareable); tracks incoming state.
- **Convert**: asset A → B with the SAME dual-amount + rate + fee disclosure and route summary; slippage tolerance as an advanced option with plain-language default ("Best rate, small variance allowed").
- **Review a payment request received** (the merchant's hosted page, consumer-side): order summary, dual amounts, environment badge, method tabs, plain-words accepted methods.

## 5. Consumer safety center (normative)

- **Spending permissions**: list of granted allowances with scope in human words ("Merchant X can spend up to 50 USDC"), revoke per row (with simulation of effect).
- **Warnings**: active security notices rendered with attack explanation (security contract §4).
- **Disputes**: "Report a problem" per payment → structured reason select → status tracking (Needs review · In review · Resolved).
- Recovery/backup flows use the secure component and human-language consequences; never raw seed phrases in plain DOM.

## 6. Rules

- Consumer surfaces show levels 0–1 of the disclosure ladder ONLY (merchant contract §3); anything deeper routes to "technical details" collapsed sections.
- Same error vocabulary and placements (error contract) — "Payment failed — reverted by receiver (reason) · Retry / Edit".
- Mobile-first: bottom tab bar (Home · Pay · Activity · Contacts · Safety) + FAB Send (Phase 1 `responsive.md`).
- Consumer never sees merchant pricing/fee schedules, catalogs, or team features; merchant CAN switch projections (same account, two projections — directive §6 one product).

## 7. Acceptance

- Consumer completes pay/request/convert/review-request with zero crypto vocabulary beyond asset names (spot-check battery).
- Every money confirmation shows the dual-amount line.
- Safety center renders permissions with human scopes + revoke (with simulation).
- Both projections share the component catalog (no bespoke consumer components outside projections).

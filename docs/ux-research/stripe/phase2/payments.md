Status: PHASE 2 (authenticated) — 2026-10-06 — live survey; all data are test-mode artifacts created during the survey.

# Payments — Transactions list, create flows, object detail

## Transactions list (`/test/payments`)

- Header: "Transactions" + primary CTA **[Create payment]**.
- Sub-tabs: **Payments · Payouts · Top-ups · All activity** (+ overflow "More").
- Status filter chips: **All · Succeeded · Refunded · Disputed · Failed · Uncaptured · Blocked** + [Filter].
- Table columns: (row-select) · **Amount** · **Status** · **Payment method** · **Description** · **Customer** · **Date** · **Decline reason** · (row menu).
  - Payment method cell: masked brand + last4 ("•••• 4242"). Amount cell: "€25.00 EUR".
  - **Decline reason is a first-class column**: present in the schema, "—" for healthy rows, populated for failed rows (observed "Other") — the error state lives IN the table, not behind a detail click.
  - Description falls back to the payment-intent ID for payment-link purchases with no explicit description.
- Footer: "1–2 of 2 results".
- Success and failure co-exist in one list (status chip distinguishes); no separate "failures" page.

### Empty state (captured before any data existed)

1. Cross-sell card: "Stripe Invoicing helps you reduce back-office workload by automating your accounts receivable." → [Create first invoice]
2. Hero: "Start collecting payments — Get started fast with a no-code option or explore customizable UIs that integrate with our APIs." → [Get started]
3. Integration-path ladder (three cards, plain language, each → docs):
   - "Use a prebuilt payment form — Embed a checkout form optimized for conversions directly into your site or redirect to a Stripe-hosted page." (Checkout)
   - "Build a custom payment UI — … modular UI components with CSS-level styling." (Elements)
   - "Charge customers in person — … card readers … point of sale." (Terminal)

→ The empty payments list is a **no-code-first onboarding surface**: adjacent-product cross-sell, hero CTA, then the integration ladder ordered by decreasing no-code-ness.

## The Create menu (global split-button)

"Create payment" opens a dropdown with **keyboard chords**, also active globally without the menu:

| Action | Chord |
|---|---|
| Invoice | `c i` |
| Payment link | `c l` |
| Subscription | `c s` |
| Manual payment | `c p` |

→ One create affordance, four destinations, full keyboard parity. (VLM-verified dropdown; menu items carry their chords as visible hints.)

## Manual payment form (`/test/payments/new`)

- Header: "Create a payment" + [Feedback?] + **[Submit and create another]** + **[Submit payment]** — dual submit, one keeps you in the flow.
- Segmented toggle: **One-time | Recurring**.
- Fields: Amount (currency-prefixed; auto-formats to 2 decimals) · Currency · **Customer (optional)** combobox ("Find or add a test customer…" — TEST-flavored placeholder) · Description · **Statement descriptor** (auto-formats to spaced caps, e.g. "PAYS WAP UX TEST"; **required** for manual card payments) · Payment method:
  - Radio "Manually enter card information" + checkbox "Save card to customer" — disabled with inline explainer "Select a customer above to save a card to their profile." until a customer is chosen (**dependent-input affordance with reason**).
  - More options: "Use a customer's on file payment method" · "Email your customer a hosted invoice with Stripe Billing".
- Card entry: single-line payment-element iframe (number · expiry · CVC · postal in one row).
- **Inline validation observed live**: "Your postal code is incomplete." (per-field, below the form); "A value is required." (statement descriptor, after failed submit — persists until the next validation pass; stale-error behavior worth avoiding). Errors clear as fields complete.
- Submitting successfully navigates to the payment's detail route; a genuinely-declined manual payment surfaces the failure in the list (Decline reason "Other") — no dead-end error page.

## Payment link creation (`/test/payment-links/create`)

- Header: "Create a payment link" + [Create link] + [Close].
- Sections: **Select type** (Products or subscriptions) · **Product** · **Payment page** · **After payment**.
- Product picker: combobox "Find or add a test product…" → unknown name yields suggestion **"Add '<name>' as new product"** → inline modal:
  - Name (required) — "Name of the product or service, visible to customers."
  - Description — "Appears at checkout, on the customer portal, and in quotes."
  - Image — "Appears at checkout. JPEG, PNG, or WEBP under 2MB." + Upload
  - Pricing: Recurring | One-off · Amount (required)
  - **Adaptive Pricing — Enabled**: "When eligible, customers can automatically pay in their local currency." + View docs
  - Live preview: "Estimate totals based on pricing model, unit quantity, and tax" → "1 × €25.00 = €25.00 · Total €25.00"
  - [Cancel] [Add product]
- **Options checklist in three tiers** (basic → advanced → more):
  - Enable Managed Payments — "Stripe handles global tax compliance, fraud, disputes, and customer support. **This adds a 3.5% fee per transaction.**" + View docs (fee disclosure inline in the option itself)
  - Collect tax automatically · Collect customer names · Collect business names · Collect customer addresses · Require customers to provide a phone number · Limit the number of payments
  - Advanced: Add custom fields · Allow promotion codes · Allow business customers to provide tax IDs · Save payment details for future use · Require customers to accept your terms of service
- **CTA wording selector**: Pay · Book · Donate — "as the call to action" (the merchant picks the verb their customer sees).
- Live preview pane ("buy.stripe.com" + "Use your domain") + footnote "You can enable more payment methods and change how this page looks in your account settings."

### Payment link detail (`/test/payment-links/plink_…`)

- URL field + actions: **Copy and share to start accepting payments with this link** · Add URL parameters · **Embed buy button** · **Download QR code** · More options.
- Sections: Overview (Payments and analytics) · Products table (Name · Quantity · Adjustable Quantity) · **Payment methods** (Manage — Card, Apple Pay, Bancontact, EPS, Klarna, Link, MB WAY, Amazon Pay, Satispay) · Details (Status Active · Date created · Limited use · Allow promotion codes · Collect addresses · Collect phone…).

## Payment object detail (`/test/payments/pi_…`) — the canonical object-detail exemplar

- Header: **amount + currency (€25.00 EUR) · status (Succeeded) · human strapline ("Charged to UX Survey") · primary action [Refund]** (`data-testid="paymentDetails.actionButtons.refund"`).
- **Recent activity** timeline: [Add note] · Payment authorized (timestamp) · Payment started (timestamp).
- **Checkout summary**: Customer (email · name · country) · Items table (Qty · Unit price · Amount) · Total.
- **Payment breakdown**: "Customer paid in HKD using Adaptive Pricing, but the funds will be transferred to you in EUR. Learn more" · Payment amount €25.00 · Stripe processing fees −€1.04 · **Net amount €23.96**.
- **Payment method**: masked number · expiry · ID (`pm_…`) · Type "Visa credit card" · Fingerprint · Issuer "Stripe Payments UK Limited" · Electronic commerce indicator 07 · Origin · **CVC check: Passed** · Owner · Address.
- Tax section with inline upsell: "No tax rate applied. Calculate tax automatically on future invoices using Stripe Tax. Start now".
- **Risk analysis**: "Risk insights are only available for live data." — test-mode honesty instead of fake scores.
- Related payments ("No related payments in the last 6 months") · **Related objects**: Latest charge (`ch_…`) · Payment link (`plink_…`) — clickable cross-object graph.
- **Receipt history**: View receipt · Send receipt · "No receipts sent".
- **Events**: human-sentence log ("A €25.00 payment for ch_… was updated", "A Checkout Session was completed", "The payment pi_… for €25.00 has succeeded") with timestamps + raw event rows.
- Payout linkage: expected payout date ("Oct 13, 12:00 AM") linking into Balances.

## Refund entry (gap noted)

The Refund action sits in the detail header next to amount/status. The modal's contents (amount prefill, reason select, confirmation) could not be captured in this environment — Phase-1 `payments.md`/`risk.md` remain the record for the refund flow interior.

## Derivation seeds (→ contracts)

- **Status vocabulary as filter chips** (Succeeded/Refunded/Disputed/Failed/Uncaptured/Blocked) → PaySwap seven-way payment-state filter (Confirmed/Settled/Reverted/Failed/Dropped/Pending/Blocked).
- **Decline-reason column in the table** → PaySwap "Failure reason" column with human-readable causes (revert, slippage, timeout, insufficient balance).
- **Empty list = integration ladder** → PaySwap empty Payments: "Accept via PaySwap Link (no code) / Embed a payment component / Integrate the API / Show QR in person".
- **Create menu + chords** → PaySwap command surface: Pay / Request / Invoice / Convert.
- **FX + fee + net disclosure in payment breakdown** → PaySwap: "Customer paid USDC on Base… settled to you in EUR via optimal route. Rate X · fees Y · net Z."
- **Object-detail anatomy** (header amount+status+action → timeline → context sections → raw IDs → related objects → human event log) → the PaySwap object-detail contract for Payment/Settlement/Refund/Customer.

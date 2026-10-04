Status: PUBLIC-SURFACE RESEARCH — 2026-10-03 (P4-W1-003 Phase 1) — source: public Stripe docs via automated extraction, no authentication; authenticated dashboard survey is Phase 2 (operator-gated)

# Stripe Customers — object model, Dashboard flows, CRM framing

Source: R3 `notes-customers.md` (docs.stripe.com/billing/customer), cross-checked with R3 SUMMARY §d. Breadcrumb: Revenue / Customer management / Customers.

## Customer object model

- Customer = "a core entity within Stripe" storing "all of the profile, billing, and tax information required to bill a customer" for subscriptions and invoices.
- Hanging off the object: PaymentMethods, Customer Credit Balance, Subscriptions, Invoices, Receipts, pending InvoiceItems, TaxIDs, per-customer invoice settings.
- Addresses split into billing (tax compliance, invoices/credit notes/receipts) vs shipping (physical goods) — two distinct concepts on one object.
- Localization: preferred_locales as an ordered RFC-4646 list (e.g., "fr-CA") drives email + PDF language.
- Tax: tax IDs rendered on invoice/credit-note headers; tax_exempt = none | exempt | reverse (reverse = customer pays the tax).
- **Accounts v2 migration callout (prominent):** Customer objects can be replaced by customer-configured Account objects for a unified user representation across products; GA for Connect, public preview otherwise — a documented object-model consolidation direction.

## Dashboard/API dual paths

- Docs present "Manage customers" with Dashboard/API tabs — the same no-code vs code dual-path pattern used across Stripe docs (also on webhooks setup).
- Recipes taught as sequences: subscription (customer → catalog/prices → subscription), one-off invoice (customer → draft line items → payment method → finalize), credit balance (credit/debit adjustments against future invoices), tax-ID add/validate, set currency.

## Dashboard flows

- **Create:** Customers page → "Add customer" button OR single-key shortcut **N** → dialog with minimum Name + Account email → "Add customer". Pre-step guidance: verify the customer doesn't already exist (dedup). Can also create inline during invoice creation.
- **Edit:** click name in list → account information page → Actions > Edit information → "Update customer".
- **Delete:** checkbox next to name → Delete; or detail page → Actions > Delete customer. Confirmation-flow text is not shown in the doc — not observable from fetched content.
- The Actions menu is the row-level surface for object operations (same overflow-menu pattern as API keys).

## Profile philosophy

- **Minimal profile:** email, name, and metadata carrying the internal customer ID. Bidirectional ID storage recommended: internal ID on Stripe metadata; Stripe ID on the internal model — searchable both ways (`search.md`).
- The profile is explicitly framed as a **lightweight CRM**.
- **Single-currency lock:** currency is immutable once set by an invoice/credit balance; the Dashboard communicates this via a **disabled Currency dropdown** — a visible affordance for an immutable property. Multi-currency entities → one customer per currency.
- Subscription edits apply "until an invoice is finalized" — next billing period uses latest state (eventual-application semantics worth copying for recurring-payment config).
- Notifications: email lets Stripe notify the customer of failed payments or actions requiring further steps (dunning emails).

## PaySwap implications (Directive B §7)

- Customer is a first-class object, navigable from payments (Payment → Customer → attempts → route → provider → settlement → finality → evidence): PaySwap payment detail pages must link to the merchant/customer record, and the customer record must aggregate its payments, subscriptions/invoices, payment methods and notes — the object-hub pattern Stripe uses everywhere.
- Minimal-profile + metadata ID-mirroring is the right default for PaySwap merchants mapping PaySwap customers to their own systems.
- Disabled-dropdown honesty: immutable properties should be shown, not hidden (PaySwap: origin chain of a transaction, token contract, settled currency).
- Per-object Actions menu + single-key create shortcut + dedup pre-check are cheap, high-leverage ergonomics.
- The Accounts v2 consolidation signals that PaySwap should keep "user/account vs customer" unified early rather than retrofit (merchant, wallet owner, and payee as one identity object with capability-scoped views).
- One-customer-per-currency maps to PaySwap's per-token/per-chain balance segmentation (`balances.md`) — expose the constraint, never silently convert.

## Honest gaps

- List-page table structure, confirmation dialogs, loading/empty/success states for customer CRUD: not observable from fetched content. Mobile customer CRUD is referenced in the mobile app doc but not detailed there either. Authenticated flows are Phase 2.

## Cross-references

Related files in this set: `search.md` (name:, email:, metadata: customer search), `payments.md`, `billing.md` (subscriptions/invoices recipes context), `balances.md` (credit balance vs currency lock), `connect.md` (Accounts v2 for Connect), `navigation.md` (Customers as first sidebar section), `component-patterns.md` (Actions/overflow menu, Dashboard/API tabs), `workflow-patterns.md`, `pay-swap-ux-mapping.md`, `README.md`.

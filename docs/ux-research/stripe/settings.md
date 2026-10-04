Status: PUBLIC-SURFACE RESEARCH — 2026-10-03 (P4-W1-003 Phase 1) — source: public Stripe pages/docs via automated extraction, no authentication

# Stripe account model and settings — teams, modes, sensitive actions

Sources: R3 notes for test mode/sandboxes (`docs.stripe.com/test-mode`), API keys (`docs.stripe.com/keys`), and Dashboard basics (`docs.stripe.com/dashboard/basics`, including its Start-a-team raw capture); R2 notes for the docs-home account-model placement and the security page's user-control layer. Key formats are described by prefix only — no key values appear in this set.

## Account model

- Dashboard settings are organized in three categories — **Personal, Account, Product** — with per-product settings islands (Billing, Radar, Card issuing, Identity, Connect, Payments, Tax, Sigma, Financial Connections, Data pipeline).
- Account settings also hold: account details and health, public business information, payouts, legal entity, custom domains, PCI compliance + attestation, document view/upload, legacy exports, and beta features.
- The Dashboard's first sidebar section is action-oriented: Home (customizable analytics widgets — "Add" under Your overview, select/unselect, Apply — plus important notifications like unresolved disputes and identity verifications), Balances, Transactions, Customers, Product catalog, and Shortcuts (pinned + recently visited pages; pinning after visiting). Secondary products hide behind a "More" menu.
- **Teams:** bulk invites (multiple email addresses at once, assigned the same roles simultaneously); users can hold multiple roles per account; "Grant the lowest permission required by the user to perform their job"; invites expire after 10 days; roles editable later via the overflow menu; restricted role presets exist (View-only; Support specialist limited to refunds and disputes).
- The account docs tree surfaces the full model as siblings: User roles / **Custom roles** / Organizations / Multiple separate accounts / Linked external accounts / Settings / **Approvals** / Profile / Branding / Statement descriptors / Custom email domain / Custom domain / **Single sign-on** / Stripe Verified.
- **Organizations:** multiple Stripe accounts (kept separate for regulatory/financial reasons) centralized for reporting, operations, and team management; org mode aggregates transactions across accounts (filter by account) and splits customers into shared/unshared lists.
- **Workbench** (enabled under Beta features) is the monitoring counterpart: integration performance and health, API + webhook usage, API version upgrades, and request logs of every successful/failed request, with API errors filterable by endpoint or type.
- Dashboard ergonomics: "?" lists available keyboard shortcuts; browser support is an explicit policy (last 20 major versions of Chrome/Firefox/Edge, last 4 of Safari).
- SSO/SCIM (from the security notes): SAML 2.0 SSO + SCIM provisioning; support requests must be authenticated.
- **Security history:** team-member account activity logged for the past 180 days.
- Team communications: @mentions in payment notes (email with a link to the payment), per-user email notification preferences (successful payment, application fee collected, disputed payment, elevated-risk marking, mention, incorrect invoice amount, webhook delivery failure), and Workflows automation for conditional multi-step email logic.

## Test/live mode separation

- Two sandbox kinds: a legacy test-mode sandbox (one per account, **shares settings with live**, undeletable) and up to five **general sandboxes** (settings copied from live at creation then fully isolated; own access control — Private / Developer / All team members; deletable). New accounts start in a sandbox; new integrations are told to use general sandboxes.
- Creating a sandbox surfaces copyable test credentials and the sandbox account ID; access is changed via the overflow menu; optional Billing simulations "move time forward" so resources change state and trigger webhook events (test clocks — time as a controllable test dimension).
- **Keys determine mode, not the Dashboard** — "Being in a sandbox in the Dashboard doesn't affect your integration code"; objects are mode-locked (a test Product can't be part of a live payment); go-live = swap keys and recreate objects with the same IDs.
- **Danger communication:** changing settings while in the test-mode sandbox can also change them in live mode — many Dashboard pages show "a notification box and disable live mode settings" (banner + field disabling); when no notification is shown, assume changes affect live mode.
- The **account picker** is the top-level mode/navigation mechanism; the API-keys page carries its own page-scoped sandbox/live toggle mirroring it.
- Test data deletion runs from a review dialog listing all test objects (irreversible; sandboxes temporarily unusable during deletion); customer emails are suppressed by default in sandboxes; the mobile app is live-only.

## Sensitive-action authentication

- Creating a secret key requires **step-up** authentication: a verification code sent by email or text before the dialog proceeds.
- One-time live-key reveal with a forced "note where you saved it" moment; sandbox keys always visible (test keys not sensitive).
- Agent-tagged restricted keys add **approval rules**: a designated reviewer must approve sensitive actions (payouts, refunds, account configuration changes) before they execute.
- Dashboard MFA for sensitive actions, ranked honestly: passkeys/hardware keys over TOTP over SMS ("last resort").
- Destructive credential actions are confirm-dialog gated (Expire key, Rotate key, Restore access each require explicit confirmation), and publishable keys can't be expired — safety rails matched to reversibility.

## Restricted keys and access policies

- Restricted keys (rk prefix) are permission-scoped, unlimited in number, and recommended over full-access secret keys for live use.
- Provider-managed keys are issued and rotated by hosting platforms on the merchant's behalf — a managed-credential tier distinct from user-created keys.
- **Access policies** attach to keys: IP/CIDR allowlists, or advanced policies (ASN allow, country allow, blocking anonymous VPNs, public proxies, residential proxies, Tor exit nodes; combined with AND logic); unauthorized use is blocked and the owner notified; policy updates apply immediately to all assigned keys.
- Keys unused for transfers/payouts for >180 days are access-limited until an explicit Restore; rotation supports a ≤7-day dual-active grace period.

## PaySwap implications (Directive B §13)

- TEST MODE / LIVE MODE — and TESTNET / MAINNET where applicable — must **never be visually ambiguous**, and no test transaction may appear to be a real financial transaction. Stripe's ingredients to copy: a mode infix embedded in credential names, mode-locked objects, banner + field disabling on bleed-prone pages, the account picker as the single mode switch, and live-only mobile.
- Mirror the sandbox hierarchy: isolated general sandboxes with their own access control for local dev/CI/staging, not a single shared test account.
- Adopt step-up authentication for sensitive actions (credential creation, payout configuration) and agent-key approval rules for AI-agent access.
- Model team access as lowest-permission-by-default with time-boxed invites, custom roles, and organization-level aggregation for multi-account merchants.
- Access policies (geo/ASN/Tor blocking) on PaySwap connector credentials are the direct analog of Stripe's key policies.
- Provide a Workbench-style integration-health surface for PaySwap merchants: connector request logs, webhook delivery status, and version-upgrade guidance in one monitoring place.

## Not observable from static content

Live Dashboard settings screens (Phase 2 territory under an authenticated window); the User roles and Custom roles permission matrices (sub-pages not fetched); approval-rule configuration UI.

## Cross-references

Related files in this set: `public-pages.md`, `developers.md` (API conventions, webhook secrets, sandboxes), `risk.md` (MFA ranking, audit posture), `onboarding.md` (account progression, go-live checklist), `dashboard-pages.md` (settings pages), `responsive.md` (mobile live-only), `pay-swap-ux-mapping.md`, `README.md`.

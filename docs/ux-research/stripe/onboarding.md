Status: PUBLIC-SURFACE RESEARCH — 2026-10-03 (P4-W1-003 Phase 1) — source: public Stripe docs via automated extraction, no authentication; authenticated dashboard survey is Phase 2 (operator-gated)

# Stripe account onboarding and go-live — progressive KYC, cached checklists, team invites

Sources: R3 `notes-account-onboarding.md` (docs.stripe.com/get-started/account, /account/set-up, /account/checklist, /checklist/go-live, /account/teams) + R3 SUMMARY §f; test-mode context from `notes-test-mode.md`.

## Onboarding progression model (explicit)

1. **Create account** → immediately usable in testing — "simulate transactions and use all Stripe features without moving any money." New accounts land in a sandbox by default.
2. **Set up / verify** the business to accept real payments: business/product/relationship info in the Dashboard; KYC framed as "Regulators and financial partners require it."
3. **Progressive verification:** "As you use more Stripe services, we might request additional information" — KYC arrives per service, on demand, not all at once.
4. **Activation requirements per service** gate live-mode use; then the **go-live checklist** governs the integration switch.

## Key rules and constraints

- **Origin country immutable after live activation** — a different country requires a new account.
- **Public business information** (customers see it on statements/emails): business name + website URL, support email/phone/address, support site URL, statement descriptor. Provided during verification, editable in Account settings. Framing: unrecognizable charges → disputes — public info is dispute-prevention evidence.
- Statement descriptor constraints: 5–22 chars, ≥5 letters, no < > ' " special chars; the issuer may append business info.
- Account ID ≠ account name (found in Account and Personal details settings). Close anytime; dormant accounts recommended for financial data/disputes.

## Account checklist (safety/security, 7 items)

- 2FA with explicit ranking: passkeys/security keys > authenticator app > SMS last-resort, with a SIM-swap warning.
- Confirm statement descriptor + public information.
- Email notifications per user (minimum recommendation: successful charges + disputes); SMS for critical account-health updates.
- Fraud/dispute prevention (review payments, evidence ready, card-testing prevention).
- **Review bank account information** — "Incorrect bank information is a common cause of payout delays"; multi-currency default; preferred payout schedule (recommended default: daily).
- Team member access: role-based, never share logins, require 2FA, SSO for central enforcement.
- Industry restrictions: Prohibited & Restricted businesses list (restricted → extra documentation; prohibited → cannot use Stripe).

## Checklist UX mechanics (notable pattern)

- Checkbox state is "stored within your browser's cache" — client-side persisted progress, no login required to use the checklist.
- Progressive personalization: "You can log in to see some of your current settings" — docs hydrate from account state when authenticated.
- Companion checklists cross-linked (integration go-live; website payment best practices).

## Teams and permissions

- Invite flow: Team tab → Add member → emails (space/comma separated; bulk same-role assignment) → role selection guided by "Grant the lowest permission required" → review → Send invites.
- **Invites expire after 10 days.** Users can hold multiple roles; edits via overflow menu.
- **Security history: 180 days** of team-member account activity.
- **@mention team members in payment notes** → email notification with a link to the payment (collaboration inside object detail pages).
- Default email-notification events include: successful payment, application fee collected, disputed payment, elevated-risk payment, mentioned in note, incorrect invoice amount, webhook delivery failure. Workflows (visual builder) automates multi-step conditional email.
- Role restrictions observed elsewhere: View-only and Support specialist roles are restricted in the mobile app (`responsive.md`).

## Go-live checklist (developer-facing)

- Set the API version (warning callout: account API settings govern unless overridden; upgrade via Workbench).
- Handle edge cases: incomplete/invalid/duplicate data (retry the same request); non-developer test pass.
- Error handling: distinguish card_error (user-facing decline) from invalid_request_error (your backend bug) — "pay close attention to what information you show to your users."
- Logging review (Stripe logs every request; keep own logs; no card details/PII).
- **Not relying on test objects:** sandbox objects are unusable live; recreate with the same ID values (not names) so code keeps working.
- Register production webhooks (separate test + live endpoints; handle delayed, duplicate, unordered notifications).
- **Change and secure API keys** before go-live (rotate; no keys in code).
- Framing: live and sandbox environments "function as similarly as possible. Switching between them is mostly a matter of swapping your API keys."

## PaySwap implications

- Progression (create → sandbox-ready → verify → activate) maps to PaySwap merchant onboarding: full feature availability in TEST/TESTNET immediately, KYC/compliance gating per capability (merchant-crypto activation, stablecoin rails), never a monolithic verification wall.
- Per-service progressive verification = PaySwap capability gating by compliance state (`connect.md`, `crypto.md` request→review→enable flows).
- Immutable properties (origin country) must be stated before commitment, with a visible, disabled affordance (`customers.md` currency-lock pattern).
- Public business info → dispute evidence is the exact chain PaySwap needs for merchant-identity evidence packets (statement descriptors, support contacts feeding dispute/chargeback responses).
- Browser-cached checklist progress: zero-backend onboarding aids that survive reloads and require no account — cheap pattern for PaySwap's merchant setup wizard.
- Team model (bulk invites, 10-day expiry, lowest-permission default, 180-day security history, @mentions on objects) transfers directly to PaySwap organizations and approval flows.
- Go-live swap-keys step: PaySwap TEST→LIVE must be a first-class checklist moment (`settings.md`, Directive B §13).

## Honest gaps

- Actual verification-form field validation, in-Dashboard checklist rendering, and invite email contents are not observable from static docs; the authenticated onboarding wizard is Phase 2.

## Cross-references

Related files in this set: `settings.md` (team/roles/step-up auth, modes), `developers.md` (keys, webhooks, sandboxes), `balances.md` (bank-info review, payout delays), `risk.md` (dispute prevention, KYC posture), `connect.md` (networked onboarding for platforms), `workflow-patterns.md` (signup + go-live workflows), `navigation.md`, `pay-swap-ux-mapping.md`, `README.md`.

Status: PUBLIC-SURFACE RESEARCH — 2026-10-03 (P4-W1-003 Phase 1) — source: public Stripe pages/docs via automated extraction, no authentication

# Stripe developer surfaces — docs IA, API conventions, key UX, webhooks, test mode

Sources: R2 notes for `docs.stripe.com` (home) and `docs.stripe.com/api`; R3 notes for API keys, test mode/sandboxes, and Dashboard basics. **Honest input note:** R3's planned `notes-webhooks.md` was never written (its session broke after nine notes files); webhook facts below come from R3's persisted summary plus the raw fetch of `docs.stripe.com/webhooks`. Key formats are described by prefix only — no key values appear anywhere in this set.

## Docs IA and the getting-started ladder

- Top-level sidebar: Get started / Payments / Revenue / Risk / Data / Money management / **Stablecoins** / Embedded finance / Developer resources / More / APIs & SDKs / Help — Stablecoins is a first-class peer of Payments; crypto also sits under Payments as a payment method and in "Browse by product" as "Accept, onramp, or pay out in crypto".
- Getting-started ladder on the docs home: quick links → a test-keys widget ("Sign in or create an account to load your test API keys") → a task-chip "Try it out" API explorer rendering live CLI samples + JSON inline (sign-in only needed to edit real requests) → quickstarts → "Build on Stripe with AI".
- **LLM affordances:** "View as Markdown" (append `.md` to any docs URL), "Copy for LLM", "Ask about this page / Ask AI", llms.txt, "Install tools"; per-section variants on API reference pages; Markdoc authoring. Machine consumers are first-class docs users — R2 relied on `.md` views to read tabbed content invisible in server HTML.

## API conventions (docs.stripe.com/api)

- REST with "predictable resource-oriented URLs, accepts form-encoded request bodies, returns JSON-encoded responses"; one object per request (no bulk updates); HTTPS only.
- Auth: HTTP Basic (key as username) or Bearer; "The API key that you use to authenticate the request determines whether the request runs in live mode or in a sandbox" — mode is a property of the credential, not the Dashboard location.
- **Idempotency:** Idempotency-Key header, up to 255 chars (V4 UUIDs suggested), POST only; the first result is saved "regardless of whether it succeeds or fails"; keys pruned after 24h; mismatched parameters on reuse → error.
- **Errors:** typed object — type enum (api_error | card_error | idempotency_error | invalid_request_error) + code + decline_code + message + param; `param` maps to UI: "display a message near the correct form field". HTTP semantics: 402 Request Failed, 409 idempotency conflict, 424 external-dependency failure, 429 → exponential backoff.
- **Expand:** `expand[]`, dot-nested recursion, "up to a maximum depth of four levels"; list expansions via `data.`; the v2 `include` parameter trims null-default payloads.
- **Pagination:** cursors (starting_after / ending_before, mutually exclusive), limit 1–100 default 10, has_more; auto-pagination in SDKs; search uses page/next_page with its own query language (total_count accurate to 10,000); v2 has a different pagination interface.
- **Versioning:** monthly no-breaking-change releases since 2024-09-30.acacia; named majors twice a year (Basil; current 2026-09-30.endive); Stripe-Version header override; account default version set in Workbench; webhooks default to the account version unless set at endpoint creation.
- **Enums:** closed vs open; open enums grow over time as backward-compatible changes — code defensive fallbacks (a default branch) and validate sent values against the supported set.
- Metadata: 50 keys × 40-char names × 500-char values; "Stripe doesn't use metadata—for example, we don't use it to authorize or decline a charge."
- v2 style: Bearer auth, preview version headers, `Stripe-Context` for recipient scoping, named restricted-key permissions, and a documented preview-registration endpoint taking preview slugs.

## API key UX (docs.stripe.com/keys)

- Key types by prefix: publishable `pk_` (safe to expose; tokenization only), restricted `rk_` (permission-scoped, unlimited count, recommended), secret `sk_` (unrestricted, discouraged for new use), organization-level `sk_org_` (multi-account), plus provider-managed keys issued by hosting platforms. A test/live mode infix is embedded in the key name itself.
- **One-time live reveal:** user-created live keys are shown once at creation — "Save the key value. You can't retrieve it later." — followed by a forced "Add a note" moment recording where it was saved. Sandbox keys always visible; publishable keys shown by default.
- **Step-up authentication:** creating a secret key requires a verification code sent by email or text before the dialog proceeds.
- **Rotation with grace:** rotate now or later; "both the old and new keys work for up to 7 days"; safe-rotation guidance (gradual rollout from a server subset, watch request logs, expire only at zero volume). Publishable keys can't be expired.
- **Inactivity limiting:** keys unused for transfers/payouts for >180 days get limited access, with an explicit Restore-access flow.
- **Access policies** (successor to IP restrictions): IP/CIDR allowlists or advanced policies (ASN, country, blocking anonymous VPNs, public proxies, Tor exit nodes) combined with AND logic; unauthorized use is blocked and the owner notified.
- **Agent-tagged restricted keys:** keys can be tagged "Authorizing agent access to your account"; designated reviewers must then approve sensitive actions (payouts, refunds, account configuration) — guarding against "agent mistakes, unexpected behavior, and hallucinations".
- Global Payouts rejects full-access live secret keys for live requests — restricted keys with named permissions are required there.
- The overflow (…) menu is the universal row-level action surface (expire / rotate / restore / view logs / edit).

## Webhooks (docs.stripe.com/webhooks)

- Model: **event destinations**, created from the Webhooks tab in Workbench (which replaces the Developers Dashboard): choose account → API version → event types → destination type "Webhook endpoint" → URL + description. Up to **16 endpoints**; publicly accessible HTTPS required (tunnel tools or the Stripe CLI for local testing).
- Each endpoint gets a per-endpoint signing secret (whsec prefix; different secrets per test/live usage) — revealed and copied at creation.
- **Handler contract:** verify the Stripe-Signature header against the raw body; the handler must quickly "return a successful status code (2xx) before any complex logic" — and never manipulate the raw request body, or verification fails.
- **Retries:** live events retry for up to three days with exponential backoff; sandbox events three times over a few hours; manual resend via Dashboard ≤15 days or CLI ≤30 days; 3xx redirect responses are treated as failures.
- **Ordering not guaranteed:** dedupe by logging event IDs (not timestamps — distinct events can share one); some duplicates are separate Event objects, identified via the data.object ID + event type.
- **Secret rolling:** immediate expiry, or delayed up to 24 hours with dual-active secrets and one signature per secret.
- Verification layers: IP allowlisting + signature verification; replay attacks mitigated by a signed timestamp inside Stripe-Signature. Debugging via the Event deliveries tab (Delivered / Pending / Failed + per-attempt HTTP codes).
- Best practices: subscribe only to needed event types; process asynchronously via queues; exempt the webhook route from CSRF protection; thin (v2) vs snapshot (v1) event styles; Connect and Organizations destination variants exist.

## Test mode / sandboxes (docs.stripe.com/test-mode)

- Two kinds: a legacy test-mode sandbox (one per account, shares settings with live, undeletable) and **general sandboxes** — up to five, isolated settings/data copied from live at creation, own access control (Private / Developer / All team members), deletable; "For new integrations, use a general sandbox instead".
- "All Stripe API requests occur in either a sandbox or live mode. API objects in one mode aren't accessible to the other" — mode-locked objects; keys determine mode.
- New accounts start in a sandbox; go-live = swap keys and recreate objects with the same IDs.
- Dashboard danger communication: settings changes in the test-mode sandbox can bleed into live mode — many pages show "a notification box and disable live mode settings" (banner + field disabling); if no banner is shown, assume changes affect live.
- Test data deletion (review dialog, irreversible; sandboxes temporarily unusable), test email suppression by default, test clocks (Billing time simulation), payout/dispute/early-fraud-warning simulation primitives; the mobile app is live-only.

## PaySwap implications

- Docs IA precedent: make crypto a first-class top-level docs section, not a sub-page of payments.
- Copy the error contract: typed errors + param→form-field mapping + decline codes; PaySwap's translation layer should map provider errors to field-level UX the same way.
- Adopt idempotency (bounded key retention), cursor pagination, expand depth caps, and open-enum defensive guidance as PaySwap connector API conventions.
- Key UX transfers directly to PaySwap connector credentials: prefix-visible key types, mode infix in the credential name, one-time reveal + note-to-self, step-up auth, rotation grace windows, inactivity limiting.
- Agent-tagged keys with approval rules are the reference pattern for PaySwap AI-agent authorization (Directive B §14).
- The webhook contract (fast-ack, raw-body preservation, event-ID dedupe, bounded retries, rolling dual secrets) should be the template for PaySwap provider-webhook ingestion.
- Sandboxes with isolated settings + keys-determine-mode + banner/field-disabling map onto PaySwap TEST/TESTNET vs LIVE/MAINNET separation (Directive B §13; see `settings.md`).

## Honest gaps

Workbench UI, logged-in personalized docs, and interactive request execution are not observable from static content; the webhooks raw extraction truncates near the end of the replay-attack section — no facts were inferred beyond the truncation point.

## Cross-references

Related files in this set: `public-pages.md`, `crypto.md` (release phases, preview registration, testnet testing), `risk.md` (key security posture), `settings.md` (sandboxes, key management, modes), `apps.md` (CLI, Extension SDK), `onboarding.md` (go-live checklist), `component-patterns.md` (code-sample switchers), `pay-swap-ux-mapping.md`, `README.md`.

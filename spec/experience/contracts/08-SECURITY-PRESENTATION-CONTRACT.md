Status: NORMATIVE CONTRACT v1 — 2026-10-06 — derived from directive §11 (security UX substantially better than a raw wallet) + Phase 2 evidence (masked keys, CVC-check display, environment banner, statement-descriptor expectation). Compliance MANDATORY.

# PaySwap security-presentation contract

## 1. Principle

Security is explained **in human language, in place, at the moment it matters** — embedded in the transaction lifecycle, not quarantined in a security center. The user should never need to understand cryptography to be protected by it, but should always be able to see, in plain words, what is being protected and how.

## 2. Environment & mode safety (directive §13)

- Persistent TESTNET/MAINNET banner on every surface (nav contract §2): environment name + human promise + inline switch. **Test and live are never visually confusable** — distinct banner + badge + account-switcher chip.
- Hosted/payment pages carry the environment badge so payers can distinguish demo links.
- Test-mode CTAs are live before activation ("Create a test payment") — the user rehearses safely.

## 3. Secrets & credentials

- Keys render **masked by default** (prefix + "…" + last chars) everywhere, including Home surfacing; reveal is an explicit per-row action, never persisted across sessions (evidence: Stripe Home API-keys card + apikeys page).
- Secret entry (keys, recovery phrases, wallet signing) happens only in the secure embedded component; full secrets never appear in page DOM, screenshots, or logs.
- "Suspicious API activity" is a first-class tab next to the keys (evidence) — PaySwap: an "Unusual activity" view adjacent to developer keys.

## 4. In-flow security affordances (normative)

1. **Confirmation restatement**: every money-moving button states amount + asset + destination ("Send 25 USDC to Alice").
2. **Counterparty assurance**: destination rendering shows verified name/address book entry, or an explicit "New recipient — not in your address book" warning chip.
3. **Checks displayed as checks**: method-detail sections show verifications as pass/fail rows (evidence: "CVC check: Passed") — PaySwap: "Signature verified · Allowance confirmed · Contract audit status: …".
4. **Attack explanations in human language** (directive §11): when a risk is detected, the message explains the attack, not the protocol: "This site is asking for a signature that could move your funds — signing would let it spend your USDC. Only sign if you initiated this."
5. **Simulation/preview before irreversible actions**: destructive or irreversible flows (drain approvals, contract interactions) show a plain-language simulation of what WILL happen, then require explicit confirm.
6. **Risk sections never fabricate**: when live data is required, say so (evidence: "Risk insights are only available for live data").

## 5. Statement & attribution clarity

- Success screens set wallet-history expectations (evidence: "A payment to Stripe will appear on your statement"): PaySwap: "This will appear as <descriptor> in your wallet app."
- Descriptors/notes are editable pre-send with visible formatting (evidence: statement-descriptor auto-format).

## 6. Team & authorization

- Settings group "Team and security" carries a scope sentence (evidence) — roles, sessions, authorized apps in one place; sensitive actions re-authenticate (evidence: Phase 1 `settings.md`).

## 7. Acceptance

- No surface ever displays a full secret.
- Every irreversible action passes the simulation + restatement gates.
- Risk messages follow the human-language attack explanation pattern (spot-check battery in §20 certification).
- Environment confusability test: screenshots of test vs live surfaces are distinguishable by automation (banner detection) 100% of the time.

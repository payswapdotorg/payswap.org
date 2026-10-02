# Development State

Machine-readable coordination state: spec/development-state/v2-work-order-state.json

The TL updates this file whenever a Work Order changes status, a dependency becomes satisfied, an accepted commit changes the frontier, or the architecture/promotion gate changes.

This is executable coordination state, not a diary.

Rules:
- maximum 3 active Work Orders;
- active Work Orders are pairwise-disjoint;
- no completion claim without repository evidence;
- blocked reasons reference an exact dependency or invariant;
- accepted Work Orders record commit SHA and verification evidence.

Phase 2 (REAL PROVIDER ACTIVATION + GLOBAL COVERAGE, opened 2026-10-02):
- v2-work-order-state.json is the FROZEN HISTORICAL Phase 1 record (21/21 COMPLETE; production deployment certified at 7da466d with the runtime plane bound). It is never rewritten; Phase 2 creates new activation/release evidence.
- phase-2-state.json is the ACTIVE Phase 2 coordination state — the TL derives activation only from it (operator-recorded structure: spec/phase-2/*, dependency graph, work items P2-W1/W2/W3-*).
- provider-probes-20261002.json is the live probe evidence backing every coverage claim (TL-executed 2026-10-02: Stripe VERIFIED incl. PayPal-on-Stripe ELIGIBLE + GHS negative datum; Paystack VERIFIED GHS/NGN/KES/ZAR; Flutterwave VERIFIED 31 wallets incl. USDC/USDT/RLUSD; MTN MoMo BLOCKED — subscription key rejected, honest operator-input status; Stellar testnet READY; WhatsApp/OpenSanctions VERIFIED; Resend UNVERIFIED-SEND).
- coverage-matrix.json is the seeded executable coverage matrix (evidence-backed rows only; gaps recorded as Gap Cases).
- Vault reconciliation: raw credential values live only in the operator vault; repo + manifests carry PROVIDER_<NAME>_CREDENTIAL_REF references (Stripe / MTN_MOMO / FLUTTERWAVE / PAYSTACK / STELLAR_TESTNET bound 2026-10-02).

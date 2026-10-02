# Universal Money Interface Work Order Catalog

All work items are implementation contracts. The TL dispatches only from the active frontier in phase-4-state.json.

## P4-W1-001 — Onchain domain and capability kernel
Owner: Worker 1
Depends: Phase 3 complete
Implement chain/account/protocol/asset abstractions, chain-family neutral execution contracts and GenericContractInteractionCapability using the existing Capability/Connector model. Prove scope, identity, observation and validation. No private-key material; no parallel ledger.

## P4-W1-002 — Wallet/signer authorization + blockchain security kernel
Owner: Worker 2
Depends: Phase 3 complete
Implement authorization requests, signing requests, simulation results, expected state/balance deltas, scoped delegation, wallet/signer adapters and deterministic guards for chain/asset/amount/destination/approval/expiry. Security agents cannot override BLOCK. No raw signing secrets.

## P4-W1-003 — Merchant crypto contracts + Stripe UX research
Owner: Worker 3
Depends: Phase 3 complete
Define crypto PaymentIntent/CheckoutSession/acceptance policy/settlement/refund contracts. Survey stripe.com, stripe.com/docs and dashboard.stripe.com using isolated browser and user-assisted official Google login. Produce a sanitized UX translation artifact covering navigation, payments, balances, customers, Connect, reports, risk, developers, apps, settings, test/live and recovery. Never store credentials or secret session data.

## P4-W2-001 — Multi-chain adapter SDK
Owner: Worker 1
Depends: W1-001,W1-002
Implement provider-neutral chain lifecycle: observe → prepare → simulate → authorize → broadcast → observe → finality → reconcile → evidence. Initial families: EVM, Solana, UTXO. No single-vendor core dependency. UNKNOWN/reorg/finality explicit.

## P4-W2-002 — DEX/protocol extensions + best execution
Owner: Worker 2
Depends: W1-001,W1-002
Implement multiple independent DEX/aggregator/intent-network capabilities, route comparison and optimization using net executable outcome. Uniswap is an extension, not core. Preserve provider-native baselines. Material route changes invalidate authorization.

## P4-W2-003 — Merchant checkout + Stripe settlement
Owner: Worker 3
Depends: W1-003,W2-001
Implement merchant onboarding, crypto checkout, payment lifecycle, wallet authorization, webhooks, refunds where supported and two explicit Stripe modes: native Stripe crypto capability and PaySwap external settlement. Never synthesize Stripe balance effects.

## P4-W3-001 — Lab + mixed-rail Organizations
Owner: Worker 1
Depends: W2-001,W2-002
Make certified onchain capabilities available to Reality Engineering Lab Organizations/strategies and mixed fiat/onchain route simulation without production financial effect.

## P4-W3-002 — Onchain FinancialOpportunity
Owner: Worker 2
Depends: W2-002,W3-001
Extend FinancialOpportunity to onchain opportunities with evidence, capital, expected return, liquidity, exit path, fees, contract/oracle/bridge risk, lock-up and maximum-loss constraints. Discovery never authorizes execution.

## P4-W3-003 — Adversarial onchain security + threat intelligence
Owner: Worker 3
Depends: W1-002,W2-002
Implement threat analysis for approvals/permits, spenders, fake tokens, restrictions, proxies/admin, oracle/bridge, MEV, chain/address confusion, signatures/replay, balance/state deltas and stale simulation. Add adversarial transaction agent; deterministic gate remains authoritative.

## P4-W4-001 — Mixed fiat/onchain route compiler
Owner: Worker 1
Depends: W3-001,W3-002
Compile a single Money Movement Intent into mixed routes such as crypto→DEX→stablecoin→off-ramp→bank, fiat→PSP→stablecoin→chain, chain A→bridge→chain B and eligible crypto→Stripe settlement. Preserve every leg's authorization/evidence lineage.

## P4-W4-002 — Universal user + merchant UX
Owner: Worker 2
Depends: W1-003,W2-003,W4-001
Build the PaySwap interface as if Stripe were designing it: outcome-level Pay/Receive/Move/Convert/Checkout plus Payments/Accounts/Activity/Opportunities/Connections/Security/Developers/Settings, progressive disclosure, command/search, security explanations and honest UNKNOWN/error states. Use repository Stripe research as implementation authority. Browser-verify desktop/mobile.

## P4-W4-003 — Production certification + release
Owner: Worker 3
Depends: W4-001,W4-002,W3-003
Run complete existing battery plus multi-chain, signer, DEX, merchant crypto, Stripe settlement, mixed-route, opportunity and adversarial suites. Use agent-browser on real rendered pages. Record exact commit, tests, integration evidence, browser traces/screenshots, deployment IDs/URLs and rollback. Phase 4 cannot be COMPLETE without all gates in state JSON.

## Global acceptance

Every Work Order requires source inspection, exact test commands, integration evidence where applicable, security/evidence/idempotency/reconciliation checks and explicit limitations. No claim is accepted from prose alone.

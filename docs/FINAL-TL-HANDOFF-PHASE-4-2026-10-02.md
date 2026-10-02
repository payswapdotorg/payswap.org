# Final TL Handoff — Universal Money Interface / Onchain Plane

Date: 2026-10-02
Architecture: 1.6-frozen-2026-10-02
Repository: payswapdotorg/payswap.org

## Start condition

Do not dispatch Phase 4 implementation until Phase 3 P3-W1-003, P3-W2-003 and P3-W3-003 are verified COMPLETE in repository state.

## Mission

Make PaySwap the main interface for money movement while keeping fiat and blockchain as peer settlement-rail families.

Users and agents express economic intents. PaySwap discovers capabilities, evaluates eligible Organizations/routes, applies security and authorization, executes, observes and reconciles.

## Merchant target

Provide a Stripe-class crypto payment product:
- merchants price in fiat;
- customers can pay eligible crypto;
- PaySwap handles route discovery and security;
- settlement can use native Stripe crypto capability where actually supported or an explicit external PaySwap settlement route;
- no synthetic Stripe balance credit.

## UX mandate

A dedicated worker must survey:
- stripe.com and relevant first-party product pages;
- stripe.com/docs;
- dashboard.stripe.com and accessible authenticated sections.

Use the official browser login with user-assisted Google authentication. The user performs Google/MFA actions. The worker uses only the authorized isolated browser session.

No credentials, cookies, tokens, API keys, customer data or secret session material may be extracted or committed.

Build PaySwap as if Stripe were the product organization designing it:
- Stripe-grade information architecture;
- operational clarity;
- search/command;
- object relationships;
- forms and validation;
- status/error/recovery;
- progressive disclosure;
- responsive/accessibility;
- merchant/developer workflows.

Do not copy proprietary code, assets or branding.

## Universal execution

Support:
- external wallets;
- scoped signers/smart accounts;
- multi-chain execution;
- DEX/aggregator/intent-network extensions;
- generic contract interaction under strict security gates;
- mixed fiat/onchain routes;
- onchain opportunity discovery.

## Security

Every supported consequential onchain write must be subject to:
intent validation → simulation when supported → deterministic policy/security → user-readable expected-state diff → authorization → pre-broadcast re-check → execution → finality/observation → postcondition verification → reconciliation.

Adversarial agents may identify tricks but cannot override a deterministic BLOCK.

## Lab

The Reality Engineering Lab must be able to use certified onchain capabilities in candidate Organizations and compare them with fiat-only and mixed organizations.

## Browser/UX acceptance

Major UI journeys must be verified with agent-browser on desktop and mobile. The TL inspects actual rendered evidence. No dead buttons, fake financial success states, hidden test mode or console errors.

## TL protocol

Before dispatch:
1. verify current main SHA;
2. verify Phase 3 completion;
3. read this handoff, ADR-007, architecture, graph, Work Order catalog and state;
4. inspect source/tests/callers directly.

During execution:
- activate max three pairwise-disjoint Work Orders;
- monitor → harvest → review → request changes/approve → merge;
- update state after each accepted merge;
- never treat agent reports as evidence without repository verification.

The TL is an orchestrator, not a fourth worker.

## Exit

Phase 4 is COMPLETE only when every phase-4-state gate has repository evidence and a reproducible release record.

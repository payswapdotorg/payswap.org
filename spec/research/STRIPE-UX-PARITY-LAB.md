# Stripe UX Parity Lab

Status: BASELINE RESEARCH — 2026-09-30

## Purpose

Stripe.com is the main external UX reference for PaySwap's information architecture and product coherence.

This document is not a visual-copy specification. It records patterns to study and adapt.

## Public research baseline

Stripe's current product catalog groups its offering into Payments, Risk, Revenue, Data, Money Management, Embedded Finance, Crypto and Stripe Platform, and currently lists 53 products. Its public site emphasizes a unified stack while exposing distinct product areas. citeturn654676search5

Stripe Connect currently positions payments, payouts, invoicing, tax, financing, card issuing and other financial services as components of an integrated platform/marketplace stack. citeturn654676search3turn654676search4

Stripe's current agentic-commerce materials describe Shared Payment Tokens, Link's agent wallet, delegated checkout and machine payments. SPTs are scoped by seller, amount and time window, while Link's agent wallet keeps underlying payment credentials away from the agent. citeturn417142search0turn417142search1turn417142search9

Stripe's 2026 materials also describe agentic transactions that can use fiat/card-based methods and stablecoins, and a broader machine-payments direction. citeturn417142search3turn417142search2

## PaySwap adaptation targets

Study these patterns:
- simple top-level information architecture;
- coherent workspace/account concepts;
- progressive disclosure;
- strong primary action;
- operational tables with useful filters;
- detailed object pages;
- clear money/status hierarchy;
- evidence and audit links;
- explicit failure/UNKNOWN states;
- developer-first API documentation;
- composable platform products;
- agent permissions and spending visibility;
- responsive/mobile coherence.

PaySwap-specific additions:
- Goals and Opportunities are first-class;
- Capability Graph is discoverable;
- Agents are collaborators, not the center of the user mental model;
- users can choose or delegate funding across rails;
- smart-contract services should feel like ordinary product capabilities;
- participation/incentive programs have transparent attribution;
- evidence is inspectable without requiring protocol expertise.

## Authenticated survey procedure

W3-001 repeats this procedure when the repository is actively implemented:

1. Open the public Stripe product/navigation surfaces.
2. Record public information architecture and journey patterns.
3. When a target Dashboard flow requires authentication, pause at the login boundary.
4. Have the authorized user authenticate in the browser session.
5. Continue surveying only the authorized account surfaces needed for architecture research.
6. Save only structural notes and non-sensitive screenshots.
7. Never save passwords, session cookies, payment details, customer data or private identifiers.
8. Record source URL, date, surface, finding and proposed PaySwap adaptation.

## Non-goals

Do not copy Stripe source code, private Dashboard data, proprietary text wholesale, customer information or hidden implementation details.

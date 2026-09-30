# ADR-003 — PSP-Neutral Merchant Connector Network

Status: ACCEPTED
Date: 2026-09-30

## Decision

A merchant may retain its existing PSP and connect PaySwap through a single PSP-neutral connector.

The connector exposes PaySwap as an additional payment method, processor, orchestration endpoint or external-payment record depending on what the PSP supports.

Stripe is one implementation example. The domain must not contain Stripe-specific primitives.

The canonical merchant promise is:

"Integrate PaySwap once, then expose every payment capability the merchant is legally and operationally entitled to accept through PaySwap."

## Constraints

A PSP connection does not magically make every PaySwap rail available through the PSP. PaySwap must have a real, authorized capability and route the payment through the appropriate underlying provider/rail.

All external results are reconciled into PaySwap's canonical attempt/finality model.

## Consequences

- Existing merchants can add PaySwap without rebuilding checkout around each new rail.
- Additional PSPs can be integrated without changing the financial domain.
- PaySwap can become the universal rail/capability layer behind heterogeneous PSP stacks.

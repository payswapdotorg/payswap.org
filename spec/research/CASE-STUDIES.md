# Architecture Case Studies and External Anchors

Research checked: 2026-09-30.

These references are design inputs, not authorities for PaySwap.org. The repository architecture and invariants remain authoritative.

## CHIPS
The Clearing House describes CHIPS as using queuing, bilateral/multilateral netting and continuous intraday settlement to offset payments before settlement and reduce funding needs.

https://www.theclearinghouse.org/payment-systems/chips
https://www.theclearinghouse.org/payment-systems/Articles/2026/04/Modern-Liquidity-Management-and-the-Strategic-Role-of-the-CHIPS-Network

Lesson: netting and temporal liquidity belong in strategy/routing.

## CLS
CLS describes multilateral netting as reducing the number/value of payments needed to settle obligations and reports funding-requirement reductions above 96% for CLSSettlement members. CLS also uses PvP for FX settlement.

https://www.cls-group.com/products/settlement/clssettlement
https://www.cls-group.com/products/processing/clsnet/netting-for-businesses/

Lesson: settlement-risk and liquidity optimization must be first-class.

## Aave
Aave documents supply/borrow incentives, points, eligibility criteria and external funding sources. Current Umbrella documentation describes target-liquidity-sensitive emissions.

https://www.aave.com/docs/aave-v4/liquidity/incentives
https://www.aave.com/docs/aave-v3/concepts/incentives
https://www.aave.com/docs/aave-v3/umbrella

Lesson: incentives should be role-specific, eligibility-aware, budgeted and able to react to target participation.

## Ethereum proof-of-stake
Ethereum documents rewards for useful participation, penalties for missed participation and slashing for specified malicious behavior.

https://ethereum.org/developers/docs/consensus-mechanisms/pos/rewards-and-penalties/

Lesson: rewards and economic penalties can be tied to objectively observable contribution and security behavior.

## A2A
A2A 1.0 defines an open model for independent agents to discover capabilities and collaborate without exposing internal agent state.

https://a2a-protocol.org/v1.0.0/
https://a2a-protocol.org/dev/specification/

Lesson: agent interoperability belongs at an adapter boundary.

## MCP
The July 2026 MCP specification added a stateless core, authorization hardening, extensions and more deterministic discovery/cache behavior.

https://blog.modelcontextprotocol.io/posts/2026-07-28/

Lesson: MCP is a provider-neutral agent/tool boundary, not the financial authority.

## PayBridge
PayBridge models liquidity assets as rail/currency nodes in an FX-aware graph and uses an economic compilation/planning pipeline. Its README explicitly states that settlement is simulated and no real funds move.

https://github.com/pectoraux/paybridge

Lesson: reuse graph/compiler ideas, but never copy simulated settlement into production.

## PaySwap3
PaySwap3 provides deterministic financial state, evidence-oriented protocol boundaries, capability/extension lifecycle, advisory agents and merchant settlement primitives.

https://github.com/payswapdotorg/payswap3

Lesson: retain strict authority boundaries and UNKNOWN/reconciliation behavior.

## Sporta
Sporta's Reality Engineering Lab and organization model provide domain packs, world simulation, fault injection, organization search, evaluation, shadow/canary and promotion patterns.

https://github.com/payswapdotorg/sporta

Lesson: separate learning/simulation from production authority.

## Ethereum account abstraction
Ethereum's account-abstraction documentation describes smart contract wallets with programmable security, recovery, batching, and sponsored gas. ERC-4337 defines UserOperations, bundlers, factories and paymasters; EIP-7702 allows EOAs to delegate code with use cases including batching, sponsorship and privilege de-escalation.

https://ethereum.org/roadmap/account-abstraction
https://eips.ethereum.org/EIPS/eip-4337
https://eips.ethereum.org/EIPS/eip-7702

Lesson:
User Agents can hide wallet mechanics while session keys, spending limits and sponsored gas constrain authority. PaySwap should use these mechanisms as wallet capabilities, not as central custody.

## Stripe agentic commerce
Stripe's current agentic-commerce materials describe Shared Payment Tokens, Link's agent wallet, Delegated Checkout and machine payments. Stripe's product catalogue currently reports 53 products across payments, risk, revenue, data, money management, embedded finance, crypto and platform.

https://stripe.com/guides/agentic-commerce-primer
https://stripe.com/products
https://stripe.com/blog/giving-agents-the-ability-to-pay

Lesson:
PaySwap should model scoped payment credentials, agent funding, delegated checkout, merchant discovery and machine payments as provider-neutral capabilities. Stripe becomes one provider adapter rather than the network boundary.

## Provider-neutral PSP orchestration
Stripe's processor-agnostic guidance describes an orchestration layer between merchant software and multiple processors, routing payments by cost, geography, payment method, performance or availability.

https://stripe.com/resources/more/processor-agnostic-payments
https://docs.stripe.com/payments/mobile/custom-payment-methods

Lesson:
PaySwap's Merchant PSP Connector can place PaySwap alongside an existing PSP, while PaySwap remains responsible for only the additional capabilities/rails actually reachable and authorized.

## Arena
Arena models Agent Bodies as stable capability contracts, cognitive substrates as replaceable possessions and expert matching as qualification/evidence based.

https://github.com/payswapdotorg/Arena

Lesson: separate Body from Soul/model and make human expertise a reusable capability.

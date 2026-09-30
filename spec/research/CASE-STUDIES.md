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

## Arena
Arena models Agent Bodies as stable capability contracts, cognitive substrates as replaceable possessions and expert matching as qualification/evidence based.

https://github.com/payswapdotorg/Arena

Lesson: separate Body from Soul/model and make human expertise a reusable capability.

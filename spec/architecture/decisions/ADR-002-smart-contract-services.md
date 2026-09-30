# ADR-002 — Smart-Contract Services and Non-Custodial Wallets

Status: ACCEPTED
Date: 2026-09-30

## Decision

Smart contracts are first-class PaySwap Extensions. Once statically analyzed, benchmarked, security-reviewed and certified, their capabilities enter the Capability Graph and become available to the Lab for composition into candidate strategies and Agent Organizations.

PaySwap is non-custodial by default and does not take title to user funds.

If funds ever need to be held, the preferred implementation is a smart-contract custody/escrow capability in which PaySwap has no unilateral withdrawal path. Any upgrade/admin/governance power is explicit and affects certification.

User Agents hide blockchain operational complexity through SmartAccountCapability, session keys, policies, recovery and sponsored gas where supported.

## Rationale

Smart contracts can move economic logic from trusted intermediaries into verifiable execution. They do not eliminate all off-chain dependencies: fiat rails, identity, regulated functions, physical delivery, tax and some data require external capabilities.

Therefore the network represents both onchain and offchain services in one Capability Graph.

## Consequences

- Smart-contract developers gain a first-class extension path.
- The Lab can discover compositions that use certified contracts.
- Users can interact through familiar agent UX instead of raw wallets.
- PaySwap remains an orchestrator rather than a custodian.
- Contract security and economic risk become explicit certification dimensions.

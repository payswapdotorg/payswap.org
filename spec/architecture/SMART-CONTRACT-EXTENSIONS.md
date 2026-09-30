# Smart-Contract Extensions and Agent-Native Wallets

## Principle

A smart contract is a first-class PaySwap Extension when it exposes an auditable capability through a provider-neutral contract.

The network does not assume that a smart contract is automatically safe or trustless. Trust properties must be proven and certified.

## Extension lifecycle

Smart-contract extensions use the normal lifecycle:

DRAFT
→ STATIC_ANALYSIS
→ BENCHMARKED
→ SECURITY_REVIEW
→ CERTIFIED
→ AVAILABLE
→ SUSPENDED
→ RETIRED

The manifest declares:
- contract addresses and supported chains;
- source-code commit and compiler/toolchain metadata;
- bytecode/source correspondence;
- ABI/interface;
- upgradeability/admin controls;
- dependencies;
- oracle dependencies;
- pause/emergency controls;
- custody and withdrawal permissions;
- supported assets/currencies;
- jurisdictional constraints;
- proof requirements;
- economic accountability;
- audits/security evidence;
- invariant suite;
- capabilities exposed;
- protocol tokens consumed/emitted.

## Capability representation

A contract can expose capabilities such as:
- escrow;
- savings;
- lending;
- borrowing;
- collateralization;
- payment routing;
- subscription financing;
- guarantees;
- insurance-like risk pools where lawful;
- liquidity provision;
- FX settlement;
- recurring payments;
- treasury rules;
- cooperative pools;
- rewards/incentives;
- dispute/recourse mechanisms;
- account/wallet services.

The Capability Graph represents the contract as a capability provider with explicit conditions, fees, latency, liquidity, risk, proof, jurisdiction and availability.

## Lab integration

Once certified, the contract becomes a searchable capability.

The Lab may:
1. discover it as a candidate capability;
2. simulate it in a sandbox namespace;
3. compose it with other capabilities;
4. place it into candidate strategies and Agent Organizations;
5. test adversarial/fault/MEV/oracle/upgrade scenarios;
6. shadow/canary it where practical;
7. promote the capability/organization combination.

A contract never becomes authoritative merely because the Lab selected it.

## Trustless custody rule

PaySwap is non-custodial by default.

PaySwap must not have unilateral access to customer funds.

A fund-holding smart-contract capability must specify:
- exact withdrawal authority;
- whether PaySwap has any admin/upgrader/key path;
- recovery mechanism;
- timelocks;
- multisig/governance;
- oracle dependencies;
- emergency controls;
- supported assets/chains;
- solvency/accounting model.

To qualify as a PaySwap trust-minimized custody capability, no PaySwap operator/key may unilaterally withdraw user funds.

Where upgradeability or external governance can change withdrawal authority, that risk is explicit and affects certification.

## Agent-native wallet layer

User Agents should hide blockchain operational complexity without hiding authority.

The network should support an Agent-Native Wallet abstraction implemented using smart accounts where supported.

Required UX goals:
- no seed phrase for ordinary users;
- passkey/device/recovery-based authentication;
- session keys for constrained agent tasks;
- spending limits;
- per-service/per-merchant limits;
- time limits;
- policy-controlled batching;
- transaction simulation before execution;
- sponsored gas/paymasters;
- gas abstraction where supported;
- token-based fee payment where supported;
- recovery/social recovery where the account design supports it;
- explicit visibility into every delegated action.

## Account abstraction

Implement provider-neutral SmartAccountCapability and bind to standards such as ERC-4337 and, where appropriate, EIP-7702.

ERC-4337 supports smart contract accounts, UserOperations, bundlers, factories and paymasters, including third-party sponsorship of gas and token-based fee approaches. Ethereum's account-abstraction documentation also identifies programmable security, recovery, batching and sponsored gas as key benefits. See spec/research/CASE-STUDIES.md.

EIP-7702 support must be treated as a distinct capability with chain/version compatibility and security requirements.

## Key custody boundary

The User Agent may hold a delegated session key, but the session key must be unable to exceed its authority envelope.

The user's root account key is never placed in model context.

For high-risk operations, the agent escalates to user approval or another authorized signer.

## Smart-contract economics

A smart-contract extension may implement a full economic service, but external dependencies remain capabilities:
- fiat bank rails;
- cards;
- KYC/AML;
- identity;
- tax;
- physical delivery;
- regulated custody;
- off-chain oracle data.

A smart contract cannot pull fiat from a bank account without an external capability.

Therefore “smart-contract equivalent” means the financial/economic logic can be trust-minimized onchain where all required value and data interfaces exist, not that every off-chain banking function can literally be encoded onchain.

## Settlement

Onchain finality is a rail/finality capability. PaySwap records the finality evidence but does not take custody merely because it orchestrates the transaction.

## Security

Contracts are never trusted solely because they are audited or source-verified. Certification must consider:
- immutable vs upgradeable code;
- privileged roles;
- pause powers;
- oracle assumptions;
- bridge assumptions;
- reentrancy;
- accounting invariants;
- economic attacks;
- MEV;
- liquidation behavior;
- chain reorg/finality assumptions;
- dependency compromise.


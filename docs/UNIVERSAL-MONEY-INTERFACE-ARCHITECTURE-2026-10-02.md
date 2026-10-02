# PaySwap Universal Money Interface Architecture

Version: 1.6-frozen-2026-10-02
Status: ACCEPTED

## Mission

PaySwap is the main interface for money movement, not a crypto-only application.

A user, merchant or agent expresses an economic intent. PaySwap discovers eligible capabilities across fiat and onchain rails, evaluates organizations/routes, performs security and authorization checks, executes, observes, reconciles and records evidence.

## Canonical topology

User/Merchant/Agent Intent
→ Intent Compiler
→ Capability Discovery
→ Eligibility + Policy
→ Organization/Strategy selection
→ Execution Plan
→ Simulation
→ Security Gate
→ User/scoped automation authorization
→ Settlement
→ Observation/Finality
→ Reconciliation/Evidence
→ Learning/Lab.

## Rail families

FIAT_RAIL = banks, PSPs, cards, mobile money, local rails, FX and similar.

ONCHAIN_RAIL = chains, wallets, signers, smart accounts, DEXs, bridges, intent networks, smart-contract protocols and other blockchain execution.

OTHER_RAIL = future economic rails.

These are peer settlement-rail families. Blockchain does not replace the financial domain model.

## Onchain capability model

Use the existing CapabilityDefinition → ProviderImplementation → ConnectedCapabilityInstance → CapabilityObservation model.

Add provider-neutral contracts for:
- ChainDefinition / ChainImplementation / ConnectedChainInstance;
- WalletCapability / SignerCapability / SmartAccountCapability;
- ProtocolDefinition / ProtocolImplementation / ConnectedProtocolInstance;
- AssetDefinition / AssetObservation;
- OnchainExecutionCapability;
- ContractInteractionCapability;
- DEXCapability;
- BridgeCapability;
- IntentExecutionCapability;
- domain-specific protocol capabilities.

Core contracts must not assume EVM, one wallet, one RPC, one indexer, one DEX or one stablecoin.

## Financial lifecycle

Onchain execution enters the canonical:
Economic Activity → Fulfillment Activity → Clearing Record → Obligation → Netting Set → Net Position → Settlement Instruction → Settlement Attempt → Rail Operation → Finality Record.

Never create a parallel crypto ledger or crypto finality model.

## Wallet/signing

PaySwap does not require custody of private keys.

Authorization is explicit and scoped. Raw private keys, seed phrases, wallet passwords, API secrets, cookies, MFA secrets and equivalent material never enter agent/model context, normal logs or repository artifacts.

For supported consequential writes:
intent validation → route validation → prepare → simulate → policy → security analysis → human-readable expected-state diff → authorization → immediate pre-broadcast recheck → broadcast → observation/finality → postcondition verification → reconciliation/evidence.

A model/security agent can report a threat but cannot downgrade a deterministic BLOCK.

## Smart contracts

GenericContractInteractionCapability is a controlled escape hatch. Unknown/insufficiently certified generic writes require blocking or explicit escalation according to policy.

Protocol extensions declare identity/version, chain, contract addresses, source/bytecode provenance, upgrade/admin/pause/oracle/custody properties, capabilities, simulation, authorization, security and reconciliation semantics.

## Best execution

Optimize best eligible executable economic outcome, not quoted token price alone. Consider output, fees, gas, bridge/FX costs, slippage, liquidity impact, failure/retry cost, time/finality, health, security, policy and eligibility.

Provider-native optimization is retained as an incumbent baseline.

## Lab

The Reality Engineering Lab can include certified onchain capabilities in candidate Organizations and mixed fiat/onchain strategies.

The same optimizer can evaluate:
fiat-only, onchain-only and mixed organizations.

## Financial opportunities

FinancialOpportunity is rail-neutral. Agents may discover onchain liquidity, lending, staking, incentives, arbitrage/price-difference and other permitted opportunities with evidence, capital requirements, risk, liquidity, exit path and maximum-loss constraints.

Discovery is not authorization.

## Stripe-class merchant product

PaySwap provides a Stripe-class merchant abstraction:
- crypto checkout;
- PaymentIntents;
- payment attempts;
- webhooks;
- refunds where supported;
- crypto acceptance policy;
- settlement destinations;
- Stripe integration where actually eligible.

Native Stripe crypto settlement is a real provider capability. External PaySwap conversion/off-ramp settlement is a separate capability. Never fabricate a Stripe balance effect.

## UX

Stripe public surfaces and the authenticated Dashboard are the primary operational UX benchmark. The worker uses an isolated browser and a user-assisted official Google login when access is needed.

The user performs Google/Stripe authentication personally. Workers never receive credentials or secret session material.

The objective is to reproduce Stripe-grade information architecture, operational clarity, progressive disclosure and workflow quality with original PaySwap implementation and branding, not copy proprietary assets/code.

## Security

Blockchain-specific threat analysis is first-class:
malicious approvals/permits, unexpected spenders, fake tokens, transfer restrictions, proxy/admin changes, oracle manipulation, bridge risk, MEV/sandwich exposure, address/chain confusion, replay/signature-domain issues, unexpected state deltas, stale simulation and finality/reorg anomalies.

Security signals feed the existing SecurityAdvisory/ThreatSignature/SecurityEpoch machinery.

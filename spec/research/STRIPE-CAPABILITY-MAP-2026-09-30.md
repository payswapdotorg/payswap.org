# Stripe Capability Mapping — 2026-09-30

Source: Stripe public product catalogue, reviewed 2026-09-30.

Stripe currently reports 53 products across Payments, Risk, Revenue, Data, Money Management, Embedded Finance, Crypto and Stripe Platform. The catalogue includes products such as Agentic Commerce, Checkout, Link, Managed Payments, Terminal, Payment Methods, Payments, Orchestration, Financial Connections, Radar, Identity, Billing, Invoicing, Tax, Revenue Recognition, Data Pipeline, Sigma, Reports, Financial Accounts, Global Payouts, Cards/Issuing, Capital, Atlas, Connect, Treasury, Crypto, Crypto Onramp, stablecoin payments/subscriptions/payouts, Wallets/Privy, Stablecoin-backed card issuing, Apps, Projects, Workflows, Organizations, mobile dashboard, AI developer tools, Custom Objects, Sandboxes, CLI and Workbench.

Reference:
https://stripe.com/products

## PaySwap coverage model

### Native PaySwap primitives
- Payments / Payment Methods / Checkout / Payment Links
- Billing / Subscriptions / Invoicing / Usage billing
- Payouts / Transfers
- Connect / platform accounts / marketplaces
- Fraud / risk / identity / compliance
- Financial Connections
- Issuing / virtual payment credentials
- Wallets
- Crypto / stablecoins
- Treasury strategy
- Analytics / reporting / data pipeline
- Workflows
- AI-agent tooling
- Developer SDK/API
- Agentic commerce
- Machine payments
- Orchestration
- External processor/PSP connectivity
- Smart-contract financial services
- Non-custodial smart accounts
- Incentives / rewards / participation
- Netting / liquidity / FX / credit
- Evidence / reconciliation / disputes / recourse

### Partner-dependent capabilities
These are capabilities PaySwap can expose through certified providers rather than necessarily operating itself:
- regulated bank accounts;
- card issuing/schemes;
- bank-data connectivity;
- KYC/AML/identity verification;
- tax calculation/registration/filing;
- merchant acquiring;
- in-person terminal hardware;
- fiat custody or regulated stored-value accounts;
- consumer/business lending where licensing or capital is required;
- stablecoin issuance;
- carbon-removal marketplaces;
- company incorporation.

### Adjacent capabilities
Not foundational PaySwap capabilities but composable ecosystem capabilities:
- company incorporation / Atlas-like services;
- climate/carbon services;
- specialized third-party analytics;
- accounting integrations.

## Architectural conclusion

PaySwap should not copy Stripe product-by-product.

Instead, the Capability Graph represents each Stripe-like service as a capability and allows:
- PaySwap-native implementation;
- another PSP/provider implementation;
- smart-contract implementation;
- multiple implementations selected by strategy;
- hybrid compositions.

Thus the same merchant/account/service can move from Stripe-backed execution to another PSP, bank, crypto rail, smart contract or multi-provider route without changing the higher-level EconomicGoal or MoneyMovementIntent.

## PSP-agnostic merchant connector

Any compatible PSP can connect to PaySwap through the same provider-neutral Merchant PSP Connector contract.

The merchant should be able to:
1. keep its existing PSP account;
2. install/connect PaySwap once;
3. expose PaySwap as a payment method, processor/orchestration endpoint, agentic checkout path or external-payment record depending on PSP capabilities;
4. accept the PaySwap rails/capabilities the merchant is actually entitled and configured to accept.

The connector never claims a rail is available merely because PaySwap lists it. Availability, authorization, compliance and provider reachability must all be authoritative.

## Agentic commerce

Stripe's current agentic-commerce stack includes Shared Payment Tokens, Link's agent wallet, Delegated Checkout and machine-payment protocols. PaySwap represents equivalent concepts as generic capabilities:
- ScopedPaymentCredentialCapability;
- AgentFundingCapability;
- DelegatedCheckoutCapability;
- MachinePaymentCapability.

Stripe is an adapter, not the domain model.

## Smart-contract equivalence

Where economic logic can be implemented onchain, PaySwap can expose a SmartContractCapability instead of requiring a centralized PSP implementation.

The capability must disclose all off-chain dependencies and trust assumptions. A smart contract cannot natively replace fiat rails, identity systems, physical operations or regulated legal functions without external capabilities.

## Explicit non-custody boundary

PaySwap coordinates and orchestrates money movement. It does not take custody/title to user funds by default.

If a flow requires funds to be held, the preferred route is a certified smart-contract custody/escrow capability in which PaySwap has no unilateral withdrawal authority.

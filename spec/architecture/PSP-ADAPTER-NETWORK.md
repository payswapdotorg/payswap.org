# Universal PSP / Processor Adapter Network

## Goal

A merchant should be able to connect the PaySwap network to an existing PSP and gain access to PaySwap-supported payment capabilities without implementing each rail separately.

The PSP is an existing merchant-facing stack. PaySwap becomes an additional processor/network capability.

## Canonical model

Merchant
→ existing PSP integration
→ PaySwap connector/payment method
→ PaySwap orchestration
→ selected PaySwap capability/rail
→ settlement to merchant according to the connected PSP/merchant arrangement.

The connector must not imply that an external PSP automatically becomes a processor for every PaySwap rail. PaySwap must actually execute or coordinate the underlying payment through an authorized rail/provider relationship.

## PSP-neutral principle

Stripe is one adapter example.

The same pattern should support:
- Stripe;
- Adyen;
- Checkout.com;
- Braintree/PayPal where integration supports it;
- regional PSPs;
- merchant-owned processors;
- custom gateways;
- commerce platforms.

Do not make Stripe objects domain primitives.

## Supported integration modes

### Payment-method mode
PaySwap appears as a payment method in the merchant's existing checkout.

### Processor/orchestration mode
The PSP/merchant routes a payment request to PaySwap as a processor/orchestrator.

### Payment-record mode
The merchant keeps the existing PSP ledger/reporting surface while PaySwap supplies an external payment and the PSP records the resulting payment through its supported external/custom-payment mechanism.

### Agentic commerce mode
PaySwap exposes machine-readable discovery, delegated checkout and scoped payment capabilities to authorized agents.

### Off-session/recurring mode
Where the PSP and underlying rail permit it, PaySwap manages recurring intents and provides the appropriate tokenized/virtual/mandated payment credential.

## Canonical merchant promise

“Integrate PaySwap once, then expose every payment capability you are legally and operationally entitled to accept through PaySwap.”

This is not “Stripe automatically accepts MTN Mobile Money.” It is “the merchant has one PaySwap connection through its existing stack, and PaySwap handles the additional rails.”

## Payment method abstraction

The merchant should receive a canonical PaySwap Payment Method reference with:
- payment method ID;
- supported currencies;
- settlement currency;
- transaction/customer context;
- status;
- authorization/evidence references.

Underlying funding may be:
- card;
- bank;
- mobile money;
- stablecoin;
- wallet;
- credit;
- LP liquidity;
- other network capabilities.

## Routing

The Strategy Engine decides based on:
- customer/merchant intent;
- cost;
- FX;
- availability;
- liquidity;
- latency;
- risk;
- recourse;
- payment method eligibility;
- incentive programs;
- merchant settlement requirements.

## Reconciliation

Every external PSP/rail result is reconciled into PaySwap's canonical attempt/finality model.

No external processor webhook becomes truth without adapter verification and protocol reconciliation.

## Scope

Initial product work should prioritize the connector pattern and one PSP. Additional PSP adapters follow exactly the same provider-neutral contract.

## Lossless PSP capability model

The PSP adapter exposes four layers:
CapabilityDefinition → ProviderImplementation → ConnectedCapabilityInstance → CapabilityObservation.

For each merchant connection, the connector determines the actual scope that is authorized and reachable. A provider catalogue capability is not evidence that a particular merchant account can execute it.

### Provider state

Payment lifecycle semantics are preserved, including customer actions, asynchronous states, capture, recurring mandate state, refund/dispute state, payout state, connected-account relationships and provider-specific failure metadata. Use ProviderStateEnvelope rather than collapsing provider states into a generic action result.

### Execution modes

- PASS_THROUGH_NATIVE: preserve the PSP-native flow/optimizer.
- COMPOSED_PAYSWAP: compose the PSP with PaySwap capabilities.
- OPTIMIZED_MULTI_PROVIDER: route across reachable providers/capabilities.

Provider-native optimization is itself a capability. The Lab may select it when it is the appropriate incumbent path.

### External funds

Provider balances are exposed only as ExternalFundsLocation / ExternalFundsPositionObservation with freshness and provenance. They are not PaySwap custodial balances.

### Sub-pack hierarchy

PSP packs are hierarchical and independently versioned/certified: payments, billing, risk, connect, payouts, tax, issuing, financial accounts, crypto and native optimization as applicable.

# Lossless Executable Connector Capability Model

This document is the detailed implementation contract for ADR-006.

## 1. Capability layers

### CapabilityDefinition

Provider-neutral semantic contract. It defines what a capability means, its canonical inputs/outputs, preconditions, state machine, safety properties and protocol token requirements.

### ProviderImplementation

Provider-specific realization of a CapabilityDefinition. SDK types, API names, provider states and provider quirks stay here.

### ConnectedCapabilityInstance

A concrete instance tied to:
- connector and provider;
- tenant/account;
- authorized credentials/delegation scope;
- geography/currency;
- enabled/configured features;
- commercial terms;
- acceptance/eligibility;
- capability version.

This is the primary object used for executable discovery.

### CapabilityObservation

A time/versioned observation of:
- availability/reachability;
- enabled/disabled status;
- health/degradation;
- quota/rate pressure;
- current terms;
- provider incident;
- eligibility changes;
- external state needed for execution.

An observation can be UNKNOWN. Unknown reachability is never treated as failure or success.

## 2. ProviderStateEnvelope

Provider-specific state is attached to consequential external operations without leaking provider types into canonical domain code.

Minimum fields:
- provider/version;
- object type;
- external object ID;
- provider revision/version;
- provider state;
- provider state history when available;
- action required;
- failure/code/reason metadata;
- provider-specific constraints/metadata subject to privacy policy;
- observation timestamp;
- provenance/evidence reference.

Canonical state and ProviderStateEnvelope are both retained. Canonical state determines protocol behavior; provider state remains available for required UI actions, reconciliation, support, audit and reprocessing.

Examples include customer authentication required, asynchronous processing, capture required, mandate lifecycle, refund lifecycle, dispute evidence requirements, payout state and connected-account state.

## 3. Executable capability contract

An executable connector capability must declare:
- preconditions;
- authorization and credential requirements;
- input/output schema;
- canonical state machine;
- provider state mapping;
- required user/customer action surface;
- idempotency key behavior;
- retry and duplicate-submit behavior;
- cancellation/compensation semantics;
- partial execution semantics;
- financial effect classification;
- external object identity/revision;
- evidence/proof;
- reconciliation contract;
- economic terms and limits;
- regulatory/commercial scope;
- supported currencies/geographies;
- current connected-instance availability.

CRUD verbs may implement transport, but they are not the semantic contract.

## 4. Execution modes

### PASS_THROUGH_NATIVE

Preserve the provider-native request and customer journey with the smallest safe translation. The provider may own an optimization/routing step. PaySwap still records the canonical intent, authorization, execution attempt and evidence.

### COMPOSED_PAYSWAP

Use the provider as one executable capability inside a PaySwap strategy, possibly combined with FX, liquidity, credit, another rail, an incentive or a smart-contract capability.

### OPTIMIZED_MULTI_PROVIDER

Compare multiple ConnectedCapabilityInstances and compose an execution graph subject to acceptance, authorization, compliance, risk, cost, timing, recourse and settlement constraints.

A strategy may select different modes for different intents.

## 5. Provider-native intelligence

Provider-native optimization, routing, recovery and payment-method selection are represented as capabilities where the provider exposes them as executable behavior.

The Lab baseline suite therefore includes:
- deterministic/generalist baseline;
- hand-designed strategy;
- searched strategy;
- incumbent/provider-native capability;
- PaySwap composition;
- multi-provider candidates where reachable.

No candidate gets credit for simulation results that cannot be reproduced through authorized production capability paths.

## 6. Hierarchical capability packs

Provider packs are trees, not monoliths. Example:

Provider
├── Payments
│   ├── Methods
│   ├── Authorization
│   ├── Capture
│   ├── Refund
│   └── Payment-state recovery
├── Billing
├── Risk
├── Connect / Marketplace
├── Payouts
├── Tax
├── Issuing
├── Financial Accounts
├── Crypto
└── Native Optimization

Each node is independently versioned/certified and scoped to one or more ConnectedCapabilityInstances.

## 7. External funds state

### ExternalFundsLocation

Identifies the external system/location where a provider reports funds or an economic position, such as a PSP balance, external bank account or wallet.

### ExternalFundsPositionObservation

A time-stamped observation associated with an ExternalFundsLocation. It must include freshness/provenance and may include reconciliation state.

These observations can inform payout timing, routing, treasury, netting and obligations. They are never recorded as PaySwap custody, and a stale or unverifiable observation cannot create a false PaySwap balance.

## 8. Certification requirements

Connector certification must prove:
- catalogue-to-implementation mapping;
- connected-account scope/eligibility behavior;
- canonical/provider state mapping;
- user-action preservation;
- idempotency/retry behavior;
- unknown/outage handling;
- evidence and reconciliation;
- compensation/partial execution;
- execution-mode correctness;
- external-funds observation semantics;
- version compatibility;
- security/privacy/regulatory boundaries.

Negative tests are mandatory: advertised-but-disabled, permission-missing, out-of-region, unsupported-currency, quota-exhausted and provider-unreachable cases must not appear executable.


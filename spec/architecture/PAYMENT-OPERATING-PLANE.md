# Payment Operating Plane

## Purpose

The Payment Operating Plane sits between professional/economic intent and the underlying Capability/Rail network.

It makes payment methods coherent without treating any single rail, PSP or wallet as the product boundary.

## Distinct abstractions

### PaymentMethod
What the payer/merchant experiences:
- card;
- bank transfer / ACH / EFT;
- instant payment;
- wire / RTGS;
- mobile money;
- digital wallet;
- virtual card;
- stablecoin / crypto;
- BNPL / credit;
- external check/cash payment record.

### RailCapability
The underlying mechanism that actually moves value.

### PaymentCredentialCapability
The authorization material required to initiate the method:
- token;
- mandate;
- bank authorization;
- mobile-money authorization;
- smart-account session key;
- virtual-card credential;
- delegated payment credential.

### PaymentAcceptancePolicy
What the merchant will accept and under which constraints.

### PaymentMethodOffer
A concrete offer exposed at checkout or to an agent:
- method;
- amount/currency;
- fees;
- FX;
- timing;
- recourse/protection;
- eligibility;
- expiry;
- settlement terms.

### PaymentMethodTranslation
Records:
requested PaymentMethod
→ selected Capability chain
→ PaymentAttempt(s)
→ actual RailOperation(s)
→ MerchantSettlementDestination.

The user-facing method may therefore be "Pay with PaySwap" while the actual path is mobile money → FX → bank.

### PaymentAttempt
An immutable attempt record with:
- strategy;
- capability;
- provider;
- authorization;
- idempotency;
- state;
- external references;
- proof/evidence.

### PaymentFallbackPolicy
Declares:
- permitted alternate methods;
- automatic vs approval-required fallback;
- material-term thresholds;
- max extra cost;
- max delay;
- recourse requirements.

A material change requires re-authorization.

### MerchantSettlementDestination
An external destination/capability where the merchant ultimately receives value:
- bank account;
- mobile-money wallet;
- card settlement;
- external PSP account;
- stablecoin wallet;
- certified smart-contract account.

PaySwap does not turn this into a custodial PaySwap balance.

### RemittanceAllocation
Preserves business meaning across payment translation:
- invoice;
- order;
- project/milestone;
- contract;
- payroll batch;
- customer/account;
- tax/fee;
- incentive;
- credit repayment.

### OffNetworkPaymentRecord
Records a check, cash payment, direct external bank payment or other movement not orchestrated by PaySwap.

It must carry:
- source;
- reporter;
- amount/currency;
- external reference;
- evidence;
- business reference;
- reconciliation state.

It never implies PaySwap execution.

## Canonical payment lifecycle

Request
→ Offer
→ accept/select
→ authorization/mandate
→ reservation
→ PaymentAttempt
→ external rail effect
→ evidence/finality
→ settlement allocation
→ reconciliation
→ receipt/complete

Refund/dispute flows use the corresponding reverse/recourse pathway.

## Recurring

Recurring payments use explicit mandates with:
- recurrence schedule;
- maximum amount;
- merchant/service scope;
- validity;
- cancellation;
- renewal authority;
- fallback policy.

No recurring renewal may silently expand authority.

## Merchant-side connector

A PSP connector can expose PaySwap as:
- payment method;
- processor/orchestration endpoint;
- external payment record;
- agentic checkout capability;
- recurring payment capability.

It never claims an underlying rail is available unless the rail/provider capability is actually authorized and reachable.

## Core UX

The interface should ask:

"How would you like to pay?"
and also:

"Do you want PaySwap to optimize this automatically?"

Advanced users can inspect:
- actual method;
- route;
- providers;
- fees;
- FX;
- timing;
- recourse;
- settlement destination;
- proof.

The default experience hides unnecessary infrastructure details while preserving transparency on demand.

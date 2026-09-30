# Service Capabilities and Service-Access Abstraction

## Principle

PaySwap should reason about the service a user wants, not merely the payment instrument required to obtain it.

## ServiceAccessIntent

A ServiceAccessIntent may specify:
- service/provider;
- plan/product/entitlement;
- country/jurisdiction;
- deadline;
- max cost;
- recurring terms;
- user/account ownership;
- financing preference;
- credential-exposure constraints;
- privacy;
- support/cancellation requirements;
- proof requirements;
- recourse.

## ServiceAccessCapability

A capability may provide access through:
- direct subscription;
- prepaid entitlement;
- delegated merchant billing;
- partner billing;
- LP financing;
- network credit;
- cooperative pool;
- smart-contract service;
- other certified mechanisms.

It declares:
- acquisition method;
- authentication requirements;
- funding requirements;
- recurring support;
- credential requirements;
- cancellation/renewal;
- transferability;
- terms;
- cost;
- latency;
- reliability;
- proof;
- jurisdiction.

## Credential isolation

The credential used to obtain a service must be separated from the credential used to fund it.

Examples:
- Netflix login is not a payment credential;
- a payment token does not authenticate to Netflix;
- an LP's card/token does not grant the user access to the LP's finances.

Credential stores and browser sessions are provider capabilities, never general-purpose agent memory.

## Financing

A service can be acquired with another actor's liquidity without transferring that actor's underlying payment credentials to the service recipient.

The resulting economic relationship is represented as:
ServiceAccessIntent
→ payment obligation
→ funding/credit relationship
→ service entitlement
→ proof.


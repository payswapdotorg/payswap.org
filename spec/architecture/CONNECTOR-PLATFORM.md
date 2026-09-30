# Connector Platform — PaySwap as the Orchestration Layer Above Existing Providers

## Positioning

The connector platform is analogous to the relationship a developer platform can have with underlying cloud infrastructure:

the customer keeps the underlying provider relationship, while PaySwap supplies a common interface, capability model, workflow/orchestration layer, observability and portability.

For PSPs, this means:
Merchant keeps Stripe/Adyen/Checkout.com/etc.
→ PaySwap Connector
→ Connector Capability Pack
→ PaySwap network capabilities.

The analogy is architectural, not a claim that PaySwap replaces or becomes the provider.

## Connector

A Connector is a versioned provider adapter and productized capability surface for an external system.

Examples:
- PSP connector;
- CRM connector;
- ERP/accounting connector;
- construction/project-management connector;
- EHR/healthcare connector;
- fleet/telematics connector;
- hospitality/PMS connector;
- legal matter connector;
- communications connector;
- cloud/dev platform connector;
- document/storage connector.

## Connector Capability Pack

Every connector exposes a declared set of capabilities:
- capability IDs and versions;
- read models;
- commands/actions;
- search/query;
- create/update/archive;
- webhook/event subscriptions;
- provisioning/account lifecycle;
- authentication/credential requirements;
- data schemas;
- object mappings;
- rate limits/quotas;
- latency/reliability;
- source-of-truth policy;
- jurisdiction/data-residency constraints;
- pricing/usage;
- evidence requirements;
- deep links/UI surfaces;
- rollback/compensation support;
- provider status/health;
- compatibility matrix.

The Capability Graph represents each exposed capability independently while preserving the connector provenance.

## Connector contract

Provider-specific SDKs remain inside the connector.

The generic contract supports:
- discover;
- authenticate;
- authorize;
- search;
- read;
- create;
- update;
- action;
- subscribe;
- reconcile;
- health;
- disconnect;
- rotate credentials;
- migrate/export.

Every mutation is idempotent where the provider allows it. Non-idempotent operations require a provider-specific compensation/idempotency strategy.

## Source-of-truth policy

Every external object mapping declares one of:
- EXTERNAL_AUTHORITATIVE;
- PAYSWAP_AUTHORITATIVE;
- SHARED_WITH_VERSIONED_CONFLICT_RULE;
- DERIVED_PROJECTION.

Conflicting writes never silently overwrite one another. The Work Graph records provenance, revision/version and conflict resolution.

## Capability composition

A connector capability may be combined with:
- a second provider capability;
- a PaySwap-native capability;
- a smart-contract capability;
- an Agent Organization;
- a human expert;
- an incentive program.

Thus a "Stripe connector" is not a Stripe object. It is a set of capabilities that happen to be backed by Stripe.

## PSP example

Merchant has only Stripe.

Merchant connects PaySwap once.

PaySwap exposes a PaySwap payment capability through the merchant's existing checkout/processor integration where supported.

PaySwap then routes the underlying transaction through actual reachable and authorized capabilities:
- bank;
- mobile money;
- stablecoin;
- card;
- another PSP;
- credit;
- liquidity;
- smart-contract settlement.

The connector must never claim that Stripe processes a rail that is actually processed elsewhere.

## Connector marketplace

Third parties can publish connectors.

Certification checks:
- authentication/security;
- capability correctness;
- webhook behavior;
- data mapping;
- error/UNKNOWN semantics;
- idempotency;
- permissions;
- privacy/residency;
- rate/usage behavior;
- evidence;
- version compatibility.

Connector publishers can earn marketplace revenue for capability usage, subject to network policy.

## Connector health

The network tracks health per connector/capability:
- reachable;
- degraded;
- unavailable;
- capability state;
- latency;
- recent provider incident;
- quota pressure.

Health never fabricates business outcome state.

## Connector portability

A Work Graph object should retain its canonical PaySwap identity while being linked to external IDs in multiple providers.

This permits:
- migration;
- dual-running;
- provider failover;
- comparison;
- incremental replacement;
- vendor exit.

## Design rule

PaySwap should build deep domain models only where they create unique network value.

For industry-specific functionality that already exists in a mature product, prefer:
canonical Work Graph + certified Connector Capability Packs + agent orchestration
over recreating the competitor's entire product.

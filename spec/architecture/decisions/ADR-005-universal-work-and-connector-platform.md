# ADR-005 — Universal Work Interface and Connector Platform

Status: ACCEPTED
Date: 2026-09-30

## Context
The simulations showed that the largest barrier to main-interface and full-replacement adoption was not payment capability. It was dependence on deep incumbent systems of record and the surrounding work context: projects, cases, documents, schedules, conversations, approvals and field operations.

## Decision
Add a Work Operating Plane and generalized Connector Platform.

PaySwap becomes the main interface for search, context, coordination, agent delegation, approvals, exception handling and economic actions. External products remain systems of record where specialized depth is valuable.

A Connector is a productized boundary to an external system. A Connector Capability Pack exposes all supported underlying capabilities as provider-neutral, versioned capabilities.

## Vercel-over-infrastructure analogy
A customer can keep an underlying provider relationship while PaySwap provides a common interface, capability model, workflow/orchestration layer, observability and portability.

For PSPs:
Merchant keeps Stripe/Adyen/another PSP
→ PaySwap Connector
→ Connector Capability Pack
→ PaySwap network capabilities.

The analogy does not imply control over the provider.

## Consequences
The product can scale across industries without recreating every incumbent's entire domain product. Main-interface adoption can grow before full system replacement.

Connector publishers can contribute capabilities and earn usage-based marketplace revenue under network policy.

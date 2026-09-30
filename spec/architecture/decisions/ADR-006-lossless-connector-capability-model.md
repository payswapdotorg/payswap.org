# ADR-006 — Lossless Executable Connector Capability Model

Status: ACCEPTED
Date: 2026-09-30
Supersedes: connector wording in v1.4; does not replace ADR-003's PSP-neutral boundary

## Decision

A Connector represents the capabilities actually exposed by a connected provider/account, not the provider's entire advertised catalogue.

The canonical hierarchy is:

CapabilityDefinition
→ ProviderImplementation
→ ConnectedCapabilityInstance
→ CapabilityObservation.

The Lab/Director reasons over ConnectedCapabilityInstance and current observations. Provider catalogue information may seed discovery but cannot authorize execution.

Connector capabilities are lossless: provider lifecycle state, required customer actions, external identifiers/revisions, retries, compensation, partial execution, evidence and economic constraints remain available alongside canonical PaySwap state.

## Execution modes

Every executable provider capability declares one or more explicit modes:
- PASS_THROUGH_NATIVE;
- COMPOSED_PAYSWAP;
- OPTIMIZED_MULTI_PROVIDER.

PASS_THROUGH_NATIVE preserves an incumbent provider's native flow or optimization with minimal translation. It does not bypass PaySwap authorization, policy, compliance, security, idempotency or evidence controls.

Provider-native optimization/recovery is itself a capability that can be benchmarked by the Lab.

## Provider state

Provider-specific lifecycle meaning is retained in ProviderStateEnvelope. Canonical state is authoritative for PaySwap protocol truth; provider state is preserved for customer action, reconciliation, support, audit and reprocessing.

## Hierarchical packs

Large providers expose independently versioned/certified Connector Capability Pack subtrees. A PSP example may contain payments, billing, risk, connect, payouts, tax, issuing, financial accounts, crypto and native optimization.

Each sub-pack is scoped to the ConnectedCapabilityInstance.

## External funds observations

ExternalFundsLocation and ExternalFundsPositionObservation represent provider-reported external balances/positions. They are observations with explicit freshness/provenance and never become PaySwap custody or an internal customer-balance claim.

## Consequences

- PaySwap does not promise capabilities merely because a PSP advertises them.
- Connectors preserve provider behavior instead of creating a lossy universal CRUD façade.
- Provider-native execution remains a first-class incumbent baseline.
- PaySwap can compose a provider capability with network capabilities without changing provider-specific semantics.
- W2-003 owns capability vocabulary and instance/observation contracts; W3-003 consumes them for execution.
- Certification must prove the mapping between advertised provider behavior and the connected capability instance, including negative/unknown cases.

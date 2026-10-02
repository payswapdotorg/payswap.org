# Phase 2 Authorization and Credential Isolation

Status: frozen for Phase 2 execution; supplements v1.5 without changing financial domain authority.

## Purpose

PaySwap is non-custodial. Provider connectivity means PaySwap has an authorized way to request an external action; it does not mean PaySwap owns or holds the provider's funds.

## Canonical separation

~~~text
Account ownership
    ≠ authorization
    ≠ authentication material
    ≠ execution
    ≠ custody
~~~

The connected account owner controls the provider account. PaySwap records authorization and capability state. Credentials/session material stays inside the secure credential/browser boundary. The connector performs the external action. The provider/rail remains the external holder/executor of funds.

## Supported authorization modes

1. DELEGATED_OAUTH
2. CONNECTED_ACCOUNT
3. SCOPED_API_CREDENTIAL
4. INTERACTIVE_BROWSER_SESSION
5. PROVIDERLESS_RAIL

INTERACTIVE_BROWSER_SESSION and PROVIDERLESS_RAIL are required for local rails where no suitable provider API credential is available.

## Interactive browser security boundary

The user agent can initiate the connection, but the LLM is not the security boundary.

The trusted browser runtime must:
- let the user type passwords and MFA directly;
- keep cookies, session storage, headers and credential fields out of model context;
- expose only an opaque browser_session_ref;
- encrypt/persist the session only in the approved secure store;
- constrain browser actions to the certified connector;
- support expiry, revocation, reauthentication/renewal and provider-required step-up;
- emit sanitized evidence and external IDs without leaking secrets.

The system must never treat "only the user's agent sees it" as sufficient credential protection.

## Connection flow

~~~text
User/merchant/supplier
  ↓
User Agent / Trusted Surface
  ↓
Provider-hosted login/consent
  ↓
Credential or browser-session broker
  ↓
ConnectedCapabilityInstance
~~~

The connection must produce explicit account scope, authorization scope, geography/currency scope, capability scope, auth mode, health, expiry/reauthentication state and provenance.

## Execution flow

~~~text
Economic Intent
  ↓
Financial Protocol authorization + policy
  ↓
ConnectedCapabilityInstance
  ↓
Connector Runtime
  ├─ token/API route
  └─ isolated browser route
  ↓
External provider/local rail
  ↓
Evidence + reconciliation
~~~

The user agent does not re-enter the provider password on every transaction. Reauthentication occurs only when the provider requires it or policy requires step-up.

## Debit/withdrawal

A connected account does not imply unrestricted debit or withdrawal authority. Transfer-out/debit capabilities require explicit authorization, scope, limits, expiry and, where applicable, provider-native confirmation/step-up.

## Providerless local rails

A local rail is certifiable without PaySwap-owned provider credentials when the real external capability is established through a user-authorized browser/device/session path and the provider/security/legal boundary permits the automation.

A provider catalogue entry alone is never sufficient.

## Evidence and failure

Browser/API paths share the same protocol requirements:
- authorization before external effect;
- idempotency/duplicate protection;
- immutable attempt lineage;
- ProviderStateEnvelope;
- UNKNOWN and reconciliation;
- customer-action-required;
- external evidence;
- fail-closed behavior;
- no synthetic financial effects.

## Exit gate

A browser/local-rail connector is not production-ready until the TL can demonstrate connection → authorized action → external evidence → reconciliation without exposing authentication material to the model or committing secrets to Git.

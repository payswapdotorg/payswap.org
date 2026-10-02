# Final TL Handoff — PaySwap.org Phase 2
Date: 2026-10-02
Repository: payswapdotorg/payswap.org
Architecture: 1.5-frozen-2026-09-30
Previous certified head: 7da466d5eda9...
Phase: REAL PROVIDER ACTIVATION + GLOBAL COVERAGE

## Mission

The previous phase certified the protocol, connector model, payment plane, Lab, UX and deployment machinery.

Phase 2 turns that machinery into real provider connectivity.

The system must remain:
- non-custodial;
- provider-neutral;
- lossless;
- account-scoped;
- reconciliation-first;
- fail-closed;
- capable of preserving incumbent provider paths.

## Current verified baseline

Repository machine state records:
- 21/21 Work Orders COMPLETE;
- production deployment authorized;
- runtime plane activated;
- 1844/1844 test battery at the latest certified implementation release;
- typecheck clean at the latest certified release;
- live runtime probe completed;
- historical deployment record still contains zero connected financial providers.

Do NOT rewrite historical certification/deployment records. Phase 2 provider activation gets new versioned records.

## Operator-supplied credentials

Credentials have been supplied for:
- Stripe;
- MTN MoMo;
- Flutterwave;
- Paystack.

Treat their existence as an operator input, not as proof of successful provider integration.

The first Phase 2 action is to reconcile the operator vault with the repository's provider configuration contract and then run live capability/authorization/eligibility probes.

Never commit raw secrets.

Preferred configuration model:
PROVIDER_<NAME>_CREDENTIAL_REF

Store the provider's complete credential bundle as a vault object/reference rather than scattering individual secrets across environment variables.

## PayPal correction

Do NOT rely exclusively on Stripe's PayPal capability.

Stripe currently offers PayPal, but its PayPal-on-Stripe availability is limited by Stripe business country/account type. PayPal's direct API/payment surface is materially broader.

Therefore:
- Stripe PayPal = Stripe-backed capability implementation;
- PayPal Direct = independent provider implementation;
- both appear in the Capability Graph;
- the Lab may select either when actually reachable.

The direct PayPal connector is part of Phase 2 global coverage.

## Phase 2 provider implementation order

### Wave 1 — supplied providers

**Worker 1 — Provider connection control plane**
- vault-backed credential reference resolution;
- ConnectedCapabilityInstance activation/deactivation;
- provider onboarding state machine;
- live capability/eligibility observation;
- provider activation records;
- operator-safe credential rotation;
- no-secret logging;
- per-provider enablement without redeploying domain contracts.

**Worker 2 — Stripe**
- real Stripe provider implementation;
- real Stripe capability packs;
- payment lifecycle;
- customer-action states;
- recurring;
- refunds/disputes;
- payout/external-funds observation;
- provider-native optimization;
- webhook verification;
- reconciliation;
- Stripe PayPal capability where eligible.

**Worker 3 — MTN MoMo + Flutterwave + Paystack**
- real provider implementations;
- exact provider API mappings;
- local payment methods;
- mobile money;
- recurring where supported;
- refunds/reconciliation;
- webhook signatures;
- provider-specific external IDs/state preserved in ProviderStateEnvelope.

All three workers must use the v1.5 connector vocabulary. No parallel capability model.

### Wave 2 — global reach providers

After Wave 1 capability contracts are stable:

**Worker 1**
- PayPal Direct;
- global bank/payout route controls.

**Worker 2**
- Rapyd;
- dLocal;
- Thunes.

**Worker 3**
- Adyen;
- Airwallex;
- EBANX.

Provider order may change only from repository evidence such as legal eligibility, account onboarding, unavailable products or a demonstrated coverage gap.

### Wave 3 — gap closure

Build only the provider/rail integrations required by the Coverage Gap Cases.

Candidate categories:
- domestic bank-transfer/instant-payment networks;
- mobile-money operators not covered by MTN/aggregators;
- local wallets;
- cash networks;
- BNPL/credit;
- domestic acquiring;
- sanctioned/high-restriction market routes.

Do not build a local connector merely because it exists. Build it when the matrix proves that it closes an executable gap.

## Provider onboarding procedure

For EACH new provider:

1. Open the provider dashboard using the operator-authorized browser session.
2. User completes authentication/MFA when the provider requires it. Never ask the user to paste raw secrets into chat.
3. Complete business/KYB/merchant verification and contractual activation required by the provider.
4. Create the least-privilege production API/app/service credential required for the intended capabilities.
5. Obtain webhook signing material and application/merchant/account identifiers.
6. Record the exact credential bundle as a vault reference.
7. Create the ProviderImplementation record.
8. Create ConnectedCapabilityInstances scoped to the real merchant/account/tenant, authorized features, currencies/geographies and permissions.
9. Run live health, authentication, capability and eligibility probes.
10. Register and verify webhook endpoints.
11. Map provider lifecycle states into ProviderStateEnvelope without loss.
12. Implement provider idempotency/retry/compensation semantics.
13. Implement reconciliation and UNKNOWN resolution.
14. Capture provider evidence and external IDs/revisions.
15. Run sandbox/test-mode conformance.
16. Run controlled live canary transactions only where explicitly authorized.
17. Certify the connector.
18. Publish a new provider activation/release record.
19. Add the verified provider to the Coverage Matrix.
20. Only then allow the Lab/Director to select the connected capability for production execution.

## Provider-specific credential harvesting

### Stripe
Harvest the current API/application credentials, webhook signing secret, account/merchant identifiers and any Connect/platform configuration actually needed.

Do not assume all Stripe products are enabled. Probe the connected account.

### MTN MoMo
The existing repository contract already expects a credential bundle covering the current MTN MoMo API-user/API-key/subscription-key class of credentials. Resolve these from the vault and bind them to the correct country/environment/account.

### Flutterwave
Harvest the current secret key plus any encryption/webhook signing material required by the selected API surface. Flutterwave documents secret/public/encryption keys and webhook verification.

### Paystack
Harvest the environment-specific secret key and webhook configuration. Paystack uses secret-key API authentication and HMAC-SHA512 webhook signatures.

### PayPal Direct
Create the appropriate API application in the PayPal developer environment, obtain client credentials, configure webhooks and verify country/account/product eligibility before enabling any capability.

### Rapyd / dLocal / Thunes / Adyen / Airwallex / EBANX
Do NOT hard-code guessed credential fields. Authenticate to each dashboard, inspect the current official integration/authentication requirements, create least-privilege credentials, and store them as one provider vault bundle.

For EBANX, prefer the currently recommended JWS authentication path where available rather than introducing new deprecated shared-secret patterns.

## Coverage matrix

Create and maintain:

country × merchant domicile × shopper/beneficiary × method × currency × pay-in/payout × provider × ConnectedCapabilityInstance × eligibility × health × regulatory profile × settlement destination.

The matrix must identify:
- primary route;
- fallback route;
- incumbent/native route;
- direct/local route;
- actual provider;
- actual rail;
- current credential/authorization status;
- evidence freshness;
- last successful probe;
- known limitations.

Coverage is executable, not marketing metadata.

## Global provider reference strategy

Initial target provider set:

Stripe
MTN MoMo
Flutterwave
Paystack
PayPal Direct
Rapyd
dLocal
Thunes
Adyen
Airwallex
EBANX

This set is a broad-coverage starting point, NOT a claim of literal every-country coverage.

Use the Gap Case mechanism to add local providers only where the matrix proves a missing capability.

## Critical production invariants

The provider activation phase must not weaken any frozen invariant.

Especially:
- provider catalogue ≠ connected capability;
- UNKNOWN ≠ FAILED;
- provider state is preserved;
- provider identity/revision is preserved;
- merchant acceptance is authoritative;
- actual rail path is visible;
- fallback material-term changes require reauthorization;
- PaySwap never represents provider balance as PaySwap custody;
- external funds are observations;
- agents cannot directly invoke providers;
- provider SDKs remain inside adapters;
- every external effect has authorization and evidence lineage;
- all financial providers are independently health-checked;
- one failing provider cannot poison unrelated providers.

## Live testing strategy

For each provider:
- test sandbox/test mode first;
- verify webhooks;
- verify duplicate-submit behavior;
- verify delayed/async states;
- verify customer-action-required states;
- verify refund/dispute paths;
- verify reconciliation after webhook loss;
- verify provider outage handling;
- verify external IDs/revisions;
- verify account eligibility;
- perform limited live canary only after explicit operational authorization.

Never manufacture a successful transaction merely to satisfy a test.

## Routing/optimization

The Lab must benchmark:
- provider-native optimization;
- Stripe-native PayPal where eligible;
- direct PayPal;
- PaySwap composition;
- multi-provider routing;
- local direct rails.

No provider is automatically preferred.

The objective is the best executable route for the specific intent under hard constraints.

## Operator UX

The Command Center must make provider reality visible:
- connected providers;
- connected capability instances;
- eligible methods;
- current health;
- pending customer action;
- current provider state;
- fallback options;
- provider evidence;
- reconciliation state;
- external settlement destination;
- coverage gaps.

Do not show "available" because a provider exists globally.

## Exit criteria

Phase 2 is complete only when:

1. all four supplied providers have real validated ConnectedCapabilityInstances;
2. Stripe's relevant capabilities are real and provider-state-lossless;
3. direct PayPal is integrated and independently selectable;
4. the global coverage stack is integrated where account eligibility permits;
5. country/method/currency coverage matrix is live and evidence-backed;
6. uncovered routes become explicit Coverage Gap Cases;
7. at least one real positive and one real negative/unknown scenario exists per provider;
8. webhook-loss and reconciliation have been exercised;
9. fallback preserves separate PaymentAttempt lineage;
10. provider-native baseline is benchmarked;
11. no provider secret exists in Git;
12. production release records distinguish certified historical releases from new provider activation releases;
13. all provider capabilities are discoverable by the Lab through actual ConnectedCapabilityInstances;
14. browser journeys use the real provider-backed API/protocol path;
15. no simulated financial route is reachable in production.

## Source-of-truth rule

The repository remains the sole implementation authority.

The provider dashboard is authoritative for provider account configuration and credentials.

Provider public documentation is authoritative for API semantics.

PaySwap's Financial Protocol is authoritative for PaySwap financial state.

Never merge these authorities into one opaque object.

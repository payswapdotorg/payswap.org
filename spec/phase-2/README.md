# Phase 2 Work Orders

Phase 2 activates real providers and closes executable coverage gaps without changing the frozen v1.5 domain architecture.

Maximum concurrency: 3.
Active work orders must be pairwise-disjoint.
The TL derives activation only from `spec/development-state/phase-2-state.json`.

Wave 1:
P2-W1-001 Provider connection control plane
P2-W2-001 Stripe production connector
P2-W3-001 MTN MoMo + Flutterwave + Paystack production connectors

Wave 2:
P2-W1-002 PayPal Direct + global payout controls
P2-W2-002 Rapyd + dLocal + Thunes
P2-W3-002 Adyen + Airwallex + EBANX

Wave 3:
P2-W1-003 Coverage-gap local rail program
P2-W2-003 Cross-provider lifecycle/conformance certification
P2-W3-003 Production provider rollout + browser/operator verification


## Authorization and credential boundary

Phase 2 must support real external capabilities even when PaySwap does not possess provider API credentials.

Supported modes:
- delegated OAuth/consent;
- provider-native connected accounts;
- scoped API credentials;
- interactive browser session;
- providerless local-rail execution.

For interactive/local routes, the merchant/supplier authenticates directly in an isolated provider browser session. The user agent/trusted surface may initiate the flow, but the agent model receives only an opaque session/authorization reference. Passwords, MFA secrets, cookies, storage and bearer tokens never enter model context, ordinary logs or protocol events.

Subsequent financial actions reuse the existing authorization through the connector runtime. The user is re-invoked only for provider-required reauthentication/step-up. Connecting an account never grants blanket withdrawal authority.

See spec/phase-2/AUTHORIZATION-AND-CREDENTIAL-ISOLATION.md.

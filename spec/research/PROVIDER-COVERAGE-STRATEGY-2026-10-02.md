# PaySwap.org — Phase 2 Global Provider Coverage Strategy
Date: 2026-10-02
Status: PHASE-2 IMPLEMENTATION AUTHORITY
Architecture: 1.5-frozen-2026-09-30

## Objective

Turn the certified PaySwap protocol/connector architecture into a real multi-provider payment network.

The objective is not to claim "every country" merely because a provider advertises worldwide reach. Coverage is evaluated at the executable instance level:

country × merchant domicile × shopper/beneficiary country × payment method × currency × direction (pay-in/payout) × regulatory perimeter × connected-account eligibility × current health.

A country is considered covered only when at least one certified ConnectedCapabilityInstance can actually execute the required use case. A provider catalogue is never sufficient.

## Current supplied providers

The operator has supplied credentials for:
- Stripe;
- MTN MoMo;
- Flutterwave;
- Paystack.

These must be harvested into the operator vault and registered as ConnectedCapabilityInstances only after live authorization/eligibility probes succeed.

The existing repository release record still records zero connected financial providers. Do not rewrite that historical release record. Phase 2 creates a new provider-activation record after live verification.

## PayPal decision

Direct PayPal integration IS required for universal coverage.

Stripe currently exposes PayPal as a payment method, but Stripe's own availability documentation says PayPal on Stripe is currently limited to Stripe businesses based in the EU except Hungary, Liechtenstein, Norway, the United Kingdom and Switzerland, with additional account-type restrictions. PayPal itself exposes a much broader worldwide API/payment surface.

Therefore:
- model Stripe's PayPal capability as a Stripe-backed implementation where the connected Stripe account is eligible;
- also build a direct PayPal Connector;
- let the Lab choose Stripe→PayPal, direct PayPal, or another method based on the connected capability instance, terms, eligibility and health;
- never assume Stripe's PayPal availability makes PayPal Direct unnecessary.

References:
- https://stripe.com/payment-method/paypal
- https://support.stripe.com/questions/paypal-payment-method-availability
- https://developer.paypal.com/api/codes/country-region/

## Recommended global coverage stack

### Tier A — already supplied

**Stripe**
Role: primary global card/wallet/payment-method provider and incumbent baseline. Stripe supports merchants in a defined set of countries/regions and can accept customers globally subject to method/currency/merchant eligibility.

**MTN MoMo**
Role: mobile-money coverage on MTN markets. Treat network/operator coverage separately from generic "mobile money".

**Flutterwave**
Role: African/regional PSP plus international cards and selected bank/local methods.

**Paystack**
Role: African PSP with current live merchant coverage in Nigeria, Ghana, South Africa and Kenya; additional countries are future/notify coverage, not assumed live.

### Tier B — add for broad cross-border and local-method coverage

**PayPal Direct**
Role: independent wallet/checkout rail and PayPal-native capability. Important because Stripe's PayPal availability is merchant-country/account constrained.

**Rapyd**
Role: broad payment/payout network and local method aggregation. Rapyd currently advertises 183 markets in its global network, but connected business eligibility and exact methods must be verified per account.

Reference:
- https://www.rapyd.net/network/

**dLocal**
Role: emerging-market local payment collection/payout coverage. dLocal currently documents 64 markets across Latin America, Africa/Middle East and Asia.

Reference:
- https://www.dlocal.com/faqs/
- https://docs.dlocal.com/docs/payment-method

**Thunes**
Role: cross-border payout/local endpoint coverage, especially mobile wallets, bank accounts, cash and stablecoin delivery. Thunes currently documents 140 payout countries and 90 collection countries; exact coverage is account/service dependent.

Reference:
- https://www.thunes.com/cross-border-payments/
- https://www.thunes.com/industries/payment-service-providers/

**Adyen**
Role: enterprise acquiring and broad global/local payment-method coverage with a mature payment-method configuration model.

Reference:
- https://docs.adyen.com/platforms/payment-methods/
- https://docs.adyen.com/plugins/netsuite/supported-payment-methods

**Airwallex**
Role: global payouts, local clearing access and FX. Airwallex currently documents local/SWIFT payouts in 200+ countries/regions and 90+ currencies; collection coverage is more constrained by business domicile/account configuration.

Reference:
- https://www.airwallex.com/docs/payouts/payout-network/bank-accounts
- https://www.airwallex.com/docs/payments/payment-methods/payment-methods-overview

**EBANX**
Role: country-specific local payment methods across Latin America, Africa and Asia where local methods dominate. Use it as a local-method coverage complement, not as a universal rail.

Reference:
- https://docs.ebanx.com/docs/pay-in/processing/payment-methods/payment-methods-overview

## Tier C — gap-driven additions

Do not integrate dozens of local PSPs preemptively.

Create a Coverage Gap Case whenever the executable matrix shows:
- no eligible pay-in route;
- no eligible payout route;
- unsupported local method;
- unsupported local currency;
- unacceptable regulatory perimeter;
- insufficient capacity/health;
- poor economics or unacceptable latency/reliability;
- no credible fallback.

The Gap Case then identifies the narrowest provider/rail addition needed.

Potential gap classes:
- domestic instant-payment systems;
- local bank-transfer providers/switches;
- mobile-money operators;
- wallet ecosystems;
- cash-in/cash-out networks;
- BNPL/credit providers;
- card acquiring gaps;
- sanctioned/high-risk markets requiring special licensing or an explicit NO_ROUTE policy.

Direct local connectors are permitted when an aggregator cannot provide the required executable capability.

## No universal-coverage promise

No finite provider list is allowed to assert that every country, every merchant domicile and every payment method is covered.

The production system must expose an executable coverage matrix and honest reasons for:
- AVAILABLE;
- NOT_ELIGIBLE;
- NOT_CONFIGURED;
- UNAVAILABLE;
- UNKNOWN;
- COMPLIANCE_BLOCKED;
- NO_VIABLE_ROUTE.

A country with no compliant executable route is a truthful NO_VIABLE_ROUTE outcome, not a product defect to be hidden.

## Provider selection policy

For every payment request the Lab/Director may compare:
1. incumbent provider-native path;
2. PaySwap-composed path;
3. multi-provider path;
4. direct local rail capability;
5. payout/global-network capability.

Selection must respect:
acceptance → authorization → capability instance → current observation → compliance → risk → cost/FX → latency → liquidity → recourse → merchant settlement destination → evidence.


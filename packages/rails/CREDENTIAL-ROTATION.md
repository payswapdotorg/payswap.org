# CREDENTIAL ROTATION — @payswap/rails (W1-005; Stripe production path P2-W2-001; MTN/Paystack/Flutterwave paths P2-W3-001)

Every rail adapter in this package declares its credential surface as
**env-driven secret-store references**. No secret value is ever read into a
domain contract, logged, or committed. Rotation is a first-class operation on
each client (`rotateCredentials`, ConnectorSDK lifecycle surface) and is
documented per rail below. The general invariant: rotation produces a
`CredentialRotationResult` carrying ONLY an opaque `newCredentialRef` plus
`ProviderExecutionEvidenceDraft` evidence — the evidence lineage makes the
rotation auditable (INV-E02/E05) without ever exposing the secret.

## Shared rules

1. Credential refs are resolved from the environment at call time; a ref
   naming an absent/empty value means "credential not provisioned" → the
   rail fails closed with `RailNotAuthorizedError` and availability UNKNOWN
   (INV-C01/C02, INV-NC04). Absence is never treated as an empty credential.
2. Rotation steps (all rails):
   a. the new credential is provisioned at the provider (provider dashboard /
      portal) by the granting authority — never by the adapter;
   b. the secret store entry the env var points at is updated to the new
      value (the env var itself keeps naming the same logical ref);
   c. `rotateCredentials` is invoked with an `AdapterExecutionAuthority` and
      an idempotency key: the adapter re-reads the ref, verifies the new
      value differs from the cached one, records the rotation evidence and
      returns the new opaque ref;
   d. the OLD credential is revoked at the provider only after the adapter
      confirms the new one serves a successful read (health probe) —
      preventing a rotation outage window;
   e. the rotation evidence node (kind `EXECUTION`, provider operation id)
      is retained immutably (INV-E05).
3. Rotation cadence: provider-recommended minimums (Stripe: manual/rolling
   90d keys; MTN: subscription keys per portal policy; public endpoints:
   no credentials — no rotation required).
4. Compromise response: rotate immediately per the steps above, then record
   an incident with the outage/evidence machinery in `src/incidents.ts` so
   the security learning path (INV-S04) has the window evidence.

## Per-rail declarations

| Rail | Env var (secret-store ref) | Kind | Rotated by | Evidence |
| --- | --- | --- | --- | --- |
| Fiat (Stripe-shaped) | `PAYSWAP_RAILS_FIAT_SECRET_REF` | API secret key | merchant/ops via Stripe Dashboard | `CredentialRotationResult.evidence` + immutable evidence-graph node |
| Mobile money (MTN MoMo) | `PAYSWAP_RAILS_MOMO_SUBSCRIPTION_KEY_REF` | subscription key | MTN developer portal | as above |
| Mobile money (MTN MoMo) | `PAYSWAP_RAILS_MOMO_API_USER_REF` | API user id | MTN provisioning | as above |
| Mobile money (MTN MoMo) | `PAYSWAP_RAILS_MOMO_API_KEY_REF` | API user secret | MTN provisioning | as above |
| Stripe (production connector) | `PROVIDER_STRIPE_CREDENTIAL_REF` | control-plane vault reference → sealed bundle | PaySwap ops via Stripe Dashboard + vault swap (below) | `CredentialRotationResult.evidence` (AUDIT_LOG) + provider-activation records |
| Mobile money (MTN MoMo, control plane) | `PROVIDER_MTN_MOMO_CREDENTIAL_REF` | control-plane vault reference → sealed bundle (subscription key + API user + API key) | PaySwap ops via MTN developer portal + vault swap (below) | as above |
| Flutterwave (production connector) | `PROVIDER_FLUTTERWAVE_CREDENTIAL_REF` | control-plane vault reference → sealed bundle | PaySwap ops via Flutterwave Dashboard + vault swap (below) | as above |
| Paystack (production connector) | `PROVIDER_PAYSTACK_CREDENTIAL_REF` | control-plane vault reference → sealed bundle | PaySwap ops via Paystack Dashboard + vault swap (below) | as above |
| Crypto (Ethereum public JSON-RPC) | — (none: public endpoint) | — | — | endpoint documented in BLOCKED-RAILS.md |
| FX (ECB reference rates) | — (none: public feed) | — | — | endpoint documented in BLOCKED-RAILS.md |

The env-var names are exported programmatically as
`RAIL_CREDENTIAL_ENV_VARS` (src/support.ts) so configuration surfaces can
render the exact required declarations; the VALUES never enter package code.

## Stripe production connector rotation path (swap-reference-then-verify)

The production Stripe connector (`src/stripe.ts`, P2-W2-001) resolves its
credential EXCLUSIVELY through the P2-W1-001 control plane: the configuration
key `PROVIDER_STRIPE_CREDENTIAL_REF` is bound (at the vault, not in the repo)
to a `vault://…` reference, and the sealed bundle material opens only inside
`CredentialBroker.withSealedBundle` with a registered `ConnectorRuntimeKey` —
material exists solely inside that callback frame. Rotation is
**swap-reference-then-verify**:

1. the NEW key is provisioned at Stripe (Dashboard → Developers → API keys;
   restricted keys with the minimum scopes are the norm) — never by the
   adapter;
2. the vault binding for `PROVIDER_STRIPE_CREDENTIAL_REF` is swapped to the
   new credential object (either the same `vault://` reference now resolves
   the new bundle, or the binding moves to a new reference — the connector
   re-resolves on EVERY provider call, so the swap is picked up immediately,
   with no restart and no cached material);
3. `rotateCredentials` is invoked with an `AdapterExecutionAuthority` and an
   idempotency key: the connector re-resolves, verifies the new reference
   DIFFERS from the recorded baseline (fail-closed: an unchanged reference
   refuses the rotation), records the AUDIT_LOG evidence and returns the new
   opaque `newCredentialRef`;
4. verification BEFORE revocation: the adapter confirms the new credential
   serves a successful authenticated read (`health()` → GET /v1/account).
   Only then is the OLD key revoked at Stripe — no rotation outage window;
5. the authorization lineage is carried by the phase-2 control-plane records
   (the provider-activation records behind
   spec/development-state/phase-2-state.json and the probe evidence in
   provider-probes-20261002.json); the rotation evidence node is retained
   immutably (INV-E05).

An env-resolved fallback exists for deployments that inject the resolved key
material directly under the same configuration key (the W1-005 rails
convention): there the baseline is an HMAC fingerprint of the material (the
material itself is never stored), and the same verify-before-revoke steps
apply. Cadence: Stripe manual/rolling 90-day keys.


## Wave-2 global-reach providers (P2-W2-002: Rapyd, dLocal, Thunes)

Each Wave-2 connector resolves its sealed bundle per provider call through
the P2-W1-001 CredentialBroker (`PROVIDER_RAPYD_CREDENTIAL_REF`,
`PROVIDER_DLOCAL_CREDENTIAL_REF`, `PROVIDER_THUNES_CREDENTIAL_REF`), so the
swap-reference-then-verify pattern applies uniformly:

1. provision the NEW credential into the vault under a NEW reference;
2. swap the vault binding for the provider's config key to the new
   reference (the connector re-resolves on every call — no restart);
3. `rotateCredentials` with an `AdapterExecutionAuthority` and an
   idempotency key: the connector verifies the new reference DIFFERS from
   the recorded baseline (fail-closed on an unchanged reference), records
   the AUDIT_LOG evidence and returns the new opaque reference;
4. verification BEFORE revocation: a real authenticated health probe
   against the provider (`health()` → the authenticated endpoint answers);
   only then is the OLD credential deactivated at the provider;
5. the rotation evidence node is retained immutably (INV-E05).

Thunes additionally requires the endpoint evidence to be current: a
rotation against a GLOBALLY_NXDOMAIN host is refused outright (the
`ThunesUnresolvableEndpointError` gate precedes every provider call), and
a host change must be recorded as NEW verified `ThunesEndpointEvidence`
(`status: "RESOLVED"` + the confirmed host) — never guessed.

dLocal note: the V2-HMAC-SHA256 canonicalization is confirmed live as
part of the FIRST authenticated probe (the honest-uncertainty record in
BLOCKED-RAILS.md §8); a rotation re-runs that confirmation.

# CREDENTIAL ROTATION — @payswap/rails (W1-005)

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
| Crypto (Ethereum public JSON-RPC) | — (none: public endpoint) | — | — | endpoint documented in BLOCKED-RAILS.md |
| FX (ECB reference rates) | — (none: public feed) | — | — | endpoint documented in BLOCKED-RAILS.md |

The env-var names are exported programmatically as
`RAIL_CREDENTIAL_ENV_VARS` (src/support.ts) so configuration surfaces can
render the exact required declarations; the VALUES never enter package code.

# Non-Negotiable Invariants

## Financial correctness
- INV-F01: money is exact; no floating-point financial arithmetic.
- INV-F02: the ledger is append-only; balances are projections.
- INV-F03: every journal entry balances.
- INV-F04: reservations cannot exceed authorized available value.
- INV-F05: one idempotency key maps to one authoritative command result.
- INV-F06: no financial mutation bypasses the Financial Protocol Authority.
- INV-F07: netting never changes gross obligations without preserving derivation.
- INV-F08: credit is explicit; no hidden temporary borrowing.
- INV-F09: FX rate, fee and spread provenance is retained.

## Failure
- INV-X01: UNKNOWN is never mapped to FAILED.
- INV-X02: UNKNOWN external writes cannot be blindly retried.
- INV-X03: reconciliation is authoritative for ambiguous external effects.
- INV-X04: terminal transitions are monotonic except explicit recovery states.

## Authorization
- INV-A01: child authority is always attenuated.
- INV-A02: expired/revoked security epochs cannot authorize sensitive actions.
- INV-A03: approval artifacts identify principal, agent, scope, expiry and request hash.
- INV-A04: an LLM never receives an unrestricted money-movement tool.
- INV-A05: user/agent suggestions cannot override protocol, policy, compliance or security constraints.

## Evidence
- INV-E01: every consequential action has authorization evidence.
- INV-E02: every external effect has execution evidence.
- INV-E03: finality requires policy-required proof.
- INV-E04: UI/browser artifacts are not stronger than their authenticated provenance.
- INV-E05: historical evidence is immutable.

## Agents
- INV-G01: Agent Body is independent of model or Soul.
- INV-G02: released Organization versions are immutable.
- INV-G03: agent proposals do not mutate financial truth.
- INV-G04: sensitive model upgrades pass evaluation, shadow and canary.

## Capabilities
- INV-C01: capability state and source availability are separate axes.
- INV-C02: unreachable source means availability unknown, not success/failure.
- INV-C03: retirement cannot rewrite in-flight history.
- INV-C04: extensions/packages cannot directly write financial state.
- INV-C05: ConnectedCapabilityInstance is scoped to a real provider account/tenant, authorization, geography/currency and permission state; provider catalogue claims alone cannot authorize execution.
- INV-C06: provider state required for customer action, reconciliation, support or audit is preserved in ProviderStateEnvelope and is never lossy-mapped into a canonical status.
- INV-C07: PASS_THROUGH_NATIVE, COMPOSED_PAYSWAP and OPTIMIZED_MULTI_PROVIDER are explicit modes and none can bypass protocol authorization, policy, compliance, security or evidence.
- INV-C08: provider-native optimization/recovery is represented as a capability and can be benchmarked without assuming PaySwap should replace it.
- INV-C09: ExternalFundsPositionObservation is an observation of external state and can never be treated as PaySwap custody or proof of a PaySwap-held customer balance.

## Participation
- INV-P01: monetary incentives are funded or explicitly contingent.
- INV-P02: attribution is deterministic and auditable.
- INV-P03: reward calculations are reproducible from evidence plus program version.
- INV-P04: anti-Sybil and anti-collusion checks run before reward finalization.
- INV-P05: leaderboards/points never become authorization or universal creditworthiness.
- INV-P06: clawbacks create separate adjustment obligations; contribution history remains.
- INV-P07: incentive changes create new versions/effective epochs.

## Smart-contract and custody
- INV-SC01: smart-contract extensions declare source/bytecode, chain, upgrade, admin, pause, oracle and custody properties.
- INV-SC02: no PaySwap operator/key may unilaterally withdraw user-held funds.
- INV-SC03: smart-account/session-key authority is bounded by an explicit permission envelope.
- INV-SC04: contract upgrade/governance risk is treated as part of capability certification.

## Security
- INV-S01: security advisories can restrict affected components globally.
- INV-S02: security epoch is checked on every sensitive delegated action.
- INV-S03: quarantined components cannot regain access through cached capability state.
- INV-S04: incidents feed evidence and security learning.

## Learning
- INV-L01: simulation is not production truth.
- INV-L02: candidate promotion requires replay/counterfactual and robustness evidence.
- INV-L03: production promotion is versioned and reversible.
- INV-L04: expert resolutions are versioned; historical versions remain for learning.

## Operations
- INV-O01: async commands are retry-safe.
- INV-O02: committed financial mutations cannot silently lose their outbox event.
- INV-O03: schema migrations are deployment-compatible.
- INV-O04: restore/replay can reconstruct authoritative state.

## Non-custody
- INV-NC01: PaySwap cannot unilaterally withdraw user-held funds.
- INV-NC02: any fund-holding smart contract declares withdrawal, upgrade, admin and recovery authority.
- INV-NC03: smart-contract custody claims are certification claims, not assumptions.
- INV-NC04: PSP connectors cannot imply support for rails that are not actually reachable and authorized.

## Privacy/compliance
- INV-R01: regulated data is purpose-bound.
- INV-R02: model context receives the minimum data required.
- INV-R03: privacy constraints are hard constraints.
- INV-R04: compliance blocks are policy/evidence backed and recorded.

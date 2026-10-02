# Phase 2 Dependency Graph
Date: 2026-10-02

## Wave 1
| ID | Worker | Work | Depends |
|---|---|---|---|
| P2-W1-001 | 1 | Provider connection control plane | none |
| P2-W2-001 | 2 | Stripe production connector | P2-W1-001 |
| P2-W3-001 | 3 | MTN MoMo + Flutterwave + Paystack production connectors | P2-W1-001 |

## Wave 2
| ID | Worker | Work | Depends |
|---|---|---|---|
| P2-W1-002 | 1 | PayPal Direct + global payout controls | P2-W1-001, P2-W2-001 |
| P2-W2-002 | 2 | Rapyd + dLocal + Thunes | P2-W2-001, P2-W3-001 |
| P2-W3-002 | 3 | Adyen + Airwallex + EBANX | P2-W2-001, P2-W3-001 |

## Wave 3
| ID | Worker | Work | Depends |
|---|---|---|---|
| P2-W1-003 | 1 | Coverage-gap local rail program | P2-W1-002, P2-W2-002, P2-W3-002 |
| P2-W2-003 | 2 | Cross-provider lifecycle/conformance certification | P2-W1-003, P2-W2-002 |
| P2-W3-003 | 3 | Production provider rollout + browser/operator verification | P2-W1-003, P2-W2-003 |

Maximum concurrency: 3. Active work orders must be pairwise-disjoint.
Provider existence never equals executable coverage. A country/method/currency/direction claim requires a currently eligible ConnectedCapabilityInstance and CapabilityObservation.
Historical Phase 1 records are immutable; Phase 2 creates new activation/release evidence.
# Universal Money Interface Dependency Graph

Authority: this graph + spec/universal-money/work-order-catalog.md + spec/development-state/phase-4-state.json.

Prerequisite: P3-W1-003, P3-W2-003 and P3-W3-003 must be COMPLETE.

## Wave 1 — foundations

P4-W1-001 Onchain domain/capability kernel — Worker 1
Depends: Phase 3 complete

P4-W1-002 Wallet/signer authorization + blockchain security kernel — Worker 2
Depends: Phase 3 complete

P4-W1-003 Merchant crypto contracts + Stripe UX research — Worker 3
Depends: Phase 3 complete

All pairwise-disjoint.

## Wave 2 — execution

P4-W2-001 Multi-chain adapter SDK — Worker 1
Depends: P4-W1-001, P4-W1-002

P4-W2-002 DEX/protocol extensions + best execution — Worker 2
Depends: P4-W1-001, P4-W1-002

P4-W2-003 Merchant checkout + Stripe settlement — Worker 3
Depends: P4-W1-003, P4-W2-001

## Wave 3 — intelligence/security

P4-W3-001 Lab + mixed-rail Organizations — Worker 1
Depends: P4-W2-001, P4-W2-002

P4-W3-002 Onchain FinancialOpportunity — Worker 2
Depends: P4-W2-002, P4-W3-001

P4-W3-003 Adversarial onchain security/threat intelligence — Worker 3
Depends: P4-W1-002, P4-W2-002

## Wave 4 — universal product

P4-W4-001 Mixed fiat/onchain route compiler — Worker 1
Depends: P4-W3-001, P4-W3-002

P4-W4-002 Universal user + merchant UX — Worker 2
Depends: P4-W1-003, P4-W2-003, P4-W4-001

P4-W4-003 Production certification + release — Worker 3
Depends: P4-W4-001, P4-W4-002, P4-W3-003

## Concurrency law

- maximum three workers;
- active Work Orders pairwise-disjoint;
- TL is not a fourth coding lane;
- no downstream mock may replace absent upstream authority;
- architecture conflicts stop at the boundary and require ADR/state/graph update.

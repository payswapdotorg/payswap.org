# Dependency Graph

Graph authority: this file plus Work Order files.
Do not activate a node whose dependencies are incomplete.

## Stage 0 — concurrent bootstrap

| ID | Work | Lane | Dependencies |
|---|---|---|---|
| W1-001 | Protocol kernel + persistence contracts | Worker 1 | none |
| W2-001 | Trust, agent, capability contracts | Worker 2 | none |
| W3-001 | API/runtime/experience boundary contracts | Worker 3 | none |

These three are pairwise-disjoint at the implementation boundary and may run concurrently.

## Stage 1

| ID | Work | Lane | Dependencies |
|---|---|---|---|
| W1-002 | Ledger, reservations, obligations, clearing | Worker 1 | W1-001 |
| W2-002 | Agent runtime, Bodies, Organizations, Packages | Worker 2 | W2-001 |
| W3-002 | Auth/approval/trusted surfaces + developer API + Work Operating Plane | Worker 3 | W3-001, W2-001 |

## Stage 2

| ID | Work | Lane | Dependencies |
|---|---|---|---|
| W1-003 | Netting, liquidity, credit, FX, value conversion | Worker 1 | W1-002 |
| W2-003 | Capability/Connector ecosystem + extensions + acceptance | Worker 2 | W2-002, W1-002 |
| W3-003 | Execution graph, webhooks, generalized connector framework | Worker 3 | W3-002, W1-002 |

## Stage 3

| ID | Work | Lane | Dependencies |
|---|---|---|---|
| W1-004 | Settlement, reconciliation, finality, evidence | Worker 1 | W1-003, W3-003 |
| W2-004 | Lab, Director, strategy/org/capability search | Worker 2 | W2-003 |
| W3-004 | Participation Engineering + incentive accounting | Worker 3 | W1-002, W2-003 |

W1-004, W2-004 and W3-004 can run concurrently.

## Stage 4

| ID | Work | Lane | Dependencies |
|---|---|---|---|
| W1-005 | Real rails + reconciliation connectors | Worker 1 | W1-004, W3-003 |
| W2-005 | Security immune system + Arena expert bridge | Worker 2 | W2-004, W1-004 |
| W3-005 | Incentive campaigns + leaderboards + referrals | Worker 3 | W3-004, W2-004 |

## Stage 5

| ID | Work | Lane | Dependencies |
|---|---|---|---|
| W1-006 | Disputes, recourse, escrow, bonds, guarantees | Worker 1 | W1-005 |
| W2-006 | Certification, promotion and safety gates | Worker 2 | W2-005, W1-005 |
| W3-006 | Product UX and messaging adapters | Worker 3 | W3-005, W3-002 |

## Stage 6

| ID | Work | Lane | Dependencies |
|---|---|---|---|
| W1-007 | End-to-end economic journeys + accounting certification | Worker 1 | W1-006, W3-006 |
| W2-007 | Adversarial/replay/fault/abuse suite | Worker 2 | W2-006, W1-007 |
| W3-007 | Deployment/browser/observability/operator runbook | Worker 3 | W3-006, W1-007 |

## Concurrency law
At most three Work Orders are active. Active Work Orders must be pairwise disjoint and satisfy the dependency graph.

The TL re-derives the frontier after every accepted merge.

## No-mock dependency rule
A downstream worker may not compensate for an absent upstream authority with a fake ledger, fake balance, fake rail, fake finality, mock provider reachable from production, or hidden UNKNOWN fallback.

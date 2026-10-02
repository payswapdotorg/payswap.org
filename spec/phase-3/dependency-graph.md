# Phase 3 Dependency Graph
Date: 2026-10-02

## Wave 1

| ID | Worker | Work | Depends |
|---|---|---|---|
| P3-W1-001 | 1 | Public web/deployment foundation | none |
| P3-W2-001 | 2 | UX system + You-platform reference extraction | none |
| P3-W3-001 | 3 | Product IA + journey contracts | none |

## Wave 2

| ID | Worker | Work | Depends |
|---|---|---|---|
| P3-W1-002 | 1 | Authentication/onboarding/connection UX | P3-W1-001, P3-W3-001 |
| P3-W2-002 | 2 | Command Center implementation | P3-W1-001, P3-W2-001, P3-W3-001 |
| P3-W3-002 | 3 | Payment/provider/local-rail journeys | P3-W1-001, P3-W1-002, P3-W2-002 |

## Wave 3

| ID | Worker | Work | Depends |
|---|---|---|---|
| P3-W1-003 | 1 | Infrastructure hardening + free/low-cost controls | P3-W1-001, P3-W2-002, P3-W3-002 |
| P3-W2-003 | 2 | Responsive/accessibility/visual verification | P3-W2-002, P3-W3-002 |
| P3-W3-003 | 3 | End-to-end production UI certification + release | P3-W1-003, P3-W2-003 |

Maximum concurrency: 3.
The TL may not dispatch a Work Order outside the frontier in phase-3-state.json.

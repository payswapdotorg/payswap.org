# Multi-Industry Professional-Agent Simulation

Date: 2026-09-30
Simulation type: synthetic behavioral model, not market forecast.

## Population

36 firms:
- 12 industries;
- 3 firms per industry;
- one small, one medium, one large cohort per industry;
- 300 projects per firm;
- 27,180 professionals represented by agents.

Each project is executed using:
1. PaySwap as an agentic operating/interface layer;
2. the representative incumbent stack for that industry;
3. existing human/organizational procedures.

## Important interpretation

"Main interface" means the professional prefers PaySwap as the place where they search, ask, coordinate, approve and initiate work, even when a specialized incumbent remains the system of record.

"Switch to just PaySwap" means the professional would be willing to retire the incumbent stack for most of their work, not merely add PaySwap.

This distinction is critical.

## Baseline architecture result

Before adding the Work Operating Plane, richer Connector Capability Packs, field/offline support, stronger external-object semantics and enterprise controls:

- main interface: ~63.7%;
- willing to use only PaySwap: ~24.9%.

## Post-improvement result

After incorporating the architectural fixes from the one-year simulation:

- main interface: ~73.8%;
- willing to use only PaySwap: ~35.2%.

These are synthetic model outputs, not adoption forecasts.

## Results by industry

| Industry | Professionals | Main interface | Main % | PaySwap-only % |
|---|---:|---:|---:|---:|
| Construction / engineering / contracting | 2,265 | 1,637 | 72.3% | 27.3% |
| Defense / security | 2,265 | 1,327 | 58.6% | 11.9% |
| Fashion / entertainment / media | 2,265 | 1,890 | 83.4% | 55.9% |
| Finance / banking / accounting | 2,265 | 1,597 | 70.5% | 19.3% |
| Healthcare | 2,265 | 1,443 | 63.7% | 16.5% |
| Hospitality | 2,265 | 1,770 | 78.1% | 40.1% |
| Legal | 2,265 | 1,490 | 65.8% | 19.2% |
| Manufacturing / industrial | 2,265 | 1,557 | 68.7% | 20.4% |
| Professional services / consulting | 2,265 | 1,859 | 82.1% | 52.5% |
| Sales / marketing | 2,265 | 1,880 | 83.0% | 58.7% |
| Technology / software | 2,265 | 1,899 | 83.8% | 64.7% |
| Transportation / delivery | 2,265 | 1,723 | 76.1% | 35.7% |
| **Total** | **27,180** | **20,075** | **73.8%** | **35.2%** |

Approximate simulated counts:
- ~20,075 professionals choose PaySwap as their main interface;
- ~9,566 are willing to use PaySwap alone.

## Why the gap remains

Deep incumbents still win specific system-of-record jobs.

Construction platforms provide domain workflows across preconstruction, field, documents, costs, schedules and project lifecycle. citeturn956781search0turn956781search2

Sales platforms increasingly combine CRM data, agents, activity management and revenue workflows. citeturn713486search2turn713486search11

ServiceNow is explicitly positioning itself as a system-of-action across hundreds of enterprise systems with AI agents and governed workflows. citeturn713486search0turn713486search14

Samsara integrates fleet intelligence, routing, compliance, mobile workflows and operational telemetry. citeturn427989search1turn427989search9

Mews is building a hospitality operating system combining PMS, revenue, messaging, accounting, BI and distribution. citeturn956781search9turn956781search17

Clio's legal stack combines matters, documents, calendars, billing, client communication and legal AI in case context. citeturn427989search0turn427989search2

The implication is not that PaySwap should copy each product. It is that the Connector + Work Graph must expose their actions and context cleanly.

## How to increase PaySwap-only adoption

Highest-leverage product improvements from the simulation:
1. deeper read/write/approve connector capabilities rather than read-only integrations;
2. Work Graph that keeps multi-month project context;
3. domain packs that surface specialized views without changing the core model;
4. migration/import/export so users can leave an incumbent without losing history;
5. offline field workflows;
6. stronger document/knowledge/email/calendar/chat integration;
7. enterprise governance: SSO/SCIM/RBAC/audit/retention/residency;
8. external-party collaboration;
9. reliable long-running workflows and exception handling;
10. connector marketplace with revenue-sharing and certification;
11. better provider failover and capability portability;
12. vertical-specific economic packs that connect operational events directly to money/liquidity/credit/incentives.

## Adoption strategy

The most important metric should not be "number of features."

Track:
- percentage of work initiated from PaySwap;
- percentage completed without leaving PaySwap;
- percentage of external writes completed by connector;
- percentage of money movement orchestrated through PaySwap;
- time-to-resolution for exceptions;
- context-switches per project;
- agent-human handoffs;
- connector coverage of critical workflows;
- percentage of projects with a single coherent Work Graph;
- user willingness to retire incumbent systems.

The synthetic model indicates that main-interface adoption can become materially higher than full replacement adoption. The product should therefore optimize for becoming the universal front door first, while systematically earning the right to replace underlying tools where PaySwap's generalized model genuinely outperforms them.

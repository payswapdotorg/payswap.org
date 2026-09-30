# Participation Engineering

## Purpose
The network must discover ways to increase useful participation when an economic goal is blocked by scarce actors, capacity, liquidity, trust, information or operational effort.

This is broader than a reward engine. The best intervention may be an incentive, a new capability, a better workflow, lower friction, a cooperative pool, better information, or a safer trust mechanism.

## Actor classes
- sender;
- recipient/beneficiary;
- merchant;
- liquidity provider;
- lender;
- borrower;
- market maker;
- rail/provider;
- developer;
- agent/package publisher;
- expert/verifier;
- introducer/referrer;
- guarantor/insurer;
- operator.

Actors can hold multiple roles.

## ParticipationGoal
Defines:
- scarce behavior or bottleneck;
- target actor population;
- desired useful outcome;
- jurisdiction/scope;
- time window;
- budget/risk limits;
- privacy/fairness constraints;
- stop conditions.

## ParticipationExperiment
Defines:
- hypothesis;
- cohorts/comparison;
- treatment;
- attribution;
- measurement window;
- guardrails;
- budget;
- evaluation method.

## IncentiveProgram
Required fields:
- sponsor/funder;
- objective;
- eligible actor role;
- eligibility rules;
- contribution event(s);
- proof requirements;
- reward formula;
- budget and reservation;
- emission/rate policy;
- caps/concentration limits;
- anti-Sybil/anti-collusion policy;
- clawback/dispute policy;
- privacy rules;
- effective period;
- version.

## ContributionRecord
A contribution is evidence that useful participation occurred. It includes actor, role, behavior, affected economic objects, quantity, time, quality/outcome, evidence references, attribution and program version.

A ContributionRecord is not itself a reward.

## RewardAccrual
Lifecycle:
PROVISIONAL → CONFIRMED → CLAIMABLE → CLAIMED
with side states DISPUTED, CLAWED_BACK and EXPIRED.

Monetary rewards create protocol obligations and settle using normal clearing/netting/settlement.

## Mechanism library
- fee rebate or fee credit;
- interest boost/discount;
- matched funding;
- deterministic threshold/time-bounded bonus;
- capacity or priority rights;
- referral reward;
- completion bounty;
- points;
- badge/recognition;
- role-specific reputation attestation;
- bond/collateral subsidy;
- lawful network-funded guarantee;
- cooperative participation pool.

Random/lottery-like reward behavior is deliberately outside the initial financial core.

## Discovery
Choose an intervention that maximizes useful participation, reliability, liquidity, user value and network value minus incentive cost, abuse cost, capital cost, operational cost and risk, subject to hard policy, jurisdiction, compliance, budget, privacy and concentration constraints.

The Lab may use bandits, evolutionary search, RL, causal experiments, planning or deterministic optimization.

Production execution only uses a versioned, certified program.

## Funding
Possible funders:
- network treasury;
- merchant;
- lender;
- liquidity provider;
- developer;
- provider;
- external sponsor;
- cooperative/community.

A monetary campaign requires an IncentiveBudgetReservation before rewards can become final unless the program explicitly makes funding contingency visible.

## Dynamic incentives
Programs may boost participation below target, normalize inside a target band, and taper above target. Emergency pause is allowed for abuse, security or budget violations.

Every program change is a new version/effective epoch.

## Anti-gaming
Program threat models can include:
- Sybil identities/accounts;
- collusion rings;
- wash transactions;
- self-referrals;
- low-quality volume;
- artificial churn;
- reward farming;
- incentive cannibalization.

Controls can include velocity limits, diminishing returns, outcome-linked rewards, counterparty diversity, duration requirements, identity linkage, economic stake, delayed finalization, graph analysis, independent verification and clawback.

No single opaque score is treated as sufficient Sybil protection.

## Leaderboards
Leaderboards are read models over ContributionRecords.

Every leaderboard declares:
- scope and actor role;
- metric and formula;
- period;
- eligibility;
- freshness;
- evidence strength;
- tie rule;
- anti-gaming status.

Metrics should reflect useful outcomes, not cheap activity.

Leaderboards, points and badges are social/product coordination mechanisms only. They cannot authorize a transfer or establish universal trustworthiness.

## Participation Organizations
The Lab may discover specialist organizations:
- Liquidity Growth;
- Lender Activation;
- Borrower Health;
- Merchant Activation;
- Corridor Expansion;
- Expert Supply;
- Developer/Agent Ecosystem;
- Security Bounty.

These are ordinary Agent Organizations with no privileged financial authority.

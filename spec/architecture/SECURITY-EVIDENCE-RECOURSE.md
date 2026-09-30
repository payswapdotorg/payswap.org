# Security, Evidence, Identity and Recourse

## Identity
Agent identity is distinct from owner identity.

AgentPrincipal binds:
- agent ID;
- owner reference;
- Agent Body/package version;
- cryptographic key;
- authority envelope;
- Security Epoch.

## Delegation
Mandates define actions, resources, rails, currencies, countries, beneficiaries, transaction/velocity/period limits, cost/spread limits, expiry, escalation, revocation and proof requirements.

Child delegation must be attenuated.

## Execution grants
Models receive constrained execution grants:
- scoped;
- short-lived;
- audience-bound;
- operation-bound;
- amount-bounded;
- resource-bounded;
- proof-bound.

Where feasible, bind grants to the caller key using sender-constrained credentials.

## Security immune system
Signals include:
- device/SIM/account changes;
- beneficiary changes;
- graph anomalies;
- velocity;
- provider incidents;
- agent/package behavior;
- verification failures;
- expert findings;
- coordinated abuse.

SecurityAdvisory can advance SecurityEpoch and restrict, quarantine or retire affected components. Cached capability state cannot bypass quarantine.

## Evidence lineage
Every consequential operation records:
- authorization lineage: why allowed;
- execution lineage: what action occurred;
- outcome lineage: what was observed;
- provenance;
- timestamp/epoch;
- links to protocol objects.

## Proof policy
Proof requirements depend on amount, risk, rail, counterparty, jurisdiction, recourse, capability and program.

Levels:
P0 assertion;
P1 authenticated artifact/receipt;
P2 provider-signed evidence;
P3 independent destination observation;
P4 multi-party corroboration plus bond;
P5 native rail/ledger finality.

The network never upgrades weak evidence because an agent says it succeeded.

## Browser-mediated action
Browser automation may be used only when lawful/allowed and within user authorization.

Capture authenticated context, action sequence, transaction reference, provider result, receipt/artifact and independent destination state where possible.

Screenshots are artifacts, not proof of finality on their own.

## Recourse
RecoursePolicy is frozen when the intent is initiated.

Mechanisms:
- native rail reversal;
- authorized pullback where supported;
- escrow;
- seller/provider/agent reserve or bond;
- network guarantee/insurance;
- explicit credit;
- hybrid.

Disputes never edit the original transaction. They create separate adjudication and adjustment obligations.

## Economic accountability
An untrusted actor may need an ExecutionBond defining provider, bonded amount, exposure cap, proof threshold, dispute window and slash/clawback rules.

The objective is explicit economic liability instead of hidden trust assumptions.

## Privacy
PII and regulated data are purpose-bound. Each access declares purpose, principal, field scope, retention and jurisdiction.

Agent prompts/context receive the minimum necessary data.

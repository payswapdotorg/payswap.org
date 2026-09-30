# Contributing

## Change hierarchy
1. Frozen architecture and invariants are highest authority.
2. Protocol contracts and schemas implement the architecture.
3. Work Orders constrain scope and sequencing.
4. Implementation details remain replaceable.

## Architecture amendment
A change that modifies a frozen invariant, authority boundary, core object meaning, financial state machine, or external protocol contract requires:
- an ADR in spec/architecture/decisions/;
- affected invariants and Work Orders identified;
- backward-compatibility and migration impact;
- updated architecture version;
- TL approval before implementation.

Never silently edit the frozen architecture to make a worker implementation fit.

## Evidence
Every implementation claim must point to repository test output, source behavior, provider documentation, or a protocol evidence record.

Implemented means wired into the real path, not merely defined or mocked.

## Production safety
Financial effects must be deterministic, idempotent, auditable, reconcilable, and fail-closed. Rail adapters are the only boundary allowed to produce external effects, and only through protocol-authorized execution grants.

## Parallel work
Workers edit disjoint package/file ownership areas where possible. Shared interfaces are contract-first artifacts and must be stabilized before dependent implementation begins.

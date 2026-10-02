# PaySwap Source of Truth

Status: CANONICAL
Date: 2026-10-02

## Authority order

1. Repository source code, tests, schemas, migrations and deployment configuration.
2. Active architecture + accepted ADRs.
3. Active phase state and dependency graph.
4. Active Work Orders.
5. Recorded CI, browser, runtime and deployment evidence.
6. External provider/standards documentation recorded with provenance.
7. Conversation history, model memory, PR prose, screenshots without repository provenance and agent claims are non-authoritative.

## Current direction

- Financial baseline: architecture 1.5-frozen-2026-09-30.
- Approved extension: architecture 1.6-frozen-2026-10-02.
- Phase 3 remains the prerequisite public-product phase.
- Phase 4 implements the Universal Money Interface + Universal Onchain Capability Plane.

## Golden rule

No worker may use chat history as missing specification. When a requirement is absent or ambiguous in the repository, stop at the boundary and the TL updates the repository before implementation continues.

## Historical immutability

Completed Phase 1/2/3 records describe what was true at those releases. They are not rewritten to make later architecture appear historical.

## Financial authority

The Financial Protocol is the sole financial source of truth. UI, agents, Lab, simulations, extensions, wallets and providers cannot declare financial finality.

External provider balances and onchain wallet balances are observations, never PaySwap custody.

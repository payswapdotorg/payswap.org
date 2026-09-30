# PaySwap.org

Open economic operating system and programmable money-movement network.

**Repository status:** architecture bootstrap — implementation is not yet authorized.

The repository is the sole source of truth for the Tech Lead (TL), three concurrent workers, and future maintainers. The implementation must follow the frozen architecture and work-order system in `docs/` and `spec/`.

Start with:
1. `AGENTS.md`
2. `docs/LLM-ARCHITECT-HANDOFF.md`
3. `spec/architecture/FROZEN-ARCHITECTURE.md`
4. `spec/dependency-graph.md`
5. `spec/development-state/v2-work-order-state.json`
6. `spec/worker-runbook.md`

The bootstrap deliberately contains no mock financial implementation. Production behavior must be implemented only through the contracts and gates defined here.

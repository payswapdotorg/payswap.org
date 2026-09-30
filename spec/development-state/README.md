# Development State

Machine-readable coordination state: spec/development-state/v2-work-order-state.json

The TL updates this file whenever a Work Order changes status, a dependency becomes satisfied, an accepted commit changes the frontier, or the architecture/promotion gate changes.

This is executable coordination state, not a diary.

Rules:
- maximum 3 active Work Orders;
- active Work Orders are pairwise-disjoint;
- no completion claim without repository evidence;
- blocked reasons reference an exact dependency or invariant;
- accepted Work Orders record commit SHA and verification evidence.

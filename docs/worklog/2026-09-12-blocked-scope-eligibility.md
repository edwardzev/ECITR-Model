# Blocked scope cannot be widened by global retrieval

The shared scope predicate previously admitted stored `blocked` cases and
evidence when the request scope was `global`. A frozen synthetic catalog
reproduced both helper admission and returned IDs through the full runtime.

The existing predicate now rejects `blocked` unconditionally. Other scope
combinations, workspace/lifecycle/approval precedence, ranking and result
budgets retain their existing behavior. The selected-record reader keeps its
separate disclosure guard and stable `blocked_scope` reason. Shared retrieval
continues reporting `scope_conflict`.

Validation covers both record layers across all valid scope combinations,
earlier rejection precedence, one-slot runtime results with eligible controls,
explicit abstention, and fresh support-graph expansion. Before the production
change, 5 of these 33 regressions failed; the failures demonstrated global
admission and graph reintroduction of blocked records. Required fixture and
repository checks, frozen before/after evidence, independent reviews, and
installed-route acceptance accompany the delivery packet.

This is a retrieval-class repair under `docs/change-control.md`, reviewed by
the Retrieval Architect, Orchestrator, and Governance/QA Steward. It does not
change schemas, canonical records, indexes or promotion. Tests use synthetic
catalogs; no live corpus exposure or retrieval-quality improvement is inferred.
Blocked IDs may still occur in exclusion diagnostics or graph explanations;
the repaired contract concerns result groups and intervention candidates.

Activation stops if eligible controls disappear or normal retrieval regresses.
The delivery records the exact base and task commit. Prefer a reviewed repair
over reverting the exclusion: a revert would restore the known defect and
requires an explicit disposition. No automatic reset or record rewrite applies.

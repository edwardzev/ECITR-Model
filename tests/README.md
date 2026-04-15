# Tests

This directory will hold schema tests, retrieval regression tests, migration tests, and cross-project boundary tests.

Future test suites should validate:
- schema acceptance and rejection for each canonical record type
- retrieval cascade behavior and per-layer budgets
- stale tactic invalidation
- cross-project leakage prevention
- evidence immutability invariants
- replay of fixture examples through migration paths
- evidence writes passing through the validation gate before adapters are called
- case compilation staying packet-based, evidence-backed, and review-gated
- invariant and tactic promotion staying review-gated and provenance-backed
- tactic freshness preventing stale default reuse
- retrieval execution preserving planner budgets and conflict reporting
- orchestrator routing staying explicit and role-bounded
- storage catalog persistence staying schema-bound and overwrite-explicit
- atomic-claim extraction preserving source spans
- review workflow keeping draft and active transitions explicit
- persisted review audit entries remaining append-only support records
- end-to-end orchestration staying catalog-backed
- derived semantic backends preserving retrieval contracts while changing candidate generation internals

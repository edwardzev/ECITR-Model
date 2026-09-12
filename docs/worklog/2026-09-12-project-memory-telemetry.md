# Project-memory opportunity and attempt telemetry

The Astra governance revision adds producer-backed telemetry to the existing
invocation store, with one lifecycle-bound opportunity and independent
attempts/read receipts for retries. Both branches capture a shadow gate
observation. The instrumented executor records before its own branch choice;
direct wrappers record caller-selected actions before internal dispatch. Mandatory retrieval remains enforced; no retrieval
skipping or model default is activated.

Scope: existing project-memory runtime, execution-loop boundary, supported CLI
wrappers, invocation/adoption reports, one versioned derived telemetry schema,
focused tests and owner documentation. Canonical corpus, retrieval ranking,
eligibility and selected-record disclosure rules are unchanged.

Validation before parent integration: 115 focused compatibility/telemetry/adoption
checks passed. Independent Metadata/QA review accepted the contract and conflict
quarantine. Retrieval Architect review intercepted an explicit-request trace label
regression; the invocation retains `explicit_request`, and its shadow gate uses
its original `discretionary` semantics. The correction passed 27 focused checks.
The parent runs the full repository check and owns commit/publication/activation.

A frozen synthetic wrapper comparison against clean c91c2dd used two warmup
pairs and ten measured AB/BA pairs. Baseline mean elapsed was 654.1 ms; revised
mean was 750.6 ms (+96.6 ms, +14.8%; paired delta SD 15.9 ms). Final invocation
bytes rose from 5,186 to 10,172 on average; each workflow retained one invocation
file. Every expected return, complete selected record, empty callback and catalog
hash matched. Raw paired samples and source/fixture hashes are in the parent
work packet. The later trace-label correction affects the execution-loop route, which that
CLI benchmark does not exercise. A subsequent primary review required an
additional evidence-boundary correction: direct wrappers are now labeled
`caller_selected_before_dispatch`, and only the instrumented executor is
`before_decision`. The original benchmark samples preserve their measured
source version; their old pre-decision labels are superseded and do not prove
external-agent choice coverage. Final positive workflow readback verifies the
corrected boundary and current artifact size. The original timing numbers are
not a fresh measurement of the final metadata-label revision.

These measurements describe added collector cost on this fixture and include
CLI process startup. They do not establish net governance benefit, real task
cost/tokens, memory attention, representative safety, or natural-cohort coverage.
The existing telemetry defect's natural representative cohort requirement remains
for the parent to assess before closing it.

Rollback: revert the scoped source changes; retain old and new derived artifacts
under their literal versions. No canonical corpus or index migration is required.

# ADR 0006: Invariants And Tactics Are Promoted Through Staging Packets

## Status

Accepted

## Context

Without staging packets, promotion from cases into higher-order memory becomes conversational and hard to audit.

## Decision

Invariant and tactic promotion in ECITR must start from explicit staging artifacts and
produce draft records before activation.

Production autonomous promotion may generate live candidate staging artifacts under:

- `staging/live-invariant-candidates/`
- `staging/live-tactic-candidates/`

Those candidates are not canonical records. Activation still requires deterministic
support checks, a promotion judge decision, and the review workflow. Benchmark
manifests remain regression inputs, not the production live candidate source.

When the promotion judge is model-backed, model input and output must stay bounded by
schema and be written as staging audit artifacts. A missing or invalid model judgment
does not fail the run and does not activate knowledge; it leaves the candidate staged
or judge-skipped.

Model narrowing may rewrite active-facing semantic fields, but live activation must
still pass a final quality gate. Generated token-bag text, live-candidate labels, and
machine-token lists cannot be written to active invariant or tactic records.

## Consequences

- promotion inputs remain separate from canonical records
- review surfaces stay explicit
- provenance from cases and evidence remains auditable

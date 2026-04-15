# Cases Layer

## Purpose

Capture structured experience from evidence.

## Owns

- one-record-per-situation discipline
- situation framing
- constraints
- action taken
- outcome
- failure mode
- applicability and non-applicability
- provenance back to evidence
- evidence-backed atomic-claim support used during derivation

## Does Not Own

- retrieval planning
- global policy
- invariant promotion authority
- tactic authority

## Authority

Cases are authoritative for curated experience within their version and provenance.

## Core Rules

- every case must cite exact evidence refs
- no case without provenance
- case meaning is versioned, never silently rewritten
- evidence wins on factual conflict
- cases are re-distillable when better tools arrive
- manual draft completion should produce an explicit amendment artifact, not an undocumented overwrite

## Read/Write Rule

- write evidence first
- derive cases second through the Case Compiler pipeline
- review before publishing as active
- autonomous runtime distillation may produce partial draft cases with explicit open questions
- non-draft cases must be complete and review-approved

See:
- `docs/architecture/case-compiler-pipeline.md`
- `docs/architecture/atomic-claims-extraction.md`
- `docs/architecture/review-workflow.md`
- `docs/adr/0005-cases-are-compiled-through-reviewable-packets.md`

## Failure Modes

- summary drift
- authority inversion over evidence
- hidden normalization of distinct situations
- stale active cases after environment change

# Atomic Claims Extraction

## Purpose

Define how verbatim evidence is decomposed into bounded, span-backed claims without promoting those claims into canonical semantics by themselves.

## Core Rule

Atomic claims are support artifacts.

They help:
- source attribution
- evidence recall
- narrow semantic matching
- later case derivation

They do not become invariants or tactics automatically.

## Inputs

Extraction consumes a staging packet with:
- the target `evidence_id`
- either inline source text or a source text path
- an extraction strategy identifier
- an extracting agent identity

## Outputs

Extraction produces one `atomic_claim_set` with:
- a stable `claim_set_id`
- the target `evidence_id`
- the source hash
- extraction metadata
- claim entries with source spans

Each atomic claim contains:
- a stable claim identifier
- the claim text
- a coarse claim kind
- a confidence score
- one or more source spans

## Source Span Rule

Every extracted claim must carry at least one source span.

The span is the minimal audit bridge between:
- raw evidence
- extracted claim
- later semantic reuse

## Claim Kinds

The first runtime extractor uses coarse kinds only:
- `fact`
- `constraint`
- `decision`
- `rationale`
- `observation`

These kinds are intended for retrieval hints and review aids, not for ontology design.

## Promotion Rule

Atomic claims may support:
- evidence retrieval
- case compilation
- review explanations

Atomic claims may not directly support:
- invariant activation
- tactic activation
- authority elevation without case review

## Replacement Rule

The first extractor is heuristic and intentionally simple.

A future extractor may use stronger models, but it must preserve:
- deterministic source spans
- stable claim-set identity rules
- explicit evidence linkage
- the support-artifact status of atomic claims

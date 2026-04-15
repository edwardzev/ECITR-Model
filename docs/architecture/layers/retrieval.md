# Retrieval Layer

## Purpose

Find, rank, and fuse records from Evidence, Cases, Invariants, and Tactics for runtime use.

## Owns

- query classification
- candidate generation
- ranking
- fusion
- budgets
- freshness checks
- invalidation application
- cross-project boundary enforcement in retrieval

## Does Not Own

- the meaning of a case
- the meaning of an invariant
- the meaning of a tactic
- source-of-truth authority

## Default Cascade

1. Tactics
2. Invariants
3. Cases
4. Evidence

## Ranking Inputs

- layer weight
- scope match
- applicability
- support strength
- outcome quality
- freshness
- duplication penalty
- staleness penalty
- conflict penalty

## Core Rules

- retrieval is staged, not flat
- each layer has explicit budgets
- evidence is used for audit, nuance, and re-distillation, not as the default flood surface
- retrieval infrastructure must be pluggable
- canonical records must remain engine-neutral

See:
- `docs/architecture/retrieval-control-plane.md`
- `docs/architecture/retrieval-planner.md`
- `docs/architecture/retrieval-runtime.md`

## Failure Modes

- evidence flood
- stale tactic reuse
- semantic ossification from one-off matches
- cross-project leakage
- retrieval engine becoming semantic owner

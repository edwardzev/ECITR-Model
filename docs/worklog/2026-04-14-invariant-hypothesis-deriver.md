# 2026-04-14 Invariant Hypothesis Deriver

## Objective

Add a real bridge from the active case corpus into invariant discovery so invariants can
be mined from live cases without jumping directly into canonical writes.

## Completed

- Added a deterministic `derive:invariants` surface.
- Added the `invariant_hypothesis_manifest` schema and store.
- Added staging-only hypothesis derivation over the uncovered active case pool.
- Added conservative clause-based gating so the deriver requires repeated promotable
  clauses, not just topical similarity.
- Added pairwise deduplication into multi-case candidate families when the same leading
  clauses recur.
- Added tests and fixture coverage for the new derivation path.
- Added runbook and architecture documentation for the new surface.

## Why

The old invariant workflow could benchmark only explicit human-written hypotheses. That
made the active case corpus non-generative.

The new deriver preserves governance while making the corpus operational:

`active cases -> staged hypothesis manifest -> invariant benchmark -> review`

## Result

A full uncovered-pool derivation now produces conservative staged candidates rather than
token-noise pairings.

The initial live run on 2026-04-14 yielded two reviewable staged candidates instead of
dozens of pairwise duplicates.

## Follow-up

- Review the two staged candidates and decide whether either should become an explicit
  benchmark manifest entry for live promotion.
- Only after the invariant path is operator-grade should tactic derivation be expanded.

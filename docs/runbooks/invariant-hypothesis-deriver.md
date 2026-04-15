# Invariant Hypothesis Deriver

## Purpose

Use this surface to derive conservative, staging-only invariant hypotheses from the
current active case pool.

This is the missing bridge between:
- a live corpus of `active` cases
- the existing invariant discovery benchmark

The deriver does not create canonical invariants.

## Contract

The deriver:
- reads only `active` cases
- excludes cases already covered by active invariants by default
- groups cases only when they repeat at least one promotable normalized clause
- uses repeated rare-token overlap only as a bounded selector and support signal
- writes only `staging/invariant-hypothesis-manifests/*.json`

The deriver must not:
- write canonical invariants
- bypass the invariant discovery benchmark
- auto-promote anything into review
- treat repeated execution steps as invariants

## Command

```bash
npm run derive:invariants -- \
  --max-candidates 25 \
  --max-candidates-per-case 3 \
  --max-rare-token-df 6 \
  --min-shared-clauses 1 \
  --min-shared-rare-tokens 4 \
  --min-rare-score 3
```

Optional:

- `--catalog-root /absolute/path/to/catalog`
- `--output-path /absolute/path/to/output.json`
- `--include-covered`
- `--dry-run`
- `--overwrite`

## Selection Rules

The current deterministic v1 deriver requires:
- at least one repeated promotable clause across the candidate case set
- enough repeated rare tokens to show the cases are materially about the same pattern

Promotable clauses are biased toward reusable rules and boundaries such as:
- `Do not ...`
- `Preserve ...`
- `Project ...`
- `Apply ...`
- `Keep ...`
- `Leave ...`
- `Lock ...`

It explicitly filters out repeated boilerplate such as:
- raw execution steps
- session-opening steps
- generic reporting sentences
- `Do not apply this case when ...` boilerplate

## Output

The output manifest is benchmark-compatible and includes, per candidate:
- repeated normalized clauses
- repeated rare tokens
- source case refs
- source evidence refs
- the live support-check result used to set `expected_decision`

The manifest lives under:

`<catalog_root>/staging/invariant-hypothesis-manifests/<derivation_id>.json`

## Recommended Flow

1. Run `derive:invariants`.
2. Review the emitted staged candidates for semantic reality.
3. Benchmark or promote the candidates that still look invariant-shaped.
4. Reject candidates that are still too task-specific or workflow-local.

## Current Limitation

The deriver is intentionally precision-biased.

It will miss real patterns that do not repeat a sufficiently explicit shared clause.
That is acceptable for v1. The goal is to avoid manufacturing invariants from topical
similarity alone.

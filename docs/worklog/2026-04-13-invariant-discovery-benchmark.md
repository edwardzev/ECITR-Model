# 2026-04-13 Invariant Discovery Benchmark

## Objective

Add a bounded invariant-discovery workflow over the active case pool before writing any
draft invariants.

## Completed

- Added an invariant discovery surface that prepares candidate promotion packets from
  explicit hypotheses plus active supporting case refs.
- Added a deterministic support check so discovery does more than packet schema
  validation.
- Added `npm run benchmark:invariants`.
- Added example benchmark coverage and a runbook for the new surface.

## Why

The invariants layer should now start from the curated active case pool, but it should
not jump directly into live promotion writes.

The benchmark surface provides a bounded way to test candidate invariants against the
current active case corpus first.

## Follow-up

- Seed a live invariant discovery benchmark from real active ECITR cases.
- Use that benchmark to decide whether the current support check is too weak or too
  strict before writing live invariant packets.

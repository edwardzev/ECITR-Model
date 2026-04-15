# Governed Morning Promotion Runner

## Date

2026-04-13

## Summary

Added a governed promotion runner so the morning ECITR launchd job no longer stops at evidence ingest and case drafting.

## What Changed

- added `src/runtime/governed-promotion-runner.js` to compose:
  - skip-blocked case batch promotion
  - invariant benchmark verification plus canonical promotion for benchmark-approved candidates
  - tactic benchmark verification plus canonical promotion for benchmark-approved candidates
  - Qdrant re-sync after canonical writes
- added `src/cli/refresh-promotions.js` and the `npm run refresh:promotions` script
- updated `src/cli/refresh-autonomous.js` so the existing launchd-owned morning run now chains governed promotion after evidence refresh and case drafting
- wrote regression coverage for clean benchmark gating, active-candidate skips, and non-fatal blocked candidate recording

## Governance

- no direct writes bypass benchmarked review surfaces
- invariant and tactic promotion abort if the corresponding benchmark manifest is no longer clean
- already-active invariant and tactic candidates are skipped idempotently
- case promotion still uses the existing skip-previously-blocked batch runner

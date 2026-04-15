# 2026-04-13 Tactic Discovery And Promotion

## What changed

- Added a tactic discovery surface and benchmark runner grounded in active cases plus active invariants.
- Added a tactic review surface with staged `tactic_promotion_packet` persistence and canonical promotion through the existing review workflow.
- Added regression coverage for process-only tactic blocking and successful canonical tactic promotion.

## Why

Cases and invariants were already curated and indexed. The next layer needed a benchmark-first path for tool-bound, environment-bound operational guidance without direct canonical writes.

## Current state

- Tactic discovery can be benchmarked independently.
- Promotion writes staged packets plus review audit entries.
- Canonical tactics are still freshness-gated after activation.

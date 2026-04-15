# 2026-04-11 Codex Refresh Policy Hardening

## Objective

Align Codex-native conversation capture with a lower-churn operating policy:

- skip unchanged rollout files cheaply
- avoid writing a full chat snapshot on every changed refresh
- preserve unconditional checkpoints for first seen, new `final_answer`, and archived threads
- use default thresholds of `7` days and `100` printed messages for active-thread checkpointing

## Changes

Implemented a local Codex import-state ledger under the catalog root so `refresh:codex` can skip unchanged rollout files before reading and parsing them.

Reworked the Codex rollout importer so changed threads only create a new immutable evidence snapshot when one of the checkpoint rules is satisfied:

- first seen
- new `final_answer`
- thread archived
- `7` day age threshold
- `100` new printed messages

Added archive checkpoint handling that still creates a terminal snapshot even when no new printed message was added after the latest active snapshot.

Updated refresh structural accounting so the new `skipped_unchanged` and `skipped_checkpoint` paths remain explicit and do not look like missing rollouts.

## Verification

Focused importer tests now cover:

- unchanged-file skipping
- new final-answer checkpointing
- below-threshold changed-thread skipping
- age-threshold checkpointing
- message-threshold checkpointing
- archive checkpoint creation without new printed output

The Codex refresh tests were updated to include the new skip categories in structural accounting.

## Outcome

ECITR keeps Codex runtime capture append-only and auditable, but no longer rewrites a full thread snapshot every time a thread changes slightly.

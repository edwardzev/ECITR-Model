# 2026-04-11 Bounded Case Completion

## Summary

Implemented the preferred bounded path for completing draft case applicability.

Instead of relying on freeform reviewer wording, ECITR now prepares a completion packet with explicit extracted facts and boundaries, generates support-linked applicability suggestions from that packet, validates the support refs, and only then derives the amendment.

## What Changed

- added a dedicated `case_completion_packet` schema and fixture
- added a file-backed completion packet store under `staging/case-completion-packets/`
- added `review:cases complete` as the bounded completion path
- linked amendment packets back to completion packets with `completion_id`
- validated that suggested applicability lines only cite extracted support ids
- documented `complete` as the preferred applicability-completion path

## Scope Notes

- the writer strategy is currently a bounded repo-local template, not a freeform external model call
- manual `amend` remains available for explicit operator-authored edits
- activation still requires the existing review decision
